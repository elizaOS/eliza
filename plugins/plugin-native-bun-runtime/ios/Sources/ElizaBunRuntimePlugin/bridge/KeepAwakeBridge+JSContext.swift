import Foundation
import JavaScriptCore

/// JSContext (compatibility engine) installer for `keep_awake_set`.
///
/// Kept in its own file — separate from the JavaScriptCore-free
/// `KeepAwakeBridge` core — so the core type can compile into the full-Bun
/// engine build (which omits JavaScriptCore and never lists this file in its
/// podspec source set). On the compat path the closure funnels into the same
/// shared ref-counted holder used by the full-Bun `host_call` dispatch.
extension KeepAwakeBridge {
    public func install(into ctx: JSContext) {
        ctx.installBridgeFunction(name: "keep_awake_set") { args in
            let enabled = args.first?.toBool() ?? false
            self.setEnabled(enabled)
            return true
        }
    }
}
