package ai.elizaos.app;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.util.Log;

import org.json.JSONObject;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
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

    ElizaBionicInferenceServer(String socketName, String defaultBundleDir) {
        this.socketName = socketName;
        this.defaultBundleDir = defaultBundleDir;
    }

    /** Bind the abstract-namespace socket and start accepting. Idempotent. */
    synchronized void start() {
        if (running.get()) {
            return;
        }
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
            if (!"generate".equals(op)) {
                return errorJson("unsupported op: " + op);
            }
            String prompt = req.optString("prompt", "");
            int maxTokens = req.optInt("maxTokens", 256);
            Log.i(TAG, "GENERATE from agent: " + prompt.length() + " prompt chars,"
                + " maxTokens=" + maxTokens + ", bundle=" + bundleDir);
            // nativeLlmSelfTest creates a FRESH context per call (reloads the model
            // → fresh GPU weights) and runs the proven greedy decode, returning
            // {ok,text,tokens,ms,tokS}. ~5 s/turn, always clean.
            //
            // PERF NOTE: model/context REUSE (to skip the cold load) was tried in
            // THREE forms and device-tested — fresh-lctx-per-call, one persistent
            // lctx, and one persistent lctx + a fork-side KV reset
            // (eliza_inference_llm_stream_reset, which IS wired and clears the KV +
            // sampler). ALL three intermittently corrupt the output (~1 in 3 turns
            // degenerate into "His!!!!" token repetition) while nativeLlmSelfTest
            // is always clean. Reloading the model per call is what differs, so the
            // root cause is the fork's Vulkan backend corrupting the SHARED GPU
            // model weights across reuse — a backend bug, not a KV/lctx issue.
            // Until that's fixed in the fork, reload-per-call is the reliable path.
            String result = ElizaVoiceNative.nativeLlmSelfTest(bundleDir, prompt, maxTokens);
            Log.i(TAG, "GENERATE result: "
                + (result.length() > 200 ? result.substring(0, 200) + "…" : result));
            return result;
        } catch (Throwable t) {
            return errorJson(t.getMessage() == null ? t.toString() : t.getMessage());
        }
    }

    /**
     * Embed text on the GPU via the fused model (--pooling last). Fresh context
     * per call (single forward pass, no autoregressive decode — fast + clean).
     * Returns {ok, embedding:[...], dim}. This is what lets on-device memory /
     * doc-seeding run locally instead of failing over to cloud BatchEmbeddings.
     */
    private String embed(String bundleDir, String text) throws org.json.JSONException {
        final int POOLING_LAST = 3;
        long ctx = ElizaVoiceNative.nativeContextCreate(bundleDir);
        if (ctx == 0L) {
            return errorJson("embed: failed to create context for " + bundleDir);
        }
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
        } finally {
            ElizaVoiceNative.nativeContextDestroy(ctx);
        }
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
