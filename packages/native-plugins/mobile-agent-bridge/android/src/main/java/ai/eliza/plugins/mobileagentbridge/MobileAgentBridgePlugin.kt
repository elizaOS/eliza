package ai.eliza.plugins.mobileagentbridge

import android.net.Uri
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

@CapacitorPlugin(name = "MobileAgentBridge")
class MobileAgentBridgePlugin : Plugin() {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private var socket: WebSocket? = null
    private var relayUrl: String? = null
    private var deviceId: String? = null
    private var pairingToken: String? = null
    private var localAgentApiBase: String = DEFAULT_LOCAL_AGENT_API_BASE
    private var state: String = "idle"
    private var lastError: String? = null

    @PluginMethod
    fun startInboundTunnel(call: PluginCall) {
        val relay = call.getString("relayUrl")?.trim()
        val id = call.getString("deviceId")?.trim()
        if (relay.isNullOrEmpty()) {
            call.reject("MobileAgentBridge.startInboundTunnel requires relayUrl")
            return
        }
        if (id.isNullOrEmpty()) {
            call.reject("MobileAgentBridge.startInboundTunnel requires deviceId")
            return
        }

        stopTunnel(notify = false)
        relayUrl = relay
        deviceId = id
        pairingToken = call.getString("pairingToken")?.trim()?.takeIf { it.isNotEmpty() }
        val localBase = call.getString("localAgentApiBase")?.trim()?.takeIf { it.isNotEmpty() }
        localAgentApiBase = if (localBase == null) {
            DEFAULT_LOCAL_AGENT_API_BASE
        } else {
            normalizeLocalAgentApiBase(localBase) ?: run {
                transition("error", "Invalid localAgentApiBase: $localBase")
                call.resolve(status())
                return
            }
        }

        val url = buildRelayUrl(relay, id, pairingToken)
        if (url == null) {
            transition("error", "Invalid relay URL: $relay")
            call.resolve(status())
            return
        }

        transition("connecting", null)
        val request = Request.Builder().url(url).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                transition("registered", null)
                sendFrame(JSONObject().apply {
                    put("type", "tunnel.register")
                    put("role", "phone-agent")
                    put("deviceId", id)
                    put("pairingToken", pairingToken ?: JSONObject.NULL)
                })
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleFrame(text)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (socket === webSocket) {
                    socket = null
                    transition("disconnected", reason.ifBlank { null })
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (socket === webSocket) {
                    transition("error", t.message ?: "WebSocket failure")
                }
            }
        })
        call.resolve(status())
    }

    @PluginMethod
    fun stopInboundTunnel(call: PluginCall) {
        stopTunnel(notify = true)
        call.resolve()
    }

    @PluginMethod
    fun getTunnelStatus(call: PluginCall) {
        call.resolve(status())
    }

    private fun stopTunnel(notify: Boolean) {
        socket?.close(1000, "Client stop")
        socket = null
        relayUrl = null
        deviceId = null
        pairingToken = null
        localAgentApiBase = DEFAULT_LOCAL_AGENT_API_BASE
        state = "idle"
        lastError = null
        if (notify) notifyListeners("stateChange", JSObject().apply { put("state", "idle") })
    }

    private fun transition(next: String, reason: String?) {
        state = next
        lastError = if (next == "error") reason else null
        notifyListeners("stateChange", JSObject().apply {
            put("state", next)
            if (reason != null) put("reason", reason)
        })
    }

    private fun status(): JSObject {
        return JSObject().apply {
            put("state", state)
            put("relayUrl", relayUrl)
            put("deviceId", deviceId)
            put("localAgentApiBase", localAgentApiBase)
            put("lastError", lastError)
        }
    }

    private fun buildRelayUrl(raw: String, id: String, token: String?): String? {
        return try {
            val uri = Uri.parse(raw)
            val scheme = when (uri.scheme) {
                "https" -> "wss"
                "http" -> "ws"
                "wss", "ws" -> uri.scheme
                else -> return null
            }
            val builder = uri.buildUpon().scheme(scheme)
                .clearQuery()
                .appendQueryParameter("deviceId", id)
            for (name in uri.queryParameterNames) {
                if (name != "deviceId" && name != "token") {
                    for (value in uri.getQueryParameters(name)) {
                        builder.appendQueryParameter(name, value)
                    }
                }
            }
            if (token != null) builder.appendQueryParameter("token", token)
            builder.build().toString()
        } catch (_: Exception) {
            null
        }
    }

    private fun handleFrame(text: String) {
        val frame = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        val type = frame.optString("type")
        if (type != "http_request" && type != "tunnel.http_request" && type != "agent.http_request") {
            return
        }
        Thread {
            val id = frame.opt("id")
            val response = try {
                proxyHttpRequest(frame)
            } catch (error: Exception) {
                JSONObject().apply {
                    put("status", 0)
                    put("headers", JSONObject())
                    put("body", "")
                    put("error", error.message ?: "Local agent proxy failed")
                }
            }
            response.put("type", "http_response")
            response.put("id", id ?: JSONObject.NULL)
            sendFrame(response)
        }.start()
    }

    private fun proxyHttpRequest(frame: JSONObject): JSONObject {
        val path = frame.optString("path", "/api/health")
        if (!path.startsWith("/") || path.startsWith("//") || path.contains("://")) {
            return JSONObject().apply {
                put("status", 400)
                put("headers", JSONObject())
                put("body", "Invalid local path")
            }
        }
        val method = frame.optString("method", "GET").trim().uppercase(Locale.US)
        if (!method.matches(Regex("^[A-Z]{1,16}$"))) {
            throw IllegalArgumentException("Unsupported HTTP method")
        }
        val timeoutMs = frame.optInt("timeoutMs", frame.optInt("timeout_ms", 30_000))
            .coerceIn(1_000, 120_000)
        val body = frame.opt("body")?.takeUnless { it == JSONObject.NULL }?.toString()
        val url = URL("${localAgentApiBase.trimEnd('/')}$path")
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = timeoutMs
            readTimeout = timeoutMs
            instanceFollowRedirects = false
            useCaches = false
        }
        applyHeaders(connection, frame.optJSONObject("headers") ?: JSONObject())
        readLocalAgentToken()?.let { token ->
            if (connection.getRequestProperty("Authorization").isNullOrBlank()) {
                connection.setRequestProperty("Authorization", "Bearer $token")
            }
        }
        if (body != null && method != "GET" && method != "HEAD") {
            val bytes = body.toByteArray(Charsets.UTF_8)
            connection.doOutput = true
            connection.outputStream.use { it.write(bytes) }
        }
        val status = connection.responseCode
        return JSONObject().apply {
            put("status", status)
            put("statusText", connection.responseMessage ?: "")
            put("headers", responseHeaders(connection))
            put("body", responseBody(connection, status))
        }
    }

    private fun applyHeaders(connection: HttpURLConnection, headers: JSONObject) {
        for (key in headers.keys()) {
            if (key.equals("host", true) || key.equals("connection", true) || key.equals("content-length", true)) {
                continue
            }
            val value = headers.optString(key).trim()
            if (value.isNotEmpty()) connection.setRequestProperty(key, value)
        }
    }

    private fun responseHeaders(connection: HttpURLConnection): JSONObject {
        return JSONObject().apply {
            for ((key, values) in connection.headerFields) {
                if (key != null && !values.isNullOrEmpty()) {
                    put(key.lowercase(Locale.US), values.joinToString(", "))
                }
            }
        }
    }

    private fun responseBody(connection: HttpURLConnection, status: Int): String {
        val stream = if (status >= 400) connection.errorStream else connection.inputStream
        return stream?.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count == -1) break
                output.write(buffer, 0, count)
            }
            output.toString(Charsets.UTF_8.name())
        } ?: ""
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

    private fun sendFrame(frame: JSONObject) {
        socket?.send(frame.toString())
    }

    private fun normalizeLocalAgentApiBase(raw: String): String? {
        return try {
            val uri = Uri.parse(raw)
            val scheme = uri.scheme?.lowercase(Locale.US)
            val host = uri.host?.lowercase(Locale.US)
            if (scheme != "http") return null
            if (host !in setOf("127.0.0.1", "localhost", "10.0.2.2")) return null
            val port = if (uri.port > 0) ":${uri.port}" else ""
            "http://$host$port"
        } catch (_: Exception) {
            null
        }
    }

    private companion object {
        private const val DEFAULT_LOCAL_AGENT_API_BASE = "http://127.0.0.1:31337"
    }
}
