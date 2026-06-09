const electronPath = require.resolve('electron');
require.cache[electronPath] = {
    exports: {
        BrowserWindow: {
            getAllWindows: vi.fn(() => [{ webContents: { send: vi.fn() } }]),
        },
        ipcMain: { handle: vi.fn(), on: vi.fn() },
        shell: { openExternal: vi.fn() },
    },
};

const {
    buildTextGenerationPrompt,
    initializeNewSession,
    isModelFallbackError,
    isQuotaError,
    needsRussianAnswerRepair,
    normalizeTranscriptForModel,
    saveConversationTurn,
} = require('../utils/gemini');

describe('system audio question handling', () => {
    beforeEach(() => {
        initializeNewSession();
    });

    it('repairs common English ASR word splits', () => {
        expect(normalizeTranscriptForModel('have to im prove per formance in aplica tions')).toBe('how to improve performance in applications');
    });

    it('instructs the model to answer one narrow technical domain', () => {
        saveConversationTurn('previous question', 'previous answer');
        const prompt = buildTextGenerationPrompt('how to improve performance in applications', 'system_audio', {
            forceRussianAnswer: true,
        });

        expect(prompt).toContain('Silently reconstruct the most likely interview question');
        expect(prompt).toContain('answer about frontend/React performance only');
        expect(prompt).toContain('Do not introduce backend, databases, cloud infrastructure');
        expect(prompt).toContain('Answer in Russian only.');
        expect(prompt).not.toContain('previous question');
        expect(prompt).not.toContain('previous answer');
    });

    it('repairs an English-only answer when Russian output is forced', () => {
        expect(needsRussianAnswerRepair('Frontend performance optimization', true)).toBe(true);
        expect(needsRussianAnswerRepair('Оптимизация React приложения', true)).toBe(false);
        expect(needsRussianAnswerRepair('Frontend performance optimization', false)).toBe(false);
    });

    it('does not fall back to another model when quota is exhausted', () => {
        const quotaError = new Error('429 RESOURCE_EXHAUSTED: quota exceeded');
        expect(isQuotaError(quotaError)).toBe(true);
        expect(isModelFallbackError(quotaError)).toBe(false);
        expect(isModelFallbackError(new Error('Model gemini-x was not found'))).toBe(true);
    });
});
