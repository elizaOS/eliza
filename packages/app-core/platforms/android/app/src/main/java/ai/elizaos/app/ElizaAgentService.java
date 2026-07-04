package ai.elizaos.app;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.content.res.AssetManager;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import ai.elizaos.app.BuildConfig;
import ai.elizaos.app.R;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Foreground service that owns the local Eliza agent process on Android.
 *
 * On startup the service unpacks the bun runtime + musl loader + matching
 * shared libraries + agent bundle from the APK assets into the app's
 * writable data dir, marks them executable, and {@link Runtime#exec}'s
 * the agent. A foreground notification keeps the OS from killing the
 * hosting process; a watchdog thread polls process liveness and the
 * agent's HTTP health endpoint and restarts the process on crash with
 * exponential backoff.
 *
 * Mirrors {@link GatewayConnectionService}'s lifecycle and static API
 * shape — start/stop/restart helpers match what other call sites already
 * use.
 */
public class ElizaAgentService extends Service {

    private static final String TAG = "ElizaAgent";

    private static final String CHANNEL_ID = "eliza_agent";
    private static final int NOTIFICATION_ID = 2;

    // Intent actions
    public static final String ACTION_START = "app.eliza.action.START_AGENT";
    public static final String ACTION_STOP = "app.eliza.action.STOP_AGENT";
    public static final String ACTION_RESTART = "app.eliza.action.RESTART_AGENT";
    public static final String ACTION_UPDATE_STATUS = "app.eliza.action.UPDATE_AGENT_STATUS";

    // Extras
    private static final String EXTRA_STATUS = "status";

    // Agent layout under getFilesDir():
    //   agent/                     ← cwd, also holds agent-bundle.js + launch.sh
    //   agent/{abi}/bun
    //   agent/{abi}/ld-musl-*.so.1
    //   agent/{abi}/libstdc++.so.6
    //   agent/{abi}/libgcc_s.so.1
    //   .eliza/                   ← ELIZA_STATE_DIR (PGlite data, auth, prompts)
    //
    // The agent runs in the priv_app SELinux domain — Android.bp deliberately
    // omits the platform certificate so seapp_contexts puts the APK there
    // instead of platform_app. AOSP's stock policy includes
    // `allow priv_app privapp_data_file:file execute;` in
    // system/sepolicy/private/priv_app.te, which is what lets us execve
    // the bun binary out of /data/data/<pkg>/files/agent/. No jniLibs
    // trick, no custom domain, no symlinks: the binary just sits in the
    // app's writable data dir at canonical names.
    private static final String AGENT_DIR_NAME = "agent";
    // Sibling dirs of AGENT_DIR_NAME under getFilesDir(), on the same filesystem
    // so File.renameTo() between them is an atomic rename(2). Asset refreshes
    // extract into the staging dir and swap it into place; the trash dir holds
    // the previous extraction across the two-rename swap so a crash between them
    // still leaves a recoverable last-good copy (#12453).
    private static final String AGENT_STAGING_DIR_NAME = "agent.staging";
    private static final String AGENT_TRASH_DIR_NAME = "agent.trash";
    private static final String AGENT_STAMP_NAME = ".apk-stamp";
    private static final String AGENT_STATE_DIR_NAME = ".eliza";
    private static final String AGENT_BUNDLE_NAME = "agent-bundle.js";
    private static final String AGENT_LAUNCH_SCRIPT = "launch.sh";
    private static final String BUN_BINARY = "bun";
    private static final String AGENT_LOG_NAME = "agent.log";
    private static final String AGENT_RESTART_DIAGNOSTICS_NAME = "agent-restart-diagnostics.jsonl";
    private static final long AGENT_RESTART_DIAGNOSTICS_MAX_BYTES = 256L * 1024L;
    /** Serializes rotate-check + append so concurrent events can't interleave JSONL lines. */
    private static final Object DIAGNOSTICS_LOCK = new Object();
    private static final String EXIT_INFO_PREFS = "eliza-agent-exit-info";
    private static final String DETACHED_LAUNCH_STAMP_KEY = "detachedLaunchStartedAtMs";
    private static final String EXIT_INFO_LAST_TIMESTAMP = "lastTimestamp";

    // The agent binds no TCP port by default (requests ride the abstract UDS
    // below). AGENT_PORT is only used when ELIZA_API_EXPOSE_PORT re-opens the
    // HTTP listener for dev/LAN/e2e, and to advertise the port in status text.
    private static final int AGENT_PORT = 31337;

    /**
     * Abstract-namespace AF_UNIX socket the in-process bionic GPU inference
     * server ({@link ElizaBionicInferenceServer}) binds, and the musl agent's
     * BionicHostLoader connects to. Abstract namespace (no filesystem path)
     * avoids SELinux file-label issues under the priv_app domain. The musl
     * agent reaches it as {@code Bun.connect({unix:"\0" + name})}.
     */
    static final String BIONIC_INFERENCE_SOCKET_NAME = "eliza_bionic_infer_v1";

    /**
     * Abstract-namespace AF_UNIX socket the on-device agent binds to serve the
     * WebView's local-agent requests (the port-free replacement for the
     * 127.0.0.1:31337 loopback HTTP path). The bun agent listens (see
     * android/bridge.ts) and this service connects per request/stream, speaking
     * the same NDJSON frame protocol the iOS bridge uses. Abstract namespace
     * (no filesystem path) is the sanctioned priv_app IPC — same reason the
     * bionic host above uses it. Exported to the agent as
     * ELIZA_LOCAL_AGENT_SOCKET; Java reaches it via {@link LocalSocketAddress}
     * with {@code Namespace.ABSTRACT}.
     */
    static final String LOCAL_AGENT_SOCKET_NAME = "eliza_local_agent_v1";
    private static final int LOCAL_REQUEST_DEFAULT_TIMEOUT_MS = 10_000;
    private static final int LOCAL_REQUEST_MAX_TIMEOUT_MS = 600_000;
    // Read-timeout budget applied to slow on-device inference routes (ASR / TTS
    // / transcription / chat generation) when the caller doesn't pin its own —
    // matches LOCAL_REQUEST_MAX_TIMEOUT_MS and the agent's chat-generation
    // budget so a cold model load never trips a spurious local_agent_unavailable.
    private static final int LOCAL_INFERENCE_REQUEST_TIMEOUT_MS = 600_000;
    private static final int LOCAL_REQUEST_MAX_BODY_BYTES = 10 * 1024 * 1024;
    private static final int LOCAL_REQUEST_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

    // The on-device boot path is heavy: PGlite extension extraction +
    // plugin resolution + libllama dlopen + first-time model load can
    // exceed several minutes on a cold cuttlefish x86_64 image. The chat path is
    // even heavier: a single planner-produced prompt at ~12k tokens,
    // chunked through llama_decode on emulated CPU, can run 15–30 min
    // wall-clock for a single chat turn (multiple model invocations:
    // planner, action evaluator, response generator).
    //
    // Strategy: combine a generous interval with a smart probe that
    // distinguishes "process dead" from "process alive but busy in a
    // native FFI call". When the HTTP probe times out but the process
    // is alive (i.e. bun is mid-llama_decode and hasn't returned to its
    // event loop yet), we DO NOT count a strike — the process is doing
    // exactly what it should be doing, just synchronously inside a
    // native call. We only count strikes when the process is actually
    // dead OR returns non-2xx / non-ready health (a real crash signal).
    // Strikes accumulate when the process is dead, which forces a
    // restart via the existing scheduleRestart() path.
    //
    // 600 s × 3 = 1800 s = 30 min worst-case grace window. Real phone
    // hardware (Tensor / Adreno) finishes a chat turn in seconds, so
    // this only matters for AOSP smoke runs on cvd. HEALTH_TIMEOUT_MS
    // = 30 s is a conservative bound on a single HTTP listener wakeup
    // — bun's setImmediate yield should hit within a few seconds even
    // mid-decode, and 30 s catches genuine TCP-level hangs without
    // racing against real long-running calls.
    private static final long WATCHDOG_INTERVAL_MS = 600_000L;
    private static final int HEALTH_FAIL_STRIKES = 3;
    private static final long HEALTH_TIMEOUT_MS = 30_000L;
    // Keep this aligned with packages/app/scripts/mobile-local-chat-smoke.mjs:
    // ANDROID_HEALTH_ATTEMPTS (240) × 2000 ms = 480 s.
    private static final long STARTUP_HEALTH_GRACE_MS = 480_000L;
    private static final long STARTUP_HEALTH_POLL_MS = 5_000L;
    private static final int MAX_RESTART_ATTEMPTS = 5;
    private static final long PROCESS_TERMINATE_GRACE_MS = 5_000L;
    // How long after a detached launch we treat a not-yet-listening agent as
    // "still cold-booting" and refuse to relaunch it (the boot — plugin
    // resolution + first model load — runs ~60-90s on an emulated CPU). Past
    // this the boot is considered failed and a relaunch is allowed.
    private static final long AGENT_BOOT_GRACE_MS = 120_000L;

    private final Object processLock = new Object();
    private Process agentProcess;
    private Thread stdoutPump;
    private Thread stderrPump;
    private WatchdogThread watchdog;
    /** In-process bionic GPU inference host; non-null only when delegating. */
    private volatile ElizaBionicInferenceServer bionicInferenceServer;
    private Thread startWorker;
    private volatile boolean shuttingDown;
    private volatile boolean foregroundStartDenied;
    private volatile boolean detachedAgentMode;
    private volatile long detachedLaunchStartedAtMs;
    private int restartAttempts;
    private String currentStatus = "starting";

    // Per-boot bearer token for the WebView↔agent loopback. Generated when
    // the service first starts the agent process and cleared on stop.
    // The Capacitor agent plugin reads it from `localAgentToken()` to
    // hydrate `window.__ELIZA_API_TOKEN__` so the WebView's fetches
    // include `Authorization: Bearer <token>`. The agent enforces the
    // token via ELIZA_REQUIRE_LOCAL_AUTH=1.
    private static volatile String currentLocalAgentToken;
    private static volatile String currentTerminalRunToken;

    /** Called by the Capacitor agent plugin Android binding. */
    public static String localAgentToken() {
        return currentLocalAgentToken;
    }

    /**
     * Cross-process token recovery. The token is a per-process static, but the
     * bun agent is a DETACHED process that outlives the app process that started
     * it — so a freshly-launched WebView process (e.g. after a boot autostart)
     * sees a null static even though a healthy agent is running, which dead-ends
     * the dashboard at the pairing screen. Fall back to the recovery file that
     * {@link #writeLocalAgentTokenFile} persists, and cache it for this process.
     */
    public static String localAgentToken(Context context) {
        String token = currentLocalAgentToken;
        if (token != null && !token.trim().isEmpty()) {
            return token;
        }
        if (context == null) {
            return token;
        }
        String fromFile = readLocalAgentTokenFile(context);
        if (fromFile != null && !fromFile.trim().isEmpty()) {
            currentLocalAgentToken = fromFile.trim();
            return currentLocalAgentToken;
        }
        return token;
    }

    private static String readLocalAgentTokenFile(Context context) {
        File file = new File(new File(context.getFilesDir(), "auth"), "local-agent-token");
        if (!file.isFile()) {
            return null;
        }
        try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[256];
            int n;
            while ((n = in.read(buf)) != -1) {
                bos.write(buf, 0, n);
            }
            return new String(bos.toByteArray(), java.nio.charset.StandardCharsets.UTF_8).trim();
        } catch (IOException error) {
            Log.w(TAG, "Unable to read local-agent token file: " + error.getMessage());
            return null;
        }
    }

    /** Called by trusted in-app code that needs to route shell requests. */
    public static String terminalRunToken() {
        return currentTerminalRunToken;
    }

    /**
     * Shared in-process request surface for Android native plugins and workers.
     *
     * The current Android agent still serves routes from the Bun child process
     * over loopback, but callers should route through this method instead of
     * opening their own sockets. That keeps auth, header filtering, body caps,
     * and future Binder/stdio replacement behind one app-owned boundary.
     */
    /**
     * Routes whose on-device handler does a synchronous, multi-second (cold
     * model load) or open-ended (token-by-token generation) llama call before
     * the HTTP response completes — they need the long inference read-timeout
     * budget, not the 10s default used for ordinary CRUD API calls.
     */
    private static boolean isLongRunningInferencePath(String path) {
        if (path == null) return false;
        String p = path.toLowerCase(Locale.US);
        return p.contains("/asr")
            || p.contains("/tts")
            || p.contains("/transcription")
            || p.contains("/speech")
            || p.contains("/local-inference")
            || p.contains("/messages/stream")
            || p.contains("/messages")
            || p.contains("/greeting")
            || p.contains("/voice");
    }

    public static String requestLocalAgent(String requestJson) throws IOException, JSONException {
        LocalAgentRequest req = parseLocalAgentRequest(requestJson);
        JSONObject payload = buildRequestPayload(req);
        return dispatchBufferedOverSocket(payload, req.timeoutMs).toString();
    }

    /** Parsed, validated, timeout-normalized local-agent request. */
    private static final class LocalAgentRequest {
        final String method;
        final String path;
        final JSONObject headers;
        final String body;
        final int timeoutMs;

        LocalAgentRequest(String method, String path, JSONObject headers, String body, int timeoutMs) {
            this.method = method;
            this.path = path;
            this.headers = headers;
            this.body = body;
            this.timeoutMs = timeoutMs;
        }
    }

    private static LocalAgentRequest parseLocalAgentRequest(String requestJson) throws JSONException {
        JSONObject request = requestJson == null || requestJson.trim().isEmpty()
            ? new JSONObject()
            : new JSONObject(requestJson);
        String path = request.optString("path", "").trim();
        if (!isSafeLocalAgentPath(path)) {
            throw new IllegalArgumentException("Local agent request requires a path that starts with /");
        }
        String method = request.optString("method", "GET").trim().toUpperCase(Locale.US);
        if (!method.matches("^[A-Z]{1,16}$")) {
            throw new IllegalArgumentException("Unsupported HTTP method");
        }
        int timeoutMs = request.optInt("timeoutMs", LOCAL_REQUEST_DEFAULT_TIMEOUT_MS);
        // On-device inference is inherently slow: a cold model load alone — the
        // ~1 GB ASR GGUF, the OmniVoice TTS GGUFs, or evicting + reloading the
        // chat model — is a multi-second synchronous llama load before the agent
        // emits a single byte, and transcription/synthesis/generation on
        // emulated or low-end CPU runs well past 10 s. The WebView transport
        // sends its generic 10 s fetch timeout for these calls too; FLOOR
        // inference/voice routes at the inference budget so a cold load never
        // trips a spurious local_agent_unavailable — raise a too-short caller
        // timeout, never lower a longer one.
        if (isLongRunningInferencePath(path)) {
            timeoutMs = Math.max(timeoutMs, LOCAL_INFERENCE_REQUEST_TIMEOUT_MS);
        }
        timeoutMs = Math.max(1_000, Math.min(timeoutMs, LOCAL_REQUEST_MAX_TIMEOUT_MS));
        JSONObject headers = request.optJSONObject("headers");
        Object rawBody = request.opt("body");
        String body = rawBody == null || rawBody == JSONObject.NULL ? null : rawBody.toString();
        return new LocalAgentRequest(method, path, headers == null ? new JSONObject() : headers, body, timeoutMs);
    }

    /**
     * Build the NDJSON request payload the agent's stdio kernel expects. The
     * per-boot bearer token is injected (the agent still honors it when
     * ELIZA_REQUIRE_LOCAL_AUTH=1) and the forwarded-header blocklist strips
     * hop-by-hop headers that no longer make sense over the socket transport.
     */
    private static JSONObject buildRequestPayload(LocalAgentRequest req) throws JSONException {
        JSONObject headers = filterForwardedHeaders(req.headers);
        String token = currentLocalAgentToken;
        if (token != null && !token.trim().isEmpty() && !hasHeader(headers, "authorization")) {
            headers.put("Authorization", "Bearer " + token.trim());
        }
        boolean methodTakesBody = !"GET".equals(req.method) && !"HEAD".equals(req.method);
        if (req.body != null && methodTakesBody && !hasHeader(headers, "content-type")) {
            headers.put("Content-Type", "application/json; charset=utf-8");
        }
        JSONObject payload = new JSONObject()
            .put("method", req.method)
            .put("path", req.path)
            .put("headers", headers);
        if (req.body != null && methodTakesBody) {
            byte[] bodyBytes = req.body.getBytes(StandardCharsets.UTF_8);
            if (bodyBytes.length > LOCAL_REQUEST_MAX_BODY_BYTES) {
                throw new IllegalArgumentException("Request body is too large");
            }
            payload.put("body", req.body);
        }
        return payload;
    }

    /**
     * Streaming variant of {@link #requestLocalAgent}. Where that returns one
     * buffered result, this sends an {@code http_request_stream} frame and reads
     * the agent's response/chunk/complete frames as they arrive, translating each
     * into the small envelope the AgentPlugin maps to Capacitor events:
     *   {"type":"response","status":..,"statusText":..,"headers":{..}}  (once, first)
     *   {"type":"chunk","dataBase64":".."}                              (per frame)
     *   {"type":"complete"}  or  {"type":"complete","error":".."}        (terminal)
     *
     * Single attempt by design: a connect failure emits a terminal error event
     * and the WebView falls back to the buffered {@link #requestLocalAgent}
     * (which carries the cold-load connect retry), so non-idempotent POSTs are
     * never replayed here. Runs on the caller's thread (AgentPlugin spawns one).
     */
    public static void requestLocalAgentStream(String requestJson, java.util.function.Consumer<String> onEvent) {
        try {
            LocalAgentRequest req = parseLocalAgentRequest(requestJson);
            JSONObject payload = buildRequestPayload(req);
            streamOverSocket(payload, req.timeoutMs, onEvent);
        } catch (Exception error) {
            emitStreamComplete(onEvent, error.getMessage() == null ? "Local agent stream failed" : error.getMessage());
        }
    }

    /**
     * Send a streaming request over the abstract UDS and translate the agent's
     * NDJSON stream frames ({@code {stream:"response"|"chunk"|"complete"}}) into
     * the AgentPlugin envelopes. The socket connect carries the cold-boot retry
     * (the agent may not have bound the socket yet); once a frame arrives the
     * request is in-flight, so a mid-stream failure surfaces as a terminal error
     * and is never silently re-dialed.
     */
    private static void streamOverSocket(
        JSONObject payload,
        int timeoutMs,
        java.util.function.Consumer<String> onEvent
    ) throws IOException, JSONException {
        JSONObject frame = new JSONObject()
            .put("id", nextFrameId())
            .put("method", "http_request_stream")
            .put("stream", true)
            .put("payload", payload);

        LocalSocket socket = connectLocalAgentSocket(timeoutMs);
        try {
            socket.setSoTimeout(timeoutMs);
            writeFrameLine(socket.getOutputStream(), frame);
            InputStream in = socket.getInputStream();
            for (String line = readFrameLine(in); line != null; line = readFrameLine(in)) {
                if (line.isEmpty()) continue;
                JSONObject response = new JSONObject(line);
                String phase = response.optString("stream", "");
                if ("response".equals(phase)) {
                    onEvent.accept(new JSONObject()
                        .put("type", "response")
                        .put("status", response.optInt("status"))
                        .put("statusText", response.optString("statusText"))
                        .put("headers", response.optJSONObject("headers") != null
                            ? response.optJSONObject("headers")
                            : new JSONObject())
                        .toString());
                } else if ("chunk".equals(phase)) {
                    onEvent.accept(new JSONObject()
                        .put("type", "chunk")
                        .put("dataBase64", response.optString("dataBase64"))
                        .toString());
                } else if ("complete".equals(phase)) {
                    emitStreamComplete(onEvent, response.has("error") ? response.optString("error") : null);
                    return;
                } else if (response.has("error")) {
                    // A parse/dispatch error before the stream started.
                    emitStreamComplete(onEvent, response.optString("error"));
                    return;
                }
            }
            // Socket closed without a terminal frame — treat as completion.
            emitStreamComplete(onEvent, null);
        } finally {
            closeQuietly(socket);
        }
    }

    private static void emitStreamComplete(java.util.function.Consumer<String> onEvent, String error) {
        try {
            JSONObject complete = new JSONObject().put("type", "complete");
            if (error != null) complete.put("error", error);
            onEvent.accept(complete.toString());
        } catch (JSONException ignored) {
            // A complete event with no error is the worst case if JSON fails.
            onEvent.accept("{\"type\":\"complete\"}");
        }
    }

    private static boolean isSafeLocalAgentPath(String path) {
        return path != null
            && path.startsWith("/")
            && !path.startsWith("//")
            && !path.contains("://");
    }

    /**
     * Send one buffered request over the abstract UDS and return the agent's
     * response envelope ({@code {status,statusText,headers,body,bodyBase64,
     * bodyEncoding}}) — the exact shape the loopback HTTP path returned, so the
     * AgentPlugin + WebView transport are unchanged. The connect (not the sent
     * request) carries the cold-boot retry: while the agent is inside a long
     * synchronous FFI call (a cold model load, a chat llama_decode) its accept
     * loop briefly stalls, so a concurrent request can hit connection-refused.
     * Only the connect phase is retried; once bytes are written the request is
     * in-flight and a read failure propagates so non-idempotent POSTs never
     * replay. The window must outlast the longest event-loop stall (~10-15 s
     * chat-model cold reload after a voice transcription).
     */
    private static JSONObject dispatchBufferedOverSocket(JSONObject payload, int timeoutMs)
        throws IOException, JSONException {
        JSONObject frame = new JSONObject()
            .put("id", nextFrameId())
            .put("method", "http_request")
            .put("payload", payload);

        LocalSocket socket = connectLocalAgentSocket(timeoutMs);
        try {
            socket.setSoTimeout(timeoutMs);
            writeFrameLine(socket.getOutputStream(), frame);
            String line = readFrameLine(socket.getInputStream());
            if (line == null || line.isEmpty()) {
                throw new IOException("local agent closed the connection with no response");
            }
            JSONObject response = new JSONObject(line);
            if (!response.optBoolean("ok", false)) {
                throw new IOException(response.optString("error", "local agent request failed"));
            }
            JSONObject result = response.optJSONObject("result");
            if (result == null) {
                throw new IOException("local agent returned no result payload");
            }
            return result;
        } finally {
            closeQuietly(socket);
        }
    }

    /**
     * Connect to the agent's abstract-namespace request socket, retrying only the
     * connect phase across the cold-boot window (the bun agent may not have bound
     * the socket yet, or its accept loop is stalled mid-decode). Returns a
     * connected {@link LocalSocket}; the caller owns closing it.
     */
    private static LocalSocket connectLocalAgentSocket(int timeoutMs) throws IOException {
        final int connectRetries = 15;
        IOException lastError = null;
        for (int attempt = 0; attempt <= connectRetries; attempt++) {
            LocalSocket socket = new LocalSocket();
            try {
                socket.connect(new LocalSocketAddress(
                    LOCAL_AGENT_SOCKET_NAME, LocalSocketAddress.Namespace.ABSTRACT));
                return socket;
            } catch (IOException connectError) {
                closeQuietly(socket);
                lastError = connectError;
            }
            if (attempt < connectRetries) {
                try {
                    Thread.sleep(250L * (attempt + 1));
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw lastError;
                }
            }
        }
        throw lastError != null ? lastError : new IOException("local agent socket unreachable");
    }

    /** Write one NDJSON frame line (UTF-8, newline-terminated) to the socket. */
    private static void writeFrameLine(OutputStream out, JSONObject frame) throws IOException {
        byte[] line = (frame.toString() + "\n").getBytes(StandardCharsets.UTF_8);
        out.write(line);
        out.flush();
    }

    /**
     * Read one newline-delimited frame line from the socket. Returns the line
     * without the trailing newline, or null at end-of-stream. Caps a single
     * frame at the response-byte budget so a runaway agent can't exhaust memory.
     */
    private static String readFrameLine(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') {
                return buffer.toString(StandardCharsets.UTF_8.name());
            }
            if (b != '\r') {
                buffer.write(b);
                if (buffer.size() > LOCAL_REQUEST_MAX_RESPONSE_BYTES) {
                    throw new IOException("local agent response frame exceeds size cap");
                }
            }
        }
        if (buffer.size() == 0) return null;
        return buffer.toString(StandardCharsets.UTF_8.name());
    }

    /** Copy request headers into the payload, dropping hop-by-hop headers. */
    private static JSONObject filterForwardedHeaders(JSONObject headers) throws JSONException {
        JSONObject out = new JSONObject();
        if (headers == null) return out;
        java.util.Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (isBlockedForwardedHeader(key)) continue;
            Object value = headers.opt(key);
            if (value == null || value == JSONObject.NULL) continue;
            String stringValue = value.toString();
            if (!stringValue.trim().isEmpty()) {
                out.put(key, stringValue);
            }
        }
        return out;
    }

    private static long frameIdCounter = 0L;

    private static synchronized long nextFrameId() {
        return ++frameIdCounter;
    }

    private static void closeQuietly(LocalSocket socket) {
        if (socket == null) return;
        try {
            socket.close();
        } catch (IOException ignored) {
            // Best-effort close; nothing to recover.
        }
    }

    private static boolean hasHeader(JSONObject headers, String expected) {
        if (headers == null) return false;
        java.util.Iterator<String> keys = headers.keys();
        while (keys.hasNext()) {
            if (expected.equalsIgnoreCase(keys.next())) return true;
        }
        return false;
    }

    private static boolean isBlockedForwardedHeader(String key) {
        return "host".equalsIgnoreCase(key)
            || "connection".equalsIgnoreCase(key)
            || "content-length".equalsIgnoreCase(key);
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        ensureNotificationChannel();

        Notification notification = buildNotification("Eliza agent", "Starting…");

        // Enter the foreground BEFORE any diagnostic IO. Android's FGS-start
        // timeout begins ticking at onCreate; spending it on the synchronous
        // getHistoricalProcessExitReasons() + diagnostic file writes below (or,
        // on a slow/loaded device, the later ~170 MB asset copy) trips
        // "Timeout executing service" and AMS kills the process mid-work — which
        // feeds the interrupted-extraction crashloop in #12453. startForeground()
        // first stops that clock. The heavy asset copy stays off the main thread
        // on the startWorker (requestAgentStart), so onCreate only needs to keep
        // the FGS-start critical path free of blocking IO.
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                );
            } else {
                startForeground(NOTIFICATION_ID, notification);
            }
        } catch (IllegalStateException error) {
            if (!ElizaAgentWatchdogPolicy.isForegroundStartDenial(error)) {
                throw error;
            }
            // Android 12+ denied the FGS start: AMS restarted the sticky
            // service with no foreground activity (the post-LMK-kill path in
            // #11506). Crashing here loops: AMS restarts the sticky service
            // and the denial repeats. Stop cleanly instead; the next real
            // (foreground) launch restarts the service, and a surviving
            // detached agent process is left untouched for it to adopt.
            Map<String, String> details = new LinkedHashMap<>();
            details.put("exception", error.getClass().getName());
            appendDiagnosticEvent("fgs-start-denied", details);
            Log.w(TAG, "startForeground() denied (background sticky restart); "
                + "stopping service cleanly instead of crash-looping.", error);
            foregroundStartDenied = true;
            shuttingDown = true;
            stopSelf();
            return;
        }

        // FGS is up; these diagnostic reads can no longer trip the FGS-start
        // timeout.
        appendDiagnosticEvent("service-onCreate", null);
        logRecentApplicationExitReasons("service-onCreate");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        Map<String, String> details = new LinkedHashMap<>();
        details.put("action", action == null ? "<default>" : action);
        details.put("flags", String.valueOf(flags));
        details.put("startId", String.valueOf(startId));
        appendDiagnosticEvent("service-onStartCommand", details);
        if (foregroundStartDenied) {
            // onCreate could not enter the foreground (background sticky
            // restart on Android 12+) and already called stopSelf(); refuse
            // the pending start so AMS does not re-deliver it. Stop this
            // delivered start explicitly too: a startService() racing the
            // teardown would otherwise leave this instance running as a
            // started service that never entered the foreground.
            appendDiagnosticEvent("service-start-refused-fgs-denied", details);
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(action)) {
            shuttingDown = true;
            appendDiagnosticEvent("service-stop-intent", details);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_RESTART.equals(action)) {
            Log.i(TAG, "Restart requested via intent.");
            restartAttempts = 0;
            requestAgentStart(true);
            return START_STICKY;
        }
        if (ACTION_UPDATE_STATUS.equals(action)) {
            String status = intent.getStringExtra(EXTRA_STATUS);
            if (status != null) {
                currentStatus = status;
                updateNotification();
            }
            return START_STICKY;
        }

        // ACTION_START or null (default) — boot the agent if it isn't already up.
        requestAgentStart(false);
        if (watchdog == null) {
            watchdog = new WatchdogThread();
            watchdog.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        // Only an explicit stop (ACTION_STOP → shuttingDown) may tear the
        // agent process down. The FGS-denial path also sets shuttingDown, but
        // its contract is the opposite — "a surviving detached agent process
        // is left untouched for [the next launch] to adopt" — so exclude it.
        boolean requestedStop = shuttingDown && !foregroundStartDenied;
        Map<String, String> details = new LinkedHashMap<>();
        details.put("shuttingDown", String.valueOf(requestedStop));
        details.put("currentStatus", currentStatus);
        details.put("detachedAgentMode", String.valueOf(detachedAgentMode));
        appendDiagnosticEvent("service-onDestroy", details);
        shuttingDown = true;
        if (watchdog != null) {
            watchdog.interrupt();
            watchdog = null;
        }
        if (bionicInferenceServer != null) {
            bionicInferenceServer.stop();
            bionicInferenceServer = null;
        }
        if (requestedStop) {
            stopAgentProcess();
        } else {
            // AMS tore this record down without an explicit stop request (an
            // ANR'd duplicate record whose startForeground never got processed
            // on a blocked main thread, LMK pressure, task removal). The
            // detached agent outlives its launching service BY DESIGN — leave
            // it running so the next service instance adopts it via
            // isLoopbackAgentListening(). Calling stopAgentProcess() here
            // pkills the agent by path: observed on the emulator e2e, an
            // in-flight start worker (asset refresh holding processLock for
            // ~33s) launched the agent and this destroy path then killed it
            // 1s later; the Android-15 background FGS-start denial meant
            // nothing ever restarted it and local mode stayed dead until the
            // next manual app launch.
            appendDiagnosticEvent("service-destroy-preserved-agent", details);
            Log.i(TAG, "Service destroyed without a stop request; leaving the agent process running for adoption.");
        }
        NotificationManager mgr = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (mgr != null) {
            mgr.cancel(NOTIFICATION_ID);
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        // Not a bound service.
        return null;
    }

    /**
     * Relay OS memory-pressure callbacks to the bionic inference host (#11760).
     * The host pins 2+ GB of GL mtrack (model weights + KV cache) while its
     * resident state exists; on the trim levels that signal real pressure
     * ({@link InferenceMemoryPolicy#shouldReleaseOnTrim}) that state is freed so
     * lmkd reclaims the memory without killing the app + agent. The release is
     * dispatched off the main thread (it blocks behind an in-flight decode) and
     * the next inference request reloads on demand — no app/agent state is lost.
     */
    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        ElizaBionicInferenceServer host = bionicInferenceServer;
        if (host == null) {
            return;
        }
        if (!InferenceMemoryPolicy.shouldReleaseOnTrim(level)) {
            Log.i(TAG, "onTrimMemory(" + level + "): keeping resident inference state");
            return;
        }
        Log.i(TAG, "onTrimMemory(" + level + "): releasing resident inference state");
        host.releaseResidentAsync("onTrimMemory level=" + level);
    }

    // ── Inference memory policy (#11760) ─────────────────────────────────

    /**
     * Debug-property override surface for on-device/emulator verification:
     * {@code adb shell setprop debug.eliza.inference.ram_class constrained} and
     * {@code … .idle_unload_ms <ms>}. Read via reflection because
     * {@code android.os.SystemProperties} is not public API; any failure just
     * means "no override".
     */
    private static String readDebugProp(String name) {
        try {
            Class<?> sp = Class.forName("android.os.SystemProperties");
            String value = (String) sp.getMethod("get", String.class).invoke(null, name);
            return value == null || value.isEmpty() ? null : value;
        } catch (Throwable ignored) {
            return null;
        }
    }

    private ActivityManager.MemoryInfo readMemoryInfo() {
        ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
        if (am != null) {
            am.getMemoryInfo(info);
        }
        return info;
    }

    /** The device's inference RAM class (debug-prop override wins). */
    private InferenceMemoryPolicy.RamClass inferenceRamClass() {
        ActivityManager.MemoryInfo info = readMemoryInfo();
        InferenceMemoryPolicy.RamClass ramClass = InferenceMemoryPolicy.classifyRamClass(
            info.totalMem, readDebugProp("debug.eliza.inference.ram_class"));
        Log.i(TAG, "inference memory policy: ramClass=" + ramClass
            + " totalMem=" + (info.totalMem >> 20) + "MB"
            + " availMem=" + (info.availMem >> 20) + "MB"
            + " lmkThreshold=" + (info.threshold >> 20) + "MB"
            + " nCtx=" + InferenceMemoryPolicy.llmContextTokens(ramClass)
            + " idleUnloadMs=" + inferenceIdleUnloadMs(ramClass));
        return ramClass;
    }

    private static long inferenceIdleUnloadMs(InferenceMemoryPolicy.RamClass ramClass) {
        return InferenceMemoryPolicy.idleUnloadMs(
            ramClass, readDebugProp("debug.eliza.inference.idle_unload_ms"));
    }

    /**
     * Construct the bionic inference host with the device's memory policy: the
     * RAM-class n_ctx default, the idle-unload timeout, and an
     * {@code ActivityManager.getMemoryInfo()}-backed pressure probe.
     */
    private ElizaBionicInferenceServer newBionicInferenceServer(String defaultBundleDir) {
        final InferenceMemoryPolicy.RamClass ramClass = inferenceRamClass();
        ElizaBionicInferenceServer.MemoryPressureProbe probe =
            new ElizaBionicInferenceServer.MemoryPressureProbe() {
                @Override
                public boolean shouldRelease() {
                    ActivityManager.MemoryInfo info = readMemoryInfo();
                    return InferenceMemoryPolicy.shouldReleaseOnAvailMem(
                        ramClass, info.availMem, info.threshold, info.lowMemory);
                }

                @Override
                public String describe() {
                    ActivityManager.MemoryInfo info = readMemoryInfo();
                    return "availMem=" + (info.availMem >> 20) + "MB threshold="
                        + (info.threshold >> 20) + "MB lowMemory=" + info.lowMemory;
                }
            };
        return new ElizaBionicInferenceServer(
            BIONIC_INFERENCE_SOCKET_NAME, defaultBundleDir, ramClass,
            inferenceIdleUnloadMs(ramClass), probe);
    }

    // ── Asset extraction ─────────────────────────────────────────────────

    /**
     * Pick the runtime ABI directory we ship binaries for. Walks
     * Build.SUPPORTED_ABIS in device-priority order so x86_64 cuttlefish
     * (which lists ["x86_64","arm64-v8a"]) doesn't wrongly pick arm64.
     */
    private String resolveRuntimeAbi() {
        String[] supported = Build.SUPPORTED_ABIS;
        if (supported != null) {
            for (String abi : supported) {
                if (
                    "arm64-v8a".equals(abi) ||
                    "x86_64".equals(abi) ||
                    "riscv64".equals(abi)
                ) return abi;
            }
            if (supported.length > 0) return supported[0];
        }
        return "arm64-v8a";
    }

    private File agentRoot() {
        return new File(getFilesDir(), AGENT_DIR_NAME);
    }

    private File agentAbiDir(String abi) {
        return new File(agentRoot(), abi);
    }

    private File agentStateDir() {
        return new File(getFilesDir(), AGENT_STATE_DIR_NAME);
    }

    /**
     * Materialise assets/agent/** into the app's data dir, crash-safely.
     *
     * <p>The extracted agent (~170 MB: agent-bundle.js + bun + ABI libs) lives
     * in {@code files/agent/}. When the installed APK changes, the new payload
     * is copied into {@code files/agent.staging/} and atomically swapped into
     * place — the old extraction is never wiped before the replacement is fully
     * staged and stamped, so an interrupted copy (ANR, LMK-kill, crash) always
     * leaves the last-good extraction bootable instead of the permanent
     * extract-failed loop of #12453. The crash-safety decision (when to swap,
     * when to keep the existing extraction, when to fail) is the pure
     * {@link ElizaAssetExtractionPolicy}; this method executes it.
     *
     * <p>Invariants: {@code .apk-stamp} is written INSIDE the staged tree so it
     * lands with the swap and never runs ahead of a completed extraction; a UI-
     * only build that lacks {@code assets/agent/*} keeps (never wipes) a valid
     * full-agent extraction; a staging failure falls back to the last-good
     * extraction rather than looping on a wipe.
     */
    private void extractAssetsIfNeeded(String abi) throws IOException {
        File filesDir = getFilesDir();
        File root = agentRoot();
        File stateDir = agentStateDir();
        File staging = new File(filesDir, AGENT_STAGING_DIR_NAME);
        File trash = new File(filesDir, AGENT_TRASH_DIR_NAME);
        if (!stateDir.exists() && !stateDir.mkdirs()) {
            throw new IOException("Could not create " + stateDir);
        }

        AssetManager assets = getAssets();

        // Recover from a swap interrupted between its two renames: the trash dir
        // still holds the last-good extraction, restore it before deciding.
        recoverInterruptedAgentSwap(root, trash);

        long pkgUpdate = computeApkUpdateTime();
        long stampedUpdate = readApkStamp(root);
        boolean apkChanged = ElizaAssetExtractionPolicy.apkChanged(pkgUpdate, stampedUpdate);
        boolean apkHasAgentAssets = apkShipsAgentAssets(assets, abi);
        boolean haveValidExtraction = extractionIsBootable(root, abi);

        ElizaAssetExtractionPolicy.Action action = ElizaAssetExtractionPolicy.decide(
            apkChanged, apkHasAgentAssets, haveValidExtraction);

        boolean staged = false;
        switch (action) {
            case STAGE_AND_SWAP:
                Log.i(TAG, "[ElizaAgentService] Refreshing agent assets via atomic staging "
                    + "(apkChanged=" + apkChanged + ", validExtraction=" + haveValidExtraction
                    + ", was=" + stampedUpdate + ", now=" + pkgUpdate + ")");
                try {
                    deleteRecursively(staging);
                    stageAgentRoot(assets, abi, pkgUpdate, staging);
                    swapStagedAgentRoot(staging, root, trash);
                    staged = true;
                    Log.i(TAG, "[ElizaAgentService] Atomic agent asset swap complete; stamp=" + pkgUpdate);
                } catch (IOException error) {
                    deleteRecursively(staging);
                    if (extractionIsBootable(root, abi)) {
                        // Fall back to the last-good extraction and leave the
                        // stamp unchanged so a later boot retries the refresh.
                        // Never loop on a wipe of a working extraction (#12453).
                        Log.e(TAG, "[ElizaAgentService] Agent asset staging failed; "
                            + "falling back to the existing last-good extraction and "
                            + "leaving the stamp at " + stampedUpdate + " so the refresh retries.",
                            error);
                    } else {
                        throw new IOException("Agent asset staging failed and no valid prior "
                            + "extraction exists to fall back to", error);
                    }
                }
                break;
            case KEEP_MISSING_ASSETS:
                // A UI-only / WebView-debug APK lacks assets/agent/* but bumped
                // the APK mtime. Wiping here would brick a working full-agent
                // install; keep it and leave the stamp so the guard re-checks.
                Log.w(TAG, "[ElizaAgentService] Installed APK ships NO assets/agent/* for abi="
                    + abi + " (UI-only build?); KEEPING the existing agent extraction rather than "
                    + "wiping it. Stamp left unchanged (was=" + stampedUpdate + ", apk=" + pkgUpdate + ").");
                break;
            case FAIL_NO_ASSETS:
                throw new IOException("Installed APK ships no assets/agent/* for abi=" + abi
                    + " and there is no valid prior extraction to boot");
            case USE_EXISTING:
            default:
                // Stamp matches and the extraction is bootable. Because the stamp
                // only advances with a completed swap, the on-disk tree is
                // complete by invariant — nothing to copy or wipe.
                break;
        }

        // Aux runtime assets live OUTSIDE the atomically-swapped agent root
        // (vector/fuzzy tarballs in files/, bundled models in .eliza/). They are
        // small and/or persistent, their partial state does not brick boot, and
        // they self-heal idempotently. Force-refresh the tarballs only when we
        // just re-staged from a full APK.
        extractAuxRuntimeAssets(assets, filesDir, stateDir, staged);
    }

    /**
     * Resolve the current APK payload timestamp. Prefers the on-disk APK mtime
     * ({@code sourceDir → File.lastModified}) over {@code lastUpdateTime}
     * because /system/priv-app installs (the AOSP image embed path) do NOT bump
     * {@code lastUpdateTime} — that field reflects pm-install + Play-update
     * events, while the APK mtime always reflects the current payload, which is
     * what invalidates a cached extraction. Returns 0 when unknown, which the
     * policy reads as "no change" (safe: it boots the existing extraction).
     */
    private long computeApkUpdateTime() {
        long pkgUpdate = 0L;
        try {
            String sourceDir = getApplicationInfo().sourceDir;
            if (sourceDir != null) {
                long apkMtime = new File(sourceDir).lastModified();
                if (apkMtime > 0L) pkgUpdate = apkMtime;
            }
            long pmUpdate = getPackageManager()
                .getPackageInfo(getPackageName(), 0).lastUpdateTime;
            if (pmUpdate > pkgUpdate) pkgUpdate = pmUpdate;
        } catch (PackageManager.NameNotFoundException error) {
            // The package cannot fail to find itself in practice; on the
            // impossible path, an unknown APK time reads as "no change".
            Log.w(TAG, "[ElizaAgentService] Could not resolve APK update time: " + error.getMessage());
        }
        return pkgUpdate;
    }

    /** Read the APK-mtime stamp from a completed extraction; 0 if absent/corrupt. */
    private long readApkStamp(File root) {
        File stamp = new File(root, AGENT_STAMP_NAME);
        if (!stamp.isFile()) {
            return 0L;
        }
        try (InputStream in = new java.io.FileInputStream(stamp)) {
            byte[] buf = new byte[64];
            int n = in.read(buf);
            if (n > 0) {
                return Long.parseLong(new String(buf, 0, n, StandardCharsets.UTF_8).trim());
            }
        } catch (IOException | NumberFormatException error) {
            Log.w(TAG, "[ElizaAgentService] Corrupt/unreadable " + AGENT_STAMP_NAME
                + "; treating extraction as stale: " + error.getMessage());
        }
        return 0L;
    }

    /** Persist the APK stamp; throws so a stamp-write failure fails the staging. */
    private void writeApkStamp(File stamp, long value) throws IOException {
        try (FileOutputStream out = new FileOutputStream(stamp)) {
            out.write(Long.toString(value).getBytes(StandardCharsets.UTF_8));
            out.flush();
        }
    }

    /**
     * Whether the installed APK actually ships the agent payload: the bundle
     * asset AND a non-empty {@code assets/agent/<abi>/} dir. False for a UI-only
     * WebView-debug build — the signal the missing-assets guard keys on.
     */
    private boolean apkShipsAgentAssets(AssetManager assets, String abi) {
        boolean bundlePresent;
        try (InputStream probe = assets.open("agent/" + AGENT_BUNDLE_NAME)) {
            bundlePresent = true;
        } catch (IOException missing) {
            bundlePresent = false;
        }
        try {
            String[] abiFiles = assets.list("agent/" + abi);
            return bundlePresent && abiFiles != null && abiFiles.length > 0;
        } catch (IOException error) {
            Log.w(TAG, "[ElizaAgentService] Could not enumerate APK agent assets for abi="
                + abi + "; treating as absent: " + error.getMessage());
            return false;
        }
    }

    /**
     * Whether an on-disk extraction can actually boot: bundle + launch.sh +
     * bun + a musl loader all present and non-empty. Mirrors the guards in
     * {@link #startAgentProcess()}, so a "valid extraction" is exactly one that
     * would pass them.
     */
    private boolean extractionIsBootable(File root, String abi) {
        File bundle = new File(root, AGENT_BUNDLE_NAME);
        if (!bundle.isFile() || bundle.length() <= 0) {
            return false;
        }
        File launch = new File(root, AGENT_LAUNCH_SCRIPT);
        if (!launch.isFile() || launch.length() <= 0) {
            return false;
        }
        File abiDir = new File(root, abi);
        File bun = new File(abiDir, BUN_BINARY);
        if (!bun.isFile() || bun.length() <= 0) {
            return false;
        }
        return findMuslLoader(abiDir) != null;
    }

    /**
     * Build a complete, ready-to-boot agent tree in {@code stagingRoot} from the
     * APK assets — every agent-root file, the ABI binaries, +x bits, and the
     * runtime symlinks — then write the {@code .apk-stamp} last so it lands only
     * on a fully-staged tree. Throws on any failure; the caller keeps the last-
     * good extraction and never swaps a partial tree into place.
     */
    private void stageAgentRoot(AssetManager assets, String abi, long pkgUpdate, File stagingRoot)
            throws IOException {
        File stagingAbiDir = new File(stagingRoot, abi);
        if (!stagingRoot.isDirectory() && !stagingRoot.mkdirs()) {
            throw new IOException("Could not create staging dir " + stagingRoot);
        }
        if (!stagingAbiDir.isDirectory() && !stagingAbiDir.mkdirs()) {
            throw new IOException("Could not create staging abi dir " + stagingAbiDir);
        }

        // Staging is fresh, so copyAssetIfMissing always copies here.
        copyAssetIfMissing(assets, "agent/" + AGENT_BUNDLE_NAME, new File(stagingRoot, AGENT_BUNDLE_NAME));
        copyAssetIfPresent(assets, "agent/" + AGENT_LAUNCH_SCRIPT, new File(stagingRoot, AGENT_LAUNCH_SCRIPT));

        // PGlite runtime assets. pglite.wasm + initdb.wasm + pglite.data sit
        // next to the bundle (`new URL("./pglite.X", import.meta.url)`).
        copyAssetIfPresent(assets, "agent/pglite.wasm", new File(stagingRoot, "pglite.wasm"));
        copyAssetIfPresent(assets, "agent/initdb.wasm", new File(stagingRoot, "initdb.wasm"));
        copyAssetIfPresent(assets, "agent/pglite.data", new File(stagingRoot, "pglite.data"));
        // Legacy ONNX Runtime Web sidecars used by the removed Android Kokoro
        // TTS path. Current AOSP TTS uses fused OmniVoice, so fresh bundles do
        // not ship these files; keep extraction best-effort for older APKs.
        copyAssetIfPresent(assets, "agent/ort-wasm-simd-threaded.mjs",
            new File(stagingRoot, "ort-wasm-simd-threaded.mjs"));
        copyAssetIfPresent(assets, "agent/ort-wasm-simd-threaded.wasm",
            new File(stagingRoot, "ort-wasm-simd-threaded.wasm"));
        copyAssetIfPresent(assets, "agent/plugins-manifest.json",
            new File(stagingRoot, "plugins-manifest.json"));

        // ABI-specific binaries: bun + musl loader + libstdc++ + libgcc.
        String abiAssetDir = "agent/" + abi;
        String[] abiFiles = assets.list(abiAssetDir);
        if (abiFiles == null || abiFiles.length == 0) {
            throw new IOException("APK is missing assets/" + abiAssetDir + " for runtime ABI " + abi);
        }
        for (String name : abiFiles) {
            try {
                copyAssetIfMissing(assets, abiAssetDir + "/" + name, new File(stagingAbiDir, name));
            } catch (java.io.FileNotFoundException error) {
                if ("libgcc_s.so.1".equals(name)) {
                    Log.w(TAG, "Optional runtime library missing from APK assets: " + abiAssetDir + "/" + name);
                    continue;
                }
                throw error;
            }
        }

        finalizeAgentAbiDir(stagingRoot, stagingAbiDir, abiFiles);

        // Stamp LAST, inside staging, so it travels with the atomic swap and
        // never gets ahead of a completed extraction.
        if (pkgUpdate > 0L) {
            writeApkStamp(new File(stagingRoot, AGENT_STAMP_NAME), pkgUpdate);
        }
    }

    /**
     * Set the +x bits and create the runtime symlinks on an extracted ABI dir.
     * The libstdc++ soname symlink is relative and the packaged-native links are
     * absolute, so both survive the staging→root rename intact.
     */
    private void finalizeAgentAbiDir(File root, File abiDir, String[] abiFiles) {
        File bun = new File(abiDir, BUN_BINARY);
        if (bun.exists()) bun.setExecutable(true, false);
        File llamaServer = new File(abiDir, "llama-server");
        if (llamaServer.exists()) llamaServer.setExecutable(true, false);
        File launch = new File(root, AGENT_LAUNCH_SCRIPT);
        if (launch.exists()) launch.setExecutable(true, false);
        for (String name : abiFiles) {
            // The musl loader (`ld-musl-<arch>.so.1`) needs +x. With the
            // SIGSYS-shim wrapper installed (x86_64 only) the original Alpine
            // loader is shipped as `ld-musl-<arch>.so.1.real` and ALSO needs +x
            // because loader-wrap execve()s it directly.
            if (name.startsWith("ld-musl-")
                && (name.endsWith(".so.1") || name.endsWith(".so.1.real"))) {
                File loader = new File(abiDir, name);
                if (loader.exists()) loader.setExecutable(true, false);
            }
        }

        boolean stdcxxLinkedFromNative = linkPackagedRuntimeLibrary(
            abiDir,
            "libstdc++.so.6",
            "libeliza_stdcpp.so"
        );
        linkPackagedRuntimeLibrary(abiDir, "libgcc_s.so.1", "libeliza_gcc_s.so");

        // bun requests `libstdc++.so.6` (the soname) at runtime, but the file we
        // shipped is the versioned realpath (`libstdc++.so.6.0.33`). Without a
        // symlink the musl loader can't find the shared object and bun crashes
        // with hundreds of "Error relocating: symbol not found" lines. Link the
        // soname to the realpath inside the same abi dir so LD_LIBRARY_PATH
        // resolution works without LD_PRELOAD.
        if (!stdcxxLinkedFromNative) {
            for (String name : abiFiles) {
                if (name.startsWith("libstdc++.so.6.")) {
                    File realPath = new File(abiDir, name);
                    File symlink = new File(abiDir, "libstdc++.so.6");
                    if (realPath.exists()) {
                        try {
                            if (java.nio.file.Files.isSymbolicLink(symlink.toPath()) && !symlink.exists()) {
                                java.nio.file.Files.deleteIfExists(symlink.toPath());
                            }
                            if (!symlink.exists() && !java.nio.file.Files.isSymbolicLink(symlink.toPath())) {
                                java.nio.file.Files.createSymbolicLink(
                                    symlink.toPath(),
                                    java.nio.file.Paths.get(name)
                                );
                            }
                        } catch (IOException error) {
                            Log.w(TAG, "Could not symlink libstdc++.so.6 → " + name + ": " + error.getMessage());
                        }
                    }
                }
            }
        }
    }

    /**
     * Atomically replace {@code root} with {@code staging}: move the current
     * extraction aside to {@code trash}, move the staged tree into place, then
     * delete the trash. There is never an instant where both the working
     * extraction is gone AND no recoverable copy exists — a crash between the
     * two renames leaves the last-good tree in {@code trash} for
     * {@link #recoverInterruptedAgentSwap} to restore on the next boot.
     */
    private void swapStagedAgentRoot(File staging, File root, File trash) throws IOException {
        deleteRecursively(trash);
        if (root.exists() && !root.renameTo(trash)) {
            throw new IOException("Could not move current agent extraction aside to " + trash);
        }
        if (!staging.renameTo(root)) {
            // Restore the last-good extraction before surfacing the failure.
            if (trash.exists() && !root.exists() && !trash.renameTo(root)) {
                Log.e(TAG, "[ElizaAgentService] Could not restore agent extraction from "
                    + trash.getName() + " after a failed swap; next boot recovers it.");
            }
            throw new IOException("Could not move staged agent extraction into place at " + root);
        }
        deleteRecursively(trash);
    }

    /**
     * Restore the last-good extraction if a prior swap died between its two
     * renames. If {@code trash} exists and {@code root} already holds a bundle,
     * the swap completed and the trash is just leftover — delete it. Otherwise
     * the working root never landed; move the trash back into place.
     */
    private void recoverInterruptedAgentSwap(File root, File trash) {
        if (!trash.isDirectory()) {
            return;
        }
        if (new File(root, AGENT_BUNDLE_NAME).exists()) {
            deleteRecursively(trash);
            Log.w(TAG, "[ElizaAgentService] Cleaned leftover " + trash.getName()
                + " from a prior interrupted asset swap; working extraction intact.");
            return;
        }
        if (root.exists()) {
            deleteRecursively(root);
        }
        if (trash.renameTo(root)) {
            Log.w(TAG, "[ElizaAgentService] Restored the last-good agent extraction from "
                + trash.getName() + " after an interrupted asset swap.");
        } else {
            Log.e(TAG, "[ElizaAgentService] Could not restore agent extraction from "
                + trash.getName() + "; a fresh extraction will be staged.");
        }
    }

    /**
     * Extract the aux runtime assets that live outside the swapped agent root:
     * the PGlite extension tarballs (files/) and bundled default models
     * (.eliza/). Both self-heal idempotently. Force-refresh the tarballs on a
     * fresh stage; never force-delete the large, persistent model files.
     */
    private void extractAuxRuntimeAssets(AssetManager assets, File filesDir, File stateDir,
            boolean forceRefreshTarballs) throws IOException {
        // vector.tar.gz / fuzzystrmatch.tar.gz must live one directory ABOVE the
        // bundle (PGlite resolves them via `new URL("../X.tar.gz", ...)`), so
        // they sit in files/ rather than the agent root. aapt2 strips the `.gz`
        // from `*.tar.gz` asset names AND decompresses them to raw tar at
        // packaging time (even with `androidResources.noCompress`), so the APK
        // entry is `vector.tar` / `fuzzystrmatch.tar`; re-gzip on extraction so
        // the on-disk file is the gzipped tarball the loader's gunzip expects
        // (raw tar → `Z_DATA_ERROR: incorrect header check` → PGlite crashloop).
        File vector = new File(filesDir, "vector.tar.gz");
        File fuzzy = new File(filesDir, "fuzzystrmatch.tar.gz");
        if (forceRefreshTarballs) {
            if (vector.exists() && !vector.delete()) Log.w(TAG, "Could not delete stale vector.tar.gz");
            if (fuzzy.exists() && !fuzzy.delete()) Log.w(TAG, "Could not delete stale fuzzystrmatch.tar.gz");
        }
        copyAssetIfPresentAsGzipped(assets, "agent/vector.tar", vector);
        copyAssetIfPresentAsGzipped(assets, "agent/fuzzystrmatch.tar", fuzzy);

        // Bundled default models (chat + embedding GGUF, staged by
        // scripts/elizaos/stage-default-models.mjs at AOSP build time). Land
        // them under $ELIZA_STATE_DIR/local-inference/models/ so the runtime's
        // first-run bootstrap discovers them at canonical paths and registers
        // them as eliza-owned models via the alongside manifest.json. Absent on
        // Capacitor (non-AOSP) builds — assets.list() returns null, treated as
        // "no models to extract".
        String modelsAssetDir = "agent/models";
        String[] modelFiles = assets.list(modelsAssetDir);
        if (modelFiles != null && modelFiles.length > 0) {
            File modelsDest = new File(new File(stateDir, "local-inference"), "models");
            if (!modelsDest.exists() && !modelsDest.mkdirs()) {
                throw new IOException("Could not create " + modelsDest);
            }
            for (String name : modelFiles) {
                copyAssetIfMissing(assets, modelsAssetDir + "/" + name, new File(modelsDest, name));
            }
            Log.i(TAG, "Extracted " + modelFiles.length + " bundled model file(s) to " + modelsDest);
        }
    }

    /**
     * Recursively delete a file tree, deleting symlinks as links (never
     * following them into their targets — the ABI dir holds symlinks into the
     * packaged nativeLibraryDir, which must not be traversed and wiped).
     */
    private void deleteRecursively(File target) {
        if (target == null) {
            return;
        }
        if (isSymlink(target)) {
            if (!target.delete()) {
                Log.w(TAG, "Could not delete symlink " + target);
            }
            return;
        }
        if (!target.exists()) {
            return;
        }
        File[] children = target.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursively(child);
            }
        }
        if (!target.delete()) {
            Log.w(TAG, "Could not delete " + target);
        }
    }

    private static boolean isSymlink(File file) {
        try {
            return java.nio.file.Files.isSymbolicLink(file.toPath());
        } catch (SecurityException error) {
            return false;
        }
    }

    /** Walk agent/{abi}/ for the musl loader; name varies by ABI. */
    private String findMuslLoader(File abiDir) {
        File[] files = abiDir.listFiles();
        if (files == null) return null;
        for (File f : files) {
            String name = f.getName();
            if (name.startsWith("ld-musl-") && name.endsWith(".so.1")) {
                return name;
            }
        }
        return null;
    }

    private File nativeLibraryDir() {
        return new File(getApplicationInfo().nativeLibraryDir);
    }

    private String packagedMuslLoaderName(String abi) {
        if ("arm64-v8a".equals(abi)) return "libeliza_ld_musl_aarch64.so";
        if ("x86_64".equals(abi)) return "libeliza_ld_musl_x86_64.so";
        if ("riscv64".equals(abi)) return "libeliza_ld_musl_riscv64.so";
        return null;
    }

    private File preferPackagedExecutable(File extractedFile, String packagedName) {
        File packaged = new File(nativeLibraryDir(), packagedName);
        if (packaged.exists() && packaged.length() > 0) {
            return packaged;
        }
        return extractedFile;
    }

    /**
     * Resolve a bundled native lib across BOTH packaging channels (#11277).
     * The legacy assets contract stages libs under assets/agent/{abi}/ (the
     * {@code abiDir} passed in, populated only when the build set
     * ELIZA_AOSP_LLAMA_ASSET_DIR*); current builds ship them as jniLibs, which
     * the installer extracts into {@link #nativeLibraryDir()}. Prefer the
     * extracted assets copy when present, else fall back to the jniLibs copy —
     * so a jniLibs-only APK still resolves the fused inference lib instead of
     * booting with no inference mode at all.
     */
    private File resolveBundledNativeLib(File abiDir, String soname) {
        File assetsCopy = new File(abiDir, soname);
        if (assetsCopy.isFile() && assetsCopy.length() > 0) {
            return assetsCopy;
        }
        return new File(nativeLibraryDir(), soname);
    }

    private boolean linkPackagedRuntimeLibrary(
        File abiDir,
        String soname,
        String packagedName
    ) {
        File packaged = new File(nativeLibraryDir(), packagedName);
        if (!packaged.exists() || packaged.length() <= 0) return false;
        File symlink = new File(abiDir, soname);
        try {
            java.nio.file.Files.deleteIfExists(symlink.toPath());
            java.nio.file.Files.createSymbolicLink(
                symlink.toPath(),
                packaged.toPath()
            );
            return true;
        } catch (IOException | UnsupportedOperationException error) {
            Log.w(TAG, "Could not symlink " + soname + " to packaged native lib: " + error.getMessage());
            return false;
        }
    }

    /**
     * Invoke `selinux.android.SELinux.restoreconRecursive` via reflection so
     * we don't take a hard compile-time dependency on the hidden API. The
     * call is best-effort: if the platform refuses it (older Android, denied
     * perm) we log and continue; the agent will run in priv_app domain and
     * the SELinux denials surface in dmesg for diagnosis.
     */
    private void relabelAgentTree(File root) {
        try {
            Class<?> selinux = Class.forName("android.os.SELinux");
            java.lang.reflect.Method restorecon = selinux.getMethod(
                "restoreconRecursive", File.class
            );
            Object result = restorecon.invoke(null, root);
            if (Boolean.FALSE.equals(result)) {
                Log.w(TAG, "SELinux.restoreconRecursive returned false for " + root);
            } else {
                Log.i(TAG, "SELinux relabel done for " + root);
            }
        } catch (ReflectiveOperationException error) {
            Log.w(TAG, "SELinux.restoreconRecursive unavailable: " + error.getMessage());
        }
    }

    private void copyAssetIfMissing(AssetManager assets, String assetPath, File target) throws IOException {
        if (target.exists() && target.length() > 0) {
            return;
        }
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("Could not create " + parent);
        }
        try (
            InputStream in = assets.open(assetPath);
            OutputStream out = new FileOutputStream(target)
        ) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                out.write(buffer, 0, read);
            }
            out.flush();
        }
    }

    /**
     * Like copyAssetIfMissing, but silently no-ops when the source asset is
     * absent. Used for optional PGlite + plugin-manifest payloads; minimal
     * mobile bundles can run without those embedded database extensions.
     */
    private void copyAssetIfPresent(AssetManager assets, String assetPath, File target) throws IOException {
        try (InputStream probe = assets.open(assetPath)) {
            // present — fall through to copy via fresh stream
        } catch (IOException missing) {
            return;
        }
        copyAssetIfMissing(assets, assetPath, target);
    }

    /**
     * Like copyAssetIfPresent, but wraps the asset bytes in a gzip stream on
     * write. Compensates for aapt2's behaviour of decompressing `.tar.gz`
     * assets at packaging time even with `androidResources.noCompress`
     * declared — the on-disk APK entry is raw tar bytes, but PGlite's
     * loader does `pipeline(createReadStream(file), createGunzip(), …)`
     * and rejects raw tar with `Z_DATA_ERROR: incorrect header check`.
     * Re-gzipping on extraction restores the contract the loader expects.
     */
    private void copyAssetIfPresentAsGzipped(AssetManager assets, String assetPath, File target) throws IOException {
        try (InputStream probe = assets.open(assetPath)) {
            // present — fall through to gzip-wrap via fresh stream
        } catch (IOException missing) {
            return;
        }
        if (target.exists() && target.length() > 0) {
            return;
        }
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("Could not create " + parent);
        }
        try (
            InputStream in = assets.open(assetPath);
            FileOutputStream raw = new FileOutputStream(target);
            java.util.zip.GZIPOutputStream gz = new java.util.zip.GZIPOutputStream(raw)
        ) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                gz.write(buffer, 0, read);
            }
            gz.flush();
        }
    }

    // ── Process lifecycle ────────────────────────────────────────────────

    /**
     * Start the in-process bionic inference host whenever the fused native lib
     * AND a local voice bundle (kokoro) are present — independent of the LLM
     * runtime mode and of whether the agent process spawns fresh or adopts a
     * surviving one.
     *
     * <p>Previously the host was started ONLY inside {@link #startAgentProcess()}'s
     * fresh-spawn {@code delegateToBionicHost} block, so after a process restart
     * that adopts a surviving agent (or when the agent runs cloud-routed) the
     * host never bound its abstract UDS, and {@code TalkMode}'s local Kokoro TTS
     * silently fell back to the system (Google) TTS. The voice host serves Kokoro
     * from {@code libelizainference} + the staged bundle and needs no LLM, so its
     * lifecycle is decoupled from agent inference here.
     *
     * <p>{@link ElizaBionicInferenceServer#start()} is idempotent and never throws
     * (it logs + returns on lib-load / socket-bind failure), so this is purely
     * additive: worst case the host stays down and TalkMode falls back to system
     * TTS exactly as before — it cannot affect agent startup.
     */
    private synchronized void ensureBionicVoiceHost() {
        if (bionicInferenceServer != null) {
            return;
        }
        File fusedLib = new File(nativeLibraryDir(), "libelizainference.so");
        if (!fusedLib.isFile()) {
            return;
        }
        File kokoroVoice = new File(getFilesDir(), "eliza-1/bundle/tts/kokoro");
        if (!kokoroVoice.isDirectory()) {
            return;
        }
        try {
            String defaultBundleDir =
                new File(getFilesDir(), "eliza-1/bundle").getAbsolutePath();
            ElizaBionicInferenceServer host = newBionicInferenceServer(defaultBundleDir);
            host.start();
            bionicInferenceServer = host;
            Log.i(TAG, "ensureBionicVoiceHost: local voice host started"
                + " (kokoro bundle present, independent of LLM mode)");
        } catch (Throwable t) {
            Log.w(TAG, "ensureBionicVoiceHost: could not start local voice host", t);
        }
    }

    private void requestAgentStart(boolean restartFirst) {
        // Bring up the local-voice (Kokoro TTS) bionic host on every service
        // start, before the agent-already-running guards below — so it binds
        // even when the agent is adopted rather than freshly spawned.
        ensureBionicVoiceHost();
        synchronized (processLock) {
            if (!restartFirst && agentProcess != null && agentProcess.isAlive()) {
                return;
            }
            if (!restartFirst
                    && detachedAgentMode
                    && ("starting".equals(currentStatus) || "running".equals(currentStatus))) {
                return;
            }
            if (startWorker != null && startWorker.isAlive()) {
                return;
            }
            currentStatus = restartFirst ? "restarting" : "starting";
            updateNotification();
            startWorker = new Thread(() -> {
                try {
                    if (restartFirst) {
                        stopAgentProcess();
                    }
                    startAgentProcess();
                } finally {
                    synchronized (processLock) {
                        startWorker = null;
                    }
                }
            }, "ElizaAgent-start");
            startWorker.start();
        }
    }

    private void startAgentProcess() {
        synchronized (processLock) {
            if (agentProcess != null && agentProcess.isAlive()) {
                return;
            }

            // Detached agents outlive the service/app process that launched
            // them. If a prior instance's agent is still bound to the loopback
            // port, ADOPT it instead of relaunching: launch.sh pkills any
            // running bun before forking a fresh one, so a needless relaunch
            // tears the live HTTP listener down for tens of seconds and the
            // WebView's /api/auth/me startup probe fails with "Backend
            // Unreachable". That is the emulator e2e churn — the Activity/FGS
            // gets recreated mid-run and onStartCommand → startAgentProcess
            // would relaunch a perfectly healthy agent. Gate on the raw socket
            // accept (not /api/health), so a bun that is alive but busy
            // mid-llama_decode — when a full request would time out — is still
            // recognised as running and left alone.
            // Adopt on the socket signal alone — not `detachedAgentMode &&`.
            // detachedAgentMode is an instance field, so a service instance
            // created after an AMS teardown / process death always sees it
            // false and would skip adoption, fall through to launch.sh, and
            // pkill a perfectly healthy surviving agent (the exact churn the
            // comment above describes). Mark the instance detached on adopt so
            // an explicit ACTION_STOP still tears the adopted agent down.
            if (isLocalAgentSocketListening()) {
                detachedAgentMode = true;
                if (!"running".equals(currentStatus)) {
                    currentStatus = "running";
                    updateNotification();
                }
                appendDiagnosticEvent("detached-agent-adopted", null);
                Log.i(TAG, "Detached agent already accepting on the request socket; adopting it (no relaunch).");
                return;
            }

            // The agent may have been launched moments ago and still be in its
            // (slow) cold boot — plugin resolution + first model load can take
            // 60-90s on an emulated CPU before bun binds the socket. During that
            // window isLocalAgentSocketListening() is false, so without this guard a
            // recreated Activity/FGS (onStartCommand fires repeatedly as the e2e
            // foregrounds/navigates) would relaunch.sh-pkill the booting bun and
            // restart the whole boot — an endless churn that never reaches ready.
            // If we launched within the boot grace window, assume it is still
            // coming up and leave it alone rather than kill + restart it.
            // The launch timestamp must survive service-instance churn: a new
            // instance created while a prior instance's agent is still cold
            // booting (port not yet bound) would otherwise see 0, skip this
            // guard, and launch.sh-pkill the booting bun. Fall back to the
            // persisted stamp written at launch (cleared on explicit stop).
            long launchStartedAt = detachedLaunchStartedAtMs > 0L
                ? detachedLaunchStartedAtMs
                : readPersistedDetachedLaunchTimestamp();
            if (launchStartedAt > 0L
                    && (System.currentTimeMillis() - launchStartedAt)
                        < AGENT_BOOT_GRACE_MS) {
                detachedAgentMode = true;
                detachedLaunchStartedAtMs = launchStartedAt;
                Map<String, String> details = new LinkedHashMap<>();
                details.put("ageMs", String.valueOf(System.currentTimeMillis() - launchStartedAt));
                details.put("bootGraceMs", String.valueOf(AGENT_BOOT_GRACE_MS));
                appendDiagnosticEvent("detached-agent-cold-boot-guard", details);
                Log.i(TAG, "Detached agent still in cold boot (launched "
                    + (System.currentTimeMillis() - launchStartedAt)
                    + "ms ago); not relaunching.");
                return;
            }

            String abi = resolveRuntimeAbi();
            try {
                extractAssetsIfNeeded(abi);
            } catch (IOException error) {
                Log.e(TAG, "Failed to extract agent assets for abi=" + abi, error);
                currentStatus = "extract-failed";
                updateNotification();
                return;
            }

            File root = agentRoot();
            File abiDir = agentAbiDir(abi);
            File bundle = new File(root, AGENT_BUNDLE_NAME);
            File launchScript = new File(root, AGENT_LAUNCH_SCRIPT);
            File bun = new File(abiDir, BUN_BINARY);
            String loaderName = findMuslLoader(abiDir);

            if (!bundle.exists()) {
                Log.e(TAG, "Agent bundle missing at " + bundle);
                currentStatus = "missing-bundle";
                updateNotification();
                return;
            }
            if (!bun.exists()) {
                Log.e(TAG, "bun binary missing at " + bun);
                currentStatus = "missing-bun";
                updateNotification();
                return;
            }
            if (!launchScript.exists()) {
                Log.e(TAG, "Agent launch script missing at " + launchScript);
                currentStatus = "missing-launcher";
                updateNotification();
                return;
            }
            if (loaderName == null) {
                Log.e(TAG, "musl loader missing under " + abiDir);
                currentStatus = "missing-loader";
                updateNotification();
                return;
            }
            File loader = new File(abiDir, loaderName);
            String packagedLoaderName = packagedMuslLoaderName(abi);
            if (packagedLoaderName != null) {
                loader = preferPackagedExecutable(loader, packagedLoaderName);
            }
            bun = preferPackagedExecutable(bun, "libeliza_bun.so");

            // Generate a fresh per-boot token for the WebView↔agent loopback.
            // Without this the loopback API would accept any local request
            // — including from other apps on the device — because the
            // agent's default isTrustedLocalRequest() heuristic treats
            // loopback as authoritative, which is wrong on multi-app
            // Android. ELIZA_REQUIRE_LOCAL_AUTH on the server side flips
            // that heuristic off so every request needs the bearer token.
            String token = generateLocalAgentToken();
            String terminalToken = generateLocalAgentToken();
            currentLocalAgentToken = token;
            currentTerminalRunToken = terminalToken;
            try {
                writeLocalAgentTokenFile(token);
            } catch (IOException error) {
                Log.w(TAG, "Failed to persist local-agent token file: " + error.getMessage());
            }

            // Invocation goes through launch.sh instead of keeping bun as a
            // Java child process. Android has repeatedly killed the direct
            // child path after ~30-50 s with SIGTRAP-like exit 133 while the
            // same runtime stays alive when it is session-detached. The
            // service still owns auth, env, foreground lifetime, and health
            // supervision; launch.sh only performs the setsid double-fork and
            // writes raw Bun stdio to agent/agent.log.
            List<String> command = new ArrayList<>();
            command.add("/system/bin/sh");
            command.add(launchScript.getAbsolutePath());

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(root);
            Map<String, String> env = pb.environment();
            Map<String, String> agentEnv = new LinkedHashMap<>();
            agentEnv.put(
                "LD_LIBRARY_PATH",
                nativeLibraryDir().getAbsolutePath() + ":" + abiDir.getAbsolutePath()
            );
            // Native voice libs (Silero VAD + WeSpeaker/pyannote voice classifier)
            // ship as jniLibs and extract into nativeLibraryDir. The on-device bun
            // agent's bun:ffi loaders (vad-ggml.ts / encoder-ggml.ts /
            // diarizer-ggml.ts) honor these env overrides; without them they fall
            // back to the repo-local CMake build dirs, which do not exist on a
            // packaged install, so live diarization would report library-missing.
            // Only export when the .so actually shipped, so a stale env never
            // points the loader at a missing path.
            File sileroVadLib = new File(nativeLibraryDir(), "libsilero_vad.so");
            File voiceClassifierLib = new File(nativeLibraryDir(), "libvoice_classifier.so");
            if (sileroVadLib.isFile() && !env.containsKey("ELIZA_SILERO_VAD_LIB")) {
                agentEnv.put("ELIZA_SILERO_VAD_LIB", sileroVadLib.getAbsolutePath());
                Log.i(TAG, "libsilero_vad.so present; exporting ELIZA_SILERO_VAD_LIB="
                    + sileroVadLib.getAbsolutePath());
            }
            if (voiceClassifierLib.isFile() && !env.containsKey("ELIZA_VOICE_CLASSIFIER_LIB")) {
                agentEnv.put("ELIZA_VOICE_CLASSIFIER_LIB", voiceClassifierLib.getAbsolutePath());
                Log.i(TAG, "libvoice_classifier.so present; exporting ELIZA_VOICE_CLASSIFIER_LIB="
                    + voiceClassifierLib.getAbsolutePath());
            }
            // Fused voice engine (#11373): the bun agent's LiveDiarizationSession
            // resolves libelizainference via ELIZA_INFERENCE_LIBRARY /
            // ELIZA_INFERENCE_LIB_DIR (see live-diarization-session.ts). The lib
            // ships as a jniLib and extracts into nativeLibraryDir, but nothing
            // exported the env var, so /api/voice/audio-frames died with
            // "fused libelizainference not found" at session construction —
            // invisible to the module-load smoke, which never builds a session.
            // Only export when the .so actually shipped (same guard as above).
            File fusedInferenceLib = new File(nativeLibraryDir(), "libelizainference.so");
            if (fusedInferenceLib.isFile() && !env.containsKey("ELIZA_INFERENCE_LIBRARY")) {
                agentEnv.put("ELIZA_INFERENCE_LIBRARY", fusedInferenceLib.getAbsolutePath());
                Log.i(TAG, "libelizainference.so present; exporting ELIZA_INFERENCE_LIBRARY="
                    + fusedInferenceLib.getAbsolutePath());
            }
            agentEnv.put("AGENT_ROOT", root.getAbsolutePath());
            agentEnv.put("RUNTIME_DIR", abiDir.getAbsolutePath());
            agentEnv.put("DEVICE_DIR", abiDir.getAbsolutePath());
            agentEnv.put("LD_NAME", loaderName);
            agentEnv.put("LD_PATH", loader.getAbsolutePath());
            agentEnv.put("BUN_PATH", bun.getAbsolutePath());
            agentEnv.put("AGENT_BUNDLE", AGENT_BUNDLE_NAME);
            agentEnv.put("AGENT_BUNDLE_PATH", bundle.getAbsolutePath());
            agentEnv.put("LOG_FILE", new File(root, AGENT_LOG_NAME).getAbsolutePath());
            agentEnv.put(
                "DIAGNOSTICS_FILE",
                new File(root, AGENT_RESTART_DIAGNOSTICS_NAME).getAbsolutePath()
            );
            // Port-free by default: the WebView reaches the agent over the
            // abstract-namespace request socket below, so the agent binds NO TCP
            // listener (localAgentMode in android/bridge.ts → startEliza). The
            // port only re-opens when ELIZA_API_EXPOSE_PORT is set (dev tooling,
            // LAN access, e2e harnesses) — then the agent advertises AGENT_PORT
            // and the launch.sh PORT default applies. Passing the port env
            // unconditionally is what used to make the agent open 31337.
            if ("1".equals(env.get("ELIZA_API_EXPOSE_PORT"))
                    || "true".equalsIgnoreCase(env.get("ELIZA_API_EXPOSE_PORT"))) {
                agentEnv.put("PORT", String.valueOf(AGENT_PORT));
                agentEnv.put("ELIZA_API_PORT", String.valueOf(AGENT_PORT));
                agentEnv.put("ELIZA_API_BIND", "127.0.0.1");
                agentEnv.put("ELIZA_PORT", String.valueOf(AGENT_PORT));
                agentEnv.put("ELIZA_UI_PORT", String.valueOf(AGENT_PORT));
            }
            // The abstract-namespace request socket the agent binds and this
            // service dials (see LOCAL_AGENT_SOCKET_NAME). Both sides read the
            // same env var so the name stays in sync.
            agentEnv.put("ELIZA_LOCAL_AGENT_SOCKET", LOCAL_AGENT_SOCKET_NAME);
            agentEnv.put("ELIZA_STATE_DIR", agentStateDir().getAbsolutePath());
            agentEnv.put("ELIZA_PLATFORM", "android");
            agentEnv.put("ELIZA_MOBILE_PLATFORM", "android");
            agentEnv.put("ELIZA_STARTUP_TRACE_ID", ElizaStartupTrace.currentId());
            agentEnv.put("ELIZA_RUNTIME_MODE", "local-yolo");
            agentEnv.put("AGENT_COMMAND", "android-bridge");
            agentEnv.put("ELIZA_DISABLE_DIRECT_RUN", "1");
            // Local passwordless mode: the on-device agent trusts its own sealed
            // request socket so the single device owner never hits a login/pairing
            // gate. The per-boot bearer-token guard (ELIZA_REQUIRE_LOCAL_AUTH=1)
            // is intentionally OFF — the WebView cannot reliably present that
            // token at cold start, which otherwise dead-ends the dashboard at
            // 401 ("Connecting to backend…" forever). The token is still minted
            // and exposed via the Agent plugin for callers that opt to use it.
            agentEnv.put("ELIZA_REQUIRE_LOCAL_AUTH", "0");
            agentEnv.put("ELIZA_API_TOKEN", token);
            agentEnv.put("ELIZA_TERMINAL_RUN_TOKEN", terminalToken);
            // The Capacitor APK always hosts @elizaos/capacitor-llama in the
            // WebView, so the runtime should always be ready to broker
            // inference over the device-bridge WSS at /api/local-inference/
            // device-bridge. The WebView dials it over loopback once the
            // user picks the local runtime mode in onboarding.
            agentEnv.put("ELIZA_DEVICE_BRIDGE_ENABLED", "1");
            agentEnv.put("ELIZA_DEVICE_PAIRING_TOKEN", token);
            // CPU-only inference on a stock-Android Capacitor APK runs the
            // same on-device chat path as the AOSP variant — Snapdragon
            // 4 Gen 1 / Tensor G1 class hardware lands at 3–7 tok/s and a
            // ~4.5 k-token system prompt + 256-token reply needs the
            // same 600 s native/chat budget the bridge uses by default.
            // The upstream gate that previously bumped these (under
            // `BuildConfig.AOSP_BUILD && isBrandedDevice()` further down)
            // only fires for branded AOSP builds; stock-Android sideloads
            // get the defaults and time out on every first turn with
            // "Chat generation failed with no streamed text
            // (err=Chat generation timed out after 180000ms)". Set the
            // same 10 min budget here unconditionally so both build
            // types finish their cold first turn.
            if (!env.containsKey("ELIZA_CHAT_GENERATION_TIMEOUT_MS")) {
                agentEnv.put("ELIZA_CHAT_GENERATION_TIMEOUT_MS", "600000");
            }
            if (!env.containsKey("ELIZA_DEVICE_GENERATE_TIMEOUT_MS")) {
                agentEnv.put("ELIZA_DEVICE_GENERATE_TIMEOUT_MS", "600000");
            }
            // The mobile bridge ships the bge embedding GGUF disabled
            // by default (`ELIZA_LOCAL_EMBEDDING_ENABLED!="1"`) because
            // mmapping it alongside the chat GGUF would OOM a 4 GB
            // Moto G Play class device. With the embedding handler
            // returning the zero vector for every call, the chat-
            // augmentation document-retrieval branch never lands a
            // match above `CHAT_DOCUMENTS_THRESHOLD`, and its LLM-
            // driven query recovery fallback wastes one full
            // generate-text round-trip per turn (~60–90 s on this
            // hardware) producing queries that themselves match
            // nothing. Skip the whole augmentation path when the
            // embedding handler is in the disabled state.
            if (!env.containsKey("ELIZA_DOCUMENT_AUGMENTATION_DISABLED")
                    && !"1".equals(env.get("ELIZA_LOCAL_EMBEDDING_ENABLED"))) {
                agentEnv.put("ELIZA_DOCUMENT_AUGMENTATION_DISABLED", "1");
            }
            // Skip the auto-download of recommended GGUF models that
            // mobile-device-bridge-bootstrap kicks off at registration
            // time. On Android the bun process cannot reach the network
            // without specific SELinux carve-outs and the download fail
            // cascades into a mid-init crash with no stderr captured
            // (agent.log empty, no exit code). The WebView side handles
            // model selection + persistence; the bun process only needs
            // the bridge handlers registered, not pre-warmed.
            agentEnv.put("ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD", "1");
            // Native bun:ffi inference path. When the APK bundles the eliza
            // llama.cpp fork's fused native lib under agent/{abi}/
            // (libelizainference.so), opt the bun process into loading it
            // directly via bun:ffi — see
            // eliza/plugins/plugin-aosp-local-inference/src/aosp-local-inference-bootstrap.ts
            // (tryBuildAospFusedTextLoader) and aosp-llama-paths.ts
            // (isAospEnabled reads ELIZA_LOCAL_LLAMA).
            // This is required, not optional: the eliza-1 model tiers are
            // Gemma-4-arch GGUFs (TurboQuant-quantized; stock f16/q8_0 KV — the
            // legacy QJL/PolarQuant/TBQ KV kernels are retired post-#9033), and
            // the stock llama-cpp-capacitor JNI lib cannot load those GGUFs at
            // all (`context->loadModel() returned false`). The fused
            // libelizainference.so carries the kernels + Gemma arch and is
            // the SOLE text/voice native library the bun agent loads.
            //
            // This was previously gated on `BuildConfig.AOSP_BUILD &&
            // isBrandedDevice()`. That gate's sole rationale was the
            // aosp loader's first-run model auto-download crashing a
            // network-restricted bun process — but that download is already
            // suppressed unconditionally above
            // (ELIZA_DISABLE_MODEL_AUTO_DOWNLOAD=1), and the loader itself
            // self-gates + defensively no-ops when the lib is absent or
            // incompatible. Presence of the bundled fused lib is therefore
            // the correct, sufficient signal for both build types.
            //
            // libelizainference.so is the lib actually dlopen'd at runtime;
            // libllama.so is kept as a legacy OR-condition so the gate still
            // activates on any APK that predates the fused-lib cutover (where
            // only libllama.so + shim were staged). Once libllama.so stops
            // being built the fused lib alone trips the gate.
            //
            // The libs ship through TWO packaging channels and the gate must
            // accept either (#11277): the legacy assets contract stages them
            // under assets/agent/{abi}/ (extracted into abiDir above, only
            // populated when the build host set ELIZA_AOSP_LLAMA_ASSET_DIR*),
            // while current builds ship them as jniLibs, extracted by the
            // installer into nativeLibraryDir() — the same dir LD_LIBRARY_PATH
            // and the voice host (ensureBionicVoiceHost) already use. Gating
            // on abiDir alone left jniLibs-only APKs with NO inference mode at
            // all: no bionic delegation, no ELIZA_LOCAL_LLAMA — the agent booted
            // with only the (unattachable) device bridge and every chat turn
            // failed with DEVICE_DISCONNECTED.
            File abiFusedInference =
                resolveBundledNativeLib(abiDir, "libelizainference.so");
            File abiLibllama = resolveBundledNativeLib(abiDir, "libllama.so");
            File abiLlamaShim =
                resolveBundledNativeLib(abiDir, "libeliza-llama-shim.so");
            File abiGgmlVulkan =
                resolveBundledNativeLib(abiDir, "libggml-vulkan.so");
            boolean fusedInferenceBundled = abiFusedInference.isFile();
            boolean legacyLibllamaBundled = abiLibllama.isFile() && abiLlamaShim.isFile();
            boolean nativeLlamaBundled = fusedInferenceBundled || legacyLibllamaBundled;
            boolean brandedAospBuild = BuildConfig.AOSP_BUILD && isBrandedDevice();
            // When the dynamic-Vulkan fused lib is staged (libelizainference.so +
            // libggml-vulkan.so), the GPU is only reachable from THIS bionic app
            // process — the musl agent's ld can't load libvulkan's HIDL closure
            // (project_android_gpu_vulkan_wall). So instead of pointing the musl
            // agent at the bun:ffi AOSP loader (ELIZA_LOCAL_LLAMA=1 → the wall),
            // delegate inference over an abstract-namespace UDS to the in-process
            // ElizaBionicInferenceServer, which runs libelizainference on the Mali
            // GPU. The musl agent never tries to load the native lib itself.
            // The bionic host is served through the fused-voice JNI bridge
            // (libelizavoicejni.so, ElizaVoiceNative → ElizaBionicInferenceServer).
            // That bridge is only built by the app's externalNativeBuild when the
            // staged libelizainference.so carries the fused-voice symbols; a build
            // whose prebuilt lib lacks them silently ships WITHOUT the bridge (see
            // build.gradle). Requiring it here means we never advertise a
            // bionic-host serving path the server cannot actually stand up — the
            // musl agent would otherwise register capacitor-llama handlers "(via
            // bionic-host)" against a socket that never binds, and every turn
            // would fail with a cryptic "bionic socket error: connect ENOENT".
            boolean bionicJniBridgeBundled =
                resolveBundledNativeLib(abiDir, "libelizavoicejni.so").isFile();
            boolean delegateToBionicHost =
                fusedInferenceBundled && abiGgmlVulkan.isFile() && bionicJniBridgeBundled;
            // #11760: export the device RAM class + idle-unload default so the
            // bun agent's in-process loader (plugin-aosp-local-inference) applies
            // the same inference memory policy as the bionic host. Operator env
            // always wins.
            InferenceMemoryPolicy.RamClass inferenceRamClass = inferenceRamClass();
            if (!env.containsKey("ELIZA_INFERENCE_RAM_CLASS")) {
                agentEnv.put("ELIZA_INFERENCE_RAM_CLASS", inferenceRamClass.wireName());
            }
            if (!env.containsKey("ELIZA_LOCAL_IDLE_UNLOAD_MS")) {
                agentEnv.put(
                    "ELIZA_LOCAL_IDLE_UNLOAD_MS",
                    String.valueOf(inferenceIdleUnloadMs(inferenceRamClass)));
            }
            if (fusedInferenceBundled && abiGgmlVulkan.isFile() && !bionicJniBridgeBundled) {
                Log.w(TAG, "agent/" + abiDir.getName()
                    + ": fused Vulkan libs are staged but libelizavoicejni.so is absent "
                    + "(this build skipped the fused-voice JNI bridge); on-device GPU "
                    + "inference via the bionic host is UNAVAILABLE. Rebuild with "
                    + "stage-elizavoice-lib.mjs to re-enable. Falling back to the "
                    + "non-delegated inference path.");
            }
            if (delegateToBionicHost) {
                agentEnv.put("ELIZA_BIONIC_HOST_DELEGATED", "1");
                agentEnv.put("ELIZA_BIONIC_INFERENCE_SOCK", BIONIC_INFERENCE_SOCKET_NAME);
                // The bionic host reloads the model per call (the fork's Vulkan
                // backend corrupts shared GPU weights on reuse), so even a
                // token-capped post-turn reflection runs ~40-60s — past the
                // 30s default post-delivery side-effect timeout. That reflection
                // is non-blocking background work (the reply is already
                // delivered), so give it room to finish and persist instead of
                // logging a spurious timeout every turn. Don't clobber an
                // explicit operator override.
                if (!agentEnv.containsKey("ELIZA_POST_DELIVERY_SIDE_EFFECT_TIMEOUT_MS")) {
                    agentEnv.put("ELIZA_POST_DELIVERY_SIDE_EFFECT_TIMEOUT_MS", "120000");
                }
                Log.i(TAG, "agent/" + abiDir.getName()
                    + "/libggml-vulkan.so present; delegating inference to the in-process"
                    + " bionic Vulkan host over UDS \"" + BIONIC_INFERENCE_SOCKET_NAME
                    + "\" (NOT taking the musl bun:ffi AOSP path)");
                // Stand up the in-process GPU inference server BEFORE the agent
                // spawns so the abstract socket is already bound when the agent's
                // BionicHostLoader first connects. Idempotent across restarts.
                if (bionicInferenceServer == null) {
                    String defaultBundleDir =
                        new File(getFilesDir(), "eliza-1/bundle").getAbsolutePath();
                    bionicInferenceServer = newBionicInferenceServer(defaultBundleDir);
                }
                // Guard the start: a failure here (e.g. the fused-voice native
                // libs failing to dlopen) must NOT leave the delegation env set,
                // or the musl agent registers dead "(via bionic-host)" handlers
                // against a socket that never binds and every turn fails. On
                // failure, retract the delegation so the caller falls through to
                // the non-delegated inference path below. UnsatisfiedLinkError is
                // an Error, not an Exception, so catch Throwable here.
                try {
                    bionicInferenceServer.start();
                } catch (Throwable startError) {
                    Log.e(TAG, "ElizaBionicInferenceServer.start() failed; disabling "
                        + "bionic-host delegation for this launch: " + startError.getMessage(),
                        startError);
                    bionicInferenceServer = null;
                    agentEnv.remove("ELIZA_BIONIC_HOST_DELEGATED");
                    agentEnv.remove("ELIZA_BIONIC_INFERENCE_SOCK");
                    delegateToBionicHost = false;
                }
            }
            if (!delegateToBionicHost && nativeLlamaBundled
                    && !env.containsKey("ELIZA_LOCAL_LLAMA")) {
                agentEnv.put("ELIZA_LOCAL_LLAMA", "1");
                String bundledLib = fusedInferenceBundled
                    ? "libelizainference.so"
                    : "libllama.so + shim (legacy)";
                Log.i(TAG, "agent/" + abiDir.getName()
                    + "/" + bundledLib + " present; enabling native bun:ffi inference (ELIZA_LOCAL_LLAMA=1)");
            }
            if (nativeLlamaBundled) {
                // When the Vulkan ggml backend (libggml-vulkan.so) is bundled —
                // i.e. the arm64 GPU build — offload the model to the GPU. The
                // aosp loader pins n_gpu_layers=0 by default, so without
                // this a Vulkan-capable build still runs entirely on CPU. CPU-
                // only builds (riscv64, or arm64 without the Vulkan backend) ship
                // no libggml-vulkan.so, so they correctly stay on CPU.
                // Skipped when delegating: the GPU offload happens in the bionic
                // host, not the musl bun:ffi path (which can't reach Vulkan).
                if (!delegateToBionicHost
                        && abiGgmlVulkan.isFile()
                        && !env.containsKey("ELIZA_AOSP_LLAMA_USE_GPU")
                        && !env.containsKey("ELIZA_LLAMA_N_GPU_LAYERS")) {
                    agentEnv.put("ELIZA_AOSP_LLAMA_USE_GPU", "true");
                    Log.i(TAG, "agent/" + abiDir.getName()
                        + "/libggml-vulkan.so present; offloading inference to GPU (ELIZA_AOSP_LLAMA_USE_GPU=true)");
                }
                if (!env.containsKey("ELIZA_MOBILE_LOCAL_DIRECT_REPLY")) {
                    agentEnv.put("ELIZA_MOBILE_LOCAL_DIRECT_REPLY", "1");
                }
                if (!env.containsKey("ELIZA_KOKORO_PREWARM")) {
                    agentEnv.put("ELIZA_KOKORO_PREWARM", "1");
                }
                if (!env.containsKey("ELIZA_KOKORO_PREWARM_DELAY_MS")) {
                    // Kokoro's first on-device ORT/WASM synthesis can be
                    // CPU-bound for tens of seconds. Keep the warmup opt-in,
                    // but schedule it well after the local HTTP server should
                    // be listening so app readiness is not blocked by audio
                    // cache priming.
                    agentEnv.put("ELIZA_KOKORO_PREWARM_DELAY_MS", "60000");
                }
                // MTP (multi-token / speculative decode) is compiled into the
                // single fused libelizainference.so (the eliza_mtp::Engine over
                // common/speculative.cpp, exported as eliza_inference_llm_mtp_supported).
                // It is controlled in-process by ELIZA_BIONIC_MTP and the FFI
                // capability probe — NOT by a separate speculative-shim .so (that
                // shim is retired and never staged). No env wiring needed here.
                if (BuildConfig.DEBUG && !env.containsKey("ELIZA_AOSP_LLAMA_DEBUG_LOG")) {
                    File debugLog = new File(agentStateDir(), "aosp-llama-debug.log");
                    agentEnv.put("ELIZA_AOSP_LLAMA_DEBUG_LOG", debugLog.getAbsolutePath());
                }
                // Mobile llama.cpp defaults for the in-process fork loader.
                // The adapter has safe fallbacks, but Java is the only layer
                // that can reliably read the Android CPU count before bun's
                // seccomp-limited runtime starts. Keep these tied to the
                // bundled fork libs, not to full-AOSP branding: the regular
                // debug APK uses the same bun:ffi path when those libs ship.
                //
                // The Eliza-1 native context is 128k. The regular debug APK
                // runs the model in-process on phone CPU, so default to a
                // small interactive context and let the adapter keep the tail
                // of oversized prompts. Full branded AOSP builds keep the
                // larger 16k context used by CVD/system smoke tests. This
                // keeps the debug APK's first message-handler prefill bounded
                // on Pixel-class devices instead of pinning bun behind a
                // multi-minute FFI call before it can answer health checks or
                // honor aborts.
                if (!env.containsKey("ELIZA_LLAMA_N_CTX")) {
                    // #11760: CONSTRAINED (5.7 GB-class) devices halve the branded
                    // context — the in-process CPU path's KV + compute buffers
                    // scale with n_ctx and contribute to the RSS that makes the
                    // app lmkd's first target. The stock APK's 4096 is already at
                    // the constrained cap.
                    String nCtx = brandedAospBuild
                        ? (inferenceRamClass == InferenceMemoryPolicy.RamClass.CONSTRAINED
                            ? "8192" : "16384")
                        : "4096";
                    agentEnv.put("ELIZA_LLAMA_N_CTX", nCtx);
                }

                if (!env.containsKey("ELIZA_LLAMA_THREADS")) {
                    int cores = Runtime.getRuntime().availableProcessors();
                    if (cores < 1) cores = 1;
                    agentEnv.put("ELIZA_LLAMA_THREADS", String.valueOf(cores));
                }

                // Keep decode chunks bounded for stock APK runs while avoiding
                // unnecessary multi-chunk prompt prefill. Pixel validation on
                // eliza-1-2b showed 256-token chunks reduce native prefill
                // time versus the older 64-token default, without blocking
                // health/startup probes because the HTTP server binds after
                // model prewarm. Branded AOSP keeps the historical 512-token
                // chunk size for its longer smoke budget.
                if (!env.containsKey("ELIZA_LLAMA_N_BATCH")) {
                    agentEnv.put("ELIZA_LLAMA_N_BATCH", brandedAospBuild ? "512" : "256");
                }
                if (!env.containsKey("ELIZA_LLAMA_N_UBATCH")) {
                    agentEnv.put("ELIZA_LLAMA_N_UBATCH", brandedAospBuild ? "512" : "256");
                }

                // Stage-1 RESPONSE_HANDLER is an internal structured planning
                // call, not the user's requested chat completion budget. On the
                // debug APK's in-process phone-CPU path, leaving it at the
                // core default (1024) lets an unconstrained or malformed local
                // decode run for minutes before the trajectory can record the
                // first stage. The AOSP adapter now honors the Stage-1 GBNF
                // grammar, so 384 tokens is ample for the HANDLE_RESPONSE
                // envelope while still bounding failure cases tightly. Full
                // branded AOSP keeps the core default unless explicitly set.
                if (!brandedAospBuild && !env.containsKey("RESPONSE_HANDLER_MAX_TOKENS")) {
                    agentEnv.put("RESPONSE_HANDLER_MAX_TOKENS", "384");
                }
                // Bound every native llama generation on debug APKs, not only
                // Stage-1. Some downstream TEXT_LARGE calls request 8192
                // tokens while the debug APK uses n_ctx=4096; without this cap
                // the adapter must reserve the whole context for output and
                // drops the prompt to a single token.
                if (!brandedAospBuild && !env.containsKey("ELIZA_LLAMA_MAX_OUTPUT_TOKENS")) {
                    agentEnv.put("ELIZA_LLAMA_MAX_OUTPUT_TOKENS", "384");
                }
            }
            if (BuildConfig.AOSP_BUILD && isBrandedDevice()) {
                agentEnv.put("ELIZA_AOSP_BUILD", "1");
                agentEnv.put("ELIZA_LOCAL_LLAMA", "1");
                // Branded AOSP unconditionally opts the bun agent into native
                // inference. If neither the fused libelizainference.so nor the
                // legacy libllama.so + shim shipped in this APK, that opt-in
                // cannot be honored — the bun agent's fused loader will fail at
                // its first TEXT_* call. Surface the broken pipeline LOUDLY here
                // (Commandment 8: no silent fallback) rather than letting the
                // failure first appear minutes later mid-inference.
                if (!nativeLlamaBundled) {
                    Log.e(TAG, "agent/" + abiDir.getName()
                        + ": branded AOSP set ELIZA_LOCAL_LLAMA=1 but no native inference lib is bundled "
                        + "(libelizainference.so absent, libllama.so + shim absent); local inference WILL fail.");
                }
                // CPU-only inference of a 12k-token prompt on cuttlefish
                // x86_64 / Eliza-1 lands well past the 180 s default
                // chat-generation timeout (chat-routes.ts). On cvd a
                // single chat turn fires the planner (9k-token prefill
                // ≈ 10 min on 4 vCPUs at 16 tok/s) plus an action
                // runner plus a reply, and the planner's structured-
                // output parser sometimes triggers a retry round.
                // Empirically end-to-end runs land at 25–45 min on cvd.
                // 60 min budget gives the smoke a full cycle to
                // complete with retries; real phone hardware
                // (Tensor / Adreno) finishes in seconds, so this only
                // matters for AOSP cvd runs.
                agentEnv.put("ELIZA_CHAT_GENERATION_TIMEOUT_MS", "3600000");
                // Device bridge is unused on AOSP (ELIZA_LOCAL_LLAMA=1 routes
                // inference through the fused libelizainference.so loader
                // instead). Set the same 1h budget explicitly so the intent is clear and
                // operator overrides above are not inadvertently in effect.
                agentEnv.put("ELIZA_DEVICE_GENERATE_TIMEOUT_MS", "3600000");

                // Native llama.cpp ctx/thread/batch defaults are applied above
                // whenever the fork libs are bundled. Full AOSP only needs
                // its longer timeout budget here.
            }
            agentEnv.put("HOME", getFilesDir().getAbsolutePath());
            if (!env.containsKey("TMPDIR")) {
                agentEnv.put("TMPDIR", getCacheDir().getAbsolutePath());
            }
            agentEnv.put("SHELL", "/system/bin/sh");
            agentEnv.put("CODING_TOOLS_SHELL", "/system/bin/sh");
            agentEnv.put("SHELL_ALLOWED_DIRECTORY", agentStateDir().getAbsolutePath());
            agentEnv.put("CODING_TOOLS_WORKSPACE_ROOTS", agentStateDir().getAbsolutePath());
            String inheritedPath = env.get("PATH");
            StringBuilder pathBuilder = new StringBuilder();
            pathBuilder.append(abiDir.getAbsolutePath()).append("/bin");
            pathBuilder.append(":").append(abiDir.getAbsolutePath());
            pathBuilder.append(":").append(new File(root, "tools/bin").getAbsolutePath());
            pathBuilder.append(":").append(new File(root, "bin").getAbsolutePath());
            pathBuilder.append(":/system/bin:/system/xbin:/vendor/bin:/apex/com.android.runtime/bin");
            if (inheritedPath != null && !inheritedPath.trim().isEmpty()) {
                pathBuilder.append(":").append(inheritedPath);
            }
            agentEnv.put("PATH", pathBuilder.toString());

            // ── No-terminal env hints for bun's stdio probe ───────────────
            // Untrusted-app SELinux policy denies `ioctl(TIOCGWINSZ)` on
            // both app_data_file and the Java-pipe fifo with `permissive=0`.
            // Bun's stdio init calls `ioctl(stdout, TIOCGWINSZ)` to detect
            // terminal width; on EACCES it has historically returned mid-
            // init without writing any diagnostic, leaving agent.log empty
            // and the watchdog probing a non-existent listener. The env
            // hints below put bun on its non-terminal path so it does not
            // bother probing — TERM=dumb gates the terminfo lookups,
            // NO_COLOR=1 + FORCE_COLOR=0 disable the ANSI emitter, and
            // CI=1 routes through bun's CI-mode logger (no progress bars,
            // no spinners, no width detection).
            agentEnv.put("TERM", "dumb");
            agentEnv.put("NO_COLOR", "1");
            agentEnv.put("FORCE_COLOR", "0");
            agentEnv.put("CI", "1");

            // ── Android seccomp compatibility (SIGSYS / code 159 fix) ──────
            //
            // Android's zygote installs a seccomp-bpf filter on every app
            // process via `seccomp_set_policy()` in
            // frameworks/base/core/jni/com_android_internal_os_Zygote.cpp,
            // sourced from the per-arch allowlists in
            // bionic/libc/seccomp/{x86_64,arm64}_app_policy.cpp. The filter is
            // inherited and locked by SECCOMP_FILTER_FLAG_TSYNC; a child
            // process spawned via fork+execve (which is how this service
            // launches bun via ProcessBuilder) cannot opt out. SELinux
            // policy in vendor/eliza/sepolicy/ is orthogonal — it does
            // not (and cannot) override seccomp.
            //
            // Bun's Linux runtime exercises several syscalls that Android's
            // seccomp filter blocks for app domains:
            //   - `io_uring_setup` / `io_uring_enter` / `io_uring_register`
            //     (bun's IO pool; not on Android's app allowlist)
            //   - `pidfd_open` (bun uses it for child-process waiting; not
            //     on the app allowlist before Android 13 / API 33, and
            //     gated behind `pidfd_open` allow on newer policy)
            //   - `preadv2` / `pwritev2` with `RWF_NONBLOCK` (bun's
            //     async-fs path; some Android kernels gate the flag arg)
            //
            // Empirically the agent bundle exit-trapped on SIGSYS (signal
            // 31, exit code 128 + 31 = 159) at first interpretation of
            // user code. The four BUN_FEATURE_FLAG_* knobs below opt bun
            // into its more conservative fallbacks for each of those
            // syscalls. They are intentionally redundant: enabling all four
            // costs nothing and protects against future bun versions that
            // start using a previously-unused gated syscall.
            //
            // BUN_FEATURE_FLAG_DISABLE_IO_POOL=1
            //     Replaces bun's io_uring-backed IO pool with the legacy
            //     thread-pool implementation. Avoids io_uring_* entirely.
            //
            // BUN_FEATURE_FLAG_FORCE_WAITER_THREAD=1
            //     Forces the dedicated waiter-thread child reaper instead
            //     of pidfd_open + epoll. Avoids pidfd_open.
            //
            // BUN_FEATURE_FLAG_DISABLE_RWF_NONBLOCK=1
            //     Drops RWF_NONBLOCK from preadv2/pwritev2 calls so bun
            //     stays on flags Android's seccomp predates. Costs us
            //     nothing on Android (the kernel runs the same fallback).
            //
            // BUN_FEATURE_FLAG_DISABLE_SPAWNSYNC_FAST_PATH=1
            //     Forces bun's portable spawn fast path off so any
            //     vfork/clone3 variants the seccomp filter blocks aren't
            //     attempted.
            //
            // To diagnose a future SIGSYS regression on a real boot:
            //   adb logcat -d | grep -E '(SIGSYS|seccomp|audit:.*type=1326)'
            //   adb shell dmesg | grep -E '(seccomp|SIGSYS)'
            // The audit line includes `syscall=N`; map it via
            //   bionic/libc/kernel/uapi/asm-generic/unistd.h or
            //   https://chromium.googlesource.com/aosp/platform/bionic/+/refs/heads/master/libc/SYSCALLS.TXT
            // and either add a new BUN_FEATURE_FLAG_* knob or open a bun
            // issue if the call has no fallback.
            agentEnv.put("BUN_FEATURE_FLAG_DISABLE_IO_POOL", "1");
            agentEnv.put("BUN_FEATURE_FLAG_FORCE_WAITER_THREAD", "1");
            agentEnv.put("BUN_FEATURE_FLAG_DISABLE_RWF_NONBLOCK", "1");
            agentEnv.put("BUN_FEATURE_FLAG_DISABLE_SPAWNSYNC_FAST_PATH", "1");
            // BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER=1
            //     Forces bun's transpiler to run on the main thread
            //     instead of the async worker pool. The worker pool
            //     uses pthread + futex_waitv (added in 5.16) which
            //     Android's app seccomp policy blocks on most kernels
            //     before API 34. Disables the worker thread spawn
            //     entirely — the transpiler still runs, just inline.
            //
            // NOTE: Do NOT set BUN_FEATURE_FLAG_DISABLE_MEMFD=1 here.
            // memfd_create IS on Android's app seccomp allowlist
            // (verified API 30+), and bun's JSC tier uses memfd as
            // the W^X dual-mapping mechanism for JIT code pages.
            // Disabling memfd forces JSC to fall back to raw RWX
            // mmap, which IS blocked by SELinux execmem on platform_app
            // — that combination kills bun before any log line is
            // written. Tested empirically: with the 43 MB agent-bundle,
            // DISABLE_MEMFD=1 produces an early SIGSYS during JIT init;
            // with memfd allowed, bun reaches PGlite + listener.
            agentEnv.put("BUN_FEATURE_FLAG_DISABLE_ASYNC_TRANSPILER", "1");

            // ── No on-device prompt-optimization / training ────────────
            //
            // The runtime ships with a trajectory-driven prompt-optimization
            // pipeline (MIPRO / GEPA / bootstrap-fewshot via the native
            // backend). On boot, OptimizedPromptService kicks off a one-
            // shot bootstrap when accumulated trajectories cross threshold,
            // and the cron auto-trainer dispatches further rounds in the
            // background. None of that belongs on a phone or a privileged
            // system app:
            //   - MIPRO/GEPA spawn coding sub-agents (PTY-backed bash) that
            //     blow past the bun seccomp envelope this service builds.
            //   - The trajectory writer fans out to the trajectories table
            //     under PGlite which already churns the device flash.
            //   - On AOSP cvd we want a deterministic agent binary, not
            //     one that mutates its prompts mid-smoke.
            //
            // Hard-disable the bootstrap so the agent never spins up a
            // training round on-device. Keep trajectory persistence available
            // in debug APKs: Android local-llama bringup depends on the
            // per-turn trace files as the ground-truth failure record. Release
            // builds keep the historical opt-out unless an operator overrides
            // the env explicitly.
            agentEnv.put("ELIZA_DISABLE_AUTO_BOOTSTRAP", "1");
            if (!env.containsKey("ELIZA_DISABLE_TRAJECTORY_LOGGING")) {
                agentEnv.put("ELIZA_DISABLE_TRAJECTORY_LOGGING", BuildConfig.DEBUG ? "0" : "1");
            }

            // ── Vault passphrase ──────────────────────────────────────
            // The runtime's vault-bootstrap mirrors process.env secrets
            // through @elizaos/vault, which on a headless Linux host
            // (Android counts: no reachable D-Bus session) refuses the
            // OS keychain and demands ELIZA_VAULT_PASSPHRASE (≥12 chars)
            // to derive a master key. Without it the bootstrap fails
            // and startEliza() throws "[vault-bootstrap] all 1 secret
            // writes failed; vault unreachable", which the watchdog
            // interprets as a crash and restart-loops the agent.
            //
            // Derive a per-install stable passphrase from ANDROID_ID
            // (Settings.Secure.ANDROID_ID — 16 hex chars, per-app-install
            // on Android 8+, stable across reboots and OS updates).
            // Prefix with a constant so the value is always ≥12 chars
            // even if ANDROID_ID is unexpectedly short or null. The
            // resulting passphrase is opaque to the user and is only
            // ever stored in memory in the spawned bun process.
            //
            // Operators can override by setting ELIZA_VAULT_PASSPHRASE
            // in the parent service env (e.g. for a deterministic dev
            // passphrase across reinstalls).
            if (!env.containsKey("ELIZA_VAULT_PASSPHRASE")) {
                String androidId = Settings.Secure.getString(
                    getContentResolver(),
                    Settings.Secure.ANDROID_ID
                );
                if (androidId == null || androidId.length() < 8) {
                    androidId = "fallback-" + Build.SERIAL;
                }
                agentEnv.put(
                    "ELIZA_VAULT_PASSPHRASE",
                    "elizaos-android-vault-" + androidId
                );
            }

            // Default to info-level logging so plugin resolution + listen
            // progress is visible in agent.log. The runtime defaults to
            // `error` which leaves boot hangs invisible. Operators can
            // override by setting LOG_LEVEL in the parent service env.
            if (!env.containsKey("LOG_LEVEL")) {
                agentEnv.put("LOG_LEVEL", "info");
            }

            env.putAll(agentEnv);

            // ── Stdio redirection (TIOCGWINSZ SELinux workaround) ─────────
            // On Android `untrusted_app`, SELinux denies
            // `ioctl(fd, TIOCGWINSZ)` (cmd 0x5413) on every non-tty class
            // accessible to the app with `permissive=0`:
            //   - `pipe:[...]` (Java ProcessBuilder PIPE) → fifo_file ioctl
            //   - `/data/data/<pkg>/files/agent/agent.log` → app_data_file ioctl
            // The denial returns EACCES; bun's stdio init (or musl's
            // `__init_libc` terminal-width probe) treats the EACCES as a
            // hard failure and exits within ~100ms before any line is
            // flushed, leaving agent.log at 0 bytes and the watchdog
            // probing nothing. The one fd class that *does* allow ioctl
            // for untrusted_app is `null_device:chr_file` (rw_file_perms
            // grants ioctl, no xperm whitelist restriction). Verified
            // empirically: same ProcessBuilder spawn from `runas_app`
            // context (more permissive) reaches `/api/health 200`;
            // identical spawn from `untrusted_app` (service context)
            // dies silently on the file ioctl.
            //
            // Workaround: redirect all three fds to /dev/null so every
            // TIOCGWINSZ returns ENOTTY (kernel-level, no SELinux check
            // needed). We sacrifice stdout/stderr capture for liveness;
            // the agent runtime still writes structured logs to
            // `<stateDir>/logs/agent.log` via its own pino transport,
            // and Android's logcat captures every line emitted via
            // `Log.i(TAG, …)` from the Java side. For local debug
            // sessions that need raw bun stdio, set `ELIZA_LOG_STDOUT=1`
            // in the parent service env — that opts into the legacy
            // file-redirect path (which only works on rooted devices
            // or via `adb shell run-as`).
            File devNull = new File("/dev/null");
            pb.redirectInput(ProcessBuilder.Redirect.from(devNull));
            pb.redirectErrorStream(true);
            if ("1".equals(env.get("ELIZA_LOG_STDOUT"))) {
                File logFile = new File(root, AGENT_LOG_NAME);
                try { logFile.createNewFile(); } catch (IOException ignored) {}
                pb.redirectOutput(ProcessBuilder.Redirect.appendTo(logFile));
                Log.i(TAG, "Agent stdout/stderr capture enabled at " + logFile.getAbsolutePath());
            } else {
                pb.redirectOutput(ProcessBuilder.Redirect.to(devNull));
            }

            Process started;
            try {
                started = pb.start();
            } catch (IOException error) {
                Log.e(TAG, "Failed to spawn agent process: " + command, error);
                currentStatus = "spawn-failed";
                updateNotification();
                scheduleRestart();
                return;
            }

            agentProcess = started;
            detachedAgentMode = true;
            detachedLaunchStartedAtMs = System.currentTimeMillis();
            persistDetachedLaunchTimestamp(detachedLaunchStartedAtMs);
            // stdoutPump/stderrPump no longer needed — bun writes straight
            // to agent.log on disk via the OS-level redirect above.
            stdoutPump = null;
            stderrPump = null;
            currentStatus = "starting";
            updateNotification();
            final long startedAtMs = System.currentTimeMillis();
            final long launchStartedAtMs = detachedLaunchStartedAtMs;
            final String startupTraceId = agentEnv.get("ELIZA_STARTUP_TRACE_ID");
            final long pidForLog = safePid(started);
            Map<String, String> launchDetails = new LinkedHashMap<>();
            launchDetails.put("launcherPid", String.valueOf(pidForLog));
            launchDetails.put("abi", abi);
            launchDetails.put("delegateToBionicHost", String.valueOf(delegateToBionicHost));
            appendDiagnosticEvent("agent-launcher-started", launchDetails);
            Log.i(TAG, "Agent launcher started (pid=" + pidForLog + ").");
            // Immediate-exit watcher: bun on `untrusted_app` has been
            // observed dying within ~50ms with no stderr / no tombstone /
            // no audit hint past the standard musl init probe denials.
            // The 10-minute watchdog tick is far too slow to surface a
            // useful exit code. This thread blocks on `process.waitFor()`
            // and logs the exit value the moment the kernel reaps the
            // child, then hands off to the existing watchdog restart
            // path via scheduleRestart().
            final Process watched = started;
            Thread exitWatcher = new Thread(() -> {
                int code;
                try {
                    code = watched.waitFor();
                } catch (InterruptedException ex) {
                    Thread.currentThread().interrupt();
                    return;
                }
                long aliveMs = System.currentTimeMillis() - startedAtMs;
                boolean localAgentSocketListening = false;
                boolean checkedLocalAgentSocket = false;
                if (detachedAgentMode && code == 0) {
                    localAgentSocketListening = isLocalAgentSocketListening();
                    checkedLocalAgentSocket = true;
                }
                Map<String, String> exitDetails = new LinkedHashMap<>();
                exitDetails.put("launcherPid", String.valueOf(pidForLog));
                exitDetails.put("launcherPidAvailable", String.valueOf(pidForLog >= 0L));
                exitDetails.put("exitCode", String.valueOf(code));
                exitDetails.put("aliveMs", String.valueOf(aliveMs));
                exitDetails.put("detachedAgentMode", String.valueOf(detachedAgentMode));
                if (checkedLocalAgentSocket) {
                    exitDetails.put(
                        "localAgentSocketListening",
                        String.valueOf(localAgentSocketListening)
                    );
                    exitDetails.put("bootGraceMs", String.valueOf(AGENT_BOOT_GRACE_MS));
                    exitDetails.put(
                        "launcherCompletedBeforeSocketReady",
                        String.valueOf(!localAgentSocketListening)
                    );
                }
                appendDiagnosticEvent("agent-launcher-exited", exitDetails);
                if (detachedAgentMode && code == 0) {
                    Log.i(TAG, "Agent launcher exited after detached start (pid="
                            + pidForLog + " alive=" + aliveMs + "ms"
                            + " socketListening=" + localAgentSocketListening + ").");
                } else {
                    Log.w(TAG, "Agent process exited early (pid=" + pidForLog
                            + " code=" + code + " alive=" + aliveMs + "ms).");
                }
                boolean stillThisProcess;
                synchronized (processLock) {
                    stillThisProcess = (agentProcess == watched);
                    if (stillThisProcess) {
                        agentProcess = null;
                    }
                }
                if (stillThisProcess && !shuttingDown && detachedAgentMode && code == 0) {
                    startDetachedStartupProbe(launchStartedAtMs, startupTraceId);
                    return;
                }
                if (stillThisProcess && !shuttingDown) {
                    scheduleRestart();
                }
            }, "ElizaAgent-exit-watcher");
            exitWatcher.setDaemon(true);
            exitWatcher.start();
        }
    }

    private void stopAgentProcess() {
        Process toStop;
        Thread outPump;
        Thread errPump;
        boolean wasDetached;
        synchronized (processLock) {
            toStop = agentProcess;
            outPump = stdoutPump;
            errPump = stderrPump;
            agentProcess = null;
            stdoutPump = null;
            stderrPump = null;
            wasDetached = detachedAgentMode;
            detachedAgentMode = false;
            detachedLaunchStartedAtMs = 0L;
            currentLocalAgentToken = null;
            currentTerminalRunToken = null;
        }
        persistDetachedLaunchTimestamp(0L);
        if (wasDetached) {
            appendDiagnosticEvent("stop-detached-agent", null);
            stopDetachedAgentProcess();
        }
        if (toStop == null) {
            return;
        }
        Log.i(TAG, "Stopping agent process (pid=" + safePid(toStop) + ").");
        toStop.destroy();
        long deadline = System.currentTimeMillis() + PROCESS_TERMINATE_GRACE_MS;
        while (toStop.isAlive() && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(100);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        if (toStop.isAlive()) {
            Log.w(TAG, "Agent did not exit on SIGTERM — sending SIGKILL.");
            toStop.destroyForcibly();
        }
        if (outPump != null) outPump.interrupt();
        if (errPump != null) errPump.interrupt();
    }

    private void stopDetachedAgentProcess() {
        String abi = resolveRuntimeAbi();
        File abiDir = agentAbiDir(abi);
        File bun = preferPackagedExecutable(new File(abiDir, BUN_BINARY), "libeliza_bun.so");
        File bundle = new File(agentRoot(), AGENT_BUNDLE_NAME);
        String killCommand = "pkill -f " + shellQuote(bun.getAbsolutePath())
            + " 2>/dev/null || true; pkill -f "
            + shellQuote(bundle.getAbsolutePath()) + " 2>/dev/null || true";
        try {
            Process killer = new ProcessBuilder("/system/bin/sh", "-c", killCommand)
                .redirectInput(ProcessBuilder.Redirect.from(new File("/dev/null")))
                .redirectOutput(ProcessBuilder.Redirect.to(new File("/dev/null")))
                .redirectError(ProcessBuilder.Redirect.to(new File("/dev/null")))
                .start();
            long deadline = System.currentTimeMillis() + PROCESS_TERMINATE_GRACE_MS;
            while (killer.isAlive() && System.currentTimeMillis() < deadline) {
                Thread.sleep(100);
            }
            if (killer.isAlive()) {
                killer.destroyForcibly();
            }
        } catch (IOException error) {
            Log.w(TAG, "Failed to stop detached agent process: " + error.getMessage());
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Persist the detached-agent launch timestamp so the cold-boot guard in
     * {@link #startAgentProcess()} survives service-instance churn (AMS
     * record teardown, process restart). 0 clears the stamp; written on every
     * launch and cleared by {@link #stopAgentProcess()} (explicit stops and
     * restart-first restarts).
     */
    private void persistDetachedLaunchTimestamp(long timestampMs) {
        getSharedPreferences(EXIT_INFO_PREFS, Context.MODE_PRIVATE)
            .edit()
            .putLong(DETACHED_LAUNCH_STAMP_KEY, timestampMs)
            .apply();
    }

    private long readPersistedDetachedLaunchTimestamp() {
        return getSharedPreferences(EXIT_INFO_PREFS, Context.MODE_PRIVATE)
            .getLong(DETACHED_LAUNCH_STAMP_KEY, 0L);
    }

    private static String shellQuote(String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }

    private static final java.security.SecureRandom TOKEN_RNG = new java.security.SecureRandom();

    private static String generateLocalAgentToken() {
        byte[] bytes = new byte[32];
        TOKEN_RNG.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    /**
     * Persist the per-boot token to a UID-restricted file so a future
     * restart of the WebView (without restarting the service) can re-read
     * it without losing auth. File is mode 0600; only the app's own UID
     * can read.
     */
    private void writeLocalAgentTokenFile(String token) throws IOException {
        File dir = new File(getFilesDir(), "auth");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("Could not create " + dir);
        }
        File file = new File(dir, "local-agent-token");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(token.getBytes());
        }
        file.setReadable(false, false);
        file.setReadable(true, true);
        file.setWritable(false, false);
        file.setWritable(true, true);
    }

    private long safePid(Process process) {
        // Process#pid() is Java 9+; Android's java.lang.Process exposes it
        // since API 24. AGP's d8 desugaring on this project rejects the
        // direct call at compile time even with sourceCompatibility=21,
        // so go through reflection — pid is informational only.
        try {
            Object value = Process.class.getMethod("pid").invoke(process);
            return value instanceof Long ? (Long) value : -1L;
        } catch (ReflectiveOperationException | UnsupportedOperationException ignored) {
            return -1L;
        }
    }

    private static final class AgentChildExit {
        final long timestampMs;
        final String childPid;
        final String exitCode;

        AgentChildExit(long timestampMs, String childPid, String exitCode) {
            this.timestampMs = timestampMs;
            this.childPid = childPid;
            this.exitCode = exitCode;
        }
    }

    /**
     * Human attribution for an agent child exit code. Codes >= 128 are
     * 128+signal deaths; the three that actually occur on-device get named
     * causes so the startup card can say what happened instead of the
     * generic "transport hung" (#13475): 159 = SIGSYS is the seccomp filter
     * killing an unshimmed runtime, 137 = SIGKILL is lmkd/OOM or an explicit
     * pkill, 143 = SIGTERM is a service stop/restart landing mid-boot.
     */
    private static String describeAgentExit(String exitCode) {
        int code;
        try {
            code = Integer.parseInt(exitCode.trim());
        } catch (NumberFormatException error) {
            return "exit " + exitCode;
        }
        if (code < 128) {
            return "exit " + code;
        }
        int signal = code - 128;
        switch (signal) {
            case 31:
                return "SIGSYS (seccomp-blocked syscall - runtime built without the SIGSYS shim? #13475)";
            case 9:
                return "SIGKILL (lmkd/OOM or pkill)";
            case 15:
                return "SIGTERM (service stop/restart during boot)";
            case 11:
                return "SIGSEGV (native crash)";
            default:
                return "signal " + signal + " (exit " + code + ")";
        }
    }

    /**
     * Scan the restart-diagnostics JSONL for the newest bridge-side fatal
     * breadcrumb (`agent-fatal` / `agent-terminated-by-signal`, written by the
     * capacitor bridge) in this launch's window, so an in-process JS fatal is
     * attributed alongside the child's exit code.
     */
    private String readLatestAgentFatal(long launchStartedAtMs, String startupTraceId) {
        File log = new File(agentRoot(), AGENT_RESTART_DIAGNOSTICS_NAME);
        if (!log.isFile()) {
            return null;
        }
        long maxBytes = Math.min(log.length(), AGENT_RESTART_DIAGNOSTICS_MAX_BYTES);
        if (maxBytes <= 0L) {
            return null;
        }
        byte[] bytes = new byte[(int) maxBytes];
        int read = 0;
        try (FileInputStream input = new FileInputStream(log)) {
            while (read < bytes.length) {
                int n = input.read(bytes, read, bytes.length - read);
                if (n < 0) break;
                read += n;
            }
        } catch (IOException error) {
            // error-policy:J7 diagnostic JSONL read failures must not kill the watchdog loop.
            Log.w(TAG, "Could not read agent fatal diagnostics", error);
            return null;
        }
        String content = new String(bytes, 0, read, StandardCharsets.UTF_8);
        String latest = null;
        long cutoffMs = Math.max(0L, launchStartedAtMs - 2_000L);
        for (String line : content.split("\\n")) {
            if (line.trim().isEmpty()) {
                continue;
            }
            try {
                JSONObject json = new JSONObject(line);
                String event = json.optString("event", "");
                if (!"agent-fatal".equals(event) && !"agent-terminated-by-signal".equals(event)) {
                    continue;
                }
                long timestampMs = json.optLong("ts", 0L);
                if (timestampMs > 0L && timestampMs < cutoffMs) {
                    continue;
                }
                JSONObject details = json.optJSONObject("details");
                String eventTraceId = details != null ? details.optString("startupTraceId", "") : "";
                if (startupTraceId != null
                        && !startupTraceId.isEmpty()
                        && !eventTraceId.isEmpty()
                        && !startupTraceId.equals(eventTraceId)) {
                    continue;
                }
                String kind = details != null ? details.optString("kind", event) : event;
                String message = details != null ? details.optString("message", "") : "";
                latest = message.isEmpty() ? kind : kind + ": " + message;
            } catch (JSONException ignored) {
                // error-policy:J3 partial or malformed diagnostic lines are invalid records; keep scanning.
            }
        }
        return latest;
    }

    /**
     * Drain a process stream into the agent log file and tee to logcat.
     * One thread per stream; both exit cleanly when the stream closes
     * (process death) or the thread is interrupted.
     */
    private Thread startStreamPump(InputStream stream, File logFile, String label) {
        Thread t = new Thread(() -> {
            byte[] buf = new byte[4096];
            try (FileOutputStream logOut = new FileOutputStream(logFile, true)) {
                // Buffer raw bytes until '\n' so multi-byte UTF-8 sequences
                // are decoded intact — newline (0x0A) never appears as a
                // continuation byte in UTF-8, so splitting on it can't slice
                // a codepoint. A char-level StringBuilder with `(char)(byte
                // & 0xFF)` would mojibake non-ASCII output (emoji, CJK).
                ByteArrayOutputStream lineBuf = new ByteArrayOutputStream(256);
                int n;
                // Interrupt check goes before read(): once read() has
                // returned bytes we're committed to writing them, otherwise
                // a graceful-shutdown interrupt during a successful read
                // would silently drop the very tail this PR exists to save.
                while (!Thread.currentThread().isInterrupted() && (n = stream.read(buf)) >= 0) {
                    // Mirror raw bytes to the log immediately so a mid-write
                    // panic in the agent doesn't lose its last diagnostic.
                    // BufferedReader.readLine() dropped partial lines on
                    // crash; the byte-level pump captures everything.
                    logOut.write(buf, 0, n);
                    logOut.flush();
                    // For logcat readability, accumulate complete lines and
                    // emit them tagged. The post-loop drain below handles the
                    // unterminated tail when the stream closes mid-line.
                    for (int i = 0; i < n; i += 1) {
                        byte b = buf[i];
                        if (b == (byte) '\n') {
                            if (lineBuf.size() > 0) {
                                String line = lineBuf.toString(StandardCharsets.UTF_8.name());
                                lineBuf.reset();
                                // Strip a trailing '\r' from CRLF without
                                // a separate scan over `line`.
                                if (line.endsWith("\r")) line = line.substring(0, line.length() - 1);
                                if (!line.isEmpty()) Log.i(TAG, line);
                            }
                        } else {
                            lineBuf.write(b);
                        }
                    }
                }
                if (lineBuf.size() > 0) {
                    String tail = lineBuf.toString(StandardCharsets.UTF_8.name());
                    Log.w(TAG, tail + " <eof — no trailing newline>");
                }
            } catch (IOException error) {
                if (!shuttingDown) {
                    Log.w(TAG, "Stream pump (" + label + ") ended.", error);
                }
            }
        }, "ElizaAgent-pump-" + label);
        t.setDaemon(true);
        t.start();
        return t;
    }

    private AgentChildExit readLatestAgentChildExit(long launchStartedAtMs, String startupTraceId) {
        File log = new File(agentRoot(), AGENT_RESTART_DIAGNOSTICS_NAME);
        if (!log.isFile()) {
            return null;
        }
        long maxBytes = Math.min(log.length(), AGENT_RESTART_DIAGNOSTICS_MAX_BYTES);
        if (maxBytes <= 0L) {
            return null;
        }
        byte[] bytes = new byte[(int) maxBytes];
        int read = 0;
        try (FileInputStream input = new FileInputStream(log)) {
            while (read < bytes.length) {
                int n = input.read(bytes, read, bytes.length - read);
                if (n < 0) break;
                read += n;
            }
        } catch (IOException error) {
            // error-policy:J7 diagnostic JSONL read failures must not kill the watchdog loop.
            Log.w(TAG, "Could not read agent child diagnostics", error);
            return null;
        }
        String content = new String(bytes, 0, read, StandardCharsets.UTF_8);
        AgentChildExit latest = null;
        long cutoffMs = Math.max(0L, launchStartedAtMs - 2_000L);
        for (String line : content.split("\\n")) {
            if (line.trim().isEmpty()) {
                continue;
            }
            try {
                JSONObject json = new JSONObject(line);
                if (!"agent-child-exited".equals(json.optString("event", ""))) {
                    continue;
                }
                long timestampMs = json.optLong("ts", 0L);
                if (timestampMs > 0L && timestampMs < cutoffMs) {
                    continue;
                }
                JSONObject details = json.optJSONObject("details");
                String childPid = details != null ? details.optString("childPid", "") : "";
                String exitCode = details != null ? details.optString("exitCode", "") : "";
                String eventTraceId = details != null ? details.optString("startupTraceId", "") : "";
                if (startupTraceId != null
                        && !startupTraceId.isEmpty()
                        && !startupTraceId.equals(eventTraceId)) {
                    continue;
                }
                latest = new AgentChildExit(timestampMs, childPid, exitCode);
            } catch (JSONException ignored) {
                // error-policy:J3 partial or malformed diagnostic lines are invalid records, not healthy exits.
                // The diagnostics file is append-only and may contain a partial
                // tail while the launcher writes; ignore that one line and keep
                // scanning for complete child-exit records.
            }
        }
        return latest;
    }

    private void startDetachedStartupProbe(final long launchStartedAtMs, final String startupTraceId) {
        Thread probe = new Thread(() -> {
            long deadline = launchStartedAtMs + STARTUP_HEALTH_GRACE_MS;
            while (!shuttingDown && System.currentTimeMillis() < deadline) {
                ElizaAgentWatchdogPolicy.ProbeResult result = probeHealth();
                if (result == ElizaAgentWatchdogPolicy.ProbeResult.OK) {
                    restartAttempts = 0;
                    synchronized (processLock) {
                        if (!detachedAgentMode || detachedLaunchStartedAtMs != launchStartedAtMs) {
                            return;
                        }
                        currentStatus = "running";
                    }
                    updateNotification();
                    Log.i(TAG, "Detached agent health check passed.");
                    return;
                }
                AgentChildExit childExit = readLatestAgentChildExit(launchStartedAtMs, startupTraceId);
                if (childExit != null) {
                    String attribution = describeAgentExit(childExit.exitCode);
                    String fatal = readLatestAgentFatal(launchStartedAtMs, startupTraceId);
                    Map<String, String> details = new LinkedHashMap<>();
                    details.put("launchStartedAtMs", String.valueOf(launchStartedAtMs));
                    details.put("startupTraceId", String.valueOf(startupTraceId));
                    details.put("childExitTimestampMs", String.valueOf(childExit.timestampMs));
                    details.put("childPid", childExit.childPid);
                    details.put("exitCode", childExit.exitCode);
                    details.put("attribution", attribution);
                    if (fatal != null) {
                        details.put("agentFatal", fatal);
                    }
                    appendDiagnosticEvent("detached-agent-child-exited-before-ready", details);
                    // The death is user-visible: the status (and its
                    // notification) says WHAT killed the agent instead of
                    // leaving "starting" up until the generic timeout card.
                    synchronized (processLock) {
                        currentStatus = "agent exited: " + attribution;
                    }
                    updateNotification();
                    Log.w(TAG, "Detached agent child exited before readiness"
                        + " (pid=" + childExit.childPid
                        + " code=" + childExit.exitCode
                        + " cause=" + attribution
                        + (fatal != null ? " fatal=" + fatal : "")
                        + "). Scheduling restart.");
                    scheduleRestart();
                    return;
                }
                try {
                    Thread.sleep(STARTUP_HEALTH_POLL_MS);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            boolean stillCurrent;
            synchronized (processLock) {
                stillCurrent = detachedAgentMode && detachedLaunchStartedAtMs == launchStartedAtMs;
            }
            if (stillCurrent && !shuttingDown) {
                Log.w(TAG, "Detached agent did not become healthy within "
                    + STARTUP_HEALTH_GRACE_MS + "ms. Scheduling restart.");
                Map<String, String> details = new LinkedHashMap<>();
                details.put("startupHealthGraceMs", String.valueOf(STARTUP_HEALTH_GRACE_MS));
                appendDiagnosticEvent("detached-agent-startup-timeout", details);
                scheduleRestart();
            }
        }, "ElizaAgent-detached-startup-probe");
        probe.setDaemon(true);
        probe.start();
    }

    /**
     * Quick liveness probe for an already-running detached agent: can a
     * connection be opened to its request socket? Unlike {@link #probeHealth()}
     * this only completes the socket handshake, so it returns true even while bun
     * is busy inside a synchronous native call (mid-llama_decode) and the accept
     * loop is briefly unresponsive to a full request — precisely the state we
     * must NOT mistake for a dead agent and relaunch over. Used by {@link
     * #startAgentProcess()} to adopt a surviving detached agent instead of
     * killing + restarting it when the service/Activity is recreated.
     */
    private boolean isLocalAgentSocketListening() {
        LocalSocket socket = new LocalSocket();
        try {
            socket.connect(new LocalSocketAddress(
                LOCAL_AGENT_SOCKET_NAME, LocalSocketAddress.Namespace.ABSTRACT));
            return true;
        } catch (IOException ignored) {
            return false;
        } finally {
            closeQuietly(socket);
        }
    }

    private ElizaAgentWatchdogPolicy.ProbeResult probeHealth() {
        try {
            JSONObject payload = new JSONObject()
                .put("method", "GET")
                .put("path", "/api/health");
            JSONObject result = dispatchBufferedOverSocket(payload, (int) HEALTH_TIMEOUT_MS);
            int status = result.optInt("status", 0);
            if (status >= 200 && status < 300) {
                String body = result.optString("body", "");
                if (!isReadyHealthBody(body)) {
                    Log.w(TAG, "Agent health endpoint responded before ready: " + compactForLog(body));
                    return ElizaAgentWatchdogPolicy.ProbeResult.DEAD;
                }
                return ElizaAgentWatchdogPolicy.ProbeResult.OK;
            }
            // Non-2xx: agent process is up but not healthy/authenticated.
            // Treat as DEAD so strikes accumulate — a crash/readiness signal.
            return ElizaAgentWatchdogPolicy.ProbeResult.DEAD;
        } catch (IOException | JSONException error) {
            // The request failed (socket connect refused / read interrupt / no
            // response). If the direct child process is still alive the most
            // likely cause is bun synchronously inside a native FFI call. Detached
            // mode has no live Java child to inspect, so use a cheap connect
            // probe: an accepting socket means the detached bun is alive but too
            // busy to answer a full request; a closed socket is DEAD and the
            // startup probe/watchdog owns retry timing.
            Process current;
            boolean detached;
            synchronized (processLock) {
                current = agentProcess;
                detached = detachedAgentMode;
            }
            if (current != null && current.isAlive()) {
                return ElizaAgentWatchdogPolicy.ProbeResult.BUSY;
            }
            if (detached && isLocalAgentSocketListening()) {
                appendDiagnosticEvent("detached-agent-probe-busy-socket-open", null);
                Log.i(TAG, "Detached agent request probe failed but socket is accepting — likely mid-decode. No strike.");
                return ElizaAgentWatchdogPolicy.ProbeResult.BUSY;
            }
            return ElizaAgentWatchdogPolicy.ProbeResult.DEAD;
        }
    }

    private static boolean isReadyHealthBody(String body) {
        return ElizaAgentWatchdogPolicy.isReadyHealthBody(body);
    }

    private static String compactForLog(String value) {
        if (value == null) return "";
        String compact = value.replaceAll("\\s+", " ").trim();
        if (compact.length() <= 240) return compact;
        return compact.substring(0, 240) + "…";
    }

    private void scheduleRestart() {
        if (shuttingDown) return;
        ElizaAgentWatchdogPolicy.RestartDecision decision =
            ElizaAgentWatchdogPolicy.nextRestart(restartAttempts, MAX_RESTART_ATTEMPTS);
        if (!decision.allowed) {
            Log.e(TAG, "Agent crashed " + restartAttempts + " times — giving up. Service stopping.");
            currentStatus = "fatal";
            updateNotification();
            Map<String, String> details = new LinkedHashMap<>();
            details.put("restartAttempts", String.valueOf(restartAttempts));
            details.put("maxRestartAttempts", String.valueOf(MAX_RESTART_ATTEMPTS));
            appendDiagnosticEvent("agent-restart-give-up", details);
            stopSelf();
            return;
        }
        long backoffMs = decision.delayMs;
        restartAttempts = decision.nextRestartAttempts;
        Map<String, String> details = new LinkedHashMap<>();
        details.put("attempt", String.valueOf(restartAttempts));
        details.put("maxRestartAttempts", String.valueOf(MAX_RESTART_ATTEMPTS));
        details.put("backoffMs", String.valueOf(backoffMs));
        appendDiagnosticEvent("agent-restart-scheduled", details);
        Log.w(TAG, "Restarting agent in " + backoffMs + "ms (attempt " + restartAttempts + "/" + MAX_RESTART_ATTEMPTS + ").");
        new Thread(() -> {
            try {
                Thread.sleep(backoffMs);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                return;
            }
            if (shuttingDown) return;
            startAgentProcess();
        }, "ElizaAgent-restart").start();
    }

    private void appendDiagnosticEvent(String event, Map<String, String> details) {
        try {
            File root = agentRoot();
            if (!root.exists() && !root.mkdirs()) {
                Log.w(TAG, "Could not create agent diagnostics dir: " + root);
                return;
            }
            File log = new File(root, AGENT_RESTART_DIAGNOSTICS_NAME);
            JSONObject json = new JSONObject()
                .put("ts", System.currentTimeMillis())
                .put("event", event)
                .put("status", currentStatus)
                .put("detachedAgentMode", detachedAgentMode)
                .put("restartAttempts", restartAttempts);
            if (details != null && !details.isEmpty()) {
                JSONObject detailJson = new JSONObject();
                for (Map.Entry<String, String> entry : details.entrySet()) {
                    detailJson.put(entry.getKey(), entry.getValue());
                }
                json.put("details", detailJson);
            }
            byte[] line = (json.toString() + "\n").getBytes(StandardCharsets.UTF_8);
            synchronized (DIAGNOSTICS_LOCK) {
                if (log.isFile() && log.length() > AGENT_RESTART_DIAGNOSTICS_MAX_BYTES) {
                    if (!log.delete()) {
                        Log.w(TAG, "Could not rotate agent diagnostics log: " + log);
                    }
                }
                try (FileOutputStream out = new FileOutputStream(log, true)) {
                    out.write(line);
                }
            }
        } catch (IOException | JSONException error) {
            Log.w(TAG, "Failed to write agent restart diagnostic event " + event, error);
        }
    }

    private void logRecentApplicationExitReasons(String trigger) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return;
        }
        ActivityManager manager = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        if (manager == null) {
            return;
        }
        SharedPreferences prefs = getSharedPreferences(EXIT_INFO_PREFS, Context.MODE_PRIVATE);
        long lastSeen = prefs.getLong(EXIT_INFO_LAST_TIMESTAMP, 0L);
        long newest = lastSeen;
        List<ApplicationExitInfo> exits;
        try {
            exits = manager.getHistoricalProcessExitReasons(getPackageName(), 0, 8);
        } catch (RuntimeException error) {
            Log.w(TAG, "Could not read historical process exit reasons", error);
            return;
        }
        for (ApplicationExitInfo info : exits) {
            long timestamp = info.getTimestamp();
            if (timestamp <= lastSeen) {
                continue;
            }
            if (timestamp > newest) {
                newest = timestamp;
            }
            Map<String, String> details = new LinkedHashMap<>();
            details.put("trigger", trigger);
            details.put("timestamp", String.valueOf(timestamp));
            details.put("pid", String.valueOf(info.getPid()));
            details.put("processName", String.valueOf(info.getProcessName()));
            details.put("reason", exitReasonName(info.getReason()));
            details.put("reasonCode", String.valueOf(info.getReason()));
            details.put("status", String.valueOf(info.getStatus()));
            details.put("importance", String.valueOf(info.getImportance()));
            details.put("pssKb", String.valueOf(info.getPss()));
            details.put("rssKb", String.valueOf(info.getRss()));
            String description = info.getDescription();
            if (description != null && !description.trim().isEmpty()) {
                details.put("description", compactForLog(description));
            }
            appendDiagnosticEvent("historical-process-exit", details);
            Log.w(TAG, "Historical process exit: pid=" + info.getPid()
                + " process=" + info.getProcessName()
                + " reason=" + exitReasonName(info.getReason())
                + " status=" + info.getStatus()
                + " importance=" + info.getImportance()
                + " pssKb=" + info.getPss()
                + " rssKb=" + info.getRss()
                + (description == null || description.trim().isEmpty()
                    ? ""
                    : " description=" + compactForLog(description)));
        }
        if (newest > lastSeen) {
            prefs.edit().putLong(EXIT_INFO_LAST_TIMESTAMP, newest).apply();
        }
    }

    private static String exitReasonName(int reason) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return "UNAVAILABLE";
        }
        switch (reason) {
            case ApplicationExitInfo.REASON_ANR:
                return "ANR";
            case ApplicationExitInfo.REASON_CRASH:
                return "CRASH";
            case ApplicationExitInfo.REASON_CRASH_NATIVE:
                return "CRASH_NATIVE";
            case ApplicationExitInfo.REASON_DEPENDENCY_DIED:
                return "DEPENDENCY_DIED";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE:
                return "EXCESSIVE_RESOURCE_USAGE";
            case ApplicationExitInfo.REASON_EXIT_SELF:
                return "EXIT_SELF";
            case ApplicationExitInfo.REASON_FREEZER:
                return "FREEZER";
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE:
                return "INITIALIZATION_FAILURE";
            case ApplicationExitInfo.REASON_LOW_MEMORY:
                return "LOW_MEMORY";
            case ApplicationExitInfo.REASON_OTHER:
                return "OTHER";
            case ApplicationExitInfo.REASON_PACKAGE_STATE_CHANGE:
                return "PACKAGE_STATE_CHANGE";
            case ApplicationExitInfo.REASON_PACKAGE_UPDATED:
                return "PACKAGE_UPDATED";
            case ApplicationExitInfo.REASON_PERMISSION_CHANGE:
                return "PERMISSION_CHANGE";
            case ApplicationExitInfo.REASON_SIGNALED:
                return "SIGNALED";
            case ApplicationExitInfo.REASON_UNKNOWN:
                return "UNKNOWN";
            case ApplicationExitInfo.REASON_USER_REQUESTED:
                return "USER_REQUESTED";
            case ApplicationExitInfo.REASON_USER_STOPPED:
                return "USER_STOPPED";
            default:
                return "REASON_" + reason;
        }
    }

    // ── Watchdog ─────────────────────────────────────────────────────────

    /**
     * Polls the agent process and the local health endpoint every
     * {@link #WATCHDOG_INTERVAL_MS}. If the process died, schedule a
     * restart with exponential backoff. If the process is alive but the
     * health endpoint has been unreachable for two consecutive ticks,
     * also force a restart — the runtime is wedged.
     */
    private final class WatchdogThread extends Thread {
        private int unhealthyTicks;

        WatchdogThread() {
            super("ElizaAgent-watchdog");
            setDaemon(true);
        }

        @Override
        public void run() {
            while (!shuttingDown && !isInterrupted()) {
                try {
                    Thread.sleep(WATCHDOG_INTERVAL_MS);
                } catch (InterruptedException error) {
                    return;
                }
                if (shuttingDown) return;

                Process current;
                synchronized (processLock) {
                    current = agentProcess;
                }
                if (current == null) {
                    if (detachedAgentMode) {
                        ElizaAgentWatchdogPolicy.ProbeResult probe = probeHealth();
                        ElizaAgentWatchdogPolicy.HealthDecision decision =
                            ElizaAgentWatchdogPolicy.evaluateHealthProbe(
                                probe,
                                unhealthyTicks,
                                HEALTH_FAIL_STRIKES
                            );
                        if (probe == ElizaAgentWatchdogPolicy.ProbeResult.OK) {
                            if (unhealthyTicks > 0) {
                                Log.i(TAG, "Detached agent health restored.");
                            }
                            unhealthyTicks = decision.unhealthyTicks;
                            if (decision.resetRestartAttempts) {
                                restartAttempts = 0;
                            }
                            if (!"running".equals(currentStatus)) {
                                currentStatus = "running";
                                updateNotification();
                            }
                        } else if (probe == ElizaAgentWatchdogPolicy.ProbeResult.DEAD) {
                            unhealthyTicks = decision.unhealthyTicks;
                            Log.w(TAG, "Detached agent health probe failed ("
                                + (decision.restartRequired ? HEALTH_FAIL_STRIKES : unhealthyTicks)
                                + " consecutive).");
                            if (decision.restartRequired) {
                                scheduleRestart();
                            }
                        }
                    }
                    continue;
                }
                if (!current.isAlive()) {
                    int exit = -1;
                    try {
                        exit = current.exitValue();
                    } catch (IllegalThreadStateException ignored) {
                        // Race: marked alive between checks. Treat as dead.
                    }
                    Log.w(TAG, "Agent process exited (code=" + exit + "). Scheduling restart.");
                    synchronized (processLock) {
                        agentProcess = null;
                    }
                    unhealthyTicks = 0;
                    scheduleRestart();
                    continue;
                }

                ElizaAgentWatchdogPolicy.ProbeResult probe = probeHealth();
                ElizaAgentWatchdogPolicy.HealthDecision decision =
                    ElizaAgentWatchdogPolicy.evaluateHealthProbe(
                        probe,
                        unhealthyTicks,
                        HEALTH_FAIL_STRIKES
                    );
                if (probe == ElizaAgentWatchdogPolicy.ProbeResult.OK) {
                    if (unhealthyTicks > 0) {
                        Log.i(TAG, "Agent health restored.");
                    }
                    unhealthyTicks = decision.unhealthyTicks;
                    if (decision.resetRestartAttempts && restartAttempts > 0) {
                        // Reset backoff once the agent has been healthy for a tick.
                        restartAttempts = 0;
                    }
                    if (!"running".equals(currentStatus)) {
                        currentStatus = "running";
                        updateNotification();
                    }
                } else if (probe == ElizaAgentWatchdogPolicy.ProbeResult.BUSY) {
                    // HTTP listener didn't answer in HEALTH_TIMEOUT_MS but the
                    // bun process is still alive. The most likely cause is
                    // synchronous work inside the JS event loop — typically
                    // a long llama_decode FFI call with a 12k-token prompt
                    // on emulated CPU. We do NOT count a strike; the
                    // process is doing exactly what it should be doing.
                    // Logging is at info-level so operators can correlate
                    // decode-busy periods with apparent unresponsiveness.
                    Log.i(TAG, "Agent HTTP probe timed out but process is alive — likely mid-decode. No strike.");
                } else {
                    // ProbeResult.DEAD: process is dead, OR /api/health
                    // did not return 2xx with ready=true. Only here do we
                    // accumulate strikes toward a force-restart.
                    unhealthyTicks = decision.unhealthyTicks;
                    Log.w(TAG, "Agent health probe failed ("
                        + (decision.restartRequired ? HEALTH_FAIL_STRIKES : unhealthyTicks)
                        + " consecutive).");
                    if (decision.restartRequired) {
                        Log.w(TAG, "Agent unresponsive — force-restarting.");
                        stopAgentProcess();
                        scheduleRestart();
                    }
                }
            }
        }

    }

    // ── Notification helpers ─────────────────────────────────────────────

    private void ensureNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "Eliza Agent",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("Local Eliza agent runtime status");
        channel.setShowBadge(false);

        NotificationManager mgr = getSystemService(NotificationManager.class);
        if (mgr != null) {
            mgr.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(String title, String text) {
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent launchPending = PendingIntent.getActivity(
            this, 1, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Intent stopIntent = new Intent(this, ElizaAgentService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
            this, 2, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(launchPending)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, "Stop", stopPending)
            .build();
    }

    private void updateNotification() {
        String title;
        String text;
        switch (currentStatus) {
            case "running":
                title = "Eliza agent · Running";
                text = "On-device agent ready";
                break;
            case "starting":
                title = "Eliza agent · Starting";
                text = "Preparing on-device runtime…";
                break;
            case "fatal":
                title = "Eliza agent · Stopped";
                text = "Agent crashed repeatedly; tap to investigate";
                break;
            case "extract-failed":
                title = "Eliza agent · Asset error";
                text = "Could not unpack runtime";
                break;
            case "missing-bundle":
            case "missing-bun":
            case "missing-loader":
                title = "Eliza agent · Missing files";
                text = currentStatus;
                break;
            case "spawn-failed":
                title = "Eliza agent · Spawn failed";
                text = "Could not start runtime process";
                break;
            default:
                title = "Eliza agent";
                text = currentStatus;
                break;
        }

        Notification notification = buildNotification(title, text);
        NotificationManager mgr = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (mgr != null) {
            mgr.notify(NOTIFICATION_ID, notification);
        }
    }

    // ── Static helpers for callers ───────────────────────────────────────

    /**
     * SharedPreferences group used by Capacitor's @capacitor/preferences
     * plugin. Mirrors PreferencesConfiguration.DEFAULTS.group in v8.
     */
    private static final String CAPACITOR_PREFS_GROUP = "CapacitorStorage";

    /**
     * Storage key for the persisted mobile runtime mode. Must match
     * MOBILE_RUNTIME_MODE_STORAGE_KEY in
     * eliza/packages/app-core/src/first-run/mobile-runtime-mode.ts.
     */
    private static final String RUNTIME_MODE_KEY = "eliza:mobile-runtime-mode";

    /**
     * Whether the on-device agent should auto-start at app boot.
     *
     * - On AOSP / ElizaOS-branded devices (`ro.elizaos.product` set or any
     *   white-label fork's `ro.<brand>os.product`), the device IS the
     *   agent: always start.
     * - On stock Android, only start when the user has explicitly picked the
     *   Local runtime in the onboarding picker (mobile-runtime-mode ==
     *   "local"). Cloud, hybrid cloud, remote, tunnel, and not-yet-chosen
     *   modes do not need this service.
     */
    public static boolean shouldAutoStart(Context context) {
        return shouldAutoStartForRuntimeMode(isBrandedDevice(), readRuntimeMode(context));
    }

    static boolean shouldAutoStartForRuntimeMode(boolean brandedDevice, String mode) {
        if (brandedDevice) return true;
        return "local".equals(mode == null ? null : mode.trim());
    }

    /**
     * True once the user (or the device image) has actually committed to
     * running the on-device agent — a branded device, or a stock phone whose
     * runtime mode has been explicitly persisted by the onboarding picker.
     *
     * Distinct from {@link #shouldAutoStart}: a fresh stock install has no
     * persisted mode yet, so the user has chosen nothing. We use this to avoid
     * cold-asking for notification consent during first-run onboarding —
     * iOS-style, we ask only after there is a committed reason.
     */
    public static boolean hasCommittedRuntimeChoice(Context context) {
        return isBrandedDevice() || readRuntimeMode(context) != null;
    }

    private static boolean isBrandedDevice() {
        // AOSP / ElizaOS images set ro.elizaos.product. White-label forks
        // that use a different sysprop should override shouldAutoStart locally.
        return !readSystemProperty("ro.elizaos.product").isEmpty();
    }

    private static String readRuntimeMode(Context context) {
        try {
            return context
                .getSharedPreferences(CAPACITOR_PREFS_GROUP, Context.MODE_PRIVATE)
                .getString(RUNTIME_MODE_KEY, null);
        } catch (Exception e) {
            Log.w(TAG, "Unable to read runtime mode preference", e);
            return null;
        }
    }

    private static String readSystemProperty(String key) {
        try {
            Class<?> spClass = Class.forName("android.os.SystemProperties");
            java.lang.reflect.Method get = spClass.getMethod("get", String.class);
            Object result = get.invoke(null, key);
            return result instanceof String ? (String) result : "";
        } catch (ReflectiveOperationException | SecurityException e) {
            return "";
        }
    }

    /** Start the foreground service (safe to call repeatedly). */
    public static void start(Context context) {
        Intent intent = new Intent(context, ElizaAgentService.class);
        intent.setAction(ACTION_START);
        context.startForegroundService(intent);
    }

    /** Request a graceful stop via the ACTION_STOP intent. */
    public static void stop(Context context) {
        Intent intent = new Intent(context, ElizaAgentService.class);
        intent.setAction(ACTION_STOP);
        context.startService(intent);
    }

    /** Restart the agent process without tearing down the service. */
    public static void restart(Context context) {
        Intent intent = new Intent(context, ElizaAgentService.class);
        intent.setAction(ACTION_RESTART);
        context.startService(intent);
    }

    /** Push a status string into the foreground notification. */
    public static void updateStatus(Context context, String status) {
        Intent intent = new Intent(context, ElizaAgentService.class);
        intent.setAction(ACTION_UPDATE_STATUS);
        intent.putExtra(EXTRA_STATUS, status);
        context.startService(intent);
    }
}
