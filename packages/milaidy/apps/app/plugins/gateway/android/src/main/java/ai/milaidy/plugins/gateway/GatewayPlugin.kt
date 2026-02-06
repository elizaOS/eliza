package ai.milaidy.plugins.gateway

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.*
import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

/**
 * Gateway Plugin for Capacitor
 *
 * Provides WebSocket connectivity to an Milaidy Gateway server.
 * This implementation handles authentication, reconnection, and RPC-style
 * request/response as well as event streaming.
 */
@CapacitorPlugin(name = "Gateway")
class GatewayPlugin : Plugin() {
    private val TAG = "GatewayPlugin"

    private var webSocket: WebSocket? = null
    private var okHttpClient: OkHttpClient? = null
    private val pendingRequests = ConcurrentHashMap<String, Continuation<JSObject>>()
    private var options: JSObject? = null
    private var sessionId: String? = null
    private var protocolVersion: Int? = null
    private var role: String? = null
    private var scopes: List<String> = emptyList()
    private var methods: List<String> = emptyList()
    private var events: List<String> = emptyList()
    private var lastSeq: Int? = null
    private var isClosed = false
    private var backoffMs: Long = 800
    private var reconnectJob: Job? = null
    private var connectContinuation: Continuation<JSObject>? = null

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    // Discovery
    private var nsdManager: NsdManager? = null
    private var isDiscovering = false
    private val discoveredGateways = ConcurrentHashMap<String, JSObject>()
    private val serviceType = "_milaidy-gw._tcp."

    private val discoveryListener = object : NsdManager.DiscoveryListener {
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
            Log.e(TAG, "Discovery start failed: $errorCode")
            isDiscovering = false
        }

        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
            Log.e(TAG, "Discovery stop failed: $errorCode")
        }

        override fun onDiscoveryStarted(serviceType: String) {
            Log.d(TAG, "Discovery started for $serviceType")
            isDiscovering = true
        }

        override fun onDiscoveryStopped(serviceType: String) {
            Log.d(TAG, "Discovery stopped for $serviceType")
            isDiscovering = false
        }

        override fun onServiceFound(serviceInfo: NsdServiceInfo) {
            if (serviceInfo.serviceType != this@GatewayPlugin.serviceType) return
            resolveService(serviceInfo)
        }

        override fun onServiceLost(serviceInfo: NsdServiceInfo) {
            val serviceName = decodeServiceName(serviceInfo.serviceName)
            val id = stableId(serviceName, "local.")
            val removed = discoveredGateways.remove(id)
            if (removed != null) {
                notifyListeners("discovery", JSObject().apply {
                    put("type", "lost")
                    put("gateway", removed)
                })
            }
        }
    }

    private fun decodeServiceName(raw: String): String {
        // Basic Bonjour escape decoding
        return raw.replace(Regex("\\\\(\\d{3})")) {
            it.groupValues[1].toIntOrNull()?.let { code ->
                code.toChar().toString()
            } ?: it.value
        }
    }

    private fun stableId(serviceName: String, domain: String): String {
        return "${serviceType}|${domain}|${serviceName.trim().lowercase()}"
    }

    private fun resolveService(serviceInfo: NsdServiceInfo) {
        nsdManager?.resolveService(serviceInfo, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.e(TAG, "Resolve failed for ${serviceInfo.serviceName}: $errorCode")
            }

            override fun onServiceResolved(resolved: NsdServiceInfo) {
                val host = resolved.host?.hostAddress ?: return
                val port = resolved.port
                if (port <= 0) return

                val serviceName = decodeServiceName(resolved.serviceName)
                val displayName = txt(resolved, "displayName") ?: serviceName
                val lanHost = txt(resolved, "lanHost")
                val tailnetDns = txt(resolved, "tailnetDns")
                val gatewayPort = txtInt(resolved, "gatewayPort")
                val canvasPort = txtInt(resolved, "canvasPort")
                val tlsEnabled = txtBool(resolved, "gatewayTls")
                val tlsFingerprint = txt(resolved, "gatewayTlsSha256")
                val id = stableId(serviceName, "local.")

                val gateway = JSObject().apply {
                    put("stableId", id)
                    put("name", displayName)
                    put("host", host)
                    put("port", gatewayPort ?: port)
                    put("lanHost", lanHost)
                    put("tailnetDns", tailnetDns)
                    put("gatewayPort", gatewayPort ?: port)
                    put("canvasPort", canvasPort)
                    put("tlsEnabled", tlsEnabled)
                    put("tlsFingerprintSha256", tlsFingerprint)
                    put("isLocal", true)
                }

                val isNew = discoveredGateways.put(id, gateway) == null
                notifyListeners("discovery", JSObject().apply {
                    put("type", if (isNew) "found" else "updated")
                    put("gateway", gateway)
                })
            }
        })
    }

    private fun txt(info: NsdServiceInfo, key: String): String? {
        val bytes = info.attributes[key] ?: return null
        return try {
            String(bytes, Charsets.UTF_8).trim().ifEmpty { null }
        } catch (_: Throwable) {
            null
        }
    }

    private fun txtInt(info: NsdServiceInfo, key: String): Int? {
        return txt(info, key)?.toIntOrNull()
    }

    private fun txtBool(info: NsdServiceInfo, key: String): Boolean {
        val raw = txt(info, key)?.trim()?.lowercase() ?: return false
        return raw == "1" || raw == "true" || raw == "yes"
    }

    @PluginMethod
    fun startDiscovery(call: PluginCall) {
        if (isDiscovering) {
            call.resolve(buildDiscoveryResult())
            return
        }

        try {
            nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
            nsdManager?.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, discoveryListener)

            // Return initial result after a brief delay for discovery
            scope.launch {
                delay(500)
                call.resolve(buildDiscoveryResult())
            }
        } catch (e: Exception) {
            call.reject("Failed to start discovery: ${e.message}")
        }
    }

    @PluginMethod
    fun stopDiscovery(call: PluginCall) {
        if (isDiscovering) {
            try {
                nsdManager?.stopServiceDiscovery(discoveryListener)
            } catch (_: Throwable) {
                // Ignore - best effort
            }
        }
        isDiscovering = false
        call.resolve()
    }

    @PluginMethod
    fun getDiscoveredGateways(call: PluginCall) {
        call.resolve(buildDiscoveryResult())
    }

    private fun buildDiscoveryResult(): JSObject {
        val gateways = JSArray()
        for (gateway in discoveredGateways.values.sortedBy { it.getString("name")?.lowercase() }) {
            gateways.put(gateway)
        }

        return JSObject().apply {
            put("gateways", gateways)
            put("status", if (isDiscovering) "Discovering..." else "Discovery stopped")
        }
    }

    @PluginMethod
    fun connect(call: PluginCall) {
        val urlString = call.getString("url")
        if (urlString == null) {
            call.reject("Missing URL parameter")
            return
        }

        // Store options for reconnection
        options = call.data

        // Close existing connection
        closeConnection()
        isClosed = false
        backoffMs = 800

        scope.launch {
            try {
                val result = establishConnection(urlString, call.data)
                call.resolve(result)
            } catch (e: Exception) {
                call.reject("Connection failed: ${e.message}")
            }
        }
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        isClosed = true
        reconnectJob?.cancel()
        reconnectJob = null
        closeConnection()
        sessionId = null
        protocolVersion = null
        notifyStateChange("disconnected", "Client disconnect")
        call.resolve()
    }

    @PluginMethod
    fun isConnected(call: PluginCall) {
        val connected = webSocket != null
        call.resolve(JSObject().apply {
            put("connected", connected)
        })
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val method = call.getString("method")
        if (method == null) {
            call.reject("Missing method parameter")
            return
        }

        val ws = webSocket
        if (ws == null) {
            call.resolve(JSObject().apply {
                put("ok", false)
                put("error", JSObject().apply {
                    put("code", "NOT_CONNECTED")
                    put("message", "Not connected to gateway")
                })
            })
            return
        }

        val id = UUID.randomUUID().toString()
        val params = call.getObject("params") ?: JSObject()

        val frame = JSONObject().apply {
            put("type", "req")
            put("id", id)
            put("method", method)
            put("params", params.toJson())
        }

        scope.launch {
            try {
                val result = sendRequest(id, frame.toString())
                call.resolve(result)
            } catch (e: Exception) {
                call.resolve(JSObject().apply {
                    put("ok", false)
                    put("error", JSObject().apply {
                        put("code", "REQUEST_FAILED")
                        put("message", e.message ?: "Unknown error")
                    })
                })
            }
        }
    }

    @PluginMethod
    fun getConnectionInfo(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("url", options?.getString("url"))
            put("sessionId", sessionId)
            put("protocol", protocolVersion)
            put("role", role)
        })
    }

    // Private methods

    private suspend fun establishConnection(url: String, options: JSObject): JSObject {
        return suspendCoroutine { continuation ->
            connectContinuation = continuation

            okHttpClient = OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS) // No read timeout for WebSocket
                .writeTimeout(30, TimeUnit.SECONDS)
                .build()

            val request = Request.Builder()
                .url(url)
                .build()

            webSocket = okHttpClient?.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    Log.d(TAG, "WebSocket connected")
                    sendConnectFrame(options)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleMessage(text)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    Log.e(TAG, "WebSocket failure: ${t.message}")
                    handleClose(t)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    Log.d(TAG, "WebSocket closed: $code $reason")
                    handleClose(null)
                }
            })

            // Set timeout
            scope.launch {
                delay(30000)
                if (connectContinuation != null) {
                    connectContinuation?.resumeWithException(Exception("Connection timeout"))
                    connectContinuation = null
                }
            }
        }
    }

    private fun sendConnectFrame(options: JSObject) {
        val clientName = options.getString("clientName") ?: "milaidy-capacitor-android"
        val clientVersion = options.getString("clientVersion") ?: "1.0.0"
        val roleParam = options.getString("role") ?: "operator"
        val scopesParam = options.getJSONArray("scopes")?.let { arr ->
            (0 until arr.length()).map { arr.getString(it) }
        } ?: listOf("operator.admin")

        val auth = JSONObject().apply {
            options.getString("token")?.let { put("token", it) }
            options.getString("password")?.let { put("password", it) }
        }

        val params = JSONObject().apply {
            put("minProtocol", 3)
            put("maxProtocol", 3)
            put("client", JSONObject().apply {
                put("id", clientName)
                put("version", clientVersion)
                put("platform", "android")
                put("mode", "ui")
            })
            put("role", roleParam)
            put("scopes", JSONArray(scopesParam))
            put("caps", JSONArray())
            put("auth", auth)
        }

        val id = UUID.randomUUID().toString()
        val frame = JSONObject().apply {
            put("type", "req")
            put("id", id)
            put("method", "connect")
            put("params", params)
        }

        webSocket?.send(frame.toString())
    }

    private suspend fun sendRequest(id: String, frameJson: String): JSObject {
        return suspendCoroutine { continuation ->
            pendingRequests[id] = continuation

            val sent = webSocket?.send(frameJson) ?: false
            if (!sent) {
                pendingRequests.remove(id)
                continuation.resumeWithException(Exception("Failed to send request"))
                return@suspendCoroutine
            }

            // Set timeout
            scope.launch {
                delay(60000)
                pendingRequests.remove(id)?.let {
                    it.resume(JSObject().apply {
                        put("ok", false)
                        put("error", JSObject().apply {
                            put("code", "TIMEOUT")
                            put("message", "Request timed out")
                        })
                    })
                }
            }
        }
    }

    private fun handleMessage(text: String) {
        try {
            val json = JSONObject(text)
            val frameType = json.optString("type")

            // Handle response frames
            if (frameType == "res") {
                val id = json.optString("id")

                // Check if this is the connect response
                if (connectContinuation != null) {
                    val ok = json.optBoolean("ok", false)
                    if (ok) {
                        val payload = json.optJSONObject("payload")
                        if (payload != null) {
                            handleHelloOk(payload)
                        }
                        val result = JSObject().apply {
                            put("connected", true)
                            put("sessionId", sessionId ?: "")
                            put("protocol", protocolVersion ?: 3)
                            put("methods", JSONArray(methods))
                            put("events", JSONArray(events))
                            put("role", role ?: "")
                            put("scopes", JSONArray(scopes))
                        }
                        connectContinuation?.resume(result)
                        connectContinuation = null
                    } else {
                        val errorMsg = json.optJSONObject("error")?.optString("message") ?: "Connection failed"
                        connectContinuation?.resumeWithException(Exception(errorMsg))
                        connectContinuation = null
                    }
                    return
                }

                // Handle pending request
                pendingRequests.remove(id)?.let { continuation ->
                    val ok = json.optBoolean("ok", false)
                    val result = JSObject().apply {
                        put("ok", ok)
                        json.opt("payload")?.let { put("payload", it) }
                        json.optJSONObject("error")?.let { error ->
                            put("error", JSObject().apply {
                                put("code", error.optString("code"))
                                put("message", error.optString("message"))
                            })
                        }
                    }
                    continuation.resume(result)
                }
                return
            }

            // Handle event frames
            if (frameType == "event") {
                val event = json.optString("event")
                val payload = json.opt("payload")
                val seq = if (json.has("seq")) json.optInt("seq") else null

                // Check for sequence gap
                if (seq != null && lastSeq != null && seq > lastSeq!! + 1) {
                    Log.w(TAG, "Event sequence gap: expected ${lastSeq!! + 1}, got $seq")
                }
                if (seq != null) {
                    lastSeq = seq
                }

                // Emit event
                val eventData = JSObject().apply {
                    put("event", event)
                    payload?.let { put("payload", it) }
                    seq?.let { put("seq", it) }
                }
                notifyListeners("gatewayEvent", eventData)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error handling message: ${e.message}")
        }
    }

    private fun handleHelloOk(payload: JSONObject) {
        sessionId = UUID.randomUUID().toString()
        protocolVersion = payload.optInt("protocol", 3)

        payload.optJSONObject("auth")?.let { auth ->
            role = auth.optString("role")
            scopes = auth.optJSONArray("scopes")?.let { arr ->
                (0 until arr.length()).map { arr.getString(it) }
            } ?: emptyList()
        }

        payload.optJSONObject("features")?.let { features ->
            methods = features.optJSONArray("methods")?.let { arr ->
                (0 until arr.length()).map { arr.getString(it) }
            } ?: emptyList()
            events = features.optJSONArray("events")?.let { arr ->
                (0 until arr.length()).map { arr.getString(it) }
            } ?: emptyList()
        }

        backoffMs = 800
        notifyStateChange("connected")
    }

    private fun handleClose(error: Throwable?) {
        webSocket = null

        // Reject all pending requests
        pendingRequests.forEach { (_, continuation) ->
            continuation.resumeWithException(Exception("Connection closed"))
        }
        pendingRequests.clear()

        if (isClosed) {
            notifyStateChange("disconnected", error?.message)
            return
        }

        // Attempt reconnection
        notifyStateChange("reconnecting", error?.message)
        notifyListeners("error", JSObject().apply {
            put("message", "Connection lost: ${error?.message ?: "unknown"}")
            put("willRetry", true)
        })

        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        if (isClosed || reconnectJob?.isActive == true) return

        val delay = backoffMs
        backoffMs = minOf((backoffMs * 1.7).toLong(), 15000)

        reconnectJob = scope.launch {
            delay(delay)
            val url = options?.getString("url")
            if (url != null && !isClosed) {
                try {
                    establishConnection(url, options ?: JSObject())
                } catch (e: Exception) {
                    handleClose(e)
                }
            }
        }
    }

    private fun closeConnection() {
        webSocket?.close(1000, "Client disconnect")
        webSocket = null
        okHttpClient?.dispatcher?.executorService?.shutdown()
        okHttpClient = null
    }

    private fun notifyStateChange(state: String, reason: String? = null) {
        val data = JSObject().apply {
            put("state", state)
            reason?.let { put("reason", it) }
        }
        notifyListeners("stateChange", data)
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        scope.cancel()
        closeConnection()
    }

    // Helper extension
    private fun JSObject.toJson(): JSONObject {
        return JSONObject(this.toString())
    }
}
