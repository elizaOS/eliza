import Foundation
import Darwin

private let fullBunHostCallCallback: @convention(c) (
    UnsafePointer<CChar>?,
    UnsafePointer<CChar>?,
    Int32
) -> UnsafeMutablePointer<CChar>? = { methodPtr, payloadPtr, timeoutMs in
    let method = methodPtr.map { String(cString: $0) } ?? ""
    let payloadJson = payloadPtr.map { String(cString: $0) } ?? "null"
    let response = FullBunEngineHost.shared.handleHostCall(
        method: method,
        payloadJson: payloadJson,
        timeoutMs: timeoutMs
    )
    return strdup(response)
}

/// Dynamic loader for the real Bun iOS engine framework.
///
/// This deliberately uses `dlopen`/`dlsym` instead of linking the framework at
/// compile time. Compatibility builds can keep using the JSContext bridge, while
/// full-engine builds add `ElizaBunEngine.xcframework` and automatically switch
/// to this host.
final class FullBunEngineHost {
    static let shared = FullBunEngineHost()
    private static let expectedAbiVersion = "3"

    private typealias AbiVersionFn = @convention(c) () -> UnsafePointer<CChar>?
    private typealias LastErrorFn = @convention(c) () -> UnsafePointer<CChar>?
    private typealias HostCallbackFn = @convention(c) (
        UnsafePointer<CChar>?,
        UnsafePointer<CChar>?,
        Int32
    ) -> UnsafeMutablePointer<CChar>?
    private typealias SetHostCallbackFn = @convention(c) (HostCallbackFn?) -> Int32
    private typealias StartFn = @convention(c) (
        UnsafePointer<CChar>,
        UnsafePointer<CChar>,
        UnsafePointer<CChar>,
        UnsafePointer<CChar>
    ) -> Int32
    private typealias StopFn = @convention(c) () -> Int32
    private typealias IsRunningFn = @convention(c) () -> Int32
    private typealias CallFn = @convention(c) (
        UnsafePointer<CChar>,
        UnsafePointer<CChar>
    ) -> UnsafeMutablePointer<CChar>?
    private typealias FreeFn = @convention(c) (UnsafeMutableRawPointer?) -> Void

    private var handle: UnsafeMutableRawPointer?
    private var abiVersionFn: AbiVersionFn?
    private var lastErrorFn: LastErrorFn?
    private var setHostCallbackFn: SetHostCallbackFn?
    private var startFn: StartFn?
    private var stopFn: StopFn?
    private var isRunningFn: IsRunningFn?
    private var callFn: CallFn?
    private var freeFn: FreeFn?
    private var running = false

    private init() {}

    var isAvailable: Bool {
        do {
            try load()
            return true
        } catch {
            return false
        }
    }

    var abiVersion: String {
        guard let abi = abiVersionFn?() else { return "unknown" }
        return String(cString: abi)
    }

    var isRunning: Bool {
        do {
            try load()
            let engineRunning = isRunningFn?() == 1
            if !engineRunning { running = false }
            return engineRunning
        } catch {
            running = false
            return false
        }
    }

    func start(
        bundlePath: String,
        argv: [String],
        env: [String: String],
        appSupportDir: String
    ) throws {
        try load()
        if running {
            if isRunningFn?() == 1 { return }
            running = false
        }
        guard let startFn else {
            throw makeError("ElizaBunEngine missing start symbol")
        }
        let argvJson = try encodeJSON(argv)
        let envJson = try encodeJSON(env)
        let code = bundlePath.withCString { bundlePtr in
            argvJson.withCString { argvPtr in
                envJson.withCString { envPtr in
                    appSupportDir.withCString { supportPtr in
                        startFn(bundlePtr, argvPtr, envPtr, supportPtr)
                    }
                }
            }
        }
        guard code == 0 else {
            let detail = lastError()
            throw makeError(
                "ElizaBunEngine start failed with code \(code)" +
                    (detail.isEmpty ? "" : ": \(detail)")
            )
        }
        running = true
    }

    func stop() {
        _ = stopFn?()
        running = false
    }

    func call(method: String, payload: Any?) throws -> Any? {
        try load()
        guard let callFn else {
            throw makeError("ElizaBunEngine missing call symbol")
        }
        let previousError = lastError()
        let payloadJson = try encodeJSON(payload ?? NSNull())
        let resultPtr = method.withCString { methodPtr in
            payloadJson.withCString { payloadPtr in
                callFn(methodPtr, payloadPtr)
            }
        }
        guard let resultPtr else {
            throw makeError("ElizaBunEngine call returned null for \(method)")
        }
        defer { freeFn?(UnsafeMutableRawPointer(resultPtr)) }
        let resultJson = String(cString: resultPtr)
        guard let data = resultJson.data(using: .utf8) else {
            throw makeError("ElizaBunEngine returned non-UTF8 payload")
        }
        let decoded = try JSONSerialization.jsonObject(with: data)
        if let dict = decoded as? [String: Any],
           let ok = dict["ok"] as? Bool,
           ok == false {
            let message = dict["error"] as? String ?? "unknown full Bun engine error"
            let detail = previousError.isEmpty || previousError == message
                ? ""
                : " (previous engine error: \(previousError))"
            throw makeError("\(message)\(detail)")
        }
        if let dict = decoded as? [String: Any],
           let ok = dict["ok"] as? Bool,
           ok == true {
            return dict["result"] ?? NSNull()
        }
        return decoded
    }

    private func load() throws {
        if handle != nil { return }
        let binaryPath = try locateFrameworkBinary()
        guard let openedHandle = dlopen(binaryPath, RTLD_NOW | RTLD_LOCAL) else {
            throw makeError(String(cString: dlerror()))
        }
        do {
            let loadedAbiVersionFn: AbiVersionFn = try symbol(
                "eliza_bun_engine_abi_version",
                in: openedHandle
            )
            let loadedLastErrorFn: LastErrorFn = try symbol(
                "eliza_bun_engine_last_error",
                in: openedHandle
            )
            let loadedSetHostCallbackFn: SetHostCallbackFn = try symbol(
                "eliza_bun_engine_set_host_callback",
                in: openedHandle
            )
            let loadedStartFn: StartFn = try symbol("eliza_bun_engine_start", in: openedHandle)
            let loadedStopFn: StopFn = try symbol("eliza_bun_engine_stop", in: openedHandle)
            let loadedIsRunningFn: IsRunningFn = try symbol(
                "eliza_bun_engine_is_running",
                in: openedHandle
            )
            let loadedCallFn: CallFn = try symbol("eliza_bun_engine_call", in: openedHandle)
            let loadedFreeFn: FreeFn = try symbol("eliza_bun_engine_free", in: openedHandle)
            guard let abiPointer = loadedAbiVersionFn() else {
                throw makeError("ElizaBunEngine ABI version returned null")
            }
            let loadedAbiVersion = String(cString: abiPointer)
            guard loadedAbiVersion == Self.expectedAbiVersion else {
                throw makeError(
                    "ElizaBunEngine ABI mismatch: expected \(Self.expectedAbiVersion), got \(loadedAbiVersion)"
                )
            }
            let callbackCode = loadedSetHostCallbackFn(fullBunHostCallCallback)
            guard callbackCode == 0 else {
                throw makeError("ElizaBunEngine failed to install host callback: \(callbackCode)")
            }

            self.handle = openedHandle
            self.abiVersionFn = loadedAbiVersionFn
            self.lastErrorFn = loadedLastErrorFn
            self.setHostCallbackFn = loadedSetHostCallbackFn
            self.startFn = loadedStartFn
            self.stopFn = loadedStopFn
            self.isRunningFn = loadedIsRunningFn
            self.callFn = loadedCallFn
            self.freeFn = loadedFreeFn
        } catch {
            _ = dlclose(openedHandle)
            throw error
        }
    }

    private func locateFrameworkBinary() throws -> String {
        let relative = "ElizaBunEngine.framework/ElizaBunEngine"
        let candidates = [
            Bundle.main.privateFrameworksURL?.appendingPathComponent(relative).path,
            Bundle.main.bundleURL.appendingPathComponent("Frameworks").appendingPathComponent(relative).path,
            Bundle.main.url(
                forResource: "ElizaBunEngine",
                withExtension: nil,
                subdirectory: "Frameworks/ElizaBunEngine.framework"
            )?.path,
        ].compactMap { $0 }
        for candidate in candidates where FileManager.default.fileExists(atPath: candidate) {
            return candidate
        }
        throw makeError("ElizaBunEngine.framework is not embedded in the app bundle")
    }

    private func symbol<T>(_ name: String, in handle: UnsafeMutableRawPointer) throws -> T {
        guard let pointer = dlsym(handle, name) else {
            throw makeError("ElizaBunEngine missing symbol \(name)")
        }
        return unsafeBitCast(pointer, to: T.self)
    }

    private func encodeJSON(_ value: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value)
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    private func lastError() -> String {
        guard let pointer = lastErrorFn?() else { return "" }
        return String(cString: pointer)
    }

    private func makeError(_ message: String) -> NSError {
        NSError(
            domain: "ElizaBunEngine",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }

    fileprivate func handleHostCall(
        method: String,
        payloadJson: String,
        timeoutMs: Int32
    ) -> String {
        _ = timeoutMs
        do {
            let payload = try decodeHostPayload(payloadJson)
            switch method {
            case "llama_hardware_info":
                return encodeHostEnvelope(ok: true, result: LlamaBridgeImpl.shared.hardwareInfo().asDict())
            case "llama_load_model":
                return try handleLoadModel(payload)
            case "llama_generate":
                return try handleGenerate(payload)
            case "llama_free":
                return handleFree(payload)
            case "llama_cancel":
                return handleCancel(payload)
            default:
                return encodeHostEnvelope(
                    ok: false,
                    error: "Unknown native host call method: \(method)"
                )
            }
        } catch {
            return encodeHostEnvelope(ok: false, error: error.localizedDescription)
        }
    }

    private func handleLoadModel(_ payload: [String: Any]) throws -> String {
        guard let path = stringValue(payload, "path") ?? stringValue(payload, "modelPath"),
              !path.isEmpty else {
            return encodeHostEnvelope(ok: false, error: "llama_load_model requires path")
        }
        let contextSize = uint32Value(payload, "context_size")
            ?? uint32Value(payload, "contextSize")
            ?? 4096
        let useGPU = boolValue(payload, "use_gpu")
            ?? boolValue(payload, "useGpu")
            ?? true
        let threads = int32Value(payload, "threads")
            ?? int32Value(payload, "maxThreads")
        let result = LlamaBridgeImpl.shared.loadModel(
            path: path,
            contextSize: contextSize,
            useGPU: useGPU,
            threads: threads
        )
        if let error = result.error {
            return encodeHostEnvelope(ok: false, error: error)
        }
        guard let contextId = result.contextId else {
            return encodeHostEnvelope(ok: false, error: "llama_load_model returned no context_id")
        }
        return encodeHostEnvelope(ok: true, result: [
            "context_id": NSNumber(value: contextId),
            "contextId": NSNumber(value: contextId),
            "modelPath": path,
            "contextSize": NSNumber(value: contextSize),
            "useGpu": NSNumber(value: useGPU),
        ])
    }

    private func handleGenerate(_ payload: [String: Any]) throws -> String {
        guard let contextId = int64Value(payload, "context_id")
            ?? int64Value(payload, "contextId") else {
            return encodeHostEnvelope(ok: false, error: "llama_generate requires context_id")
        }
        guard let prompt = stringValue(payload, "prompt"), !prompt.isEmpty else {
            return encodeHostEnvelope(ok: false, error: "llama_generate requires prompt")
        }
        let maxTokens = int32Value(payload, "max_tokens")
            ?? int32Value(payload, "maxTokens")
            ?? 256
        let temperature = floatValue(payload, "temperature") ?? 0.7
        let topP = floatValue(payload, "top_p") ?? floatValue(payload, "topP") ?? 0.95
        let topK = int32Value(payload, "top_k") ?? int32Value(payload, "topK") ?? 40
        let stopSequences = stringArrayValue(payload, "stop")
            ?? stringArrayValue(payload, "stopSequences")
            ?? []

        let generate = {
            LlamaBridgeImpl.shared.generate(
                contextId: contextId,
                prompt: prompt,
                maxTokens: maxTokens,
                temperature: temperature,
                topP: topP,
                topK: topK,
                stopSequences: stopSequences
            )
        }
        let result: LlamaGenerateResult
        if let queue = LlamaBridgeImpl.shared.workQueue(for: contextId) {
            result = queue.sync(execute: generate)
        } else {
            result = generate()
        }
        if let error = result.error {
            return encodeHostEnvelope(ok: false, error: error)
        }
        return encodeHostEnvelope(ok: true, result: [
            "text": result.text,
            "promptTokens": NSNumber(value: result.promptTokens),
            "outputTokens": NSNumber(value: result.outputTokens),
            "durationMs": NSNumber(value: result.durationMs),
        ])
    }

    private func handleFree(_ payload: [String: Any]) -> String {
        guard let contextId = int64Value(payload, "context_id")
            ?? int64Value(payload, "contextId") else {
            return encodeHostEnvelope(ok: true, result: ["freed": false])
        }
        LlamaBridgeImpl.shared.free(contextId: contextId)
        return encodeHostEnvelope(ok: true, result: [
            "freed": true,
            "context_id": NSNumber(value: contextId),
        ])
    }

    private func handleCancel(_ payload: [String: Any]) -> String {
        guard let contextId = int64Value(payload, "context_id")
            ?? int64Value(payload, "contextId") else {
            return encodeHostEnvelope(ok: true, result: ["cancelled": false])
        }
        LlamaBridgeImpl.shared.cancel(contextId: contextId)
        return encodeHostEnvelope(ok: true, result: [
            "cancelled": true,
            "context_id": NSNumber(value: contextId),
        ])
    }

    private func decodeHostPayload(_ json: String) throws -> [String: Any] {
        guard let data = json.data(using: .utf8) else { return [:] }
        let value = try JSONSerialization.jsonObject(with: data)
        return value as? [String: Any] ?? [:]
    }

    private func encodeHostEnvelope(
        ok: Bool,
        result: Any? = nil,
        error: String? = nil
    ) -> String {
        var object: [String: Any] = ["ok": ok]
        if let result {
            object["result"] = result
        } else if ok {
            object["result"] = NSNull()
        }
        if let error {
            object["error"] = error
        }
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              let json = String(data: data, encoding: .utf8) else {
            let fallback = (error ?? "Failed to encode native host response")
                .replacingOccurrences(of: "\"", with: "\\\"")
            return "{\"ok\":false,\"error\":\"\(fallback)\"}"
        }
        return json
    }

    private func stringValue(_ payload: [String: Any], _ key: String) -> String? {
        payload[key] as? String
    }

    private func boolValue(_ payload: [String: Any], _ key: String) -> Bool? {
        if let value = payload[key] as? Bool { return value }
        if let value = payload[key] as? NSNumber { return value.boolValue }
        if let value = payload[key] as? String {
            if value == "true" || value == "1" { return true }
            if value == "false" || value == "0" { return false }
        }
        return nil
    }

    private func int32Value(_ payload: [String: Any], _ key: String) -> Int32? {
        if let value = payload[key] as? NSNumber { return value.int32Value }
        if let value = payload[key] as? String, let parsed = Int32(value) { return parsed }
        return nil
    }

    private func int64Value(_ payload: [String: Any], _ key: String) -> Int64? {
        if let value = payload[key] as? NSNumber { return value.int64Value }
        if let value = payload[key] as? String, let parsed = Int64(value) { return parsed }
        return nil
    }

    private func uint32Value(_ payload: [String: Any], _ key: String) -> UInt32? {
        if let value = payload[key] as? NSNumber { return value.uint32Value }
        if let value = payload[key] as? String, let parsed = UInt32(value) { return parsed }
        return nil
    }

    private func floatValue(_ payload: [String: Any], _ key: String) -> Float? {
        if let value = payload[key] as? NSNumber { return value.floatValue }
        if let value = payload[key] as? String, let parsed = Float(value) { return parsed }
        return nil
    }

    private func stringArrayValue(_ payload: [String: Any], _ key: String) -> [String]? {
        if let values = payload[key] as? [String] { return values }
        if let values = payload[key] as? [Any] {
            return values.compactMap { $0 as? String }
        }
        return nil
    }
}
