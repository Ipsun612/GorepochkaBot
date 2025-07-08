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
const CREDITS_PATH = path.join(__dirname, 'Credits', 'credits.txt');

console.log(`ℹ️ Путь к приветственному сообщению: ${WELCOME_MESSAGE_PATH}`);
console.log(`ℹ️ Путь к логу изменений: ${CHANGELOG_PATH}`);
// +++ ДОБАВЛЕНО: Логирование пути к титрам +++
console.log(`ℹ️ Путь к титрам: ${CREDITS_PATH}`);


let welcomeMessage = 'Добро пожаловать! Бот готов к работе.';
try {
    welcomeMessage = fs.readFileSync(WELCOME_MESSAGE_PATH, 'utf8');
    console.log('✅ Приветственное сообщение загружено из файла');
} catch (error) {
    console.error(`❌ Ошибка загрузки приветствия: ${error.message}`);
    console.log('ℹ️ Используется резервное приветственное сообщение');
}

let creditsText = 'Титры не найдены. Создатель, проверь файл Credits/credits.txt';
try {
    // Проверяем, существует ли файл перед чтением
    if (fs.existsSync(CREDITS_PATH)) {
        creditsText = fs.readFileSync(CREDITS_PATH, 'utf8');
        console.log('✅ Титры загружены из файла');
    } else {
        console.warn(`⚠️ Файл титров не найден по пути: ${CREDITS_PATH}`);
        // Создаем папку и файл-пример, если их нет
        fs.mkdirSync(path.dirname(CREDITS_PATH), { recursive: true });
        fs.writeFileSync(CREDITS_PATH, '**Титры**\n\nРазработано [Ваше Имя].');
        creditsText = fs.readFileSync(CREDITS_PATH, 'utf8');
        console.log('ℹ️ Создан пример файла credits.txt. Пожалуйста, отредактируйте его.');
    }
} catch (error) {
    console.error(`❌ Ошибка загрузки титров: ${error.message}`);
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
        relationshipLevel: 0,
        relationshipStatus: 'Незнакомец',
        stressLevel: 0,
        isBanned: false,
        ignoreTimer: null,
        ignoreState: 'default',
        userBio: '', // Хранит биографию пользователя
        isWaitingForBio: false, // Флаг ожидания ввода биографии
        characterDescription: '',
        isWaitingForCharacter: false // Флаг ожидания ввода характера
    };
}

function getChatButtonText(chatId, slotIndex) {
    const slotState = userStates[chatId].slots[slotIndex];
    const isActive = userStates[chatId].activeChatSlot === slotIndex;
    const hasMessages = chatHistories[chatId][slotIndex].length > 0;

    let buttonText = '';

    if (isActive) buttonText += '➡️ ';
    if (slotState.isBanned) {
        buttonText += `Чат ${slotIndex + 1} 🔒 Заблокирован`;
    } else if (!hasMessages) {
        buttonText += `Слот ${slotIndex + 1} ⭐ (Пусто)`;
    } else {
        const icon = '📁';
        const rel = `❤️ ${slotState.relationshipLevel} (${slotState.relationshipStatus})`;
        const stress = `⛈️ ${slotState.stressLevel}`;
        buttonText += `Чат ${slotIndex + 1} ${icon} ${rel} ${stress}`;
    }

    if (buttonText.length > 64) buttonText = buttonText.substring(0, 61) + '...';
    return buttonText;
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
            timezoneOffset: null,
            // +++ ДОБАВЛЕНО: Глобальное поле для хранения модели пользователя +++
            selectedModel: process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash" // По умолчанию берем из .env или ставим flash
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
        // Сохраняем биографию и характер перед сбросом
        const currentUserBio = userStates[chatId].slots[slotIndex].userBio || '';
        const currentCharacterDescription = userStates[chatId].slots[slotIndex].characterDescription || '';
        
        // Сбрасываем состояние слота
        userStates[chatId].slots[slotIndex] = getDefaultSlotState();
        
        // Восстанавливаем биографию и характер
        userStates[chatId].slots[slotIndex].userBio = currentUserBio;
        userStates[chatId].slots[slotIndex].characterDescription = currentCharacterDescription;
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

const settingsReplyKeyboard = {
    keyboard: [
        [{ text: '🗑️ Очистить историю' }, { text: '🔄 Выбрать чат' }, { text: '🤖 Выбрать модель' }],
        [{ text: '📝 Установить биографию' }, { text: '📝 Задать характер' }],
        [{ text: '📤 Экспортировать чат' }, { text: '📥 Импортировать чат' }],
        [{ text: 'ℹ️ Титры' }, { text: '📄 Изменения' }],
        [{ text: '🛠️ Режим отладки' }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
};


// Модификация обработчика callback_query для поддержки настроек
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;
    try {
        if (!(await isChatValid(chatId))) return;
        initializeUser(chatId);

        // Обработка выбора модели
        if (data.startsWith('select_model_')) {
            const newModel = data.replace('select_model_', '');
            const userState = userStates[chatId];
            
            if (userState.selectedModel === newModel) {
                await bot.answerCallbackQuery(callbackQuery.id, { text: 'Эта модель уже активна!', show_alert: true });
                return;
            }

            userState.selectedModel = newModel;
            console.log(`[Модель] Пользователь ${chatId} сменил модель на ${newModel}`);

            let confirmationMessage = '';
            if (newModel.includes('pro')) {
                confirmationMessage = '✅ Вы выбрали самую мощную модель, но придётся долго ждать генерацию.';
            } else {
                confirmationMessage = '✅ Вы выбрали flash версию ИИ, она быстрее, но чуть менее мощная.';
            }

            await bot.answerCallbackQuery(callbackQuery.id, { text: `Модель изменена на ${newModel}` });
            await bot.editMessageText(confirmationMessage, {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id
            });
            return;
        }

        // Обработка старта чата
        if (data === 'start_chat') {
            userStates[chatId].hasCompletedWelcome = true;
            await bot.answerCallbackQuery(callbackQuery.id);
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id
            });
            await bot.sendMessage(chatId, `Переписка началась (в чате 1/${MAX_CHAT_SLOTS}). Нажмите на кнопку в правом нижнем углу, чтобы настроить бота.`, {
                reply_markup: settingsReplyKeyboard
            });
            console.log(`Пользователь ${chatId} нажал "Начать переписываться"`);
            return;
        }

        // Обработка переключения чатов
        if (data.startsWith('switch_chat_')) {
            const slotIndex = parseInt(data.split('_')[2]);
            if (slotIndex >= 0 && slotIndex < MAX_CHAT_SLOTS) {
                const oldSlotIndex = userStates[chatId].activeChatSlot;
                clearIgnoreTimer(chatId, oldSlotIndex);
                if (userStates[chatId].slots[oldSlotIndex].interactions > 0) {
                    setIgnoreTimer(chatId, oldSlotIndex);
                }

                userStates[chatId].activeChatSlot = slotIndex;
                if (chatHistories[chatId][slotIndex].length === 0 && fs.existsSync(getChatHistoryPath(chatId, slotIndex))) {
                    chatHistories[chatId][slotIndex] = loadChatHistory(chatId, slotIndex);
                }

                clearIgnoreTimer(chatId, slotIndex);

                await bot.answerCallbackQuery(callbackQuery.id, { text: `Переключено на чат ${slotIndex + 1}` });
                await bot.deleteMessage(chatId, callbackQuery.message.message_id);
                await bot.sendMessage(chatId, `Вы переключились на чат ${slotIndex + 1}.`, {
                    reply_markup: settingsReplyKeyboard
                });
                console.log(`Пользователь ${chatId} переключился на чат ${slotIndex + 1}`);
            } else {
                await bot.answerCallbackQuery(callbackQuery.id, { text: 'Ошибка выбора чата', show_alert: true });
            }
            return;
        }
    } catch (error) {
        console.error(`❌ Ошибка в callback_query (${chatId}):`, error.message);
        try {
            await bot.answerCallbackQuery(callbackQuery.id, { text: 'Произошла ошибка', show_alert: true });
        } catch (e) { /* ignore */ }
    }
});

function extractAndRemoveCommands(text, slotState) { // isDebugMode больше не нужен
    const patterns = [
        {
            regex: /<Уровень доверия\s*=\s*(-?\d+)>/g,
            action: (value) => {
                const newValue = parseInt(value, 10);
                slotState.relationshipLevel = Math.max(-100, Math.min(100, newValue));
            }
        },
        { regex: /<Изменить статус отношений на:\s*(.*?)>/g, action: (status) => slotState.relationshipStatus = status.trim() },
        {
            regex: /<Стресс\s*=\s*(\d+)>/g,
            action: (value) => {
                const newValue = parseInt(value, 10);
                slotState.stressLevel = Math.max(0, Math.min(100, newValue));
            }
        },
        { regex: /<Дать бан>/g, action: () => slotState.isBanned = true },
        { regex: /<Пользователь попрощался>/g, action: () => { slotState.ignoreState = 'goodbye'; console.log(`Статус одного из чатов изменен на 'goodbye'`); } },
        { regex: /<Пользователь в сети>/g, action: () => { slotState.ignoreState = 'default'; console.log(`Статус одного из чатов изменен на 'default'`); } },
    ];

    // Итерируемся по паттернам и выполняем действия, если команда найдена.
    // Мы НЕ изменяем текст, а только считываем данные.
    patterns.forEach(pattern => {
        const regex = new RegExp(pattern.regex.source, 'g');
        let match;
        while ((match = regex.exec(text)) !== null) {
            const value = match.length > 1 ? match[1] : match[0];
            pattern.action(value);
        }
    });

    // Возвращаем исходный, нетронутый текст.
    // Вся обработка тегов будет в sendSplitMessage.
    return text;
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    initializeUser(chatId);

    const activeSlotIndex = userStates[chatId].activeChatSlot;
    const slotState = userStates[chatId].slots[activeSlotIndex];

    // Проверка режима ожидания биографии
    // НАЙДИТЕ И ЗАМЕНИТЕ ЭТОТ БЛОК КОДА ВНУТРИ bot.on('message', ...)
// Проверка режима ожидания характера
	if (slotState.isWaitingForBio) {
        if (!msg.text) {
            await bot.sendMessage(chatId, 'Пожалуйста, введи свою биографию текстом, или напиши /cancel для отмены.', {
                reply_markup: settingsReplyKeyboard
            });
            return;
        }
        if (msg.text.toLowerCase() === '/cancel') {
            slotState.isWaitingForBio = false;
            await bot.sendMessage(chatId, '✅ Ввод биографии отменен.', {
                reply_markup: settingsReplyKeyboard
            });
            return;
        }
        
        const bioText = msg.text;
        slotState.isWaitingForBio = false;

        if (bioText.toLowerCase() === 'erase') {
            slotState.userBio = '';
            clearChatHistoryAndState(chatId, activeSlotIndex); 
            await bot.sendMessage(chatId, '✅ Твоя биография стёрта. Наш диалог очищен, чтобы я это не забыла.', {
                reply_markup: settingsReplyKeyboard
            });
            return;
        }

        if (bioText.length > 700) {
            await bot.sendMessage(chatId, '❌ Ой, это слишком длинная биография (больше 700 символов). Попробуй еще раз.', {
                reply_markup: settingsReplyKeyboard
            });
            slotState.isWaitingForBio = true; 
            return;
        }

        slotState.userBio = bioText;
        // ИЗМЕНЕНИЕ: Сбрасываем историю и предупреждаем пользователя
        clearChatHistoryAndState(chatId, activeSlotIndex); 
        await bot.sendMessage(chatId, '✅ Отлично, я запомнила твою историю! **Наш текущий диалог сброшен**, чтобы изменения вступили в силу. Начинаем с чистого листа!', {
            reply_markup: settingsReplyKeyboard,
            parse_mode: 'Markdown'
        });
        return;
    }

    // 2. Обработка ввода ХАРАКТЕРА
    if (slotState.isWaitingForCharacter) {
		if (!msg.text) {
			await bot.sendMessage(chatId, 'Пожалуйста, введите текст для характера или напишите /cancel для отмены.', {
				reply_markup: settingsReplyKeyboard
			});
			return;
		}
		if (msg.text.toLowerCase() === '/cancel') {
			slotState.isWaitingForCharacter = false;
			await bot.sendMessage(chatId, '✅ Ввод характера отменен.', {
				reply_markup: settingsReplyKeyboard
			});
			return;
		}

		const characterText = msg.text;
		slotState.isWaitingForCharacter = false;

		if (characterText.toLowerCase() === 'erase') {
			slotState.characterDescription = '';
            // ИЗМЕНЕНИЕ: Сбрасываем историю
			clearChatHistoryAndState(chatId, activeSlotIndex);
			await bot.sendMessage(chatId, '✅ Характер Горепочки сброшен к стандартному. **Наш диалог очищен.**', {
				 reply_markup: settingsReplyKeyboard,
                 parse_mode: 'Markdown'
			});
			return;
		}
		
		if (characterText.length > 400) {
			await bot.sendMessage(chatId, '❌ Ой, это слишком длинное описание (больше 400 символов). Попробуйте еще раз.', {
				reply_markup: settingsReplyKeyboard
			});
            slotState.isWaitingForCharacter = true;
			return;
		}

        slotState.characterDescription = characterText;
        // ИЗМЕНЕНИЕ: Сбрасываем историю и предупреждаем пользователя
        clearChatHistoryAndState(chatId, activeSlotIndex);
        await bot.sendMessage(chatId, '✅ Характер изменён! **Наш текущий диалог сброшен**, чтобы я сразу вошла в роль. Просто напиши что-нибудь!', {
            reply_markup: settingsReplyKeyboard,
            parse_mode: 'Markdown'
        });
        return;
    }

    // 3. Обработка ИМПОРТА ФАЙЛА
    if (slotState.isWaitingForImportFile) {
        if (msg.text && msg.text.toLowerCase() === '/cancel') {
            slotState.isWaitingForImportFile = false;
            await bot.sendMessage(chatId, '✅ Импорт отменен.', {
                reply_markup: settingsReplyKeyboard
            });
            return;
        }
        await processImportFile(bot, msg);
        return;
    }


    if (msg.animation || msg.photo || (msg.document && msg.document.mime_type.startsWith('image/')) || msg.sticker || msg.voice) {
        if (!userStates[chatId].hasCompletedWelcome) {
            await showWelcomeMessage(chatId);
            return;
        }
        if (msg.animation) return await handleAnimatedMedia(bot, msg);
        if (msg.photo || (msg.document && msg.document.mime_type.startsWith('image/')) || msg.sticker) return await handleVisualMedia(bot, msg);
        if (msg.voice) return await handleVoiceMessage(msg);
        return;
    }

    const userInput = msg.text;
    if (!userInput) return;

    if (!(await isChatValid(chatId))) return;

    // Обработка настроек через reply-клавиатуру
    if (userInput === '🗑️ Очистить историю') {
        clearChatHistoryAndState(chatId, activeSlotIndex);
        clearIgnoreTimer(chatId, activeSlotIndex);
        await bot.sendMessage(chatId, `Чат ${activeSlotIndex + 1} очищен 🗑️.`, {
            reply_markup: settingsReplyKeyboard
        });
        return;
    }
    if (userInput === '🛠️ Режим отладки') {
        userStates[chatId].isDebugMode = !userStates[chatId].isDebugMode;
        await bot.sendMessage(chatId, userStates[chatId].isDebugMode
            ? "✅ Включён режим отладки. Команды <> теперь будут видны."
            : "☑️ Режим отладки выключен. Команды <> вновь будут скрыты.", {
                reply_markup: settingsReplyKeyboard
            });
        return;
    }
    if (userInput === '🔄 Выбрать чат') {
        const keyboard = {
            keyboard: [
                [
                    { text: getChatButtonText(chatId, 0) },
                    { text: getChatButtonText(chatId, 1) },
                    { text: getChatButtonText(chatId, 2) }
                ],
                [
                    { text: getChatButtonText(chatId, 3) },
                    { text: getChatButtonText(chatId, 4) },
                    { text: getChatButtonText(chatId, 5) }
                ],
                [
                    { text: getChatButtonText(chatId, 6) },
                    { text: getChatButtonText(chatId, 7) },
                    { text: '🔙 Назад' }
                ]
            ],
            resize_keyboard: true,
            one_time_keyboard: false
        };
        await bot.sendMessage(chatId, 'Выберите чат:', { reply_markup: keyboard });
        return;
    }

    if (userInput.startsWith('➡️ Чат ') || userInput.startsWith('Чат ') || userInput.startsWith('Слот ')) {
        const match = userInput.match(/(\d+)/);
        if (match) {
            const slotIndex = parseInt(match[1]) - 1;
            if (slotIndex >= 0 && slotIndex < MAX_CHAT_SLOTS) {
                const slotState = userStates[chatId].slots[slotIndex];
                if (slotState.isBanned) {
                    await bot.sendMessage(chatId, 'Этот чат заблокирован.', { reply_markup: settingsReplyKeyboard });
                    return;
                }
                const oldSlotIndex = userStates[chatId].activeChatSlot;
                clearIgnoreTimer(chatId, oldSlotIndex);
                if (userStates[chatId].slots[oldSlotIndex].interactions > 0) {
                    setIgnoreTimer(chatId, oldSlotIndex);
                }
                userStates[chatId].activeChatSlot = slotIndex;
                if (chatHistories[chatId][slotIndex].length === 0 && fs.existsSync(getChatHistoryPath(chatId, slotIndex))) {
                    chatHistories[chatId][slotIndex] = loadChatHistory(chatId, slotIndex);
                }
                clearIgnoreTimer(chatId, slotIndex);
                await bot.sendMessage(chatId, `Вы переключились на чат ${slotIndex + 1}.`, {
                    reply_markup: settingsReplyKeyboard
                });
                console.log(`Пользователь ${chatId} переключился на чат ${slotIndex + 1}`);
                await sendRelationshipStats(bot, chatId, userStates[chatId].slots[slotIndex]);
            } else {
                await bot.sendMessage(chatId, 'Ошибка выбора чата.', { reply_markup: settingsReplyKeyboard });
            }
        }
        return;
    }

    if (userInput === '🔙 Назад') {
        await bot.sendMessage(chatId, 'Возвращаемся к настройкам.', { reply_markup: settingsReplyKeyboard });
        return;
    }
    if (userInput === '📝 Установить биографию') {
        slotState.isWaitingForBio = true;
        await bot.sendMessage(chatId, 'Расскажи свою биографию Горепочке (до 700 символов). Если хочешь сбросить биографию, напиши "Erase". Для отмены напиши /cancel.', {
            reply_markup: settingsReplyKeyboard
        });
        return;
    }
    if (userInput === '📝 Задать характер') {
        slotState.isWaitingForCharacter = true;
        await bot.sendMessage(chatId, 'Задайте характер Горепочке (до 300 символов). Для отмены напишите /cancel.', {
            reply_markup: settingsReplyKeyboard
        });
        return;
    }
    if (userInput === '📤 Экспортировать чат') {
        await handleExport(bot, chatId);
        return;
    }
    if (userInput === '📥 Импортировать чат') {
        slotState.isWaitingForImportFile = true;
        await bot.sendMessage(chatId, 'Пришли JSON-файл, экспортированный ранее. Для отмены напишите /cancel.', {
            reply_markup: settingsReplyKeyboard
        });
        return;
    }
    if (userInput === '🤖 Выбрать модель') {
        const modelKeyboard = {
            keyboard: [
                [{ text: '🧠 gemini-2.5-pro' }, { text: '⚡ gemini-2.5-flash' }]
            ],
            resize_keyboard: true,
            one_time_keyboard: true
        };
        await bot.sendMessage(chatId, 'Выберите модель:', {
            reply_markup: modelKeyboard
        });
        return;
    }
    if (userInput === 'ℹ️ Титры') {
        await bot.sendMessage(chatId, creditsText, { parse_mode: 'Markdown', reply_markup: settingsReplyKeyboard });
        return;
    }
    if (userInput === '📄 Изменения') {
        try {
            const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
            await bot.sendMessage(chatId, `📄 Последние изменения:\n${changelog}`, { parse_mode: 'Markdown', reply_markup: settingsReplyKeyboard });
        } catch (error) {
            await bot.sendMessage(chatId, '❌ Не удалось загрузить список изменений.', {
                reply_markup: settingsReplyKeyboard
            });
        }
        return;
    }
    if (userInput === '🧠 gemini-2.5-pro' || userInput === '⚡ gemini-2.5-flash') {
        const newModel = userInput.includes('pro') ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
        if (userStates[chatId].selectedModel === newModel) {
            await bot.sendMessage(chatId, 'Эта модель уже активна!', {
                reply_markup: settingsReplyKeyboard
            });
        } else {
            userStates[chatId].selectedModel = newModel;
            await bot.sendMessage(chatId, newModel.includes('pro')
                ? '✅ Вы выбрали самую мощную модель, но придётся долго ждать генерацию.'
                : '✅ Вы выбрали flash версию ИИ, она быстрее, но чуть менее мощная.', {
                    reply_markup: settingsReplyKeyboard
                });
        }
        return;
    }

    // Проверка неподдерживаемых команд
    if (userInput.startsWith('/')) {
        if (!['/start', '/chatlist'].includes(userInput)) {
            await bot.sendMessage(chatId, 'Эта команда не поддерживается. Используйте reply-клавиатуру для настроек.');
            return;
        }
    }

    if (!userStates[chatId].hasCompletedWelcome) {
        await showWelcomeMessage(chatId);
        return;
    }

    await processUserText(chatId, userInput, msg.message_id);
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
                userPrompt = 'Пользователь прислал этот анимированный стикер, проанализируй контекст недавних реплик и ответь на это.';
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

        currentSlotState.interactions++;
        currentSlotState.lastActive = Date.now();

        // Формируем системный промпт
        let fullSystemPrompt = systemPrompt || '';
        if (currentSlotState.characterDescription && currentSlotState.characterDescription.trim() !== '') {
            fullSystemPrompt += `\n\n[Дополнительное описание характера: "${currentSlotState.characterDescription}"]`;
        }
        if (currentSlotState.userBio && currentSlotState.userBio.trim() !== '') {
            fullSystemPrompt += `\n\n[Важная информация о пользователе (его биография): "${currentSlotState.userBio}"]`;
        }

        const selectedModel = userStates[chatId].selectedModel;
        const model = genAI.getGenerativeModel({
            model: selectedModel,
            systemInstruction: fullSystemPrompt || undefined
        });
        console.log(`[Модель] Чат ${chatId} использует модель: ${selectedModel}`);

        const result = await model.generateContent({ contents });
        const response = await result.response;

        if (!response.candidates?.length) {
            throw new Error("Пустой ответ от Gemini API");
        }
        
        let responseText = response.candidates[0].content.parts[0].text;
        console.log(`[DEBUG] Ответ модели для чата ${chatId}/${activeSlotIndex}: ${responseText}`);

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

        currentSlotState.interactions++;
        currentSlotState.lastActive = Date.now();

        // Формируем системный промпт
        let fullSystemPrompt = systemPrompt || '';
        if (currentSlotState.characterDescription && currentSlotState.characterDescription.trim() !== '') {
            fullSystemPrompt += `\n\n[Дополнительное описание характера: "${currentSlotState.characterDescription}"]`;
        }
        if (currentSlotState.userBio && currentSlotState.userBio.trim() !== '') {
            fullSystemPrompt += `\n\n[Важная информация о пользователе (его биография): "${currentSlotState.userBio}"]`;
        }

        const selectedModel = userStates[chatId].selectedModel;
        const model = genAI.getGenerativeModel({
            model: selectedModel,
            systemInstruction: fullSystemPrompt || undefined
        });
        console.log(`[Модель] Чат ${chatId} использует модель: ${selectedModel}`);

        const result = await model.generateContent({ contents });
        const genResponse = await result.response;

        if (!genResponse.candidates?.length) {
            throw new Error("Пустой ответ от Gemini API");
        }
        
        let responseText = genResponse.candidates[0].content.parts[0].text;
        console.log(`[DEBUG] Ответ модели для чата ${chatId}/${activeSlotIndex}: ${responseText}`);

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
// ПОЛНАЯ ИСПРАВЛЕННАЯ ВЕРСИЯ ДЛЯ ЗАМЕНЫ

// ЗАМЕНИТЕ ЭТУ ФУНКЦИЮ ЦЕЛИКОМ
// ЗАМЕНИТЕ ЭТУ ФУНКЦИЮ ЦЕЛИКОМ

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

    // Сохраняем чистое сообщение пользователя в историю
    currentHistory.push({ role: "user", parts: [{ text: userInput }] });
    currentSlotState.interactions++;
    currentSlotState.lastActive = Date.now();

    try {
        await bot.sendChatAction(chatId, 'typing');

        // Создаем временную копию истории для отправки в API
        const contents = currentHistory.map(msg => ({
            role: msg.role === "assistant" ? "model" : msg.role,
            parts: JSON.parse(JSON.stringify(msg.parts)) // Глубокое копирование
        }));

        // --- ГЛАВНОЕ ИЗМЕНЕНИЕ: ИНЪЕКЦИЯ ХАРАКТЕРА В ПЕРВОЕ СООБЩЕНИЕ ---
        
        // Считаем, сколько сообщений от пользователя уже было в истории
        const userMessagesCount = currentHistory.filter(m => m.role === 'user').length;
        
        // Если это самое первое сообщение от пользователя и характер задан
        if (currentSlotState.characterDescription && userMessagesCount === 1) {
            const characterInstruction = `(СИСТЕМНАЯ ИНСТРУКЦИЯ ДЛЯ ТЕБЯ, А НЕ ДЛЯ ПОЛЬЗОВАТЕЛЯ: Это начало нашего диалога. Твоя задача — немедленно, с самого первого слова, полностью принять и отыгрывать следующую роль. ЗАПРЕЩЕНО вести себя как обычный ассистент. Твоя роль: "${currentSlotState.characterDescription}". Начинай свой первый ответ СРАЗУ в этой роли, обращаясь к пользователю.)`;
            
            // Находим последнее сообщение во временной копии (это и есть первое сообщение юзера)
            const lastMessage = contents[contents.length - 1];
            if (lastMessage && lastMessage.role === 'user') {
                // Внедряем инструкцию ПЕРЕД текстом пользователя
                lastMessage.parts[0].text = `${characterInstruction}\n\nСообщение от пользователя, на которое нужно ответить в роли: "${lastMessage.parts[0].text}"`;
                console.log(`[Инъекция] Характер (${currentSlotState.characterDescription}) внедрен в первое сообщение для чата ${chatId}`);
            }
        }
        // --- КОНЕЦ ГЛАВНОГО ИЗМЕНЕНИЯ ---

        // Формируем системный промпт. Он теперь может быть проще.
        let fullSystemPrompt = systemPrompt || '';
        
        // ВАЖНО: Добавляем характер и сюда, чтобы он сохранялся в последующих сообщениях
        if (currentSlotState.characterDescription && currentSlotState.characterDescription.trim() !== '') {
            fullSystemPrompt += `\n\n[ТВОЙ ХАРАКТЕР]: Ты всегда должна придерживаться этой роли: "${currentSlotState.characterDescription}"`;
        }

        if (currentSlotState.userBio && currentSlotState.userBio.trim() !== '') {
            fullSystemPrompt += `\n\n[БИОГРАФИЯ ПОЛЬЗОВАТЕЛЯ]: Учитывай эту информацию о пользователе: "${currentSlotState.userBio}"`;
        }

        console.log(`[DEBUG] Полный системный промпт для чата ${chatId}/${activeSlotIndex}: ${fullSystemPrompt}`);

        const selectedModel = userStates[chatId].selectedModel;
        const model = genAI.getGenerativeModel({
            model: selectedModel,
            systemInstruction: fullSystemPrompt || undefined
        });
        console.log(`[Модель] Чат ${chatId} использует модель: ${selectedModel}`);

        // Отправляем в API временную историю с инъекцией
        const result = await model.generateContent({ contents });
        const response = await result.response;

        if (!response.candidates?.length) throw new Error("Пустой ответ от Gemini API");

        let botResponse = response.candidates[0].content.parts[0].text;
        console.log(`[DEBUG] Ответ модели для чата ${chatId}/${activeSlotIndex}: ${botResponse}`);

        const isDebug = userStates[chatId].isDebugMode;
        botResponse = extractAndRemoveCommands(botResponse, currentSlotState);
        
        // Сохраняем ответ модели в НАСТОЯЩУЮ историю
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
        console.error(`❌ Ошибка при работе с ботом (${chatId}):`, error.message, error.stack);
        // Откатываем последнее сообщение пользователя, если API выдало ошибку
        currentHistory.pop();
        await bot.sendMessage(chatId, '🚫 Кажется, я не могу сейчас ответить. Возможно, сработала цензура или закончились лимиты. Попробуй переформулировать.');
        currentSlotState.spamCounter = 0;
    }
}

async function sendSplitMessage(bot, chatId, originalText, isAiResponseType, replyToMessageId) {
    const isDebugMode = userStates[chatId]?.isDebugMode || false;
    let typingTimer;

    const startTyping = async () => {
        // ... (код этой вложенной функции остается без изменений) ...
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
        // ... (код этой вложенной функции остается без изменений) ...
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

            // --- КЛЮЧЕВОЕ ИЗМЕНЕНИЕ: ОЧИСТКА ТЕКСТА ПРОИСХОДИТ ЗДЕСЬ ---
            let cleanText = textChunk;
            if (!isDebugMode) {
                // В обычном режиме удаляем ВСЕ команды из текущего куска текста
                cleanText = cleanText.replace(/<[^>]*>/g, '').trim();
            } else {
                 // В режиме отладки просто убираем лишние пробелы
                 cleanText = cleanText.trim();
            }

            if (!cleanText) return null; // Если после очистки ничего не осталось, не отправляем

            const options = createMessageOptions(cleanText);
            const sent = await bot.sendMessage(chatId, cleanText, options);
            isFirstChunk = false;
            return sent;
        };
        
        // Разделяем "грязный" текст по команде.
        const parts = originalText.split(/<Разделить сообщение>/g);

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!(await isChatValid(chatId))) { stopTyping(); return messageIds; }
            
            // Если это не первый кусок и мы в режиме отладки, добавляем видимый разделитель
            if (i > 0 && isDebugMode) {
                 await sendMessageAndUpdateFlag('_<Разделить сообщение>_');
            }
            
            // Вычисляем задержку на основе "грязного" текста без команд
            const textWithoutCommands = part.replace(/<.*?>/g, '');
            const timePerCharacter = 62;
            const delay = textWithoutCommands.length * timePerCharacter;

            await new Promise(resolve => setTimeout(resolve, delay));

            // Отправляем текущий "грязный" кусок в нашу новую умную функцию отправки
            const sent = await sendMessageAndUpdateFlag(part);
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

async function handleExport(bot, chatId) {
    try {
        initializeUser(chatId);
        const userState = userStates[chatId];
        const activeSlotIndex = userState.activeChatSlot;

        const currentSlotState = userState.slots[activeSlotIndex];
        const currentHistory = chatHistories[chatId][activeSlotIndex];

        // +++ НАЧАЛО ИСПРАВЛЕНИЯ: Исключаем таймер из экспорта +++
        // Создаем поверхностную копию состояния слота, чтобы не изменять оригинал
        const stateToExport = { ...currentSlotState };
        // Удаляем из КОПИИ свойство с таймером, которое вызывает ошибку "circular structure"
        delete stateToExport.ignoreTimer;
        // +++ КОНЕЦ ИСПРАВЛЕНИЯ +++

        // 1. Создаем структурированный объект для экспорта
        const exportData = {
            exportVersion: 1, // Версия для проверки при импорте
            exportedAt: new Date().toISOString(),
            // Сохраняем ОЧИЩЕННУЮ копию состояния слота
            slotState: stateToExport,
            // Сохраняем ПОЛНУЮ историю сообщений
            history: currentHistory
        };
        
        // 2. Превращаем объект в JSON и создаем буфер для отправки
        const fileContent = JSON.stringify(exportData, null, 2); // null, 2 для красивого форматирования
        const fileBuffer = Buffer.from(fileContent, 'utf8');

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `export_chat_${activeSlotIndex + 1}_${timestamp}.json`;

        // 3. Отправляем файл как документ
        await bot.sendDocument(chatId, fileBuffer, {}, {
            filename: fileName,
            contentType: 'application/json'
        });

        console.log(`✅ Экспорт для чата ${chatId}, слот ${activeSlotIndex + 1} успешно завершен.`);

    } catch (error) {
        console.error(`❌ Ошибка при экспорте для чата ${chatId}:`, error.message);
        await bot.sendMessage(chatId, '🚫 Произошла ошибка при создании файла для экспорта.');
    }
}

/**
 * Обрабатывает полученный JSON-файл для импорта.
 */
async function processImportFile(bot, msg) {
    const chatId = msg.chat.id;
    initializeUser(chatId);
    const userState = userStates[chatId];
    const activeSlotIndex = userState.activeChatSlot;
    const currentSlotState = userState.slots[activeSlotIndex];

    // Сбрасываем флаг ожидания файла
    currentSlotState.isWaitingForImportFile = false;

    // --- Блок проверок безопасности и валидации ---
    if (!msg.document) {
        await bot.sendMessage(chatId, 'Пожалуйста, пришли именно файл. Или напиши /cancel для отмены.');
        currentSlotState.isWaitingForImportFile = true; // Снова ждем файл
        return;
    }

    if (msg.document.mime_type !== 'application/json') {
        await bot.sendMessage(chatId, '❌ Ошибка: Файл должен быть в формате JSON. Попробуй еще раз или напиши /cancel.');
        currentSlotState.isWaitingForImportFile = true; // Снова ждем файл
        return;
    }
    
    try {
        await bot.sendMessage(chatId, '⏳ Получила файл, начинаю проверку и импорт...');
        const fileId = msg.document.file_id;
        const fileStream = bot.getFileStream(fileId);
        
        let fileContent = '';
        for await (const chunk of fileStream) {
            fileContent += chunk.toString('utf8');
        }

        const importedData = JSON.parse(fileContent);

        // Главная проверка: это наш файл или случайный?
        if (importedData.exportVersion !== 1 || !importedData.slotState || !Array.isArray(importedData.history)) {
             await bot.sendMessage(chatId, '❌ Ошибка: Структура файла не соответствует стандарту. Убедись, что это файл, экспортированный из этого бота.');
             return;
        }

        // --- Если все проверки пройдены, начинаем импорт ---
        
        // 1. Полностью заменяем состояние слота данными из файла
        // Мы используем Object.assign для "умного" слияния на случай, если в новой версии бота появятся поля, которых нет в старом файле
        userStates[chatId].slots[activeSlotIndex] = Object.assign(getDefaultSlotState(), importedData.slotState);
        // Важно! После импорта отключаем флаг ожидания
        userStates[chatId].slots[activeSlotIndex].isWaitingForImportFile = false;


        // 2. Полностью заменяем историю в памяти
        chatHistories[chatId][activeSlotIndex] = importedData.history;

        // 3. Сохраняем новую импортированную историю на диск
        saveChatHistory(chatId, activeSlotIndex, importedData.history);
        
        // 4. Сбрасываем таймер для этого слота, так как мы "обновили" диалог
        clearIgnoreTimer(chatId, activeSlotIndex);

        console.log(`✅ Импорт для чата ${chatId}, слот ${activeSlotIndex + 1} успешно завершен.`);
        await bot.sendMessage(chatId, '✅ Файл с перепиской успешно импортирован! Твой диалог и отношения с Горепочкой восстановлены.');
        
        // Отправляем обновленную статистику для подтверждения
        await sendRelationshipStats(bot, chatId, userStates[chatId].slots[activeSlotIndex]);


    } catch (error) {
        console.error(`❌ Ошибка импорта для чата ${chatId}:`, error.message);
        await bot.sendMessage(chatId, '🚫 Ой! Произошла критическая ошибка при чтении файла. Возможно, он поврежден. Импорт отменен.');
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
