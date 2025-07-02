require('dotenv').config();
require('./stickerProcessor');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { transcribeAudio } = require('./speechProcessor'); // <-- ПОДКЛЮЧАЕМ НАШ МОДУЛЬ
const cors =require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');


// Инициализация Google Gemini API
if (!process.env.GEMINI_API_KEY) {
    console.error('❌ Ошибка: GEMINI_API_KEY не найден в .env файле.');
    process.exit(1);
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Используем РАБОЧУЮ модель. Она поддерживает и текст, и изображения, и аудио.
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash";
console.log(`🧠 Используется модель: ${GEMINI_MODEL_NAME}`);

// Настройка директорий
const HISTORY_DIR = path.join(__dirname, 'history');
const IMAGES_DIR = path.join(__dirname, 'images');
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR);
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);

// Создайте папку 'bot_data' в корне проекта
const DATA_DIR = path.join(__dirname, 'Logs');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const WELCOME_MESSAGE_PATH = path.join(DATA_DIR, 'FirstMessage.txt');
const CHANGELOG_PATH = path.join(DATA_DIR, 'ChangeLog.txt');

console.log(`ℹ️ Путь к приветственному сообщению: ${WELCOME_MESSAGE_PATH}`);
console.log(`ℹ️ Путь к логу изменений: ${CHANGELOG_PATH}`);


let welcomeMessage = 'Добро пожаловать! Бот готов к работе.';
try {
    welcomeMessage = fs.readFileSync(WELCOME_MESSAGE_PATH, 'utf8');
    console.log('✅ Приветственное сообщение загружено из файла');
} catch (error) {
    console.error(`❌ Ошибка загрузки приветствия: ${error.message}`);
    console.log('ℹ️ Используется резервное приветственное сообщение');
}

let systemPrompt = '';
try {
    const PROMPT_FILE_PATH = path.join(__dirname, 'Prompts/Gorepochka/gorepochka.txt');
    systemPrompt = fs.readFileSync(PROMPT_FILE_PATH, 'utf8');
    console.log('✅ Системный промпт загружен');
} catch (error) {
    console.error(`❌ Ошибка загрузки промпта: ${error.message}`);
}

const chatHistories = {};
const userStates = {};
const MAX_CHAT_SLOTS = 8;

function getDefaultSlotState() {
    return {
        interactions: 0,
        lastActive: 0,
        contextSize: 0,
        spamCounter: 0,
        // Новое начальное значение уровня отношений
        relationshipLevel: 0,
        // +++ ДОБАВЛЕНО: Новое поле для хранения текстового статуса
        relationshipStatus: 'Незнакомец',
        stressLevel: 0,
        isBanned: false,
        ignoreTimer: null,
        ignoreState: 'default'
    };
}


// --- НАЧАЛО БЛОКА: ЛОГИКА ТАЙМЕРА "ИГНОРА" ---

// Функция для сброса существующего таймера
function clearIgnoreTimer(chatId, slotIndex) {
    if (userStates[chatId] && userStates[chatId].slots[slotIndex] && userStates[chatId].slots[slotIndex].ignoreTimer) {
        clearTimeout(userStates[chatId].slots[slotIndex].ignoreTimer);
        userStates[chatId].slots[slotIndex].ignoreTimer = null;
        console.log(`[Таймер для ${chatId}/${slotIndex}] Таймер сброшен из-за активности пользователя.`);
    }
}

// Функция для установки нового таймера
function setIgnoreTimer(chatId, slotIndex) {
    // Сначала всегда сбрасываем старый таймер, чтобы не было дублей
    clearIgnoreTimer(chatId, slotIndex);

    const slotState = userStates[chatId].slots[slotIndex];

    // Не запускаем таймер для забаненных чатов
    if (slotState.isBanned) {
        return;
    }

    let minDelay, maxDelay;

    // Выбираем диапазон времени в зависимости от состояния
    if (slotState.ignoreState === 'goodbye') {
        // от 2 до 4 дней в миллисекундах
        minDelay = 2 * 24 * 60 * 60 * 1000;
        maxDelay = 4 * 24 * 60 * 60 * 1000;
        console.log(`[Таймер для ${chatId}/${slotIndex}] Установлен долгий таймер (2-4 дня) из-за статуса "goodbye"`);
    } else { // 'default' state
        // от 35 до 60 минут в миллисекундах
        minDelay = 35 * 60 * 1000;
        maxDelay = 60 * 60 * 1000;
         console.log(`[Таймер для ${chatId}/${slotIndex}] Установлен стандартный таймер (35-60 мин)`);
    }

    // Генерируем случайную задержку в заданном диапазоне
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

    const timerId = setTimeout(async () => {
        // Проверяем, что чат все еще существует и активен
        if (!userStates[chatId] || !userStates[chatId].slots[slotIndex] || !(await isChatValid(chatId))) {
            return;
        }
        
        console.log(`[Таймер для ${chatId}/${slotIndex}] СРАБОТАЛ! Отправка команды <Игнор от пользователя>`);
        
        // Имитируем сообщение от пользователя с внутренней командой
        await processUserText(chatId, '<Игнор от пользователя>');

    }, delay);

    // Сохраняем ID таймера в состоянии слота
    slotState.ignoreTimer = timerId;
}

// --- КОНЕЦ БЛОКА: ЛОГИКА ТАЙМЕРА "ИГНОРА" ---




function initializeUser(chatId) {
    if (!userStates[chatId]) {
        userStates[chatId] = {
            hasCompletedWelcome: false,
            activeChatSlot: 0,
            slots: Array(MAX_CHAT_SLOTS).fill(null).map(() => getDefaultSlotState()),
            isDebugMode: false,
            // --- ДОБАВЛЕНО: Хранилище для смещения часового пояса в минутах ---
            timezoneOffset: null
        };
    }
    if (!chatHistories[chatId]) {
        chatHistories[chatId] = Array(MAX_CHAT_SLOTS).fill(null).map(() => []);
    }
}

function getChatHistoryPath(chatId, slotIndex) {
    return path.join(HISTORY_DIR, `${chatId}_slot_${slotIndex}.json`);
}

function loadChatHistory(chatId, slotIndex) {
    const filePath = getChatHistoryPath(chatId, slotIndex);
    if (fs.existsSync(filePath)) {
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            const history = JSON.parse(data);
            // ПРОВЕРКА И ИНИЦИАЛИЗАЦИЯ ДАННЫХ ДЛЯ СТАРЫХ ИСТОРИЙ
            if (userStates[chatId] && userStates[chatId].slots[slotIndex]) {
                 if (userStates[chatId].slots[slotIndex].relationshipStatus === undefined) {
                    userStates[chatId].slots[slotIndex].relationshipStatus = 'Незнакомец';
                 }
            }
            return history;
        } catch (e) {
            console.error(`❌ Ошибка чтения истории ${chatId}_slot_${slotIndex}:`, e.message);
            return [];
        }
    }
    return [];
}

function saveChatHistory(chatId, slotIndex, history) {
    const filePath = getChatHistoryPath(chatId, slotIndex);
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
}

function clearChatHistoryAndState(chatId, slotIndex) {
    const filePath = getChatHistoryPath(chatId, slotIndex);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
    if (chatHistories[chatId] && chatHistories[chatId][slotIndex]) {
        chatHistories[chatId][slotIndex] = [];
    }
    if (userStates[chatId] && userStates[chatId].slots[slotIndex]) {
        userStates[chatId].slots[slotIndex] = getDefaultSlotState();
    }
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('❌ Ошибка: TELEGRAM_BOT_TOKEN не найден в .env файле.');
    process.exit(1);
}
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
console.log('🤖 Бот Telegram инициализирован');

const app = express();
app.use(cors());
app.use(express.json());
app.get('/', (req, res) => {
    res.send('Telegram LLM Bot с Google Gemini API работает!');
});
// --- НАЧАЛО БЛОКА ВРЕМЕНИ ---

// 1. Отдаем нашу веб-страницу для синхронизации
app.get('/tz-setup', (req, res) => {
    res.sendFile(path.join(__dirname, 'timezone.html'));
});

// 2. Принимаем данные со страницы и сохраняем их
app.post('/set-timezone', async (req, res) => {
    const { chatId, offset } = req.body;

    if (!chatId || offset === undefined) {
        return res.status(400).send('Missing chatId or offset');
    }

    initializeUser(chatId); // Убедимся, что пользователь есть в системе
    userStates[chatId].timezoneOffset = parseInt(offset, 10);

    console.log(`[Время] Для чата ${chatId} установлен часовой пояс со смещением ${offset} минут.`);
    
    try {
        // Отправляем подтверждение в чат
        await bot.sendMessage(chatId, 'Отлично! Я настроила свои часы под твой часовой пояс. Теперь я буду знать, когда у тебя утро, а когда ночь ✨');
    } catch (e) {
        console.error("Не удалось отправить сообщение о синхронизации времени:", e.message);
    }

    res.status(200).send('Timezone updated');
});

// --- КОНЕЦ БЛОКА ВРЕМЕНИ ---


async function isChatValid(chatId) {
    try {
        const chat = await bot.getChat(chatId);
        return chat && !chat.pinned_message;
    } catch (error) {
        if (error.response?.body?.error_code === 403) {
            console.error(`❌ Чат ${chatId} недоступен (пользователь заблокировал бота)`);
            if (userStates[chatId]) delete userStates[chatId];
            if (chatHistories[chatId]) delete chatHistories[chatId];
            return false;
        }
        console.error(`❌ Ошибка проверки чата ${chatId}:`, error.message);
        return false;
    }
}


async function sendRelationshipStats(bot, chatId, slotState) {
    if (!slotState) return;
    // +++ ИЗМЕНЕНО: Теперь мы берем статус напрямую из состояния, а не вычисляем его.
    const statsMessage = `Статистика (Чат ${userStates[chatId] ? userStates[chatId].activeChatSlot + 1 : 'N/A'}):
  Уровень отношений: ${slotState.relationshipLevel} (${slotState.relationshipStatus})
  Стресс: ${slotState.stressLevel}`;
    try {
        if (!(await isChatValid(chatId))) return;
        await bot.sendMessage(chatId, statsMessage);
        console.log(`📊 Статистика отправлена для чата ${chatId}, слот ${userStates[chatId] ? userStates[chatId].activeChatSlot : 'N/A'}`);
    } catch (error) {
        console.error(`❌ Ошибка отправки статистики (${chatId}):`, error.message);
    }
}

const showWelcomeMessage = async (chatId) => {
    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: 'Начать переписываться', callback_data: 'start_chat' }]
            ]
        },
        parse_mode: 'Markdown'
    };
    try {
        if (!(await isChatValid(chatId))) return;
        await bot.sendMessage(chatId, welcomeMessage, options);
    } catch (error) {
        if (error.response?.body?.error_code === 403) {
            console.error(`❌ Пользователь ${chatId} заблокировал бота.`);
            if (userStates[chatId]) delete userStates[chatId];
            if (chatHistories[chatId]) delete chatHistories[chatId];
            return;
        }
        console.error(`❌ Ошибка отправки приветствия (${chatId}):`, error.message);
    }
};

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        if (!(await isChatValid(chatId))) return;
        initializeUser(chatId);
        userStates[chatId].hasCompletedWelcome = false;
        await showWelcomeMessage(chatId);
        console.log(`Пользователь ${chatId} отправил /start`);
    } catch (error) {
        console.error(`❌ Ошибка в /start (${chatId}):`, error.message);
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    try {
        if (!(await isChatValid(chatId))) return;
        initializeUser(chatId);
        if (data === 'start_chat') {
            userStates[chatId].hasCompletedWelcome = true;
            await bot.answerCallbackQuery(callbackQuery.id);
            await bot.sendMessage(chatId, `Теперь вы можете начать общение с ботом (в чате 1/${MAX_CHAT_SLOTS}). Используйте /chatlist для выбора другого чата.`);
            console.log(`Пользователь ${chatId} нажал "Начать переписываться"`);
        } else if (data.startsWith('switch_chat_')) {
            const slotIndex = parseInt(data.split('_')[2]);
            if (slotIndex >= 0 && slotIndex < MAX_CHAT_SLOTS) {
                
                // --- ДОБАВЛЕНО: Управление таймерами при переключении ---
                // 1. Останавливаем таймер для чата, который пользователь покидает.
                const oldSlotIndex = userStates[chatId].activeChatSlot;
                clearIgnoreTimer(chatId, oldSlotIndex);
                // 2. Если в покинутом чате была история, запускаем для него таймер.
                if (userStates[chatId].slots[oldSlotIndex].interactions > 0) {
                    setIgnoreTimer(chatId, oldSlotIndex);
                }
                // --- КОНЕЦ ДОБАВЛЕНИЯ ---

                userStates[chatId].activeChatSlot = slotIndex;
                if (chatHistories[chatId][slotIndex].length === 0 && fs.existsSync(getChatHistoryPath(chatId, slotIndex))) {
                    chatHistories[chatId][slotIndex] = loadChatHistory(chatId, slotIndex);
                }

                // --- ДОБАВЛЕНО: Сбрасываем таймер для нового активного чата ---
                // Это нужно на случай, если для него уже был запущен таймер, пока он был неактивен.
                clearIgnoreTimer(chatId, slotIndex);
                // --- КОНЕЦ ДОБАВЛЕНИЯ ---

                await bot.answerCallbackQuery(callbackQuery.id, { text: `Переключено на чат ${slotIndex + 1}` });
                await bot.sendMessage(chatId, `Вы переключились на чат ${slotIndex + 1}.`);
                console.log(`Пользователь ${chatId} переключился на чат ${slotIndex + 1}`);
            } else {
                await bot.answerCallbackQuery(callbackQuery.id, { text: 'Ошибка выбора чата', show_alert: true });
            }
        }
    } catch (error) {
        console.error(`❌ Ошибка в callback_query (${chatId}):`, error.message);
        try {
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Произошла ошибка', show_alert: true });
        } catch (e) { /* ignore */ }
    }
});

// Новая версия
function extractAndRemoveCommands(text, slotState, isDebugMode) {
    let modifiedText = text;
    const patterns = [
        // +++ ИЗМЕНЕНО: Диапазон теперь от -100 до 100
        { regex: /<Повысить уровень отношений на (\d+)>/g, action: (amount) => slotState.relationshipLevel = Math.min(100, slotState.relationshipLevel + parseInt(amount)) },
        { regex: /<Понизить уровень отношений на (\d+)>/g, action: (amount) => slotState.relationshipLevel = Math.max(-100, slotState.relationshipLevel - parseInt(amount)) },
        
        // +++ ДОБАВЛЕНО: Новая команда для смены текстового статуса
        { regex: /<Изменить статус отношений на:\s*(.*?)>/g, action: (status) => slotState.relationshipStatus = status.trim() },

        // Остальные команды без изменений
        { regex: /<Повысить стресс на (\d+)>/g, action: (amount) => slotState.stressLevel = Math.min(100, slotState.stressLevel + parseInt(amount)) },
        { regex: /<Понизить стресс на (\d+)>/g, action: (amount) => slotState.stressLevel = Math.max(0, slotState.stressLevel - parseInt(amount)) },
        { regex: /<Дать бан>/g, action: () => slotState.isBanned = true },
        { regex: /<Пользователь попрощался>/g, action: () => { slotState.ignoreState = 'goodbye'; console.log(`Статус одного из чатов изменен на 'goodbye'`); } },
        { regex: /<Пользователь в сети>/g, action: () => { slotState.ignoreState = 'default'; console.log(`Статус одного из чатов изменен на 'default'`); } },
    ];

    patterns.forEach(pattern => {
        // Используем глобальный флаг 'g' для поиска всех вхождений
        const regex = new RegExp(pattern.regex.source, 'g');
        let match;
        while ((match = regex.exec(text)) !== null) {
            // match[1] - это захваченная группа (цифра или текст статуса)
            const value = match[1];
            pattern.action(value);
        }

        // Удаляем команду из текста, если не включен режим отладки
        if (!isDebugMode) {
            modifiedText = modifiedText.replace(regex, '');
        }
    });

    // Очистка текста от лишних тегов и пробелов, если не в режиме отладки
    if (!isDebugMode) {
        modifiedText = modifiedText.replace(/<.*?>/g, '');
        modifiedText = modifiedText.replace(/\s{2,}/g, ' ').trim();
    } else {
        modifiedText = modifiedText.trim();
    }

    return modifiedText;
}

bot.onText(/\/chatlist/, async (msg) => {
    const chatId = msg.chat.id;
    if (!(await isChatValid(chatId))) return;
    initializeUser(chatId); // Убедимся, что пользователь и его слоты инициализированы

    const userState = userStates[chatId];
    const buttons = [];

    // Проходим по каждому слоту, чтобы создать для него кнопку
    for (let i = 0; i < MAX_CHAT_SLOTS; i++) {
        const slotData = userState.slots[i];
        
        // Проверяем, есть ли у слота какая-либо история (в памяти или на диске)
        const hasHistoryFile = fs.existsSync(getChatHistoryPath(chatId, i));
        const hasInteractions = slotData && slotData.interactions > 0;
        const isUsed = hasHistoryFile || hasInteractions;

        let buttonText = '';

        // Логика построения текста на кнопке. Порядок важен!
        // 1. Сначала проверяем на блокировку, так как это самый критичный статус.
        if (slotData.isBanned) {
            // Если пользователь сейчас активен в заблокированном чате, помечаем это стрелкой.
            const activeMarker = (i === userState.activeChatSlot) ? '➡️ ' : '';
            // Текст четко говорит о статусе.
            buttonText = `${activeMarker}Чат ${i + 1} 🔒 Заблокирован`;
        
        // 2. Если не заблокирован, проверяем, активен ли он сейчас.
        } else if (i === userState.activeChatSlot) {
            // +++ ИСПРАВЛЕНО: Добавляем текстовый статус в скобках
            buttonText = `➡️ Чат ${i + 1} ✨ ❤️${slotData.relationshipLevel} (${slotData.relationshipStatus}) ⛈️${slotData.stressLevel}`;
        
        // 3. Если не заблокирован и не активен, но был использован.
        } else if (isUsed) {
             // +++ ИСПРАВЛЕНО: Добавляем текстовый статус в скобках
            buttonText = `Чат ${i + 1} 📂 ❤️${slotData.relationshipLevel} (${slotData.relationshipStatus}) ⛈️${slotData.stressLevel}`;
        
        // 4. Если ничего из вышеперечисленного, значит, слот пуст.
        } else {
            // Четко обозначаем пустой слот, приглашая начать новый диалог.
            buttonText = `Слот ${i + 1} ➕ (Пусто)`;
        }
        
        // Добавляем готовую кнопку в массив
        buttons.push([{ text: buttonText, callback_data: `switch_chat_${i}` }]);
    }

    const options = { reply_markup: { inline_keyboard: buttons } };
    await bot.sendMessage(chatId, '🗂️ Выберите или переключите чат:', options);
    console.log(`Пользователь ${chatId} запросил обновленный /chatlist`);
});

// --- ОБРАБОТЧИКИ МЕДИА ---

async function handleVisualMedia(bot, msg) {
    const chatId = msg.chat.id;
    await bot.sendChatAction(chatId, 'typing');
    
    initializeUser(chatId);
    const userState = userStates[chatId];
    if (!userState) {
        console.error(`Ошибка: состояние для пользователя ${chatId} не найдено.`);
        return;
    }
    const activeSlotIndex = userState.activeChatSlot;
    const currentSlotState = userState.slots[activeSlotIndex];
    const currentHistory = chatHistories[chatId][activeSlotIndex];

    try {
        let file_id, mime_type, userPrompt;

        if (msg.sticker) {
            if (msg.sticker.is_animated || msg.sticker.is_video) {
                if (!msg.sticker.thumbnail) {
                     await bot.sendMessage(chatId, 'У этого стикера нет превью, не могу его рассмотреть :(');
                     return;
                }
                file_id = msg.sticker.thumbnail.file_id;
                mime_type = 'image/jpeg';
                userPrompt = 'Пользователь прислал этот анимированный стикер проанализируй контекст недавних реплик и ответь на это.';
            } else {
                file_id = msg.sticker.file_id;
                mime_type = 'image/webp';
                userPrompt = 'Пользователь прислал этот стикер, ответь на него согласну контексту ситуации: он прислал это просто так или для подчёркивания ситуации?.';
            }
        } else if (msg.photo) {
            file_id = msg.photo[msg.photo.length - 1].file_id;
            mime_type = 'image/jpeg';
            userPrompt = msg.caption || 'Проанализируй недавние сообщения и ответь на это фото, ты имеешь право описать картинку только в том случае, если контекст подходящий.';
        } else if (msg.document && msg.document.mime_type.startsWith('image/')) {
            file_id = msg.document.file_id;
            mime_type = msg.document.mime_type;
            userPrompt = msg.caption || 'Проанализируй недавние сообщения и ответь на это фото, ты имеешь право описать картинку только в том случае, если контекст подходящий';
        } else {
            return;
        }

        const file = await bot.getFile(file_id);
        if (!file || !file.file_path) {
            throw new Error("Файл не найден или удален на серверах Telegram.");
        }

        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const imageResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });

        if (imageResponse.data.length > 4 * 1024 * 1024) {
            await bot.sendMessage(chatId, "🖼️ Ой, эта картинка или стикер слишком большие. Попробуйте отправить что-нибудь поменьше.");
            return;
        }

        const base64Image = Buffer.from(imageResponse.data, 'binary').toString('base64');
        const imagePart = { inlineData: { mimeType: mime_type, data: base64Image } };
        const textPart = { text: userPrompt };

        const contents = currentHistory.map(h => ({ role: h.role === 'assistant' ? 'model' : h.role, parts: h.parts }));
        contents.push({ role: 'user', parts: [textPart, imagePart] });

        if (systemPrompt) {
            contents.unshift({ role: "model", parts: [{ text: `System prompt: ${systemPrompt}` }] });
        }
        
        currentSlotState.interactions++;
        currentSlotState.lastActive = Date.now();

        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });
        const result = await model.generateContent({ contents });
        const response = await result.response;

        if (!response.candidates?.length) {
            throw new Error("Пустой ответ от Gemini API");
        }
        
        let responseText = response.candidates[0].content.parts[0].text;
        
        // --- ИЗМЕНЕНО: Получаем глобальный флаг отладки и передаем его ---
        const isDebug = userStates[chatId].isDebugMode;
        responseText = extractAndRemoveCommands(responseText, currentSlotState, isDebug);

        currentHistory.push({ role: 'user', parts: [textPart, imagePart] });
        currentHistory.push({ role: 'model', parts: [{ text: responseText }] });
        saveChatHistory(chatId, activeSlotIndex, currentHistory);
        
        await sendSplitMessage(bot, chatId, responseText, true);
        await sendRelationshipStats(bot, chatId, currentSlotState);

        setIgnoreTimer(chatId, activeSlotIndex);

    } catch (error) {
        console.error(`❌ Ошибка обработки медиа для чата ${chatId}:`, error.message);
        if (error.response?.data) console.error('Google API response error:', JSON.stringify(error.response.data));
        await bot.sendMessage(chatId, '🚫 Ой, что-то пошло не так... Не могу это рассмотреть.');
    }
}

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
ffmpeg.setFfmpegPath(ffmpegPath);

async function handleAnimatedMedia(bot, msg) {
    const chatId = msg.chat.id;
    await bot.sendChatAction(chatId, 'typing');

    initializeUser(chatId);
    const userState = userStates[chatId];
    const activeSlotIndex = userState.activeChatSlot;
    const currentSlotState = userState.slots[activeSlotIndex];
    const currentHistory = chatHistories[chatId][activeSlotIndex];

    const tempInputDir = path.join(__dirname, 'temp_in');
    const tempOutputDir = path.join(__dirname, 'temp_out');
    if (!fs.existsSync(tempInputDir)) fs.mkdirSync(tempInputDir);
    if (!fs.existsSync(tempOutputDir)) fs.mkdirSync(tempOutputDir);
    
    let tempInputPath = '';
    let tempOutputPath = '';

    try {
        let file_id, file_extension, userPrompt;

        if (msg.animation) {
            file_id = msg.animation.file_id;
            file_extension = 'mp4';
            userPrompt = msg.caption || 'Пользователь прислал эту гифку. Опиши свою реакцию на неё.';
        } else {
            return;
        }
        
        const fileLink = await bot.getFileLink(file_id);
        const response = await axios({ url: fileLink, responseType: 'arraybuffer' });
        const inputBuffer = Buffer.from(response.data);

        const uniqueId = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        tempInputPath = path.join(tempInputDir, `${uniqueId}.${file_extension}`);
        tempOutputPath = path.join(tempOutputDir, `${uniqueId}.png`);
        fs.writeFileSync(tempInputPath, inputBuffer);
        
        await new Promise((resolve, reject) => {
            ffmpeg(tempInputPath)
                .frames(1)
                .output(tempOutputPath)
                .on('end', () => resolve())
                .on('error', (err) => reject(new Error(`Ошибка FFMPEG: ${err.message}`)))
                .run();
        });

        if (!fs.existsSync(tempOutputPath)) {
            throw new Error('Не удалось создать кадр из анимации.');
        }

        const imageBuffer = fs.readFileSync(tempOutputPath);
        const base64Image = imageBuffer.toString('base64');
        const imagePart = { inlineData: { mimeType: 'image/png', data: base64Image } };
        const textPart = { text: userPrompt };

        const contents = currentHistory.map(h => ({ role: h.role === 'assistant' ? 'model' : h.role, parts: h.parts }));
        contents.push({ role: 'user', parts: [textPart, imagePart] });

        if (systemPrompt) {
            contents.unshift({ role: "model", parts: [{ text: `System prompt: ${systemPrompt}` }] });
        }
        
        currentSlotState.interactions++;
        currentSlotState.lastActive = Date.now();

        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });
        const result = await model.generateContent({ contents });
        const genResponse = await result.response;

        if (!genResponse.candidates?.length) {
            throw new Error("Пустой ответ от Gemini API");
        }
        
        let responseText = genResponse.candidates[0].content.parts[0].text;

        // --- ИЗМЕНЕНО: Получаем глобальный флаг отладки и передаем его ---
        const isDebug = userStates[chatId].isDebugMode;
        responseText = extractAndRemoveCommands(responseText, currentSlotState, isDebug);

        currentHistory.push({ role: 'user', parts: [textPart, imagePart] });
        currentHistory.push({ role: 'model', parts: [{ text: responseText }] });
        saveChatHistory(chatId, activeSlotIndex, currentHistory);
        
        await sendSplitMessage(bot, chatId, responseText, true);
        await sendRelationshipStats(bot, chatId, currentSlotState);

        setIgnoreTimer(chatId, activeSlotIndex);

    } catch (error) {
        console.error(`❌ Ошибка обработки анимированного медиа для чата ${chatId}:`, error.message);
        await bot.sendMessage(chatId, '🚫 Упс, что-то пошло не так... Не могу рассмотреть эту анимацию.');
    } finally {
        if (tempInputPath && fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
        if (tempOutputPath && fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
    }
}


// ПОЛНАЯ ВЕРСИЯ ДЛЯ ЗАМЕНЫ
async function handleVoiceMessage(msg) {
    const chatId = msg.chat.id;

    if (!msg.voice) return;

    try {
        await bot.sendMessage(chatId, '🎙️ Слушаю твоё ГС, секундочку...');
        await bot.sendChatAction(chatId, 'typing');

        const fileId = msg.voice.file_id;
        const mimeType = msg.voice.mime_type || 'audio/ogg';

        if (msg.voice.file_size > 14 * 1024 * 1024) { // Лимит ~15MB, ставим с запасом
            await bot.sendMessage(chatId, "Ой, это голосовое сообщение слишком длинное. Попробуйте записать что-нибудь покороче.");
            return;
        }
        
        const fileLink = await bot.getFileLink(fileId);
        const response = await axios({ url: fileLink, responseType: 'arraybuffer' });
        const audioBuffer = Buffer.from(response.data);

        // Вызываем наш модуль для распознавания речи
        const transcribedText = await transcribeAudio(genAI, audioBuffer, mimeType);

        if (transcribedText && transcribedText.length > 0) {
            
            // Отправляем распознанный текст и ID ОРИГИНАЛЬНОГО голосового сообщения
            await processUserText(chatId, transcribedText, msg.message_id);
        } else {
            await bot.sendMessage(chatId, 'Хм, не могу разобрать, чё ты вякнул. Попробуй перезаписать сообщение или напиши текстом.');
        }

    } catch (error) {
        console.error(`❌ Ошибка обработки голосового сообщения для чата ${chatId}:`, error.message);
        await bot.sendMessage(chatId, '🚫 Произошла ошибка при обработке вашего голосового сообщения. Пожалуйста, попробуйте еще раз.');
    }
}

// ПОЛНАЯ ВЕРСИЯ ДЛЯ ЗАМЕНЫ
async function processUserText(chatId, userInput, replyToMessageId) {
    const userState = userStates[chatId];
    const activeSlotIndex = userState.activeChatSlot;
    const currentSlotState = userState.slots[activeSlotIndex];

    if (currentSlotState.isBanned) {
        try {
            await bot.sendMessage(chatId, "Ну-ну, кажется Горепочка устала от вашего поведения и блокнула вас. Используйте команду /clear или переключитесь на новый чат.");
        } catch (error) {
             console.error(`❌ Ошибка отправки сообщения о бане (${chatId}):`, error.message);
        }
        return;
    }

    if (chatHistories[chatId][activeSlotIndex].length === 0 && fs.existsSync(getChatHistoryPath(chatId, activeSlotIndex))) {
        chatHistories[chatId][activeSlotIndex] = loadChatHistory(chatId, activeSlotIndex);
    }
    const currentHistory = chatHistories[chatId][activeSlotIndex];

    if (userInput !== '<Игнор от пользователя>') {
        currentSlotState.spamCounter++;
        if (currentSlotState.spamCounter > 2) {
            try {
                await bot.sendMessage(chatId, 'Ой-ой спамить - не хорошо! 😠 Подожди, когда я договорю.');
            } catch (error) { /* ignore */ }
            return;
        }
    }


    currentHistory.push({ role: "user", parts: [{ text: userInput }] });
    currentSlotState.interactions++;
    currentSlotState.lastActive = Date.now();

    try {
        await bot.sendChatAction(chatId, 'typing');

        const contents = currentHistory.map(msg => ({ role: msg.role === "assistant" ? "model" : msg.role, parts: msg.parts }));
        if (systemPrompt) {
            contents.unshift({ role: "model", parts: [{ text: `System prompt: ${systemPrompt}` }] });
        }

        const model = genAI.getGenerativeModel({ model: GEMINI_MODEL_NAME });
        const result = await model.generateContent({ contents });
        const response = await result.response;

        if (!response.candidates?.length) throw new Error("Пустой ответ от Gemini API");

        let botResponse = response.candidates[0].content.parts[0].text;

        // --- ИЗМЕНЕНО: Получаем глобальный флаг отладки и передаем его ---
        const isDebug = userStates[chatId].isDebugMode;
        botResponse = extractAndRemoveCommands(botResponse, currentSlotState, isDebug);

        currentHistory.push({ role: "model", parts: [{ text: botResponse }] });
        saveChatHistory(chatId, activeSlotIndex, currentHistory);

        currentSlotState.contextSize = currentHistory.length;
        if (currentHistory.length > 100) {
            currentHistory.splice(0, currentHistory.length - 80);
            saveChatHistory(chatId, activeSlotIndex, currentHistory);
            console.log(`История чата ${chatId} сокращена.`);
        }

        await sendSplitMessage(bot, chatId, botResponse, true, replyToMessageId);
        
        currentSlotState.spamCounter = 0;
        await sendRelationshipStats(bot, chatId, currentSlotState);

        setIgnoreTimer(chatId, activeSlotIndex);

    } catch (error) {
        console.error(`❌ Ошибка при работе с ботом:`, error.message, error.stack);
        await bot.sendMessage(chatId, '🚫 Кажется закончились лимиты, подождите 15 минут. Или возможно цензура не пропускает ваше сообщение).');
        currentSlotState.spamCounter = 0;
    }
}


// ПОЛНАЯ ВЕРСИЯ ДЛЯ ЗАМЕНЫ
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    initializeUser(chatId);

    const activeSlotIndexOnMessage = userStates[chatId].activeChatSlot;
    clearIgnoreTimer(chatId, activeSlotIndexOnMessage);

    if (msg.animation) {
        if (!userStates[chatId].hasCompletedWelcome) {
            await showWelcomeMessage(chatId);
            return;
        }
        await handleAnimatedMedia(bot, msg);
        return;
    }

    if (msg.photo || (msg.document && msg.document.mime_type.startsWith('image/')) || msg.sticker) {
        if (!userStates[chatId].hasCompletedWelcome) {
            await showWelcomeMessage(chatId);
            return;
        }
        await handleVisualMedia(bot, msg);
        return;
    }
    
    if (msg.voice) {
        if (!userStates[chatId].hasCompletedWelcome) {
            await showWelcomeMessage(chatId);
            return;
        }
        await handleVoiceMessage(msg);
        return;
    }

    const userInput = msg.text;
    if (!userInput) return;

    if (!(await isChatValid(chatId))) return;

    if (userInput.startsWith('/') && userInput !== '<Игнор от пользователя>') {
        if (['/start', '/chatlist'].includes(userInput)) return;
        
        if (userInput === '/debug') {
            const userState = userStates[chatId];
            userState.isDebugMode = !userState.isDebugMode;

            if (userState.isDebugMode) {
                await bot.sendMessage(chatId, "✅ Включён режим отладки. Команды <> теперь будут видны.");
            } else {
                await bot.sendMessage(chatId, "☑️ Режим отладки выключен. Команды <> вновь будут скрыты.");
            }
            return;
        }

        if (userInput === '/time') {
            let publicUrl = process.env.PUBLIC_URL || 'https://your-bot-domain.com';
            if (publicUrl === 'https://your-bot-domain.com') {
                console.error("PUBLIC_URL не установлен в .env! Команда /time не будет работать.");
                await bot.sendMessage(chatId, "Ой, я не могу синхронизироваться, мой создатель не указал мой публичный адрес. ⚙️");
                return;
            }
            
            // --- НАЧАЛО ИСПРАВЛЕНИЯ ---
            // Эта строка "чинит" URL, удаляя случайное дублирование протокола
            publicUrl = publicUrl.replace(/^https:https:\/\//, 'https://').replace(/^http:http:\/\//, 'http://');
            // --- КОНЕЦ ИСПРАВЛЕНИЯ ---

            const syncUrl = `${publicUrl}/tz-setup?id=${chatId}`;
            const options = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🕰️ Синхронизировать время', url: syncUrl }]
                    ]
                }
            };
            await bot.sendMessage(chatId, 'Чтобы я знала, который у тебя час, нажми на кнопку ниже. Откроется страница для быстрой синхронизации.', options);
            return;
        }
        
        if (userInput === '/clear') {
            const activeSlotIndex = userStates[chatId].activeChatSlot;
            clearChatHistoryAndState(chatId, activeSlotIndex);
            clearIgnoreTimer(chatId, activeSlotIndex);
            await bot.sendMessage(chatId, `Чат ${activeSlotIndex + 1} очищен 🗑️.`);
            return;
        }
        if (userInput === '/context') {
            const activeSlotIndex = userStates[chatId].activeChatSlot;
            const filePath = getChatHistoryPath(chatId, activeSlotIndex);
            if (fs.existsSync(filePath)) await bot.sendDocument(chatId, fs.createReadStream(filePath));
            else await bot.sendMessage(chatId, `Контекст для чата ${activeSlotIndex + 1} отсутствует.`);
            return;
        }
        if (userInput === '/changes') {
            try {
                const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
                await sendSplitMessage(bot, chatId, `📄 Последние изменения:\n${changelog}`, false);
            } catch (error) { await bot.sendMessage(chatId, '❌ Не удалось загрузить список изменений.'); }
            return;
        }
        return;
    }
    
    if (!userStates[chatId].hasCompletedWelcome) {
        await showWelcomeMessage(chatId);
        return;
    }

    // ВАЖНО: нужно вызвать правильную версию processUserText
    await processUserText(chatId, userInput, msg.message_id);
});


// ПОЛНАЯ ВЕРСИЯ ДЛЯ ЗАМЕНЫ
async function sendSplitMessage(bot, chatId, originalText, isAiResponseType, replyToMessageId) {
    let typingTimer;
    const startTyping = async () => {
        if (typingTimer) clearInterval(typingTimer);
        try {
            if (await isChatValid(chatId)) {
                await bot.sendChatAction(chatId, 'typing');
                typingTimer = setInterval(async () => {
                    try {
                        if (await isChatValid(chatId)) { await bot.sendChatAction(chatId, 'typing'); }
                        else { stopTyping(); }
                    } catch { stopTyping(); }
                }, 4000);
            }
        } catch { /* ignore */ }
    };
    const stopTyping = () => {
        if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
    };
    await startTyping();

    const messageIds = [];
    let isFirstChunk = true;

    try {
        if (!(await isChatValid(chatId))) { stopTyping(); return []; }

        const createMessageOptions = (textChunk) => {
            const options = { parse_mode: 'Markdown' };
            if (isFirstChunk && replyToMessageId && isAiResponseType && !textChunk.trim().startsWith('```')) {
                options.reply_to_message_id = replyToMessageId;
            }
            return options;
        };
        
        const sendMessageAndUpdateFlag = async (textChunk) => {
            if (!(await isChatValid(chatId))) return null;
            if (!textChunk || !textChunk.trim()) return null;

            const options = createMessageOptions(textChunk);
            const sent = await bot.sendMessage(chatId, textChunk, options);
            isFirstChunk = false;
            return sent;
        };

        if (!isAiResponseType) {
            if (originalText.length <= 4096) {
                const sent = await sendMessageAndUpdateFlag(originalText);
                if(sent) messageIds.push(sent.message_id);
            } else {
                const chunks = originalText.match(/([\s\S]|[\r\n]){1,4096}/g) || [];
                for (const chunk of chunks) {
                    const sent = await sendMessageAndUpdateFlag(chunk);
                    if(sent) messageIds.push(sent.message_id);
                    await new Promise(resolve => setTimeout(resolve, 700));
                }
            }
            stopTyping();
            return messageIds;
        }

        if (originalText.length <= 85) {
            const partsForShortAi = originalText.split(/(```[\s\S]*?```)/gs);
            for (const part of partsForShortAi) {
                if(part.trim()){
                    const sent = await sendMessageAndUpdateFlag(part);
                    if(sent) messageIds.push(sent.message_id);
                }
            }
            stopTyping();
            return messageIds;
        }

        let zerosSentThisMessage = 0;
        let onesSentThisMessage = 0;
        const textAndCodeParts = originalText.split(/(```[\s\S]*?```)/gs);
        let currentMessageSegment = '';
        let punctuationEventsInCurrentTextSegment = 0;

        for (const part of textAndCodeParts) {
            if (!(await isChatValid(chatId))) { stopTyping(); return messageIds; }
            if (part.startsWith('```') && part.endsWith('```')) {
                if (currentMessageSegment.trim()) {
                    const sent = await sendMessageAndUpdateFlag(currentMessageSegment.trim());
                    if (sent) messageIds.push(sent.message_id);
                    currentMessageSegment = '';
                    punctuationEventsInCurrentTextSegment = 0;
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
                if (part.length <= 4096) {
                    const sent = await sendMessageAndUpdateFlag(part);
                    if (sent) messageIds.push(sent.message_id);
                } else {
                    const codeChunks = part.match(/([\s\S]|[\r\n]){1,4090}/g) || [];
                    for (let k = 0; k < codeChunks.length; k++) {
                        if (!(await isChatValid(chatId))) { stopTyping(); return messageIds; }
                        let chunkToSend = codeChunks[k];
                        if (k === 0 && !chunkToSend.startsWith("```")) chunkToSend = "```\n" + chunkToSend;
                        if (k === codeChunks.length - 1 && !chunkToSend.endsWith("```")) chunkToSend = chunkToSend + "\n```";
                        const sent = await sendMessageAndUpdateFlag(chunkToSend);
                        if (sent) messageIds.push(sent.message_id);
                        await new Promise(resolve => setTimeout(resolve, 700));
                    }
                }
                punctuationEventsInCurrentTextSegment = 0;
            } else {
                for (let i = 0; i < part.length; i++) {
                    const char = part[i];
                    currentMessageSegment += char;
                    let eventType = null;
                    if (char === '.' && i + 2 < part.length && part[i + 1] === '.' && part[i + 2] === '.') {
                        eventType = 'ellipsis';
                        currentMessageSegment += part[i + 1] + part[i + 2];
                        i += 2;
                    } else if (char === '.' || char === '?' || char === '!') {
                        eventType = 'punctuation';
                    }

                    if (eventType) {
                        punctuationEventsInCurrentTextSegment++;
                        if (punctuationEventsInCurrentTextSegment >= 2) {
                            let makeSplitDecision = false;
                            const canSplit = onesSentThisMessage < 3;
                            if (canSplit && Math.random() > 0.5) {
                                makeSplitDecision = true;
                            }

                            if (makeSplitDecision) {
                                if (currentMessageSegment.trim()) {
                                    const sent = await sendMessageAndUpdateFlag(currentMessageSegment.trim());
                                    if (sent) messageIds.push(sent.message_id);
                                }
                                currentMessageSegment = '';
                                onesSentThisMessage++;
                                zerosSentThisMessage = 0;
                                punctuationEventsInCurrentTextSegment = 0;
                                await startTyping();
                                const delay = Math.random() * (3700 - 990) + 990;
                                await new Promise(resolve => setTimeout(resolve, Math.floor(delay)));
                            } else {
                                zerosSentThisMessage++;
                            }
                        }
                    }
                    if (currentMessageSegment.length >= 4050) {
                        if (!(await isChatValid(chatId))) { stopTyping(); return messageIds; }
                        const sent = await sendMessageAndUpdateFlag(currentMessageSegment.trim());
                        if (sent) messageIds.push(sent.message_id);
                        currentMessageSegment = '';
                        punctuationEventsInCurrentTextSegment = 0;
                        await startTyping();
                        await new Promise(resolve => setTimeout(resolve, 300));
                    }
                }
            }
        }
        if (currentMessageSegment.trim()) {
            if (!(await isChatValid(chatId))) { stopTyping(); return messageIds; }
            const sent = await sendMessageAndUpdateFlag(currentMessageSegment.trim());
            if (sent) messageIds.push(sent.message_id);
        }
        stopTyping();
        return messageIds;
    } catch (error) {
        stopTyping();
        if (error.response?.body?.error_code === 403) {
            console.error(`❌ Пользователь ${chatId} заблокировал бота.`);
            if (userStates[chatId]) delete userStates[chatId];
            if (chatHistories[chatId]) delete chatHistories[chatId];
            return [];
        }
        console.error('❌ Ошибка при отправке разделенного сообщения:', error.message, error.stack);
        try {
            if (await isChatValid(chatId)) {
                await bot.sendMessage(chatId, 'Ошибка 🚫 Не удалось отправить полный ответ.');
            }
        } catch (sendError) {
            console.error(`❌ Не удалось отправить сообщение об ошибке отправки (${chatId}):`, sendError.message);
        }
        return messageIds;
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер Node.js запущен на порту ${PORT}`);
    console.log(`ℹ️ URL для проверки: http://localhost:${PORT}`);
});

bot.on('polling_error', (error) => {
    console.error(`❌ Ошибка polling'а Telegram: ${error.code} - ${error.message}`);
});

bot.on('webhook_error', (error) => {
    console.error(`❌ Ошибка вебхука: ${error.message}`);
});

console.log('ℹ️ Бот Горепочка ожидает команды...');