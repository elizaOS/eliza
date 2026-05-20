import Foundation

/// Persisted connection configuration stored in UserDefaults.
/// Provides the agent WebSocket URL and device name used across sessions.
final class ConnectionConfig: ObservableObject {
    private enum Key {
        static let agentUrl = "eliza_facewear_agent_url"
        static let deviceName = "eliza_facewear_device_name"
    }

    @Published var agentUrl: String {
        didSet { UserDefaults.standard.set(agentUrl, forKey: Key.agentUrl) }
    }

    @Published var deviceName: String {
        didSet { UserDefaults.standard.set(deviceName, forKey: Key.deviceName) }
    }

    /// Derived WebSocket URL from agentUrl (replace http/https scheme with ws/wss).
    var webSocketUrl: URL? {
        var raw = agentUrl
        if raw.hasPrefix("http://") {
            raw = "ws://" + raw.dropFirst(7)
        } else if raw.hasPrefix("https://") {
            raw = "wss://" + raw.dropFirst(8)
        }
        // Append the XR WebSocket path if not already present
        if !raw.hasSuffix("/xr-ws") && !raw.hasSuffix("/xr-ws/") {
            raw = raw.hasSuffix("/") ? raw + "xr-ws" : raw + "/xr-ws"
        }
        return URL(string: raw)
    }

    /// PWA URL for the WebXR view (loaded in WKWebView).
    var pwaUrl: URL? {
        var base = agentUrl
        if !base.hasPrefix("http") { base = "http://" + base }
        return URL(string: base)
    }

    init() {
        agentUrl = UserDefaults.standard.string(forKey: Key.agentUrl) ?? "http://192.168.1.100:31337"
        deviceName = UserDefaults.standard.string(forKey: Key.deviceName) ?? "apple-vision-pro"
    }
}
