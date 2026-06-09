const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain } = require('electron');

let helperProcess = null;
let currentLanguage = 'en-US';
let currentTranscript = '';
let currentPartialTranscript = '';
let lastForwardedTranscript = '';
let helperState = {
    isActive: false,
    onTranscript: null,
};

function isNativeMacOSMicTranscriptionEnabled() {
    return helperState.isActive;
}

function sendNativeMicLog(payload) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send('native-mic-transcription-log', payload);
    }
}

function getHelperSourcePath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'MacOSMicTranscriber.swift');
    }

    return path.join(__dirname, '..', 'native', 'MacOSMicTranscriber.swift');
}

function getHelperBinaryPath() {
    const nativeDir = path.join(app.getPath('userData'), 'native');
    fs.mkdirSync(nativeDir, { recursive: true });
    return path.join(nativeDir, 'MacOSMicTranscriber');
}

function getTmpDir() {
    const tmpDir = path.join(app.getPath('userData'), 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
}

function needsRebuild(sourcePath, binaryPath) {
    if (!fs.existsSync(binaryPath)) {
        return true;
    }

    const sourceStat = fs.statSync(sourcePath);
    const binaryStat = fs.statSync(binaryPath);
    return sourceStat.mtimeMs > binaryStat.mtimeMs;
}

function buildHelperBinary() {
    return new Promise((resolve, reject) => {
        const sourcePath = getHelperSourcePath();
        const binaryPath = getHelperBinaryPath();

        if (!fs.existsSync(sourcePath)) {
            reject(new Error(`Missing helper source at ${sourcePath}`));
            return;
        }

        if (!needsRebuild(sourcePath, binaryPath)) {
            resolve(binaryPath);
            return;
        }

        console.log('[Native mic transcription] Building Swift helper...');

        const buildProcess = spawn(
            '/usr/bin/xcrun',
            ['swiftc', sourcePath, '-O', '-o', binaryPath],
            {
                env: {
                    ...process.env,
                    TMPDIR: getTmpDir(),
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            }
        );

        let stderr = '';
        buildProcess.stderr.on('data', data => {
            stderr += data.toString();
        });

        buildProcess.on('error', error => {
            reject(error);
        });

        buildProcess.on('close', code => {
            if (code === 0) {
                console.log('[Native mic transcription] Swift helper ready:', binaryPath);
                resolve(binaryPath);
                return;
            }

            reject(new Error(stderr || `swiftc exited with code ${code}`));
        });
    });
}

function normalizeLanguage(language) {
    if (!language || typeof language !== 'string') {
        return 'en-US';
    }

    return language.trim() || 'en-US';
}

function stopNativeMacOSMicTranscription() {
    helperState.isActive = false;
    currentTranscript = '';
    currentPartialTranscript = '';
    lastForwardedTranscript = '';

    if (helperProcess) {
        console.log('[Native mic transcription] Stopping helper...');
        helperProcess.kill('SIGTERM');
        helperProcess = null;
    }
}

async function forwardTranscriptPayload(payload) {
    if (!payload?.text || typeof helperState.onTranscript !== 'function') {
        return;
    }

    if (payload.text === lastForwardedTranscript) {
        return;
    }

    lastForwardedTranscript = payload.text;
    await helperState.onTranscript(payload);
}

async function startNativeMacOSMicTranscription(language, onTranscript) {
    if (process.platform !== 'darwin') {
        throw new Error('Native macOS microphone transcription is only available on macOS');
    }

    stopNativeMacOSMicTranscription();

    const helperPath = await buildHelperBinary();
    currentLanguage = normalizeLanguage(language);
    helperState.onTranscript = onTranscript;

    helperProcess = spawn(helperPath, [currentLanguage], {
        env: {
            ...process.env,
            TMPDIR: getTmpDir(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    helperState.isActive = true;

    const stdoutInterface = readline.createInterface({
        input: helperProcess.stdout,
        crlfDelay: Infinity,
    });

    stdoutInterface.on('line', async line => {
        if (!line.trim()) {
            return;
        }

        try {
            const payload = JSON.parse(line);

            if (payload.type === 'partial') {
                currentPartialTranscript = payload.text;
                console.log(`[Native mic transcription][partial] ${payload.text}`);
                sendNativeMicLog(payload);
                return;
            }

            if (payload.type === 'stabilized') {
                currentTranscript = payload.text;
                currentPartialTranscript = '';
                console.log(`[Native mic transcription][stabilized] ${payload.text}`);
                sendNativeMicLog(payload);
                await forwardTranscriptPayload(payload);
                return;
            }

            if (payload.type === 'final') {
                currentTranscript = payload.text;
                currentPartialTranscript = '';
                console.log(`[Native mic transcription][final] ${payload.text}`);
                sendNativeMicLog(payload);

                await forwardTranscriptPayload(payload);
                return;
            }

            if (payload.type === 'status') {
                console.log(`[Native mic transcription][status] ${payload.message}`);
                sendNativeMicLog(payload);
                return;
            }

            if (payload.type === 'error') {
                console.error(
                    `[Native mic transcription][error] ${payload.message}${payload.details ? `: ${payload.details}` : ''}`
                );
                sendNativeMicLog(payload);
            }
        } catch (error) {
            console.error('[Native mic transcription] Failed to parse helper output:', line, error);
        }
    });

    helperProcess.stderr.on('data', data => {
        const message = data.toString().trim();
        if (message) {
            console.error('[Native mic transcription][stderr]', message);
        }
    });

    helperProcess.on('error', error => {
        helperState.isActive = false;
        console.error('[Native mic transcription] Helper process error:', error);
    });

    helperProcess.on('close', code => {
        helperState.isActive = false;
        helperProcess = null;
        console.log('[Native mic transcription] Helper stopped with code:', code);
    });
}

function setupNativeMacOSMicTranscriptionIpcHandlers(onFinalTranscript) {
    ipcMain.handle('start-native-macos-mic-transcription', async (event, language = 'en-US') => {
        try {
            await startNativeMacOSMicTranscription(language, onFinalTranscript);
            return { success: true };
        } catch (error) {
            console.error('Error starting native macOS mic transcription:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-native-macos-mic-transcription', async () => {
        try {
            stopNativeMacOSMicTranscription();
            return { success: true };
        } catch (error) {
            console.error('Error stopping native macOS mic transcription:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    setupNativeMacOSMicTranscriptionIpcHandlers,
    startNativeMacOSMicTranscription,
    stopNativeMacOSMicTranscription,
    isNativeMacOSMicTranscriptionEnabled,
};
