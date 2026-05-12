package ai.eliza.plugins.agent

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import org.json.JSONObject

private const val LOCAL_AGENT_BASE_URL = "http://127.0.0.1:31337"
private const val MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024
private const val MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024

/**
 * Eliza Agent Plugin — Android bridge.
 *
 * The app module owns ElizaAgentService, so this library uses reflection to
 * avoid a Gradle dependency cycle while still exposing the per-boot loopback
 * bearer token to the WebView.
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

        val timeoutMs = (call.getInt("timeoutMs") ?: 10_000).coerceIn(1_000, 120_000)
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
        val serviceClass = Class.forName("${context.packageName}.ElizaAgentService")
        val method = serviceClass.getMethod(methodName, android.content.Context::class.java)
        method.invoke(null, context)
    }

    private fun readLocalAgentToken(): String? {
        return try {
            val serviceClass = Class.forName("${context.packageName}.ElizaAgentService")
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

        val connection = (URL("$LOCAL_AGENT_BASE_URL$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            instanceFollowRedirects = false
            useCaches = false
        }

        for (key in headers.keys()) {
            if (key.equals("host", ignoreCase = true) ||
                key.equals("connection", ignoreCase = true) ||
                key.equals("content-length", ignoreCase = true)
            ) {
                continue
            }
            val value = headers.opt(key) as? String
            if (!value.isNullOrBlank()) {
                connection.setRequestProperty(key, value)
            }
        }

        if (token != null && connection.getRequestProperty("Authorization").isNullOrBlank()) {
            connection.setRequestProperty("Authorization", "Bearer $token")
        }

        if (requestBody != null && method != "GET" && method != "HEAD") {
            connection.doOutput = true
            connection.outputStream.use { output ->
                output.write(requestBody)
            }
        }

        val status = connection.responseCode
        val stream = if (status >= 400) connection.errorStream else connection.inputStream
        val responseBody = stream?.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            var total = 0
            while (true) {
                val count = input.read(buffer)
                if (count == -1) break
                total += count
                if (total > MAX_RESPONSE_BODY_BYTES) {
                    throw IllegalStateException("Response body is too large")
                }
                output.write(buffer, 0, count)
            }
            output.toString(Charsets.UTF_8.name())
        } ?: ""

        val responseHeaders = JSObject()
        for ((key, values) in connection.headerFields) {
            if (key == null || values == null || values.isEmpty()) continue
            responseHeaders.put(key.lowercase(Locale.US), values.joinToString(", "))
        }

        return JSObject().apply {
            put("status", status)
            put("statusText", connection.responseMessage ?: "")
            put("headers", responseHeaders)
            put("body", responseBody)
        }
    }
}
