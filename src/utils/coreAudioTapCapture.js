const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app } = require('electron');

function getSourcePath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'CoreAudioTapCapture.swift');
    }
    return path.join(__dirname, '..', 'native', 'CoreAudioTapCapture.swift');
}

function getBinaryPath() {
    const nativeDir = path.join(app.getPath('userData'), 'native');
    fs.mkdirSync(nativeDir, { recursive: true });
    return path.join(nativeDir, 'CoreAudioTapCapture');
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
    return fs.statSync(sourcePath).mtimeMs > fs.statSync(binaryPath).mtimeMs;
}

function buildCoreAudioTapHelper() {
    return new Promise((resolve, reject) => {
        const sourcePath = getSourcePath();
        const binaryPath = getBinaryPath();

        if (!fs.existsSync(sourcePath)) {
            reject(new Error(`Missing Core Audio Tap helper source at ${sourcePath}`));
            return;
        }
        if (!needsRebuild(sourcePath, binaryPath)) {
            resolve(binaryPath);
            return;
        }

        console.log('[CoreAudioTap] Building Swift helper...');
        const buildProcess = spawn('/usr/bin/xcrun', ['swiftc', sourcePath, '-O', '-o', binaryPath], {
            env: {
                ...process.env,
                TMPDIR: getTmpDir(),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';

        buildProcess.stderr.on('data', data => {
            stderr += data.toString();
        });
        buildProcess.on('error', reject);
        buildProcess.on('close', code => {
            if (code === 0) {
                console.log('[CoreAudioTap] Swift helper ready:', binaryPath);
                resolve(binaryPath);
                return;
            }
            reject(new Error(stderr || `swiftc exited with code ${code}`));
        });
    });
}

async function startCoreAudioTapProcess() {
    if (process.platform !== 'darwin') {
        throw new Error('Core Audio Tap is only available on macOS');
    }

    const [major, minor] = require('os')
        .release()
        .split('.')
        .map(value => Number.parseInt(value, 10));
    if (major < 23 || (major === 23 && minor < 2)) {
        throw new Error('Core Audio Tap requires macOS 14.2 or newer');
    }

    const binaryPath = await buildCoreAudioTapHelper();
    const helperProcess = spawn(binaryPath, [], {
        env: {
            ...process.env,
            TMPDIR: getTmpDir(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise((resolve, reject) => {
        let stderr = '';
        let settled = false;
        const timeout = setTimeout(() => {
            if (!settled) {
                settled = true;
                helperProcess.kill('SIGTERM');
                reject(new Error('Core Audio Tap helper did not become ready'));
            }
        }, 5000);

        helperProcess.stderr.on('data', data => {
            const message = data.toString();
            stderr += message;
            if (!settled && message.includes('[CoreAudioTap] started')) {
                settled = true;
                clearTimeout(timeout);
                resolve(helperProcess);
            }
        });
        helperProcess.on('error', error => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(error);
            }
        });
        helperProcess.on('close', code => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(new Error(stderr.trim() || `Core Audio Tap helper exited with code ${code}`));
            }
        });
    });
}

module.exports = {
    buildCoreAudioTapHelper,
    startCoreAudioTapProcess,
};
