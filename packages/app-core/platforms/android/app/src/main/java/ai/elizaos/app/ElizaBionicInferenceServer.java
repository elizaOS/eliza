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

    private final String socketName;
    private final String defaultBundleDir;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile LocalServerSocket serverSocket;
    private volatile Thread acceptThread;

    // Resident inference state: the model + context + stream stay loaded across
    // turns (no per-call reload). KV + sampler are reset each turn. Guarded by
    // residentLock so the per-connection workers serialize (one decode at a time).
    private long residentCtx = 0L;
    private long residentStream = 0L;
    private String residentBundle = null;
    /** The previous turn's prompt tokens — used to find the longest common prefix
     *  with the next turn's prompt so its KV can be reused (only the delta is
     *  re-prefilled). null when the stream has no reusable KV (first turn / after
     *  a reset/reopen). */
    private int[] residentPrevTokens = null;
    private final Object residentLock = new Object();
    /** Hard decode ceiling for the resident stream (per-call cap is applied below). */
    private static final int RESIDENT_STREAM_MAX_TOKENS = 2048;

    ElizaBionicInferenceServer(String socketName, String defaultBundleDir) {
        this.socketName = socketName;
        this.defaultBundleDir = defaultBundleDir;
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
    private static void applyBionicInferenceMemoryDefaults() {
        setEnvIfAbsent("ELIZA_LLM_N_BATCH", "128");
        setEnvIfAbsent("ELIZA_LLM_N_CTX", "8192");
        // The JNI bridge defaults the KV cache to the fused QJL/TBQ quant
        // (cache_type_k="qjl1_256"). QJL1_256 is a head_dim=128 sketch, but the
        // active eliza-1 tiers are qwen3.5 with head_dim=256, so llama can't
        // build that KV cache and llm_stream_open returns "failed to init llama
        // context" (elizaOS/eliza#8848). Fall back to the f16 KV cache, which is
        // only ~0.4 GB at 8k ctx for the 2B. Re-enable per device once a
        // head_dim=256 QJL/TBQ path is verified.
        setEnvIfAbsent("ELIZA_BIONIC_KV_QUANT", "0");
        // Arm same-file MTP (NextN speculative head embedded in the 2B/4B text
        // GGUF — no separate drafter). MTP accelerates DECODE ~1.5x and is the
        // best per-turn win available on the shipped qwen3.5 tiers: prefix-KV
        // reuse (resetAndPrefillResident → nativeLlmStreamResetKeep) needs the KV
        // cache to support partial sequence removal, but the qwen3.5 non-MTP F16
        // cache returns false from llama_memory_seq_rm (only the MTP/RS context
        // supports bounded partial removal), so prefix-reuse is a no-op fallback
        // on this model and disabling MTP for it would be strictly worse. The
        // resident path therefore stays MTP + full reset; reset_keep remains
        // wired for models/caches that DO support partial removal. (Tracked:
        // MTP-side prefix reuse via reset_engine_keep on the RS context.)
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
        Log.i(TAG, "bionic inference host listening on abstract UDS \"" + socketName
            + "\" (default bundle " + defaultBundleDir + ")");
    }

    synchronized void stop() {
        running.set(false);
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
                    continue;
                }
                String responseJson = handleRequest(requestJson);
                writeFrame(out, responseJson);
                out.flush();
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
            if (!"generate".equals(op)) {
                return errorJson("unsupported op: " + op);
            }
            String prompt = req.optString("prompt", "");
            int maxTokens = req.optInt("maxTokens", 256);
            Log.i(TAG, "GENERATE from agent: " + prompt.length() + " prompt chars,"
                + " maxTokens=" + maxTokens + ", bundle=" + bundleDir);
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
                    String r = generateResident(bundleDir, prompt, maxTokens);
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
     */
    private String generateResident(String bundleDir, String prompt, int maxTokens)
            throws org.json.JSONException {
        synchronized (residentLock) {
            ensureResidentCtx(bundleDir);
            final long t0 = android.os.SystemClock.elapsedRealtime();
            resetAndPrefillResident(prompt);
            final StringBuilder sb = new StringBuilder();
            int produced = 0;
            final int cap = maxTokens > 0 ? maxTokens : 32;
            while (produced < cap) {
                String stepJson = ElizaVoiceNative.nativeLlmStreamNext(residentStream);
                if (stepJson == null) break;
                JSONObject step = new JSONObject(stepJson);
                sb.append(step.optString("text", ""));
                int nout = step.optInt("nout", 1);
                produced += nout > 0 ? nout : 1;
                if (step.optBoolean("done", false)) break;
            }
            final long ms = android.os.SystemClock.elapsedRealtime() - t0;
            final double tokS = ms > 0 ? produced * 1000.0 / ms : 0.0;
            return new JSONObject()
                .put("ok", true)
                .put("tokens", produced)
                .put("ms", ms)
                .put("tokS", tokS)
                .put("text", sb.toString())
                .put("resident", true)
                .toString();
        }
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
        String prompt = "";
        int maxTokens = 256;
        try {
            JSONObject req = new JSONObject(requestJson);
            bundleDir = req.optString("bundleDir", "");
            if (bundleDir.isEmpty()) {
                bundleDir = defaultBundleDir;
            }
            prompt = req.optString("prompt", "");
            maxTokens = req.optInt("maxTokens", 256);
        } catch (org.json.JSONException e) {
            writeFrame(out, errorJson(e.getMessage() == null ? e.toString() : e.getMessage()));
            return;
        }
        generateStream(bundleDir, prompt, maxTokens, out);
    }

    /**
     * Streaming variant of {@link #generateResident}: the identical warm decode,
     * but it writes one length-prefixed {type:"token",text} frame per decode step
     * to {@code out} as tokens are produced, then a terminal
     * {type:"done",ok,tokens,ms,tokS,text} frame. This lets the agent render
     * tokens as they decode (first paint at the first token instead of after the
     * whole reply) and unblocks phrase-chunked LLM→TTS. The buffered op="generate"
     * is unchanged for non-streaming callers (embed/tts/self-test).
     */
    private void generateStream(String bundleDir, String prompt, int maxTokens,
                                DataOutputStream out) throws IOException {
        Log.i(TAG, "GENERATE_STREAM from agent: " + prompt.length() + " prompt chars,"
            + " maxTokens=" + maxTokens + ", bundle=" + bundleDir);
        final StringBuilder sb = new StringBuilder();
        try {
            synchronized (residentLock) {
                ensureResidentCtx(bundleDir);
                final long t0 = android.os.SystemClock.elapsedRealtime();
                resetAndPrefillResident(prompt);
                int produced = 0;
                final int cap = maxTokens > 0 ? maxTokens : 32;
                while (produced < cap) {
                    String stepJson = ElizaVoiceNative.nativeLlmStreamNext(residentStream);
                    if (stepJson == null) break;
                    JSONObject step = new JSONObject(stepJson);
                    String t = step.optString("text", "");
                    if (!t.isEmpty()) {
                        sb.append(t);
                        writeFrame(out, new JSONObject()
                            .put("type", "token").put("text", t).toString());
                        out.flush();
                    }
                    int nout = step.optInt("nout", 1);
                    produced += nout > 0 ? nout : 1;
                    if (step.optBoolean("done", false)) break;
                }
                final long ms = android.os.SystemClock.elapsedRealtime() - t0;
                final double tokS = ms > 0 ? produced * 1000.0 / ms : 0.0;
                writeFrame(out, new JSONObject()
                    .put("type", "done").put("ok", true)
                    .put("tokens", produced).put("ms", ms).put("tokS", tokS)
                    .put("text", sb.toString()).put("resident", true).toString());
                out.flush();
                Log.i(TAG, "GENERATE_STREAM done (resident): " + produced + " tok @ "
                    + String.format(java.util.Locale.US, "%.2f", tokS) + " tok/s");
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
        if (residentCtx == 0L || !bundleDir.equals(residentBundle)) {
            resetResident();
            residentCtx = ElizaVoiceNative.nativeContextCreate(bundleDir);
            if (residentCtx == 0L) {
                throw new IllegalStateException("resident contextCreate failed: " + bundleDir);
            }
            residentBundle = bundleDir;
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
            residentPrevTokens = null;
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
    private void resetAndPrefillResident(String prompt) {
        if (residentStream == 0L) {
            residentStream = ElizaVoiceNative.nativeLlmStreamOpen(
                residentCtx, RESIDENT_STREAM_MAX_TOKENS, 0.0f, 1.0f, 1, -1, "");
            if (residentStream == 0L) {
                throw new IllegalStateException("resident streamOpen failed");
            }
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
                    residentCtx, RESIDENT_STREAM_MAX_TOKENS, 0.0f, 1.0f, 1, -1, "");
                if (residentStream == 0L) {
                    throw new IllegalStateException("resident streamReopen failed");
                }
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
