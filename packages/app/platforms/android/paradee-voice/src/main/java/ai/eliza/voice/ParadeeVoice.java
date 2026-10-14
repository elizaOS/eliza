package ai.eliza.voice;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * On-device English speech with Paradee-8M v1.0 (one voice, af_heart) in
 * {@code libelizainference}. Native misaki G2P turns text into phonemes; long
 * text is split into model-sized chunks natively. 24 kHz audio, in this
 * process, with no agent, server, account or network use.
 *
 * <p>One instance owns one loaded model (about 40 MB resident). Synthesis
 * calls are serialized; run them on a worker thread, never on the Android
 * main thread. {@link #cancel} may be called from any thread and makes the
 * running call throw {@link java.util.concurrent.CancellationException}.
 */
public final class ParadeeVoice implements AutoCloseable {
    /** {@link #g2pKind}: the lexicon has no fallback for unknown words. */
    public static final int G2P_LEXICON_ONLY = 0;
    /** {@link #g2pKind}: unknown words use native letter-to-sound rules. */
    public static final int G2P_RULES = 1;
    /** {@link #g2pKind}: unknown words use eSpeak NG, converted to misaki spelling. */
    public static final int G2P_ESPEAK = 2;

    /** Model output: mono float PCM in [-1, 1] at {@link #sampleRate}. */
    public static final class Audio {
        public final float[] samples;
        public final int sampleRate;

        Audio(float[] samples, int sampleRate) {
            this.samples = samples;
            this.sampleRate = sampleRate;
        }

        public double seconds() {
            return samples.length / (double) sampleRate;
        }
    }

    /** Guards the context pointer so cancel never signals a freed context. */
    private final Object handleLock = new Object();
    private long handle;
    private final int sampleRate;
    private final int g2pKind;

    /**
     * Loads the model.
     *
     * @param model the Paradee GGUF, for example {@code paradee-8m-v1_0.gguf}
     * @param lexicon the misaki lexicon, {@code misaki-en-us.lex}
     * @param espeakDir the directory that contains {@code espeak-ng-data}, or
     *     null to keep G2P to the lexicon and its rules
     */
    public ParadeeVoice(File model, File lexicon, File espeakDir) throws IOException {
        for (File file : new File[] {model, lexicon}) {
            if (!file.isFile()) throw new IOException("Missing Paradee file " + file);
        }
        if (espeakDir != null && !new File(espeakDir, "espeak-ng-data/en_dict").isFile()) {
            throw new IOException("Missing eSpeak NG English data under " + espeakDir);
        }
        if (VoiceNative.nativeParadeeSupported() != 1) {
            throw new IllegalStateException("libelizainference was built without Paradee (LLAMA_BUILD_PARADEE=OFF)");
        }
        long ctx = VoiceNative.nativeContextCreate(model.getParentFile().getAbsolutePath());
        try {
            VoiceNative.nativeParadeeLoad(ctx, model.getAbsolutePath(), lexicon.getAbsolutePath(),
                    espeakDir == null ? null : espeakDir.getAbsolutePath());
            sampleRate = VoiceNative.nativeParadeeSampleRate(ctx);
            g2pKind = VoiceNative.nativeParadeeG2pKind(ctx);
        } catch (RuntimeException error) {
            VoiceNative.nativeContextDestroy(ctx);
            throw new IOException("Paradee model load failed", error);
        }
        handle = ctx;
    }

    public int sampleRate() {
        return sampleRate;
    }

    /** One of {@link #G2P_LEXICON_ONLY}, {@link #G2P_RULES}, {@link #G2P_ESPEAK}. */
    public int g2pKind() {
        return g2pKind;
    }

    /** English text to misaki phonemes, the model's input spelling. */
    public synchronized String phonemize(String text) {
        return VoiceNative.nativeParadeePhonemize(check(), bytes(text));
    }

    /** Speaks English text. {@code speed} 1.0 is the model's own rate. */
    public synchronized Audio synthesize(String text, float speed) {
        return new Audio(VoiceNative.nativeParadeeSynthesize(check(), bytes(text), speed), sampleRate);
    }

    /** Speaks text that is already in misaki phonemes. */
    public synchronized Audio synthesizePhonemes(String phonemes, float speed) {
        return new Audio(VoiceNative.nativeParadeeSynthesizePhonemes(check(), bytes(phonemes), speed), sampleRate);
    }

    /** Stops the running synthesis, if any. Safe from any thread. */
    public void cancel() {
        synchronized (handleLock) {
            if (handle != 0) VoiceNative.nativeCancelTts(handle);
        }
    }

    /** Frees the model weights and keeps the instance; the next call reloads them. */
    public synchronized void trimMemory() {
        VoiceNative.nativeMmapEvict(check(), "tts");
    }

    @Override
    public void close() {
        cancel();
        synchronized (this) {
            synchronized (handleLock) {
                if (handle != 0) {
                    VoiceNative.nativeContextDestroy(handle);
                    handle = 0;
                }
            }
        }
    }

    private long check() {
        synchronized (handleLock) {
            if (handle == 0) throw new IllegalStateException("Paradee voice closed");
            return handle;
        }
    }

    private static byte[] bytes(String value) {
        if (value == null) throw new IllegalArgumentException("Expected text");
        return value.getBytes(StandardCharsets.UTF_8);
    }
}
