package ai.eliza.voice;

/**
 * Voice natives of {@code libparadeevoicejni.so}. That library is the shared
 * {@code elizavoice-jni.cpp} bridge built with
 * {@code ELIZA_VOICE_JNI_CLASS=ai/eliza/voice/VoiceNative} and
 * {@code ELIZA_VOICE_JNI_SUBSET=voice}; its JNI_OnLoad binds exactly these
 * methods and fails the load if one is missing. Handles are native context
 * pointers. Text crosses as standard UTF-8 byte arrays.
 */
final class VoiceNative {
    static {
        // Phonon-2 runs on the in-tree ggml path. "parakeet" is a model
        // architecture, not a registered backend override. The installed
        // bundle pins and verifies the only permitted ASR model.
        try {
            android.system.Os.setenv("ELIZA_ASR_BACKEND", "ggml", true);
        } catch (android.system.ErrnoException unset) {
            throw new IllegalStateException("Cannot configure the Phonon-2 ASR backend", unset);
        }
        System.loadLibrary("elizainference");
        System.loadLibrary("paradeevoicejni");
    }

    private VoiceNative() {}

    static native String nativeVoiceAbiVersion();

    static native long nativeContextCreate(String bundleDir);

    static native void nativeContextDestroy(long ctx);

    static native int nativeParadeeSupported();

    static native int nativeParadeeLoad(long ctx, String gguf, String lexicon, String espeakDirOrNull);

    static native int nativeParadeeSampleRate(long ctx);

    static native int nativeParadeeG2pKind(long ctx);

    static native String nativeParadeePhonemize(long ctx, byte[] utf8Text);

    static native int nativeParadeeStreamSupported();

    static native void nativeParadeeSynthesizeStream(long ctx, byte[] utf8Text, float speed, Object sink);

    static native float[] nativeParadeeSynthesize(long ctx, byte[] utf8Text, float speed);

    static native float[] nativeParadeeSynthesizePhonemes(long ctx, byte[] utf8Phonemes, float speed);

    static native int nativeCancelTts(long ctx);

    static native int nativeAsrSupported();

    static native String nativeAsrTranscribe(long ctx, float[] pcm, int sampleRate);

    static native int nativeAsrCancel(long ctx);

    static native int nativeAsrStreamSupported();

    static native long nativeAsrStreamOpen(long ctx, int sampleRate);

    static native int nativeAsrStreamFeed(long stream, float[] pcm);

    static native String nativeAsrStreamPartial(long stream);

    static native String nativeAsrStreamFinish(long stream);

    static native int nativeAsrStreamCancel(long stream);

    static native void nativeAsrStreamClose(long stream);

    static native int nativeMmapAcquire(long ctx, String region);

    static native int nativeMmapEvict(long ctx, String region);
}
