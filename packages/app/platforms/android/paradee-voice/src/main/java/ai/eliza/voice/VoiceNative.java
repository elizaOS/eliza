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

    static native float[] nativeParadeeSynthesize(long ctx, byte[] utf8Text, float speed);

    static native float[] nativeParadeeSynthesizePhonemes(long ctx, byte[] utf8Phonemes, float speed);

    static native int nativeCancelTts(long ctx);

    static native int nativeAsrSupported();

    static native String nativeAsrTranscribe(long ctx, float[] pcm, int sampleRate);

    static native int nativeAsrCancel(long ctx);

    static native int nativeMmapAcquire(long ctx, String region);

    static native int nativeMmapEvict(long ctx, String region);
}
