import Foundation
import Capacitor
import Network

/** Capacitor bridge for Eliza Gateway connectivity and Bonjour discovery. */
@objc(GatewayPlugin)
public class GatewayPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GatewayPlugin"
    public let jsName = "Gateway"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDiscoveredGateways", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isConnected", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getConnectionInfo", returnType: CAPPluginReturnPromise)
    ]

    var browser: NWBrowser?
    var discoveredGateways: [String: JSObject] = [:]
    let serviceType = "_eliza-gw._tcp"
    var isDiscovering = false
    var webSocket: URLSessionWebSocketTask?
    var urlSession: URLSession?
    var pendingRequests: [String: (resolve: (JSObject) -> Void, reject: (Error) -> Void)] = [:]
    var options: JSObject?
    var sessionId: String?
    var protocolVersion: Int?
    var role: String?
    var scopes: [String] = []
    var methods: [String] = []
    var events: [String] = []
    var lastSequence: Int?
    var isClosed = false
    var backoffMs: TimeInterval = 0.8
    var reconnectTimer: Timer?
    var connectContinuation: CheckedContinuation<JSObject, Error>?

    @objc func connect(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url") else {
            call.reject("Missing URL parameter")
            return
        }
        guard let url = URL(string: urlString) else {
            call.reject("Invalid URL")
            return
        }
        options = call.jsObjectRepresentation
        closeConnection()
        isClosed = false
        backoffMs = 0.8
        Task {
            do {
                let result = try await establishConnection(
                    url: url,
                    options: call.jsObjectRepresentation
                )
                call.resolve(result)
            } catch {
                call.reject("Connection failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        isClosed = true
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        closeConnection()
        sessionId = nil
        protocolVersion = nil
        notifyStateChange(state: "disconnected", reason: "Client disconnect")
        call.resolve()
    }

    @objc func isConnected(_ call: CAPPluginCall) {
        call.resolve(["connected": webSocket != nil && webSocket?.state == .running])
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let method = call.getString("method") else {
            call.reject("Missing method parameter")
            return
        }
        guard let socket = webSocket, socket.state == .running else {
            call.resolve([
                "ok": false,
                "error": ["code": "NOT_CONNECTED", "message": "Not connected to gateway"]
            ])
            return
        }
        let requestId = UUID().uuidString
        let frame: [String: Any] = [
            "type": "req",
            "id": requestId,
            "method": method,
            "params": call.getObject("params") ?? [:]
        ]
        Task {
            do {
                call.resolve(try await sendRequest(id: requestId, frame: frame))
            } catch {
                call.resolve([
                    "ok": false,
                    "error": ["code": "REQUEST_FAILED", "message": error.localizedDescription]
                ])
            }
        }
    }

    @objc func getConnectionInfo(_ call: CAPPluginCall) {
        call.resolve([
            "url": options?["url"] as? String ?? NSNull(),
            "sessionId": sessionId ?? NSNull(),
            "protocol": protocolVersion ?? NSNull(),
            "role": role ?? NSNull()
        ])
    }
}
