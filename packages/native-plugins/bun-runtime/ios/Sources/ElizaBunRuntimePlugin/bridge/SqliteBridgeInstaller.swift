import Foundation
import JavaScriptCore

/// One-shot installer for the SQLite bridge module.
///
/// The main `BridgeInstaller` should call `SqliteBridgeInstaller.install(into:)`
/// once during runtime startup, alongside the other bridge installations.
/// Returns the bridge instance so the caller can invoke `shutdown()` during
/// runtime teardown.
///
/// Suggested wiring in `BridgeInstaller.install`:
///
///     let sqlite = SqliteBridgeInstaller.install(into: ctx)
///     // ...add `sqlite: SqliteBridge` to `BridgeKit`...
///
/// And in the kit shutdown path:
///
///     kit.sqlite.shutdown()
public enum SqliteBridgeInstaller {
    @discardableResult
    public static func install(into ctx: JSContext) -> SqliteBridge {
        let bridge = SqliteBridge()
        bridge.install(into: ctx)
        return bridge
    }
}
