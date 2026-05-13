import Foundation
import JavaScriptCore
import Capacitor

/// Installs every `__ELIZA_BRIDGE__` host function on the given JSContext.
///
/// Call once at runtime startup, before evaluating the polyfill prefix or
/// the agent bundle. All host functions execute on the JSContext's queue
/// (`ai.eliza.bun.runtime`); async bridges dispatch off the queue internally
/// and hop back to fulfill JS promises.
///
    /// The returned `BridgeKit` holds references to each bridge module so the
    /// caller can release runtime-owned resources when the runtime stops.
public struct BridgeKit {
    public let fs: FSBridge
    public let paths: PathsBridge
    public let crypto: CryptoBridge
    public let http: HTTPBridge
    public let httpServer: HTTPServerBridge
    public let llama: LlamaBridge
    public let log: LogBridge
    public let process: ProcessBridge
    public let ui: UIBridge
}

public enum BridgeInstaller {
    public static let version = "v1"

    public static func install(
        into ctx: JSContext,
        paths: SandboxPaths,
        plugin: CAPPluginRef,
        argv: [String],
        env: [String: String],
        runtime: ElizaBunRuntime
    ) -> BridgeKit {
        // Seed the __ELIZA_BRIDGE__ object and version BEFORE installing
        // host functions so the polyfill can detect them at module top-level.
        ctx.evaluateScript("globalThis.__ELIZA_BRIDGE__ = globalThis.__ELIZA_BRIDGE__ || {};")
        ctx.evaluateScript("globalThis.__ELIZA_BRIDGE_VERSION__ = \"\(version)\";")
        if let bridge = ctx.objectForKeyedSubscript("__ELIZA_BRIDGE__") {
            bridge.setObject(version, forKeyedSubscript: "version" as NSString)
        }

        let fs = FSBridge()
        fs.install(into: ctx)

        let pathsBridge = PathsBridge(paths: paths)
        pathsBridge.install(into: ctx)

        let crypto = CryptoBridge()
        crypto.install(into: ctx)

        let http = HTTPBridge()
        http.install(into: ctx)

        let httpServer = HTTPServerBridge()
        httpServer.install(into: ctx)

        let llama = LlamaBridge()
        llama.install(into: ctx)

        let log = LogBridge()
        log.install(into: ctx)

        let process = ProcessBridge(initialArgv: argv, initialEnv: env, owner: runtime)
        process.install(into: ctx)

        let ui = UIBridge(plugin: plugin.value)
        ui.install(into: ctx)

        return BridgeKit(
            fs: fs,
            paths: pathsBridge,
            crypto: crypto,
            http: http,
            httpServer: httpServer,
            llama: llama,
            log: log,
            process: process,
            ui: ui
        )
    }
}

/// Lightweight weak-wrapper for the Capacitor plugin so we can pass it into
/// bridge constructors without creating a retain cycle through the plugin
/// instance.
public final class CAPPluginRef {
    public weak var value: CAPPlugin?
    public init(_ plugin: CAPPlugin?) {
        self.value = plugin
    }
}
