import Foundation
import JavaScriptCore
import Capacitor

// Disambiguate `JSValue` — both JavaScriptCore (class) and Capacitor (marker
// protocol) export a type called `JSValue`. Inside this file we always mean
// the JSC class.
private typealias JSValue = JavaScriptCore.JSValue

/// Core runtime that hosts a JavaScriptCore JSContext on a dedicated serial
/// queue. The plugin shell (`ElizaBunRuntimePlugin`) talks to this class to
/// start/stop the agent, send chat messages, and route React UI calls into
/// JS-registered handlers via the UI bridge.
public final class ElizaBunRuntime {
    // MARK: - Public state

    public private(set) var isRunning: Bool = false
    public private(set) var bridgeVersion: String?
    public private(set) var loadedModelPath: String?
    public private(set) var tokensPerSecond: Double?
    public private(set) var engineMode: String = "compat"

    // MARK: - Private state

    private let queue = DispatchQueue(label: RuntimeQueue.label, qos: .userInitiated)
    private let virtualMachine = JSVirtualMachine()!
    private var context: JSContext?
    private var bridges: BridgeKit?
    private var fullBunEngine: FullBunEngineHost?
    private weak var plugin: CAPPlugin?

    // MARK: - Init

    public init(plugin: CAPPlugin?) {
        self.plugin = plugin
    }

    // MARK: - Lifecycle

    /// Starts the runtime. Loads the polyfill prefix, installs the bridge,
    /// then evaluates the agent bundle. Calls `startEliza()` if exported.
    public func start(
        bundlePath: String?,
        polyfillPath: String?,
        engine: String,
        argv: [String],
        env: [String: String],
        completion: @escaping (Result<StartOutcome, Error>) -> Void
    ) {
        if isRunning {
            completion(.success(StartOutcome(bridgeVersion: bridgeVersion ?? BridgeInstaller.version)))
            return
        }

        queue.async { [weak self] in
            guard let self = self else { return }
            RuntimeQueue.current = self.queue
            do {
                try self.bootstrap(
                    bundlePath: bundlePath,
                    polyfillPath: polyfillPath,
                    engine: engine,
                    argv: argv,
                    env: env
                )
                let outcome = StartOutcome(bridgeVersion: self.bridgeVersion ?? BridgeInstaller.version)
                completion(.success(outcome))
            } catch {
                completion(.failure(error))
            }
        }
    }

    public func stop(completion: @escaping () -> Void) {
        queue.async { [weak self] in
            self?.teardown()
            completion()
        }
    }

    public struct StartOutcome {
        public let bridgeVersion: String
    }

    // MARK: - Bridge-facing hooks

    /// Called by `ProcessBridge` when the agent calls `exit(code)`. Tears
    /// down the runtime and posts a UI event so the React shell can refresh.
    public func handleAgentExit(code: Int) {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.bridges?.ui.handler(for: "__internal_on_exit__")?.callSync(args: [code])
            self.teardown()
            DispatchQueue.main.async {
                self.plugin?.notifyListeners("milady:runtime-exit", data: ["code": code])
            }
        }
    }

    // MARK: - Public RPC surface used by the plugin shell

    public func sendMessage(
        text: String,
        conversationId: String?,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        queue.async { [weak self] in
            guard let self = self else {
                completion(.failure(Self.runtimeStaleError()))
                return
            }
            if let fullBunEngine = self.fullBunEngine {
                do {
                    let payload: [String: Any] = [
                        "message": text,
                        "conversationId": conversationId ?? NSNull(),
                    ]
                    let result = try fullBunEngine.call(method: "send_message", payload: payload)
                    completion(.success(self.extractReply(from: result)))
                } catch {
                    completion(.failure(error))
                }
                return
            }
            guard let ctx = self.context else {
                completion(.failure(self.makeError("Runtime is not started")))
                return
            }
            guard let handler = self.bridges?.ui.handler(for: "send_message") else {
                completion(.failure(self.makeError("Agent has not registered a send_message handler")))
                return
            }
            let payload: [String: Any] = [
                "message": text,
                "conversationId": conversationId ?? NSNull(),
            ]
            guard let result = handler.callSync(args: [payload]) else {
                completion(.failure(self.makeError("send_message handler returned undefined")))
                return
            }
            if let err = ctx.takeException() {
                completion(.failure(err))
                return
            }
            self.unwrapReply(result: result, ctx: ctx, completion: completion)
        }
    }

    public func dispatchHandler(
        method: String,
        args: Any?,
        completion: @escaping (Result<Any?, Error>) -> Void
    ) {
        queue.async { [weak self] in
            guard let self = self else {
                completion(.failure(Self.runtimeStaleError()))
                return
            }
            if let fullBunEngine = self.fullBunEngine {
                do {
                    completion(.success(try fullBunEngine.call(method: method, payload: args ?? NSNull())))
                } catch {
                    completion(.failure(error))
                }
                return
            }
            guard let ctx = self.context else {
                completion(.failure(self.makeError("Runtime is not started")))
                return
            }
            guard let handler = self.bridges?.ui.handler(for: method) else {
                completion(.failure(self.makeError("No handler registered for \(method)")))
                return
            }
            let callArgs: [Any] = args == nil ? [] : [args!]
            guard let result = handler.callSync(args: callArgs) else {
                completion(.failure(self.makeError("\(method) handler returned undefined")))
                return
            }
            if let err = ctx.takeException() {
                completion(.failure(err))
                return
            }
            self.unwrapAny(result: result, ctx: ctx, completion: completion)
        }
    }

    // MARK: - Bootstrap

    private func bootstrap(
        bundlePath: String?,
        polyfillPath: String?,
        engine: String,
        argv: [String],
        env: [String: String]
    ) throws {
        let requestedEngine = engine.lowercased()
        if requestedEngine == "bun" || requestedEngine == "auto" || requestedEngine.isEmpty {
            let host = FullBunEngineHost.shared
            if host.isAvailable {
                try host.start(
                    bundlePath: try resolveAgentBundlePath(override: bundlePath),
                    argv: argv,
                    env: env,
                    appSupportDir: SandboxPaths().appSupport.path
                )
                self.fullBunEngine = host
                self.context = nil
                self.bridges = nil
                self.engineMode = "bun"
                self.bridgeVersion = "bun-ios:\(host.abiVersion)"
                self.isRunning = true
                return
            }
            if requestedEngine == "bun" {
                throw makeError("Full Bun engine requested but ElizaBunEngine.framework is not embedded")
            }
        }

        let ctx = JSContext(virtualMachine: virtualMachine)!
        ctx.name = "ElizaBunRuntime"
        ctx.exceptionHandler = { _, exception in
            let msg = exception?.toString() ?? "<unknown exception>"
            let stack = exception?.objectForKeyedSubscript("stack")?.toString() ?? ""
            NSLog("[ElizaBunRuntime] JS exception: \(msg)\n\(stack)")
        }
        self.context = ctx

        // Surface `console.log` into NSLog before any user code runs so polyfill
        // load errors are visible.
        installMinimalConsole(into: ctx)

        // Build the bridges.
        let pluginRef = CAPPluginRef(plugin)
        let kit = BridgeInstaller.install(
            into: ctx,
            paths: SandboxPaths(),
            plugin: pluginRef,
            argv: argv,
            env: env,
            runtime: self
        )
        self.bridges = kit
        self.bridgeVersion = BridgeInstaller.version
        self.engineMode = "compat"

        // Load the polyfill prefix.
        let polyfillSource = try loadPolyfillSource(override: polyfillPath)
        ctx.evaluateScript(polyfillSource)
        if let err = ctx.takeException() {
            throw makeError("Polyfill load failed: \(err)")
        }

        // Load the agent bundle.
        let agentSource = try loadAgentSource(override: bundlePath)
        ctx.evaluateScript(agentSource)
        if let err = ctx.takeException() {
            throw makeError("Agent bundle load failed: \(err)")
        }

        // Invoke `globalThis.startEliza()` if exported.
        if let startEliza = ctx.objectForKeyedSubscript("startEliza"), startEliza.isObject {
            _ = startEliza.call(withArguments: [])
            if let err = ctx.takeException() {
                throw makeError("startEliza threw: \(err)")
            }
        }

        self.isRunning = true
    }

    private func teardown() {
        fullBunEngine?.stop()
        fullBunEngine = nil
        bridges?.httpServer.shutdown()
        bridges?.ui.clear()
        bridges = nil
        context = nil
        isRunning = false
        loadedModelPath = nil
        tokensPerSecond = nil
        engineMode = "compat"
        RuntimeQueue.current = nil
    }

    // MARK: - Source loading

    private func loadAgentSource(override: String?) throws -> String {
        return try String(contentsOfFile: resolveAgentBundlePath(override: override), encoding: .utf8)
    }

    private func resolveAgentBundlePath(override: String?) throws -> String {
        if let override = override, !override.isEmpty {
            return override
        }
        let candidates: [(String, String?, String?)] = [
            ("agent-bundle-ios", "js", nil),
            ("agent-bundle", "js", nil),
            ("agent-bundle-ios", "js", "public/agent"),
            ("agent-bundle", "js", "public/agent"),
        ]
        for (name, ext, subdir) in candidates {
            if let url = Bundle.main.url(
                forResource: name,
                withExtension: ext,
                subdirectory: subdir
            ) {
                return url.path
            }
        }
        throw makeError(
            "agent-bundle.js not found in app bundle resources (searched app root and public/agent)"
        )
    }

    private func loadPolyfillSource(override: String?) throws -> String {
        if let override = override, !override.isEmpty {
            return try String(contentsOfFile: override, encoding: .utf8)
        }
        if let url = Bundle.main.url(forResource: "milady-polyfill-prefix", withExtension: "js") {
            return try String(contentsOf: url, encoding: .utf8)
        }
        // Minimal embedded fallback. Just exposes the bridge version + globals
        // so the agent code can detect the runtime even when the full
        // polyfill bundle isn't shipped yet.
        return """
        if (typeof globalThis.__MILADY_BRIDGE__ !== "object") {
          throw new Error("__MILADY_BRIDGE__ host not installed");
        }
        if (globalThis.__MILADY_BRIDGE_VERSION__ !== "v1") {
          throw new Error("Bridge version mismatch: expected v1, got " + globalThis.__MILADY_BRIDGE_VERSION__);
        }
        """
    }

    private func installMinimalConsole(into ctx: JSContext) {
        let levels: [(String, String)] = [
            ("log", "info"),
            ("info", "info"),
            ("debug", "debug"),
            ("warn", "warn"),
            ("error", "error"),
        ]
        ctx.evaluateScript("globalThis.console = globalThis.console || {};")
        guard let console = ctx.objectForKeyedSubscript("console") else { return }
        for (method, level) in levels {
            let block: @convention(block) () -> Void = {
                let args = JSContext.currentArguments() as? [JSValue] ?? []
                let message = args.map { $0.toString() ?? "" }.joined(separator: " ")
                NSLog("[ElizaBunRuntime console.\(level)] \(message)")
            }
            console.setObject(unsafeBitCast(block, to: AnyObject.self), forKeyedSubscript: method as NSString)
        }
    }

    // MARK: - Promise / response unwrapping

    private func unwrapReply(
        result: JSValue,
        ctx: JSContext,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        // The reply is expected to be `{ reply: string }` or a Promise of it.
        let isThenable = result.objectForKeyedSubscript("then")?.isObject == true
        if isThenable {
            let onResolve: @convention(block) (JSValue) -> Void = { [weak self] resolved in
                guard let self = self else { return }
                if let err = ctx.takeException() {
                    completion(.failure(err))
                    return
                }
                completion(.success(self.extractReply(from: resolved)))
            }
            let onReject: @convention(block) (JSValue) -> Void = { rejected in
                let msg = rejected.toString() ?? "Promise rejected"
                completion(.failure(NSError(
                    domain: "ElizaBunRuntime",
                    code: -1,
                    userInfo: [NSLocalizedDescriptionKey: msg]
                )))
            }
            _ = result.objectForKeyedSubscript("then")?.call(withArguments: [
                JSValue(object: unsafeBitCast(onResolve, to: AnyObject.self), in: ctx) as Any,
                JSValue(object: unsafeBitCast(onReject, to: AnyObject.self), in: ctx) as Any,
            ])
            return
        }
        completion(.success(extractReply(from: result)))
    }

    private func extractReply(from value: JSValue) -> String {
        if value.isString {
            return value.toString() ?? ""
        }
        if let s = value.objectForKeyedSubscript("reply")?.toString(), !s.isEmpty {
            return s
        }
        if let s = value.objectForKeyedSubscript("text")?.toString(), !s.isEmpty {
            return s
        }
        return value.toString() ?? ""
    }

    private func extractReply(from value: Any?) -> String {
        if let s = value as? String { return s }
        if let dict = value as? [String: Any] {
            if let s = dict["reply"] as? String { return s }
            if let s = dict["text"] as? String { return s }
            if let result = dict["result"] { return extractReply(from: result) }
        }
        return String(describing: value ?? "")
    }

    private func unwrapAny(
        result: JSValue,
        ctx: JSContext,
        completion: @escaping (Result<Any?, Error>) -> Void
    ) {
        let isThenable = result.objectForKeyedSubscript("then")?.isObject == true
        if isThenable {
            let onResolve: @convention(block) (JSValue) -> Void = { resolved in
                if let err = ctx.takeException() {
                    completion(.failure(err))
                    return
                }
                completion(.success(resolved.toObject()))
            }
            let onReject: @convention(block) (JSValue) -> Void = { rejected in
                let msg = rejected.toString() ?? "Promise rejected"
                completion(.failure(NSError(
                    domain: "ElizaBunRuntime",
                    code: -1,
                    userInfo: [NSLocalizedDescriptionKey: msg]
                )))
            }
            _ = result.objectForKeyedSubscript("then")?.call(withArguments: [
                JSValue(object: unsafeBitCast(onResolve, to: AnyObject.self), in: ctx) as Any,
                JSValue(object: unsafeBitCast(onReject, to: AnyObject.self), in: ctx) as Any,
            ])
            return
        }
        completion(.success(result.toObject()))
    }

    // MARK: - Errors

    private func makeError(_ message: String) -> Error {
        return NSError(
            domain: "ElizaBunRuntime",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }

    private static func runtimeStaleError() -> Error {
        return NSError(
            domain: "ElizaBunRuntime",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: "Runtime has been deallocated"]
        )
    }
}
