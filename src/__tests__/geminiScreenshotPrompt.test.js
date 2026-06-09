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

const { buildScreenshotGenerationPrompt, initializeNewSession, normalizeScreenshotMode, saveConversationTurn } = require('../utils/gemini');

describe('buildScreenshotGenerationPrompt', () => {
    beforeEach(() => {
        initializeNewSession();
    });

    it('includes screenshot-specific guidance without conversation history', () => {
        saveConversationTurn('previous question', 'previous answer');

        const prompt = buildScreenshotGenerationPrompt('Solve the task on screen');

        expect(prompt).toContain('Current input source: screenshot');
        expect(prompt).toContain('Solve the task on screen');
        expect(prompt).toContain('Use the screenshot as the primary source of truth.');
        expect(prompt).not.toContain('previous question');
        expect(prompt).not.toContain('previous answer');
        expect(prompt).not.toContain('SCREENSHOT MODE:');
    });

    it.each([
        ['live_coding', 'SCREENSHOT MODE: LIVE CODING', 'time and space complexity'],
        ['code_review', 'SCREENSHOT MODE: CODE REVIEW', 'Order findings by severity'],
        ['console_output', 'SCREENSHOT MODE: CONSOLE OUTPUT', 'exact console output'],
    ])('adds instructions for %s mode', (mode, heading, detail) => {
        const prompt = buildScreenshotGenerationPrompt('Analyze the visible code', { mode });

        expect(prompt).toContain(heading);
        expect(prompt).toContain(detail);
    });

    it('falls back to default mode for unknown values', () => {
        expect(normalizeScreenshotMode('unknown')).toBe('default');
        expect(normalizeScreenshotMode('code_review')).toBe('code_review');

        const prompt = buildScreenshotGenerationPrompt('Analyze the screen', { mode: 'unknown' });
        expect(prompt).not.toContain('SCREENSHOT MODE:');
    });
});
