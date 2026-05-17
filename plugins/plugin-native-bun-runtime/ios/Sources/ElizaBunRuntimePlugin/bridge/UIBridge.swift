import Foundation
import JavaScriptCore
import Capacitor

/// Implements `ui_post_message` and `ui_register_handler` from
/// `BRIDGE_CONTRACT.md`.
///
/// `ui_post_message` is a Capacitor event that flows from the agent → WebView.
/// The Capacitor plugin shell forwards the events via `notifyListeners` so
/// the React UI can subscribe with `addListener`.
///
/// `ui_register_handler` registers a JS callback under a string name. The
/// plugin's `call(method, args)` Capacitor method dispatches to the matching
/// handler and returns the result.
public final class UIBridge {
    private weak var context: JSContext?
    private weak var plugin: CAPPlugin?
    private var handlers: [String: ManagedCallback] = [:]
    private let lock = NSLock()

    public init(plugin: CAPPlugin?) {
        self.plugin = plugin
    }

    public func install(into ctx: JSContext) {
        self.context = ctx

        ctx.installBridgeFunction(name: "ui_post_message") { args in
            guard args.count >= 1,
                  let channel = args[0].toString() else {
                return NSNull()
            }
            let payload: Any? = args.count >= 2 ? args[1].toObject() : nil
            let event: [String: Any] = [
                "channel": channel,
                "payload": payload ?? NSNull(),
            ]
            DispatchQueue.main.async {
                self.plugin?.notifyListeners("eliza:ui", data: event)
            }
            return NSNull()
        }

        ctx.installBridgeFunction(name: "ui_register_handler") { args in
            guard args.count >= 2,
                  let method = args[0].toString() else {
                return NSNull()
            }
            let value = args[1]
            guard let mc = ManagedCallback(value: value) else { return NSNull() }
            self.lock.lock()
            self.handlers[method] = mc
            self.lock.unlock()
            return NSNull()
        }
    }

    /// Looks up a registered handler. Returns nil when nothing is registered
    /// under `method`. The caller is responsible for invoking it on the
    /// JSContext queue.
    public func handler(for method: String) -> ManagedCallback? {
        lock.lock()
        defer { lock.unlock() }
        return handlers[method]
    }

    public func clear() {
        lock.lock()
        handlers.removeAll()
        lock.unlock()
    }
}
