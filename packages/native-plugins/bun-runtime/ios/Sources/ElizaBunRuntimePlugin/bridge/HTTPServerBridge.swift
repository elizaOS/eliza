import Foundation
import JavaScriptCore

/// Compatibility registration for the old `http_serve_*` bridge surface.
///
/// iOS local mode must route foreground and backend calls through Capacitor /
/// engine IPC (`ElizaBunRuntime.call("http_request", ...)`) instead of opening
/// a localhost listener inside the app. Keeping these symbols registered gives
/// older JSContext bundles a deterministic error without ever binding a port.
public final class HTTPServerBridge {
    public init() {}

    public func install(into ctx: JSContext) {
        ctx.installBridgeFunction(name: "http_serve_start") { _ in
            [
                "ok": false,
                "port": 0,
                "error": "http_serve_start is disabled on iOS; use ElizaBunRuntime.call(http_request) IPC",
            ]
        }

        ctx.installBridgeFunction(name: "http_serve_register_handler") { _ in
            NSNull()
        }

        ctx.installBridgeFunction(name: "http_serve_stop") { _ in
            NSNull()
        }
    }

    public func shutdown() {}
}
