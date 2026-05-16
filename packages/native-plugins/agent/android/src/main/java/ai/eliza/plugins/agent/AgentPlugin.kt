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
        if (path == null || !path.startsWith("/") || path.startsWith("//")) {
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
                call.reject(error.message ?: "Local agent request failed")
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

    private fun invokeAgentServiceRequest(requestJson: String): String {
        val serviceClass = Class.forName(resolveAgentServiceClassName())
        val method = serviceClass.getMethod("requestLocalAgent", String::class.java)
        return method.invoke(null, requestJson) as? String
            ?: throw IllegalStateException("ElizaAgentService.requestLocalAgent returned null")
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
        return packageInfo.services
            ?.firstOrNull {
                it.packageName == ctx.packageName && it.name.endsWith(".ElizaAgentService")
            }
            ?.name
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
