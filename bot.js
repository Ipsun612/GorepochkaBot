require('dotenv').config();
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
        userBio: '', 
        isWaitingForBio: false, 
        characterDescription: '',
        isWaitingForCharacter: false,
        // +++ ИЗМЕНЕНИЕ: Добавляем флаг блокировки для предотвращения гонки состояний +++
        isGenerating: false,
        isWaitingForImportFile: false // Добавил недостающий флаг для чистоты
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

function setIgnoreTimer(chatId, slotIndex) {
    // Сначала всегда сбрасываем старый таймер, чтобы не было дублей
    clearIgnoreTimer(chatId, slotIndex);

    // +++ ДОБАВЛЕНО: Проверяем, включил ли пользователь эту функцию глобально +++
    if (!userStates[chatId]?.ignoreTimerEnabled) {
        console.log(`[Таймер для ${chatId}/${slotIndex}] Установка отменена: функция отключена пользователем.`);
        return;
    }

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
        // +++ ИЗМЕНЕНО: Время задержки увеличено до 19-24 часов +++
        // от 19 до 24 часов в миллисекундах
        minDelay = 19 * 60 * 60 * 1000;
        maxDelay = 24 * 60 * 60 * 1000;
        console.log(`[Таймер для ${chatId}/${slotIndex}] Установлен стандартный таймер (19-24 часа)`);
    }

    // Генерируем случайную задержку в заданном диапазоне
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

    const timerId = setTimeout(async () => {
        try {
            // Проверяем, что чат все еще существует и активен
            if (!userStates[chatId] || !userStates[chatId].slots[slotIndex] || !(await isChatValid(chatId))) {
                console.log(`[Таймер для ${chatId}/${slotIndex}] Отменен: чат недействителен.`);
                return;
            }
            
            console.log(`[Таймер для ${chatId}/${slotIndex}] СРАБОТАЛ! Отправка команды <Игнор от пользователя>`);
            
            // Имитируем сообщение от пользователя с внутренней командой
            await processUserText(chatId, '<Игнор от пользователя>');
        
        } catch (error) {
            // Логируем ошибку, чтобы она не "убила" приложение
            console.error(`❌ Критическая ошибка в таймере setIgnoreTimer для чата ${chatId}/${slotIndex}:`, error.message);
        }
    }, delay);

    // Сохраняем ID таймера в состоянии слота
    slotState.ignoreTimer = timerId;
}

// --- КОНЕЦ БЛОКА: ЛОГИКА ТАЙМЕРА "ИГНОРА" ---




// +++ ИЗМЕНЕННАЯ ВЕРСИЯ ДЛЯ ЗАМЕНЫ +++
function initializeUser(chatId) {
    if (!userStates[chatId]) {
        userStates[chatId] = {
            hasCompletedWelcome: false,
            activeChatSlot: 0,
            slots: Array(MAX_CHAT_SLOTS).fill(null).map(() => getDefaultSlotState()),
            isDebugMode: false,
            timezoneOffset: null, // <--- ДОБАВЛЕНО: Смещение в минутах (null = не установлено)
            selectedModel: process.env.GEMINI_MODEL_NAME || "gemini-2.5-flash",
            ignoreTimerEnabled: true,
            currentMenu: 'main'
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

    try {
        initializeUser(chatId); // Убедимся, что пользователь есть в системе
        userStates[chatId].timezoneOffset = parseInt(offset, 10);

        console.log(`[Время] Для чата ${chatId} установлен часовой пояс со смещением ${offset} минут.`);

        // Отправляем подтверждение в чат
        await bot.sendMessage(chatId, 'Отлично! ✨ Ваш часовой пояс был настроен. Теперь, Горепочка будет знать, когда у вас утро, а когда ночь.');
        
        // Сразу отправляем первое сообщение со временем для немедленного эффекта
        await processUserText(chatId, '<Время только что синхронизировано>');

        res.status(200).send('Timezone updated');

    } catch (e) {
        console.error("Не удалось обработать запрос на синхронизацию времени:", e.message);
        res.status(500).send('Internal server error');
    }
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

function getReplyKeyboard(chatId) {
    const userState = userStates[chatId];
    if (!userState) return { remove_keyboard: true };

    const reminderButtonText = userState.ignoreTimerEnabled
        ? '🔕 Отключить напоминания'
        : '🔔 Включить напоминания';

    // +++ НОВЫЙ БЛОК: Динамический текст для кнопки времени +++
    const timeButtonText = userState.timezoneOffset !== null
        ? '🚫 Забыть время'
        : '⏰ Синхр. время';
    // +++ КОНЕЦ НОВОГО БЛОКА +++

    let keyboard;

    switch (userState.currentMenu) {
        case 'main_settings':
            keyboard = [
                [{ text: '📝 Установить биографию' }, { text: '📝 Задать характер' }],
                // +++ ИЗМЕНЕНИЕ: Добавляем новую кнопку +++
                [{ text: timeButtonText }, { text: '🤖 Выбрать модель' }],
                [{ text: reminderButtonText }],
                [{ text: '🔙 Назад' }]
            ];
            break;

        // ... остальные case без изменений ...
        
        case 'advanced_settings':
            keyboard = [
                [{ text: '📤 Экспортировать чат' }, { text: '📥 Импортировать чат' }],
                [{ text: '🛠️ Режим отладки' }],
                [{ text: '🔙 Назад' }]
            ];
            break;

        case 'info':
            keyboard = [
                [{ text: '📄 Изменения' }, { text: 'ℹ️ Титры' }],
                [{ text: '🔙 Назад' }]
            ];
            break;

        case 'main':
        default:
            keyboard = [
                [{ text: '🗑️ Очистить историю' }, { text: '🔄 Выбрать чат' }],
                [{ text: '⚙️ Основные настройки' }],
                [{ text: '🛠️ Расширенные настройки' }],
                [{ text: 'ℹ️ Дополнительно' }]
            ];
            break;
    }

    return { keyboard, resize_keyboard: true };
}


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
            // +++ ИЗМЕНЕНИЕ ЗДЕСЬ +++
            await bot.sendMessage(chatId, `Переписка началась (в чате 1/${MAX_CHAT_SLOTS}). Нажмите на кнопку в правом нижнем углу, чтобы настроить бота.`, {
                reply_markup: getReplyKeyboard(chatId)
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

// +++ ПОЛНАЯ ВЕРСИЯ ДЛЯ ЗАМЕНЫ +++
// +++ ПОЛНАЯ ВЕРСИЯ ДЛЯ ЗАМЕНЫ +++
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    initializeUser(chatId);

    const activeSlotIndex = userStates[chatId].activeChatSlot;
    const slotState = userStates[chatId].slots[activeSlotIndex];
    const userState = userStates[chatId];
    const userInput = msg.text;

    if (!userInput) { // Игнорируем сообщения без текста, если это не медиа
        if (msg.animation || msg.photo || (msg.document && msg.document.mime_type.startsWith('image/')) || msg.sticker || msg.voice) {
           // Обработка медиа будет ниже
        } else {
            return;
        }
    }

    // --- ПРОВЕРКА СПЕЦИАЛЬНЫХ СОСТОЯНИЙ (ожидание ввода) ---
    // Эти проверки имеют наивысший приоритет
    if (slotState.isWaitingForBio) {
        // ... (Этот блок кода остается без изменений, но я включаю его для полноты)
        if (userInput.toLowerCase() === '/cancel') {
            slotState.isWaitingForBio = false;
            await bot.sendMessage(chatId, '✅ Ввод биографии отменен.', { reply_markup: getReplyKeyboard(chatId) });
            return;
        }
        const bioText = userInput;
        slotState.isWaitingForBio = false;
        if (bioText.toLowerCase() === 'erase') {
            slotState.userBio = '';
            clearChatHistoryAndState(chatId, activeSlotIndex);
            await bot.sendMessage(chatId, '✅ Твоя биография стёрта. Наш диалог очищен.', { reply_markup: getReplyKeyboard(chatId) });
            return;
        }
        if (bioText.length > 700) {
            await bot.sendMessage(chatId, '❌ Слишком длинная биография (больше 700 символов). Попробуй еще раз.', { reply_markup: getReplyKeyboard(chatId) });
            slotState.isWaitingForBio = true;
            return;
        }
        slotState.userBio = bioText;
        clearChatHistoryAndState(chatId, activeSlotIndex);
        await bot.sendMessage(chatId, '✅ Биография сохранена! **Текущий диалог сброшен**, чтобы изменения вступили в силу.', { reply_markup: getReplyKeyboard(chatId), parse_mode: 'Markdown' });
        return;
    }
    if (slotState.isWaitingForCharacter) {
        // ... (Этот блок кода остается без изменений)
        if (userInput.toLowerCase() === '/cancel') {
            slotState.isWaitingForCharacter = false;
            await bot.sendMessage(chatId, '✅ Ввод характера отменен.', { reply_markup: getReplyKeyboard(chatId) });
            return;
        }
        const characterText = userInput;
        slotState.isWaitingForCharacter = false;
        if (characterText.toLowerCase() === 'erase') {
            slotState.characterDescription = '';
            clearChatHistoryAndState(chatId, activeSlotIndex);
            await bot.sendMessage(chatId, '✅ Характер сброшен к стандартному. **Диалог очищен.**', { reply_markup: getReplyKeyboard(chatId), parse_mode: 'Markdown' });
            return;
        }
        if (characterText.length > 400) {
            await bot.sendMessage(chatId, '❌ Слишком длинное описание (больше 400 символов). Попробуйте еще раз.', { reply_markup: getReplyKeyboard(chatId) });
            slotState.isWaitingForCharacter = true;
            return;
        }
        slotState.characterDescription = characterText;
        clearChatHistoryAndState(chatId, activeSlotIndex);
        await bot.sendMessage(chatId, '✅ Характер изменён! **Текущий диалог сброшен**, чтобы я вошла в роль.', { reply_markup: getReplyKeyboard(chatId), parse_mode: 'Markdown' });
        return;
    }
    if (slotState.isWaitingForImportFile) {
        // ... (Этот блок кода остается без изменений)
        if (userInput && userInput.toLowerCase() === '/cancel') {
            slotState.isWaitingForImportFile = false;
            await bot.sendMessage(chatId, '✅ Импорт отменен.', { reply_markup: getReplyKeyboard(chatId) });
            return;
        }
        await processImportFile(bot, msg);
        return;
    }

    // --- ОБРАБОТКА МЕДИАФАЙЛОВ ---
    if (msg.animation || msg.photo || (msg.document && msg.document.mime_type.startsWith('image/')) || msg.sticker || msg.voice) {
        if (!userState.hasCompletedWelcome) {
            await showWelcomeMessage(chatId);
            return;
        }
        try {
            slotState.isGenerating = true;
            if (msg.animation) await handleAnimatedMedia(bot, msg);
            else if (msg.photo || (msg.document && msg.document.mime_type.startsWith('image/')) || msg.sticker) await handleVisualMedia(bot, msg);
            else if (msg.voice) await handleVoiceMessage(msg);
        } finally {
            slotState.isGenerating = false;
        }
        return;
    }

    if (!(await isChatValid(chatId))) return;

    // --- НОВАЯ ЛОГИКА НАВИГАЦИИ ПО МЕНЮ И ОБРАБОТКИ КОМАНД ---
    const commandHandlers = {
        // --- Навигация по меню ---
        '⚙️ Основные настройки': async () => {
            userState.currentMenu = 'main_settings';
            await bot.sendMessage(chatId, 'Раздел: Основные настройки', { reply_markup: getReplyKeyboard(chatId) });
        },
        '🛠️ Расширенные настройки': async () => {
            userState.currentMenu = 'advanced_settings';
            await bot.sendMessage(chatId, 'Раздел: Расширенные настройки', { reply_markup: getReplyKeyboard(chatId) });
        },
        'ℹ️ Дополнительно': async () => {
            userState.currentMenu = 'info';
            await bot.sendMessage(chatId, 'Раздел: Дополнительно', { reply_markup: getReplyKeyboard(chatId) });
        },
        '🔙 Назад': async () => {
            userState.currentMenu = 'main';
            await bot.sendMessage(chatId, 'Главное меню настроек.', { reply_markup: getReplyKeyboard(chatId) });
        },
        // --- Команды ---
        '🗑️ Очистить историю': async () => {
            clearChatHistoryAndState(chatId, activeSlotIndex);
            clearIgnoreTimer(chatId, activeSlotIndex);
            await bot.sendMessage(chatId, `Чат ${activeSlotIndex + 1} очищен 🗑️.`, { reply_markup: getReplyKeyboard(chatId) });
        },
        '🔄 Выбрать чат': async () => {
            const keyboard = { /* ... код для выбора чата остается тот же ... */ };
             await bot.sendMessage(chatId, 'Выберите чат:', { reply_markup: {
                keyboard: [
                    [{ text: getChatButtonText(chatId, 0) }, { text: getChatButtonText(chatId, 1) }, { text: getChatButtonText(chatId, 2) }],
                    [{ text: getChatButtonText(chatId, 3) }, { text: getChatButtonText(chatId, 4) }, { text: getChatButtonText(chatId, 5) }],
                    [{ text: getChatButtonText(chatId, 6) }, { text: getChatButtonText(chatId, 7) }, { text: '🔙 Назад' }]
                ],
                resize_keyboard: true,
            }});
        },
       
		'⏰ Синхр. время': async () => {
			if (!process.env.WEB_APP_URL) {
				console.error('❌ Ошибка: WEB_APP_URL не указан в .env файле!');
				await bot.sendMessage(chatId, '🚫 Ошибка конфигурации сервера. Администратор не указал WEB_APP_URL. Синхронизация невозможна.');
				return;
			}
			const url = `${process.env.WEB_APP_URL}/tz-setup?chatId=${chatId}`;
			await bot.sendMessage(chatId, 'Чтобы задать ваша точное время, нажмите на кнопку ниже и откройте ссылку. Горепочкой клянёмся, что безопасно и никаих данных не нужно *кроме ваших трёх цифр на карточке*', {
				reply_markup: {
					inline_keyboard: [
						[{ text: 'Открыть страницу синхронизации', url: url }]
					]
				}
			});
		},
		'🚫 Забыть время': async () => {
			if (userState.timezoneOffset !== null) {
				userState.timezoneOffset = null;
				await bot.sendMessage(chatId, 'Хорошо, я забыла твой часовой пояс. Больше не буду его учитывать.', { reply_markup: getReplyKeyboard(chatId) });
				// Отправляем команду, чтобы ИИ узнал об этом
				await processUserText(chatId, '<Время забыто>');
			}
		},
		'📝 Установить биографию': async () => {
            slotState.isWaitingForBio = true;
            await bot.sendMessage(chatId, 'Расскажите свою биографию (до 700 символов). Если хотите сбросить, напишите "Erase". Для отмены введите /cancel.', { reply_markup: getReplyKeyboard(chatId) });
        },
        '📝 Задать характер': async () => {
            slotState.isWaitingForCharacter = true;
            await bot.sendMessage(chatId, 'Задайте характер Горепочке (до 400 символов). Для отмены напишите /cancel.', { reply_markup: getReplyKeyboard(chatId) });
        },
        '🤖 Выбрать модель': async () => {
             await bot.sendMessage(chatId, 'Выберите модель:', {
                reply_markup: {
                    keyboard: [[{ text: '🧠 gemini-2.5-pro' }, { text: '⚡ gemini-2.5-flash' }],[{ text: '🔙 Назад' }]],
                    resize_keyboard: true, one_time_keyboard: true
                }
            });
        },
        '🔕 Отключить напоминания': async () => {
            userState.ignoreTimerEnabled = false;
            for (let i = 0; i < MAX_CHAT_SLOTS; i++) clearIgnoreTimer(chatId, i);
            await bot.sendMessage(chatId, '✅ Напоминания отключены.', { reply_markup: getReplyKeyboard(chatId) });
        },
        '🔔 Включить напоминания': async () => {
            userState.ignoreTimerEnabled = true;
            await bot.sendMessage(chatId, '✅ Напоминания включены.', { reply_markup: getReplyKeyboard(chatId) });
        },
        '📤 Экспортировать чат': async () => {
            await handleExport(bot, chatId);
        },
        '📥 Импортировать чат': async () => {
            slotState.isWaitingForImportFile = true;
            await bot.sendMessage(chatId, 'Пришли JSON-файл для импорта. Для отмены напишите /cancel.', { reply_markup: getReplyKeyboard(chatId) });
        },
        '🛠️ Режим отладки': async () => {
            userState.isDebugMode = !userState.isDebugMode;
            await bot.sendMessage(chatId, userState.isDebugMode ? "✅ Включён режим отладки." : "☑️ Режим отладки выключен.", { reply_markup: getReplyKeyboard(chatId) });
        },
        '📄 Изменения': async () => {
            try {
                const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
                await bot.sendMessage(chatId, `📄 Последние изменения:\n${changelog}`, { parse_mode: 'Markdown', reply_markup: getReplyKeyboard(chatId) });
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Не удалось загрузить список изменений.', { reply_markup: getReplyKeyboard(chatId) });
            }
        },
        'ℹ️ Титры': async () => {
            await bot.sendMessage(chatId, creditsText, { parse_mode: 'Markdown', reply_markup: getReplyKeyboard(chatId) });
        },
    };

    // Проверяем, является ли ввод командой из нашего списка
    if (commandHandlers[userInput]) {
        await commandHandlers[userInput]();
        return;
    }

    // Обработка переключения чатов и моделей (которые не в основном меню)
    if (userInput.startsWith('➡️ Чат ') || userInput.startsWith('Чат ') || userInput.startsWith('Слот ')) {
        const match = userInput.match(/(\d+)/);
        if (match) {
            const slotIndex = parseInt(match[1]) - 1;
            if (slotIndex >= 0 && slotIndex < MAX_CHAT_SLOTS) {
                userState.currentMenu = 'main'; // Возвращаемся в главное меню после выбора
                // ... остальная логика переключения чата
                 const currentSlot = userState.slots[slotIndex];
                if (currentSlot.isBanned) {
                    await bot.sendMessage(chatId, 'Этот чат заблокирован.', { reply_markup: getReplyKeyboard(chatId) });
                    return;
                }
                const oldSlotIndex = userState.activeChatSlot;
                clearIgnoreTimer(chatId, oldSlotIndex);
                if (userState.slots[oldSlotIndex].interactions > 0) setIgnoreTimer(chatId, oldSlotIndex);
                userState.activeChatSlot = slotIndex;
                if (chatHistories[chatId][slotIndex].length === 0 && fs.existsSync(getChatHistoryPath(chatId, slotIndex))) {
                    chatHistories[chatId][slotIndex] = loadChatHistory(chatId, slotIndex);
                }
                clearIgnoreTimer(chatId, slotIndex);
                await bot.sendMessage(chatId, `Вы переключились на чат ${slotIndex + 1}.`, { reply_markup: getReplyKeyboard(chatId) });
                await sendRelationshipStats(bot, chatId, userState.slots[slotIndex]);
            }
        }
        return;
    }
     if (userInput === '🧠 gemini-2.5-pro' || userInput === '⚡ gemini-2.5-flash') {
        userState.currentMenu = 'main'; // Возвращаемся в главное меню
        const newModel = userInput.includes('pro') ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
        if (userState.selectedModel !== newModel) {
            userState.selectedModel = newModel;
            await bot.sendMessage(chatId, `✅ Модель изменена на ${newModel}.`, { reply_markup: getReplyKeyboard(chatId) });
        } else {
             await bot.sendMessage(chatId, 'Эта модель уже активна!', { reply_markup: getReplyKeyboard(chatId) });
        }
        return;
    }

    // Если ничего из вышеперечисленного не сработало, значит, это обычное сообщение для бота
    if (slotState.isGenerating) {
        try { await bot.sendMessage(chatId, '⏳ Пожалуйста, подожди, я еще думаю...'); } catch (e) {}
        return;
    }
    
    if (!userState.hasCompletedWelcome) {
        await showWelcomeMessage(chatId);
        return;
    }

    // Запускаем основную логику обработки текста
    try {
        slotState.isGenerating = true;
        await processUserText(chatId, userInput, msg.message_id);
    } finally {
        slotState.isGenerating = false;
    }
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

    // +++ БЛОК ПРОВЕРКИ СПАМА ОСТАЕТСЯ ЗДЕСЬ +++
    const internalCommands = ['<Игнор от пользователя>', '<Время забыто>', '<Время только что синхронизировано>'];
    if (!internalCommands.includes(userInput)) {
        currentSlotState.spamCounter++;
        if (currentSlotState.spamCounter > 2) {
            try {
                await bot.sendMessage(chatId, 'Ой-ой спамить - не хорошо! 😠 Подожди, когда я договорю.');
            } catch (error) { /* ignore */ }
            return;
        }
    }

    // +++ НАЧАЛО КЛЮЧЕВЫХ ИЗМЕНЕНИЙ +++
    
    // Создаем переменную для текста, который пойдет в API
    let processedInput = userInput;

    // 1. Проверяем, установлено ли время и не является ли сообщение внутренней командой
    if (userState.timezoneOffset !== null && !internalCommands.includes(userInput)) {
        const now = new Date();
        // getTimezoneOffset() возвращает смещение в минутах (для UTC+3 это -180).
        // Чтобы получить локальное время, нужно вычесть это смещение (т.к. оно с обратным знаком).
        // new Date() создается в локальном времени системы, но ее внутреннее значение - это UTC timestamp.
        // `now.getTime() - (userState.timezoneOffset * 60 * 1000)` - это правильный способ получить timestamp для времени пользователя.
        const userTime = new Date(now.getTime() - (userState.timezoneOffset * 60 * 1000));
        
        // Используем UTC-методы, чтобы получить компоненты времени из вычисленного timestamp без влияния локали сервера
        const hours = userTime.getUTCHours().toString().padStart(2, '0');
        const minutes = userTime.getUTCMinutes().toString().padStart(2, '0');
        const timeString = `<Время пользователя: ${hours}:${minutes}>`;
        
        // Добавляем команду к сообщению пользователя
        processedInput = `${timeString}\n\n${userInput}`;
        console.log(`[Время] Для чата ${chatId} добавлена временная метка: ${timeString}`);
    }
    
    // 2. Сохраняем в историю ОРИГИНАЛЬНОЕ сообщение пользователя, без нашей команды
    currentHistory.push({ role: "user", parts: [{ text: userInput }] });
    currentSlotState.interactions++;
    currentSlotState.lastActive = Date.now();
    
    // +++ КОНЕЦ КЛЮЧЕВЫХ ИЗМЕНЕНИЙ +++


    try {
        await bot.sendChatAction(chatId, 'typing');

        const contents = currentHistory.map(msg => ({
            role: msg.role === "assistant" ? "model" : msg.role,
            parts: JSON.parse(JSON.stringify(msg.parts)) 
        }));
        
        // Заменяем последнее сообщение в КОПИИ истории на обработанное
        if (contents.length > 0) {
            contents[contents.length - 1].parts[0].text = processedInput;
        }

        const userMessagesCount = currentHistory.filter(m => m.role === 'user').length;
        
        if (currentSlotState.characterDescription && userMessagesCount === 1) {
            const characterInstruction = `(СИСТЕМНАЯ ИНСТРУКЦИЯ ДЛЯ ТЕБЯ, А НЕ ДЛЯ ПОЛЬЗОВАТЕЛЯ: Это начало нашего диалога. Твоя задача — немедленно, с самого первого слова, полностью принять и отыгрывать следующую роль. ЗАПРЕЩЕНО вести себя как обычный ассистент. Твоя роль: "${currentSlotState.characterDescription}". Начинай свой первый ответ СРАЗУ в этой роли, обращаясь к пользователю.)`;
            
            const lastMessage = contents[contents.length - 1];
            if (lastMessage && lastMessage.role === 'user') {
                lastMessage.parts[0].text = `${characterInstruction}\n\nСообщение от пользователя, на которое нужно ответить в роли: "${lastMessage.parts[0].text}"`;
                console.log(`[Инъекция] Характер (${currentSlotState.characterDescription}) внедрен в первое сообщение для чата ${chatId}`);
            }
        }
        
        let fullSystemPrompt = systemPrompt || '';
        if (currentSlotState.characterDescription && currentSlotState.characterDescription.trim() !== '') {
            fullSystemPrompt += `\n\n[ТВОЙ ХАРАКТЕР]: Ты всегда должна придерживаться этой роли: "${currentSlotState.characterDescription}"`;
        }
        if (currentSlotState.userBio && currentSlotState.userBio.trim() !== '') {
            fullSystemPrompt += `\n\n[БИОГРАФИЯ ПОЛЬЗОВАТЕЛЯ]: Учитывай эту информацию о пользователе: "${currentSlotState.userBio}"`;
        }

        const selectedModel = userStates[chatId].selectedModel;
        const model = genAI.getGenerativeModel({
            model: selectedModel,
            systemInstruction: fullSystemPrompt || undefined
        });

        const result = await model.generateContent({ contents });
        const response = await result.response;

        if (!response.candidates?.length) throw new Error("Пустой ответ от Gemini API");

        let botResponse = response.candidates[0].content.parts[0].text;
        
        botResponse = extractAndRemoveCommands(botResponse, currentSlotState);
        
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
