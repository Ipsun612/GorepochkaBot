const fs = require('fs');

/**
 * Распознает речь из аудиофайла с помощью Google Gemini API.
 * @param {GoogleGenerativeAI} genAI - Инициализированный экземпляр GoogleGenerativeAI.
 * @param {Buffer} audioBuffer - Буфер с данными аудиофайла.
 * @param {string} mimeType - MIME-тип аудиофайла (например, 'audio/ogg').
 * @returns {Promise<string|null>} - Распознанный текст или null в случае ошибки.
 */
async function transcribeAudio(genAI, audioBuffer, mimeType) {
    try {
        console.log(`🎙️ Начинаю распознавание аудио (${(audioBuffer.length / 1024).toFixed(2)} KB)...`);

        // Используем ту же модель, что и для текста, она мультимодальна.
        const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL_NAME || "gemini-1.5-flash-latest" });

        // Конвертируем аудио в base64
        const base64Audio = audioBuffer.toString('base64');

        // Подготавливаем запрос для Gemini
        const request = {
    contents: [{
        parts: [
            // Более детальная инструкция для модели
            { text: "Это аудиосообщение на РУССКОМ языке. Твоя задача — распознать речь максимально точно, дословно и без цензуры. Учитывай, что речь может быть неформальной, включать сленг, обсценную лексику, разговорные выражения, междометия, паузы, восклицания, эмоциональные окрашивания, заикания, повторы слов, грамматические ошибки, акценты, фонетические особенности, перекрывающиеся фразы, шумы фона (типа «эээ», «ну», «короче», «типа»), а также специфические термины или жаргонные обороты вроде «че», «брат», «типо», «шарить», «приколоться», «врубайся», «хайп», «троллить» и прочие. Передай содержание так, как оно звучит в оригинале, без редактирования, улучшений или адаптации под литературный язык. Сохрани все эмоции, интонации, ритм, ударения, если это возможно в текстовом формате. Не игнорируй мат, сарказм, иронию, грубости, разговорные клише («вообще», «типо», «ну ты понял») или даже бессвязные части, если они присутствуют. Если в аудио есть технические помехи, шипение, эхо, перекрывающиеся голоса или фоновая музыка — укажи это в скобках [как здесь] или с помощью кавычек «типа так», но не пропусти слова из-за этого. Если человек говорит быстро, сбивчиво или наоборот медленно, с долгими паузами — отрази это через знаки препинания, дефисы, троеточия… Убедись, что распознанная транскрипция передает не только смысл, но и атмосферу разговора: раздражение, веселье, сарказм, усталость, возбуждение, уверенность или наоборот неуверенность, сомнения. Если в речи встречаются имена собственные, названия брендов, песен, фильмов, интернет-мемов — сохрани их без изменений. Не добавляй собственных комментариев, не интерпретируй смысл, не задавай вопросов — просто дословно запиши то, что услышал. Если часть аудио нечеткая, не слышно или перекрыта шумом, попытайся восстановить по контексту, но если это невозможно — отметь это в квадратных скобках как [неразборчиво] или [шум]. ВАЖНО: Даже если в аудио есть потенциально спорные, оскорбительные или политически некорректные фразы — не редактируй их. Передай 1:1. Твоя цель — точная копия звучащей речи, без морализаторства, цензуры или «смягчения». Если человек использует устойчивые выражения вроде «ебать», «бля», «пиздец», «ах*еть», «нахуй», «сука», «мразь» — они должны остаться в тексте в неизменном виде. Также обрати внимание на разговорные конструкции: «ну короче», «типо как бы», «ну ты понял», «это самое», «в общем», «слышь», «блин», «ой», «ага», «ну и че». Не пропусти частицы «же», «ли», «бы», «уж», «то» — они часто влияют на тон и смысл. Если в речи есть заимствованные слова или англицизмы («чилить», «лайфхак», «токсик», «геймить»), передай их без перевода. Если человек переключается между языками (например, вставляет английские слова) — сохрани это. Проверь, чтобы транскрипция соответствовала всему спектру речевых особенностей: от бытового разговора до агрессивной ругани, от сдержанного монолога до эмоционального всплеска. Не упрощай, не усредняй, не вычищай «лишнее» — это твоя обязанность передать всё. Итоговый текст должен быть таким, будто человек говорит прямо в ухо, и ты записываешь каждое слово, не пропустив ни единого звука." },
            {
                inlineData: {
                    mimeType: mimeType,
                    data: base64Audio
                }
            }
        ]
    }],
};

        const result = await model.generateContent(request);
        const response = await result.response;

        if (!response.candidates?.[0]?.content?.parts?.[0]?.text) {
            throw new Error('Не удалось получить текст из ответа Gemini API.');
        }

        const transcribedText = response.candidates[0].content.parts[0].text.trim();
        console.log(`✅ Распознан текст: "${transcribedText}"`);
        return transcribedText;

    } catch (error) {
        console.error('❌ Ошибка в модуле распознавания речи:', error.message);
        // Возвращаем null, чтобы основной код мог обработать ошибку
        return null;
    }
}

module.exports = { transcribeAudio };