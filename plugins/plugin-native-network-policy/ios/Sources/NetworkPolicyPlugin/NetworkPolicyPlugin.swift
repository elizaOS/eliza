import Foundation
import Capacitor
import Network

/// Native iOS implementation of the `ElizaNetworkPolicy` Capacitor plugin
/// (R5-versioning §4.2).
///
/// Bridges `NWPathMonitor` to the TypeScript `NetworkPolicyPlugin`
/// interface. The voice-model auto-updater calls `getPathHints()` before
/// every download to gate on `isExpensive` (Apple's "treat as metered"
/// flag) and `isConstrained` (Low Data Mode).
///
/// Implementation note: the plugin keeps one long-lived `NWPathMonitor`
/// instance and reads its `currentPath` on each call. This avoids the
/// cost of starting/stopping a monitor per request and gives us a "live"
/// path snapshot — `NWPathMonitor.currentPath` is updated as the OS sees
/// path changes (cellular ↔ Wi-Fi handover, hotspot toggle, etc.).
@objc(ElizaNetworkPolicyPlugin)
public class ElizaNetworkPolicyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaNetworkPolicyPlugin"
    public let jsName = "ElizaNetworkPolicy"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getMeteredHint", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPathHints", returnType: CAPPluginReturnPromise),
    ]

    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "ai.eliza.network-policy.monitor", qos: .utility)
    private var started = false

    public override func load() {
        startIfNeeded()
    }

    deinit {
        if started {
            monitor.cancel()
        }
    }

    private func startIfNeeded() {
        if started { return }
        // The `pathUpdateHandler` is intentionally empty — we only read
        // `monitor.currentPath` on demand. The handler is required for the
        // monitor to publish path updates internally.
        monitor.pathUpdateHandler = { _ in }
        monitor.start(queue: monitorQueue)
        started = true
    }

    /// Android-only stub on iOS. Always resolves with a placeholder shape
    /// so the JS bridge can call `getMeteredHint()` uniformly across
    /// platforms; iOS callers should prefer `getPathHints()`.
    @objc func getMeteredHint(_ call: CAPPluginCall) {
        var response: [String: Any] = ["source": "android-os"]
        response["metered"] = NSNull()
        call.resolve(response)
    }

    @objc func getPathHints(_ call: CAPPluginCall) {
        startIfNeeded()
        let path = monitor.currentPath
        let response: [String: Any] = [
            "isExpensive": path.isExpensive,
            "isConstrained": path.isConstrained,
            "source": "nw-path-monitor",
        ]
        call.resolve(response)
    }
}
