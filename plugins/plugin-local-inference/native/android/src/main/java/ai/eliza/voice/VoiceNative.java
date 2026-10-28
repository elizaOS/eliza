package ai.eliza.voice;

/**
 * Fused inference natives of {@code libparadeevoicejni.so}. That library is the shared
 * {@code elizavoice-jni.cpp} bridge built with
 * {@code ELIZA_VOICE_JNI_CLASS=ai/eliza/voice/VoiceNative} and
 * {@code ELIZA_VOICE_JNI_SUBSET=full}; its JNI_OnLoad binds exactly these
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

    // Full inference ABI shared with the application host.
    static native int nativeVadSupported();

    static native int nativeWakewordSupported();

    static native int nativeSpeakerSupported();

    static native int nativeDiarizSupported();

    static native long nativeVadOpen(long ctxHandle);

    static native float[] nativeVadProcessBatch(long vadHandle, float[] pcm);

    static native void nativeVadReset(long vadHandle);

    static native void nativeVadClose(long vadHandle);

    static native long nativeWakewordOpen(long ctxHandle, String headName);

    static native float[] nativeWakewordScoreBatch(long wakeHandle, float[] pcm);

    static native void nativeWakewordReset(long wakeHandle);

    static native void nativeWakewordClose(long wakeHandle);

    static native long nativeSpeakerOpen(long ctxHandle, String ggufPath);

    static native float[] nativeSpeakerEmbed(long speakerHandle, float[] pcm);

    static native void nativeSpeakerClose(long speakerHandle);

    static native long nativeDiarizOpen(long ctxHandle, String ggufPath);

    static native byte[] nativeDiarizSegment(long diarizHandle, float[] pcm);

    static native void nativeDiarizClose(long diarizHandle);

    static native long nativePipelineOpen(long ctxHandle);

    static native String nativePipelineProcess(long handle, float[] pcm);

    static native String nativePipelineFlush(long handle);

    static native float[] nativePipelineTurnEmbedding(long handle, int index);

    static native byte[] nativePipelineTurnLabels(long handle, int index);

    static native float[] nativePipelineTurnPcm(long handle, int index);

    static native void nativePipelineReset(long handle);

    static native void nativePipelineClose(long handle);

    static native String nativeVadSelfTest(String bundleDir);

    static native String nativeWakewordSelfTest(String bundleDir, float[] pos, float[] neg);

    static native String nativePipelineSelfTest(String bundleDir, float[] pcm, int feedSamples);

    static native int nativeLlmStreamSupported();

    static native int nativeEmbedSupported();

    static native int nativeEotSupported();

    static native int[] nativeTokenize(long ctxHandle, String text, boolean addSpecial, boolean parseSpecial);

    static native float[] nativeEmbed(long ctxHandle, String text, int pooling);

    static native long nativeContextCreateUtf8(byte[] bundlePath);

    static native int[] nativeTokenizeUtf8(long ctxHandle, byte[] text);

    static native float[] nativeEmbedUtf8(long ctxHandle, byte[] text, int pooling);

    static native int[] nativeTokenizeWithOptionsUtf8(long ctxHandle, byte[] text, boolean parseSpecial);

    static native float[] nativeEmbedWithOptionsUtf8(long ctxHandle, byte[] text, int pooling, boolean parseSpecial);

    static native float nativeEotScore(long ctxHandle, int[] tokens, int targetToken);

    static native long nativeLlmStreamOpen(long ctxHandle, int maxTokens, float temperature, float topP, int topK, int nGpuLayers, String drafterPath);

    static native void nativeLlmStreamPrefill(long streamHandle, int[] tokens);

    static native String nativeLlmStreamNext(long streamHandle, int maxStepTokens);

    static native void nativeLlmStreamClose(long streamHandle);

    static native int nativeLlmStreamReset(long streamHandle);

    static native int nativeLlmStreamResetKeep(long streamHandle, int nKeep);

    static native String nativeLlmSelfTest(String bundleDir, String prompt, int maxTokens);

    static native int nativeVisionSupported();

    static native String nativeDescribeImage(
            long ctxHandle, byte[] imageBytes, String mmprojPath, String prompt);
}
