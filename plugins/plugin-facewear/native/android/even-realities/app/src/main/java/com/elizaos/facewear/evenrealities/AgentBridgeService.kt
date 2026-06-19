package com.elizaos.facewear.evenrealities

import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Binder
import android.os.IBinder
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import android.util.Base64
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * WebSocket client that connects to the elizaOS agent and bridges commands to G1BleService.
 *
 * Inbound text frames from the agent are parsed as elizaOS XR protocol messages:
 *   { type: "agent_text", text: "..." }  → display on G1 via G1BleService.displayText()
 *   { type: "transcript", text: "...", final: true } → show transcription on G1
 *   { type: "ready", sessionId: "..." }  → connection confirmed
 *
 * Binary frames (tts_audio) are logged but not played — the G1 has no speaker.
 * The agent should detect device type "even-realities" and skip TTS audio frames.
 *
 * Outbound: this bridge sends a "hello" frame on connect identifying itself as
 * device type "even-realities" so the agent can adjust its response format.
 */
class AgentBridgeService : Service() {

    private val TAG = "AgentBridgeService"

    private val binder = LocalBinder()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private val sessionId = UUID.randomUUID().toString()

    private var g1Service: G1BleService? = null
    private val g1Connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            g1Service = (binder as G1BleService.LocalBinder).service
            g1Service?.onDataReceived = { side, bytes -> forwardG1DataToAgent(side, bytes) }
        }
        override fun onServiceDisconnected(name: ComponentName) { g1Service = null }
    }

    var onStatusChange: ((String) -> Unit)? = null

    inner class LocalBinder : Binder() {
        val service: AgentBridgeService get() = this@AgentBridgeService
    }

    override fun onCreate() {
        super.onCreate()
        bindService(Intent(this, G1BleService::class.java), g1Connection, Context.BIND_AUTO_CREATE)
    }

    override fun onBind(intent: Intent): IBinder = binder

    fun connect(agentWsUrl: String) {
        webSocket?.close(1000, "Reconnecting")
        onStatusChange?.invoke("Connecting to agent: $agentWsUrl")

        val request = Request.Builder().url(agentWsUrl).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                val hello = JSONObject().apply {
                    put("type", "hello")
                    put("deviceType", "even-realities")
                    put("sessionId", sessionId)
                }.toString()
                ws.send(hello)
                onStatusChange?.invoke("Connected to agent (session: $sessionId)")
            }

            override fun onMessage(ws: WebSocket, text: String) {
                handleAgentTextFrame(text)
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                // TTS audio binary frame — G1 has no speaker, ignore audio payload.
                // The 4-byte prefix + JSON header follows the plugin-xr binary protocol.
                Log.d(TAG, "Binary frame received (${bytes.size} bytes) — skipping audio on G1")
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                onStatusChange?.invoke("Agent WebSocket error: ${t.message}")
                scheduleReconnect(agentWsUrl)
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                onStatusChange?.invoke("Agent disconnected: $reason")
            }
        })
    }

    private fun handleAgentTextFrame(text: String) {
        try {
            val json = JSONObject(text)
            when (json.optString("type")) {
                "ready" -> {
                    onStatusChange?.invoke("Agent ready — session ${json.optString("sessionId")}")
                }
                "agent_text" -> {
                    val msg = json.optString("text")
                    if (msg.isNotEmpty()) {
                        g1Service?.displayText(msg) ?: Log.w(TAG, "G1 service not bound")
                    }
                }
                "clear_display" -> {
                    g1Service?.clearDisplay() ?: Log.w(TAG, "G1 service not bound")
                }
                "mic_control" -> {
                    g1Service?.setMicEnabled(json.optBoolean("enabled", true))
                        ?: Log.w(TAG, "G1 service not bound")
                }
                "brightness" -> {
                    g1Service?.setBrightness(json.optInt("level", 10), json.optBoolean("auto", false))
                        ?: Log.w(TAG, "G1 service not bound")
                }
                "battery_status" -> {
                    g1Service?.requestBatteryStatus() ?: Log.w(TAG, "G1 service not bound")
                }
                "heartbeat" -> {
                    g1Service?.sendHeartbeat() ?: Log.w(TAG, "G1 service not bound")
                }
                "g1_write" -> {
                    val bytes = jsonArrayToByteArray(json.optJSONArray("data"))
                    if (bytes.isNotEmpty()) {
                        g1Service?.sendRaw(json.optString("side", "both"), bytes)
                            ?: Log.w(TAG, "G1 service not bound")
                    }
                }
                "transcript" -> {
                    if (json.optBoolean("final", false)) {
                        val transcript = json.optString("text")
                        if (transcript.isNotEmpty()) {
                            g1Service?.displayText("You: $transcript")
                        }
                    }
                }
                "pong" -> Log.d(TAG, "Pong from agent")
                else -> Log.d(TAG, "Unhandled agent frame type: ${json.optString("type")}")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse agent frame: ${e.message}")
        }
    }

    private fun jsonArrayToByteArray(array: JSONArray?): ByteArray {
        if (array == null) return ByteArray(0)
        return ByteArray(array.length()) { index ->
            (array.optInt(index) and 0xff).toByte()
        }
    }

    private fun forwardG1DataToAgent(side: GlassSide, bytes: ByteArray) {
        val sideName = if (side == GlassSide.LEFT) "left" else "right"
        val frame = JSONObject().apply {
            put("type", "g1_raw")
            put("side", sideName)
            put("data", JSONArray(bytes.map { it.toInt() and 0xff }))
            put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        }
        webSocket?.send(frame.toString())

        if (bytes.isNotEmpty() && (bytes[0].toInt() and 0xff) == 0xF1) {
            val sequence = if (bytes.size > 1) bytes[1].toInt() and 0xff else JSONObject.NULL
            val audioPayload = if (bytes.size > 2) bytes.copyOfRange(2, bytes.size) else ByteArray(0)
            val audioFrame = JSONObject().apply {
                put("type", "mic_lc3")
                put("side", sideName)
                put("sampleRate", 16000)
                put("encoding", "lc3")
                put("sequence", sequence)
                put("lc3", JSONArray(audioPayload.map { it.toInt() and 0xff }))
                put("base64", Base64.encodeToString(audioPayload, Base64.NO_WRAP))
            }
            webSocket?.send(audioFrame.toString())
        }
    }

    fun sendPing() {
        webSocket?.send(JSONObject().apply { put("type", "ping") }.toString())
    }

    private fun scheduleReconnect(url: String) {
        scope.launch {
            delay(5_000)
            connect(url)
        }
    }

    override fun onDestroy() {
        scope.cancel()
        webSocket?.close(1000, "Service destroyed")
        unbindService(g1Connection)
        client.dispatcher.executorService.shutdown()
        super.onDestroy()
    }
}
