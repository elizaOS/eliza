package ai.elizaos.app;

import android.util.Log;

/**
 * JNI loader + native-method surface for the fused fork voice runtime.
 *
 * <p>Loads the NDK/bionic-built {@code libelizainference.so} (the omnivoice
 * {@code elizainference} target — VAD, wake-word, speaker, diarizer fused at
 * ABI v7) IN the {@code ai.elizaos.app} APK process via
 * {@link System#loadLibrary}, then through {@code libelizavoicejni.so} exposes
 * the full fused voice ABI directly (no separate musl bun agent transport).
 *
 * <p>The text musl stack (libeliza_bun / musl ld) is untouched; this class is
 * the bionic, in-process path for the FOUR voice classifiers. Handles are raw
 * native pointers returned as {@code long}; the Java side keeps them opaque and
 * passes them back through {@code close()} for cleanup.
 */
final class ElizaVoiceNative {

    private static final String TAG = "ElizaVoiceNative";

    private static volatile boolean loaded = false;
    private static volatile String loadError = null;

    private ElizaVoiceNative() {}

    /**
     * Load the fused voice library + the JNI shim. The fused .so is statically
     * linked (ggml/llama/mtmd folded in) so it has no external NEEDED deps
     * beyond bionic libc/libm/libdl — load order is just: the engine, then the
     * shim that links it.
     */
    static synchronized boolean ensureLoaded() {
        if (loaded) {
            return true;
        }
        try {
            System.loadLibrary("elizainference");
            Log.i(TAG, "Loaded fused voice engine: libelizainference.so");
            System.loadLibrary("elizavoicejni");
            Log.i(TAG, "Loaded JNI bridge: libelizavoicejni.so");
            loaded = true;
            loadError = null;
        } catch (UnsatisfiedLinkError e) {
            loadError = e.getMessage();
            Log.e(TAG, "Failed to load fused voice native libraries", e);
            loaded = false;
        }
        return loaded;
    }

    static boolean isLoaded() {
        return loaded;
    }

    static String getLoadError() {
        return loadError;
    }

    // ── ABI / capability probes ──────────────────────────────────────────

    /** {@code eliza_inference_abi_version()} — expect "7". */
    static native String nativeVoiceAbiVersion();

    /** {@code eliza_inference_vad_supported()}. */
    static native int nativeVadSupported();

    /** {@code eliza_inference_wakeword_supported()}. */
    static native int nativeWakewordSupported();

    /** {@code eliza_inference_speaker_supported()}. */
    static native int nativeSpeakerSupported();

    /** {@code eliza_inference_diariz_supported()}. */
    static native int nativeDiarizSupported();

    // ── Context lifecycle ────────────────────────────────────────────────

    /** {@code eliza_inference_create(bundleDir)} — returns an opaque context handle. */
    static native long nativeContextCreate(String bundleDir);

    /** {@code eliza_inference_destroy(ctx)}. Idempotent on 0. */
    static native void nativeContextDestroy(long ctxHandle);

    // ── VAD ──────────────────────────────────────────────────────────────

    static native long nativeVadOpen(long ctxHandle);

    /** Process all 512-sample windows in {@code pcm}; returns per-window P(speech). */
    static native float[] nativeVadProcessBatch(long vadHandle, float[] pcm);

    static native void nativeVadReset(long vadHandle);

    static native void nativeVadClose(long vadHandle);

    // ── Wake-word ────────────────────────────────────────────────────────

    static native long nativeWakewordOpen(long ctxHandle, String headName);

    /** Score all 1280-sample frames in {@code pcm}; returns per-frame P(wake). */
    static native float[] nativeWakewordScoreBatch(long wakeHandle, float[] pcm);

    static native void nativeWakewordReset(long wakeHandle);

    static native void nativeWakewordClose(long wakeHandle);

    // ── Speaker encoder ──────────────────────────────────────────────────

    static native long nativeSpeakerOpen(long ctxHandle, String ggufPath);

    /** Embed {@code pcm} → 256-float L2-normalized speaker embedding. */
    static native float[] nativeSpeakerEmbed(long speakerHandle, float[] pcm);

    static native void nativeSpeakerClose(long speakerHandle);

    // ── Diarizer ─────────────────────────────────────────────────────────

    static native long nativeDiarizOpen(long ctxHandle, String ggufPath);

    /** Segment a 5 s window → per-frame int8 powerset labels. */
    static native byte[] nativeDiarizSegment(long diarizHandle, float[] pcm);

    static native void nativeDiarizClose(long diarizHandle);

    // ── Streaming pipeline (native hot-loop owner) ───────────────────────

    /** Open a pipeline session (VAD + speaker + diariz) on a context. */
    static native long nativePipelineOpen(long ctxHandle);

    /**
     * Feed one audio-frame batch (16 kHz mono fp32). Runs VAD streaming +
     * turn segmentation natively; on speech-end runs speaker + diariz. Returns
     * a JSON array of turns completed in THIS call.
     */
    static native String nativePipelineProcess(long handle, float[] pcm);

    /** Force-finalize any open turn; returns the JSON array of flushed turns. */
    static native String nativePipelineFlush(long handle);

    /** Read the 256-float speaker embedding for the i-th turn of the last call. */
    static native float[] nativePipelineTurnEmbedding(long handle, int index);

    /** Read the diariz int8 frame labels for the i-th turn of the last call. */
    static native byte[] nativePipelineTurnLabels(long handle, int index);

    static native void nativePipelineReset(long handle);

    static native void nativePipelineClose(long handle);

    // ── Self-tests (single native call; evidence via logcat) ─────────────

    static native String nativeVadSelfTest(String bundleDir);

    /** Open wake-word + score a positive and a negative clip; logs both maxP. */
    static native String nativeWakewordSelfTest(String bundleDir, float[] pos, float[] neg);

    /** Run the whole pipeline (ctx→open→feed→flush) on one PCM buffer in one call. */
    static native String nativePipelineSelfTest(String bundleDir, float[] pcm, int feedSamples);
}
