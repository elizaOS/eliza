package ai.eliza.voicequalify;

import ai.eliza.voice.NativeAsr;
import ai.eliza.voice.ParadeeVoice;
import ai.eliza.voice.VoiceAssets;
import android.content.Context;
import java.io.IOException;

/**
 * The only file here that touches the :paradee-voice API. Opens the packaged
 * voice bundle (Paradee GGUF + misaki lexicon, Phonon-2 GGUF, Silero VAD)
 * and exposes synthesis and transcription for the qualify tests.
 */
final class QualifyVoice implements AutoCloseable {
    static final class Audio {
        final float[] samples;
        final int sampleRate;

        Audio(float[] samples, int sampleRate) {
            this.samples = samples;
            this.sampleRate = sampleRate;
        }

        double seconds() {
            return samples.length / (double) sampleRate;
        }
    }

    final VoiceAssets.Bundle bundle;
    private ParadeeVoice tts;
    private NativeAsr asr;

    private QualifyVoice(VoiceAssets.Bundle bundle) {
        this.bundle = bundle;
    }

    /** Installs the bundle out of the APK assets (worker thread). */
    static QualifyVoice install(Context context) throws IOException {
        return new QualifyVoice(VoiceAssets.install(context));
    }

    synchronized Audio synthesize(String text, float speed) throws IOException {
        if (tts == null) tts = bundle.openVoice();
        ParadeeVoice.Audio audio = tts.synthesize(text, speed);
        return new Audio(audio.samples, audio.sampleRate);
    }

    synchronized String phonemize(String text) throws IOException {
        if (tts == null) tts = bundle.openVoice();
        return tts.phonemize(text);
    }

    /** 16 kHz mono fp32 in; silence behavior is asserted by AsrWerTest. */
    synchronized String transcribe(float[] pcm16k) throws IOException {
        if (asr == null) asr = bundle.openAsr();
        return asr.transcribe(pcm16k);
    }

    @Override
    public synchronized void close() {
        if (tts != null) tts.close();
        if (asr != null) asr.close();
        tts = null;
        asr = null;
    }
}
