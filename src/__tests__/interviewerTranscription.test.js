const {
    DEFAULT_CLEANUP_DEBOUNCE_MS,
    DEFAULT_FINALIZE_CLEANUP_WAIT_MS,
    createInterviewerTranscriptBuffer,
    extractTranscriptionUpdate,
    isMeaningfulInterviewerTranscript,
    mergeTranscriptText,
} = require('../utils/interviewerTranscription');

describe('interviewer transcription', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('reads the current Gemini Live text/finished contract', () => {
        expect(extractTranscriptionUpdate({ text: '  Explain React  ', finished: true })).toEqual({
            text: 'Explain React',
            finished: true,
        });
    });

    it('keeps compatibility with legacy diarization results', () => {
        expect(
            extractTranscriptionUpdate({
                results: [{ transcript: 'Explain' }, { transcript: 'hooks' }],
            })
        ).toEqual({
            text: 'Explain hooks',
            finished: false,
        });
    });

    it('merges cumulative and incremental transcript updates', () => {
        expect(mergeTranscriptText('Explain React', 'Explain React hooks')).toBe('Explain React hooks');
        expect(mergeTranscriptText('Explain React', 'React hooks')).toBe('Explain React hooks');
        expect(mergeTranscriptText('Explain React', 'hooks')).toBe('Explain React hooks');
    });

    it('finalizes a complete transcript when Gemini marks it finished', async () => {
        const onFinalize = vi.fn();
        const buffer = createInterviewerTranscriptBuffer({ onFinalize });

        buffer.add({ text: 'Расскажите про React', finished: false });
        buffer.add({ text: 'Расскажите про React hooks', finished: true });
        await Promise.resolve();

        expect(onFinalize).toHaveBeenCalledWith(
            'Расскажите про React hooks',
            'transcription_finished',
            expect.objectContaining({
                rawText: 'Расскажите про React hooks',
                repairedText: 'Расскажите про React hooks',
            })
        );
        expect(buffer.getText()).toBe('');
    });

    it('waits for silence and resets the timer when more speech arrives', async () => {
        vi.useFakeTimers();
        const onFinalize = vi.fn();
        const buffer = createInterviewerTranscriptBuffer({
            silenceMs: 1500,
            onFinalize,
        });

        buffer.add({ text: 'Расскажите про ваш опыт' });
        vi.advanceTimersByTime(1000);
        buffer.add({ text: 'с TypeScript' });
        vi.advanceTimersByTime(1000);
        expect(onFinalize).not.toHaveBeenCalled();

        vi.advanceTimersByTime(500);
        await vi.runAllTimersAsync();
        expect(onFinalize).toHaveBeenCalledWith(
            'Расскажите про ваш опыт с TypeScript',
            'silence_timeout',
            expect.objectContaining({
                rawText: 'Расскажите про ваш опыт с TypeScript',
            })
        );
    });

    it('uses pause time to apply transcript cleanup before finalizing', async () => {
        vi.useFakeTimers();
        const onFinalize = vi.fn();
        const onCleanup = vi.fn(async transcript => transcript.replace('have to', 'how to'));
        const buffer = createInterviewerTranscriptBuffer({
            onFinalize,
            onCleanup,
            repairText: text => text,
            cleanupDebounceMs: 300,
            finalizeCleanupWaitMs: 120,
        });

        buffer.add({ text: 'have to improve performance in React' });
        await vi.advanceTimersByTimeAsync(300);
        await Promise.resolve();

        buffer.add({ text: 'applications' });
        await vi.advanceTimersByTimeAsync(1500);
        await Promise.resolve();

        expect(onCleanup).toHaveBeenCalled();
        expect(onFinalize).toHaveBeenCalledWith(
            'how to improve performance in React applications',
            'silence_timeout',
            expect.objectContaining({
                rawText: 'have to improve performance in React applications',
                cleanedText: 'how to improve performance in React applications',
            })
        );
    });

    it('exports cleanup timing defaults', () => {
        expect(DEFAULT_CLEANUP_DEBOUNCE_MS).toBe(650);
        expect(DEFAULT_FINALIZE_CLEANUP_WAIT_MS).toBe(250);
    });

    it('ignores acknowledgements but keeps short explicit questions', () => {
        expect(isMeaningfulInterviewerTranscript('Окей')).toBe(false);
        expect(isMeaningfulInterviewerTranscript('Почему?')).toBe(true);
        expect(isMeaningfulInterviewerTranscript('Почему')).toBe(true);
        expect(isMeaningfulInterviewerTranscript('Why React?')).toBe(true);
    });
});
