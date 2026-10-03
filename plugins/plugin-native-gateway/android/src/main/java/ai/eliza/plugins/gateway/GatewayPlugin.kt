package ai.eliza.plugins.gateway

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
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
 * Provides WebSocket connectivity to an Eliza Gateway server.
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
    private var isClosed = true
    private var authenticated = false
    private var generation = 0L
    private var connectRequestId: String? = null
    private var connectTimeout: Job? = null
    private val requestTimeouts = mutableMapOf<String, Job>()
    private var backoffMs: Long = 800
    private var reconnectJob: Job? = null
    private var connectContinuation: Continuation<JSObject>? = null

    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    // Discovery
    private var nsdManager: NsdManager? = null
    private var isDiscovering = false
    private val discoveredGateways = ConcurrentHashMap<String, JSObject>()
    private val serviceType = "_eliza-gw._tcp."

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

    @Suppress("DEPRECATION")
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
            call.resolve(GatewayDiscovery.buildDiscoveryResult(discoveredGateways.values, isDiscovering))
            return
        }

        try {
            nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
            nsdManager?.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, discoveryListener)

            // Return initial result after a brief delay for discovery
            scope.launch {
                delay(500)
                call.resolve(GatewayDiscovery.buildDiscoveryResult(discoveredGateways.values, isDiscovering))
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
        call.resolve(GatewayDiscovery.buildDiscoveryResult(discoveredGateways.values, isDiscovering))
    }

    @PluginMethod
    fun connect(call: PluginCall) {
        val urlString = call.getString("url")
        if (urlString.isNullOrBlank()) {
            call.reject("Missing URL parameter", "INVALID_INPUT")
            return
        }
        scope.launch {
            reconnectJob?.cancel()
            reconnectJob = null
            closeConnection(Exception("Connection replaced"))
            options = call.data
            isClosed = false
            backoffMs = 800
            try {
                call.resolve(establishConnection(urlString, call.data))
            } catch (error: Exception) {
                // error-policy:J1 Translate native connection failure at the bridge.
                call.reject("Connection failed: ${error.message}", "CONNECTION_FAILED")
            }
        }
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        scope.launch {
            isClosed = true
            reconnectJob?.cancel()
            reconnectJob = null
            closeConnection()
            notifyStateChange("disconnected", "Client disconnect")
            call.resolve()
        }
    }

    @PluginMethod
    fun isConnected(call: PluginCall) {
        scope.launch { call.resolve(JSObject().apply { put("connected", authenticated) }) }
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val method = call.getString("method")
        if (method.isNullOrBlank()) {
            call.reject("Missing method parameter", "INVALID_INPUT")
            return
        }
        scope.launch {
            if (!authenticated || webSocket == null) {
                call.resolve(JSObject().apply {
                    put("ok", false)
                    put("error", JSObject().apply {
                        put("code", "NOT_CONNECTED")
                        put("message", "Not connected to gateway")
                    })
                })
                return@launch
            }
            val id = UUID.randomUUID().toString()
            val frame = JSONObject().apply {
                put("type", "req")
                put("id", id)
                put("method", method)
                put("params", (call.getObject("params") ?: JSObject()).toJson())
            }
            try {
                call.resolve(sendRequest(id, frame.toString()))
            } catch (error: Exception) {
                // error-policy:J1 RPC failures keep the public structured result contract.
                call.resolve(JSObject().apply {
                    put("ok", false)
                    put("error", JSObject().apply {
                        put("code", "REQUEST_FAILED")
                        put("message", error.message ?: "Request failed")
                    })
                })
            }
        }
    }

    @PluginMethod
    fun getConnectionInfo(call: PluginCall) {
        scope.launch {
            call.resolve(JSObject().apply {
                put("url", options?.getString("url"))
                put("sessionId", sessionId)
                put("protocol", protocolVersion)
                put("role", role)
            })
        }
    }

    // Private methods

    private suspend fun establishConnection(url: String, options: JSObject): JSObject {
        // Build before saving the continuation: invalid URLs must not leave a
        // suspended handshake behind. All connection state runs on the main scope.
        val request = Request.Builder().url(url).build()
        return suspendCoroutine { continuation ->
            val attempt = ++generation
            connectContinuation = continuation
            connectRequestId = UUID.randomUUID().toString()
            authenticated = false
            notifyStateChange("connecting")
            val client = OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .build()
            okHttpClient = client
            webSocket = client.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(socket: WebSocket, response: Response) {
                    scope.launch { if (attempt == generation) sendConnectFrame(options) }
                }
                override fun onMessage(socket: WebSocket, text: String) {
                    scope.launch { if (attempt == generation) handleMessage(text) }
                }
                override fun onClosing(socket: WebSocket, code: Int, reason: String) {
                    socket.close(code, reason)
                }
                override fun onFailure(socket: WebSocket, error: Throwable, response: Response?) {
                    scope.launch { if (attempt == generation) handleClose(error) }
                }
                override fun onClosed(socket: WebSocket, code: Int, reason: String) {
                    scope.launch { if (attempt == generation) handleClose(null) }
                }
            })
            connectTimeout = scope.launch {
                delay(30000)
                if (attempt == generation && connectContinuation != null) {
                    handleClose(Exception("Connection timeout"))
                }
            }
        }
    }

    private fun sendConnectFrame(options: JSObject) {
        val clientName = options.getString("clientName") ?: "eliza-capacitor-android"
        val clientVersion = options.getString("clientVersion") ?: "1.0.0"
        val roleParam = options.getString("role") ?: "operator"
        val scopesParam = options.optJSONArray("scopes")?.let { arr ->
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

        val id = checkNotNull(connectRequestId)
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
            requestTimeouts[id] = scope.launch {
                delay(60000)
                requestTimeouts.remove(id)
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

                // Only the matching handshake response may authenticate this socket.
                if (connectContinuation != null && id == connectRequestId) {
                    if (!json.optBoolean("ok", false)) {
                        val message = json.optJSONObject("error")?.optString("message") ?: "Connection failed"
                        isClosed = true
                        closeConnection(Exception(message))
                        notifyStateChange("disconnected", message)
                        return
                    }
                    val payload = json.optJSONObject("payload")
                    if (payload == null || payload.optInt("protocol", -1) != 3) {
                        isClosed = true
                        closeConnection(Exception("Invalid gateway handshake"))
                        notifyStateChange("disconnected", "Invalid gateway handshake")
                        return
                    }
                    try {
                        handleHelloOk(payload)
                    } catch (error: Exception) {
                        // error-policy:J3 Reject a malformed peer handshake and release its promise.
                        isClosed = true
                        closeConnection(Exception("Invalid gateway handshake", error))
                        notifyStateChange("disconnected", "Invalid gateway handshake")
                        return
                    }
                    val continuation = checkNotNull(connectContinuation)
                    connectContinuation = null
                    connectRequestId = null
                    connectTimeout?.cancel()
                    connectTimeout = null
                    continuation.resume(JSObject().apply {
                        put("connected", true)
                        put("sessionId", sessionId)
                        put("protocol", protocolVersion)
                        put("methods", JSONArray(methods))
                        put("events", JSONArray(events))
                        put("role", role)
                        put("scopes", JSONArray(scopes))
                    })
                    return
                }

                // Handle pending request
                pendingRequests.remove(id)?.let { continuation ->
                    requestTimeouts.remove(id)?.cancel()
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
            if (frameType == "event" && authenticated) {
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
        authenticated = true
        notifyStateChange("connected")
    }

    private fun handleClose(error: Throwable?) {
        closeConnection(Exception("Connection closed", error))
        if (isClosed) {
            notifyStateChange("disconnected", error?.message)
            return
        }
        notifyStateChange("reconnecting", error?.message)
        notifyListeners("error", JSObject().apply {
            put("message", "Connection lost: ${error?.message ?: "peer closed"}")
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
            reconnectJob = null
            val url = options?.getString("url")
            if (url != null && !isClosed) {
                val beforeAttempt = generation
                try {
                    establishConnection(url, checkNotNull(options))
                } catch (error: Exception) {
                    // error-policy:J1 Transport callbacks already settle failed attempts.
                    // Only a synchronous setup failure still owns this generation.
                    if (generation == beforeAttempt || generation == beforeAttempt + 1) handleClose(error)
                }
            }
        }
    }

    private fun closeConnection(error: Exception = Exception("Client disconnect")) {
        // Invalidate callbacks before cancelling the transport. Old sockets and
        // timeout jobs must never settle promises belonging to a later session.
        generation++
        authenticated = false
        val connecting = connectContinuation
        connectContinuation = null
        connectRequestId = null
        connectTimeout?.cancel()
        connectTimeout = null
        val requests = pendingRequests.values.toList()
        pendingRequests.clear()
        requestTimeouts.values.forEach { it.cancel() }
        requestTimeouts.clear()
        webSocket?.cancel()
        webSocket = null
        okHttpClient?.connectionPool?.evictAll()
        okHttpClient?.dispatcher?.executorService?.shutdown()
        okHttpClient = null
        sessionId = null
        protocolVersion = null
        role = null
        scopes = emptyList()
        methods = emptyList()
        events = emptyList()
        lastSeq = null
        connecting?.resumeWithException(error)
        requests.forEach { it.resumeWithException(error) }
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
        scope.launch {
            isClosed = true
            reconnectJob?.cancel()
            closeConnection()
            scope.cancel()
        }
    }

    // Helper extension
    private fun JSObject.toJson(): JSONObject {
        return JSONObject(this.toString())
    }
}
