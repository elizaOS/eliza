import Foundation
import Darwin

/// Dynamic loader for the real Bun iOS engine framework.
///
/// This deliberately uses `dlopen`/`dlsym` instead of linking the framework at
/// compile time. Compatibility builds can keep using the JSContext bridge, while
/// full-engine builds add `ElizaBunEngine.xcframework` and automatically switch
/// to this host.
final class FullBunEngineHost {
    static let shared = FullBunEngineHost()

    private typealias AbiVersionFn = @convention(c) () -> UnsafePointer<CChar>?
    private typealias StartFn = @convention(c) (
        UnsafePointer<CChar>,
        UnsafePointer<CChar>,
        UnsafePointer<CChar>,
        UnsafePointer<CChar>
    ) -> Int32
    private typealias StopFn = @convention(c) () -> Int32
    private typealias CallFn = @convention(c) (
        UnsafePointer<CChar>,
        UnsafePointer<CChar>
    ) -> UnsafeMutablePointer<CChar>?
    private typealias FreeFn = @convention(c) (UnsafeMutableRawPointer?) -> Void

    private var handle: UnsafeMutableRawPointer?
    private var abiVersionFn: AbiVersionFn?
    private var startFn: StartFn?
    private var stopFn: StopFn?
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

    func start(
        bundlePath: String,
        argv: [String],
        env: [String: String],
        appSupportDir: String
    ) throws {
        try load()
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
            throw makeError("ElizaBunEngine start failed with code \(code)")
        }
        running = true
    }

    func stop() {
        guard running else { return }
        _ = stopFn?()
        running = false
    }

    func call(method: String, payload: Any?) throws -> Any? {
        try load()
        guard let callFn else {
            throw makeError("ElizaBunEngine missing call symbol")
        }
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
            throw makeError(message)
        }
        return decoded
    }

    private func load() throws {
        if handle != nil { return }
        let binaryPath = try locateFrameworkBinary()
        guard let handle = dlopen(binaryPath, RTLD_NOW | RTLD_LOCAL) else {
            throw makeError(String(cString: dlerror()))
        }
        self.handle = handle
        self.abiVersionFn = try symbol("eliza_bun_engine_abi_version")
        self.startFn = try symbol("eliza_bun_engine_start")
        self.stopFn = try symbol("eliza_bun_engine_stop")
        self.callFn = try symbol("eliza_bun_engine_call")
        self.freeFn = try symbol("eliza_bun_engine_free")
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

    private func symbol<T>(_ name: String) throws -> T {
        guard let handle else {
            throw makeError("ElizaBunEngine is not loaded")
        }
        guard let pointer = dlsym(handle, name) else {
            throw makeError("ElizaBunEngine missing symbol \(name)")
        }
        return unsafeBitCast(pointer, to: T.self)
    }

    private func encodeJSON(_ value: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value)
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    private func makeError(_ message: String) -> NSError {
        NSError(
            domain: "ElizaBunEngine",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }
}
