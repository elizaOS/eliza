package ai.eliza.kokoro;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * On-device English speech with Kokoro-82M. eSpeak NG makes the phonemes and
 * the Kokoro head in libelizainference makes 24 kHz audio, in this process.
 * There is no agent, inference server, account, or network use.
 *
 * <p>One instance owns one loaded model (about 160 MB resident). Calls are
 * serialized; run them on a worker thread, never on the Android main thread.
 */
public final class KokoroVoice implements AutoCloseable {
    static {
        System.loadLibrary("elizainference");
        System.loadLibrary("kokorovoicejni");
    }

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

    private long handle;
    private final int sampleRate;
    private final boolean phonemizer;

    /**
     * Loads the model.
     *
     * @param model the Kokoro v1.0 GGUF, for example {@code kokoro-82m-v1_0.gguf}
     * @param voice the voice preset, for example {@code af_bella.bin}
     * @param espeakRoot the directory that contains {@code espeak-ng-data}, or
     *     null when the caller supplies phonemes through {@link #synthesizeIpa}
     */
    public KokoroVoice(File model, File voice, File espeakRoot) throws IOException {
        for (File file : new File[] {model, voice}) {
            if (!file.isFile()) throw new IOException("Missing Kokoro file " + file);
        }
        if (espeakRoot != null && !new File(espeakRoot, "espeak-ng-data/en_dict").isFile()) {
            throw new IOException("Missing eSpeak NG English data under " + espeakRoot);
        }
        phonemizer = espeakRoot != null;
        handle = nativeOpen(
                bytes(model.getParentFile().getAbsolutePath()),
                bytes(model.getAbsolutePath()),
                bytes(voice.getAbsolutePath()),
                phonemizer ? bytes(espeakRoot.getAbsolutePath()) : new byte[0]);
        sampleRate = nativeSampleRate(handle);
    }

    public int sampleRate() {
        return sampleRate;
    }

    /** English text to Kokoro phoneme phrases, each short enough for one model pass. */
    public synchronized String[] phonemize(String text) {
        check();
        if (!phonemizer) throw new IllegalStateException("Opened without eSpeak NG data; use synthesizeIpa");
        return nativePhonemize(bytes(text));
    }

    /** Speaks English text. {@code speed} 1.0 is the model's own rate. */
    public synchronized Audio synthesize(String text, float speed) {
        String[] phrases = phonemize(text);
        float[][] parts = new float[phrases.length][];
        int total = 0;
        for (int i = 0; i < phrases.length; i++) {
            parts[i] = nativeSynthesizeIpa(handle, bytes(phrases[i]), speed);
            total = Math.addExact(total, parts[i].length);
        }
        float[] out = new float[total];
        int offset = 0;
        for (float[] part : parts) {
            System.arraycopy(part, 0, out, offset, part.length);
            offset += part.length;
        }
        return new Audio(out, sampleRate);
    }

    /** Speaks one phrase that is already in Kokoro phoneme symbols. */
    public synchronized Audio synthesizeIpa(String ipa, float speed) {
        check();
        return new Audio(nativeSynthesizeIpa(handle, bytes(ipa), speed), sampleRate);
    }

    @Override
    public synchronized void close() {
        if (handle != 0) {
            nativeClose(handle);
            handle = 0;
        }
    }

    private void check() {
        if (handle == 0) throw new IllegalStateException("Kokoro voice closed");
    }

    private static byte[] bytes(String value) {
        if (value == null) throw new IllegalArgumentException("Expected text");
        return value.getBytes(StandardCharsets.UTF_8);
    }

    private static native long nativeOpen(byte[] modelDir, byte[] model, byte[] voice, byte[] espeakRoot)
            throws IOException;

    private static native void nativeClose(long handle);

    private static native int nativeSampleRate(long handle);

    private static native String[] nativePhonemize(byte[] text);

    private static native float[] nativeSynthesizeIpa(long handle, byte[] ipa, float speed);
}
