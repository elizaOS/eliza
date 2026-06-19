package ai.elizaos.app;

import android.util.Log;

/**
 * Phase 3a JNI loader for the fused fork voice runtime.
 *
 * <p>Loads the NDK/bionic-built {@code libelizainference.so} (the omnivoice
 * {@code elizainference} target — VAD, wake-word, speaker, diarizer fused at
 * ABI v7) IN the {@code ai.elizaos.app} APK process via
 * {@link System#loadLibrary}, then through {@code libelizavoicejni.so} exposes
 * a couple of native methods that call {@code eliza_inference_*} directly.
 *
 * <p>This is the bionic, in-process path that replaces the musl bun-agent for
 * the voice runtimes. The text musl stack (libeliza_bun / musl ld) is
 * untouched; this class only proves the fused voice .so loads + a voice op runs
 * in the app process. Phase 3b wires the full pipeline.
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
     *
     * @return true if both libraries loaded.
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

    /** {@code eliza_inference_abi_version()} — expect "7". */
    static native String nativeVoiceAbiVersion();

    /** {@code eliza_inference_vad_supported()} — 1 when the native VAD backend is present. */
    static native int nativeVadSupported();

    /**
     * Run the open/process/close VAD path against a bundle on disk and return a
     * JSON status string ({@code {"ok":...,"probability":...,"abi":"7",...}}).
     */
    static native String nativeVadSelfTest(String bundleDir);
}
