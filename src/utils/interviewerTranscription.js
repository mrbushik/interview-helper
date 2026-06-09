const DEFAULT_SILENCE_MS = 1500;
const DEFAULT_MIN_CHARS = 8;
const DEFAULT_CLEANUP_DEBOUNCE_MS = 650;
const DEFAULT_FINALIZE_CLEANUP_WAIT_MS = 250;

const SHORT_ACKNOWLEDGEMENTS = new Set([
    'ага',
    'да',
    'хорошо',
    'ладно',
    'понятно',
    'угу',
    'так',
    'ок',
    'окей',
    'yes',
    'yeah',
    'yep',
    'okay',
    'ok',
    'right',
    'sure',
    'good',
    'great',
    'thanks',
]);

const QUESTION_START_PATTERN =
    /^(?:why|what|when|where|who|which|how|can|could|would|will|do|does|did|is|are|have|has|tell|describe|explain|walk|почему|зачем|что|когда|где|кто|какой|какая|какие|как|можете|можешь|расскажите|расскажи|объясните|объясни|опишите|опиши)(?=\s|$|[?!,.:;])/i;

function normalizeTranscriptText(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function findTextOverlap(left, right) {
    const maxLength = Math.min(left.length, right.length);
    for (let length = maxLength; length > 0; length--) {
        if (left.slice(-length).toLowerCase() === right.slice(0, length).toLowerCase()) {
            return length;
        }
    }
    return 0;
}

function mergeTranscriptText(currentText, incomingText) {
    const current = normalizeTranscriptText(currentText);
    const incoming = normalizeTranscriptText(incomingText);

    if (!incoming) {
        return current;
    }
    if (!current) {
        return incoming;
    }
    if (incoming.toLowerCase() === current.toLowerCase()) {
        return current;
    }
    if (incoming.toLowerCase().startsWith(current.toLowerCase())) {
        return incoming;
    }
    if (current.toLowerCase().endsWith(incoming.toLowerCase())) {
        return current;
    }

    const overlap = findTextOverlap(current, incoming);
    if (overlap > 0) {
        return normalizeTranscriptText(`${current}${incoming.slice(overlap)}`);
    }

    return normalizeTranscriptText(`${current} ${incoming}`);
}

function extractTranscriptionUpdate(inputTranscription) {
    if (!inputTranscription) {
        return { text: '', finished: false };
    }

    if (typeof inputTranscription === 'string') {
        return { text: normalizeTranscriptText(inputTranscription), finished: false };
    }

    if (typeof inputTranscription.text === 'string') {
        return {
            text: normalizeTranscriptText(inputTranscription.text),
            finished: inputTranscription.finished === true,
        };
    }

    if (Array.isArray(inputTranscription.results)) {
        const text = inputTranscription.results
            .map(result => result?.transcript)
            .filter(Boolean)
            .join(' ');

        return {
            text: normalizeTranscriptText(text),
            finished: inputTranscription.finished === true,
        };
    }

    return { text: '', finished: inputTranscription.finished === true };
}

function isMeaningfulInterviewerTranscript(text, minChars = DEFAULT_MIN_CHARS) {
    const normalized = normalizeTranscriptText(text);
    if (!normalized) {
        return false;
    }

    const content = normalized
        .toLowerCase()
        .replace(/[.,!?;:()[\]{}"'`]+/g, '')
        .trim();

    if (!content || SHORT_ACKNOWLEDGEMENTS.has(content)) {
        return false;
    }

    if (normalized.includes('?') || QUESTION_START_PATTERN.test(normalized)) {
        return content.length >= 3;
    }

    return content.length >= Math.max(1, Number(minChars) || DEFAULT_MIN_CHARS);
}

function createInterviewerTranscriptBuffer(options = {}) {
    const {
        silenceMs = DEFAULT_SILENCE_MS,
        minChars = DEFAULT_MIN_CHARS,
        cleanupDebounceMs = DEFAULT_CLEANUP_DEBOUNCE_MS,
        finalizeCleanupWaitMs = DEFAULT_FINALIZE_CLEANUP_WAIT_MS,
        onUpdate = () => {},
        onFinalize = () => {},
        onCleanup = null,
        repairText = text => text,
        logger = console,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
    } = options;

    let rawTranscript = '';
    let repairedTranscript = '';
    let cleanedTranscript = '';
    let silenceTimer = null;
    let cleanupTimer = null;
    let cleanupRevision = 0;
    let cleanupPromise = null;
    let cleanupPromiseRevision = 0;

    function clearSilenceTimer() {
        if (silenceTimer) {
            clearTimer(silenceTimer);
            silenceTimer = null;
        }
    }

    function clearCleanupTimer() {
        if (cleanupTimer) {
            clearTimer(cleanupTimer);
            cleanupTimer = null;
        }
    }

    function getBestText() {
        return cleanedTranscript || repairedTranscript || rawTranscript;
    }

    function emitUpdate(update = {}) {
        onUpdate({
            rawText: rawTranscript,
            repairedText: repairedTranscript,
            cleanedText: cleanedTranscript,
            bestText: getBestText(),
            cleanupPending: Boolean(cleanupTimer || cleanupPromise),
            ...update,
        });
    }

    function reset() {
        clearSilenceTimer();
        clearCleanupTimer();
        cleanupRevision += 1;
        cleanupPromise = null;
        cleanupPromiseRevision = 0;
        rawTranscript = '';
        repairedTranscript = '';
        cleanedTranscript = '';
    }

    function invalidateCleanedTranscript() {
        cleanedTranscript = '';
    }

    function applyLocalRepair(text) {
        return normalizeTranscriptText(repairText(text));
    }

    async function runCleanupNow(reason = 'debounced_cleanup') {
        if (typeof onCleanup !== 'function') {
            return '';
        }

        const revision = cleanupRevision;
        if (cleanupPromise && cleanupPromiseRevision === revision) {
            return cleanupPromise;
        }
        const textToClean = repairedTranscript || rawTranscript;
        if (!textToClean) {
            return '';
        }

        cleanupPromiseRevision = revision;
        cleanupPromise = Promise.resolve(
            onCleanup(textToClean, {
                rawText: rawTranscript,
                repairedText: repairedTranscript,
                reason,
            })
        )
            .then(cleanedText => {
                if (revision !== cleanupRevision || cleanupPromiseRevision !== revision) {
                    return '';
                }

                const normalizedCleanedText = normalizeTranscriptText(cleanedText);
                if (normalizedCleanedText) {
                    cleanedTranscript = normalizedCleanedText;
                    emitUpdate({ cleanupApplied: true });
                }
                return normalizedCleanedText;
            })
            .catch(error => {
                logger.warn('[Interviewer transcription] Cleanup failed:', error);
                return '';
            })
            .finally(() => {
                if (cleanupPromiseRevision === revision) {
                    cleanupPromise = null;
                }
            });

        return cleanupPromise;
    }

    function scheduleCleanup() {
        if (typeof onCleanup !== 'function') {
            return;
        }

        clearCleanupTimer();
        cleanupTimer = setTimer(() => {
            cleanupTimer = null;
            void runCleanupNow('pause_cleanup');
        }, Math.max(150, Number(cleanupDebounceMs) || DEFAULT_CLEANUP_DEBOUNCE_MS));
    }

    function waitForCleanup(timeoutMs) {
        if (!cleanupPromise) {
            return Promise.resolve();
        }

        return Promise.race([
            cleanupPromise.catch(() => {}),
            new Promise(resolve => {
                setTimer(resolve, Math.max(50, Number(timeoutMs) || DEFAULT_FINALIZE_CLEANUP_WAIT_MS));
            }),
        ]);
    }

    async function finalize(reason = 'manual') {
        clearSilenceTimer();
        clearCleanupTimer();

        if (typeof onCleanup === 'function' && (repairedTranscript || rawTranscript) && !cleanedTranscript) {
            await runCleanupNow('finalize_cleanup');
        }

        await waitForCleanup(finalizeCleanupWaitMs);

        const finalizedText = normalizeTranscriptText(getBestText());
        const rawText = rawTranscript;
        const repairedText = repairedTranscript;
        const cleanedText = cleanedTranscript;
        reset();

        if (!isMeaningfulInterviewerTranscript(finalizedText, minChars)) {
            if (finalizedText) {
                logger.log(`[Interviewer transcription] Ignored short/non-question fragment (${reason}):`, finalizedText);
            }
            return false;
        }

        logger.log(`[Interviewer transcription] Finalized (${reason}):`, finalizedText);
        Promise.resolve(
            onFinalize(finalizedText, reason, {
                rawText,
                repairedText,
                cleanedText,
            })
        ).catch(error => {
            logger.error('[Interviewer transcription] Finalization failed:', error);
        });
        return true;
    }

    function scheduleFinalization(delayMs, reason) {
        clearSilenceTimer();
        silenceTimer = setTimer(() => {
            silenceTimer = null;
            finalize(reason);
        }, Math.max(100, Number(delayMs) || DEFAULT_SILENCE_MS));
    }

    function scheduleSilenceFinalization() {
        scheduleFinalization(silenceMs, 'silence_timeout');
    }

    function add(inputTranscription) {
        const update = extractTranscriptionUpdate(inputTranscription);
        if (update.text) {
            rawTranscript = mergeTranscriptText(rawTranscript, update.text);
            repairedTranscript = applyLocalRepair(rawTranscript);
            invalidateCleanedTranscript();
            cleanupRevision += 1;
            emitUpdate(update);
        }

        if (update.finished) {
            return void finalize('transcription_finished');
        }

        if (update.text) {
            scheduleCleanup();
            scheduleSilenceFinalization();
        }

        return false;
    }

    return {
        add,
        finalize,
        reset,
        scheduleFinalize: (delayMs = 350, reason = 'turn_complete') => scheduleFinalization(delayMs, reason),
        getText: () => rawTranscript,
        getBestText,
    };
}

module.exports = {
    DEFAULT_CLEANUP_DEBOUNCE_MS,
    DEFAULT_FINALIZE_CLEANUP_WAIT_MS,
    DEFAULT_MIN_CHARS,
    DEFAULT_SILENCE_MS,
    createInterviewerTranscriptBuffer,
    extractTranscriptionUpdate,
    isMeaningfulInterviewerTranscript,
    mergeTranscriptText,
    normalizeTranscriptText,
};
