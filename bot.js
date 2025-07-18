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
const DIARY_DIR = path.join(__dirname, 'diaries');
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR);
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);
if (!fs.existsSync(DIARY_DIR)) fs.mkdirSync(DIARY_DIR);

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

const SPECIAL_DATES_PATH = path.join(__dirname, 'knowledge', 'special_dates.json');
let specialDatesList = [];

try {
    if (fs.existsSync(SPECIAL_DATES_PATH)) {
        const datesData = fs.readFileSync(SPECIAL_DATES_PATH, 'utf8');
        specialDatesList = JSON.parse(datesData);
        console.log(`✅ База знаний о датах загружена. Найдено записей: ${specialDatesList.length}`);
    } else {
        console.warn(`⚠️ Файл special_dates.json не найден по пути: ${SPECIAL_DATES_PATH}`);
        fs.mkdirSync(path.dirname(SPECIAL_DATES_PATH), { recursive: true });
        const exampleDates = [
            { "date": "01-01", "event": "Новый Год" },
            { "date": "04-03", "event": "День рождения моего создателя" }
        ];
        fs.writeFileSync(SPECIAL_DATES_PATH, JSON.stringify(exampleDates, null, 2));
        specialDatesList = exampleDates;
        console.log('ℹ️ Создан пример файла special_dates.json. Вы можете его отредактировать.');
    }
} catch (error) {
    console.error(`❌ Ошибка загрузки базы знаний о датах: ${error.message}`);
}

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

const PROMPTS_DIR = path.join(__dirname, 'Prompts/Gorepochka');
let systemPrompt = '';


function loadSystemPrompt(directory) {
    let combinedPrompt = '';
    
    // Проверяем, существует ли указанная директория
    if (!fs.existsSync(directory)) {
        console.warn(`⚠️ Директория с промптами не найдена: ${directory}`);
        // Создаем папку и файл-пример для пользователя
        fs.mkdirSync(directory, { recursive: true });
        const examplePromptPath = path.join(directory, '01_base_prompt.txt');
        const exampleContent = 'Это базовый промпт. Опишите здесь основную роль и поведение вашего персонажа.';
        fs.writeFileSync(examplePromptPath, exampleContent);
        console.log(`ℹ️ Создана папка для промптов и пример файла: ${examplePromptPath}`);
        return exampleContent; // Возвращаем пример, чтобы бот не запускался с пустым промптом
    }

    try {
        // Получаем список всех файлов и папок в директории
        const files = fs.readdirSync(directory);
        
        // Сортируем файлы, чтобы они читались в предсказуемом порядке (например, 01_..., 02_...)
        files.sort();

        files.forEach(file => {
            const fullPath = path.join(directory, file);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                // Если это папка, вызываем эту же функцию для неё (рекурсия)
                combinedPrompt += loadSystemPrompt(fullPath) + '\n\n';
            } else if (path.extname(file).toLowerCase() === '.txt') {
                // Если это .txt файл, читаем его и добавляем содержимое
                console.log(`✅ Загрузка промпта из файла: ${fullPath}`);
                const content = fs.readFileSync(fullPath, 'utf8');
                combinedPrompt += content + '\n\n'; // Добавляем два переноса строки для разделения частей промпта
            }
        });
    } catch (error) {
         console.error(`❌ Ошибка при чтении директории промптов ${directory}: ${error.message}`);
    }

    return combinedPrompt.trim(); // Убираем лишние пробелы в конце
}

// Запускаем процесс загрузки
try {
    systemPrompt = loadSystemPrompt(PROMPTS_DIR);
    if (systemPrompt) {
        console.log('✅ Системный промпт успешно собран из файлов.');
        // Для отладки можно раскомментировать следующую строку, чтобы увидеть итоговый промпт
        // console.log('--- Итоговый системный промпт ---\n', systemPrompt, '\n--- Конец промпта ---');
    } else {
        console.error('❌ Ошибка: Системный промпт пуст. Проверьте папку Prompts/Gorepochka.');
    }
} catch (error) {
    console.error(`❌ Критическая ошибка при загрузке системного промпта: ${error.message}`);
}

const NARRATOR_PROMPTS_DIR = path.join(__dirname, 'Prompts/Narrator');
let narratorSystemPrompt = '';
try {
    narratorSystemPrompt = loadSystemPrompt(NARRATOR_PROMPTS_DIR);
    if (narratorSystemPrompt) {
        console.log('✅ Системный промпт Рассказчика успешно собран.');
    } else {
        // Это не критическая ошибка, так как функция может быть неактивна
        console.warn('⚠️ Системный промпт Рассказчика пуст. Проверьте папку Prompts/Narrator, если планируете использовать эту функцию.');
    }
} catch (error) {
    console.error(`❌ Критическая ошибка при загрузке промпта Рассказчика: ${error.message}`);
}

const chatHistories = {};
const diaries = {};
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
        moodlet: 'В норме', // <--- ЗАМЕНА: stressLevel на moodlet
        isBanned: false,
        ignoreTimer: null,
        ignoreState: 'default',
        userBio: '', 
        isWaitingForBio: false, 
        characterDescription: '',
        isWaitingForCharacter: false,
        isGenerating: false,
        isWaitingForImportFile: false,
		narratorPrompt: '', 
        isWaitingForNarrator: false,
        narratorInterventionCounter: 0
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
        // +++ ИЗМЕНЕНИЕ: Вместо стресса показываем мудлет +++
        const moodlet = `💭 ${slotState.moodlet}`; 
        buttonText += `Чат ${slotIndex + 1} ${icon} ${rel} ${moodlet}`;
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
	if (!diaries[chatId]) {
        diaries[chatId] = Array(MAX_CHAT_SLOTS).fill(null).map(() => []);
	
	}
}

function getDiaryPath(chatId, slotIndex) {
    return path.join(DIARY_DIR, `${chatId}_slot_${slotIndex}_diary.json`);
}

function loadDiary(chatId, slotIndex) {
    // Сначала проверяем кэш
    if (diaries[chatId] && diaries[chatId][slotIndex] && diaries[chatId][slotIndex].length > 0) {
        return diaries[chatId][slotIndex];
    }
    
    // Если в кэше пусто, загружаем с диска
    const filePath = getDiaryPath(chatId, slotIndex);
    if (fs.existsSync(filePath)) {
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            const diaryEntries = JSON.parse(data);
            // Сохраняем в кэш
            if (diaries[chatId]) {
                diaries[chatId][slotIndex] = diaryEntries;
            }
            return diaryEntries;
        } catch (e) {
            console.error(`❌ Ошибка чтения дневника ${chatId}_slot_${slotIndex}:`, e.message);
            return [];
        }
    }
    return [];
}

function saveDiary(chatId, slotIndex, diaryEntries) {
    // Обновляем кэш
    if (diaries[chatId]) {
        diaries[chatId][slotIndex] = diaryEntries;
    }
    // Сохраняем на диск
    const filePath = getDiaryPath(chatId, slotIndex);
    fs.writeFileSync(filePath, JSON.stringify(diaryEntries, null, 2));
}

async function processDiaryCommands(rawText, chatId, slotIndex) {
    const commandRegex = /<Запомнить информацию:\s*(.*?)>/g;
    let match;
    let entryMade = false;

    // Ищем все вхождения команды в тексте
    while ((match = commandRegex.exec(rawText)) !== null) {
        const textToRemember = match[1].trim();
        if (textToRemember) {
            // Загружаем текущие записи
            const diaryEntries = loadDiary(chatId, slotIndex);
            // Добавляем новую
            diaryEntries.push(textToRemember);
            // Сохраняем обновленный дневник
            saveDiary(chatId, slotIndex, diaryEntries);
            entryMade = true;
            console.log(`[Дневник] Сохранена запись для чата ${chatId}/${slotIndex}: "${textToRemember}"`);
        }
    }

    return entryMade; // Возвращаем, была ли сделана запись
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
                 // +++ ДОБАВЛЕНО: Проверка на наличие мудлета для старых чатов +++
                 if (userStates[chatId].slots[slotIndex].moodlet === undefined) {
                    userStates[chatId].slots[slotIndex].moodlet = 'В норме';
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
    // Очистка истории чата
    const historyFilePath = getChatHistoryPath(chatId, slotIndex);
    if (fs.existsSync(historyFilePath)) {
        fs.unlinkSync(historyFilePath);
    }
    if (chatHistories[chatId] && chatHistories[chatId][slotIndex]) {
        chatHistories[chatId][slotIndex] = [];
    }
    
    // +++ ДОБАВЛЕНО: Очистка дневника +++
    const diaryFilePath = getDiaryPath(chatId, slotIndex);
    if (fs.existsSync(diaryFilePath)) {
        fs.unlinkSync(diaryFilePath);
        console.log(`🗑️ Дневник для чата ${chatId}, слот ${slotIndex} очищен.`);
    }
    if (diaries[chatId] && diaries[chatId][slotIndex]) {
        diaries[chatId][slotIndex] = [];
    }

    // Сброс состояния слота
    if (userStates[chatId] && userStates[chatId].slots[slotIndex]) {
        const currentUserBio = userStates[chatId].slots[slotIndex].userBio || '';
        const currentCharacterDescription = userStates[chatId].slots[slotIndex].characterDescription || '';
		const currentNarratorPrompt = userStates[chatId].slots[slotIndex].narratorPrompt || '';
        
        userStates[chatId].slots[slotIndex] = getDefaultSlotState();
        
        userStates[chatId].slots[slotIndex].userBio = currentUserBio;
        userStates[chatId].slots[slotIndex].characterDescription = currentCharacterDescription;
		userStates[chatId].slots[slotIndex].narratorPrompt = currentNarratorPrompt;
		
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
    
    // +++ ИЗМЕНЕНИЕ: Заменяем Стресс на Настроение (мудлет) +++
    const statsMessage = `Статистика (Чат ${userStates[chatId] ? userStates[chatId].activeChatSlot + 1 : 'N/A'}):
  Уровень отношений: ${slotState.relationshipLevel} (${slotState.relationshipStatus})
  Настроение: ${slotState.moodlet}`;
  
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

    const timeButtonText = userState.timezoneOffset !== null
        ? '🚫 Забыть Дату/Время'
        : '⏰ Настроить Дату/Время';

    let keyboard;

    switch (userState.currentMenu) {
        case 'main_settings':
            keyboard = [
                [{ text: '📝 Установить биографию' }, { text: '📝 Задать характер' }],
				[{ text: '📖 Рассказчик' }],
                [{ text: timeButtonText }, { text: '🤖 Выбрать модель' }],
                [{ text: reminderButtonText }],
                [{ text: '🔙 Назад' }]
            ];
            break;
        
        case 'advanced_settings':
            keyboard = [
                [{ text: '📤 Экспортировать чат' }, { text: '📥 Импортировать чат' }],
                [{ text: '🛠️ Режим отладки' }],
                [{ text: '🔙 Назад' }]
            ];
            break;

        case 'info':
            keyboard = [
                // +++ ДОБАВЛЕНА КНОПКА ДНЕВНИКА +++
                [{ text: 'ℹ️ Титры' }, { text: '📄 Изменения' }],
                [{ text: '📔Дневник '}],
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

function extractAndRemoveCommands(text, slotState) { 
    const patterns = [
        {
            regex: /<Уровень отношений\s*=\s*(-?\d+)>/g,
            action: (value) => {
                const newValue = parseInt(value, 10);
                slotState.relationshipLevel = Math.max(-100, Math.min(100, newValue));
            }
        },
        { regex: /<Изменить статус отношений на:\s*(.*?)>/g, action: (status) => slotState.relationshipStatus = status.trim() },
        // +++ НОВЫЙ ПАТТЕРН ДЛЯ МУДЛЕТА +++
        { 
            regex: /<Установить мудлет на:\s*(.*?)>/g, 
            action: (status) => slotState.moodlet = status.trim() 
        },
        // --- СТАРЫЙ ПАТТЕРН ДЛЯ СТРЕССА УДАЛЕН ---
        { regex: /<Дать бан>/g, action: () => slotState.isBanned = true },
        { regex: /<Пользователь попрощался>/g, action: () => { slotState.ignoreState = 'goodbye'; console.log(`Статус одного из чатов изменен на 'goodbye'`); } },
        { regex: /<Пользователь в сети>/g, action: () => { slotState.ignoreState = 'default'; console.log(`Статус одного из чатов изменен на 'default'`); } },
    ];

    patterns.forEach(pattern => {
        const regex = new RegExp(pattern.regex.source, 'g');
        let match;
        while ((match = regex.exec(text)) !== null) {
            const value = match.length > 1 ? match[1] : match[0];
            pattern.action(value);
        }
    });

    return text;
}


bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    initializeUser(chatId);

    const activeSlotIndex = userStates[chatId].activeChatSlot;
    const slotState = userStates[chatId].slots[activeSlotIndex];
    const userState = userStates[chatId];
    const userInput = msg.text;

    if (!userInput) { 
        if (msg.animation || msg.photo || (msg.document && msg.document.mime_type.startsWith('image/')) || msg.sticker || msg.voice) {
           // Обработка медиа будет ниже
        } else {
            return;
        }
    }

    // --- ПРОВЕРКА СПЕЦИАЛЬНЫХ СОСТОЯНИЙ (ожидание ввода) ---
    if (slotState.isWaitingForBio) {
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
        if (userInput && userInput.toLowerCase() === '/cancel') {
            slotState.isWaitingForImportFile = false;
            await bot.sendMessage(chatId, '✅ Импорт отменен.', { reply_markup: getReplyKeyboard(chatId) });
            return;
        }
        await processImportFile(bot, msg);
        return;
    }
	if (slotState.isWaitingForNarrator) {
        if (userInput.toLowerCase() === '/cancel') {
            slotState.isWaitingForNarrator = false;
            await bot.sendMessage(chatId, '✅ Настройка Рассказчика отменена.', { reply_markup: getReplyKeyboard(chatId) });
            return;
        }
        const narratorText = userInput;
        slotState.isWaitingForNarrator = false;

        if (narratorText.toLowerCase() === 'erase') {
            slotState.narratorPrompt = '';
            slotState.narratorInterventionCounter = 0;
            clearChatHistoryAndState(chatId, activeSlotIndex);
            await bot.sendMessage(chatId, '✅ Рассказчик деактивирован. **Диалог очищен.**', { reply_markup: getReplyKeyboard(chatId), parse_mode: 'Markdown' });
            return;
        }

        if (narratorText.length > 3000) {
            await bot.sendMessage(chatId, '❌ Слишком длинное описание (больше 3000 символов). Попробуйте еще раз.', { reply_markup: getReplyKeyboard(chatId) });
            slotState.isWaitingForNarrator = true; // Снова ждем ввода
            return;
        }

        slotState.narratorPrompt = narratorText;
        slotState.narratorInterventionCounter = 0; // Сбрасываем счетчик при новой настройке
        clearChatHistoryAndState(chatId, activeSlotIndex);
        await bot.sendMessage(chatId, '✅ Рассказчик активирован! **Текущий диалог сброшен**, чтобы изменения вступили в силу.', { reply_markup: getReplyKeyboard(chatId), parse_mode: 'Markdown' });
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
        '🗑️ Очистить историю': async () => {
            clearChatHistoryAndState(chatId, activeSlotIndex);
            clearIgnoreTimer(chatId, activeSlotIndex);
            await bot.sendMessage(chatId, `Чат ${activeSlotIndex + 1} очищен 🗑️.`, { reply_markup: getReplyKeyboard(chatId) });
        },
        '🔄 Выбрать чат': async () => {
             await bot.sendMessage(chatId, 'Выберите чат:', { reply_markup: {
                keyboard: [
                    [{ text: getChatButtonText(chatId, 0) }, { text: getChatButtonText(chatId, 1) }, { text: getChatButtonText(chatId, 2) }],
                    [{ text: getChatButtonText(chatId, 3) }, { text: getChatButtonText(chatId, 4) }, { text: getChatButtonText(chatId, 5) }],
                    [{ text: getChatButtonText(chatId, 6) }, { text: getChatButtonText(chatId, 7) }, { text: '🔙 Назад' }]
                ],
                resize_keyboard: true,
            }});
        },
       
		// +++ ИЗМЕНЕНИЕ: Обновляем названия команд +++
		'⏰ Настроить Дату/Время': async () => {
			if (!process.env.WEB_APP_URL) {
				console.error('❌ Ошибка: WEB_APP_URL не указан в .env файле!');
				await bot.sendMessage(chatId, '🚫 Ошибка конфигурации сервера. Администратор не указал WEB_APP_URL. Синхронизация невозможна.');
				return;
			}
			const url = `${process.env.WEB_APP_URL}/tz-setup?chatId=${chatId}`;
			await bot.sendMessage(chatId, 'Чтобы Горепочка знала вашу точную дату и время, нажмите на кнопку ниже, чтобы открыть ссылку. Это безопасно, Горепочка сохраняет только данный трёх цифорок на задней стороне карты и ФИО всех ваших родственников!', {
				reply_markup: {
					inline_keyboard: [
						[{ text: 'Открыть страницу синхронизации', url: url }]
					]
				}
			});
		},
		'🚫 Забыть Дату/Время': async () => {
			if (userState.timezoneOffset !== null) {
				userState.timezoneOffset = null;
				await bot.sendMessage(chatId, 'Хорошо, Горепочка забыла ваш часовой пояс. Отныне всё это не учитывается.', { reply_markup: getReplyKeyboard(chatId) });
			}
		},
        // +++ КОНЕЦ ИЗМЕНЕНИЯ +++
		'📝 Установить биографию': async () => {
            slotState.isWaitingForBio = true;
            await bot.sendMessage(chatId, 'Расскажите свою биографию (до 700 символов). Если хотите сбросить, напишите "Erase". Для отмены введите /cancel.', { reply_markup: getReplyKeyboard(chatId) });
        },
        '📝 Задать характер': async () => {
            slotState.isWaitingForCharacter = true;
            await bot.sendMessage(chatId, 'Задайте характер Горепочке (до 400 символов). Для отмены напишите /cancel.', { reply_markup: getReplyKeyboard(chatId) });
        },
        '📖 Рассказчик': async () => {
            slotState.isWaitingForNarrator = true;
            await bot.sendMessage(chatId, 'Как должен идти диалог? (до 3000 символов).\n\nПропишите `Erase`, чтобы отключить рассказчика. \nДля отмены введите /cancel.', {
                reply_markup: { remove_keyboard: true } // Временно убираем клавиатуру для чистоты ввода
            });
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
		'Дневник 📔': async () => {
            const diaryEntries = loadDiary(chatId, activeSlotIndex);
            
            if (diaryEntries.length === 0) {
                await bot.sendMessage(chatId, 'В моей голове пока пусто... по крайней мере, насчет этого чата. 텅 비었다.', { reply_markup: getReplyKeyboard(chatId) });
                return;
            }

            const header = `Мысли Горепочки (чат: ${activeSlotIndex + 1}):\n\n`;
            
            // Форматируем каждую запись с нумерацией и отступом
            const formattedEntries = diaryEntries.map((entry, index) => `${index + 1}. ${entry}`).join('\n\n');

            await bot.sendMessage(chatId, header + formattedEntries, { reply_markup: getReplyKeyboard(chatId) });
        }
        // +++ КОНЕЦ НОВОГО ОБРАБОТЧИКА +++
    };

	
	

    if (commandHandlers[userInput]) {
        await commandHandlers[userInput]();
        return;
    }

    if (userInput.startsWith('➡️ Чат ') || userInput.startsWith('Чат ') || userInput.startsWith('Слот ')) {
        const match = userInput.match(/(\d+)/);
        if (match) {
            const slotIndex = parseInt(match[1]) - 1;
            if (slotIndex >= 0 && slotIndex < MAX_CHAT_SLOTS) {
                userState.currentMenu = 'main';
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
        userState.currentMenu = 'main';
        const newModel = userInput.includes('pro') ? 'gemini-2.5-pro' : 'gemini-2.5-flash';
        if (userState.selectedModel !== newModel) {
            userState.selectedModel = newModel;
            await bot.sendMessage(chatId, `✅ Модель изменена на ${newModel}.`, { reply_markup: getReplyKeyboard(chatId) });
        } else {
             await bot.sendMessage(chatId, 'Эта модель уже активна!', { reply_markup: getReplyKeyboard(chatId) });
        }
        return;
    }
    
    if (slotState.isGenerating) {
        try { await bot.sendMessage(chatId, '⏳ Пожалуйста, подожди, я еще думаю...'); } catch (e) {}
        return;
    }
    
    if (!userState.hasCompletedWelcome) {
        await showWelcomeMessage(chatId);
        return;
    }

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

    const internalCommands = ['<Игнор от пользователя>', '<Время забыто>', '<Время только что синхронизировано>'];
    if (!internalCommands.includes(userInput)) {
        currentSlotState.spamCounter++;
        if (currentSlotState.spamCounter > 2) {
            try {
                await bot.sendMessage(chatId, 'Ой-ой спамить - не хорошо! 😠 Подожди, когда я договорю.');
            } catch (error) { /* ignore */ }
            return;
        }
        if (currentSlotState.narratorPrompt) {
            currentSlotState.narratorInterventionCounter++;
        }
    }

    // --- НАЧАЛО ИСПРАВЛЕНИЯ: Логика Рассказчика перенесена наверх ---

    let narratorInstruction = '';
	// Проверяем, активен ли Рассказчик и наступила ли его очередь
	if (currentSlotState.narratorPrompt && currentSlotState.narratorInterventionCounter > 0 && currentSlotState.narratorInterventionCounter % 2 === 0) {
		console.log(`[Рассказчик] Активация для чата ${chatId}/${activeSlotIndex}.`);
		try {
			const narratorModel = genAI.getGenerativeModel({
				model: userState.selectedModel,
				systemInstruction: narratorSystemPrompt // Используем новый "железный" промпт
			});

			// --- НОВЫЙ ПОДХОД: Формируем сценарий вместо истории ---
			// Очищаем историю от служебных тегов Горепочки
			const cleanedHistory = currentHistory.map(msg => {
				const role = msg.role === 'user' ? 'Пользователь' : 'Горепочка';
				const text = msg.parts[0].text.replace(/<[^>]*>/g, '').trim();
				return { role, text };
			}).filter(msg => msg.text); // Убираем пустые сообщения

			// Превращаем диалог в сценарий
			const dialogueScript = cleanedHistory.map(msg => `${msg.role}: ${msg.text}`).join('\n');

			// Собираем финальный промпт для Рассказчика
			const finalNarratorPrompt = `
	[ИСТОРИЯ ДИАЛОГА ДЛЯ АНАЛИЗА]:
	---
	${dialogueScript}
	---

	[ОСНОВНАЯ ЦЕЛЬ ОТ ПОЛЬЗОВАТЕЛЯ]:
	"${currentSlotState.narratorPrompt}"

	[ТВОЙ ПРИКАЗ ДЛЯ ГОРЕПОЧКИ]:
	`;
			// --- КОНЕЦ НОВОГО ПОДХОДА ---

			const narratorResult = await narratorModel.generateContent(finalNarratorPrompt); // Отправляем как единый текст
			const narratorResponse = await narratorResult.response;
			
			if (narratorResponse.candidates?.length) {
				narratorInstruction = narratorResponse.candidates[0].content.parts[0].text;
				console.log(`[Рассказчик] Сгенерировал приказ: "${narratorInstruction}"`);
			}
		} catch (narratorError) {
			console.error(`❌ Ошибка генерации от Рассказчика для чата ${chatId}:`, narratorError.message);
		}
	}
    
    // Теперь, когда narratorInstruction точно определена (пустая или с текстом), формируем итоговый ввод
    let processedInput = userInput;

    if (narratorInstruction) {
        // Внедряем инструкцию от Рассказчика ПЕРЕД сообщением пользователя.
        processedInput = `[СИСТЕМНАЯ ИНСТРУКЦИЯ ОТ РАССКАЗЧИКА]: ${narratorInstruction}\n\n[СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ]: ${userInput}`;
    }
    
    // Добавляем информацию о дате и времени пользователя, если она есть
    if (userState.timezoneOffset !== null && !internalCommands.includes(userInput)) {
        const now = new Date();
        const userTime = new Date(now.getTime() - (userState.timezoneOffset * 60 * 1000));
        
        const day = userTime.getUTCDate().toString().padStart(2, '0');
        const month = (userTime.getUTCMonth() + 1).toString().padStart(2, '0');
        const year = userTime.getUTCFullYear();
        const hours = userTime.getUTCHours().toString().padStart(2, '0');
        const minutes = userTime.getUTCMinutes().toString().padStart(2, '0');
        
        const dateTimeString = `<Дата и время пользователя: ${day}.${month}.${year} ${hours}:${minutes}> Отныне действуй согласно контексту. Можешь пожелать доброго утра или ночи, если время позволяет, или например сказать что у пользователя вечереет!`;
        
        processedInput = `${dateTimeString}\n\n${processedInput}`; // Добавляем в начало уже обработанного ввода
        console.log(`[Контекст] Для чата ${chatId} добавлена метка времени.`);
    }

    // --- КОНЕЦ ИСПРАВЛЕНИЯ ---
    
    // В историю сохраняем ЧИСТЫЙ ввод пользователя, без наших инструкций
    currentHistory.push({ role: "user", parts: [{ text: userInput }] }); 
    currentSlotState.interactions++;
    currentSlotState.lastActive = Date.now();
    
    try {
        await bot.sendChatAction(chatId, 'typing');

        const contents = currentHistory.map(msg => ({
            role: msg.role === "assistant" ? "model" : msg.role,
            parts: JSON.parse(JSON.stringify(msg.parts)) 
        }));
        
        if (contents.length > 0) {
            // А вот модели передаем уже обогащенный ввод
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
        
        if (specialDatesList.length > 0) {
            const monthNames = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
            const datesKnowledge = specialDatesList.map(item => {
                const [month, day] = item.date.split('-').map(Number);
                const formattedDate = `${day} ${monthNames[month - 1]}`;
                return `- ${item.event} (дата: ${formattedDate})`;
            }).join('\n');
            
            const knowledgeBlock = `\n\n[СПРАВОЧНАЯ ИНФОРМАЦИЯ О ВАЖНЫХ ДАТАХ]\nТы обладаешь знаниями об этих особых датах.Если этот день настанет, то поздравь пользователя с этим праздником. А Если пользователь спрашивает о какой-либо из них, используй эту информацию для ответа. Не упоминай этот список напрямую, если тебя об этом не просят.\n${datesKnowledge}`;
            
            fullSystemPrompt += knowledgeBlock;
        }

        if (currentSlotState.characterDescription && currentSlotState.characterDescription.trim() !== '') {
            fullSystemPrompt += `\n\n[ТВОЙ ХАРАКТЕР]: Ты всегда должна придерживаться этой роли: "${currentSlotState.characterDescription}"`;
        }
        if (currentSlotState.userBio && currentSlotState.userBio.trim() !== '') {
            fullSystemPrompt += `\n\n[БИОГРАФИЯ ПОЛЬЗОВАТЕЛЯ]: Учитывай эту информацию о пользователе: "${currentSlotState.userBio}"`;
        }
		if (currentSlotState.narratorPrompt) {
            fullSystemPrompt += `\n\n[ПРАВИЛО РАССКАЗЧИКА]: Иногда перед сообщением пользователя ты будешь получать специальную системную инструкцию от Рассказчика. Она выглядит так: [СИСТЕМНАЯ ИНСТРУКЦИЯ ОТ РАССКАЗЧИКА]: ... Ты ДОЛЖНА беспрекословно следовать этой инструкции. Она имеет наивысший приоритет и полностью определяет контекст, эмоции и направление твоего следующего ответа. Игнорируй предыдущий контекст, если он противоречит инструкции Рассказчика.`;
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
		await processDiaryCommands(botResponse, chatId, activeSlotIndex);
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

        // Эта внутренняя функция теперь содержит логику отката
        const sendMessageAndUpdateFlag = async (textChunk) => {
            if (!(await isChatValid(chatId))) return null;

            let cleanText = textChunk;
            if (!isDebugMode) {
                cleanText = cleanText.replace(/<[^>]*>/g, '').trim();
            } else {
                 cleanText = cleanText.trim();
            }

            if (!cleanText) return null;

            const options = { parse_mode: 'Markdown' };
            if (isFirstChunk && replyToMessageId && isAiResponseType && !cleanText.trim().startsWith('```')) {
                options.reply_to_message_id = replyToMessageId;
            }

            try {
                // ПЕРВАЯ ПОПЫТКА: отправить с Markdown
                const sent = await bot.sendMessage(chatId, cleanText, options);
                isFirstChunk = false;
                return sent;
            } catch (error) {
                // ВТОРАЯ ПОПЫТКА (если ошибка парсинга): отправить как простой текст
                if (error.response && error.response.body && error.response.body.error_code === 400 && error.response.body.description.includes("can't parse entities")) {
                    console.warn(`[Markdown Fallback] Ошибка парсинга Markdown для чата ${chatId}. Отправка в виде простого текста.`);
                    console.warn(`[Markdown Fallback] Проблемный текст: "${cleanText}"`);
                    
                    // Удаляем опцию parse_mode, чтобы отправить как обычный текст
                    delete options.parse_mode; 
                    
                    const sent = await bot.sendMessage(chatId, cleanText, options);
                    isFirstChunk = false;
                    return sent;
                } else {
                    // Если это другая ошибка (бот заблокирован и т.д.), пробрасываем ее дальше
                    throw error;
                }
            }
        };
        
        const parts = originalText.split(/<Разделить сообщение>/g);

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            if (!(await isChatValid(chatId))) { stopTyping(); return messageIds; }
            
            if (i > 0 && isDebugMode) {
                 await sendMessageAndUpdateFlag('_<Разделить сообщение>_');
            }
            
            const textWithoutCommands = part.replace(/<.*?>/g, '');
            const timePerCharacter = 62;
            const delay = textWithoutCommands.length * timePerCharacter;

            await new Promise(resolve => setTimeout(resolve, delay));

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
        // Теперь сюда будут попадать только "настоящие" ошибки, а не ошибки парсинга
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
