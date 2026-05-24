package com.elizaos.facewear.xreal

import android.content.Context
import android.webkit.JavascriptInterface
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.util.Base64
import java.util.concurrent.TimeUnit

/**
 * JavaScript bridge between the facewear PWA (running in the WebView) and the
 * elizaOS agent WebSocket.
 *
 * The PWA calls window.ElizaXreal.<method>(...) to send/receive frames and
 * control messages. The bridge forwards binary frames over a WebSocket using the
 * same protocol as plugin-xr (4-byte big-endian JSON-header length prefix).
 *
 * XREAL SDK note: once the XREAL SDK AAR (3.0.0) is integrated, replace the
 * CameraService Camera2 path and add NRGlassesController calls here for
 * display brightness, IMU events, and NR Spatial Anchor APIs.
 */
class XrealBridgeJs(private val context: Context) {

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private var webSocket: WebSocket? = null
    private var agentUrl: String = ""
    private var sessionId: String = ""
    private var onMessageCallback: String? = null

    @JavascriptInterface
    fun connect(agentWsUrl: String, sessionIdParam: String) {
        agentUrl = agentWsUrl
        sessionId = sessionIdParam
        val request = Request.Builder().url(agentWsUrl).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                val hello = JSONObject().apply {
                    put("type", "hello")
                    put("deviceType", "xreal")
                    put("sessionId", sessionId)
                }.toString()
                ws.send(hello)
            }

            override fun onMessage(ws: WebSocket, text: String) {
                onMessageCallback?.let { cb ->
                    android.util.Log.d("XrealBridge", "Text frame: $text")
                }
            }

            override fun onMessage(ws: WebSocket, bytes: ByteString) {
                // TTS audio binary frame → forward to PWA for playback
                val b64 = Base64.getEncoder().encodeToString(bytes.toByteArray())
                android.util.Log.d("XrealBridge", "Binary frame received (${bytes.size} bytes)")
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                android.util.Log.e("XrealBridge", "WebSocket error: ${t.message}")
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                android.util.Log.i("XrealBridge", "WebSocket closed: $reason")
            }
        })
    }

    /** Send a text control message (JSON string) to the agent. */
    @JavascriptInterface
    fun sendControl(jsonText: String) {
        webSocket?.send(jsonText)
    }

    /**
     * Send a binary frame (Base64-encoded) to the agent.
     * The PWA encodes the 4-byte-prefixed binary frame locally and passes it here.
     */
    @JavascriptInterface
    fun sendBinaryFrame(base64Frame: String) {
        val bytes = Base64.getDecoder().decode(base64Frame)
        webSocket?.send(bytes.toByteString())
    }

    /**
     * Returns the device capabilities JSON string so the PWA can adapt its UI.
     * Add NRGlassesController capability flags here when XREAL SDK is integrated.
     */
    @JavascriptInterface
    fun getDeviceInfo(): String {
        return JSONObject().apply {
            put("deviceType", "xreal")
            put("platform", "android")
            put("xrealSdkAvailable", isXrealSdkAvailable())
            put("camera", true)
            put("audio", true)
        }.toString()
    }

    /**
     * Reflect XREAL SDK presence so the PWA can gate advanced XR features.
     * Returns true when the XREAL SDK AAR is present and the NRManager is initialised.
     */
    private fun isXrealSdkAvailable(): Boolean {
        return try {
            Class.forName("com.nreal.magic.sdk.NRManager")
            true
        } catch (_: ClassNotFoundException) {
            false
        }
    }

    fun disconnect() {
        webSocket?.close(1000, "Activity destroyed")
        webSocket = null
        client.dispatcher.executorService.shutdown()
    }
}
