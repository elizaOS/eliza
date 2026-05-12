import Foundation
import Capacitor

/// Capacitor plugin shell.
///
/// Exposes the JS surface declared in `src/definitions.ts`:
///   - `start(opts)` — boot the runtime and load the agent bundle
///   - `sendMessage(opts)` — round-trip a chat message through the agent
///   - `getStatus()` — return ready / model / tokensPerSecond
///   - `stop()` — tear down the runtime
///   - `call({ method, args })` — invoke any `ui_register_handler` handler
///
/// The plugin delegates everything to `ElizaBunRuntime`, which owns the
/// JSContext on its dedicated serial dispatch queue.
@objc(ElizaBunRuntimePlugin)
public class ElizaBunRuntimePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaBunRuntimePlugin"
    public let jsName = "ElizaBunRuntime"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendMessage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "call", returnType: CAPPluginReturnPromise),
    ]

    private var runtime: ElizaBunRuntime?

    override public func load() {
        // Construct lazily on first start to avoid holding the JSVirtualMachine
        // when the app launches without the runtime.
        runtime = nil
    }

    // MARK: - start

    @objc func start(_ call: CAPPluginCall) {
        let bundlePath = call.getString("bundlePath")
        let polyfillPath = call.getString("polyfillPath")
        let engine = call.getString("engine") ?? "auto"
        let argv = call.getArray("argv", String.self) ?? ["bun", "public/agent/agent-bundle.js"]
        let env: [String: String]
        if let raw = call.getObject("env") {
            env = raw.compactMapValues { $0 as? String }
        } else {
            env = [:]
        }

        let runtime = ensureRuntime()
        runtime.start(
            bundlePath: bundlePath,
            polyfillPath: polyfillPath,
            engine: engine,
            argv: argv,
            env: env
        ) { result in
            switch result {
            case .success(let outcome):
                call.resolve([
                    "ok": true,
                    "bridgeVersion": outcome.bridgeVersion,
                ])
            case .failure(let error):
                call.resolve([
                    "ok": false,
                    "error": "\(error)",
                ])
            }
        }
    }

    // MARK: - sendMessage

    @objc func sendMessage(_ call: CAPPluginCall) {
        guard let runtime = runtime else {
            call.reject("ElizaBunRuntime is not started")
            return
        }
        guard let message = call.getString("message") else {
            call.reject("sendMessage requires a message string")
            return
        }
        let conversationId = call.getString("conversationId")
        runtime.sendMessage(text: message, conversationId: conversationId) { result in
            switch result {
            case .success(let reply):
                call.resolve(["reply": reply])
            case .failure(let error):
                call.reject("\(error)")
            }
        }
    }

    // MARK: - getStatus

    @objc func getStatus(_ call: CAPPluginCall) {
        guard let runtime = runtime else {
            call.resolve(["ready": false])
            return
        }
        var payload: JSObject = [
            "ready": runtime.isRunning,
            "engine": runtime.engineMode,
        ]
        if let v = runtime.bridgeVersion { payload["bridgeVersion"] = v }
        if let m = runtime.loadedModelPath { payload["model"] = m }
        if let tps = runtime.tokensPerSecond { payload["tokensPerSecond"] = tps }
        call.resolve(payload)
    }

    // MARK: - stop

    @objc func stop(_ call: CAPPluginCall) {
        guard let runtime = runtime else {
            call.resolve()
            return
        }
        runtime.stop {
            call.resolve()
        }
    }

    // MARK: - call

    @objc func call(_ pluginCall: CAPPluginCall) {
        guard let runtime = runtime else {
            pluginCall.reject("ElizaBunRuntime is not started")
            return
        }
        guard let method = pluginCall.getString("method") else {
            pluginCall.reject("call requires a method name")
            return
        }
        let args: Any? = pluginCall.getValue("args")
        runtime.dispatchHandler(method: method, args: args) { (result: Result<Any?, Error>) in
            switch result {
            case .success(let value):
                pluginCall.resolve(["result": Self.jsonSafe(value)])
            case .failure(let error):
                pluginCall.reject("\(error)")
            }
        }
    }

    // MARK: - Helpers

    private func ensureRuntime() -> ElizaBunRuntime {
        if let existing = runtime { return existing }
        let new = ElizaBunRuntime(plugin: self)
        runtime = new
        return new
    }

    /// Capacitor's bridge serializes a known set of Foundation types
    /// (`NSString`, `NSNumber`, `NSArray`, `NSDictionary`, `NSNull`). Other
    /// types get coerced to their string description so the React side
    /// always sees something.
    private static func jsonSafe(_ value: Any?) -> Any {
        guard let value = value else { return NSNull() }
        if value is NSNull { return NSNull() }
        if let s = value as? String { return s }
        if let n = value as? NSNumber { return n }
        if let arr = value as? [Any] { return arr.map { jsonSafe($0) } }
        if let dict = value as? [String: Any] {
            var out: [String: Any] = [:]
            for (k, v) in dict { out[k] = jsonSafe(v) }
            return out
        }
        return String(describing: value)
    }
}

// Compatibility helper for `call.getArray<T>` typed access on older Capacitor
// builds that don't expose the generic form.
extension CAPPluginCall {
    func getArray<T>(_ key: String, _: T.Type) -> [T]? {
        guard let raw = self.getArray(key) else { return nil }
        return raw.compactMap { $0 as? T }
    }
}
