import Foundation
import JavaScriptCore
import Darwin.Mach

// MARK: - LlamaBridgeImpl
//
// Real llama.cpp-backed implementation. Pure Swift API surface — does NOT
// install JS bridge functions. `LlamaBridge.swift` (the Capacitor plugin's
// stub) delegates to this class when M09 wires the real backend in.
//
// The split keeps responsibilities clean:
//   * `LlamaBridge.swift` owns the JS-facing contract (parses JSValue args,
//     builds promises, schedules ManagedCallback streaming).
//   * `LlamaBridgeImpl.swift` (this file) owns the C-API plumbing
//     (@_silgen_name bindings, batch/sampler setup, decode loop).
//
// Wiring: in `LlamaBridge.swift`, replace the canned-reply blocks in
// `loadModel(...)` and `generate(...)` with:
//
//     let impl = LlamaBridgeImpl.shared
//     let result = impl.loadModel(path: path, contextSize: contextSize, ...)
//     // → either { context_id } or { error: string }
//
//     let onToken: (String, Bool) -> Void = { tok, last in
//         RuntimeQueue.dispatchOnJS { streamCallback?.callSync(args: [tok, last]) }
//     }
//     let genResult = impl.generate(contextId: ..., prompt: ..., onToken: onToken)
//
// The impl is thread-safe: it does its own queueing via a per-session
// serial queue and a session registry guarded by a sync lock.

// MARK: - C-API bindings via @_silgen_name
//
// We call llama.cpp's C symbols directly through @_silgen_name rather than
// importing a generated module. This keeps us provider-agnostic: the same
// Swift code works whether the binary slice came from `LlamaCpp.xcframework`
// (built by `native/ios-bun-port/vendor-deps/llama.cpp/build-ios.sh`) or
// from a different distribution. The contract is the linker — at link time
// the symbols must resolve, otherwise we get a clear "Undefined symbol"
// error.
//
// Symbol names track upstream llama.cpp >= b4404 (Jan 2025 sampler-chain
// API). If you bump the pinned version in
// `native/ios-bun-port/vendor-deps/VERSIONS` to one that renamed any of
// these symbols, this file is where you update them.

private let LLAMA_DEFAULT_SEED: UInt32 = 0xFFFFFFFF
private let LLAMA_TOKEN_NULL: Int32 = -1

typealias LlamaModelPtr = OpaquePointer
typealias LlamaContextPtr = OpaquePointer
typealias LlamaVocabPtr = OpaquePointer
typealias LlamaSamplerPtr = OpaquePointer

@_silgen_name("llama_backend_init")
private func c_llama_backend_init()

@_silgen_name("llama_backend_free")
private func c_llama_backend_free()

@_silgen_name("llama_model_load_from_file")
private func c_llama_model_load_from_file(
    _ path: UnsafePointer<CChar>,
    _ params: LlamaModelParamsBag
) -> LlamaModelPtr?

@_silgen_name("llama_model_free")
private func c_llama_model_free(_ model: LlamaModelPtr)

@_silgen_name("llama_model_default_params")
private func c_llama_model_default_params() -> LlamaModelParamsBag

@_silgen_name("llama_init_from_model")
private func c_llama_init_from_model(
    _ model: LlamaModelPtr,
    _ params: LlamaContextParamsBag
) -> LlamaContextPtr?

@_silgen_name("llama_free")
private func c_llama_free(_ ctx: LlamaContextPtr)

@_silgen_name("llama_context_default_params")
private func c_llama_context_default_params() -> LlamaContextParamsBag

@_silgen_name("llama_model_get_vocab")
private func c_llama_model_get_vocab(_ model: LlamaModelPtr) -> LlamaVocabPtr

@_silgen_name("llama_n_ctx")
private func c_llama_n_ctx(_ ctx: LlamaContextPtr) -> UInt32

@_silgen_name("llama_tokenize")
private func c_llama_tokenize(
    _ vocab: LlamaVocabPtr,
    _ text: UnsafePointer<CChar>,
    _ text_len: Int32,
    _ tokens: UnsafeMutablePointer<Int32>,
    _ n_tokens_max: Int32,
    _ add_special: Bool,
    _ parse_special: Bool
) -> Int32

@_silgen_name("llama_token_to_piece")
private func c_llama_token_to_piece(
    _ vocab: LlamaVocabPtr,
    _ token: Int32,
    _ buf: UnsafeMutablePointer<CChar>,
    _ length: Int32,
    _ lstrip: Int32,
    _ special: Bool
) -> Int32

@_silgen_name("llama_vocab_is_eog")
private func c_llama_vocab_is_eog(_ vocab: LlamaVocabPtr, _ token: Int32) -> Bool

@_silgen_name("llama_batch_init")
private func c_llama_batch_init(_ n_tokens: Int32, _ embd: Int32, _ n_seq_max: Int32) -> LlamaBatch

@_silgen_name("llama_batch_free")
private func c_llama_batch_free(_ batch: LlamaBatch)

@_silgen_name("llama_decode")
private func c_llama_decode(_ ctx: LlamaContextPtr, _ batch: LlamaBatch) -> Int32

@_silgen_name("llama_sampler_chain_default_params")
private func c_llama_sampler_chain_default_params() -> LlamaSamplerChainParams

@_silgen_name("llama_sampler_chain_init")
private func c_llama_sampler_chain_init(_ params: LlamaSamplerChainParams) -> LlamaSamplerPtr?

@_silgen_name("llama_sampler_chain_add")
private func c_llama_sampler_chain_add(_ chain: LlamaSamplerPtr, _ sampler: LlamaSamplerPtr)

@_silgen_name("llama_sampler_init_temp")
private func c_llama_sampler_init_temp(_ t: Float) -> LlamaSamplerPtr?

@_silgen_name("llama_sampler_init_top_p")
private func c_llama_sampler_init_top_p(_ p: Float, _ min_keep: Int) -> LlamaSamplerPtr?

@_silgen_name("llama_sampler_init_top_k")
private func c_llama_sampler_init_top_k(_ k: Int32) -> LlamaSamplerPtr?

@_silgen_name("llama_sampler_init_dist")
private func c_llama_sampler_init_dist(_ seed: UInt32) -> LlamaSamplerPtr?

@_silgen_name("llama_sampler_sample")
private func c_llama_sampler_sample(_ smpl: LlamaSamplerPtr, _ ctx: LlamaContextPtr, _ idx: Int32) -> Int32

@_silgen_name("llama_sampler_accept")
private func c_llama_sampler_accept(_ smpl: LlamaSamplerPtr, _ token: Int32)

@_silgen_name("llama_sampler_free")
private func c_llama_sampler_free(_ smpl: LlamaSamplerPtr)

@_silgen_name("llama_kv_self_clear")
private func c_llama_kv_self_clear(_ ctx: LlamaContextPtr)

// MARK: - Opaque parameter bags
//
// llama.cpp's `llama_model_params`, `llama_context_params`, and `llama_batch`
// are POD structs but their layouts drift across upstream releases. We treat
// the params structs as opaque byte bags sized generously, and use a tiny C
// shim (LlamaShim.c) for the few field reads/writes Swift needs. That keeps
// Swift agnostic to layout drift.
//
// `LlamaBatch` we mirror in Swift because its layout has been stable since
// the b3000-era refactor and we need to pass it back into C functions by
// value. Six pointers + n_tokens; alignment is automatic.

struct LlamaModelParamsBag {
    // Storage sized to comfortably hold upstream `llama_model_params` (~96 B).
    // Never read from Swift directly — the shim is the only authorized writer.
    private var storage: (UInt64, UInt64, UInt64, UInt64,
                          UInt64, UInt64, UInt64, UInt64,
                          UInt64, UInt64, UInt64, UInt64,
                          UInt64, UInt64, UInt64, UInt64) =
        (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
}

struct LlamaContextParamsBag {
    // Storage sized to comfortably hold upstream `llama_context_params` (~144 B).
    private var storage: (UInt64, UInt64, UInt64, UInt64,
                          UInt64, UInt64, UInt64, UInt64,
                          UInt64, UInt64, UInt64, UInt64,
                          UInt64, UInt64, UInt64, UInt64,
                          UInt64, UInt64, UInt64, UInt64,
                          UInt64, UInt64, UInt64, UInt64) =
        (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
         0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
}

struct LlamaSamplerChainParams {
    var no_perf: Bool = false
}

struct LlamaBatch {
    var n_tokens: Int32 = 0
    var token: UnsafeMutablePointer<Int32>? = nil
    var embd: UnsafeMutablePointer<Float>? = nil
    var pos: UnsafeMutablePointer<Int32>? = nil
    var n_seq_id: UnsafeMutablePointer<Int32>? = nil
    var seq_id: UnsafeMutablePointer<UnsafeMutablePointer<Int32>?>? = nil
    var logits: UnsafeMutablePointer<Int8>? = nil
}

// Shim symbols — implemented in LlamaShim.c. The shim folds into libllama.a
// by `vendor-deps/llama.cpp/build-ios.sh`.

@_silgen_name("milady_llama_model_params_set_n_gpu_layers")
private func shim_model_params_set_n_gpu_layers(_ params: UnsafeMutablePointer<LlamaModelParamsBag>, _ n: Int32)

@_silgen_name("milady_llama_context_params_set_n_ctx")
private func shim_context_params_set_n_ctx(_ params: UnsafeMutablePointer<LlamaContextParamsBag>, _ n: UInt32)

@_silgen_name("milady_llama_context_params_set_n_threads")
private func shim_context_params_set_n_threads(_ params: UnsafeMutablePointer<LlamaContextParamsBag>, _ n: Int32, _ n_batch: Int32)

@_silgen_name("milady_llama_batch_set_single")
private func shim_batch_set_single(_ batch: UnsafeMutablePointer<LlamaBatch>, _ token: Int32, _ pos: Int32, _ logits_out: Bool)

@_silgen_name("milady_llama_batch_append")
private func shim_batch_append(_ batch: UnsafeMutablePointer<LlamaBatch>, _ token: Int32, _ pos: Int32, _ logits_out: Bool)

@_silgen_name("milady_llama_batch_reset")
private func shim_batch_reset(_ batch: UnsafeMutablePointer<LlamaBatch>)

@_silgen_name("milady_llama_log_silence")
private func shim_log_silence()

@_silgen_name("milady_llama_has_metal")
private func shim_has_metal() -> Bool

// MARK: - Result types

public struct LlamaLoadResult {
    public let contextId: Int64?
    public let error: String?
    public static func success(_ id: Int64) -> LlamaLoadResult { .init(contextId: id, error: nil) }
    public static func failure(_ msg: String) -> LlamaLoadResult { .init(contextId: nil, error: msg) }
}

public struct LlamaGenerateResult {
    public let text: String
    public let promptTokens: Int
    public let outputTokens: Int
    public let durationMs: Double
    public let error: String?
    public static func success(text: String, promptTokens: Int, outputTokens: Int, durationMs: Double) -> LlamaGenerateResult {
        .init(text: text, promptTokens: promptTokens, outputTokens: outputTokens, durationMs: durationMs, error: nil)
    }
    public static func failure(_ msg: String) -> LlamaGenerateResult {
        .init(text: "", promptTokens: 0, outputTokens: 0, durationMs: 0, error: msg)
    }
}

public struct LlamaHardwareInfo {
    public let backend: String       // "metal" or "cpu"
    public let totalRamGB: Double
    public let availableRamGB: Double
    public let cpuCores: Int
    public let isSimulator: Bool
    public let metalSupported: Bool

    /// Render as the `[String: Any]` shape the bridge contract expects.
    public func asDict() -> [String: Any] {
        return [
            "backend": backend,
            "total_ram_gb": NSNumber(value: totalRamGB),
            "available_ram_gb": NSNumber(value: availableRamGB),
            "cpu_cores": NSNumber(value: cpuCores),
            "is_simulator": NSNumber(value: isSimulator),
            "metal_supported": NSNumber(value: metalSupported)
        ]
    }
}

// MARK: - Session bookkeeping

private final class LlamaSession {
    let id: Int64
    let model: LlamaModelPtr
    let ctx: LlamaContextPtr
    let vocab: LlamaVocabPtr
    let workQueue: DispatchQueue
    let nCtx: UInt32
    var cancelled: Bool = false

    init(id: Int64, model: LlamaModelPtr, ctx: LlamaContextPtr, vocab: LlamaVocabPtr, nCtx: UInt32) {
        self.id = id
        self.model = model
        self.ctx = ctx
        self.vocab = vocab
        self.nCtx = nCtx
        self.workQueue = DispatchQueue(label: "ai.eliza.bun.llama.session.\(id)")
    }

    func free() {
        c_llama_free(ctx)
        c_llama_model_free(model)
    }
}

private final class SessionRegistry {
    static let shared = SessionRegistry()
    private let queue = DispatchQueue(label: "ai.eliza.bun.llama.sessions")
    private var sessions: [Int64: LlamaSession] = [:]
    private var nextId: Int64 = 1
    private var backendInitialized = false

    func ensureBackend() {
        queue.sync {
            if !backendInitialized {
                shim_log_silence()
                c_llama_backend_init()
                backendInitialized = true
            }
        }
    }

    func add(_ session: LlamaSession) {
        queue.sync { sessions[session.id] = session }
    }

    func get(_ id: Int64) -> LlamaSession? {
        queue.sync { sessions[id] }
    }

    func remove(_ id: Int64) -> LlamaSession? {
        queue.sync {
            let s = sessions.removeValue(forKey: id)
            return s
        }
    }

    func allocateId() -> Int64 {
        queue.sync {
            let id = nextId
            nextId += 1
            return id
        }
    }
}

// MARK: - LlamaBridgeImpl public API

public final class LlamaBridgeImpl {
    public static let shared = LlamaBridgeImpl()

    private init() {}

    /// Synchronously loads a GGUF and returns either a context_id or an error.
    /// Heavy operation (file I/O + model mmap + Metal init); the caller should
    /// dispatch onto a background queue before invoking.
    public func loadModel(
        path: String,
        contextSize: UInt32 = 4096,
        useGPU: Bool = true,
        threads: Int32? = nil
    ) -> LlamaLoadResult {
        guard FileManager.default.fileExists(atPath: path) else {
            return .failure("llama_load_model: file not found at \(path)")
        }
        SessionRegistry.shared.ensureBackend()

        let resolvedThreads = threads ?? min(4, Int32(ProcessInfo.processInfo.activeProcessorCount))

        var modelParams = c_llama_model_default_params()
        let nGpuLayers: Int32 = (useGPU && shim_has_metal()) ? 999 : 0
        withUnsafeMutablePointer(to: &modelParams) { ptr in
            shim_model_params_set_n_gpu_layers(ptr, nGpuLayers)
        }

        guard let modelPtr = path.withCString({ cpath in
            c_llama_model_load_from_file(cpath, modelParams)
        }) else {
            return .failure("llama_model_load_from_file failed for \(path)")
        }

        var ctxParams = c_llama_context_default_params()
        withUnsafeMutablePointer(to: &ctxParams) { ptr in
            shim_context_params_set_n_ctx(ptr, contextSize)
            shim_context_params_set_n_threads(ptr, resolvedThreads, resolvedThreads)
        }

        guard let llamaCtx = c_llama_init_from_model(modelPtr, ctxParams) else {
            c_llama_model_free(modelPtr)
            return .failure("llama_init_from_model failed")
        }

        let vocab = c_llama_model_get_vocab(modelPtr)
        let nCtxActual = c_llama_n_ctx(llamaCtx)
        let id = SessionRegistry.shared.allocateId()
        let session = LlamaSession(
            id: id,
            model: modelPtr,
            ctx: llamaCtx,
            vocab: vocab,
            nCtx: nCtxActual
        )
        SessionRegistry.shared.add(session)
        return .success(id)
    }

    /// Streaming generation. Returns the final result after the loop ends.
    /// `onToken` is called for every sampled token; the bool second argument
    /// is `true` exactly once, at the end. The caller is responsible for
    /// marshalling `onToken` invocations back to the JS thread (we don't do
    /// that here so this class stays JSC-agnostic).
    public func generate(
        contextId: Int64,
        prompt: String,
        maxTokens: Int32 = 256,
        temperature: Float = 0.7,
        topP: Float = 0.95,
        topK: Int32 = 40,
        stopSequences: [String] = [],
        onToken: ((String, Bool) -> Void)? = nil
    ) -> LlamaGenerateResult {
        guard let session = SessionRegistry.shared.get(contextId) else {
            return .failure("llama_generate: unknown context_id \(contextId)")
        }
        session.cancelled = false
        let start = DispatchTime.now()

        // 1. Tokenize prompt.
        let promptTokens = LlamaBridgeImpl.tokenize(
            vocab: session.vocab,
            text: prompt,
            addSpecial: true
        )
        if promptTokens.isEmpty {
            return .failure("tokenize returned 0 tokens (prompt empty?)")
        }
        if Int32(promptTokens.count) >= Int32(session.nCtx) {
            return .failure("prompt (\(promptTokens.count) tokens) exceeds context (\(session.nCtx))")
        }

        // Reset KV cache for a clean generation.
        c_llama_kv_self_clear(session.ctx)

        // 2. Prefill: enqueue all prompt tokens, then decode once.
        let batch = c_llama_batch_init(max(Int32(promptTokens.count), 512), 0, 1)
        defer { c_llama_batch_free(batch) }

        var mutableBatch = batch
        withUnsafeMutablePointer(to: &mutableBatch) { ptr in
            shim_batch_reset(ptr)
            for (i, tok) in promptTokens.enumerated() {
                let isLast = i == promptTokens.count - 1
                shim_batch_append(ptr, tok, Int32(i), isLast)
            }
        }
        if c_llama_decode(session.ctx, mutableBatch) != 0 {
            return .failure("llama_decode (prompt) failed")
        }

        // 3. Sampler chain.
        var chainParams = c_llama_sampler_chain_default_params()
        chainParams.no_perf = true
        guard let chain = c_llama_sampler_chain_init(chainParams) else {
            return .failure("llama_sampler_chain_init failed")
        }
        defer { c_llama_sampler_free(chain) }
        if let s = c_llama_sampler_init_top_k(topK) { c_llama_sampler_chain_add(chain, s) }
        if let s = c_llama_sampler_init_top_p(topP, 1) { c_llama_sampler_chain_add(chain, s) }
        if let s = c_llama_sampler_init_temp(temperature) { c_llama_sampler_chain_add(chain, s) }
        if let s = c_llama_sampler_init_dist(LLAMA_DEFAULT_SEED) { c_llama_sampler_chain_add(chain, s) }

        // 4. Generation loop.
        var generated = ""
        var generatedTokens: Int32 = 0
        var nPast: Int32 = Int32(promptTokens.count)
        var stoppedByStopSeq = false

        while generatedTokens < maxTokens {
            if session.cancelled { break }

            let newTokenId = c_llama_sampler_sample(chain, session.ctx, -1)
            c_llama_sampler_accept(chain, newTokenId)

            if c_llama_vocab_is_eog(session.vocab, newTokenId) {
                break
            }

            let piece = LlamaBridgeImpl.tokenToPiece(vocab: session.vocab, token: newTokenId)
            generated.append(piece)
            generatedTokens += 1

            onToken?(piece, false)

            if !stopSequences.isEmpty {
                if let _ = stopSequences.first(where: { !$0.isEmpty && generated.hasSuffix($0) }) {
                    stoppedByStopSeq = true
                    break
                }
            }

            // Feed sampled token back to extend KV cache.
            withUnsafeMutablePointer(to: &mutableBatch) { ptr in
                shim_batch_set_single(ptr, newTokenId, nPast, true)
            }
            if c_llama_decode(session.ctx, mutableBatch) != 0 {
                onToken?("", true)
                return .failure("llama_decode (decode-loop) failed at token \(generatedTokens)")
            }
            nPast += 1

            if nPast >= Int32(session.nCtx) {
                break
            }
        }

        onToken?("", true)

        // Strip stop sequence from the bulk text (streaming consumer already saw it).
        var finalText = generated
        if stoppedByStopSeq {
            for stop in stopSequences where !stop.isEmpty && finalText.hasSuffix(stop) {
                finalText = String(finalText.dropLast(stop.count))
                break
            }
        }

        let elapsedNs = DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds
        return .success(
            text: finalText,
            promptTokens: promptTokens.count,
            outputTokens: Int(generatedTokens),
            durationMs: Double(elapsedNs) / 1_000_000.0
        )
    }

    /// Marks the in-flight generation on `contextId` for cancellation. The
    /// generation loop polls this flag between sampled tokens.
    public func cancel(contextId: Int64) {
        SessionRegistry.shared.get(contextId)?.cancelled = true
    }

    /// Releases the model + context backing `contextId`. The session's work
    /// queue serializes the free against any in-flight generate.
    public func free(contextId: Int64) {
        if let session = SessionRegistry.shared.remove(contextId) {
            session.workQueue.async { session.free() }
        }
    }

    /// Returns the work queue for a context_id, or nil. The bridge stub uses
    /// this to schedule `generate(...)` on the per-session serial queue,
    /// keeping multiple JS calls into the same context naturally serialized.
    public func workQueue(for contextId: Int64) -> DispatchQueue? {
        return SessionRegistry.shared.get(contextId)?.workQueue
    }

    /// Reports runtime capabilities. Synchronous and cheap to call.
    public func hardwareInfo() -> LlamaHardwareInfo {
        let pi = ProcessInfo.processInfo
        let isSim: Bool = {
#if targetEnvironment(simulator)
            return true
#else
            return false
#endif
        }()
        let totalRAM = Double(pi.physicalMemory) / (1024.0 * 1024.0 * 1024.0)
        let availRAM = LlamaBridgeImpl.availableMemoryGB()
        let metalSupported = shim_has_metal() && !isSim
        return LlamaHardwareInfo(
            backend: metalSupported ? "metal" : "cpu",
            totalRamGB: totalRAM,
            availableRamGB: availRAM,
            cpuCores: pi.activeProcessorCount,
            isSimulator: isSim,
            metalSupported: metalSupported
        )
    }

    // MARK: - Private helpers

    private static func availableMemoryGB() -> Double {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { ptr -> kern_return_t in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { intPtr in
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), intPtr, &count)
            }
        }
        guard result == KERN_SUCCESS else { return 0 }
        let used = Double(info.phys_footprint)
        let total = Double(ProcessInfo.processInfo.physicalMemory)
        let avail = max(0, total - used)
        return avail / (1024.0 * 1024.0 * 1024.0)
    }

    private static func tokenize(vocab: LlamaVocabPtr, text: String, addSpecial: Bool) -> [Int32] {
        let utf8 = text.utf8CString
        let textLen = Int32(text.utf8.count)
        var probeBuf = [Int32](repeating: 0, count: 8)
        let probe = utf8.withUnsafeBufferPointer { bp -> Int32 in
            guard let base = bp.baseAddress else { return 0 }
            return probeBuf.withUnsafeMutableBufferPointer { ob in
                c_llama_tokenize(vocab, base, textLen, ob.baseAddress!, Int32(ob.count), addSpecial, true)
            }
        }
        if probe >= 0 {
            return Array(probeBuf.prefix(Int(probe)))
        }
        let needed = Int(-probe)
        var tokens = [Int32](repeating: 0, count: needed)
        let written = utf8.withUnsafeBufferPointer { bp -> Int32 in
            guard let base = bp.baseAddress else { return 0 }
            return tokens.withUnsafeMutableBufferPointer { ob in
                c_llama_tokenize(vocab, base, textLen, ob.baseAddress!, Int32(ob.count), addSpecial, true)
            }
        }
        if written <= 0 { return [] }
        return Array(tokens.prefix(Int(written)))
    }

    private static func tokenToPiece(vocab: LlamaVocabPtr, token: Int32) -> String {
        var buf = [CChar](repeating: 0, count: 64)
        let n = buf.withUnsafeMutableBufferPointer { bp -> Int32 in
            c_llama_token_to_piece(vocab, token, bp.baseAddress!, Int32(bp.count), 0, false)
        }
        let writtenCount: Int
        if n < 0 {
            let needed = Int(-n)
            buf = [CChar](repeating: 0, count: needed + 1)
            let n2 = buf.withUnsafeMutableBufferPointer { bp -> Int32 in
                c_llama_token_to_piece(vocab, token, bp.baseAddress!, Int32(bp.count), 0, false)
            }
            if n2 <= 0 { return "" }
            writtenCount = Int(n2)
        } else if n == 0 {
            return ""
        } else {
            writtenCount = Int(n)
        }
        // Buffer is not necessarily null-terminated. Decode the byte slice as UTF-8.
        let bytes = buf.prefix(writtenCount).map { UInt8(bitPattern: $0) }
        return String(decoding: bytes, as: UTF8.self)
    }
}
