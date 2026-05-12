import Foundation
import JavaScriptCore

#if canImport(LlamaCppCapacitor)
import LlamaCppCapacitor
#endif

/// Implements `llama_*` from `BRIDGE_CONTRACT.md`.
///
/// `LlamaBridgeImpl` is JSContext-agnostic by design: this file owns JSValue
/// parsing, promise wiring, and ManagedCallback streaming; the impl owns the
/// llama.cpp C API calls. Bridge failures resolve as `{ error }` values
/// because the JS polyfill layer treats bridge results as native response
/// payloads rather than exception channels.
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
            LlamaBridgeImpl.shared.cancel(contextId: Int64(id))
            return NSNull()
        }

        ctx.installBridgeFunction(name: "llama_free") { args in
            guard let id = args.first?.toNumber()?.intValue else { return NSNull() }
            self.contexts.removeValue(forKey: id)
            LlamaBridgeImpl.shared.free(contextId: Int64(id))
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

            if !FileManager.default.fileExists(atPath: path) {
                RuntimeQueue.dispatchOnJS {
                    managedResolve?.callSync(args: [["error": "model file not found: \(path)"]])
                }
                return
            }

            let result = LlamaBridgeImpl.shared.loadModel(
                path: path,
                contextSize: UInt32(max(1, contextSize)),
                useGPU: useGpu,
                threads: Int32(max(1, threads))
            )
            if let error = result.error {
                RuntimeQueue.dispatchOnJS {
                    managedResolve?.callSync(args: [["error": error]])
                }
                return
            }
            guard let contextId = result.contextId else {
                RuntimeQueue.dispatchOnJS {
                    managedResolve?.callSync(args: [["error": "llama_load_model: backend returned no context_id"]])
                }
                return
            }

            let id = Int(contextId)
            self.nextContextId = max(self.nextContextId, id + 1)
            self.contexts[id] = LlamaContextState(
                id: id,
                modelPath: path,
                contextSize: contextSize,
                useGpu: useGpu,
                threads: threads,
                cancelled: false
            )

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
        let temperature = opts.objectForKeyedSubscript("temperature")?.toNumber()?.doubleValue ?? 0.7
        let topP = opts.objectForKeyedSubscript("top_p")?.toNumber()?.doubleValue ?? 0.95
        let stop = opts.objectForKeyedSubscript("stop")?.toStringArray() ?? []
        let streamToken = opts.objectForKeyedSubscript("stream_callback_token")?.toString()

        guard let state = contexts[contextId] else {
            return Self.rejectedAsync(in: ctx, error: "llama_generate: unknown context_id \(contextId)")
        }

        let (promise, resolver) = Self.makeAsyncPromise(in: ctx)
        let managedResolve = resolver.flatMap { ManagedCallback(value: $0) }
        let streamCallback = streamToken.flatMap { self.streamCallbacks[$0] }

        let queue = LlamaBridgeImpl.shared.workQueue(for: Int64(contextId)) ?? inferenceQueue
        queue.async {
            let started = Date()
            let result = LlamaBridgeImpl.shared.generate(
                contextId: Int64(state.id),
                prompt: prompt,
                maxTokens: Int32(max(1, maxTokens)),
                temperature: Float(temperature),
                topP: Float(topP),
                stopSequences: stop,
                onToken: { token, isLast in
                    guard let cb = streamCallback else { return }
                    RuntimeQueue.dispatchOnJS {
                        cb.callSync(args: [token, isLast])
                    }
                }
            )

            let durationMs = Int(Date().timeIntervalSince(started) * 1000)
            let promptTokens = max(1, result.promptTokens)
            let outputTokens = max(1, result.outputTokens)

            RuntimeQueue.dispatchOnJS {
                if let error = result.error {
                    managedResolve?.callSync(args: [["error": error]])
                    return
                }
                managedResolve?.callSync(args: [[
                    "text": result.text,
                    "prompt_tokens": promptTokens,
                    "output_tokens": outputTokens,
                    "duration_ms": Int(result.durationMs > 0 ? result.durationMs : Double(durationMs)),
                ]])
            }
        }

        return promise
    }

    private func hardwareInfo() -> [String: Any] {
        return LlamaBridgeImpl.shared.hardwareInfo().asDict()
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
