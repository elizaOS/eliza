package ai.eliza.plugins.mobileagentbridge

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Eliza MobileAgentBridge — Android scaffold.
 *
 * Locks the Capacitor surface (`startInboundTunnel`, `stopInboundTunnel`,
 * `getTunnelStatus`) so the JS runtime can call into this plugin today.
 * The actual outbound-tunnel transport (OkHttp WebSocket + loopback
 * proxy to the on-device agent at `127.0.0.1:31337`) is the follow-on
 * described in `docs/reverse-direction-tunneling.md`.
 *
 * Until the transport lands, every call reports a structured
 * `not_implemented` status. The runtime treats this as a soft-fail:
 * the phone keeps serving its on-device agent locally and the Mac
 * client surfaces a "tunnel not running" state.
 */
@CapacitorPlugin(name = "MobileAgentBridge")
class MobileAgentBridgePlugin : Plugin() {
    private var lastRelayUrl: String? = null
    private var lastDeviceId: String? = null

    @PluginMethod
    fun startInboundTunnel(call: PluginCall) {
        val relayUrl = call.getString("relayUrl")?.trim()
        val deviceId = call.getString("deviceId")?.trim()
        if (relayUrl.isNullOrEmpty()) {
            call.reject("MobileAgentBridge.startInboundTunnel requires relayUrl")
            return
        }
        if (deviceId.isNullOrEmpty()) {
            call.reject("MobileAgentBridge.startInboundTunnel requires deviceId")
            return
        }
        lastRelayUrl = relayUrl
        lastDeviceId = deviceId

        val notImplemented =
            "Android MobileAgentBridge transport is not implemented yet. " +
                "See docs/reverse-direction-tunneling.md."

        val status = JSObject().apply {
            put("state", "error")
            put("relayUrl", relayUrl)
            put("deviceId", deviceId)
            put("lastError", notImplemented)
        }
        val event = JSObject().apply {
            put("state", "error")
            put("reason", notImplemented)
        }
        notifyListeners("stateChange", event)
        call.resolve(status)
    }

    @PluginMethod
    fun stopInboundTunnel(call: PluginCall) {
        lastRelayUrl = null
        lastDeviceId = null
        val event = JSObject().apply { put("state", "idle") }
        notifyListeners("stateChange", event)
        call.resolve()
    }

    @PluginMethod
    fun getTunnelStatus(call: PluginCall) {
        val state = if (lastRelayUrl == null) "idle" else "error"
        val notImplemented =
            "Android MobileAgentBridge transport is not implemented yet. " +
                "See docs/reverse-direction-tunneling.md."
        val status = JSObject().apply {
            put("state", state)
            put("relayUrl", lastRelayUrl)
            put("deviceId", lastDeviceId)
            put("lastError", if (state == "idle") null else notImplemented)
        }
        call.resolve(status)
    }
}
