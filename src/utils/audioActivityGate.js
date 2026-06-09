function calculateFloat32Rms(samples) {
    if (!samples || samples.length === 0) {
        return 0;
    }

    let squareSum = 0;
    for (const sample of samples) {
        squareSum += sample * sample;
    }
    return Math.sqrt(squareSum / samples.length);
}

function calculatePcm16Rms(buffer) {
    if (!buffer || buffer.length < 2) {
        return 0;
    }

    const sampleCount = Math.floor(buffer.length / 2);
    let squareSum = 0;
    for (let index = 0; index < sampleCount; index++) {
        const normalizedSample = buffer.readInt16LE(index * 2) / 32768;
        squareSum += normalizedSample * normalizedSample;
    }
    return Math.sqrt(squareSum / sampleCount);
}

function createAudioActivityGate({ calculateRms, threshold = 0.004, preRollChunks = 3, hangoverChunks = 20 } = {}) {
    if (typeof calculateRms !== 'function') {
        throw new TypeError('calculateRms must be a function');
    }

    let preRoll = [];
    let remainingHangoverChunks = 0;

    return {
        push(chunk) {
            const active = calculateRms(chunk) >= threshold;
            if (active) {
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

        reset() {
            preRoll = [];
            remainingHangoverChunks = 0;
        },
    };
}

function createFloat32AudioActivityGate(options = {}) {
    return createAudioActivityGate({
        calculateRms: calculateFloat32Rms,
        ...options,
    });
}

function createPcm16AudioActivityGate(options = {}) {
    return createAudioActivityGate({
        calculateRms: calculatePcm16Rms,
        ...options,
    });
}

module.exports = {
    calculateFloat32Rms,
    calculatePcm16Rms,
    createAudioActivityGate,
    createFloat32AudioActivityGate,
    createPcm16AudioActivityGate,
};
