/**
 * Android Capacitor bridge to the app-owned ElizaAgentService. Lifecycle state
 * comes from the service directly, while route calls use its authenticated
 * in-process request boundary; neither path opens a second loopback client or
 * imposes a model-call wall-clock deadline.
 */
package ai.elizaos.plugins.bunruntime

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.util.Locale

@CapacitorPlugin(name = "ElizaBunRuntime")
class ElizaBunRuntimePlugin : Plugin() {

    companion object {
        private const val TAG = "ElizaBunRuntime"
        private const val LOCAL_AGENT_IPC_BASE = "eliza-local-agent://ipc"
        private const val POLL_INTERVAL_MS = 2_000L
    }

    // ── start ───────────────────────────────────────────────────────────────

    @PluginMethod
    fun start(call: PluginCall) {
        Thread({
            try {
                startServiceReflective()
                var serviceOwnedStartup = false
                while (true) {
                    val bootState = readLocalAgentBootState()
                    serviceOwnedStartup = serviceOwnedStartup ||
                        bootState.optBoolean("serviceActive", false) ||
                        bootState.getString("state") == "booting" ||
                        bootState.getString("state") == "restarting"
                    when (bootState.getString("state")) {
                        "listening" -> {
                            call.resolve(JSObject().apply {
                                put("ok", true)
                                put("bridgeVersion", "bun-android:1")
                            })
                            return@Thread
                        }
                        "dead" -> {
                            if (!serviceOwnedStartup) {
                                Thread.sleep(POLL_INTERVAL_MS)
                                continue
                            }
                            val reason = bootState.optString("reason", "local agent service stopped")
                            call.resolve(JSObject().apply {
                                put("ok", false)
                                put("error", reason)
                            })
                            return@Thread
                        }
                    }
                    try {
                        Thread.sleep(POLL_INTERVAL_MS)
                    } catch (_: InterruptedException) {
                        // error-policy:J1 the Capacitor method boundary returns
                        // an explicit cancelled result when its worker is interrupted.
                        Thread.currentThread().interrupt()
                        val result = JSObject().apply {
                            put("ok", false)
                            put("error", "Android Bun runtime startup was cancelled")
                        }
                        call.resolve(result)
                        return@Thread
                    }
                }
            } catch (e: Exception) {
                // error-policy:J1 translate startup failure at the Capacitor
                // method boundary instead of fabricating a ready result.
                call.reject(e.message ?: "Could not start Android Bun runtime")
            }
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
                val response = servicePost(path, body)
                val text = response.optString("text")
                    .takeIf { it.isNotBlank() }
                    ?: response.optString("reply")
                        .takeIf { it.isNotBlank() }
                    ?: throw IllegalStateException("Local agent returned no message reply")

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
                val bootState = readLocalAgentBootState()
                val result = JSObject().apply {
                    put("ready", bootState.getString("state") == "listening")
                    put("engine", "bun")
                    put("bridgeVersion", "bun-android:1")
                }
                call.resolve(result)
            } catch (e: Exception) {
                call.reject(e.message ?: "Could not read Android Bun runtime status")
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
            // error-policy:J6 stopping an already-removed service is teardown;
            // the warning preserves the failure without making stop non-idempotent.
            android.util.Log.w(TAG, "stop: could not stop ElizaAgentService: ${e.message}")
        }
        call.resolve()
    }

    // ── call ────────────────────────────────────────────────────────────────

    /**
     * Dispatch a named bridge-handler call into the running agent.
     *
     * Android exposes the lifecycle and local-agent request operations that it
     * can implement through `ElizaAgentService`. iOS-only host handlers are
     * rejected explicitly instead of being sent to a route the agent does not
     * expose.
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
        return when (method) {
            "status" -> {
                val bootState = readLocalAgentBootState()
                mapOf(
                    "ready" to (bootState.getString("state") == "listening"),
                    "apiBase" to LOCAL_AGENT_IPC_BASE,
                    "transport" to "agent-service",
                    "state" to bootState.getString("state"),
                )
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
                val response = serviceRequest(reqMethod, path, reqHeaders, reqBody)
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
                val response = servicePost(path, body)
                val text = response.optString("text").takeIf { it.isNotBlank() }
                    ?: response.optString("reply").takeIf { it.isNotBlank() }
                    ?: throw IllegalStateException("Local agent returned no message reply")
                mapOf(
                    "text" to text,
                    "reply" to text,
                    "conversationId" to convId,
                )
            }

            else -> throw UnsupportedOperationException(
                "Android Bun runtime does not expose bridge method: $method",
            )
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
     * the process owner. This plugin simply asks it to (re)start.
     */
    private fun startServiceReflective() {
        val ctx = context ?: throw IllegalStateException("Android plugin context is unavailable")
        val serviceClassName = resolveAgentServiceClassName()
            ?: throw IllegalStateException("ElizaAgentService is not registered in ${ctx.packageName}")
        val intent = Intent().apply {
            component = ComponentName(ctx.packageName, serviceClassName)
        }
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent)
        } else {
            ctx.startService(intent)
        }
    }

    private fun stopServiceReflective() {
        val ctx = context ?: throw IllegalStateException("Android plugin context is unavailable")
        val serviceClassName = resolveAgentServiceClassName()
            ?: throw IllegalStateException("ElizaAgentService is not registered")
        val intent = Intent().apply {
            component = ComponentName(ctx.packageName, serviceClassName)
        }
        ctx.stopService(intent)
    }

    /**
     * Read the per-boot bearer token through `ElizaAgentService`, which owns
     * both the in-process value and recovery from its private auth file. The
     * reflective boundary keeps this reusable plugin independent of the host
     * application's package name.
     */
    private fun readLocalAgentToken(): String? {
        val ctx = context ?: throw IllegalStateException("Android plugin context is unavailable")
        val serviceClassName = resolveAgentServiceClassName()
            ?: throw IllegalStateException("ElizaAgentService is not registered")
        val cls = Class.forName(serviceClassName)
        val method = cls.getMethod("localAgentToken", Context::class.java)
        val token = method.invoke(null, ctx) as? String
        return token?.trim()?.takeIf { it.isNotEmpty() }
    }

    private fun readLocalAgentBootState(): JSONObject {
        val ctx = context ?: throw IllegalStateException("Android plugin context is unavailable")
        val serviceClassName = resolveAgentServiceClassName()
            ?: throw IllegalStateException("ElizaAgentService is not registered")
        val cls = Class.forName(serviceClassName)
        val method = cls.getMethod("getLocalAgentBootState", Context::class.java)
        return method.invoke(null, ctx) as? JSONObject
            ?: throw IllegalStateException("ElizaAgentService returned no boot state")
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
        val refs = packageInfo.services
            ?.map { AgentServiceLocator.ServiceRef(it.packageName, it.name) }
            ?: emptyList()
        return AgentServiceLocator.selectAgentServiceClass(refs, packageName)
    }

    // ── Local-agent request helpers ──────────────────────────────────────────

    private fun servicePost(path: String, body: String): JSONObject {
        return JSONObject(servicePostRaw(path, body))
    }

    private fun servicePostRaw(path: String, body: String): String {
        val response = agentServiceRequest("POST", path, null, body, readLocalAgentToken())
        val status = response.getInt("status")
        val responseBody = response.getString("body")
        if (status !in 200..299) {
            throw IllegalStateException("Local agent POST $path failed with HTTP $status: $responseBody")
        }
        return responseBody
    }

    private fun serviceRequest(
        method: String,
        path: String,
        headers: JSObject?,
        body: String?,
    ): Map<String, Any?> {
        val response = agentServiceRequest(method, path, headers, body, readLocalAgentToken())
        val statusCode = response.getInt("status")
        val raw = response.getString("body")
        // Return a structure that mirrors the iOS bridge http_request response shape.
        return mapOf(
            "status" to statusCode,
            "statusText" to response.optString("statusText", statusTextForCode(statusCode)),
            "headers" to (response.optJSONObject("headers") ?: JSONObject()),
            "body" to raw,
            "bodyBase64" to response.optString(
                "bodyBase64",
                android.util.Base64.encodeToString(raw.toByteArray(Charsets.UTF_8), android.util.Base64.NO_WRAP),
            ),
            "bodyEncoding" to response.optString("bodyEncoding", "utf-8"),
        )
    }

    private fun statusTextForCode(status: Int): String = when (status) {
        200 -> "OK"; 201 -> "Created"; 204 -> "No Content"
        400 -> "Bad Request"; 401 -> "Unauthorized"; 403 -> "Forbidden"
        404 -> "Not Found"; 500 -> "Internal Server Error"; 504 -> "Gateway Timeout"
        else -> ""
    }

    private fun agentServiceRequest(
        method: String,
        path: String,
        headers: JSObject?,
        body: String?,
        token: String?,
    ): JSONObject {
        val requestHeaders = JSONObject(headers?.toString() ?: "{}")
        if (!token.isNullOrBlank() && !hasHeader(requestHeaders, "authorization")) {
            requestHeaders.put("Authorization", "Bearer $token")
        }
        val request = JSONObject().apply {
            put("method", method)
            put("path", path)
            put("headers", requestHeaders)
            put("body", body ?: JSONObject.NULL)
        }
        val serviceClassName = resolveAgentServiceClassName()
            ?: throw IllegalStateException("ElizaAgentService is not registered")
        val serviceClass = Class.forName(serviceClassName)
        val bridge = serviceClass.getMethod("requestLocalAgent", String::class.java)
        val raw = bridge.invoke(null, request.toString()) as? String
            ?: throw IllegalStateException("ElizaAgentService.requestLocalAgent returned null")
        return JSONObject(raw)
    }

    private fun hasHeader(headers: JSONObject, expected: String): Boolean {
        val keys = headers.keys()
        while (keys.hasNext()) {
            if (expected.equals(keys.next(), ignoreCase = true)) return true
        }
        return false
    }

    // ── Conversation helpers ──────────────────────────────────────────────────

    private fun createConversation(): String {
        val body = JSONObject().apply {
            put("title", "Android Chat")
        }.toString()
        val response = servicePost("/api/conversations", body)
        return response.optJSONObject("conversation")?.optString("id")
            ?.takeIf { it.isNotBlank() }
            ?: throw RuntimeException("Failed to create conversation: $response")
    }

    private fun encodeSegment(segment: String): String =
        java.net.URLEncoder.encode(segment, "UTF-8").replace("+", "%20")
}
