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

    /** Read the segmented fp32 PCM for the i-th turn of the last call. */
    static native float[] nativePipelineTurnPcm(long handle, int index);

    static native void nativePipelineReset(long handle);

    static native void nativePipelineClose(long handle);

    // ── Self-tests (single native call; evidence via logcat) ─────────────

    static native String nativeVadSelfTest(String bundleDir);

    /** Open wake-word + score a positive and a negative clip; logs both maxP. */
    static native String nativeWakewordSelfTest(String bundleDir, float[] pos, float[] neg);

    /** Run the whole pipeline (ctx→open→feed→flush) on one PCM buffer in one call. */
    static native String nativePipelineSelfTest(String bundleDir, float[] pcm, int feedSamples);

    // ── Text generation (LLM) — the GPU-accelerated text path ────────────
    //
    // When this host is built against the dynamic-Vulkan libelizainference
    // (libggml-vulkan.so staged alongside), llm_stream_open offloads the model
    // to the GPU in the bionic app process — the path the musl bun agent can't
    // take. nGpuLayers=-1 means all-GPU (default); the CPU/GPU choice is the
    // staged LIB variant, not this flag.

    /** {@code eliza_inference_llm_stream_supported()}. */
    static native int nativeLlmStreamSupported();

    /** {@code eliza_inference_embed_supported()}. */
    static native int nativeEmbedSupported();

    /** {@code eliza_inference_llm_eot_supported()} (ABI v11). */
    static native int nativeEotSupported();

    /** Tokenize text → int[] token ids. */
    static native int[] nativeTokenize(long ctxHandle, String text, boolean addSpecial, boolean parseSpecial);

    /** Pooled (MEAN) L2-normalized sentence embedding → float[n_embd]. */
    static native float[] nativeEmbed(long ctxHandle, String text, int pooling);

    /** End-of-turn score: next-token P(targetToken | tokens). */
    static native float nativeEotScore(long ctxHandle, int[] tokens, int targetToken);

    /** Open a streaming-LLM session (nGpuLayers=-1 all-GPU; drafterPath ""=none). */
    static native long nativeLlmStreamOpen(long ctxHandle, int maxTokens, float temperature, float topP, int topK, int nGpuLayers, String drafterPath);

    /** Feed pre-tokenized prompt tokens into the session KV before the first next(). */
    static native void nativeLlmStreamPrefill(long streamHandle, int[] tokens);

    /**
     * Pull the next decode step → JSON {text, done, nout, drafted, accepted}.
     * {@code maxStepTokens} bounds how many tokens this ONE native call may
     * decode (clamped to [1, 256] — the JNI-side token buffer). The native
     * decode loop stops at that budget, at EOS/EOG, and at the stream-level
     * {@code max_tokens} — so a caller enforcing a per-turn cap passes
     * {@code min(step, cap - produced)} and never pays over-cap eval work
     * (issue #11913: the old no-arg form always decoded the full 256-token
     * buffer in one call, so maxTokens never engaged and TTFT equaled
     * full-turn latency).
     */
    static native String nativeLlmStreamNext(long streamHandle, int maxStepTokens);

    static native void nativeLlmStreamClose(long streamHandle);

    /** Reset a persistent stream (clear KV + sampler) for warm reuse. 1=ok, 0=no. */
    static native int nativeLlmStreamReset(long streamHandle);

    /**
     * Prefix-preserving reset: keep the first {@code nKeep} tokens of KV cache
     * resident and drop the rest, so the next prefill only decodes the per-turn
     * delta. Returns the n_keep actually applied ({@code >= 0}), or a negative
     * code on a null/MTP/unopened stream (caller falls back to a full reset).
     */
    static native int nativeLlmStreamResetKeep(long streamHandle, int nKeep);

    /**
     * KEYSTONE proof: run a whole greedy text generation in one native call,
     * in the bionic app process. With the dynamic-Vulkan lib staged, ggml-vulkan
     * logs the Mali device + layer offload to logcat. Returns JSON
     * {ok, text, tokens, ms, tokS}.
     */
    static native String nativeLlmSelfTest(String bundleDir, String prompt, int maxTokens);

    /** Kokoro-82M model native sample rate (24000 for v1.0), or -1 if not loaded. */
    static native int nativeKokoroSampleRate(long ctxHandle);

    /**
     * Synthesize {@code text} with the fused Kokoro-82M head (ABI v10), loading
     * the GGUF + voice preset on first use. Returns 24 kHz fp32 PCM. This is the
     * on-device voice the Android app speaks with — TalkMode delegates here (via
     * the bionic inference host) instead of falling back to the platform TTS.
     */
    static native float[] nativeKokoroSynthesize(
            long ctxHandle, String ggufPath, String voiceBinPath, String text, float speed);

    // ── Batch ASR + mmproj vision (the agent's STT / screen-recognition path) ──

    /**
     * Transcribe {@code pcm} (16 kHz mono fp32) → UTF-8 transcript via the fused
     * local ASR head ({@code eliza_inference_asr_transcribe}). VAD-free: the
     * resident context mmap-acquires the {@code asr/} weights on first use. The
     * bionic host's op="asr" calls this so the agent TRANSCRIPTION delegate gets
     * a real on-device transcript without the full attribution pipeline.
     */
    static native String nativeAsrTranscribe(long ctxHandle, float[] pcm, int sampleRate);

    /** {@code eliza_inference_vision_supported()} (ABI v9): 1 if mmproj vision is built. */
    static native int nativeVisionSupported();

    /**
     * Describe a raw PNG/JPEG/WebP image with the resident TEXT model + the
     * mmproj projector at {@code mmprojPath} ({@code eliza_inference_describe_image}).
     * {@code prompt} may be empty (a default describe prompt is used). The bionic
     * host's op="image" calls this so the agent IMAGE_DESCRIPTION delegate runs
     * screen/vision recognition fully on-device.
     */
    static native String nativeDescribeImage(
            long ctxHandle, byte[] imageBytes, String mmprojPath, String prompt);
}
