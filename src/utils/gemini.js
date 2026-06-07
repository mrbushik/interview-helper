const { GoogleGenAI, createPartFromBase64, createUserContent } = require('@google/genai');
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt } = require('./prompts');
const {
    setupNativeMacOSMicTranscriptionIpcHandlers,
    stopNativeMacOSMicTranscription,
    isNativeMacOSMicTranscriptionEnabled,
} = require('./nativeMacOSMicTranscription');
const {
    DEFAULT_MIN_CHARS,
    DEFAULT_SILENCE_MS,
    createInterviewerTranscriptBuffer,
} = require('./interviewerTranscription');

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];
let isInitializingSession = false;
let rawMessageBuffer = '';
let geminiTextClient = null;
let geminiTextSystemPrompt = '';
let geminiTextTools = [];
let activeTextGenerationId = 0;
let lastSubmittedText = '';
let lastSubmittedTextAt = 0;
let activeAudioMode = 'speaker_only';
let interviewerTranscriptBuffer = null;
let systemAudioStats = {
    chunks: 0,
    clippedSamples: 0,
    peak: 0,
    rmsTotal: 0,
    lastLogAt: 0,
};

const DEFAULT_GEMINI_TEXT_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-001'];

const INTERNAL_REASONING_PARAGRAPH_PATTERNS = [
    /^(considering|analyzing|refining|prioritizing|synthesizing|formulating|addressing)\b/i,
    /^i('?m| am) (now )?(focusing|analyzing|refining|prioritizing|synthesizing|formulating)\b/i,
    /^(my (thought process|latest focus|goal|next step|response))/i,
];

const INTERNAL_REASONING_SNIPPETS = [
    'thought process',
    'internal monologue',
    'teleprompter response',
    'ready to deploy',
    'i need to',
    'i will focus on',
    'i am now focusing',
    "i'm now focusing",
    'i am now zeroing in',
    "i'm now zeroing in",
    'based on their russian speech',
    'the user context confirms',
    'i believe my response',
];

function isInternalReasoningParagraph(paragraph) {
    const normalized = paragraph.trim();
    if (!normalized) {
        return false;
    }

    if (INTERNAL_REASONING_PARAGRAPH_PATTERNS.some(pattern => pattern.test(normalized))) {
        return true;
    }

    const lower = normalized.toLowerCase();
    return INTERNAL_REASONING_SNIPPETS.some(snippet => lower.includes(snippet));
}

function sanitizeAssistantResponse(text) {
    const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) {
        return '';
    }

    const paragraphs = normalized
        .split(/\n\s*\n/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean);

    const filteredParagraphs = paragraphs.filter(paragraph => !isInternalReasoningParagraph(paragraph));

    const cleaned = (filteredParagraphs.length > 0 ? filteredParagraphs : paragraphs)
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return cleaned;
}

const TRANSCRIPT_CORRECTIONS = [
    [/\bhave\s+to\s+(?=im\s*prove\b|improve\b)/gi, 'how to '],
    [/\bim\s+prove\b/gi, 'improve'],
    [/\bper\s+formance\b/gi, 'performance'],
    [/\bapp?lica?\s+tions?\b/gi, 'applications'],
    [/\baplica\s+tions?\b/gi, 'applications'],
    [/\bopti\s+mize\b/gi, 'optimize'],
    [/\bopti\s+mization\b/gi, 'optimization'],
    [/\bre\s+render(?:s|ing)?\b/gi, 're-rendering'],
    [/\bdata\s+base\b/gi, 'database'],
    [/\bреакт(?:е|а|ом)?\b/gi, 'React'],
    [/\bреакц(?:ия|ии|ию|ией)\b/gi, 'React'],
    [/\bриакт\b/gi, 'React'],
    [/\bджав[ао]скрипт\b/gi, 'JavaScript'],
    [/\bтайпскрипт\b/gi, 'TypeScript'],
    [/\bнод(?:а|е|ой)?\.?\s*джи\s*эс\b/gi, 'Node.js'],
    [/\bнода\b/gi, 'Node.js'],
    [/\bивент\s*луп\b/gi, 'event loop'],
    [/\bevent\s*loop\b/gi, 'event loop'],
    [/\bфсд\b/gi, 'FSD'],
    [/\bэф\s*эс\s*ди\b/gi, 'FSD'],
    [/\bредакс\b/gi, 'Redux'],
    [/\bредукс\b/gi, 'Redux'],
    [/\bхуки\b/gi, 'hooks'],
    [/\bпропсы\b/gi, 'props'],
    [/\bстейт\b/gi, 'state'],
    [/\bрендеринг\b/gi, 'rendering'],
    [/\brende+r+\b/gi, 'render'],
    [/\bрендер(?:а|е|ом)?\b/gi, 'render'],
    [/\bреконсиляц(?:ия|ии|ию|ией)\b/gi, 'reconciliation'],
    [/\bмемоизац(?:ия|ии|ию|ией)\b/gi, 'memoization'],
    [/\bюз\s*мемо\b/gi, 'useMemo'],
    [/\bюз\s*колл?бэк\b/gi, 'useCallback'],
    [/\bюз\s*эффект\b/gi, 'useEffect'],
    [/\bви\s*дом\b/gi, 'VDOM'],
    [/\bвиртуальн(?:ый|ого|ом)\s+дом\b/gi, 'virtual DOM'],
];

const GOOGLE_SEARCH_TRIGGER_PATTERNS = [
    /\b(latest|recent|current|today|yesterday|news|funding|acquisition|pricing|price|stock|release|version)\b/i,
    /\b(company|startup|market|competitor|leadership|ceo|cto|trend|report)\b/i,
    /\b(последн|свеж|актуальн|сегодня|вчера|новост|финансирован|инвестиц|покупк|поглощен|цен[аы]|стоимост)\b/i,
    /\b(компани|рынок|конкурент|руководител|директор|тренд|отчет|релиз|верси[яи])\b/i,
];

const RUSSIAN_ANSWER_OVERRIDE = [
    'CRITICAL LANGUAGE RULE:',
    'Answer in Russian only.',
    'This overrides the selected interview language, speech recognition language, examples, and any earlier instruction.',
    'Do not say that you can only respond in English.',
    'Do not ask the user to rephrase in English.',
    'Keep common technical terms in English when appropriate, for example React, Event Loop, FSD, API, TypeScript, JavaScript, render, reconciliation, props, state, hooks.',
].join('\n');

function normalizeTranscriptForModel(text) {
    let normalized = String(text || '').trim();
    for (const [pattern, replacement] of TRANSCRIPT_CORRECTIONS) {
        normalized = normalized.replace(pattern, replacement);
    }
    return normalized.replace(/\s{2,}/g, ' ').trim();
}

function getRecentConversationContext() {
    return conversationHistory
        .slice(-6)
        .map((turn, index) => {
            return `Turn ${index + 1}\nQuestion:\n${turn.transcription}\nAnswer:\n${turn.ai_response}`;
        })
        .join('\n\n');
}

function containsCyrillic(text) {
    return /[А-Яа-яЁё]/.test(text);
}

function needsRussianAnswerRepair(text, forceRussianAnswer) {
    return forceRussianAnswer && Boolean(String(text || '').trim()) && !containsCyrillic(text);
}

function buildTextGenerationPrompt(question, source = 'text', options = {}) {
    const recentContext = getRecentConversationContext();
    const sections = [];

    if (recentContext) {
        sections.push(`Recent interview context:\n${recentContext}`);
    }

    sections.push(`Current input source: ${source}`);
    sections.push(`Current question:\n${question}`);

    if (source === 'system_audio') {
        sections.push(
            [
                'SPEECH TRANSCRIPTION RULES:',
                '- The current question came from automatic speech recognition and may contain split words, missing punctuation, or a small phonetic error.',
                '- Silently reconstruct the most likely interview question before answering.',
                '- Answer one narrow question only. Do not turn an ambiguous question into a survey of every skill in the candidate resume.',
                '- Prefer explicit terms in the current question, then recent dialogue, then the target role/vacancy context.',
                '- If application performance is asked in a frontend or React interview and no backend term is present, answer about frontend/React performance only.',
                '- Do not introduce backend, databases, cloud infrastructure, cost optimization, or AI tools unless the current question or recent dialogue explicitly points there.',
                '- Use the resume to personalize a relevant example, not to enumerate unrelated experience.',
            ].join('\n')
        );
    }

    if (options.forceRussianAnswer || containsCyrillic(question)) {
        sections.push(RUSSIAN_ANSWER_OVERRIDE);
    }

    sections.push('Return the final answer only.');

    return sections.join('\n\n');
}

function buildScreenshotGenerationPrompt(instruction, options = {}) {
    const recentContext = getRecentConversationContext();
    const sections = [];

    if (recentContext) {
        sections.push(`Recent conversation context:\n${recentContext}`);
    }

    sections.push('Current input source: screenshot');
    sections.push(`Screenshot task:\n${instruction}`);

    if (options.forceRussianAnswer || containsCyrillic(instruction)) {
        sections.push(RUSSIAN_ANSWER_OVERRIDE);
    }

    sections.push('Use the screenshot as the primary source of truth.');
    sections.push('If the screenshot contains a problem or question, solve that exact problem and explain the answer briefly.');
    sections.push('If there are multiple tasks on screen, prioritize the most prominent active task.');
    sections.push('Return the final answer only.');

    return sections.join('\n\n');
}

function buildEffectiveTextSystemInstruction(forceRussianAnswer) {
    if (!forceRussianAnswer) {
        return geminiTextSystemPrompt;
    }

    return `${geminiTextSystemPrompt}\n\n${RUSSIAN_ANSWER_OVERRIDE}`;
}

function shouldUseGoogleSearchForText(question) {
    if (!geminiTextTools.length) {
        return false;
    }

    return GOOGLE_SEARCH_TRIGGER_PATTERNS.some(pattern => pattern.test(question));
}

async function getGeminiTextModelCandidates() {
    const storedModel = (await getStoredSetting('geminiTextModel', '')).trim();
    const models = storedModel ? [storedModel, ...DEFAULT_GEMINI_TEXT_MODELS] : DEFAULT_GEMINI_TEXT_MODELS;
    return [...new Set(models.filter(Boolean))];
}

function isRetryableTextModelError(error) {
    const text = `${error?.message || ''} ${error?.status || ''} ${error?.code || ''}`.toLowerCase();
    return (
        text.includes('429') ||
        text.includes('too many requests') ||
        text.includes('resource_exhausted') ||
        text.includes('quota') ||
        text.includes('not found') ||
        text.includes('not supported') ||
        text.includes('model')
    );
}

async function generateTextAnswerFromTranscript(transcript, source = 'text') {
    if (!geminiTextClient) {
        throw new Error('Gemini text client is not initialized');
    }

    const normalizedTranscript = normalizeTranscriptForModel(transcript);
    if (!normalizedTranscript) {
        return { success: false, error: 'Empty transcript' };
    }

    const now = Date.now();
    if (normalizedTranscript === lastSubmittedText && now - lastSubmittedTextAt < 2500) {
        console.log('[Gemini text] Skipping duplicate transcript:', normalizedTranscript);
        return { success: true, skipped: true, reason: 'duplicate_transcript' };
    }

    lastSubmittedText = normalizedTranscript;
    lastSubmittedTextAt = now;

    const generationId = ++activeTextGenerationId;
    let responseBuffer = '';
    const transcriptionLine =
        source === 'native_mic'
            ? `[Candidate]: ${normalizedTranscript}`
            : source === 'system_audio'
              ? `[Interviewer]: ${normalizedTranscript}`
              : normalizedTranscript;

    currentTranscription = `${transcriptionLine}\n`;

    console.log(`[Gemini text][${source}]`, normalizedTranscript);
    sendToRenderer('update-status', 'Generating text answer...');

    try {
        const tools = shouldUseGoogleSearchForText(normalizedTranscript) ? geminiTextTools : [];
        const forceRussianAnswer = (await getStoredSetting('forceRussianAnswer', 'false')) === 'true';
        console.log('[Gemini text] Google Search tools for this request:', tools.length > 0);
        console.log('[Gemini text] Force Russian answer:', forceRussianAnswer);

        const modelCandidates = await getGeminiTextModelCandidates();
        let stream = null;
        let lastError = null;
        let selectedModel = '';

        for (const model of modelCandidates) {
            try {
                selectedModel = model;
                console.log('[Gemini text] Trying model:', model);
                stream = await geminiTextClient.models.generateContentStream({
                    model,
                    contents: buildTextGenerationPrompt(normalizedTranscript, source, { forceRussianAnswer }),
                    config: {
                        systemInstruction: buildEffectiveTextSystemInstruction(forceRussianAnswer),
                        tools,
                        temperature: source === 'system_audio' ? 0.2 : 0.35,
                        topP: 0.9,
                        maxOutputTokens: 1200,
                        responseMimeType: 'text/plain',
                    },
                });
                break;
            } catch (error) {
                lastError = error;
                console.warn(`[Gemini text] Model ${model} failed:`, error.message || error);
                if (!isRetryableTextModelError(error)) {
                    throw error;
                }
            }
        }

        if (!stream) {
            throw lastError || new Error('No Gemini text model candidates available');
        }

        console.log('[Gemini text] Streaming answer with model:', selectedModel);

        for await (const chunk of stream) {
            if (generationId !== activeTextGenerationId) {
                return { success: true, skipped: true, reason: 'superseded' };
            }

            if (chunk.text) {
                responseBuffer += chunk.text;
                sendToRenderer('update-response', sanitizeAssistantResponse(responseBuffer));
            }
        }

        if (generationId !== activeTextGenerationId) {
            return { success: true, skipped: true, reason: 'superseded' };
        }

        let finalResponse = sanitizeAssistantResponse(responseBuffer);

        if (needsRussianAnswerRepair(finalResponse, forceRussianAnswer)) {
            console.warn('[Gemini text] Retrying because the forced-Russian answer contained no Cyrillic');
            const repairResponse = await geminiTextClient.models.generateContent({
                model: selectedModel,
                contents: [
                    'Rewrite the answer below in Russian.',
                    'Preserve technical terms such as React, JavaScript, TypeScript, API, render, memoization, and database in English when natural.',
                    'Do not add new topics or explanations. Return only the corrected ready-to-speak answer.',
                    `Answer to rewrite:\n${finalResponse}`,
                ].join('\n\n'),
                config: {
                    systemInstruction: RUSSIAN_ANSWER_OVERRIDE,
                    temperature: 0.1,
                    maxOutputTokens: 1200,
                    responseMimeType: 'text/plain',
                },
            });
            const repairedResponse = sanitizeAssistantResponse(repairResponse.text);
            if (repairedResponse) {
                finalResponse = repairedResponse;
            }
        }

        sendToRenderer('update-response', finalResponse);
        sendToRenderer('update-status', 'Ready');

        if (finalResponse) {
            saveConversationTurn(currentTranscription, finalResponse);
            currentTranscription = '';
        }

        return { success: true, text: finalResponse };
    } catch (error) {
        console.error('[Gemini text] Failed to generate answer:', error);
        sendToRenderer('update-status', 'Error: ' + error.message);
        return { success: false, error: error.message };
    }
}

async function generateAnswerFromScreenshot(instruction, imageBase64, mimeType = 'image/jpeg') {
    if (!geminiTextClient) {
        throw new Error('Gemini text client is not initialized');
    }

    const normalizedInstruction = String(instruction || '').trim();
    if (!normalizedInstruction) {
        return { success: false, error: 'Empty screenshot instruction' };
    }

    if (!imageBase64 || typeof imageBase64 !== 'string') {
        return { success: false, error: 'Invalid screenshot data' };
    }

    const generationId = ++activeTextGenerationId;
    let responseBuffer = '';

    currentTranscription = `[Screenshot Task]: ${normalizedInstruction}\n`;
    sendToRenderer('update-status', 'Analyzing screenshot...');

    try {
        const forceRussianAnswer = (await getStoredSetting('forceRussianAnswer', 'false')) === 'true';
        const tools = shouldUseGoogleSearchForText(normalizedInstruction) ? geminiTextTools : [];
        const modelCandidates = await getGeminiTextModelCandidates();
        let stream = null;
        let lastError = null;
        let selectedModel = '';

        const prompt = buildScreenshotGenerationPrompt(normalizedInstruction, { forceRussianAnswer });
        const contents = createUserContent([createPartFromBase64(imageBase64, mimeType), { text: prompt }]);

        for (const model of modelCandidates) {
            try {
                selectedModel = model;
                console.log('[Gemini screenshot] Trying model:', model);
                stream = await geminiTextClient.models.generateContentStream({
                    model,
                    contents,
                    config: {
                        systemInstruction: buildEffectiveTextSystemInstruction(forceRussianAnswer),
                        tools,
                        temperature: 0.25,
                        topP: 0.9,
                        maxOutputTokens: 1600,
                        responseMimeType: 'text/plain',
                    },
                });
                break;
            } catch (error) {
                lastError = error;
                console.warn(`[Gemini screenshot] Model ${model} failed:`, error?.message || error);
                if (!isRetryableTextModelError(error)) {
                    throw error;
                }
            }
        }

        if (!stream) {
            throw lastError || new Error('No screenshot-capable Gemini model available');
        }

        console.log('[Gemini screenshot] Selected model:', selectedModel);

        for await (const chunk of stream) {
            if (generationId !== activeTextGenerationId) {
                console.log('[Gemini screenshot] Generation superseded, ignoring remaining chunks');
                return { success: false, error: 'Generation superseded' };
            }

            const chunkText = typeof chunk.text === 'string' ? chunk.text : '';
            if (!chunkText) {
                continue;
            }

            responseBuffer += chunkText;
            sendToRenderer('update-response', sanitizeAssistantResponse(responseBuffer));
        }

        const finalResponse = sanitizeAssistantResponse(responseBuffer);
        if (!finalResponse) {
            sendToRenderer('update-status', 'Error: Empty screenshot response');
            return { success: false, error: 'Empty screenshot response' };
        }

        sendToRenderer('update-response', finalResponse);
        sendToRenderer('update-status', 'Listening...');

        if (currentTranscription && finalResponse) {
            saveConversationTurn(currentTranscription, finalResponse);
            currentTranscription = '';
        }

        return { success: true, response: finalResponse };
    } catch (error) {
        console.error('Error generating screenshot answer:', error);
        sendToRenderer('update-status', 'Error: ' + error.message);
        return { success: false, error: error.message };
    }
}

function formatSpeakerResults(results) {
    let text = '';
    for (const result of results) {
        if (result.transcript && result.speakerId) {
            const speakerLabel = result.speakerId === 1 ? 'Interviewer' : 'Candidate';
            text += `[${speakerLabel}]: ${result.transcript}\n`;
        }
    }
    return text;
}

module.exports.formatSpeakerResults = formatSpeakerResults;

// Audio capture variables
let systemAudioProc = null;
let messageBuffer = '';
let systemAudioRestartTimer = null;
let stopRequestedForSystemAudio = false;
let systemAudioRestartAttempts = 0;
const MAX_SYSTEM_AUDIO_RESTART_ATTEMPTS = 5;
const SYSTEM_AUDIO_RESTART_DELAY_MS = 1500;

// Reconnection tracking variables
let reconnectionAttempts = 0;
let maxReconnectionAttempts = 3;
let reconnectionDelay = 2000; // 2 seconds between attempts
let lastSessionParams = null;

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

// Conversation management functions
function initializeNewSession() {
    currentSessionId = Date.now().toString();
    currentTranscription = '';
    conversationHistory = [];
    console.log('New conversation session started:', currentSessionId);
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved conversation turn:', conversationTurn);

    // Send to renderer to save in IndexedDB
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

async function sendReconnectionContext() {
    if (activeAudioMode === 'speaker_only' || !global.geminiSessionRef?.current || conversationHistory.length === 0) {
        return;
    }

    try {
        // Gather all transcriptions from the conversation history
        const transcriptions = conversationHistory
            .map(turn => turn.transcription)
            .filter(transcription => transcription && transcription.trim().length > 0);

        if (transcriptions.length === 0) {
            return;
        }

        // Create the context message
        const contextMessage = `Till now all these questions were asked in the interview, answer the last one please:\n\n${transcriptions.join(
            '\n'
        )}`;

        console.log('Sending reconnection context with', transcriptions.length, 'previous questions');

        // Send the context message to the new session
        await global.geminiSessionRef.current.sendRealtimeInput({
            text: contextMessage,
        });
    } catch (error) {
        console.error('Error sending reconnection context:', error);
    }
}

async function getEnabledTools() {
    const tools = [];

    // Check if Google Search is enabled (default: true)
    const googleSearchEnabled = await getStoredSetting('googleSearchEnabled', 'true');
    console.log('Google Search enabled:', googleSearchEnabled);

    if (googleSearchEnabled === 'true') {
        tools.push({ googleSearch: {} });
        console.log('Added Google Search tool');
    } else {
        console.log('Google Search tool disabled');
    }

    return tools;
}

async function getStoredSetting(key, defaultValue) {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            // Wait a bit for the renderer to be ready
            await new Promise(resolve => setTimeout(resolve, 100));

            // Try to get setting from renderer process localStorage
            const value = await windows[0].webContents.executeJavaScript(`
                (function() {
                    try {
                        if (typeof localStorage === 'undefined') {
                            console.log('localStorage not available yet for ${key}');
                            return '${defaultValue}';
                        }
                        const stored = localStorage.getItem('${key}');
                        console.log('Retrieved setting ${key}:', stored);
                        return stored || '${defaultValue}';
                    } catch (e) {
                        console.error('Error accessing localStorage for ${key}:', e);
                        return '${defaultValue}';
                    }
                })()
            `);
            return value;
        }
    } catch (error) {
        console.error('Error getting stored setting for', key, ':', error.message);
    }
    console.log('Using default value for', key, ':', defaultValue);
    return defaultValue;
}

async function handleNativeMicTranscript(payload) {
    const transcript = typeof payload === 'string' ? payload : payload?.text;
    if (!transcript) {
        return;
    }

    console.log(
        `[Native mic transcription -> Gemini][${typeof payload === 'string' ? 'final' : payload.type || 'unknown'}]`,
        `[Candidate]: ${transcript}`
    );

    try {
        await generateTextAnswerFromTranscript(transcript, 'native_mic');
    } catch (error) {
        console.error('[Native mic transcription] Failed to generate text answer:', error);
        sendToRenderer('update-status', 'Error: ' + error.message);
    }
}

function parseBoundedInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}

function clearInterviewerTranscriptBuffer() {
    if (interviewerTranscriptBuffer) {
        interviewerTranscriptBuffer.reset();
    }
    sendToRenderer('interviewer-transcription', {
        text: '',
        final: false,
    });
}

function resetInterviewerTranscriptBuffer() {
    clearInterviewerTranscriptBuffer();
    interviewerTranscriptBuffer = null;
}

function configureInterviewerTranscriptBuffer({ silenceMs, minChars }) {
    resetInterviewerTranscriptBuffer();

    interviewerTranscriptBuffer = createInterviewerTranscriptBuffer({
        silenceMs,
        minChars,
        onUpdate: transcript => {
            console.log('[Interviewer transcription][partial]', transcript);
            sendToRenderer('interviewer-transcription', {
                text: transcript,
                final: false,
            });
        },
        onFinalize: async (transcript, reason) => {
            if (activeAudioMode !== 'speaker_only') {
                return;
            }

            sendToRenderer('interviewer-transcription', {
                text: transcript,
                final: true,
                reason,
            });
            sendToRenderer('update-status', 'Interviewer question recognized');
            await generateTextAnswerFromTranscript(transcript, 'system_audio');
        },
    });
}

function isTerminalLiveSessionError(message) {
    const normalized = String(message || '').toLowerCase();
    return (
        normalized.includes('api key not valid') ||
        normalized.includes('invalid api key') ||
        normalized.includes('authentication failed') ||
        normalized.includes('unauthorized') ||
        normalized.includes('requested combination of response modalities') ||
        (normalized.includes('response modalities') && normalized.includes('not supported')) ||
        (normalized.includes('model') && normalized.includes('not found')) ||
        normalized.includes('invalid argument')
    );
}

function stopLiveReconnection(reason, statusPrefix = 'Session closed') {
    console.log('Non-retryable Live session error:', reason);
    lastSessionParams = null;
    reconnectionAttempts = maxReconnectionAttempts;
    sendToRenderer('update-status', `${statusPrefix}: ${reason}`);
}

async function attemptReconnection() {
    if (!lastSessionParams || reconnectionAttempts >= maxReconnectionAttempts) {
        console.log('Max reconnection attempts reached or no session params stored');
        sendToRenderer('update-status', 'Session closed');
        return false;
    }

    reconnectionAttempts++;
    console.log(`Attempting reconnection ${reconnectionAttempts}/${maxReconnectionAttempts}...`);

    // Wait before attempting reconnection
    await new Promise(resolve => setTimeout(resolve, reconnectionDelay));

    try {
        const session = await initializeGeminiSession(
            lastSessionParams.apiKey,
            lastSessionParams.customPrompt,
            lastSessionParams.profile,
            lastSessionParams.language,
            true // isReconnection flag
        );

        if (session && global.geminiSessionRef) {
            global.geminiSessionRef.current = session;
            reconnectionAttempts = 0; // Reset counter on successful reconnection
            console.log('Live session reconnected');

            // Send context message with previous transcriptions
            await sendReconnectionContext();

            return true;
        }
    } catch (error) {
        console.error(`Reconnection attempt ${reconnectionAttempts} failed:`, error);
    }

    // If this attempt failed, try again
    if (reconnectionAttempts < maxReconnectionAttempts) {
        return attemptReconnection();
    } else {
        console.log('All reconnection attempts failed');
        sendToRenderer('update-status', 'Session closed');
        return false;
    }
}

async function initializeGeminiSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US', isReconnection = false) {
    if (isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }

    isInitializingSession = true;
    sendToRenderer('session-initializing', true);

    const forceRussianAnswer = (await getStoredSetting('forceRussianAnswer', 'false')) === 'true';
    activeAudioMode = await getStoredSetting('audioMode', 'speaker_only');
    const interviewerSilenceMs = parseBoundedInteger(
        await getStoredSetting('interviewerSilenceMs', String(DEFAULT_SILENCE_MS)),
        DEFAULT_SILENCE_MS,
        700,
        4000
    );
    const interviewerMinChars = parseBoundedInteger(
        await getStoredSetting('interviewerMinChars', String(DEFAULT_MIN_CHARS)),
        DEFAULT_MIN_CHARS,
        3,
        50
    );

    if (activeAudioMode === 'speaker_only') {
        configureInterviewerTranscriptBuffer({
            silenceMs: interviewerSilenceMs,
            minChars: interviewerMinChars,
        });
    } else {
        resetInterviewerTranscriptBuffer();
    }

    // Store session parameters for reconnection (only if not already reconnecting)
    if (!isReconnection) {
        lastSessionParams = {
            apiKey,
            customPrompt,
            profile,
            language,
            forceRussianAnswer,
            audioMode: activeAudioMode,
        };
        reconnectionAttempts = 0; // Reset counter for new session
    }

    const client = new GoogleGenAI({
        vertexai: false,
        apiKey: apiKey,
        apiVersion: 'v1alpha',
    });

    // Get enabled tools first to determine Google Search status
    const enabledTools = await getEnabledTools();
    const googleSearchEnabled = enabledTools.some(tool => tool.googleSearch);

    const systemPrompt = getSystemPrompt(profile, customPrompt, googleSearchEnabled, { forceRussianAnswer });
    geminiTextClient = client;
    geminiTextTools = enabledTools;
    geminiTextSystemPrompt = systemPrompt;
    activeTextGenerationId += 1;
    lastSubmittedText = '';
    lastSubmittedTextAt = 0;

    console.log('Gemini text answers enabled:', {
        model: 'gemini-2.0-flash-001',
        forceRussianAnswer,
        googleSearchEnabled,
        audioMode: activeAudioMode,
        interviewerSilenceMs,
        interviewerMinChars,
    });

    // Initialize new conversation session (only if not reconnecting)
    if (!isReconnection) {
        initializeNewSession();
    }
    messageBuffer = '';
    rawMessageBuffer = '';

    const speakerOnlyMode = activeAudioMode === 'speaker_only';
    const liveSystemPrompt = speakerOnlyMode
        ? [
              'You are a low-latency speech transcription transport.',
              `The expected interview language is ${language}. Technical terms may be spoken in English.`,
              'Do not answer the speaker and do not solve interview questions.',
              'After each detected turn, return only a single period.',
          ].join('\n')
        : systemPrompt;

    try {
        const session = await client.live.connect({
            model: 'gemini-2.5-flash-native-audio-preview-12-2025',
            callbacks: {
                onopen: function () {
                    sendToRenderer('update-status', 'Live session connected');
                },
                onmessage: function (message) {
                    const serverContent = message.serverContent;

                    if (speakerOnlyMode) {
                        if (serverContent?.inputTranscription) {
                            interviewerTranscriptBuffer?.add(serverContent.inputTranscription);
                        }

                        // Input transcription can arrive after the model turn.
                        // A late transcription update replaces this short finalization timer.
                        if (serverContent?.turnComplete) {
                            interviewerTranscriptBuffer?.scheduleFinalize(350, 'turn_complete');
                        }
                        return;
                    }

                    if (serverContent?.inputTranscription?.results) {
                        currentTranscription += formatSpeakerResults(serverContent.inputTranscription.results);
                    } else if (serverContent?.inputTranscription?.text) {
                        currentTranscription += `[Interviewer]: ${serverContent.inputTranscription.text}\n`;
                    }

                    // Handle AI model response
                    if (serverContent?.modelTurn?.parts) {
                        for (const part of serverContent.modelTurn.parts) {
                            if (part.text) {
                                rawMessageBuffer += part.text;
                                messageBuffer = sanitizeAssistantResponse(rawMessageBuffer);
                                sendToRenderer('update-response', messageBuffer);
                            }
                        }
                    }

                    if (serverContent?.outputTranscription?.text) {
                        rawMessageBuffer += serverContent.outputTranscription.text;
                        messageBuffer = sanitizeAssistantResponse(rawMessageBuffer);
                        sendToRenderer('update-response', messageBuffer);
                    }

                    if (serverContent?.generationComplete) {
                        messageBuffer = sanitizeAssistantResponse(rawMessageBuffer);
                        sendToRenderer('update-response', messageBuffer);

                        // Save conversation turn when we have both transcription and AI response
                        if (currentTranscription && messageBuffer) {
                            saveConversationTurn(currentTranscription, messageBuffer);
                            currentTranscription = ''; // Reset for next turn
                        }

                        messageBuffer = '';
                        rawMessageBuffer = '';
                    }

                    if (serverContent?.turnComplete) {
                        sendToRenderer('update-status', 'Listening...');
                    }
                },
                onerror: function (e) {
                    console.debug('Error:', e.message);

                    if (isTerminalLiveSessionError(e.message)) {
                        stopLiveReconnection(e.message, 'Live error');
                        return;
                    }

                    sendToRenderer('update-status', 'Error: ' + e.message);
                },
                onclose: function (e) {
                    console.debug('Session closed:', e.reason);

                    if (isTerminalLiveSessionError(e.reason)) {
                        stopLiveReconnection(e.reason);
                        return;
                    }

                    // Attempt automatic reconnection for server-side closures
                    if (lastSessionParams && reconnectionAttempts < maxReconnectionAttempts) {
                        console.log('Attempting automatic reconnection...');
                        attemptReconnection();
                    } else {
                        sendToRenderer('update-status', 'Session closed');
                    }
                },
            },
            config: {
                // Native-audio models require AUDIO output. Speaker-only mode ignores
                // that output and uses inputAudioTranscription for the text pipeline.
                responseModalities: ['AUDIO'],
                tools: speakerOnlyMode ? [] : enabledTools,
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                ...(speakerOnlyMode
                    ? {
                          realtimeInputConfig: {
                              automaticActivityDetection: {
                                  startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
                                  endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
                                  prefixPaddingMs: 300,
                                  silenceDurationMs: interviewerSilenceMs,
                              },
                              activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
                              turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
                          },
                      }
                    : {}),
                contextWindowCompression: { slidingWindow: {} },
                systemInstruction: {
                    parts: [{ text: liveSystemPrompt }],
                },
            },
        });

        isInitializingSession = false;
        sendToRenderer('session-initializing', false);
        return session;
    } catch (error) {
        console.error('Failed to initialize Gemini session:', error);
        isInitializingSession = false;
        sendToRenderer('session-initializing', false);
        return null;
    }
}

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');

        // Kill any existing SystemAudioDump processes
        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        // Timeout after 2 seconds
        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture(geminiSessionRef, options = {}) {
    if (process.platform !== 'darwin') return false;

    const { skipKillExisting = false, resetRestartAttempts = true } = options;

    // Kill any existing SystemAudioDump processes first unless this is an internal restart
    if (!skipKillExisting) {
        await killExistingSystemAudioDump();
    }

    stopRequestedForSystemAudio = false;
    if (resetRestartAttempts) {
        systemAudioRestartAttempts = 0;
    }
    if (systemAudioRestartTimer) {
        clearTimeout(systemAudioRestartTimer);
        systemAudioRestartTimer = null;
    }

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    // Spawn SystemAudioDump with stealth options
    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            // Set environment variables that might help with stealth
            PROCESS_NAME: 'AudioService',
            APP_NAME: 'System Audio Service',
        },
    };

    // On macOS, apply additional stealth measures
    if (process.platform === 'darwin') {
        spawnOptions.detached = false;
        spawnOptions.windowsHide = false;
    }

    systemAudioProc = spawn(systemAudioPath, [], spawnOptions);

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);
    systemAudioStats = {
        chunks: 0,
        clippedSamples: 0,
        peak: 0,
        rmsTotal: 0,
        lastLogAt: Date.now(),
    };

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;
            trackSystemAudioQuality(monoChunk);
            const base64Data = monoChunk.toString('base64');
            sendAudioToGemini(base64Data, geminiSessionRef);

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        const stderrText = data.toString();
        console.error('SystemAudioDump stderr:', stderrText);

        if (stderrText.includes('Stream was stopped by the system')) {
            scheduleSystemAudioRestart(geminiSessionRef, 'system stopped the stream');
        }
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;

        if (!stopRequestedForSystemAudio && code !== 0) {
            scheduleSystemAudioRestart(geminiSessionRef, `process exited with code ${code}`);
        }
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
        if (!stopRequestedForSystemAudio) {
            scheduleSystemAudioRestart(geminiSessionRef, err.message || 'process error');
        }
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        const rightSample = stereoBuffer.readInt16LE(i * 4 + 2);
        const mixedSample = Math.round((leftSample + rightSample) / 2);
        monoBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, mixedSample)), i * 2);
    }

    return monoBuffer;
}

function analyzePcm16(buffer) {
    if (!buffer || buffer.length < 2) {
        return { samples: 0, rms: 0, peak: 0, clippedSamples: 0 };
    }

    const samples = Math.floor(buffer.length / 2);
    let squareSum = 0;
    let peak = 0;
    let clippedSamples = 0;

    for (let i = 0; i < samples; i++) {
        const sample = buffer.readInt16LE(i * 2);
        const absoluteSample = Math.abs(sample);
        squareSum += sample * sample;
        peak = Math.max(peak, absoluteSample);
        if (absoluteSample >= 32760) {
            clippedSamples++;
        }
    }

    return {
        samples,
        rms: Math.sqrt(squareSum / samples),
        peak,
        clippedSamples,
    };
}

function trackSystemAudioQuality(buffer) {
    const analysis = analyzePcm16(buffer);
    systemAudioStats.chunks++;
    systemAudioStats.rmsTotal += analysis.rms;
    systemAudioStats.peak = Math.max(systemAudioStats.peak, analysis.peak);
    systemAudioStats.clippedSamples += analysis.clippedSamples;

    const now = Date.now();
    if (now - systemAudioStats.lastLogAt < 10000) {
        return;
    }

    const averageRms = systemAudioStats.rmsTotal / Math.max(1, systemAudioStats.chunks);
    console.log('[System audio quality]', {
        averageRms: Math.round(averageRms),
        peak: systemAudioStats.peak,
        clippedSamples: systemAudioStats.clippedSamples,
        signal: averageRms < 80 ? 'too_quiet' : averageRms > 18000 ? 'too_loud' : 'ok',
    });

    systemAudioStats = {
        chunks: 0,
        clippedSamples: 0,
        peak: 0,
        rmsTotal: 0,
        lastLogAt: now,
    };
}

function stopMacOSAudioCapture() {
    stopRequestedForSystemAudio = true;
    stopNativeMacOSMicTranscription();
    clearInterviewerTranscriptBuffer();
    if (systemAudioRestartTimer) {
        clearTimeout(systemAudioRestartTimer);
        systemAudioRestartTimer = null;
    }
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
}

function scheduleSystemAudioRestart(geminiSessionRef, reason) {
    if (stopRequestedForSystemAudio) {
        return;
    }

    if (systemAudioRestartAttempts >= MAX_SYSTEM_AUDIO_RESTART_ATTEMPTS) {
        console.error('SystemAudioDump restart limit reached; not restarting again:', reason);
        return;
    }

    if (systemAudioRestartTimer) {
        return;
    }

    systemAudioRestartAttempts += 1;
    console.warn(
        `Scheduling SystemAudioDump restart ${systemAudioRestartAttempts}/${MAX_SYSTEM_AUDIO_RESTART_ATTEMPTS} after ${SYSTEM_AUDIO_RESTART_DELAY_MS}ms due to: ${reason}`
    );

    systemAudioRestartTimer = setTimeout(async () => {
        systemAudioRestartTimer = null;

        if (stopRequestedForSystemAudio) {
            return;
        }

        try {
            await startMacOSAudioCapture(geminiSessionRef, {
                skipKillExisting: true,
                resetRestartAttempts: false,
            });
        } catch (error) {
            console.error('Failed to restart SystemAudioDump:', error);
        }
    }, SYSTEM_AUDIO_RESTART_DELAY_MS);
}

async function sendAudioToGemini(base64Data, geminiSessionRef) {
    if (!geminiSessionRef.current) return;

    try {
        process.stdout.write('.');
        await geminiSessionRef.current.sendRealtimeInput({
            audio: {
                data: base64Data,
                mimeType: 'audio/pcm;rate=24000',
            },
        });
    } catch (error) {
        console.error('Error sending audio to Gemini:', error);
    }
}

function setupGeminiIpcHandlers(geminiSessionRef) {
    // Store the geminiSessionRef globally for reconnection access
    global.geminiSessionRef = geminiSessionRef;
    setupNativeMacOSMicTranscriptionIpcHandlers(handleNativeMicTranscript);

    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        const session = await initializeGeminiSession(apiKey, customPrompt, profile, language);
        if (session) {
            geminiSessionRef.current = session;
            return true;
        }
        return false;
    });

    ipcMain.handle('send-audio-content', async (event, { data, mimeType }) => {
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write('.');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending system audio:', error);
            return { success: false, error: error.message };
        }
    });

    // Handle microphone audio on a separate channel
    ipcMain.handle('send-mic-audio-content', async (event, { data, mimeType }) => {
        if (isNativeMacOSMicTranscriptionEnabled()) {
            return { success: true, skipped: true, reason: 'native_macos_mic_transcription_active' };
        }

        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write(',');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending mic audio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (event, { data, debug }) => {
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };

        try {
            if (!data || typeof data !== 'string') {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            const buffer = Buffer.from(data, 'base64');

            if (buffer.length < 1000) {
                console.error(`Image buffer too small: ${buffer.length} bytes`);
                return { success: false, error: 'Image buffer too small' };
            }

            process.stdout.write('!');
            await geminiSessionRef.current.sendRealtimeInput({
                media: { data: data, mimeType: 'image/jpeg' },
            });

            return { success: true };
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        try {
            if (!text || typeof text !== 'string' || text.trim().length === 0) {
                return { success: false, error: 'Invalid text message' };
            }

            console.log('Sending text message:', text);
            return await generateTextAnswerFromTranscript(text.trim(), 'manual_text');
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-screenshot-prompt', async (event, { instruction, data, mimeType = 'image/jpeg' }) => {
        try {
            if (!instruction || typeof instruction !== 'string' || instruction.trim().length === 0) {
                return { success: false, error: 'Invalid screenshot instruction' };
            }

            if (!data || typeof data !== 'string') {
                return { success: false, error: 'Invalid screenshot data' };
            }

            return await generateAnswerFromScreenshot(instruction.trim(), data, mimeType);
        } catch (error) {
            console.error('Error sending screenshot prompt:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture(geminiSessionRef);
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async event => {
        try {
            stopMacOSAudioCapture();
            resetInterviewerTranscriptBuffer();

            // Clear session params to prevent reconnection when user closes session
            lastSessionParams = null;
            geminiTextClient = null;
            geminiTextSystemPrompt = '';
            geminiTextTools = [];
            activeTextGenerationId += 1;
            lastSubmittedText = '';
            lastSubmittedTextAt = 0;

            // Cleanup any pending resources and stop audio/video capture
            if (geminiSessionRef.current) {
                await geminiSessionRef.current.close();
                geminiSessionRef.current = null;
            }

            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    // Conversation history IPC handlers
    ipcMain.handle('get-current-session', async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-google-search-setting', async (event, enabled) => {
        try {
            console.log('Google Search setting updated to:', enabled);
            // The setting is already saved in localStorage by the renderer
            // This is just for logging/confirmation
            return { success: true };
        } catch (error) {
            console.error('Error updating Google Search setting:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    initializeGeminiSession,
    getEnabledTools,
    getStoredSetting,
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    sendReconnectionContext,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    analyzePcm16,
    stopMacOSAudioCapture,
    sendAudioToGemini,
    setupGeminiIpcHandlers,
    attemptReconnection,
    isTerminalLiveSessionError,
    formatSpeakerResults,
    normalizeTranscriptForModel,
    needsRussianAnswerRepair,
    buildTextGenerationPrompt,
    buildScreenshotGenerationPrompt,
};
