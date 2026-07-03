package ai.elizaos.app;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.system.Os;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * In-process bionic GPU inference server.
 *
 * <p>The embedded musl bun agent cannot load the bionic Android Vulkan driver
 * (its restricted linker namespace can't satisfy libvulkan's HIDL/HAL closure —
 * see {@code project_android_gpu_vulkan_wall}). This server runs in the normal
 * {@code ai.elizaos.app} (bionic) process, where {@link ElizaVoiceNative} has
 * already loaded {@code libelizainference.so} + {@code libggml-vulkan.so} and
 * can offload the model to the Mali GPU. The musl agent delegates text
 * generation here over an abstract-namespace {@code AF_UNIX} socket; the agent
 * side is {@code plugins/plugin-local-inference/src/services/bionic-host-loader.ts}.
 *
 * <p>Wire protocol (length-prefixed frames, both directions):
 * <pre>
 *   [int32 big-endian byte length N][N bytes UTF-8 JSON]
 * </pre>
 * Request JSON: {@code {op:"generate", bundleDir, prompt, maxTokens}}.
 * Response JSON: {@code {ok, text?, error?, tokens?, ms?, tokS?}} — for the
 * buffered first slice this is exactly the JSON {@link ElizaVoiceNative#nativeLlmSelfTest}
 * already returns, so the GPU decode loop runs entirely server-side and the
 * musl agent never round-trips per token.
 *
 * <p>This is the buffered first slice. Server-push per-step streaming, embed,
 * and cancel are layered on later (the framing already supports an {@code op}
 * discriminator).
 */
final class ElizaBionicInferenceServer {

    private static final String TAG = "ElizaBionicInfer";
    /** Hard cap on a single request frame (1 MiB) — prompts, not payloads. */
    private static final int MAX_FRAME_BYTES = 1 << 20;

    /**
     * Poll-based memory-pressure probe supplied by the owning service
     * ({@link ElizaAgentService} backs it with {@code ActivityManager.getMemoryInfo()}
     * + {@link InferenceMemoryPolicy#shouldReleaseOnAvailMem}). Kept as an
     * interface so this server has no Context dependency.
     */
    interface MemoryPressureProbe {
        /** True when the resident inference state should be released right now. */
        boolean shouldRelease();

        /** Human-readable snapshot for the release log line. */
        String describe();
    }

    /** Cadence of the idle/pressure policy tick (#11760). */
    private static final long MEMORY_POLICY_TICK_MS = 30_000L;

    private final String socketName;
    private final String defaultBundleDir;
    private final InferenceMemoryPolicy.RamClass ramClass;
    /** Idle-unload timeout; {@code 0} disables the idle lever (#11760). */
    private final long idleUnloadMs;
    private final MemoryPressureProbe pressureProbe;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile LocalServerSocket serverSocket;
    private volatile Thread acceptThread;
    private volatile ScheduledExecutorService memoryPolicyExecutor;

    // Resident inference state: the model + context + stream stay loaded across
    // turns (no per-call reload). KV + sampler are reset each turn. Guarded by
    // residentLock so the per-connection workers serialize (one decode at a time).
    private long residentCtx = 0L;
    private long residentStream = 0L;
    private String residentBundle = null;
    private String residentDrafterPath = "";
    /** The previous turn's prompt tokens — used to find the longest common prefix
     *  with the next turn's prompt so its KV can be reused (only the delta is
     *  re-prefilled). null when the stream has no reusable KV (first turn / after
     *  a reset/reopen). */
    private int[] residentPrevTokens = null;
    private final Object residentLock = new Object();
    /** Hard decode ceiling for the resident stream (per-call cap is applied below). */
    private static final int RESIDENT_STREAM_MAX_TOKENS = 2048;
    /**
     * Lock-free mirror of {@code residentCtx != 0} so the policy tick can guard
     * without contending with an in-flight decode (which holds residentLock for
     * the whole turn). Written only inside residentLock.
     */
    private volatile boolean residentActive = false;
    /** elapsedRealtime of the last completed inference op — drives idle unload. */
    private volatile long lastInferenceAtMs = android.os.SystemClock.elapsedRealtime();

    ElizaBionicInferenceServer(
            String socketName,
            String defaultBundleDir,
            InferenceMemoryPolicy.RamClass ramClass,
            long idleUnloadMs,
            MemoryPressureProbe pressureProbe) {
        this.socketName = socketName;
        this.defaultBundleDir = defaultBundleDir;
        this.ramClass = ramClass;
        this.idleUnloadMs = idleUnloadMs;
        this.pressureProbe = pressureProbe;
    }

    /** Bind the abstract-namespace socket and start accepting. Idempotent. */
    /**
     * The bionic host runs the LLM in THIS (app) process via JNI, so the fused
     * native lib reads its tuning from the app-process environment — NOT the bun
     * agent subprocess env (which only carries the ELIZA_LLAMA_* names). On
     * Mali-class 8 GB phones the 2B's non-flash-attn compute + logits buffers at
     * the upstream n_batch=512 default push peak RSS past what the device can
     * allocate ("llm_stream_open: failed to init llama context"). FA is disabled
     * on Android (the scalar-FA race), so the non-FA attention buffer is the
     * dominant cost and it scales with n_batch; capping n_batch shrinks both that
     * and the n_vocab×n_batch logits buffer ~4x, which is what lets the context
     * fit. n_ctx is left at the model-capped default (KV is only ~0.4 GB at 8k).
     * Only sets a value when it is not already present, so any explicit override
     * still wins.
     */
    private void applyBionicInferenceMemoryDefaults() {
        setEnvIfAbsent("ELIZA_LLM_N_BATCH", "128");
        // n_ctx by device RAM class (#11760): the resident stream's KV cache +
        // non-FA compute buffers scale with n_ctx, and on a 5.7 GB-class device
        // the pinned footprint at 8192 makes the app lmkd's first target. 4096
        // halves the persistent KV (f16 2B: ~0.4 GB → ~0.2 GB) on CONSTRAINED
        // devices; STANDARD keeps 8192.
        setEnvIfAbsent(
            "ELIZA_LLM_N_CTX",
            String.valueOf(InferenceMemoryPolicy.llmContextTokens(ramClass)));
        // The JNI bridge can default the KV cache to a fused QJL/TBQ quant
        // (cache_type_k="qjl1_256"), but that path is a head_dim=128 sketch and
        // is RETIRED for the shipped tiers (elizaOS/eliza#8848 / #9033 Gemma-4
        // cutover): eliza-1 now ships Gemma-4-arch GGUFs whose KV is already
        // minimal (MQA + windowed SWA + shared-KV; dual head dims 512 global /
        // 256 SWA) and which run on stock f16/q8_0 KV. The head_dim=128 QJL/TBQ
        // kernels are dimensionally inapplicable to Gemma, so keep KV quant OFF
        // (stock f16, only ~0.4 GB at 8k ctx for the 2B). This is the intended
        // Gemma KV path, not a fallback.
        setEnvIfAbsent("ELIZA_BIONIC_KV_QUANT", "0");
        // Allow MTP speculative decode when a Gemma-4 SEPARATE drafter
        // (mtp/drafter-<tier>.gguf, loaded via "-md … --spec-type draft-mtp") —
        // NOT a same-file NextN head embedded in the text GGUF; the JNI threads
        // cfg.mtp_drafter_path when the TS bridge has staged one. MTP stays
        // dormant when no drafter path is supplied; the retired same-file path
        // is intentionally not used for Gemma bundles. The resident path uses
        // MTP + full reset;
        // prefix-KV reuse via reset_keep (resetAndPrefillResident →
        // nativeLlmStreamResetKeep) stays wired for caches that support bounded
        // partial removal (llama_memory_seq_rm).
        setEnvIfAbsent("ELIZA_BIONIC_MTP", "1");
    }

    private static void setEnvIfAbsent(String key, String value) {
        try {
            if (System.getenv(key) == null) {
                Os.setenv(key, value, true);
                Log.i(TAG, "set " + key + "=" + value + " for in-process bionic inference");
            }
        } catch (Throwable t) {
            Log.w(TAG, "could not set " + key, t);
        }
    }

    synchronized void start() {
        if (running.get()) {
            return;
        }
        applyBionicInferenceMemoryDefaults();
        // Load the fused native engine up front so the first request doesn't pay
        // the dlopen + Vulkan-device init; also fail fast + loud if the GPU host
        // isn't actually usable, so the agent's refuse-and-fallback can engage.
        if (!ElizaVoiceNative.ensureLoaded()) {
            Log.e(TAG, "fused native engine failed to load; bionic inference host NOT started: "
                + ElizaVoiceNative.getLoadError());
            return;
        }
        try {
            serverSocket = new LocalServerSocket(socketName);
        } catch (IOException e) {
            Log.e(TAG, "failed to bind abstract UDS \"" + socketName + "\"", e);
            return;
        }
        running.set(true);
        acceptThread = new Thread(this::acceptLoop, "eliza-bionic-infer-accept");
        acceptThread.setDaemon(true);
        acceptThread.start();
        startMemoryPolicyScheduler();
        Log.i(TAG, "bionic inference host listening on abstract UDS \"" + socketName
            + "\" (default bundle " + defaultBundleDir + ", ramClass=" + ramClass
            + ", nCtx=" + InferenceMemoryPolicy.llmContextTokens(ramClass)
            + ", idleUnloadMs=" + idleUnloadMs + ")");
    }

    synchronized void stop() {
        running.set(false);
        ScheduledExecutorService exec = memoryPolicyExecutor;
        memoryPolicyExecutor = null;
        if (exec != null) {
            exec.shutdownNow();
        }
        LocalServerSocket s = serverSocket;
        serverSocket = null;
        if (s != null) {
            try {
                s.close();
            } catch (IOException ignored) {
                // closing only needs to unblock accept(); nothing to recover.
            }
        }
        resetResident();
        acceptThread = null;
    }

    /**
     * Idle/pressure policy tick (#11760). A single daemon scheduler checks every
     * {@link #MEMORY_POLICY_TICK_MS} whether the resident inference state (model
     * weights + KV cache + compute buffers, 2+ GB of GL mtrack on the 2B tier)
     * should be freed: after {@link #idleUnloadMs} of inactivity, or when the
     * pressure probe reports the device is approaching lmkd's kill line. The
     * next request reloads via {@code ensureResidentCtx} — agent/app state is
     * untouched, so the reclaim is lossless apart from the reload latency.
     */
    private void startMemoryPolicyScheduler() {
        if (memoryPolicyExecutor != null) {
            return;
        }
        if (idleUnloadMs <= 0L && pressureProbe == null) {
            Log.i(TAG, "memory policy scheduler disabled (idleUnloadMs=0, no pressure probe)");
            return;
        }
        ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "eliza-bionic-infer-memory-policy");
            t.setDaemon(true);
            return t;
        });
        exec.scheduleWithFixedDelay(
            this::memoryPolicyTick, MEMORY_POLICY_TICK_MS, MEMORY_POLICY_TICK_MS,
            TimeUnit.MILLISECONDS);
        memoryPolicyExecutor = exec;
    }

    private void memoryPolicyTick() {
        try {
            if (!residentActive) {
                return;
            }
            long idleMs = android.os.SystemClock.elapsedRealtime() - lastInferenceAtMs;
            if (idleUnloadMs > 0L && idleMs >= idleUnloadMs) {
                releaseIfStillIdle();
                return;
            }
            if (pressureProbe != null && pressureProbe.shouldRelease()) {
                releaseResident("memory-pressure: " + pressureProbe.describe());
            }
        } catch (Throwable t) {
            // The policy tick must never kill the scheduler.
            Log.w(TAG, "memory policy tick failed", t);
        }
    }

    /**
     * Idle-unload arm: acquiring residentLock may block behind an in-flight
     * decode, which refreshes {@link #lastInferenceAtMs} when it completes — so
     * the idle window is re-checked under the lock before freeing anything.
     */
    private void releaseIfStillIdle() {
        synchronized (residentLock) {
            long idleMs = android.os.SystemClock.elapsedRealtime() - lastInferenceAtMs;
            if (idleUnloadMs <= 0L || idleMs < idleUnloadMs) {
                return;
            }
            releaseResidentLocked("idle " + idleMs + "ms >= " + idleUnloadMs + "ms");
        }
    }

    /**
     * Free the resident model + context + stream (idle unload, memory pressure,
     * or an {@code onTrimMemory} callback relayed by {@link ElizaAgentService}).
     * Blocks on residentLock, so an in-flight decode finishes its turn first.
     * Safe to call from any thread except the main thread (use
     * {@link #releaseResidentAsync}).
     */
    void releaseResident(String reason) {
        synchronized (residentLock) {
            releaseResidentLocked(reason);
        }
    }

    /** Caller must hold residentLock. */
    private void releaseResidentLocked(String reason) {
        if (residentCtx == 0L && residentStream == 0L) {
            return;
        }
        Log.i(TAG, "releasing resident inference state (reason=" + reason
            + ", bundle=" + residentBundle + ", ramClass=" + ramClass + ")");
        resetResident();
        Log.i(TAG, "resident inference state released; model weights + KV cache + compute "
            + "buffers reclaimed (reason=" + reason + "). Next request reloads on demand.");
    }

    /** {@link #releaseResident} off-thread — for main-thread callers (onTrimMemory). */
    void releaseResidentAsync(String reason) {
        ScheduledExecutorService exec = memoryPolicyExecutor;
        if (exec != null) {
            exec.execute(() -> releaseResident(reason));
            return;
        }
        Thread t = new Thread(() -> releaseResident(reason), "eliza-bionic-infer-release");
        t.setDaemon(true);
        t.start();
    }

    private void acceptLoop() {
        while (running.get()) {
            LocalServerSocket s = serverSocket;
            if (s == null) {
                break;
            }
            final LocalSocket client;
            try {
                client = s.accept();
            } catch (IOException e) {
                if (running.get()) {
                    Log.w(TAG, "accept() failed", e);
                }
                continue;
            }
            // One worker thread per connection: a long GPU decode must not block
            // accepting the next request (the agent may open a second connection).
            Thread worker = new Thread(() -> handleConnection(client), "eliza-bionic-infer-conn");
            worker.setDaemon(true);
            worker.start();
        }
    }

    private void handleConnection(LocalSocket client) {
        try (LocalSocket sock = client;
             DataInputStream in = new DataInputStream(sock.getInputStream());
             DataOutputStream out = new DataOutputStream(sock.getOutputStream())) {
            // One request per connection for the buffered slice; loop so a future
            // streaming/keep-alive client can reuse the connection.
            while (running.get()) {
                final String requestJson;
                try {
                    requestJson = readFrame(in);
                } catch (IOException eof) {
                    break; // peer closed
                }
                if (requestJson == null) {
                    break;
                }
                // op="generateStream" server-pushes one frame per decode step on
                // this same connection (handled inline so it can write many
                // frames); every other op is one-request/one-response.
                if ("generateStream".equals(opOf(requestJson))) {
                    generateStreamRequest(requestJson, out);
                    out.flush();
                    lastInferenceAtMs = android.os.SystemClock.elapsedRealtime();
                    continue;
                }
                String responseJson = handleRequest(requestJson);
                writeFrame(out, responseJson);
                out.flush();
                // Every op (generate/embed/tts/asr/image) touches the shared
                // resident context — refresh the idle clock on completion (#11760).
                lastInferenceAtMs = android.os.SystemClock.elapsedRealtime();
            }
        } catch (IOException e) {
            Log.w(TAG, "connection error", e);
        } catch (RuntimeException e) {
            Log.e(TAG, "unexpected handler failure", e);
        }
    }

    private String handleRequest(String requestJson) {
        try {
            JSONObject req = new JSONObject(requestJson);
            String op = req.optString("op", "generate");
            String bundleDir = req.optString("bundleDir", "");
            if (bundleDir.isEmpty()) {
                bundleDir = defaultBundleDir;
            }
            if ("embed".equals(op)) {
                return embed(bundleDir, req.optString("text", ""));
            }
            if ("tts".equals(op)) {
                return tts(bundleDir, req.optString("text", ""),
                    (float) req.optDouble("speed", 1.0));
            }
            if ("asr".equals(op)) {
                return asr(bundleDir, req.optString("pcmBase64", ""),
                    req.optInt("sampleRate", 16000));
            }
            if ("image".equals(op)) {
                return describeImage(bundleDir, req.optString("imageBase64", ""),
                    req.optString("mmprojPath", ""), req.optString("prompt", ""));
            }
            if (!"generate".equals(op)) {
                return errorJson("unsupported op: " + op);
            }
            String prompt = req.optString("prompt", "");
            String drafterPath = req.optString("drafterPath", "");
            int maxTokens = req.optInt("maxTokens", 256);
            Log.i(TAG, "GENERATE from agent: " + prompt.length() + " prompt chars,"
                + " maxTokens=" + maxTokens + ", bundle=" + bundleDir
                + ", drafter=" + (drafterPath.isEmpty() ? "(none)" : drafterPath));
            // RESIDENT path (default): the model + context stay loaded across turns;
            // only the KV cache + sampler are reset and the prompt re-prefilled per
            // turn, so we skip the ~7-8s model RELOAD that nativeLlmSelfTest paid every
            // call. Reuse was previously believed to "corrupt the GPU model weights"
            // (~1/3 turns degenerated into " His!!!!" repetition) — but that signature
            // is the flash-attn SCALAR RACE, which is now DISABLED on Android (FA-off
            // → deterministic non-FA attention). So warm reuse is clean. Any stream
            // failure falls back to the reload-per-call self-test (set
            // ELIZA_BIONIC_RESIDENT=0 to force the old path).
            if (!"0".equals(System.getenv("ELIZA_BIONIC_RESIDENT"))) {
                try {
                    String r = generateResident(bundleDir, drafterPath, prompt, maxTokens);
                    Log.i(TAG, "GENERATE result (resident): "
                        + (r.length() > 200 ? r.substring(0, 200) + "…" : r));
                    return r;
                } catch (Throwable t) {
                    Log.w(TAG, "resident generate failed; falling back to reload-per-call", t);
                    resetResident();
                }
            }
            String result = ElizaVoiceNative.nativeLlmSelfTest(bundleDir, prompt, maxTokens);
            Log.i(TAG, "GENERATE result: "
                + (result.length() > 200 ? result.substring(0, 200) + "…" : result));
            return result;
        } catch (Throwable t) {
            return errorJson(t.getMessage() == null ? t.toString() : t.getMessage());
        }
    }

    /**
     * Warm/resident generate: the model + context + stream are created once and
     * reused; each turn only resets the KV+sampler and re-prefills the prompt, so
     * we skip the ~7-8s model reload. Greedy decode (temp=0, top_k=1), all-GPU.
     * Returns the same {ok,tokens,ms,tokS,text} JSON as nativeLlmSelfTest.
     *
     * <p>The per-turn {@code maxTokens} cap is enforced per NATIVE CALL via
     * {@link BionicDecodeLoop}: every {@code nativeLlmStreamNext} is budgeted
     * {@code min(step, cap - produced)}, so a maxTokens=20 request performs at
     * most 20 tokens of eval work (#11913 — previously one native call decoded
     * the full 256-token JNI buffer before the Java cap check ever ran).
     */
    private String generateResident(String bundleDir, String drafterPath, String prompt, int maxTokens)
            throws Exception {
        synchronized (residentLock) {
            ensureResidentCtx(bundleDir);
            final long t0 = android.os.SystemClock.elapsedRealtime();
            resetAndPrefillResident(prompt, drafterPath);
            // Buffered op: no per-frame consumer, so use the largest step the
            // JNI buffer allows — the per-turn cap still bounds every call.
            final BionicDecodeLoop.Result r = BionicDecodeLoop.run(
                this::residentStreamStep, maxTokens,
                BionicDecodeLoop.MAX_STEP_TOKENS, null);
            final long ms = android.os.SystemClock.elapsedRealtime() - t0;
            final double tokS = ms > 0 ? r.produced * 1000.0 / ms : 0.0;
            Log.i(TAG, "GENERATE (resident) eval count: " + r.produced
                + " tok (maxTokens cap "
                + (maxTokens > 0 ? maxTokens : BionicDecodeLoop.DEFAULT_CAP_TOKENS)
                + ") in " + ms + " ms");
            // Refresh under residentLock: a policy tick blocked on this lock
            // must re-read a fresh idle clock, not the pre-turn one.
            lastInferenceAtMs = android.os.SystemClock.elapsedRealtime();
            return new JSONObject()
                .put("ok", true)
                .put("tokens", r.produced)
                .put("ms", ms)
                .put("tokS", tokS)
                .put("text", r.text)
                .put("resident", true)
                .toString();
        }
    }

    /** One bounded native decode step on the resident stream, parsed for the loop. */
    private BionicDecodeLoop.Step residentStreamStep(int stepCap)
            throws org.json.JSONException {
        final String stepJson =
            ElizaVoiceNative.nativeLlmStreamNext(residentStream, stepCap);
        if (stepJson == null) return null;
        final JSONObject step = new JSONObject(stepJson);
        return new BionicDecodeLoop.Step(
            step.optString("text", ""),
            step.optInt("nout", 1),
            step.optBoolean("done", false));
    }

    /** Cheap op discriminator without fully consuming the request. */
    private static String opOf(String requestJson) {
        try {
            return new JSONObject(requestJson).optString("op", "generate");
        } catch (org.json.JSONException e) {
            return "generate";
        }
    }

    /** Parse an op="generateStream" request and run the streaming decode. */
    private void generateStreamRequest(String requestJson, DataOutputStream out)
            throws IOException {
        String bundleDir = defaultBundleDir;
        String drafterPath = "";
        String prompt = "";
        int maxTokens = 256;
        int streamStep = 0;
        try {
            JSONObject req = new JSONObject(requestJson);
            bundleDir = req.optString("bundleDir", "");
            if (bundleDir.isEmpty()) {
                bundleDir = defaultBundleDir;
            }
            drafterPath = req.optString("drafterPath", "");
            prompt = req.optString("prompt", "");
            maxTokens = req.optInt("maxTokens", 256);
            streamStep = req.optInt("streamStep", 0);
        } catch (org.json.JSONException e) {
            writeFrame(out, errorJson(e.getMessage() == null ? e.toString() : e.getMessage()));
            return;
        }
        generateStream(bundleDir, drafterPath, prompt, maxTokens, streamStep, out);
    }

    /**
     * Per-native-call token budget for the STREAMING op — how many tokens each
     * {@code nativeLlmStreamNext} may decode before its text is flushed as a
     * token frame. Small enough that the first frame (and every frame after it)
     * arrives at token cadence instead of after the whole reply; 8 matches the
     * user-visible streaming knee benchmarked in #9174. Resolution order:
     * per-request {@code streamStep} → {@code ELIZA_BIONIC_STREAM_STEP} env →
     * 8; clamped to the JNI token buffer.
     */
    private static final int DEFAULT_STREAM_STEP_TOKENS = 8;

    static int resolveStreamStepTokens(int requestValue, String envValue) {
        int step = requestValue > 0 ? requestValue : parsePositiveInt(envValue);
        if (step <= 0) step = DEFAULT_STREAM_STEP_TOKENS;
        return Math.min(step, BionicDecodeLoop.MAX_STEP_TOKENS);
    }

    private static int parsePositiveInt(String value) {
        if (value == null || value.trim().isEmpty()) return -1;
        try {
            final int parsed = Integer.parseInt(value.trim());
            return parsed > 0 ? parsed : -1;
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /**
     * Streaming variant of {@link #generateResident}: the identical warm decode,
     * but it writes one length-prefixed {type:"token",text} frame per decode step
     * to {@code out} as tokens are produced, then a terminal
     * {type:"done",ok,tokens,ms,tokS,text} frame. This lets the agent render
     * tokens as they decode (first paint at the first token instead of after the
     * whole reply) and unblocks phrase-chunked LLM→TTS. The buffered op="generate"
     * is unchanged for non-streaming callers (embed/tts/self-test).
     *
     * <p>Each native call is budgeted {@code min(streamStep, cap - produced)}
     * tokens (#11913): the {@code maxTokens} cap bounds total eval work exactly,
     * and the small per-call step is what makes the token frames actually
     * incremental — with the old unbounded call the whole 256-token buffer
     * decoded inside ONE {@code nativeLlmStreamNext}, so the "stream" was a
     * single giant frame and TTFT equaled full-turn latency.
     */
    private void generateStream(String bundleDir, String drafterPath, String prompt, int maxTokens,
                                int requestedStreamStep, DataOutputStream out) throws IOException {
        final int streamStep = resolveStreamStepTokens(
            requestedStreamStep, System.getenv("ELIZA_BIONIC_STREAM_STEP"));
        Log.i(TAG, "GENERATE_STREAM from agent: " + prompt.length() + " prompt chars,"
            + " maxTokens=" + maxTokens + ", streamStep=" + streamStep
            + ", bundle=" + bundleDir
            + ", drafter=" + (drafterPath.isEmpty() ? "(none)" : drafterPath));
        try {
            synchronized (residentLock) {
                ensureResidentCtx(bundleDir);
                final long t0 = android.os.SystemClock.elapsedRealtime();
                resetAndPrefillResident(prompt, drafterPath);
                final BionicDecodeLoop.Result r = BionicDecodeLoop.run(
                    this::residentStreamStep, maxTokens, streamStep,
                    text -> {
                        writeFrame(out, new JSONObject()
                            .put("type", "token").put("text", text).toString());
                        out.flush();
                    });
                final long ms = android.os.SystemClock.elapsedRealtime() - t0;
                final double tokS = ms > 0 ? r.produced * 1000.0 / ms : 0.0;
                writeFrame(out, new JSONObject()
                    .put("type", "done").put("ok", true)
                    .put("tokens", r.produced).put("ms", ms).put("tokS", tokS)
                    .put("text", r.text).put("resident", true).toString());
                out.flush();
                // Refresh under residentLock (see generateResident).
                lastInferenceAtMs = android.os.SystemClock.elapsedRealtime();
                Log.i(TAG, "GENERATE_STREAM done (resident): eval count "
                    + r.produced + " tok (maxTokens cap "
                    + (maxTokens > 0 ? maxTokens : BionicDecodeLoop.DEFAULT_CAP_TOKENS)
                    + ") @ " + String.format(java.util.Locale.US, "%.2f", tokS)
                    + " tok/s");
            }
        } catch (Throwable t) {
            Log.w(TAG, "generate_stream failed", t);
            resetResident();
            try {
                writeFrame(out, new JSONObject()
                    .put("type", "done").put("ok", false)
                    .put("error", t.getMessage() == null ? t.toString() : t.getMessage())
                    .toString());
                out.flush();
            } catch (Throwable ignored) {
            }
        }
    }

    /**
     * Get-or-create the shared resident inference context. ONE model load is
     * reused by both generation (via residentStream) and embeddings (the native
     * EliInferenceContext caches a separate non-causal embed_ctx + the causal
     * stream within the same shared model weights), so embeds no longer reload
     * the 1.27 GB model per call. Caller must hold residentLock.
     */
    private long ensureResidentCtx(String bundleDir) {
        // Op start, under residentLock — a policy tick blocked on the lock must
        // re-read a fresh idle clock (embed/tts/asr/image update the post-op
        // edge in handleConnection, outside the lock).
        lastInferenceAtMs = android.os.SystemClock.elapsedRealtime();
        if (residentCtx == 0L || !bundleDir.equals(residentBundle)) {
            resetResident();
            residentCtx = ElizaVoiceNative.nativeContextCreate(bundleDir);
            if (residentCtx == 0L) {
                throw new IllegalStateException("resident contextCreate failed: " + bundleDir);
            }
            residentBundle = bundleDir;
            residentActive = true;
        }
        return residentCtx;
    }

    /** Tear down the resident model/context/stream (on bundle change, failure, or stop). */
    private void resetResident() {
        synchronized (residentLock) {
            if (residentStream != 0L) {
                try { ElizaVoiceNative.nativeLlmStreamClose(residentStream); } catch (Throwable ignored) {}
                residentStream = 0L;
            }
            if (residentCtx != 0L) {
                try { ElizaVoiceNative.nativeContextDestroy(residentCtx); } catch (Throwable ignored) {}
                residentCtx = 0L;
            }
            residentBundle = null;
            residentDrafterPath = "";
            residentPrevTokens = null;
            residentActive = false;
        }
    }

    /**
     * Reset the resident stream for a new turn and prefill the prompt, REUSING
     * the KV of the longest common token prefix with the previous turn (the
     * system + tool-schema block is identical turn-to-turn) so only the per-turn
     * delta is decoded. On Mali's scalar-matmul prefill the prefix is the
     * dominant per-turn cost, so this is the single biggest latency win. Falls
     * back to a full reset (close+reopen on failure) when there is no reusable
     * prefix or the stream can't be trimmed (e.g. an MTP stream). Caller holds
     * residentLock.
     */
    private void resetAndPrefillResident(String prompt, String drafterPath) {
        final String effectiveDrafterPath = drafterPath == null ? "" : drafterPath;
        if (residentStream != 0L && !effectiveDrafterPath.equals(residentDrafterPath)) {
            ElizaVoiceNative.nativeLlmStreamClose(residentStream);
            residentStream = 0L;
            residentPrevTokens = null;
        }
        if (residentStream == 0L) {
            residentStream = ElizaVoiceNative.nativeLlmStreamOpen(
                residentCtx, RESIDENT_STREAM_MAX_TOKENS, 0.0f, 1.0f, 1, -1,
                effectiveDrafterPath);
            if (residentStream == 0L) {
                throw new IllegalStateException("resident streamOpen failed");
            }
            residentDrafterPath = effectiveDrafterPath;
            residentPrevTokens = null;
        }
        final int[] toks = ElizaVoiceNative.nativeTokenize(residentCtx, prompt, true, true);
        // Longest common token prefix with the previous turn, capped so at least
        // one new token is prefilled (the decode samples from the last prefilled
        // position's logits, so the suffix must be non-empty).
        int lcp = 0;
        if (residentPrevTokens != null) {
            final int max = Math.min(residentPrevTokens.length, toks.length);
            while (lcp < max && residentPrevTokens[lcp] == toks[lcp]) {
                lcp++;
            }
            if (lcp >= toks.length) {
                lcp = toks.length - 1;
            }
        }
        int applied = lcp > 0
            ? ElizaVoiceNative.nativeLlmStreamResetKeep(residentStream, lcp)
            : -1;
        if (applied < 0) {
            // No reusable prefix (first turn / MTP / trim failure): full reset,
            // close+reopen on failure.
            if (ElizaVoiceNative.nativeLlmStreamReset(residentStream) != 1) {
                ElizaVoiceNative.nativeLlmStreamClose(residentStream);
                residentStream = ElizaVoiceNative.nativeLlmStreamOpen(
                    residentCtx, RESIDENT_STREAM_MAX_TOKENS, 0.0f, 1.0f, 1, -1,
                    effectiveDrafterPath);
                if (residentStream == 0L) {
                    throw new IllegalStateException("resident streamReopen failed");
                }
                residentDrafterPath = effectiveDrafterPath;
            }
            applied = 0;
        }
        final int[] suffix = (applied <= 0)
            ? toks
            : java.util.Arrays.copyOfRange(toks, applied, toks.length);
        ElizaVoiceNative.nativeLlmStreamPrefill(residentStream, suffix);
        residentPrevTokens = toks;
        if (applied > 0) {
            Log.i(TAG, "resident prefill reuse: kept " + applied + "/" + toks.length
                + " prefix tokens, prefilled " + suffix.length + " delta");
        }
    }

    /**
     * Embed text on the GPU via the fused model (--pooling last). Reuses the
     * shared resident context (the native side caches a non-causal embed_ctx
     * inside it) so the 1.27 GB model is NOT reloaded per call — previously every
     * embed did contextCreate→embed→contextDestroy (~15 s + a full model copy of
     * memory churn each), which starved the LLM context on 8 GB devices. Single
     * forward pass, no autoregressive decode. Returns {ok, embedding:[...], dim}.
     */
    private String embed(String bundleDir, String text) throws org.json.JSONException {
        final int POOLING_LAST = 3;
        synchronized (residentLock) {
            final long ctx = ensureResidentCtx(bundleDir);
            try {
                float[] emb = ElizaVoiceNative.nativeEmbed(ctx, text, POOLING_LAST);
                org.json.JSONArray arr = new org.json.JSONArray();
                for (float v : emb) {
                    arr.put((double) v);
                }
                Log.i(TAG, "EMBED from agent: " + text.length() + " chars -> dim " + emb.length);
                return new JSONObject()
                    .put("ok", true)
                    .put("embedding", arr)
                    .put("dim", emb.length)
                    .toString();
            } catch (Throwable t) {
                // A failed embed may leave the shared context in an unknown state;
                // drop it so the next generate/embed rebuilds cleanly.
                resetResident();
                throw t;
            }
        }
    }

    /**
     * Synthesize {@code text} with the fused Kokoro-82M head and return base64
     * fp32 PCM at the model's native rate. This is the on-device voice the
     * Android app speaks with: TalkMode delegates here instead of falling back to
     * the platform TextToSpeech (the HTTP /api/tts/local-inference path can't
     * reach the fused lib from the musl agent, so it 502'd and the app spoke with
     * the system voice). Resolves the Kokoro GGUF + voice preset from the bundle's
     * {@code tts/kokoro/} dir.
     */
    private String tts(String bundleDir, String text, float speed) throws org.json.JSONException {
        if (text.trim().isEmpty()) {
            return errorJson("tts: empty text");
        }
        File kokoroDir = new File(bundleDir, "tts/kokoro");
        String gguf = firstMatch(kokoroDir, ".gguf");
        String voiceBin = firstMatch(kokoroDir, ".bin");
        if (gguf == null || voiceBin == null) {
            return errorJson("tts: Kokoro GGUF + voice .bin not found under " + kokoroDir);
        }
        // Reuse the ONE resident context (the 1.27 GB model is already loaded for
        // generation/embeddings) instead of contextCreate/Destroy per call — a
        // fresh context reloaded the whole model every utterance. Kokoro itself
        // is loaded once and cached on the ctx (idempotent kokoro_load), so a
        // multi-clause reply synthesizes each clause without any reload.
        synchronized (residentLock) {
            final long ctx = ensureResidentCtx(bundleDir);
            try {
                float[] pcm = ElizaVoiceNative.nativeKokoroSynthesize(
                    ctx, gguf, voiceBin, text, speed <= 0f ? 1.0f : speed);
                int sampleRate = ElizaVoiceNative.nativeKokoroSampleRate(ctx);
                // Pack fp32 PCM little-endian and base64 it for the JSON frame.
                ByteBuffer buf = ByteBuffer.allocate(pcm.length * 4).order(ByteOrder.LITTLE_ENDIAN);
                for (float v : pcm) {
                    buf.putFloat(v);
                }
                String b64 = Base64.encodeToString(buf.array(), Base64.NO_WRAP);
                Log.i(TAG, "TTS (kokoro) from agent: " + text.length() + " chars -> "
                    + pcm.length + " samples @ " + sampleRate + " Hz");
                return new JSONObject()
                    .put("ok", true)
                    .put("sampleRate", sampleRate)
                    .put("samples", pcm.length)
                    .put("pcmBase64", b64)
                    .toString();
            } catch (Throwable t) {
                // A failed synth may leave the shared ctx in an unknown state;
                // drop it so the next generate/embed/tts rebuilds cleanly.
                resetResident();
                throw t;
            }
        }
    }

    /**
     * On-device STT: decode the base64 little-endian fp32 PCM, run the fused
     * local ASR batch transcribe on the resident context (it mmap-acquires the
     * {@code asr/} weights on first use), and return {ok, text}. The agent's
     * TRANSCRIPTION delegate routes here over UDS (op="asr"); the musl agent
     * can't reach the fused lib itself. Reuses the ONE resident context like
     * embed/tts so the model is not reloaded per call.
     */
    private String asr(String bundleDir, String pcmBase64, int sampleRate)
            throws org.json.JSONException {
        if (pcmBase64.isEmpty()) {
            return errorJson("asr: empty pcmBase64");
        }
        byte[] raw = Base64.decode(pcmBase64, Base64.DEFAULT);
        final int n = raw.length / 4;
        if (n <= 0) {
            return errorJson("asr: pcmBase64 decoded to " + raw.length + " bytes (need fp32 PCM)");
        }
        float[] pcm = new float[n];
        ByteBuffer bb = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < n; i++) {
            pcm[i] = bb.getFloat();
        }
        final int sr = sampleRate > 0 ? sampleRate : 16000;
        synchronized (residentLock) {
            final long ctx = ensureResidentCtx(bundleDir);
            try {
                String text = ElizaVoiceNative.nativeAsrTranscribe(ctx, pcm, sr);
                Log.i(TAG, "ASR from agent: " + n + " samples @ " + sr + " Hz -> \""
                    + (text.length() > 200 ? text.substring(0, 200) + "…" : text) + "\"");
                return new JSONObject()
                    .put("ok", true)
                    .put("text", text)
                    .toString();
            } catch (Throwable t) {
                // A failed transcribe may leave the shared ctx in an unknown state;
                // drop it so the next generate/embed/tts/asr rebuilds cleanly.
                resetResident();
                throw t;
            }
        }
    }

    /**
     * On-device vision / screen-recognition: decode the base64 image bytes and
     * run the fused mmproj describe-image on the resident TEXT model. When the
     * caller doesn't pass an explicit {@code mmprojPath}, resolve the projector
     * GGUF from the bundle's {@code vision/} dir. Returns {ok, text}. The agent's
     * IMAGE_DESCRIPTION delegate routes here over UDS (op="image").
     */
    private String describeImage(String bundleDir, String imageBase64,
            String mmprojPath, String prompt) throws org.json.JSONException {
        if (imageBase64.isEmpty()) {
            return errorJson("image: empty imageBase64");
        }
        byte[] img = Base64.decode(imageBase64, Base64.DEFAULT);
        if (img.length == 0) {
            return errorJson("image: imageBase64 decoded to 0 bytes");
        }
        String mmproj = mmprojPath;
        if (mmproj == null || mmproj.isEmpty()) {
            File visionDir = new File(bundleDir, "vision");
            mmproj = firstMatch(visionDir, ".gguf");
            if (mmproj == null) {
                return errorJson("image: mmproj GGUF not found under " + visionDir
                    + " (stage a vision projector or pass mmprojPath)");
            }
        }
        synchronized (residentLock) {
            final long ctx = ensureResidentCtx(bundleDir);
            try {
                String desc = ElizaVoiceNative.nativeDescribeImage(ctx, img, mmproj, prompt);
                Log.i(TAG, "IMAGE from agent: " + img.length + " bytes (mmproj " + mmproj + ") -> \""
                    + (desc.length() > 200 ? desc.substring(0, 200) + "…" : desc) + "\"");
                return new JSONObject()
                    .put("ok", true)
                    .put("text", desc)
                    .toString();
            } catch (Throwable t) {
                resetResident();
                throw t;
            }
        }
    }

    /** First file in {@code dir} whose name ends with {@code suffix}, or null. */
    private static String firstMatch(File dir, String suffix) {
        File[] files = dir.listFiles();
        if (files == null) {
            return null;
        }
        for (File f : files) {
            if (f.isFile() && f.getName().endsWith(suffix)) {
                return f.getAbsolutePath();
            }
        }
        return null;
    }

    private static String errorJson(String message) {
        try {
            return new JSONObject().put("ok", false).put("error", message).toString();
        } catch (org.json.JSONException e) {
            return "{\"ok\":false,\"error\":\"internal\"}";
        }
    }

    /** Read one length-prefixed UTF-8 frame, or null on a clean length-0 frame. */
    private static String readFrame(DataInputStream in) throws IOException {
        int len = in.readInt(); // big-endian; throws EOFException when peer closes
        if (len <= 0) {
            return null;
        }
        if (len > MAX_FRAME_BYTES) {
            throw new IOException("frame too large: " + len);
        }
        byte[] buf = new byte[len];
        in.readFully(buf);
        return new String(buf, StandardCharsets.UTF_8);
    }

    private static void writeFrame(DataOutputStream out, String json) throws IOException {
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        out.writeInt(bytes.length);
        out.write(bytes);
    }
}
