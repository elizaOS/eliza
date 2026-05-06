import Foundation
import Capacitor

/// Eliza Agent Plugin — iOS native status shell.
///
/// The request path itself is handled by app-core's in-process ITTP transport.
/// This native plugin exists so the shared mobile RuntimeGate can start/stop
/// and status-check the local agent capability on both Android and iOS.
@objc(AgentPlugin)
public class AgentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AgentPlugin"
    public let jsName = "Agent"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLocalAgentToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
    ]

    private static var startedAt: Double?
    private static let token = UUID().uuidString

    @objc func start(_ call: CAPPluginCall) {
        if Self.startedAt == nil {
            Self.startedAt = Date().timeIntervalSince1970 * 1000
        }
        call.resolve(status(state: "running"))
    }

    @objc func stop(_ call: CAPPluginCall) {
        Self.startedAt = nil
        call.resolve(["ok": true])
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve(status(state: Self.startedAt == nil ? "not_started" : "running"))
    }

    @objc func getLocalAgentToken(_ call: CAPPluginCall) {
        call.resolve([
            "available": true,
            "token": Self.token,
        ])
    }

    @objc func request(_ call: CAPPluginCall) {
        call.reject("iOS local agent requests are handled by the in-process ITTP transport")
    }

    private func status(state: String) -> JSObject {
        let startedAt = Self.startedAt
        let now = Date().timeIntervalSince1970 * 1000
        var payload: JSObject = [
            "state": state,
            "agentState": state,
            "available": true,
            "ready": state == "running",
            "uptimeMs": startedAt == nil ? 0 : max(0, now - (startedAt ?? now)),
        ]
        if let startedAt = startedAt {
            payload["startedAt"] = startedAt
        }
        return payload
    }
}
