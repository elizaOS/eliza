package ai.eliza.plugins.agent

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import android.content.pm.PackageManager
import java.util.Locale
import org.json.JSONObject

private const val MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024
private const val DEFAULT_REQUEST_TIMEOUT_MS = 10_000
private const val MAX_REQUEST_TIMEOUT_MS = 600_000
private const val MAX_EVENT_SUBSCRIPTIONS = 2

/**
 * Eliza Agent Plugin — Android bridge.
 *
 * The app module owns ElizaAgentService, so this library uses reflection to
 * avoid a Gradle dependency cycle while still exposing the per-boot bearer
 * token and request dispatch surface to the WebView.
 */
@CapacitorPlugin(name = "Agent")
class AgentPlugin : Plugin() {
    @PluginMethod
    fun start(call: PluginCall) {
        try {
            invokeAgentService("start")
            call.resolve(agentStatus("starting", null))
        } catch (error: Exception) {
            call.reject(error.message ?: "Failed to start local agent")
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        try {
            invokeAgentService("stop")
            call.resolve(JSObject().apply {
                put("ok", true)
            })
        } catch (error: Exception) {
            call.reject(error.message ?: "Failed to stop local agent")
        }
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val token = readLocalAgentToken()
        if (token == null) {
            call.resolve(agentStatus("not_started", null))
            return
        }

        Thread {
            try {
                val result = forwardLocalRequest("/api/status", "GET", JSObject(), null, 1_500, token)
                val json = JSONObject(result.getString("body") ?: "{}")
                call.resolve(agentStatus(
                    json.optString("state", "running"),
                    json.optString("error").takeIf { it.isNotBlank() },
                ))
            } catch (error: Exception) {
                call.resolve(agentStatus("error", error.message ?: "Local agent status unavailable"))
            }
        }.start()
    }

    @PluginMethod
    fun getLocalAgentToken(call: PluginCall) {
        val token = readLocalAgentToken()
        call.resolve(JSObject().apply {
            put("available", token != null)
            put("token", token ?: JSONObject.NULL)
        })
    }

    @PluginMethod
    fun request(call: PluginCall) {
        val path = call.getString("path")?.trim()
        if (path == null || !isSafeLocalPath(path)) {
            call.reject("Agent.request requires a local path that starts with /")
            return
        }

        val method = (call.getString("method") ?: "GET").trim().uppercase(Locale.US)
        if (!method.matches(Regex("^[A-Z]{1,16}$"))) {
            call.reject("Unsupported HTTP method")
            return
        }

        val timeoutMs = (call.getInt("timeoutMs") ?: DEFAULT_REQUEST_TIMEOUT_MS)
            .coerceIn(1_000, MAX_REQUEST_TIMEOUT_MS)
        val body = call.getString("body")
        val headers = call.getObject("headers") ?: JSObject()
        val token = readLocalAgentToken()

        Thread {
            try {
                val result = forwardLocalRequest(path, method, headers, body, timeoutMs, token)
                call.resolve(result)
            } catch (error: Exception) {
                call.resolve(localAgentUnavailableResponse(error.message ?: "Local agent request failed"))
            }
        }.start()
    }

    /**
     * Streaming variant of [request]. Where [request] buffers the whole loopback
     * response, this pushes it incrementally: the service reads the response
     * stream and hands us per-fragment JSON envelopes, which we forward to the
     * WebView as `agentStream*` Capacitor events tagged with a per-request
     * `streamId`. Resolves immediately with the `streamId`; events follow.
     */
    @PluginMethod
    fun requestStream(call: PluginCall) {
        val path = call.getString("path")?.trim()
        if (path == null || !isSafeLocalPath(path)) {
            call.reject("Agent.requestStream requires a local path that starts with /")
            return
        }
        val method = (call.getString("method") ?: "GET").trim().uppercase(Locale.US)
        if (!method.matches(Regex("^[A-Z]{1,16}$"))) {
            call.reject("Unsupported HTTP method")
            return
        }
        val timeoutMs = (call.getInt("timeoutMs") ?: DEFAULT_REQUEST_TIMEOUT_MS)
            .coerceIn(1_000, MAX_REQUEST_TIMEOUT_MS)
        val body = call.getString("body")
        val headers = call.getObject("headers") ?: JSObject()
        val streamId = java.util.UUID.randomUUID().toString()

        val requestJson = JSONObject().apply {
            put("method", method)
            put("path", path)
            put("headers", JSONObject(headers.toString()))
            put("body", body ?: JSONObject.NULL)
            put("timeoutMs", timeoutMs)
        }.toString()

        val onEvent = java.util.function.Consumer<String> { eventJson ->
            try {
                val event = JSONObject(eventJson)
                when (event.optString("type")) {
                    "response" -> notifyListeners("agentStreamResponse", JSObject().apply {
                        put("streamId", streamId)
                        put("status", event.optInt("status"))
                        put("statusText", event.optString("statusText"))
                        put("headers", event.optJSONObject("headers") ?: JSONObject())
                    })
                    "chunk" -> notifyListeners("agentStreamChunk", JSObject().apply {
                        put("streamId", streamId)
                        put("dataBase64", event.optString("dataBase64"))
                    })
                    "complete" -> notifyListeners("agentStreamComplete", JSObject().apply {
                        put("streamId", streamId)
                        if (event.has("error")) put("error", event.optString("error"))
                    })
                }
            } catch (_: Exception) {
                // A malformed envelope shouldn't kill the stream; drop it.
            }
        }

        // Resolve before the work starts so the WebView can attach listeners for
        // this streamId; the service emits on the background thread below.
        call.resolve(JSObject().apply { put("streamId", streamId) })

        Thread {
            try {
                invokeAgentServiceRequestStream(requestJson, onEvent)
            } catch (error: Exception) {
                notifyListeners("agentStreamComplete", JSObject().apply {
                    put("streamId", streamId)
                    put("error", error.message ?: "Local agent stream failed")
                })
            }
        }.start()
    }

    private fun agentStatus(state: String, error: String?): JSObject {
        return JSObject().apply {
            put("state", state)
            put("agentName", JSONObject.NULL)
            put("port", if (state == "not_started") JSONObject.NULL else 31337)
            put("startedAt", JSONObject.NULL)
            put("error", error ?: JSONObject.NULL)
        }
    }

    private fun invokeAgentService(methodName: String) {
        val serviceClass = Class.forName(resolveAgentServiceClassName())
        val method = serviceClass.getMethod(methodName, android.content.Context::class.java)
        method.invoke(null, context)
    }

    private fun localAgentUnavailableResponse(message: String): JSObject {
        return JSObject().apply {
            put("status", 503)
            put("statusText", "Service Unavailable")
            put("headers", JSObject().apply {
                put("content-type", "application/json")
            })
            put("body", JSONObject().apply {
                put("error", "local_agent_unavailable")
                put("message", message)
            }.toString())
        }
    }

    private fun readLocalAgentToken(): String? {
        return try {
            val serviceClass = Class.forName(resolveAgentServiceClassName())
            val method = serviceClass.getMethod("localAgentToken")
            (method.invoke(null) as? String)?.trim()?.takeIf { it.isNotEmpty() }
        } catch (_: Exception) {
            null
        }
    }

    private fun forwardLocalRequest(
        path: String,
        method: String,
        headers: JSObject,
        body: String?,
        timeoutMs: Int,
        token: String?,
    ): JSObject {
        val requestBody = body?.toByteArray(Charsets.UTF_8)
        if (requestBody != null && requestBody.size > MAX_REQUEST_BODY_BYTES) {
            throw IllegalArgumentException("Request body is too large")
        }

        val request = JSONObject().apply {
            put("method", method)
            put("path", path)
            put("headers", headers)
            put("body", body ?: JSONObject.NULL)
            put("timeoutMs", timeoutMs)
            if (!token.isNullOrBlank() && !hasHeader(headers, "authorization")) {
                put("headers", JSONObject(headers.toString()).apply {
                    put("Authorization", "Bearer $token")
                })
            }
        }
        val raw = invokeAgentServiceRequest(request.toString())
        return jsObjectFromJson(JSONObject(raw))
    }

    private val eventSubscriptions =
        java.util.concurrent.ConcurrentHashMap<String, Any>()

    /**
     * Live agent-event feed over the private IPC (WS `agent_event` parity for
     * the port-free app). Takes `{streams, subscriptionId?}`, resolves
     * `{subscriptionId}`, then emits `agentEvent` events tagged with it:
     * `subscribed` → `event`/`dropped` … → terminal `end` (`error` set on
     * failure; there is no replay, so the caller resubscribes).
     */
    @PluginMethod
    fun subscribeEvents(call: PluginCall) {
        val subscriptionId = call.getString("subscriptionId") ?: java.util.UUID.randomUUID().toString()
        if (!subscriptionId.matches(Regex("^[A-Za-z0-9-]{8,64}$"))) {
            call.reject("Invalid subscriptionId")
            return
        }
        val requestJson = JSONObject().apply {
            put("streams", call.getArray("streams") ?: org.json.JSONArray())
        }.toString()
        val handle: Any
        val subscribe: java.lang.reflect.Method
        try {
            val serviceClass = Class.forName(resolveAgentServiceClassName())
            val handleClass = Class.forName("${serviceClass.name}\$LocalStreamHandle")
            handle = handleClass.getConstructor().newInstance()
            subscribe = serviceClass.getMethod(
                "subscribeLocalAgentEvents",
                String::class.java,
                java.util.function.Consumer::class.java,
                handleClass,
            )
        } catch (error: Exception) {
            call.reject("Agent event subscriptions are unavailable")
            return
        }
        synchronized(eventSubscriptions) {
            if (eventSubscriptions.containsKey(subscriptionId)) {
                call.reject("subscriptionId already active")
                return
            }
            if (eventSubscriptions.size >= MAX_EVENT_SUBSCRIPTIONS) {
                call.reject("Too many event subscriptions")
                return
            }
            eventSubscriptions[subscriptionId] = handle
        }
        val onEvent = java.util.function.Consumer<String> { eventJson ->
            try {
                notifyListeners("agentEvent", jsObjectFromJson(JSONObject(eventJson)).apply {
                    put("subscriptionId", subscriptionId)
                })
            } catch (_: Exception) {
                // A malformed envelope must not kill the feed.
            }
        }
        call.resolve(JSObject().apply { put("subscriptionId", subscriptionId) })
        Thread {
            try {
                subscribe.invoke(null, requestJson, onEvent, handle)
            } catch (error: Exception) {
                notifyListeners("agentEvent", JSObject().apply {
                    put("subscriptionId", subscriptionId)
                    put("type", "end")
                    put("error", error.message ?: "Local agent event feed failed")
                })
            } finally {
                eventSubscriptions.remove(subscriptionId, handle)
            }
        }.apply { isDaemon = true }.start()
    }

    @PluginMethod
    fun unsubscribeEvents(call: PluginCall) {
        val subscriptionId = call.getString("subscriptionId")
        val handle = subscriptionId?.let { eventSubscriptions[it] }
        try {
            handle?.let { cancelHandle(it) }
        } catch (_: Exception) {
            // Retain ownership so a later cleanup attempt can cancel this feed.
            call.reject("Native event subscription cleanup is unconfirmed")
            return
        }
        if (subscriptionId != null && handle != null) {
            eventSubscriptions.remove(subscriptionId, handle)
        }
        call.resolve(JSObject().apply { put("ok", handle != null) })
    }

    override fun handleOnDestroy() {
        for ((id, handle) in eventSubscriptions.entries) {
            try {
                cancelHandle(handle)
                eventSubscriptions.remove(id, handle)
            } catch (_: Exception) {
                android.util.Log.e("ElizaAgentPlugin", "Native event subscription cleanup is unconfirmed")
            }
        }
        super.handleOnDestroy()
    }

    private fun cancelHandle(handle: Any) {
        handle.javaClass.getMethod("cancel").invoke(handle)
    }

    private fun invokeAgentServiceRequest(requestJson: String): String {
        val serviceClass = Class.forName(resolveAgentServiceClassName())
        val method = serviceClass.getMethod("requestLocalAgent", String::class.java)
        return method.invoke(null, requestJson) as? String
            ?: throw IllegalStateException("ElizaAgentService.requestLocalAgent returned null")
    }

    private fun invokeAgentServiceRequestStream(
        requestJson: String,
        onEvent: java.util.function.Consumer<String>,
    ) {
        val serviceClass = Class.forName(resolveAgentServiceClassName())
        val method = serviceClass.getMethod(
            "requestLocalAgentStream",
            String::class.java,
            java.util.function.Consumer::class.java,
        )
        method.invoke(null, requestJson, onEvent)
    }

    private fun isSafeLocalPath(path: String): Boolean {
        return path.startsWith("/") && !path.startsWith("//") && !path.contains("://")
    }

    private fun resolveAgentServiceClassName(): String {
        val ctx = context ?: throw IllegalStateException("Android context is unavailable")
        val packageInfo = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            ctx.packageManager.getPackageInfo(
                ctx.packageName,
                PackageManager.PackageInfoFlags.of(PackageManager.GET_SERVICES.toLong()),
            )
        } else {
            @Suppress("DEPRECATION")
            ctx.packageManager.getPackageInfo(ctx.packageName, PackageManager.GET_SERVICES)
        }
        val refs = packageInfo.services
            ?.map { AgentServiceLocator.ServiceRef(it.packageName, it.name) }
            ?: emptyList()
        return AgentServiceLocator.selectAgentServiceClass(refs, ctx.packageName)
            ?: throw IllegalStateException("ElizaAgentService is not registered")
    }

    private fun hasHeader(headers: JSObject, expected: String): Boolean {
        val keys = headers.keys()
        while (keys.hasNext()) {
            if (expected.equals(keys.next(), ignoreCase = true)) return true
        }
        return false
    }

    private fun jsObjectFromJson(json: JSONObject): JSObject {
        return JSObject().apply {
            for (key in json.keys()) {
                put(key, json.opt(key))
            }
        }
    }
}
