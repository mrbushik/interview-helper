const { analyzePcm16, convertStereoToMono, formatSpeakerResults, isTerminalLiveSessionError } = require('../utils/gemini');

describe('formatSpeakerResults', () => {
    it('formats diarization results', () => {
        const results = [
            { transcript: 'hello', speakerId: 1 },
            { transcript: 'hi', speakerId: 2 },
        ];
        const text = formatSpeakerResults(results);
        expect(text).toBe('[Interviewer]: hello\n[Candidate]: hi\n');
    });

    it('mixes both stereo channels instead of dropping the right channel', () => {
        const stereo = Buffer.alloc(8);
        stereo.writeInt16LE(0, 0);
        stereo.writeInt16LE(12000, 2);
        stereo.writeInt16LE(-4000, 4);
        stereo.writeInt16LE(4000, 6);

        const mono = convertStereoToMono(stereo);

        expect(mono.readInt16LE(0)).toBe(6000);
        expect(mono.readInt16LE(2)).toBe(0);
    });

    it('reports PCM signal quality metrics', () => {
        const pcm = Buffer.alloc(6);
        pcm.writeInt16LE(0, 0);
        pcm.writeInt16LE(3000, 2);
        pcm.writeInt16LE(-32768, 4);

        expect(analyzePcm16(pcm)).toEqual({
            samples: 3,
            rms: expect.any(Number),
            peak: 32768,
            clippedSamples: 1,
        });
    });

    it('does not retry unsupported Live model configuration errors', () => {
        expect(
            isTerminalLiveSessionError(
                'The requested combination of response modalities (TEXT) is not supported by the model.'
            )
        ).toBe(true);
        expect(isTerminalLiveSessionError('Temporary server disconnect')).toBe(false);
    });
});
