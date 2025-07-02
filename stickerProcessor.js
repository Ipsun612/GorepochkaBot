const fs = require('fs');
const path = require('path');

let stickerMap = {};

// Загружаем и парсим наш JSON файл со стикерами один раз при запуске
try {
    const filePath = path.join(__dirname, 'sticker_commands.json');
    const fileContent = fs.readFileSync(filePath, 'utf8');
    stickerMap = JSON.parse(fileContent);
    console.log('✅ Карта стикеров успешно загружена.');
} catch (error) {
    console.error('❌ Ошибка загрузки файла sticker_commands.json:', error.message);
    console.error('ℹ️ Убедитесь, что файл существует и имеет корректный JSON-формат.');
}

/**
 * Проверяет текст на наличие команд для отправки стикеров, отправляет их и удаляет команды из текста.
 * @param {object} bot - Экземпляр node-telegram-bot-api.
 * @param {number|string} chatId - ID чата для отправки.
 * @param {string} text - Исходный текст ответа от ИИ.
 * @returns {Promise<string>} - Текст, очищенный от команд стикеров.
 */
async function processStickerCommands(bot, chatId, text) {
    let modifiedText = text;

    // Проходим по каждой команде из нашей карты
    for (const command in stickerMap) {
        // Проверяем, есть ли команда в тексте
        if (modifiedText.includes(command)) {
            const stickerId = stickerMap[command];
            try {
                // Отправляем стикер
                await bot.sendSticker(chatId, stickerId);
                console.log(`Отправлен стикер для команды ${command} в чат ${chatId}`);
                
                // Удаляем команду из текста, чтобы она не отобразилась в сообщении
                // Используем глобальный флаг 'g' для удаления всех вхождений команды
                const regex = new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                modifiedText = modifiedText.replace(regex, '');
                
            } catch (error) {
                console.error(`❌ Не удалось отправить стикер с ID ${stickerId}:`, error.message);
            }
        }
    }

    // Возвращаем текст, уже очищенный от команд стикеров
    return modifiedText.trim();
}

// Экспортируем нашу функцию для использования в основном файле
module.exports = { processStickerCommands };