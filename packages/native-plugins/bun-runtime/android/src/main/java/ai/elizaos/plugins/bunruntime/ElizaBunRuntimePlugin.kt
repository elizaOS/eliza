package ai.elizaos.plugins.bunruntime

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale

/**
 * Android implementation of `@elizaos/capacitor-bun-runtime`.
 *
 * On iOS, the plugin hosts an embedded Bun engine (full xcframework) or
 * a JSContext compatibility bridge. On Android, Bun runs as a child process
 * managed by `ElizaAgentService` — a foreground service that handles asset
 * extraction, process lifecycle, watchdog health-checks, and crash restarts.
 *
 * This plugin therefore delegates lifecycle operations to the host app's
 * `ElizaAgentService` through the host app package (no compile-time
 * dependency on the host package) and routes all RPC calls — `sendMessage`,
 * `call`, `getStatus` — over the loopback HTTP surface that the service
 * binds on `127.0.0.1:31337`.
 *
 * Wire protocol parity with the iOS side:
 *   - `start(opts)`      → start the `ElizaAgentService`; poll readiness
 *   - `sendMessage(opts)` → POST /api/conversations/:id/messages
 *   - `getStatus()`      → GET /api/health + service state probe
 *   - `stop()`           → stop the `ElizaAgentService`
 *   - `call({ method, args })` → dispatch to the registered bridge handler
 *                          via POST /api/bridge/call (Android-specific
 *                          loopback RPC endpoint)
 *
 * The `engine` field in `GetStatusResult` is always `"bun"` on Android
 * because the Bun process is the only runtime the service supports — there
 * is no JSContext compatibility fallback on Android.
 *
 * Error handling mirrors the iOS side: transient service/process failures
 * resolve with `ok: false` + an `error` string rather than hard-rejecting,
 * so the JS caller can surface a graceful message instead of an uncaught
 * exception.
 */
@CapacitorPlugin(name = "ElizaBunRuntime")
class ElizaBunRuntimePlugin : Plugin() {

    companion object {
        private const val TAG = "ElizaBunRuntime"
        private const val LOCAL_AGENT_BASE = "http://127.0.0.1:31337"
        private const val DEFAULT_START_TIMEOUT_MS = 120_000L
        private const val POLL_INTERVAL_MS = 2_000L
        private const val DEFAULT_TIMEOUT_MS = 30_000
        private const val MAX_BODY_BYTES = 10 * 1024 * 1024 // 10 MB
    }

    // ── start ───────────────────────────────────────────────────────────────

    @PluginMethod
    fun start(call: PluginCall) {
        val startTimeoutMs = DEFAULT_START_TIMEOUT_MS

        // Spawn a background thread to:
        //   1. Start the ElizaAgentService through the host app package.
        //   2. Poll /api/health until the agent is ready or the timeout elapses.
        // We must not block the Capacitor executor thread — agent boot takes
        // 30-120 s on first launch (PGlite WASM extraction + plugin resolution).
        Thread({
            // Kick the service on this background thread — safe because
            // Context.startForegroundService is thread-safe.
            try {
                startServiceReflective()
            } catch (e: Exception) {
                android.util.Log.w(TAG, "start: could not start ElizaAgentService: ${e.message}")
            }

            val deadline = System.currentTimeMillis() + startTimeoutMs
            var lastError: String? = null
            while (System.currentTimeMillis() < deadline) {
                try {
                    val health = loopbackGet("/api/health", 5_000)
                    if (health.optBoolean("ready", false)) {
                        val result = JSObject().apply {
                            put("ok", true)
                            put("bridgeVersion", "bun-android:1")
                        }
                        call.resolve(result)
                        return@Thread
                    }
                    lastError = "health not ready: ${health.opt("state")}"
                } catch (e: Exception) {
                    lastError = e.message ?: "health probe failed"
                }
                try {
                    Thread.sleep(POLL_INTERVAL_MS)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    break
                }
            }
            val result = JSObject().apply {
                put("ok", false)
                put("error", "Android Bun runtime did not become ready within ${startTimeoutMs}ms: $lastError")
            }
            call.resolve(result)
        }, "ElizaBunRuntime-start").apply {
            isDaemon = true
            start()
        }
    }

    // ── sendMessage ─────────────────────────────────────────────────────────

    @PluginMethod
    fun sendMessage(call: PluginCall) {
        val message = call.getString("message")
        if (message.isNullOrBlank()) {
            call.reject("sendMessage requires a non-empty message string")
            return
        }
        val conversationId = call.getString("conversationId")

        Thread({
            try {
                // Resolve or create a conversation ID, then POST the message.
                val convId = conversationId?.trim()?.takeIf { it.isNotEmpty() }
                    ?: createConversation()

                val body = JSONObject().apply {
                    put("text", message)
                    put("channelType", "DM")
                }.toString()

                val path = "/api/conversations/${encodeSegment(convId)}/messages"
                val response = loopbackPost(path, body, DEFAULT_TIMEOUT_MS)
                val text = response.optString("text")
                    .takeIf { it.isNotBlank() }
                    ?: response.optString("reply")
                        .takeIf { it.isNotBlank() }
                    ?: ""

                val result = JSObject().apply {
                    put("reply", text)
                }
                call.resolve(result)
            } catch (e: Exception) {
                call.reject(e.message ?: "sendMessage failed")
            }
        }, "ElizaBunRuntime-sendMessage").apply {
            isDaemon = true
            start()
        }
    }

    // ── getStatus ───────────────────────────────────────────────────────────

    @PluginMethod
    fun getStatus(call: PluginCall) {
        Thread({
            try {
                val token = readLocalAgentToken()
                if (token == null) {
                    val result = JSObject().apply {
                        put("ready", false)
                        put("engine", "bun")
                    }
                    call.resolve(result)
                    return@Thread
                }
                val health = loopbackGet("/api/health", 5_000, token)
                val ready = health.optBoolean("ready", false)
                val result = JSObject().apply {
                    put("ready", ready)
                    put("engine", "bun")
                    put("bridgeVersion", "bun-android:1")
                    val agentName = health.optString("agentName", "")
                    if (agentName.isNotBlank()) put("model", agentName)
                }
                call.resolve(result)
            } catch (e: Exception) {
                val result = JSObject().apply {
                    put("ready", false)
                    put("engine", "bun")
                }
                call.resolve(result)
            }
        }, "ElizaBunRuntime-getStatus").apply {
            isDaemon = true
            start()
        }
    }

    // ── stop ────────────────────────────────────────────────────────────────

    @PluginMethod
    fun stop(call: PluginCall) {
        try {
            stopServiceReflective()
        } catch (e: Exception) {
            android.util.Log.w(TAG, "stop: could not stop ElizaAgentService: ${e.message}")
        }
        call.resolve()
    }

    // ── call ────────────────────────────────────────────────────────────────

    /**
     * Dispatch a named bridge-handler call into the running agent.
     *
     * The Android agent exposes a dedicated RPC endpoint at
     * `POST /api/bridge/call` that maps to the same handler registry the
     * iOS bridge populates via `bridge.ui_register_handler`. If that
     * endpoint is absent (older bundle), built-in method shortcuts cover
     * the three most critical ones: `status`, `http_request`, `send_message`.
     */
    @PluginMethod
    fun call(call: PluginCall) {
        val method = call.getString("method")
        if (method.isNullOrBlank()) {
            call.reject("call requires a method name")
            return
        }
        val args = call.getObject("args")

        Thread({
            try {
                val result = dispatchBridgeCall(method, args)
                val out = JSObject().apply {
                    put("result", result)
                }
                call.resolve(out)
            } catch (e: Exception) {
                call.reject(e.message ?: "call($method) failed")
            }
        }, "ElizaBunRuntime-call-$method").apply {
            isDaemon = true
            start()
        }
    }

    // ── Bridge dispatch ──────────────────────────────────────────────────────

    private fun dispatchBridgeCall(method: String, args: JSObject?): Any? {
        val timeoutMs = args?.getInteger("timeoutMs") ?: DEFAULT_TIMEOUT_MS

        return when (method) {
            "status" -> {
                try {
                    val health = loopbackGet("/api/health", minOf(timeoutMs, 30_000))
                    mapOf(
                        "ready" to health.optBoolean("ready", false),
                        "apiPort" to 31337,
                    )
                } catch (_: Exception) {
                    mapOf("ready" to false, "apiPort" to 0)
                }
            }

            "http_request", "http_fetch" -> {
                val reqMethod = (args?.getString("method") ?: "GET").uppercase(Locale.US)
                val path = args?.getString("path") ?: throw IllegalArgumentException("http_request requires path")
                if (!path.startsWith("/") || path.startsWith("//")) {
                    throw IllegalArgumentException("http_request path must start with /")
                }
                // args is non-null here: path was just extracted successfully
                val reqHeaders = args.getJSObject("headers")
                val reqBody = args.getString("body")
                val response = loopbackRequest(reqMethod, path, reqHeaders, reqBody, timeoutMs)
                response
            }

            "send_message" -> {
                val msg = args?.getString("message") ?: throw IllegalArgumentException("send_message requires message")
                val convId = args.getString("conversationId")?.trim()?.takeIf { it.isNotEmpty() }
                    ?: createConversation()
                val body = JSONObject().apply {
                    put("text", msg)
                    put("channelType", "DM")
                }.toString()
                val path = "/api/conversations/${encodeSegment(convId)}/messages"
                val response = loopbackPost(path, body, timeoutMs)
                mapOf(
                    "text" to (response.optString("text").takeIf { it.isNotBlank() }
                        ?: response.optString("reply", "")),
                    "reply" to (response.optString("reply").takeIf { it.isNotBlank() }
                        ?: response.optString("text", "")),
                    "conversationId" to convId,
                )
            }

            else -> {
                // Generic forward: POST /api/bridge/call with {method, args}.
                // This endpoint must be registered by the agent bundle; falls
                // back to a descriptive error if absent (HTTP 404).
                val body = JSONObject().apply {
                    put("method", method)
                    put("args", args?.toString() ?: "null")
                }.toString()
                val responseBody = loopbackPostRaw("/api/bridge/call", body, timeoutMs)
                runCatching { JSONObject(responseBody) }.getOrElse { JSONObject() }
            }
        }
    }

    // ── Service helpers ──────────────────────────────────────────────────────

    /**
     * Start the host app's `ElizaAgentService` without a compile-time
     * dependency on the host package. White-label builds can change the
     * application id, so resolve the service from the current app package
     * instead of baking in one Java package name.
     *
     * The host app registers `AgentPlugin` and keeps `ElizaAgentService` as
     * the canonical process owner. This plugin simply asks it to (re)start.
     */
    private fun startServiceReflective() {
        val ctx = context ?: return
        try {
            val serviceClassName = resolveAgentServiceClassName() ?: run {
                android.util.Log.d(TAG, "ElizaAgentService not registered in ${ctx.packageName}")
                return
            }
            val intent = Intent().apply {
                component = ComponentName(ctx.packageName, serviceClassName)
            }
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent)
            } else {
                ctx.startService(intent)
            }
        } catch (e: Exception) {
            android.util.Log.w(TAG, "Could not start ElizaAgentService: ${e.message}")
        }
    }

    private fun stopServiceReflective() {
        val ctx = context ?: return
        try {
            val serviceClassName = resolveAgentServiceClassName() ?: return
            val intent = Intent().apply {
                component = ComponentName(ctx.packageName, serviceClassName)
            }
            ctx.stopService(intent)
        } catch (e: Exception) {
            android.util.Log.w(TAG, "Could not stop ElizaAgentService: ${e.message}")
        }
    }

    /**
     * Read the per-boot bearer token written by `ElizaAgentService`. The
     * token is stored in a volatile static field (`localAgentToken()`) so we
     * access it reflectively rather than reading the auth file on disk.
     */
    private fun readLocalAgentToken(): String? {
        return try {
            val serviceClassName = resolveAgentServiceClassName() ?: return null
            val cls = Class.forName(serviceClassName)
            val m = cls.getMethod("localAgentToken")
            val token = m.invoke(null) as? String
            token?.trim()?.takeIf { it.isNotEmpty() }
        } catch (_: Exception) {
            null
        }
    }

    private fun resolveAgentServiceClassName(): String? {
        val ctx = context ?: return null
        val packageName = ctx.packageName
        val packageInfo = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            ctx.packageManager.getPackageInfo(
                packageName,
                PackageManager.PackageInfoFlags.of(PackageManager.GET_SERVICES.toLong()),
            )
        } else {
            @Suppress("DEPRECATION")
            ctx.packageManager.getPackageInfo(packageName, PackageManager.GET_SERVICES)
        }
        return packageInfo.services
            ?.firstOrNull { it.packageName == packageName && it.name.endsWith(".ElizaAgentService") }
            ?.name
    }

    // ── Loopback HTTP helpers ────────────────────────────────────────────────

    private fun loopbackGet(path: String, timeoutMs: Int, token: String? = readLocalAgentToken()): JSONObject {
        val raw = loopbackRequestRaw("GET", path, null, null, timeoutMs, token)
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    private fun loopbackGet(path: String, timeoutMs: Long, token: String? = readLocalAgentToken()): JSONObject =
        loopbackGet(path, minOf(timeoutMs, Int.MAX_VALUE.toLong()).toInt(), token)

    private fun loopbackPost(path: String, body: String, timeoutMs: Int): JSONObject {
        val raw = loopbackPostRaw(path, body, timeoutMs)
        return runCatching { JSONObject(raw) }.getOrElse { JSONObject() }
    }

    private fun loopbackPostRaw(path: String, body: String, timeoutMs: Int): String {
        return loopbackRequestRaw("POST", path, null, body, timeoutMs, readLocalAgentToken())
    }

    /** Returns (httpStatusCode, responseBodyString). */
    private fun loopbackRequestWithStatus(
        method: String,
        path: String,
        headers: JSObject?,
        body: String?,
        timeoutMs: Int,
        token: String?,
    ): Pair<Int, String> {
        val url = URL(LOCAL_AGENT_BASE + path)
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            instanceFollowRedirects = false
            useCaches = false
            setRequestProperty("Accept", "application/json")
            if (body != null) setRequestProperty("Content-Type", "application/json; charset=utf-8")
            if (token != null) setRequestProperty("Authorization", "Bearer $token")
            headers?.keys()?.forEach { key ->
                headers.getString(key)?.let { v -> setRequestProperty(key, v) }
            }
            if (body != null && method !in listOf("GET", "HEAD")) {
                doOutput = true
                outputStream.write(body.toByteArray(Charsets.UTF_8))
            }
        }
        return try {
            val status = conn.responseCode
            val stream: InputStream? = if (status >= 400) conn.errorStream else conn.inputStream
            val raw = if (stream == null) "" else {
                val out = ByteArrayOutputStream()
                var total = 0
                val buf = ByteArray(8192)
                stream.use {
                    var n = it.read(buf)
                    while (n >= 0) {
                        total += n
                        if (total > MAX_BODY_BYTES) error("Response body too large")
                        out.write(buf, 0, n)
                        n = it.read(buf)
                    }
                }
                out.toString("UTF-8")
            }
            Pair(status, raw)
        } finally {
            conn.disconnect()
        }
    }

    private fun loopbackRequest(
        method: String,
        path: String,
        headers: JSObject?,
        body: String?,
        timeoutMs: Int,
    ): Map<String, Any?> {
        val (statusCode, raw) = loopbackRequestWithStatus(method, path, headers, body, timeoutMs, readLocalAgentToken())
        // Return a structure that mirrors the iOS bridge http_request response shape.
        return mapOf(
            "status" to statusCode,
            "statusText" to statusTextForCode(statusCode),
            "body" to raw,
            "bodyBase64" to android.util.Base64.encodeToString(
                raw.toByteArray(Charsets.UTF_8),
                android.util.Base64.NO_WRAP,
            ),
            "bodyEncoding" to "utf-8",
        )
    }

    private fun statusTextForCode(status: Int): String = when (status) {
        200 -> "OK"; 201 -> "Created"; 204 -> "No Content"
        400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"
        404 -> "Not Found"; 500 -> "Internal Server Error"; 504 -> "Gateway Timeout"
        else -> ""
    }

    private fun loopbackRequestRaw(
        method: String,
        path: String,
        headers: JSObject?,
        body: String?,
        timeoutMs: Int,
        token: String?,
    ): String {
        val url = URL(LOCAL_AGENT_BASE + path)
        val conn = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            instanceFollowRedirects = false
            useCaches = false
            setRequestProperty("Accept", "application/json")
            if (body != null) {
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
            if (token != null) {
                setRequestProperty("Authorization", "Bearer $token")
            }
            headers?.keys()?.forEach { key ->
                val v = headers.getString(key)
                if (v != null) setRequestProperty(key, v)
            }
            if (body != null && method !in listOf("GET", "HEAD")) {
                doOutput = true
                outputStream.write(body.toByteArray(Charsets.UTF_8))
            }
        }

        return try {
            val status = conn.responseCode
            val stream: InputStream? = if (status >= 400) conn.errorStream else conn.inputStream
            if (stream == null) return ""
            val out = ByteArrayOutputStream()
            var total = 0
            val buf = ByteArray(8192)
            stream.use {
                var n = it.read(buf)
                while (n >= 0) {
                    total += n
                    if (total > MAX_BODY_BYTES) error("Response body too large")
                    out.write(buf, 0, n)
                    n = it.read(buf)
                }
            }
            out.toString("UTF-8")
        } finally {
            conn.disconnect()
        }
    }

    // ── Conversation helpers ──────────────────────────────────────────────────

    private fun createConversation(): String {
        val body = JSONObject().apply {
            put("title", "Android Chat")
        }.toString()
        val response = loopbackPost("/api/conversations", body, DEFAULT_TIMEOUT_MS)
        return response.optJSONObject("conversation")?.optString("id")
            ?.takeIf { it.isNotBlank() }
            ?: throw RuntimeException("Failed to create conversation: $response")
    }

    private fun encodeSegment(segment: String): String =
        java.net.URLEncoder.encode(segment, "UTF-8").replace("+", "%20")
}
