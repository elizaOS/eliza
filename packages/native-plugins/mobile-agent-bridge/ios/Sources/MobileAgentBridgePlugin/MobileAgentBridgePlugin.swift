import Foundation
import Capacitor

/// Eliza MobileAgentBridge — iOS scaffold.
///
/// Locks the Capacitor surface (`startInboundTunnel`, `stopInboundTunnel`,
/// `getTunnelStatus`) so the JS runtime can call into this plugin today.
/// The actual outbound-tunnel transport (URLSessionWebSocketTask + proxy
/// to the in-process agent ITTP surface) is the follow-on described in
/// `docs/reverse-direction-tunneling.md`.
///
/// Until the transport lands, every call reports a structured
/// `not_implemented` status. The runtime treats this as a soft-fail:
/// the phone keeps serving its on-device agent locally and the Mac
/// client surfaces a "tunnel not running" state.
@objc(MobileAgentBridgePlugin)
public class MobileAgentBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MobileAgentBridgePlugin"
    public let jsName = "MobileAgentBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startInboundTunnel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopInboundTunnel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getTunnelStatus", returnType: CAPPluginReturnPromise),
    ]

    private var lastRelayUrl: String?
    private var lastDeviceId: String?

    @objc func startInboundTunnel(_ call: CAPPluginCall) {
        guard let relayUrl = call.getString("relayUrl")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !relayUrl.isEmpty else {
            call.reject("MobileAgentBridge.startInboundTunnel requires relayUrl")
            return
        }
        guard let deviceId = call.getString("deviceId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !deviceId.isEmpty else {
            call.reject("MobileAgentBridge.startInboundTunnel requires deviceId")
            return
        }

        lastRelayUrl = relayUrl
        lastDeviceId = deviceId

        let status: [String: Any] = [
            "state": "error",
            "relayUrl": relayUrl,
            "deviceId": deviceId,
            "lastError": "iOS MobileAgentBridge transport is not implemented yet. See docs/reverse-direction-tunneling.md.",
        ]
        notifyListeners("stateChange", data: [
            "state": "error",
            "reason": status["lastError"] ?? NSNull(),
        ])
        call.resolve(status)
    }

    @objc func stopInboundTunnel(_ call: CAPPluginCall) {
        lastRelayUrl = nil
        lastDeviceId = nil
        notifyListeners("stateChange", data: ["state": "idle"])
        call.resolve()
    }

    @objc func getTunnelStatus(_ call: CAPPluginCall) {
        call.resolve([
            "state": lastRelayUrl == nil ? "idle" : "error",
            "relayUrl": lastRelayUrl ?? NSNull(),
            "deviceId": lastDeviceId ?? NSNull(),
            "lastError": lastRelayUrl == nil
                ? NSNull()
                : "iOS MobileAgentBridge transport is not implemented yet. See docs/reverse-direction-tunneling.md.",
        ])
    }
}
