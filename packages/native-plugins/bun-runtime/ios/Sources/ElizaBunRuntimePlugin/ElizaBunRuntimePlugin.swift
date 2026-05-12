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
    private var runtime: ElizaBunRuntime?
    private var nativeSmokeStarted = false

    override public func load() {
        // Construct lazily on first start to avoid holding the JSVirtualMachine
        // when the app launches without the runtime.
        runtime = nil
        runNativeFullBunSmokeIfRequested()
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

    // MARK: - Simulator full Bun smoke

    private func runNativeFullBunSmokeIfRequested() {
        guard !nativeSmokeStarted else { return }
        guard UserDefaults.standard.string(forKey: Self.fullBunSmokeRequestKey) == "1" else { return }
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
            env: [
                "ELIZA_PLATFORM": "ios",
                "ELIZA_MOBILE_PLATFORM": "ios",
                "ELIZA_IOS_LOCAL_BACKEND": "1",
                "ELIZA_IOS_FULL_BUN_SMOKE": "1",
                "ELIZA_HEADLESS": "1",
                "ELIZA_API_BIND": "127.0.0.1",
                "LOG_LEVEL": "error",
            ]
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

    private func runNativeFullBunRouteSmoke(runtime: ElizaBunRuntime) {
        dispatchSmokeCall(runtime: runtime, method: "status", args: ["timeoutMs": 60_000]) { [weak self, weak runtime] statusResult in
            guard let self = self, let runtime = runtime else { return }
            switch statusResult {
            case .failure(let error):
                self.writeFullBunSmokeFailure(error)
            case .success(let bridgeStatus):
                let healthArgs: [String: Any] = [
                    "method": "GET",
                    "path": "/api/health",
                    "headers": ["accept": "application/json"],
                    "timeoutMs": 120_000,
                ]
                self.dispatchSmokeCall(runtime: runtime, method: "http_request", args: healthArgs) { [weak self, weak runtime] healthResult in
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
        }
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
            "timeoutMs": 180_000,
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
