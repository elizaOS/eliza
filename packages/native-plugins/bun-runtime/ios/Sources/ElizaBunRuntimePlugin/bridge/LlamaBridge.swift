import Foundation
import JavaScriptCore

#if canImport(LlamaCppCapacitor)
import LlamaCppCapacitor
#endif

/// Implements `llama_*` from `BRIDGE_CONTRACT.md`.
///
/// ## Real backend integration
///
/// The real backend lives in `LlamaBridgeImpl.swift` — it links directly
/// against the `LlamaCpp.xcframework` built by
/// `native/ios-bun-port/vendor-deps/llama.cpp/build-ios.sh` via
/// `@_silgen_name` C-API bindings. Wire it in by replacing the
/// `cannedReply` / `splitToTokens` calls below with:
///
///     let impl = LlamaBridgeImpl.shared
///     // loadModel:
///     let r = impl.loadModel(path: path, contextSize: UInt32(contextSize),
///                            useGPU: useGpu, threads: Int32(threads))
///     // → r.contextId / r.error
///
///     // generate:
///     let r = impl.generate(
///       contextId: Int64(state.id),
///       prompt: prompt,
///       maxTokens: Int32(maxTokens),
///       temperature: Float(temperature),
///       topP: Float(topP),
///       stopSequences: stop,
///       onToken: { tok, last in
///         RuntimeQueue.dispatchOnJS { streamCallback?.callSync(args: [tok, last]) }
///       })
///
///     // hardwareInfo:
///     return impl.hardwareInfo().asDict()
///
/// `LlamaBridgeImpl` is JSContext-agnostic by design — this file owns the
/// JS marshalling (JSValue parsing, ManagedCallback wiring, promise build)
/// and `LlamaBridgeImpl` owns the C-API. Tracked in M09 of the iOS Bun port
/// roadmap.
///
/// Until M09 cuts the stub over, the bridge returns realistic-shaped canned
/// responses so the end-to-end JS → bridge → response path can be exercised.
/// Each method documents where the real call would land.
public final class LlamaBridge {
    private weak var context: JSContext?
    private var nextContextId: Int = 1
    private var contexts: [Int: LlamaContextState] = [:]
    private var streamCallbacks: [String: ManagedCallback] = [:]
    private let inferenceQueue = DispatchQueue(label: "ai.eliza.bun.runtime.llama", qos: .userInitiated)

    public init() {}

    public func install(into ctx: JSContext) {
        self.context = ctx

        ctx.installBridgeFunction(name: "llama_load_model") { args in
            guard let ctx = self.context else { return NSNull() }
            return self.loadModel(args: args, ctx: ctx)
        }

        ctx.installBridgeFunction(name: "llama_generate") { args in
            guard let ctx = self.context else { return NSNull() }
            return self.generate(args: args, ctx: ctx)
        }

        ctx.installBridgeFunction(name: "llama_register_stream_callback") { args in
            guard args.count >= 2,
                  let token = args[0].toString() else { return NSNull() }
            let handlerValue = args[1]
            if let mc = ManagedCallback(value: handlerValue) {
                self.streamCallbacks[token] = mc
            }
            return NSNull()
        }

        ctx.installBridgeFunction(name: "llama_cancel") { args in
            guard let id = args.first?.toNumber()?.intValue else { return NSNull() }
            if var state = self.contexts[id] {
                state.cancelled = true
                self.contexts[id] = state
            }
            return NSNull()
        }

        ctx.installBridgeFunction(name: "llama_free") { args in
            guard let id = args.first?.toNumber()?.intValue else { return NSNull() }
            self.contexts.removeValue(forKey: id)
            return NSNull()
        }

        ctx.installBridgeFunction(name: "llama_hardware_info") { _ in
            return self.hardwareInfo()
        }
    }

    // MARK: - Context state

    private struct LlamaContextState {
        let id: Int
        let modelPath: String
        var contextSize: Int
        var useGpu: Bool
        var threads: Int
        var cancelled: Bool
    }

    // MARK: - Implementations

    private func loadModel(args: [JSValue], ctx: JSContext) -> Any? {
        guard let opts = args.first, opts.isObject else {
            return Self.rejectedAsync(in: ctx, error: "llama_load_model: missing options")
        }
        let path = opts.objectForKeyedSubscript("path")?.toString() ?? ""
        if path.isEmpty {
            return Self.rejectedAsync(in: ctx, error: "llama_load_model: missing path")
        }
        let contextSize = opts.objectForKeyedSubscript("context_size")?.toNumber()?.intValue ?? 4096
        let useGpu = opts.objectForKeyedSubscript("use_gpu")?.toBool() ?? true
        let threads = opts.objectForKeyedSubscript("threads")?.toNumber()?.intValue
            ?? min(4, ProcessInfo.processInfo.activeProcessorCount)

        // Build the promise + resolver pair on the JS side.
        let (promise, resolver) = Self.makeAsyncPromise(in: ctx)
        let managedResolve = resolver.flatMap { ManagedCallback(value: $0) }

        inferenceQueue.async { [weak self] in
            guard let self = self else { return }

            // --- Real backend integration point ----------------------------------
            // When LlamaCppCapacitor's Swift API stabilizes, do something like:
            //
            //   let bridge = LlamaCppPlugin.shared
            //   bridge.initContext(
            //     contextId: self.nextContextId,
            //     params: NativeContextParams(model: path, n_ctx: contextSize, ...))
            //
            // The result of `initContext` becomes the contextId returned here.
            // --------------------------------------------------------------------

            if !FileManager.default.fileExists(atPath: path) {
                RuntimeQueue.dispatchOnJS {
                    managedResolve?.callSync(args: [["error": "model file not found: \(path)"]])
                }
                return
            }

            let id = self.nextContextId
            self.nextContextId += 1
            let state = LlamaContextState(
                id: id,
                modelPath: path,
                contextSize: contextSize,
                useGpu: useGpu,
                threads: threads,
                cancelled: false
            )
            self.contexts[id] = state

            RuntimeQueue.dispatchOnJS {
                managedResolve?.callSync(args: [["context_id": id]])
            }
        }

        return promise
    }

    private func generate(args: [JSValue], ctx: JSContext) -> Any? {
        guard let opts = args.first, opts.isObject else {
            return Self.rejectedAsync(in: ctx, error: "llama_generate: missing options")
        }
        let contextId = opts.objectForKeyedSubscript("context_id")?.toNumber()?.intValue ?? -1
        let prompt = opts.objectForKeyedSubscript("prompt")?.toString() ?? ""
        let maxTokens = opts.objectForKeyedSubscript("max_tokens")?.toNumber()?.intValue ?? 256
        _ = opts.objectForKeyedSubscript("temperature")?.toNumber()?.doubleValue ?? 0.7
        _ = opts.objectForKeyedSubscript("top_p")?.toNumber()?.doubleValue ?? 0.95
        _ = opts.objectForKeyedSubscript("stop")?.toStringArray() ?? []
        let streamToken = opts.objectForKeyedSubscript("stream_callback_token")?.toString()

        guard let state = contexts[contextId] else {
            return Self.rejectedAsync(in: ctx, error: "llama_generate: unknown context_id \(contextId)")
        }

        let (promise, resolver) = Self.makeAsyncPromise(in: ctx)
        let managedResolve = resolver.flatMap { ManagedCallback(value: $0) }
        let streamCallback = streamToken.flatMap { self.streamCallbacks[$0] }

        inferenceQueue.async { [weak self] in
            guard let self = self else { return }

            // --- Real backend integration point ----------------------------------
            // When the LlamaCppCapacitor Swift API is wired, replace this with:
            //
            //   bridge.completion(contextId: state.id, params: NativeCompletionParams(
            //     prompt: prompt, n_predict: maxTokens, temperature: temperature,
            //     top_p: topP, stop: stop, ...))
            //
            // Stream callbacks land via the plugin's `addListener("token", ...)`
            // event; bridge each emitted token into `streamCallback.call(...)`.
            // --------------------------------------------------------------------

            let started = Date()
            let cannedReply = Self.cannedReply(for: prompt, modelPath: state.modelPath)

            // Stream tokens one at a time when a callback is registered.
            if let cb = streamCallback {
                let tokens = Self.splitToTokens(cannedReply, max: maxTokens)
                for (idx, tok) in tokens.enumerated() {
                    // Check cancellation.
                    if let live = self.contexts[contextId], live.cancelled {
                        break
                    }
                    let isLast = (idx == tokens.count - 1)
                    RuntimeQueue.dispatchOnJS {
                        cb.callSync(args: [tok, isLast])
                    }
                    Thread.sleep(forTimeInterval: 0.01)
                }
            }

            let durationMs = Int(Date().timeIntervalSince(started) * 1000)
            let promptTokens = max(1, prompt.count / 4)
            let outputTokens = max(1, cannedReply.count / 4)

            RuntimeQueue.dispatchOnJS {
                managedResolve?.callSync(args: [[
                    "text": cannedReply,
                    "prompt_tokens": promptTokens,
                    "output_tokens": outputTokens,
                    "duration_ms": durationMs,
                ]])
            }
        }

        return promise
    }

    private func hardwareInfo() -> [String: Any] {
        let pi = ProcessInfo.processInfo
        let total = Double(pi.physicalMemory) / 1_073_741_824.0
        let available: Double
        if #available(iOS 13.0, *) {
            available = max(0, Double(os_proc_available_memory()) / 1_073_741_824.0)
        } else {
            available = total
        }
        let isSimulator: Bool = {
            #if targetEnvironment(simulator)
            return true
            #else
            return false
            #endif
        }()
        // Metal is supported on every iOS device we ship to, but disabled in
        // the simulator (no Metal). Use a conservative detection.
        let metalSupported = !isSimulator

        return [
            "backend": metalSupported ? "metal" : "cpu",
            "total_ram_gb": total,
            "available_ram_gb": available,
            "cpu_cores": pi.activeProcessorCount,
            "is_simulator": isSimulator,
            "metal_supported": metalSupported,
        ]
    }

    // MARK: - Stub helpers (will go away when M09 wires the real backend)

    private static func cannedReply(for prompt: String, modelPath: String) -> String {
        let p = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if p.isEmpty {
            return "[bun-runtime llama stub] empty prompt"
        }
        let modelName = (modelPath as NSString).lastPathComponent
        return "[bun-runtime llama stub | model=\(modelName)] \(p)"
    }

    private static func splitToTokens(_ text: String, max: Int) -> [String] {
        // Simple whitespace tokenization for the stub. Real backend will
        // call the model tokenizer.
        let parts = text.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        let limited = parts.prefix(max).map { $0 + " " }
        return Array(limited)
    }

    // MARK: - Promise builders

    /// Returns `(promise, resolver)`. The resolver is a JS function value.
    static func makeAsyncPromise(in ctx: JSContext) -> (Any, JSValue?) {
        let script = """
        (function(){
          let resolveFn;
          const p = new Promise(function(res){ resolveFn = res; });
          p.__milady_resolve = resolveFn;
          return p;
        })
        """
        guard let promise = ctx.evaluateScript(script)?.call(withArguments: []) else {
            return (NSNull(), nil)
        }
        let resolver = promise.forProperty("__milady_resolve")
        return (promise, resolver)
    }

    static func rejectedAsync(in ctx: JSContext, error: String) -> Any? {
        let script = "(function(msg){return Promise.resolve({error:msg});})"
        return ctx.evaluateScript(script)?.call(withArguments: [error])
    }
}
