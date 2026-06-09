// renderer.js
const { ipcRenderer } = require('electron');

// Initialize random display name for UI components
window.randomDisplayName = null;

// Request random display name from main process
ipcRenderer
    .invoke('get-random-display-name')
    .then(name => {
        window.randomDisplayName = name;
        console.log('Set random display name:', name);
    })
    .catch(err => {
        console.warn('Could not get random display name:', err);
        window.randomDisplayName = 'System Monitor';
    });

let mediaStream = null;
let screenshotInterval = null;
let audioContext = null;
let audioProcessor = null;
let micAudioProcessor = null;
let audioBuffer = [];
const SAMPLE_RATE = 24000;
const AUDIO_CHUNK_DURATION = 0.1; // seconds
const BUFFER_SIZE = 4096; // Increased buffer size for smoother audio

let hiddenVideo = null;
let offscreenCanvas = null;
let offscreenContext = null;
let currentImageQuality = 'medium'; // Store current image quality for manual screenshots

const isLinux = process.platform === 'linux';
const isMacOS = process.platform === 'darwin';

function createFloat32AudioActivityGate({ threshold = 0.004, preRollChunks = 3, hangoverChunks = 20 } = {}) {
    let preRoll = [];
    let remainingHangoverChunks = 0;

    return {
        push(chunk) {
            let squareSum = 0;
            for (const sample of chunk) {
                squareSum += sample * sample;
            }

            const rms = chunk.length > 0 ? Math.sqrt(squareSum / chunk.length) : 0;
            if (rms >= threshold) {
                const chunks = [...preRoll, chunk];
                preRoll = [];
                remainingHangoverChunks = hangoverChunks;
                return chunks;
            }

            if (remainingHangoverChunks > 0) {
                remainingHangoverChunks -= 1;
                return [chunk];
            }

            preRoll.push(chunk);
            if (preRoll.length > preRollChunks) {
                preRoll.shift();
            }
            return [];
        },
    };
}

function convertFloat32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        // Improved scaling to prevent clipping
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16Array;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

async function initializeGemini(profile = 'interview', language = 'en-US') {
    const apiKey = localStorage.getItem('apiKey')?.trim();
    if (apiKey) {
        const success = await ipcRenderer.invoke('initialize-gemini', apiKey, buildSessionContext(), profile, language);
        if (success) {
            cheddar.setStatus('Live');
        } else {
            cheddar.setStatus('error');
        }
    }
}

function buildSessionContext() {
    const sections = [];
    const maxSectionChars = 4000;
    const customPrompt = (localStorage.getItem('customPrompt') || '').trim();
    const candidateContext = (localStorage.getItem('candidateContext') || '').trim();
    const companyContext = (localStorage.getItem('companyContext') || '').trim();
    const vacancyContext = (localStorage.getItem('vacancyContext') || '').trim();
    const limitSection = value => (value.length > maxSectionChars ? `${value.slice(0, maxSectionChars)}\n[Context truncated]` : value);

    if (candidateContext) {
        sections.push(`Candidate profile and personal experience\n-----\n${limitSection(candidateContext)}\n-----`);
    }

    if (companyContext) {
        sections.push(`Target company context\n-----\n${limitSection(companyContext)}\n-----`);
    }

    if (vacancyContext) {
        sections.push(`Vacancy requirements and role context\n-----\n${limitSection(vacancyContext)}\n-----`);
    }

    if (customPrompt) {
        sections.push(`Additional custom instructions\n-----\n${limitSection(customPrompt)}\n-----`);
    }

    return sections.join('\n\n');
}

function shouldUseNativeMacOSMicTranscription(audioMode) {
    return isMacOS && localStorage.getItem('useNativeMacOSMicTranscription') === 'true' && (audioMode === 'mic_only' || audioMode === 'both');
}

// Listen for status updates
ipcRenderer.on('update-status', (event, status) => {
    console.log('Status update:', status);
    cheddar.setStatus(status);
});

ipcRenderer.on('native-mic-transcription-log', (event, payload) => {
    if (payload.type === 'partial' || payload.type === 'final') {
        console.log(`[Native mic transcription][${payload.type}] ${payload.text}`);
        return;
    }

    if (payload.type === 'status') {
        console.log(`[Native mic transcription][status] ${payload.message}`);
        return;
    }

    if (payload.type === 'error') {
        console.error(`[Native mic transcription][error] ${payload.message}${payload.details ? `: ${payload.details}` : ''}`);
    }
});

// Listen for responses - REMOVED: This is handled in CheatingDaddyApp.js to avoid duplicates
// ipcRenderer.on('update-response', (event, response) => {
//     console.log('Gemini response:', response);
//     cheddar.e().setResponse(response);
//     // You can add UI elements to display the response if needed
// });

async function startCapture(screenshotIntervalSeconds = 'manual', imageQuality = 'medium') {
    // Store the image quality for manual screenshots
    currentImageQuality = imageQuality;

    const audioMode = localStorage.getItem('audioMode') || 'speaker_only';
    const nativeMacOSMicTranscription = shouldUseNativeMacOSMicTranscription(audioMode);

    try {
        if (isMacOS) {
            // macOS uses a dedicated system-audio helper and one-shot screenshots.
            const shouldCaptureSystemAudio = audioMode === 'speaker_only' || audioMode === 'both';
            if (shouldCaptureSystemAudio) {
                console.log('Starting macOS system audio capture...');

                // Start macOS audio capture
                const audioResult = await ipcRenderer.invoke('start-macos-audio');
                if (!audioResult.success) {
                    throw new Error('Failed to start macOS audio capture: ' + audioResult.error);
                }
            } else {
                console.log('Skipping system audio capture because audio mode is microphone-only');
            }

            console.log(
                `macOS session started without a persistent screen stream - system audio ${shouldCaptureSystemAudio ? 'enabled' : 'disabled'}`
            );

            if (audioMode === 'mic_only' || audioMode === 'both') {
                if (nativeMacOSMicTranscription) {
                    const result = await ipcRenderer.invoke(
                        'start-native-macos-mic-transcription',
                        localStorage.getItem('selectedLanguage') || 'en-US'
                    );
                    if (!result.success) {
                        throw new Error('Failed to start native macOS mic transcription: ' + result.error);
                    }
                    console.log('macOS native microphone transcription started');
                } else {
                    let micStream = null;
                    try {
                        micStream = await navigator.mediaDevices.getUserMedia({
                            audio: {
                                sampleRate: SAMPLE_RATE,
                                channelCount: 1,
                                echoCancellation: true,
                                noiseSuppression: true,
                                autoGainControl: true,
                            },
                            video: false,
                        });
                        console.log('macOS microphone capture started');
                        setupLinuxMicProcessing(micStream);
                    } catch (micError) {
                        console.warn('Failed to get microphone access on macOS:', micError);
                    }
                }
            }
        } else if (isLinux) {
            // Linux - use display media for screen capture and try to get system audio
            try {
                // First try to get system audio via getDisplayMedia (works on newer browsers)
                mediaStream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        frameRate: 1,
                        width: { ideal: 1920 },
                        height: { ideal: 1080 },
                    },
                    audio: {
                        sampleRate: SAMPLE_RATE,
                        channelCount: 1,
                        echoCancellation: false, // Don't cancel system audio
                        noiseSuppression: false,
                        autoGainControl: false,
                    },
                });

                console.log('Linux system audio capture via getDisplayMedia succeeded');

                // Setup audio processing for Linux system audio
                setupLinuxSystemAudioProcessing();
            } catch (systemAudioError) {
                console.warn('System audio via getDisplayMedia failed, trying screen-only capture:', systemAudioError);

                // Fallback to screen-only capture
                mediaStream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        frameRate: 1,
                        width: { ideal: 1920 },
                        height: { ideal: 1080 },
                    },
                    audio: false,
                });
            }

            // Additionally get microphone input for Linux based on audio mode
            if (audioMode === 'mic_only' || audioMode === 'both') {
                let micStream = null;
                try {
                    micStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            sampleRate: SAMPLE_RATE,
                            channelCount: 1,
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true,
                        },
                        video: false,
                    });

                    console.log('Linux microphone capture started');

                    // Setup audio processing for microphone on Linux
                    setupLinuxMicProcessing(micStream);
                } catch (micError) {
                    console.warn('Failed to get microphone access on Linux:', micError);
                    // Continue without microphone if permission denied
                }
            }

            console.log('Linux capture started - system audio:', mediaStream.getAudioTracks().length > 0, 'microphone mode:', audioMode);
        } else {
            // Windows - use display media with loopback for system audio
            mediaStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    frameRate: 1,
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: {
                    sampleRate: SAMPLE_RATE,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            console.log('Windows capture started with loopback audio');

            // Setup audio processing for Windows loopback audio only
            setupWindowsLoopbackProcessing();

            if (audioMode === 'mic_only' || audioMode === 'both') {
                let micStream = null;
                try {
                    micStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            sampleRate: SAMPLE_RATE,
                            channelCount: 1,
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true,
                        },
                        video: false,
                    });
                    console.log('Windows microphone capture started');
                    setupLinuxMicProcessing(micStream);
                } catch (micError) {
                    console.warn('Failed to get microphone access on Windows:', micError);
                }
            }
        }

        if (mediaStream) {
            console.log('MediaStream obtained:', {
                hasVideo: mediaStream.getVideoTracks().length > 0,
                hasAudio: mediaStream.getAudioTracks().length > 0,
                videoTrack: mediaStream.getVideoTracks()[0]?.getSettings(),
            });
        }

        console.log('Screenshots are manual-only and captured with Cmd/Ctrl+Enter');
    } catch (err) {
        console.error('Error starting capture:', err);
        cheddar.setStatus('error');
    }
}

function setupLinuxMicProcessing(micStream) {
    // Setup microphone audio processing for Linux
    const micAudioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const micSource = micAudioContext.createMediaStreamSource(micStream);
    const micProcessor = micAudioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;
    const audioActivityGate = createFloat32AudioActivityGate();

    micProcessor.onaudioprocess = async e => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioBuffer.push(...inputData);

        // Process audio in chunks
        while (audioBuffer.length >= samplesPerChunk) {
            const chunk = audioBuffer.splice(0, samplesPerChunk);
            for (const activeChunk of audioActivityGate.push(chunk)) {
                const pcmData16 = convertFloat32ToInt16(activeChunk);
                const base64Data = arrayBufferToBase64(pcmData16.buffer);

                await ipcRenderer.invoke('send-mic-audio-content', {
                    data: base64Data,
                    mimeType: 'audio/pcm;rate=24000',
                });
            }
        }
    };

    micSource.connect(micProcessor);
    micProcessor.connect(micAudioContext.destination);

    // Store processor reference for cleanup
    micAudioProcessor = micProcessor;
}

function setupLinuxSystemAudioProcessing() {
    // Setup system audio processing for Linux (from getDisplayMedia)
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioContext.createMediaStreamSource(mediaStream);
    audioProcessor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;
    const audioActivityGate = createFloat32AudioActivityGate();

    audioProcessor.onaudioprocess = async e => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioBuffer.push(...inputData);

        // Process audio in chunks
        while (audioBuffer.length >= samplesPerChunk) {
            const chunk = audioBuffer.splice(0, samplesPerChunk);
            for (const activeChunk of audioActivityGate.push(chunk)) {
                const pcmData16 = convertFloat32ToInt16(activeChunk);
                const base64Data = arrayBufferToBase64(pcmData16.buffer);

                await ipcRenderer.invoke('send-audio-content', {
                    data: base64Data,
                    mimeType: 'audio/pcm;rate=24000',
                });
            }
        }
    };

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
}

function setupWindowsLoopbackProcessing() {
    // Setup audio processing for Windows loopback audio only
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioContext.createMediaStreamSource(mediaStream);
    audioProcessor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;
    const audioActivityGate = createFloat32AudioActivityGate();

    audioProcessor.onaudioprocess = async e => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioBuffer.push(...inputData);

        // Process audio in chunks
        while (audioBuffer.length >= samplesPerChunk) {
            const chunk = audioBuffer.splice(0, samplesPerChunk);
            for (const activeChunk of audioActivityGate.push(chunk)) {
                const pcmData16 = convertFloat32ToInt16(activeChunk);
                const base64Data = arrayBufferToBase64(pcmData16.buffer);

                await ipcRenderer.invoke('send-audio-content', {
                    data: base64Data,
                    mimeType: 'audio/pcm;rate=24000',
                });
            }
        }
    };

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
}

async function captureScreenshot(imageQuality = 'medium') {
    console.log('Capturing manual screenshot...');

    if (isMacOS) {
        return ipcRenderer.invoke('capture-screen-thumbnail', imageQuality);
    }

    if (!mediaStream) {
        return { success: false, error: 'Screen capture stream is not available' };
    }

    // Lazy init of video element
    if (!hiddenVideo) {
        hiddenVideo = document.createElement('video');
        hiddenVideo.srcObject = mediaStream;
        hiddenVideo.muted = true;
        hiddenVideo.playsInline = true;
        await hiddenVideo.play();

        await new Promise(resolve => {
            if (hiddenVideo.readyState >= 2) return resolve();
            hiddenVideo.onloadedmetadata = () => resolve();
        });

        // Lazy init of canvas based on video dimensions
        offscreenCanvas = document.createElement('canvas');
        offscreenCanvas.width = hiddenVideo.videoWidth;
        offscreenCanvas.height = hiddenVideo.videoHeight;
        offscreenContext = offscreenCanvas.getContext('2d');
    }

    // Check if video is ready
    if (hiddenVideo.readyState < 2) {
        console.warn('Video not ready yet, skipping screenshot');
        return;
    }

    offscreenContext.drawImage(hiddenVideo, 0, 0, offscreenCanvas.width, offscreenCanvas.height);

    // Check if image was drawn properly by sampling a pixel
    const imageData = offscreenContext.getImageData(0, 0, 1, 1);
    const isBlank = imageData.data.every((value, index) => {
        // Check if all pixels are black (0,0,0) or transparent
        return index === 3 ? true : value === 0;
    });

    if (isBlank) {
        console.warn('Screenshot appears to be blank/black');
    }

    let qualityValue;
    switch (imageQuality) {
        case 'high':
            qualityValue = 0.9;
            break;
        case 'medium':
            qualityValue = 0.7;
            break;
        case 'low':
            qualityValue = 0.5;
            break;
        default:
            qualityValue = 0.7; // Default to medium
    }

    return new Promise(resolve => {
        offscreenCanvas.toBlob(
            async blob => {
                if (!blob) {
                    console.error('Failed to create blob from canvas');
                    resolve({ success: false, error: 'Failed to create screenshot blob' });
                    return;
                }

                const reader = new FileReader();
                reader.onloadend = async () => {
                    const base64data = reader.result.split(',')[1];

                    if (!base64data || base64data.length < 100) {
                        console.error('Invalid base64 data generated');
                        resolve({ success: false, error: 'Invalid base64 data generated' });
                        return;
                    }

                    resolve({
                        success: true,
                        data: base64data,
                        mimeType: 'image/jpeg',
                        width: offscreenCanvas.width,
                        height: offscreenCanvas.height,
                    });
                };
                reader.readAsDataURL(blob);
            },
            'image/jpeg',
            qualityValue
        );
    });
}

async function captureManualScreenshot(imageQuality = null) {
    console.log('Manual screenshot triggered');
    const quality = imageQuality || currentImageQuality;
    const screenshotMode = localStorage.getItem('screenshotMode') || 'default';
    const app = cheddar.element();
    if (app) {
        app._awaitingNewResponse = true;
        app._currentResponseIsComplete = true;
    }

    const screenshot = await captureScreenshot(quality);
    if (!screenshot?.success) {
        console.error('Manual screenshot failed:', screenshot?.error);
        cheddar.setStatus('Error capturing screenshot');
        return { success: false, error: screenshot?.error || 'Manual screenshot failed' };
    }

    const instruction = `Analyze the screenshot and answer the task shown on the screen.
If the screen shows a coding problem, provide:
- a short approach in a few bullets
- the complete final code
- any important caveats or edge cases if they matter
If the screen shows a multiple-choice question, identify the correct option and briefly explain why.
If the screen shows a math, logic, or theory question, solve it directly and include a short explanation.
Focus on the main visible task and give the exact answer the user needs.`;

    const result = await ipcRenderer.invoke('send-screenshot-prompt', {
        instruction,
        data: screenshot.data,
        mimeType: screenshot.mimeType,
        mode: screenshotMode,
    });

    if (!result.success) {
        console.error('Failed to get screenshot answer:', result.error);
        cheddar.setStatus('Error: ' + result.error);
    }

    return result;
}

async function resetContextAndCapture() {
    console.log('Reset context shortcut triggered');

    const app = cheddar.element();
    const profile = app?.selectedProfile || localStorage.getItem('selectedProfile') || 'interview';
    const language = app?.selectedLanguage || localStorage.getItem('selectedLanguage') || 'en-US';
    const screenshotInterval = 'manual';
    const imageQuality = app?.selectedImageQuality || localStorage.getItem('selectedImageQuality') || 'medium';

    if (app) {
        app.responses = [];
        app.currentResponseIndex = -1;
        app._awaitingNewResponse = true;
        app._currentResponseIsComplete = true;
        if (typeof app.requestUpdate === 'function') {
            app.requestUpdate();
        }
    }

    stopCapture();

    try {
        if (window.require) {
            const { ipcRenderer } = window.require('electron');
            await ipcRenderer.invoke('close-session');
        }

        const initialized = await initializeGemini(profile, language);
        if (!initialized) {
            console.error('Failed to initialize Gemini for new context');
            return { success: false, error: 'Failed to initialize Gemini session' };
        }

        await startCapture(screenshotInterval, imageQuality);

        if (screenshotInterval === 'manual' || screenshotInterval === 'Manual') {
            await captureManualScreenshot(imageQuality);
        }

        return { success: true };
    } catch (error) {
        console.error('Error resetting context:', error);
        return { success: false, error: error.message };
    }
}

// Expose functions to global scope for external access
window.captureManualScreenshot = captureManualScreenshot;
window.resetContextAndCapture = resetContextAndCapture;

function stopCapture() {
    if (screenshotInterval) {
        clearInterval(screenshotInterval);
        screenshotInterval = null;
    }

    if (audioProcessor) {
        audioProcessor.disconnect();
        audioProcessor = null;
    }

    // Clean up microphone audio processor (Linux only)
    if (micAudioProcessor) {
        micAudioProcessor.disconnect();
        micAudioProcessor = null;
    }

    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }

    // Stop macOS audio capture if running
    if (isMacOS) {
        ipcRenderer.invoke('stop-macos-audio').catch(err => {
            console.error('Error stopping macOS audio:', err);
        });
        ipcRenderer.invoke('stop-native-macos-mic-transcription').catch(err => {
            console.error('Error stopping native macOS mic transcription:', err);
        });
    }

    // Clean up hidden elements
    if (hiddenVideo) {
        hiddenVideo.pause();
        hiddenVideo.srcObject = null;
        hiddenVideo = null;
    }
    offscreenCanvas = null;
    offscreenContext = null;
}

// Send text message to Gemini
async function sendTextMessage(text) {
    if (!text || text.trim().length === 0) {
        console.warn('Cannot send empty text message');
        return { success: false, error: 'Empty message' };
    }

    try {
        const result = await ipcRenderer.invoke('send-text-message', text);
        if (result.success) {
            console.log('Text message sent successfully');
        } else {
            console.error('Failed to send text message:', result.error);
        }
        return result;
    } catch (error) {
        console.error('Error sending text message:', error);
        return { success: false, error: error.message };
    }
}

// Conversation storage functions using IndexedDB
let conversationDB = null;

async function initConversationStorage() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('ConversationHistory', 1);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            conversationDB = request.result;
            resolve(conversationDB);
        };

        request.onupgradeneeded = event => {
            const db = event.target.result;

            // Create sessions store
            if (!db.objectStoreNames.contains('sessions')) {
                const sessionStore = db.createObjectStore('sessions', { keyPath: 'sessionId' });
                sessionStore.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
    });
}

async function saveConversationSession(sessionId, conversationHistory) {
    if (!conversationDB) {
        await initConversationStorage();
    }

    const transaction = conversationDB.transaction(['sessions'], 'readwrite');
    const store = transaction.objectStore('sessions');

    const sessionData = {
        sessionId: sessionId,
        timestamp: parseInt(sessionId),
        conversationHistory: conversationHistory,
        lastUpdated: Date.now(),
    };

    return new Promise((resolve, reject) => {
        const request = store.put(sessionData);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

async function getConversationSession(sessionId) {
    if (!conversationDB) {
        await initConversationStorage();
    }

    const transaction = conversationDB.transaction(['sessions'], 'readonly');
    const store = transaction.objectStore('sessions');

    return new Promise((resolve, reject) => {
        const request = store.get(sessionId);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
    });
}

async function getAllConversationSessions() {
    if (!conversationDB) {
        await initConversationStorage();
    }

    const transaction = conversationDB.transaction(['sessions'], 'readonly');
    const store = transaction.objectStore('sessions');
    const index = store.index('timestamp');

    return new Promise((resolve, reject) => {
        const request = index.getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            // Sort by timestamp descending (newest first)
            const sessions = request.result.sort((a, b) => b.timestamp - a.timestamp);
            resolve(sessions);
        };
    });
}

// Listen for conversation data from main process
ipcRenderer.on('save-conversation-turn', async (event, data) => {
    try {
        await saveConversationSession(data.sessionId, data.fullHistory);
        console.log('Conversation session saved:', data.sessionId);
    } catch (error) {
        console.error('Error saving conversation session:', error);
    }
});

// Initialize conversation storage when renderer loads
initConversationStorage().catch(console.error);

// Listen for emergency erase command from main process
ipcRenderer.on('clear-sensitive-data', () => {
    console.log('Clearing renderer-side sensitive data...');
    localStorage.removeItem('apiKey');
    localStorage.removeItem('customPrompt');
    localStorage.removeItem('candidateContext');
    localStorage.removeItem('companyContext');
    localStorage.removeItem('vacancyContext');
    // Consider clearing IndexedDB as well for full erasure
});

// Handle shortcuts based on current view
function handleShortcut(shortcutKey) {
    const currentView = cheddar.getCurrentView();

    if (shortcutKey === 'ctrl+enter' || shortcutKey === 'cmd+enter') {
        if (currentView === 'main') {
            cheddar.element().handleStart();
        } else {
            captureManualScreenshot();
        }
    }
}

// Create reference to the main app element
const cheatingDaddyApp = document.querySelector('cheating-daddy-app');

// Consolidated cheddar object - all functions in one place
const cheddar = {
    // Element access
    element: () => cheatingDaddyApp,
    e: () => cheatingDaddyApp,

    // App state functions - access properties directly from the app element
    getCurrentView: () => cheatingDaddyApp.currentView,
    getLayoutMode: () => cheatingDaddyApp.layoutMode,

    // Status and response functions
    setStatus: text => cheatingDaddyApp.setStatus(text),
    setResponse: response => cheatingDaddyApp.setResponse(response),

    // Core functionality
    initializeGemini,
    buildSessionContext,
    startCapture,
    stopCapture,
    sendTextMessage,
    resetContextAndCapture,
    handleShortcut,

    // Conversation history functions
    getAllConversationSessions,
    getConversationSession,
    initConversationStorage,

    // Content protection function
    getContentProtection: () => {
        const contentProtection = localStorage.getItem('contentProtection');
        return contentProtection !== null ? contentProtection === 'true' : true;
    },

    // Platform detection
    isLinux: isLinux,
    isMacOS: isMacOS,
};

// Make it globally available
window.cheddar = cheddar;
