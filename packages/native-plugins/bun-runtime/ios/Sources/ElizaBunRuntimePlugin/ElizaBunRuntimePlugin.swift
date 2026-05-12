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

    // Native-only smoke is intentionally separate from the WebView smoke key.
    // The WebView smoke exercises the production Capacitor call path; using the
    // same key here races two full Bun runtimes and PGlite rejects the duplicate
    // database owner.
    private static let fullBunSmokeRequestKey = "CapacitorStorage.eliza:ios-full-bun-native-smoke:request"
    private static let fullBunSmokeResultKey = "CapacitorStorage.eliza:ios-full-bun-native-smoke:result"
    private static let webFullBunSmokeRequestKey = "CapacitorStorage.eliza:ios-full-bun-smoke:request"
    private static let webFullBunSmokeResultKey = "CapacitorStorage.eliza:ios-full-bun-smoke:result"
    private static let webFullBunPrewarmResultKey = "CapacitorStorage.eliza:ios-full-bun-prewarm:result"
    private static let mobileRuntimeModeKey = "CapacitorStorage.eliza:mobile-runtime-mode"
    private var runtime: ElizaBunRuntime?
    private var nativeSmokeStarted = false
    private var fullBunPrewarmStarted = false

    override public func load() {
        // Construct lazily on first start to avoid holding the JSVirtualMachine
        // when the app launches without the runtime.
        runtime = nil
        runNativeFullBunSmokeIfRequested()
        prewarmFullBunRuntimeIfRequested()
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
                self.runNativeFullBunSmokeAfterSuccessfulStartIfRequested(runtime: runtime)
                DispatchQueue.main.async {
                    call.resolve([
                        "ok": true,
                        "bridgeVersion": outcome.bridgeVersion,
                    ])
                }
            case .failure(let error):
                DispatchQueue.main.async {
                    call.resolve([
                        "ok": false,
                        "error": "\(error)",
                    ])
                }
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
            DispatchQueue.main.async {
                switch result {
                case .success(let reply):
                    call.resolve(["reply": reply])
                case .failure(let error):
                    call.reject("\(error)")
                }
            }
        }
    }

    // MARK: - getStatus

    @objc func getStatus(_ call: CAPPluginCall) {
        guard let runtime = runtime else {
            call.resolve(["ready": false])
            return
        }
        runtime.currentStatus { status in
            DispatchQueue.main.async {
                var payload: JSObject = [
                    "ready": status.ready,
                    "engine": status.engine,
                ]
                if let v = status.bridgeVersion { payload["bridgeVersion"] = v }
                if let m = status.model { payload["model"] = m }
                if let tps = status.tokensPerSecond { payload["tokensPerSecond"] = tps }
                call.resolve(payload)
            }
        }
    }

    // MARK: - stop

    @objc func stop(_ call: CAPPluginCall) {
        guard let runtime = runtime else {
            call.resolve()
            return
        }
        runtime.stop {
            DispatchQueue.main.async {
                call.resolve()
            }
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
            DispatchQueue.main.async {
                switch result {
                case .success(let value):
                    pluginCall.resolve(["result": Self.jsonSafe(value)])
                case .failure(let error):
                    pluginCall.reject("\(error)")
                }
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

    // MARK: - Simulator full Bun smoke

    private func fullBunLaunchEnvironment(isSmoke: Bool) -> [String: String] {
        var env: [String: String] = [
            "ELIZA_PLATFORM": "ios",
            "ELIZA_MOBILE_PLATFORM": "ios",
            "ELIZA_IOS_LOCAL_BACKEND": "1",
            "ELIZA_IOS_BUN_STARTUP_TIMEOUT_MS": "300000",
            "ELIZA_PGLITE_DISABLE_EXTENSIONS": "0",
            "ELIZA_VAULT_BACKEND": "file",
            "ELIZA_DISABLE_VAULT_PROFILE_RESOLVER": "1",
            "ELIZA_DISABLE_AGENT_WALLET_BOOTSTRAP": "1",
            "ELIZA_HEADLESS": "1",
            "ELIZA_API_BIND": "127.0.0.1",
            "LOG_LEVEL": "error",
        ]
        if isSmoke {
            env["ELIZA_IOS_FULL_BUN_SMOKE"] = "1"
        }
        return env
    }

    private func prewarmFullBunRuntimeIfRequested() {
        guard !nativeSmokeStarted, !fullBunPrewarmStarted else { return }

        let defaults = UserDefaults.standard
        let webSmokeRequested = defaults.string(forKey: Self.webFullBunSmokeRequestKey) == "1"
        let localRuntimeRequested = defaults.string(forKey: Self.mobileRuntimeModeKey) == "local"
        guard webSmokeRequested || localRuntimeRequested else { return }

        fullBunPrewarmStarted = true
        let runtime = ensureRuntime()
        if webSmokeRequested {
            writeWebFullBunSmokeProgress([
                "phase": "native-prewarm-starting",
                "nativePrewarm": true,
            ])
        }
        runtime.start(
            bundlePath: nil,
            polyfillPath: nil,
            engine: "bun",
            argv: ["bun", "--no-install", "public/agent/agent-bundle.js", "ios-bridge", "--stdio"],
            env: fullBunLaunchEnvironment(isSmoke: webSmokeRequested)
        ) { [weak self] result in
            guard let self = self else { return }
            switch result {
            case .success:
                if webSmokeRequested {
                    self.writeWebFullBunSmokeProgress([
                        "phase": "native-prewarm-started",
                        "nativePrewarm": true,
                    ])
                    self.pollWebFullBunPrewarmReady(runtime: runtime, startedAt: Date(), attempt: 0)
                }
            case .failure(let error):
                self.fullBunPrewarmStarted = false
                if webSmokeRequested {
                    self.writeWebFullBunSmokeProgress([
                        "ok": false,
                        "phase": "failed",
                        "nativePrewarm": true,
                        "error": "\(error)",
                    ])
                } else {
                    NSLog("[ElizaBunRuntime] iOS full Bun prewarm failed: \(error)")
                }
            }
        }
    }

    private func runNativeFullBunSmokeIfRequested() {
        guard shouldRunNativeFullBunSmoke() else { return }
        nativeSmokeStarted = true

        let runtime = ensureRuntime()
        writeFullBunSmokeResult([
            "phase": "native-starting",
            "nativeOnly": true,
        ])
        runtime.start(
            bundlePath: nil,
            polyfillPath: nil,
            engine: "bun",
            argv: ["bun", "--no-install", "public/agent/agent-bundle.js", "ios-bridge", "--stdio"],
            env: fullBunLaunchEnvironment(isSmoke: true)
        ) { [weak self, weak runtime] result in
            guard let self = self, let runtime = runtime else { return }
            switch result {
            case .success:
                self.runNativeFullBunRouteSmoke(runtime: runtime)
            case .failure(let error):
                self.writeFullBunSmokeFailure(error)
            }
        }
    }

    private func pollWebFullBunPrewarmReady(
        runtime: ElizaBunRuntime,
        startedAt: Date,
        attempt: Int
    ) {
        dispatchSmokeCall(runtime: runtime, method: "status", args: ["timeoutMs": 5_000]) { [weak self, weak runtime] statusResult in
            guard let self = self, let runtime = runtime else { return }
            let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            switch statusResult {
            case .failure(let error):
                if elapsedMs >= 300_000 {
                    self.writeWebFullBunSmokeProgress([
                        "ok": false,
                        "phase": "failed",
                        "nativePrewarm": true,
                        "error": error.localizedDescription,
                        "finishedAt": self.isoTimestamp(),
                    ])
                    return
                }
                self.writeWebFullBunSmokeProgress([
                    "phase": "native-prewarm-waiting-backend",
                    "nativePrewarm": true,
                    "elapsedMs": elapsedMs,
                    "attempt": attempt,
                    "lastStatusError": error.localizedDescription,
                ])
                self.scheduleWebFullBunPrewarmReadyPoll(runtime: runtime, startedAt: startedAt, attempt: attempt + 1)
            case .success(let bridgeStatus):
                if self.isBridgeStatusReady(bridgeStatus) {
                    self.writeWebFullBunSmokeProgress([
                        "phase": "native-prewarm-ready",
                        "nativePrewarm": true,
                        "elapsedMs": elapsedMs,
                        "attempt": attempt,
                        "engine": runtime.engineMode,
                        "bridgeVersion": runtime.bridgeVersion ?? NSNull(),
                        "bridgeStatus": Self.jsonSafe(bridgeStatus),
                    ])
                    return
                }
                if self.isBridgeStatusError(bridgeStatus) {
                    self.writeWebFullBunSmokeProgress([
                        "ok": false,
                        "phase": "failed",
                        "nativePrewarm": true,
                        "error": "iOS full Bun backend failed to boot: \(bridgeStatus ?? NSNull())",
                        "finishedAt": self.isoTimestamp(),
                    ])
                    return
                }
                if elapsedMs >= 300_000 {
                    self.writeWebFullBunSmokeProgress([
                        "ok": false,
                        "phase": "failed",
                        "nativePrewarm": true,
                        "error": "iOS full Bun backend did not become ready within 300000ms; last status: \(bridgeStatus ?? NSNull())",
                        "finishedAt": self.isoTimestamp(),
                    ])
                    return
                }
                self.writeWebFullBunSmokeProgress([
                    "phase": "native-prewarm-waiting-backend",
                    "nativePrewarm": true,
                    "elapsedMs": elapsedMs,
                    "attempt": attempt,
                    "bridgeStatus": Self.jsonSafe(bridgeStatus),
                ])
                self.scheduleWebFullBunPrewarmReadyPoll(runtime: runtime, startedAt: startedAt, attempt: attempt + 1)
            }
        }
    }

    private func scheduleWebFullBunPrewarmReadyPoll(
        runtime: ElizaBunRuntime,
        startedAt: Date,
        attempt: Int
    ) {
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 2.0) { [weak self, weak runtime] in
            guard let self = self, let runtime = runtime else { return }
            self.pollWebFullBunPrewarmReady(runtime: runtime, startedAt: startedAt, attempt: attempt)
        }
    }

    private func runNativeFullBunSmokeAfterSuccessfulStartIfRequested(runtime: ElizaBunRuntime) {
        guard shouldRunNativeFullBunSmoke() else { return }
        nativeSmokeStarted = true
        writeFullBunSmokeProgress([
            "phase": "native-route-smoke-starting",
            "nativeOnly": true,
        ])
        runNativeFullBunRouteSmoke(runtime: runtime)
    }

    private func shouldRunNativeFullBunSmoke() -> Bool {
        guard !nativeSmokeStarted else { return false }
        return UserDefaults.standard.string(forKey: Self.fullBunSmokeRequestKey) == "1"
    }

    private func runNativeFullBunRouteSmoke(runtime: ElizaBunRuntime) {
        pollNativeFullBunBridgeReady(runtime: runtime, startedAt: Date(), attempt: 0)
    }

    private func pollNativeFullBunBridgeReady(
        runtime: ElizaBunRuntime,
        startedAt: Date,
        attempt: Int
    ) {
        dispatchSmokeCall(runtime: runtime, method: "status", args: ["timeoutMs": 5_000]) { [weak self, weak runtime] statusResult in
            guard let self = self, let runtime = runtime else { return }
            let elapsedMs = Int(Date().timeIntervalSince(startedAt) * 1000)
            switch statusResult {
            case .failure(let error):
                if elapsedMs >= 300_000 {
                    self.writeFullBunSmokeFailure(error)
                    return
                }
                self.writeFullBunSmokeProgress([
                    "phase": "native-waiting-backend",
                    "nativeOnly": true,
                    "elapsedMs": elapsedMs,
                    "attempt": attempt,
                    "lastStatusError": error.localizedDescription,
                ])
                self.scheduleNativeBridgeReadyPoll(runtime: runtime, startedAt: startedAt, attempt: attempt + 1)
            case .success(let bridgeStatus):
                if self.isBridgeStatusReady(bridgeStatus) {
                    self.runNativeFullBunHealthSmoke(runtime: runtime, bridgeStatus: bridgeStatus)
                    return
                }
                if self.isBridgeStatusError(bridgeStatus) {
                    self.writeFullBunSmokeFailure(
                        self.makeSmokeError("native full Bun backend failed to boot: \(bridgeStatus ?? NSNull())")
                    )
                    return
                }
                if elapsedMs >= 300_000 {
                    self.writeFullBunSmokeFailure(
                        self.makeSmokeError("native full Bun backend did not become ready within 300000ms; last status: \(bridgeStatus ?? NSNull())")
                    )
                    return
                }
                self.writeFullBunSmokeProgress([
                    "phase": "native-waiting-backend",
                    "nativeOnly": true,
                    "elapsedMs": elapsedMs,
                    "attempt": attempt,
                    "bridgeStatus": Self.jsonSafe(bridgeStatus),
                ])
                self.scheduleNativeBridgeReadyPoll(runtime: runtime, startedAt: startedAt, attempt: attempt + 1)
            }
        }
    }

    private func scheduleNativeBridgeReadyPoll(
        runtime: ElizaBunRuntime,
        startedAt: Date,
        attempt: Int
    ) {
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 2.0) { [weak self, weak runtime] in
            guard let self = self, let runtime = runtime else { return }
            self.pollNativeFullBunBridgeReady(runtime: runtime, startedAt: startedAt, attempt: attempt)
        }
    }

    private func runNativeFullBunHealthSmoke(runtime: ElizaBunRuntime, bridgeStatus: Any?) {
        let healthArgs: [String: Any] = [
            "method": "GET",
            "path": "/api/health",
            "headers": ["accept": "application/json"],
            "timeoutMs": 120_000,
        ]
        dispatchSmokeCall(runtime: runtime, method: "http_request", args: healthArgs) { [weak self, weak runtime] healthResult in
            guard let self = self, let runtime = runtime else { return }
            switch healthResult {
            case .failure(let error):
                self.writeFullBunSmokeFailure(error)
            case .success(let healthResponse):
                do {
                    let healthJson = try self.parseSmokeHttpJSON(
                        label: "native full Bun /api/health",
                        value: healthResponse
                    )
                    guard healthJson["ready"] as? Bool == true,
                          healthJson["runtime"] as? String == "ok" else {
                        throw self.makeSmokeError(
                            "native full Bun /api/health returned unexpected body: \(healthJson)"
                        )
                    }
                    self.createNativeSmokeConversation(
                        runtime: runtime,
                        bridgeStatus: bridgeStatus,
                        health: healthJson
                    )
                } catch {
                    self.writeFullBunSmokeFailure(error)
                }
            }
        }
    }

    private func isBridgeStatusReady(_ value: Any?) -> Bool {
        guard let dict = value as? [String: Any] else { return false }
        if let ready = dict["ready"] as? Bool { return ready }
        if let ready = dict["ready"] as? NSNumber { return ready.boolValue }
        return false
    }

    private func isBridgeStatusError(_ value: Any?) -> Bool {
        guard let dict = value as? [String: Any] else { return false }
        return dict["phase"] as? String == "error"
    }

    private func createNativeSmokeConversation(
        runtime: ElizaBunRuntime,
        bridgeStatus: Any?,
        health: [String: Any]
    ) {
        let createArgs: [String: Any] = [
            "method": "POST",
            "path": "/api/conversations",
            "headers": [
                "accept": "application/json",
                "content-type": "application/json",
            ],
            "body": "{\"title\":\"iOS Full Bun Native Smoke\"}",
            "timeoutMs": 120_000,
        ]
        dispatchSmokeCall(runtime: runtime, method: "http_request", args: createArgs) { [weak self, weak runtime] createResult in
            guard let self = self, let runtime = runtime else { return }
            switch createResult {
            case .failure(let error):
                self.writeFullBunSmokeFailure(error)
            case .success(let createResponse):
                do {
                    let createJson = try self.parseSmokeHttpJSON(
                        label: "native full Bun POST /api/conversations",
                        value: createResponse
                    )
                    guard let conversation = createJson["conversation"] as? [String: Any],
                          let conversationId = conversation["id"] as? String,
                          !conversationId.isEmpty else {
                        throw self.makeSmokeError("native full Bun conversation create did not return an id")
                    }
                    self.sendNativeSmokeMessage(
                        runtime: runtime,
                        bridgeStatus: bridgeStatus,
                        health: health,
                        conversationId: conversationId
                    )
                } catch {
                    self.writeFullBunSmokeFailure(error)
                }
            }
        }
    }

    private func sendNativeSmokeMessage(
        runtime: ElizaBunRuntime,
        bridgeStatus: Any?,
        health: [String: Any],
        conversationId: String
    ) {
        let messageArgs: [String: Any] = [
            "message": "iOS full Bun native smoke",
            "conversationId": conversationId,
            "metadata": ["smoke": "ios-full-bun-native"],
            "timeoutMs": 600_000,
        ]
        dispatchSmokeCall(runtime: runtime, method: "send_message", args: messageArgs) { [weak self] messageResult in
            guard let self = self else { return }
            switch messageResult {
            case .failure(let error):
                self.writeFullBunSmokeFailure(error)
            case .success(let sendMessage):
                self.writeFullBunSmokeProgress([
                    "ok": true,
                    "phase": "native-complete",
                    "nativeOnly": true,
                    "finishedAt": self.isoTimestamp(),
                    "engine": runtime.engineMode,
                    "bridgeVersion": runtime.bridgeVersion ?? NSNull(),
                    "bridgeStatus": Self.jsonSafe(bridgeStatus),
                    "health": Self.jsonSafe(health),
                    "conversationId": conversationId,
                    "sendMessage": Self.jsonSafe(sendMessage),
                ])
            }
        }
    }

    private func dispatchSmokeCall(
        runtime: ElizaBunRuntime,
        method: String,
        args: Any?,
        completion: @escaping (Result<Any?, Error>) -> Void
    ) {
        runtime.dispatchHandler(method: method, args: args) { result in
            completion(result)
        }
    }

    private func parseSmokeHttpJSON(label: String, value: Any?) throws -> [String: Any] {
        guard let response = value as? [String: Any] else {
            throw makeSmokeError("\(label) did not return an object")
        }
        let status = (response["status"] as? NSNumber)?.intValue ?? response["status"] as? Int
        guard let status = status, status >= 200, status < 300 else {
            throw makeSmokeError("\(label) returned HTTP \(String(describing: response["status"]))")
        }
        guard let body = response["body"] as? String,
              let data = body.data(using: .utf8),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw makeSmokeError("\(label) returned invalid JSON body")
        }
        return json
    }

    private func writeFullBunSmokeFailure(_ error: Error) {
        writeFullBunSmokeResult([
            "ok": false,
            "phase": "failed",
            "nativeOnly": true,
            "error": error.localizedDescription,
            "finishedAt": isoTimestamp(),
        ])
        UserDefaults.standard.removeObject(forKey: Self.fullBunSmokeRequestKey)
        UserDefaults.standard.synchronize()
    }

    private func writeFullBunSmokeProgress(_ result: [String: Any]) {
        if let existing = UserDefaults.standard.string(forKey: Self.fullBunSmokeResultKey),
           let data = existing.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           json["ok"] as? Bool == true {
            return
        }
        writeFullBunSmokeResult(result)
        if result["ok"] as? Bool == true {
            UserDefaults.standard.removeObject(forKey: Self.fullBunSmokeRequestKey)
            UserDefaults.standard.synchronize()
        }
    }

    private func writeFullBunSmokeResult(_ result: [String: Any]) {
        var payload = result
        payload["updatedAt"] = isoTimestamp()
        let safePayload = Self.jsonSafe(payload)
        guard JSONSerialization.isValidJSONObject(safePayload),
              let data = try? JSONSerialization.data(withJSONObject: safePayload),
              let json = String(data: data, encoding: .utf8) else {
            return
        }
        UserDefaults.standard.set(json, forKey: Self.fullBunSmokeResultKey)
        UserDefaults.standard.synchronize()
    }

    private func writeWebFullBunSmokeProgress(_ result: [String: Any]) {
        var payload = result
        payload["updatedAt"] = isoTimestamp()
        let safePayload = Self.jsonSafe(payload)
        guard JSONSerialization.isValidJSONObject(safePayload),
              let data = try? JSONSerialization.data(withJSONObject: safePayload),
              let json = String(data: data, encoding: .utf8) else {
            return
        }
        UserDefaults.standard.set(json, forKey: Self.webFullBunPrewarmResultKey)
        UserDefaults.standard.synchronize()
    }

    private func makeSmokeError(_ message: String) -> NSError {
        NSError(
            domain: "ElizaBunRuntimeSmoke",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }

    private func isoTimestamp() -> String {
        ISO8601DateFormatter().string(from: Date())
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
