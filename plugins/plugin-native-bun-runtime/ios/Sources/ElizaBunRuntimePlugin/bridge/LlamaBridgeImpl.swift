import Foundation
#if !ELIZA_IOS_FULL_BUN_ENGINE
import JavaScriptCore
#endif
import Darwin.Mach
import os

#if ELIZA_IOS_INCLUDE_LLAMA

// MARK: - LlamaBridgeImpl
//
// Real llama.cpp-backed implementation. Pure Swift API surface — does NOT
// install JS bridge functions. `LlamaBridge.swift` owns that JS-facing layer
// and delegates llama.cpp work to this class.
//
// The split keeps responsibilities clean:
//   * `LlamaBridge.swift` owns the JS-facing contract (parses JSValue args,
//     builds promises, schedules ManagedCallback streaming).
//   * `LlamaBridgeImpl.swift` (this file) owns the C-API plumbing
//     (@_silgen_name bindings, batch/sampler setup, decode loop).
//
// The impl is thread-safe: it does its own queueing via a per-session
// serial queue and a session registry guarded by a sync lock.

// MARK: - C-API bindings via @_silgen_name
//
// We call llama.cpp's C symbols directly through @_silgen_name rather than
// importing a generated module. This keeps us provider-agnostic: the same
// Swift code works whether the binary slice came from `LlamaCpp.xcframework`
// (built by the app-core iOS local-inference pipeline) or from a different
// distribution. The contract is the linker — at link time
// the symbols must resolve, otherwise we get a clear "Undefined symbol"
// error.
//
// Symbol names track upstream llama.cpp >= b4404 (Jan 2025 sampler-chain
// API). If you bump the pinned version in
// the pinned llama.cpp version to one that renamed any of these symbols, this
// file is where you update them.

private let LLAMA_DEFAULT_SEED: UInt32 = 0xFFFFFFFF
private let LLAMA_TOKEN_NULL: Int32 = -1

typealias LlamaModelPtr = OpaquePointer
typealias LlamaContextPtr = OpaquePointer
typealias LlamaMemoryPtr = OpaquePointer
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

@_silgen_name("llama_model_n_layer")
private func c_llama_model_n_layer(_ model: LlamaModelPtr) -> Int32

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

@_silgen_name("llama_get_memory")
private func c_llama_get_memory(_ ctx: LlamaContextPtr) -> LlamaMemoryPtr?

@_silgen_name("llama_memory_clear")
private func c_llama_memory_clear(_ memory: LlamaMemoryPtr, _ data: Bool)

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
    // Exact size of the pinned iOS `llama_model_params` (72 B). These structs
    // are returned and passed by value, so "large enough" is not ABI-safe.
    // Never read from Swift directly — the shim is the only authorized writer.
    private var storage: (UInt64, UInt64, UInt64,
                          UInt64, UInt64, UInt64,
                          UInt64, UInt64, UInt64) =
        (0, 0, 0, 0, 0, 0, 0, 0, 0)
}

struct LlamaContextParamsBag {
    // Exact size of the pinned iOS `llama_context_params` (136 B).
    private var storage: (UInt64, UInt64, UInt64, UInt64,
                          UInt64, UInt64, UInt64, UInt64,
                          UInt64, UInt64, UInt64, UInt64,
                          UInt64, UInt64, UInt64, UInt64,
                          UInt64) =
        (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
         0, 0, 0, 0, 0)
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

@_silgen_name("eliza_llama_model_params_set_n_gpu_layers")
private func shim_model_params_set_n_gpu_layers(_ params: UnsafeMutablePointer<LlamaModelParamsBag>, _ n: Int32)

@_silgen_name("eliza_llama_context_params_set_n_ctx")
private func shim_context_params_set_n_ctx(_ params: UnsafeMutablePointer<LlamaContextParamsBag>, _ n: UInt32)

@_silgen_name("eliza_llama_context_params_set_n_threads")
private func shim_context_params_set_n_threads(_ params: UnsafeMutablePointer<LlamaContextParamsBag>, _ n: Int32, _ n_batch: Int32)

@_silgen_name("eliza_llama_context_params_set_batch_sizes")
private func shim_context_params_set_batch_sizes(_ params: UnsafeMutablePointer<LlamaContextParamsBag>, _ nBatch: UInt32, _ nUbatch: UInt32)

@_silgen_name("eliza_llama_batch_set_single")
private func shim_batch_set_single(_ batch: UnsafeMutablePointer<LlamaBatch>, _ token: Int32, _ pos: Int32, _ logits_out: Bool)

@_silgen_name("eliza_llama_batch_append")
private func shim_batch_append(_ batch: UnsafeMutablePointer<LlamaBatch>, _ token: Int32, _ pos: Int32, _ logits_out: Bool)

@_silgen_name("eliza_llama_batch_reset")
private func shim_batch_reset(_ batch: UnsafeMutablePointer<LlamaBatch>)

@_silgen_name("eliza_llama_log_silence")
private func shim_log_silence()

@_silgen_name("eliza_llama_log_to_file")
private func shim_log_to_file(_ path: UnsafePointer<CChar>) -> Bool

@_silgen_name("eliza_llama_has_metal")
private func shim_has_metal() -> Bool

// KV cache-type setters. `type` is the integer value of llama.cpp's
// `ggml_type` enum (e.g. 1=f16, 8=q8_0, 2=q4_0). The Swift wrapper
// maps the string-typed cacheType{K,V} from JS to the enum value
// via `ggmlTypeFromString` and only invokes these when a mapping
// exists; otherwise the field keeps its default and llama.cpp uses
// the build-time default (typically f16).
@_silgen_name("eliza_llama_context_params_set_type_k")
private func shim_context_params_set_type_k(_ params: UnsafeMutablePointer<LlamaContextParamsBag>, _ type: Int32)

@_silgen_name("eliza_llama_context_params_set_type_v")
private func shim_context_params_set_type_v(_ params: UnsafeMutablePointer<LlamaContextParamsBag>, _ type: Int32)

// MTP speculative-decode bridge. `shim_speculative_supported()`
// returns true only when the linked slice has the buun fork's
// libcommon (with `common_speculative_draft_gen`) folded into it.
// On stock slices the helper is absent and `supported()` is false;
// the generate loop then falls back to plain decode.
@_silgen_name("eliza_llama_speculative_supported")
private func shim_speculative_supported() -> Bool

@_silgen_name("eliza_llama_speculative_draft_gen")
private func shim_speculative_draft_gen(
    _ targetCtx: LlamaContextPtr,
    _ drafterCtx: LlamaContextPtr,
    _ pastTokens: UnsafePointer<Int32>,
    _ nPast: Int32,
    _ draftMin: Int32,
    _ draftMax: Int32,
    _ outDrafted: UnsafeMutablePointer<Int32>,
    _ outCapacity: Int32
) -> Int32

// Token-tree sampler constructor. Returns NULL when the slice does
// not link `llama_sampler_init_logit_bias` or when the payload is
// malformed. The Swift caller checks for NULL before adding the stage
// to the sampler chain.
@_silgen_name("eliza_llama_sampler_init_token_tree")
private func shim_sampler_init_token_tree(
    _ nVocab: Int32,
    _ trieBytes: UnsafePointer<UInt8>,
    _ trieSize: Int
) -> LlamaSamplerPtr?

// Vocab size lookup used when constructing the token-tree sampler.
@_silgen_name("llama_vocab_n_tokens")
private func c_llama_vocab_n_tokens(_ vocab: LlamaVocabPtr) -> Int32

typealias ElizaInferenceContextPtr = OpaquePointer

@_silgen_name("eliza_inference_abi_version")
private func c_eliza_inference_abi_version() -> UnsafePointer<CChar>?

@_silgen_name("eliza_inference_create")
private func c_eliza_inference_create(
    _ bundleDir: UnsafePointer<CChar>,
    _ outError: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
) -> ElizaInferenceContextPtr?

@_silgen_name("eliza_inference_destroy")
private func c_eliza_inference_destroy(_ ctx: ElizaInferenceContextPtr?)

@_silgen_name("eliza_inference_mmap_acquire")
private func c_eliza_inference_mmap_acquire(
    _ ctx: ElizaInferenceContextPtr?,
    _ regionName: UnsafePointer<CChar>,
    _ outError: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
) -> Int32

@_silgen_name("eliza_inference_tts_synthesize")
private func c_eliza_inference_tts_synthesize(
    _ ctx: ElizaInferenceContextPtr?,
    _ text: UnsafePointer<CChar>,
    _ textLen: Int,
    _ speakerPresetId: UnsafePointer<CChar>?,
    _ outPcm: UnsafeMutablePointer<Float>,
    _ maxSamples: Int,
    _ outError: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
) -> Int32

@_silgen_name("eliza_inference_asr_transcribe")
private func c_eliza_inference_asr_transcribe(
    _ ctx: ElizaInferenceContextPtr?,
    _ pcm: UnsafePointer<Float>?,
    _ nSamples: Int,
    _ sampleRate: Int32,
    _ outText: UnsafeMutablePointer<CChar>?,
    _ maxTextBytes: Int,
    _ outError: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32

@_silgen_name("eliza_inference_free_string")
private func c_eliza_inference_free_string(_ value: UnsafeMutablePointer<CChar>?)

// MARK: - Result types

/// Per-generation speculative-decode toggle. `auto` follows the session
/// state (drafter loaded + slice supports spec decode); `on` requires it
/// (falls back with a log line if unsupported); `off` forces plain decode.
public enum SpecDecodeMode {
    case auto
    case on
    case off
}

public struct LlamaLoadResult {
    public let contextId: Int64?
    public let error: String?
    public static func success(_ id: Int64) -> LlamaLoadResult { .init(contextId: id, error: nil) }
    public static func failure(_ id: Int64?, _ msg: String?) -> LlamaLoadResult { .init(contextId: id, error: msg) }
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

public struct LlamaTtsSynthesizeResult {
    public let audioBase64: String
    public let audioFilePath: String?
    public let contentType: String
    public let sampleRate: Int
    public let samples: Int
    public let durationMs: Double
    public let error: String?

    public static func success(audioFilePath: String, sampleRate: Int, samples: Int, durationMs: Double) -> LlamaTtsSynthesizeResult {
        .init(
            audioBase64: "",
            audioFilePath: audioFilePath,
            contentType: "audio/wav",
            sampleRate: sampleRate,
            samples: samples,
            durationMs: durationMs,
            error: nil
        )
    }

    public static func failure(_ msg: String) -> LlamaTtsSynthesizeResult {
        .init(
            audioBase64: "",
            audioFilePath: nil,
            contentType: "audio/wav",
            sampleRate: 24_000,
            samples: 0,
            durationMs: 0,
            error: msg
        )
    }
}

public struct LlamaAsrTranscribeResult {
    public let text: String
    public let durationMs: Double
    public let error: String?

    public static func success(text: String, durationMs: Double) -> LlamaAsrTranscribeResult {
        .init(text: text, durationMs: durationMs, error: nil)
    }

    public static func failure(_ msg: String) -> LlamaAsrTranscribeResult {
        .init(text: "", durationMs: 0, error: msg)
    }
}

public struct LlamaHardwareInfo {
    public let backend: String       // "metal" or "cpu"
    public let totalRamGB: Double
    public let availableRamGB: Double
    public let cpuCores: Int
    public let isSimulator: Bool
    public let metalSupported: Bool
    /// True when the linked slice exposes a usable `common_speculative_draft_gen`
    /// AND the device has enough headroom to run target + drafter side-by-side.
    public let mtpSupported: Bool
    /// Optional human-readable reason when `mtpSupported` is false.
    public let mtpReason: String?

    /// Render as the `[String: Any]` shape the bridge contract expects.
    public func asDict() -> [String: Any] {
        var dict: [String: Any] = [
            "backend": backend,
            "total_ram_gb": NSNumber(value: totalRamGB),
            "available_ram_gb": NSNumber(value: availableRamGB),
            "cpu_cores": NSNumber(value: cpuCores),
            "is_simulator": NSNumber(value: isSimulator),
            "metal_supported": NSNumber(value: metalSupported),
            "mtp_supported": NSNumber(value: mtpSupported)
        ]
        if let reason = mtpReason {
            dict["mtp_reason"] = reason
        }
        return dict
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
    let nBatch: UInt32
    var cancelled: Bool = false

    // MTP drafter state. Non-nil iff the user passed a `draftModelPath`
    // at load time AND the slice supports speculative decode (the
    // `eliza_llama_speculative_supported` shim probe returned true).
    let drafterModel: LlamaModelPtr?
    let drafterCtx: LlamaContextPtr?
    let draftMinDefault: Int32
    let draftMaxDefault: Int32

    init(
        id: Int64,
        model: LlamaModelPtr,
        ctx: LlamaContextPtr,
        vocab: LlamaVocabPtr,
        nCtx: UInt32,
        nBatch: UInt32,
        drafterModel: LlamaModelPtr? = nil,
        drafterCtx: LlamaContextPtr? = nil,
        draftMinDefault: Int32 = 1,
        draftMaxDefault: Int32 = 3
    ) {
        self.id = id
        self.model = model
        self.ctx = ctx
        self.vocab = vocab
        self.nCtx = nCtx
        self.nBatch = nBatch
        self.drafterModel = drafterModel
        self.drafterCtx = drafterCtx
        self.draftMinDefault = draftMinDefault
        self.draftMaxDefault = draftMaxDefault
        self.workQueue = DispatchQueue(label: "ai.eliza.bun.llama.session.\(id)")
    }

    func free() {
        if let drafterCtx = drafterCtx {
            c_llama_free(drafterCtx)
        }
        if let drafterModel = drafterModel {
            c_llama_model_free(drafterModel)
        }
        c_llama_free(ctx)
        c_llama_model_free(model)
    }
}

private final class CachedVoiceContext {
    let bundleDir: String
    let backend: String
    let context: ElizaInferenceContextPtr

    init(bundleDir: String, backend: String, context: ElizaInferenceContextPtr) {
        self.bundleDir = bundleDir
        self.backend = backend
        self.context = context
    }
}

/// Maps a string KV cache type ("f16", "q8_0", "q4_0", "tbq3", ...) to the
/// integer value of llama.cpp's `ggml_type` enum. Returns nil for unknown
/// types so the caller can leave the params struct at default. Fork-specific
/// TBQ / QJL / Q4_POLAR codes mirror the patched ggml_type enum values
/// introduced by `packages/app-core/scripts/build-llama-cpp-mtp.mjs`;
/// when the linked slice doesn't have those kernels compiled in, llama.cpp
/// reports the error at context-init time and we surface it through
/// `loadModel`'s failure path.
private func ggmlTypeFromString(_ raw: String?) -> Int32? {
    guard let raw = raw?.lowercased(), !raw.isEmpty else { return nil }
    switch raw {
    case "f32": return 0
    case "f16": return 1
    case "q4_0": return 2
    case "q4_1": return 3
    case "q5_0": return 6
    case "q5_1": return 7
    case "q8_0": return 8
    case "q8_1": return 9
    case "q2_k": return 10
    case "q3_k": return 11
    case "q4_k": return 12
    case "q5_k": return 13
    case "q6_k": return 14
    case "q8_k": return 15
    // Buun fork codes. Values mirror the patched enum in build-llama-cpp-mtp.mjs.
    case "tbq3", "q4_tq3": return 64
    case "tbq4", "q4_tq4": return 65
    case "qjl4": return 66
    case "q4_polar": return 67
    default: return nil
    }
}

/// Routes ggml/llama logs to a pullable file under the app's writable state
/// dir (issue #11612). iOS does not forward the embedded engine's stdio to
/// devicectl/idevicesyslog, so without this sink the GGML_LOG_ERROR line that
/// names a failing Metal kernel is unobservable on device. The file is
/// capturable with `xcrun devicectl device copy from`. Falls back to
/// silencing the logger when the sink file cannot be opened.
private func installGgmlLogSink() {
    let env = ProcessInfo.processInfo.environment
    let stateDir = env["ELIZA_STATE_DIR"].flatMap { $0.isEmpty ? nil : $0 }
        ?? SandboxPaths().appSupport.path
    let logsDir = URL(fileURLWithPath: stateDir, isDirectory: true)
        .appendingPathComponent("logs", isDirectory: true)
    try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
    let logPath = logsDir.appendingPathComponent("ggml.log").path
    if logPath.withCString({ shim_log_to_file($0) }) {
        NSLog("[LlamaBridgeImpl] ggml/llama logs -> \(logPath)")
    } else {
        NSLog("[LlamaBridgeImpl] ggml log sink unavailable at \(logPath); silencing llama logs")
        shim_log_silence()
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
                installGgmlLogSink()
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
    private let ttsQueue = DispatchQueue(label: "ai.eliza.bun.llama.tts")
    private var cachedTtsContext: CachedVoiceContext?
    private var cachedAsrContext: CachedVoiceContext?

    private init() {}

    private static var isRunningInSimulator: Bool {
#if targetEnvironment(simulator)
        return true
#else
        return false
#endif
    }

    /// Keep this in sync with the pinned `llama_model_params` layout mirrored
    /// in `runtime-symbol-shim.c`. Upstream defaults keep `use_extra_bufts`
    /// enabled, which can still touch Metal buffer types even when
    /// `n_gpu_layers` is zero. `split_mode = LLAMA_SPLIT_MODE_NONE` plus
    /// `main_gpu = -1` tells llama.cpp to clear discovered GPU devices.
    private static func forceModelCpuOnly(_ params: UnsafeMutablePointer<LlamaModelParamsBag>) {
        let raw = UnsafeMutableRawPointer(params)
        raw.advanced(by: 20).storeBytes(of: Int32(0), as: Int32.self) // split_mode = LLAMA_SPLIT_MODE_NONE
        raw.advanced(by: 24).storeBytes(of: Int32(-1), as: Int32.self) // main_gpu = disabled
        raw.advanced(by: 69).storeBytes(of: UInt8(0), as: UInt8.self) // use_extra_bufts
    }

    /// Keep this in sync with the pinned `llama_context_params` layout mirrored
    /// in `runtime-symbol-shim.c`. CPU-only simulator loads must also disable
    /// KQV/op offload and flash attention, otherwise llama.cpp can initialize
    /// ggml-metal during context creation.
    private static func setContextGpuOffload(
        _ params: UnsafeMutablePointer<LlamaContextParamsBag>,
        enabled: Bool
    ) {
        let raw = UnsafeMutableRawPointer(params)
        if !enabled {
            raw.advanced(by: 36).storeBytes(of: Int32(0), as: Int32.self) // flash_attn_type disabled
        }
        raw.advanced(by: 113).storeBytes(of: UInt8(enabled ? 1 : 0), as: UInt8.self) // offload_kqv
        raw.advanced(by: 115).storeBytes(of: UInt8(enabled ? 1 : 0), as: UInt8.self) // op_offload
    }

    private static func mobileBatchSizes(contextSize: UInt32) -> (logical: UInt32, physical: UInt32) {
        let logical = max(UInt32(1), min(contextSize, UInt32(4096)))
        // #11612 GPU-OOM fix: the Metal compute buffer scales ~linearly with
        // the physical micro-batch (n_ubatch). Measured on iPhone 16 Pro Max
        // (A18): 1037 MiB at n_ubatch=1024, which pushed weights (4722 MiB,
        // full offload) + compute + KV (36 MiB) ≈ 5795 MiB past the ~5461 MiB
        // jetsam working set (2/3 of 8 GiB) → decode ret=-3 + jetsam. At 256
        // the compute buffer is ~260 MiB: 4722 + 260 + 36 ≈ 5018 MiB fits
        // with full-GPU speed retained. Prefill still chunks by the logical
        // batch; llama.cpp splits it into n_ubatch slices internally.
        let physicalLimit: UInt32 = Self.isRunningInSimulator ? 512 : 256
        return (logical, max(UInt32(1), min(logical, physicalLimit)))
    }

    /// Per-element Metal compute-buffer cost for the physical micro-batch:
    /// 1037 MiB measured at n_ubatch=1024 on the mobile 4b tier (A18), plus
    /// ~5% slack → ~1.05 MiB per element.
    private static let computeBytesPerUbatchElement: UInt64 = 1_100_000

    /// Wire-cost estimate for one loaded context at `ctx` tokens: KV +
    /// per-token scratch, the n_ubatch-scaled compute buffer, and fixed
    /// runtime overhead (Metal heaps, tokenizer, batch buffers, mmap page-in
    /// slack). Weights are added by the caller — they are only wired for the
    /// GPU-offloaded fraction of layers.
    private static func nonWeightBytes(contextSize: UInt32) -> UInt64 {
        let perTokenBytes: UInt64 = 64 * 1024
        let computeBytes =
            UInt64(Self.mobileBatchSizes(contextSize: contextSize).physical)
            * Self.computeBytesPerUbatchElement
        let runtimeOverheadBytes: UInt64 = 256 * 1024 * 1024
        return UInt64(contextSize) * perTokenBytes + computeBytes + runtimeOverheadBytes
    }

    /// Read the transformer layer count from a GGUF via a CPU-only,
    /// mmap-backed metadata load (no Metal wiring; clean pages only). Used
    /// exclusively on the degraded partial-offload path, so the extra load
    /// is paid only when the model already failed full-offload admission.
    private static func probeLayerCount(path: String) -> Int32? {
        var params = c_llama_model_default_params()
        withUnsafeMutablePointer(to: &params) { ptr in
            shim_model_params_set_n_gpu_layers(ptr, 0)
            Self.forceModelCpuOnly(ptr)
        }
        guard let model = path.withCString({ cpath in
            c_llama_model_load_from_file(cpath, params)
        }) else { return nil }
        defer { c_llama_model_free(model) }
        let layers = c_llama_model_n_layer(model)
        return layers > 0 ? layers : nil
    }

    /// Synchronously loads a GGUF and returns either a context_id or an error.
    /// Heavy operation (file I/O + model mmap + Metal init); the caller should
    /// dispatch onto a background queue before invoking.
    ///
    /// When `draftModelPath` is set AND the linked slice supports speculative
    /// decode (`shim_speculative_supported()` is true), a second model +
    /// context is loaded as the MTP drafter and stored on the session.
    /// Drafter load failures are non-fatal: we log and proceed without spec
    /// decode rather than failing the entire load.
    public func loadModel(
        path: String,
        contextSize: UInt32 = 4096,
        useGPU: Bool = true,
        threads: Int32? = nil,
        draftModelPath: String? = nil,
        draftContextSize: UInt32 = 4096,
        draftGpuLayers: Int32? = nil,
        draftMin: Int32 = 1,
        draftMax: Int32 = 3,
        cacheTypeK: String? = nil,
        cacheTypeV: String? = nil
    ) -> LlamaLoadResult {
        guard FileManager.default.fileExists(atPath: path) else {
            return .failure("llama_load_model: file not found at \(path)")
        }
        SessionRegistry.shared.ensureBackend()

        // #11612: a load that exceeds the per-process jetsam budget kills the
        // app (and on constrained devices can wedge the OS). Estimate the
        // footprint up front — GPU-wired weights + KV/scratch + the
        // n_ubatch-scaled Metal compute buffer + fixed overhead — then admit
        // in order of least harm: shrink the context/KV first, next reduce
        // the GPU layer offload (CPU-resident layers stay mmap-backed clean
        // pages, which do not count against the jetsam footprint the way
        // wired Metal buffers do), and only fail when not even a zero-offload
        // load fits. Fit math (iPhone 16 Pro Max, A18, 8 GiB → ~5461 MiB
        // headroom): weights 4722 + compute ~260 (n_ubatch 256) + KV 36
        // ≈ 5018 MiB → full offload admitted.
        let canUseGPU = useGPU && shim_has_metal() && !Self.isRunningInSimulator
        var resolvedContextSize = contextSize
        var nGpuLayers: Int32 = canUseGPU ? 999 : 0
        let headroom = Self.jetsamHeadroomBytes()
        if headroom > 0 {
            let modelBytes = Self.fileSizeBytes(path)
            let drafterBytes = draftModelPath.map { Self.fileSizeBytes($0) } ?? 0
            let minContext: UInt32 = 1024
            // When the GPU is off, weights are never wired — mmap pages them
            // lazily and the OS can evict them — so only the wired fraction
            // of the weights counts toward the budget.
            func requiredBytes(_ ctx: UInt32, wiredWeightBytes: UInt64) -> UInt64 {
                wiredWeightBytes + drafterBytes + Self.nonWeightBytes(contextSize: ctx)
            }
            let fullWeightBytes = canUseGPU ? modelBytes : 0
            while requiredBytes(resolvedContextSize, wiredWeightBytes: fullWeightBytes) > headroom
                && resolvedContextSize / 2 >= minContext {
                resolvedContextSize /= 2
            }
            if requiredBytes(resolvedContextSize, wiredWeightBytes: fullWeightBytes) > headroom {
                let fixedBytes = requiredBytes(resolvedContextSize, wiredWeightBytes: 0)
                if canUseGPU && headroom > fixedBytes && modelBytes > 0 {
                    // Partial offload: wire only the fitting fraction of
                    // layers. Layer count comes from a CPU-only metadata
                    // probe of the same GGUF (exact, no guessed constants).
                    let weightBudget = headroom - fixedBytes
                    let layerCount = Self.probeLayerCount(path: path) ?? 36
                    let fitting = Int32(
                        (Double(weightBudget) / Double(modelBytes)) * Double(layerCount)
                    )
                    nGpuLayers = max(0, min(layerCount, fitting))
                    NSLog(
                        "[LlamaBridgeImpl] memory budget: reduced n_gpu_layers 999 -> \(nGpuLayers)/\(layerCount) "
                        + "(weights \(modelBytes / 1024 / 1024) MB > budget \(weightBudget / 1024 / 1024) MB, "
                        + "headroom \(headroom / 1024 / 1024) MB, ctx \(resolvedContextSize))"
                    )
                } else {
                    let needMB = requiredBytes(resolvedContextSize, wiredWeightBytes: fullWeightBytes) / (1024 * 1024)
                    let haveMB = headroom / (1024 * 1024)
                    return .failure(
                        "llama_load_model: insufficient memory: \(path) needs ~\(needMB) MB "
                        + "(ctx \(resolvedContextSize)) but only \(haveMB) MB is available before "
                        + "the OS memory limit. Close other apps or use a smaller model."
                    )
                }
            }
            if resolvedContextSize != contextSize {
                NSLog(
                    "[LlamaBridgeImpl] memory budget: reduced context \(contextSize) -> \(resolvedContextSize) "
                    + "(model \(modelBytes / 1024 / 1024) MB, headroom \(headroom / 1024 / 1024) MB)"
                )
            }
        }

        let resolvedThreads = threads ?? min(4, Int32(ProcessInfo.processInfo.activeProcessorCount))

        var modelParams = c_llama_model_default_params()
        withUnsafeMutablePointer(to: &modelParams) { ptr in
            shim_model_params_set_n_gpu_layers(ptr, nGpuLayers)
            if !canUseGPU {
                Self.forceModelCpuOnly(ptr)
            }
        }

        guard let modelPtr = path.withCString({ cpath in
            c_llama_model_load_from_file(cpath, modelParams)
        }) else {
            return .failure("llama_model_load_from_file failed for \(path)")
        }

        let batchSizes = Self.mobileBatchSizes(contextSize: resolvedContextSize)
        var ctxParams = c_llama_context_default_params()
        withUnsafeMutablePointer(to: &ctxParams) { ptr in
            shim_context_params_set_n_ctx(ptr, resolvedContextSize)
            shim_context_params_set_batch_sizes(ptr, batchSizes.logical, batchSizes.physical)
            shim_context_params_set_n_threads(ptr, resolvedThreads, resolvedThreads)
            Self.setContextGpuOffload(ptr, enabled: canUseGPU)
            if let kCode = ggmlTypeFromString(cacheTypeK) {
                shim_context_params_set_type_k(ptr, kCode)
            }
            if let vCode = ggmlTypeFromString(cacheTypeV) {
                shim_context_params_set_type_v(ptr, vCode)
            }
        }

        guard let llamaCtx = c_llama_init_from_model(modelPtr, ctxParams) else {
            c_llama_model_free(modelPtr)
            return .failure("llama_init_from_model failed")
        }

        // Optional MTP drafter. Non-fatal: drafter load failures fall back
        // to plain decode rather than aborting the main model load.
        var drafterModelPtr: LlamaModelPtr? = nil
        var drafterCtxPtr: LlamaContextPtr? = nil
        if let drafterPath = draftModelPath, !drafterPath.isEmpty {
            if !FileManager.default.fileExists(atPath: drafterPath) {
                NSLog("[LlamaBridgeImpl] drafter not found at \(drafterPath); spec decode disabled")
            } else if !shim_speculative_supported() {
                NSLog("[LlamaBridgeImpl] linked slice has no common_speculative_draft_gen; spec decode disabled")
            } else {
                var drafterModelParams = c_llama_model_default_params()
                let drafterLayers: Int32 = draftGpuLayers ?? (canUseGPU ? 999 : 0)
                withUnsafeMutablePointer(to: &drafterModelParams) { ptr in
                    shim_model_params_set_n_gpu_layers(ptr, drafterLayers)
                    if !canUseGPU { Self.forceModelCpuOnly(ptr) }
                }
                let loadedDrafter = drafterPath.withCString { cpath in
                    c_llama_model_load_from_file(cpath, drafterModelParams)
                }
                if let dm = loadedDrafter {
                    let draftBatchSizes = Self.mobileBatchSizes(contextSize: draftContextSize)
                    var drafterCtxParams = c_llama_context_default_params()
                    withUnsafeMutablePointer(to: &drafterCtxParams) { ptr in
                        shim_context_params_set_n_ctx(ptr, draftContextSize)
                        shim_context_params_set_batch_sizes(ptr, draftBatchSizes.logical, draftBatchSizes.physical)
                        shim_context_params_set_n_threads(ptr, resolvedThreads, resolvedThreads)
                        Self.setContextGpuOffload(ptr, enabled: canUseGPU)
                        if let kCode = ggmlTypeFromString(cacheTypeK) {
                            shim_context_params_set_type_k(ptr, kCode)
                        }
                        if let vCode = ggmlTypeFromString(cacheTypeV) {
                            shim_context_params_set_type_v(ptr, vCode)
                        }
                    }
                    if let dctx = c_llama_init_from_model(dm, drafterCtxParams) {
                        drafterModelPtr = dm
                        drafterCtxPtr = dctx
                    } else {
                        c_llama_model_free(dm)
                        NSLog("[LlamaBridgeImpl] drafter context init failed; spec decode disabled")
                    }
                } else {
                    NSLog("[LlamaBridgeImpl] drafter model load failed for \(drafterPath); spec decode disabled")
                }
            }
        }

        let vocab = c_llama_model_get_vocab(modelPtr)
        let nCtxActual = c_llama_n_ctx(llamaCtx)
        let id = SessionRegistry.shared.allocateId()
        let resolvedDraftMin = max(1, draftMin)
        let resolvedDraftMax = max(resolvedDraftMin, draftMax)
        let session = LlamaSession(
            id: id,
            model: modelPtr,
            ctx: llamaCtx,
            vocab: vocab,
            nCtx: nCtxActual,
            nBatch: batchSizes.logical,
            drafterModel: drafterModelPtr,
            drafterCtx: drafterCtxPtr,
            draftMinDefault: resolvedDraftMin,
            draftMaxDefault: resolvedDraftMax
        )
        SessionRegistry.shared.add(session)
        return .success(id)
    }

    /// Streaming generation. Returns the final result after the loop ends.
    /// `onToken` is called for every sampled token; the bool second argument
    /// is `true` exactly once, at the end. The caller is responsible for
    /// marshalling `onToken` invocations back to the JS thread (we don't do
    /// that here so this class stays JSC-agnostic).
    ///
    /// - `specDecode`:
    ///     - `.auto` (default): use spec decode iff the session has a drafter
    ///       AND the slice supports it.
    ///     - `.on`: prefer spec decode; fall back to plain decode with a
    ///       log line when unsupported.
    ///     - `.off`: force plain decode even when a drafter is loaded.
    /// - `draftMin` / `draftMax` override session defaults per call.
    /// - `tokenTreeTrie` is the serialized token-tree payload (see
    ///   `token-tree.ts`); when non-nil and the slice exposes
    ///   `llama_sampler_init_logit_bias`, the bias stage is inserted
    ///   into the sampler chain before the temperature/top-k/top-p
    ///   stages so the trie constraints fire first.
    public func generate(
        contextId: Int64,
        prompt: String,
        maxTokens: Int32 = 256,
        temperature: Float = 0.7,
        topP: Float = 0.95,
        topK: Int32 = 40,
        stopSequences: [String] = [],
        specDecode: SpecDecodeMode = .auto,
        draftMin: Int32? = nil,
        draftMax: Int32? = nil,
        tokenTreeTrie: Data? = nil,
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
        if let memory = c_llama_get_memory(session.ctx) {
            c_llama_memory_clear(memory, true)
        }

        // 2. Prefill the prompt in chunks that fit the context's logical
        // batch size. llama.cpp aborts, rather than returning an error, when a
        // single decode exceeds cparams.n_batch.
        let prefillChunkSize = max(1, min(Int(session.nBatch), promptTokens.count))
        let batch = c_llama_batch_init(Int32(prefillChunkSize), 0, 1)
        defer { c_llama_batch_free(batch) }

        var mutableBatch = batch
        var prefilled = 0
        while prefilled < promptTokens.count {
            let chunkEnd = min(prefilled + prefillChunkSize, promptTokens.count)
            withUnsafeMutablePointer(to: &mutableBatch) { ptr in
                shim_batch_reset(ptr)
                for i in prefilled..<chunkEnd {
                    let isLast = i == promptTokens.count - 1
                    shim_batch_append(ptr, promptTokens[i], Int32(i), isLast)
                }
            }
            if c_llama_decode(session.ctx, mutableBatch) != 0 {
                return .failure("llama_decode (prompt chunk \(prefilled)..<\(chunkEnd)) failed")
            }
            prefilled = chunkEnd
        }

        // 3. Sampler chain.
        var chainParams = c_llama_sampler_chain_default_params()
        chainParams.no_perf = true
        guard let chain = c_llama_sampler_chain_init(chainParams) else {
            return .failure("llama_sampler_chain_init failed")
        }
        defer { c_llama_sampler_free(chain) }

        // Token-tree logit-bias stage fires first so the trie constrains
        // the distribution before temperature / top-k / top-p shrink it.
        // We feature-detect by NULL return: stock builds without
        // `llama_sampler_init_logit_bias` get a NULL here and we skip.
        if let trie = tokenTreeTrie, !trie.isEmpty {
            let nVocab = c_llama_vocab_n_tokens(session.vocab)
            let trieSampler: LlamaSamplerPtr? = trie.withUnsafeBytes { raw -> LlamaSamplerPtr? in
                guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return nil }
                return shim_sampler_init_token_tree(nVocab, base, trie.count)
            }
            if let s = trieSampler {
                c_llama_sampler_chain_add(chain, s)
            } else {
                NSLog("[LlamaBridgeImpl] token-tree sampler unavailable; skipping trie stage")
            }
        }

        if let s = c_llama_sampler_init_top_k(topK) { c_llama_sampler_chain_add(chain, s) }
        if let s = c_llama_sampler_init_top_p(topP, 1) { c_llama_sampler_chain_add(chain, s) }
        if let s = c_llama_sampler_init_temp(temperature) { c_llama_sampler_chain_add(chain, s) }
        if let s = c_llama_sampler_init_dist(LLAMA_DEFAULT_SEED) { c_llama_sampler_chain_add(chain, s) }

        // Resolve spec-decode mode for this call. The auto path defers
        // entirely to whether the session has a drafter AND the slice
        // supports spec decode. `.on` falls back gracefully (logs and
        // proceeds with plain decode) rather than failing.
        let wantsSpec: Bool
        switch specDecode {
        case .off:
            wantsSpec = false
        case .on:
            wantsSpec = true
            if session.drafterCtx == nil || !shim_speculative_supported() {
                NSLog("[LlamaBridgeImpl] spec decode requested but unavailable; falling back to plain decode")
            }
        case .auto:
            wantsSpec = session.drafterCtx != nil && shim_speculative_supported()
        }
        let useSpec = wantsSpec && session.drafterCtx != nil && shim_speculative_supported()
        let effectiveDraftMin = max(1, draftMin ?? session.draftMinDefault)
        let effectiveDraftMax = max(effectiveDraftMin, draftMax ?? session.draftMaxDefault)
        // Per-generation past-token buffer used by the spec-decode call.
        // Allocated up-front (capped at nCtx) so we don't realloc each step.
        var pastTokenBuffer: [Int32] = useSpec ? promptTokens : []
        pastTokenBuffer.reserveCapacity(Int(session.nCtx))
        // Scratch buffer for drafted tokens. Capped at effectiveDraftMax
        // so we never overrun the libcommon helper's writeable range.
        var draftScratch = [Int32](repeating: 0, count: Int(effectiveDraftMax))

        // 4. Generation loop.
        var generated = ""
        var generatedTokens: Int32 = 0
        var nPast: Int32 = Int32(promptTokens.count)
        var stoppedByStopSeq = false

        while generatedTokens < maxTokens {
            if session.cancelled { break }

            // First, sample one token from the target's current distribution.
            // This is the verified token that the target accepts unconditionally.
            let newTokenId = c_llama_sampler_sample(chain, session.ctx, -1)
            c_llama_sampler_accept(chain, newTokenId)

            if c_llama_vocab_is_eog(session.vocab, newTokenId) {
                break
            }

            let piece = LlamaBridgeImpl.tokenToPiece(vocab: session.vocab, token: newTokenId)
            generated.append(piece)
            generatedTokens += 1

            onToken?(piece, false)
            if useSpec {
                pastTokenBuffer.append(newTokenId)
            }

            if !stopSequences.isEmpty {
                if let _ = stopSequences.first(where: { !$0.isEmpty && generated.hasSuffix($0) }) {
                    stoppedByStopSeq = true
                    break
                }
            }

            // Feed sampled token back to extend KV cache on the main context.
            withUnsafeMutablePointer(to: &mutableBatch) { ptr in
                shim_batch_set_single(ptr, newTokenId, nPast, true)
            }
            if c_llama_decode(session.ctx, mutableBatch) != 0 {
                onToken?("", true)
                return .failure("llama_decode (decode-loop) failed at token \(generatedTokens)")
            }
            nPast += 1

            if nPast >= Int32(session.nCtx) { break }
            if generatedTokens >= maxTokens { break }

            // Optional speculative-decode burst.
            //
            // After every verified token we ask the drafter to propose up to
            // `effectiveDraftMax` continuation tokens. We then run them
            // through the target's sampler one at a time and stop on first
            // disagreement. This is the textbook common_speculative loop:
            // drafted tokens that match the target's distribution are kept
            // verbatim, the first mismatch resets us to the standard
            // per-token sample at the top of the next outer iteration.
            //
            // The shim helper guards itself when libcommon isn't linked, so
            // this branch is cheap and safe in stock builds — it just never
            // fires there (`useSpec` is false).
            if useSpec, let drafterCtx = session.drafterCtx {
                let nDrafted: Int32 = pastTokenBuffer.withUnsafeBufferPointer { pastBuf in
                    guard let pastBase = pastBuf.baseAddress else { return 0 }
                    return draftScratch.withUnsafeMutableBufferPointer { draftBuf in
                        guard let draftBase = draftBuf.baseAddress else { return 0 }
                        return shim_speculative_draft_gen(
                            session.ctx,
                            drafterCtx,
                            pastBase,
                            Int32(pastBuf.count),
                            effectiveDraftMin,
                            effectiveDraftMax,
                            draftBase,
                            Int32(draftBuf.count)
                        )
                    }
                }
                if nDrafted <= 0 { continue }

                for di in 0..<Int(nDrafted) {
                    if generatedTokens >= maxTokens { break }
                    let proposed = draftScratch[di]

                    // Verify proposal: re-sample at the same position and
                    // compare. If the target's next token equals `proposed`
                    // we accept; otherwise we discard the rest of the burst.
                    // We use the same sampler chain so temperature, top-k,
                    // top-p, and token-tree all apply equally to drafted
                    // tokens.
                    withUnsafeMutablePointer(to: &mutableBatch) { ptr in
                        shim_batch_set_single(ptr, proposed, nPast, true)
                    }
                    if c_llama_decode(session.ctx, mutableBatch) != 0 {
                        // Hard error: bubble up.
                        onToken?("", true)
                        return .failure("llama_decode (spec-verify) failed at token \(generatedTokens)")
                    }
                    let verified = c_llama_sampler_sample(chain, session.ctx, -1)
                    if verified != proposed {
                        // Disagree — accept the verified token, drop rest of burst.
                        c_llama_sampler_accept(chain, verified)
                        if c_llama_vocab_is_eog(session.vocab, verified) {
                            // Surface the verified token, then exit outer loop.
                            let p = LlamaBridgeImpl.tokenToPiece(vocab: session.vocab, token: verified)
                            generated.append(p)
                            generatedTokens += 1
                            onToken?(p, false)
                            nPast += 1
                            break
                        }
                        let p = LlamaBridgeImpl.tokenToPiece(vocab: session.vocab, token: verified)
                        generated.append(p)
                        generatedTokens += 1
                        pastTokenBuffer.append(verified)
                        onToken?(p, false)
                        nPast += 1
                        break
                    }
                    // Agree — accept the proposal verbatim.
                    c_llama_sampler_accept(chain, proposed)
                    let p = LlamaBridgeImpl.tokenToPiece(vocab: session.vocab, token: proposed)
                    generated.append(p)
                    generatedTokens += 1
                    pastTokenBuffer.append(proposed)
                    onToken?(p, false)
                    nPast += 1
                    if c_llama_vocab_is_eog(session.vocab, proposed) { break }
                    if !stopSequences.isEmpty,
                       stopSequences.first(where: { !$0.isEmpty && generated.hasSuffix($0) }) != nil {
                        stoppedByStopSeq = true
                        break
                    }
                    if nPast >= Int32(session.nCtx) { break }
                }
                if stoppedByStopSeq { break }
                if nPast >= Int32(session.nCtx) { break }
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

    public func synthesizeSpeech(
        bundleDir: String,
        text: String,
        speakerPresetId: String? = nil,
        maxSamples: Int = 24_000 * 60
    ) -> LlamaTtsSynthesizeResult {
        ttsQueue.sync {
            if Self.kokoroCoreMlTtsEnabled(),
               let coreMlResult = synthesizeKokoroCoreMl(
                bundleDir: bundleDir,
                text: text,
                speakerPresetId: speakerPresetId,
                maxSamples: maxSamples
            ) {
                return coreMlResult
            }
            // When CoreML Kokoro is unavailable, route through OmniVoice — the
            // tier DEFAULT voice engine (ELIZA_1_VOICE_BACKENDS) and the validated
            // fused engine. The fork GGUF-Kokoro path is intentionally disabled on
            // iOS ("not production speech"); OmniVoice is not gated.
            return Self.withTemporaryEnvironment("ELIZA_TTS_BACKEND", value: "omnivoice") {
                return Self.withTemporaryEnvironment("ELIZA_TTS_MAX_BACKEND_ALLOC_MB", value: "768") {
                    return Self.withTemporaryEnvironment("GGML_BACKEND", value: "CPU") {
                        return synthesizeSpeechAttempt(
                            bundleDir: bundleDir,
                            text: text,
                            speakerPresetId: speakerPresetId,
                            maxSamples: maxSamples
                        )
                    }
                }
            }
        }
    }

    /// On-device speech-to-text. Mirrors `synthesizeSpeech`: serializes on the
    /// shared inference queue, reuses the per-bundle `EliInferenceContext`
    /// (which serves text + tts + asr), and surfaces native errors verbatim.
    /// `pcm` is mono fp32 in [-1, 1]; `sampleRate` is the source rate in Hz —
    /// the linked slice resamples internally as needed.
    public func transcribeSpeech(
        bundleDir: String,
        pcm: [Float],
        sampleRate: Int
    ) -> LlamaAsrTranscribeResult {
        ttsQueue.sync {
            Self.withTemporaryEnvironment("GGML_BACKEND", value: "CPU") {
                transcribeSpeechAttempt(
                    bundleDir: bundleDir,
                    pcm: pcm,
                    sampleRate: sampleRate
                )
            }
        }
    }

    private func transcribeSpeechAttempt(
        bundleDir: String,
        pcm: [Float],
        sampleRate: Int
    ) -> LlamaAsrTranscribeResult {
        let attemptBackend = Self.currentBackendEnv()
        NSLog("[LlamaBridgeImpl] ASR attempt start backend=\(attemptBackend) bundle=\(bundleDir) samples=\(pcm.count) sampleRate=\(sampleRate)")
        guard FileManager.default.fileExists(atPath: bundleDir) else {
            NSLog("[LlamaBridgeImpl] ASR attempt failed stage=bundle-check backend=\(attemptBackend) bundle=\(bundleDir)")
            return .failure("eliza_asr_transcribe: bundle not found at \(bundleDir)")
        }
        guard !pcm.isEmpty else {
            NSLog("[LlamaBridgeImpl] ASR attempt failed stage=pcm-check backend=\(attemptBackend)")
            return .failure("eliza_asr_transcribe: empty pcm")
        }
        guard let abiPtr = c_eliza_inference_abi_version() else {
            NSLog("[LlamaBridgeImpl] ASR attempt failed stage=abi backend=\(attemptBackend) reason=missing")
            return .failure("eliza_asr_transcribe: missing eliza inference ABI")
        }
        let abi = String(cString: abiPtr)
        guard let abiVersion = Int(abi), abiVersion >= 4 else {
            NSLog("[LlamaBridgeImpl] ASR attempt failed stage=abi backend=\(attemptBackend) abi=\(abi)")
            return .failure("eliza_asr_transcribe: linked iOS inference slice is the smoke-build ABI \(abi); rebuild with fused iOS local inference")
        }

        let start = DispatchTime.now()
        let prepared = prepareAsrContext(bundleDir: bundleDir, backend: attemptBackend)
        guard let ctx = prepared.context else {
            let error = prepared.error ?? "eliza_inference_mmap_acquire(asr) failed"
            return .failure(error)
        }

        var out = [CChar](repeating: 0, count: 4096)
        var asrError: UnsafeMutablePointer<CChar>? = nil
        NSLog("[LlamaBridgeImpl] ASR stage=transcribe begin backend=\(attemptBackend) samples=\(pcm.count)")
        let bytesWritten = pcm.withUnsafeBufferPointer { pcmBuffer -> Int32 in
            guard let pcmPtr = pcmBuffer.baseAddress else { return -2 }
            return out.withUnsafeMutableBufferPointer { outBuffer -> Int32 in
                guard let outPtr = outBuffer.baseAddress else { return -2 }
                return c_eliza_inference_asr_transcribe(
                    ctx,
                    pcmPtr,
                    pcm.count,
                    Int32(sampleRate),
                    outPtr,
                    outBuffer.count,
                    &asrError
                )
            }
        }
        guard bytesWritten >= 0 else {
            let error = Self.takeInferenceError(&asrError, fallback: "eliza_inference_asr_transcribe failed with code \(bytesWritten)")
            NSLog("[LlamaBridgeImpl] ASR stage=transcribe failed backend=\(attemptBackend) code=\(bytesWritten) error=\(error)")
            clearCachedAsrContext()
            return .failure(error)
        }
        let transcript = out.withUnsafeBufferPointer { buffer -> String in
            guard let base = buffer.baseAddress else { return "" }
            return String(cString: base)
        }
        let elapsedNs = DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds
        NSLog("[LlamaBridgeImpl] ASR attempt ok backend=\(attemptBackend) bytes=\(bytesWritten) durationMs=\(Double(elapsedNs) / 1_000_000.0)")
        return .success(text: transcript, durationMs: Double(elapsedNs) / 1_000_000.0)
    }

    public func ttsEngineDiagnostics(bundleDir: String?) -> [String: Any] {
        let hardware = hardwareInfo()
        var payload: [String: Any] = [
            "available": true,
            "abiVersion": Self.elizaInferenceAbiVersion() ?? "missing",
            "ggmlBackendEnv": Self.currentBackendEnv(),
            "ttsBackendEnv": Self.currentTtsBackendEnv(),
            "kokoroGgufTtsEnabled": Self.experimentalKokoroGgufTtsEnabled(),
            "kokoroCoreMlTtsEnabled": Self.kokoroCoreMlTtsEnabled(),
            "cachedTtsContext": cachedTtsContext != nil,
            "cachedAsrContext": cachedAsrContext != nil,
            "hardware": hardware.asDict(),
        ]
        if let bundleDir {
            payload["bundleDir"] = bundleDir
            payload["kokoroCoreMl"] = Self.kokoroCoreMlDiagnostics(bundleDir: bundleDir)
        }
        return payload
    }

    private func synthesizeKokoroCoreMl(
        bundleDir: String,
        text: String,
        speakerPresetId: String?,
        maxSamples: Int
    ) -> LlamaTtsSynthesizeResult? {
        guard let coreMlDir = Self.kokoroCoreMlDirectory(bundleDir: bundleDir) else {
            return nil
        }
        guard #available(iOS 18.0, *) else {
            return .failure("iOS Kokoro CoreML TTS requires iOS 18 or newer")
        }
        do {
            NSLog("[LlamaBridgeImpl] TTS attempt start backend=kokoro-coreml bundle=\(bundleDir) modelDir=\(coreMlDir.path) textBytes=\(text.lengthOfBytes(using: .utf8)) maxSamples=\(maxSamples)")
            let result = try KokoroCoreMlEngine.shared.synthesize(
                modelDirectory: coreMlDir,
                text: text,
                voice: speakerPresetId,
                maxSamples: max(maxSamples, 24_000)
            )
            let wav = Self.wavData(from: result.samples, sampleRate: result.sampleRate)
            let audioFileUrl = FileManager.default.temporaryDirectory
                .appendingPathComponent("eliza-kokoro-coreml-\(UUID().uuidString)")
                .appendingPathExtension("wav")
            try wav.write(to: audioFileUrl, options: [.atomic])
            NSLog("[LlamaBridgeImpl] TTS attempt ok backend=kokoro-coreml voice=\(result.voice) samples=\(result.samples.count) durationMs=\(result.durationMs)")
            return .success(
                audioFilePath: audioFileUrl.path,
                sampleRate: result.sampleRate,
                samples: result.samples.count,
                durationMs: result.durationMs
            )
        } catch {
            NSLog("[LlamaBridgeImpl] TTS attempt failed backend=kokoro-coreml error=\(error.localizedDescription)")
            return .failure("Kokoro CoreML TTS failed: \(error.localizedDescription)")
        }
    }

    private func synthesizeSpeechAttempt(
        bundleDir: String,
        text: String,
        speakerPresetId: String?,
        maxSamples: Int
    ) -> LlamaTtsSynthesizeResult {
        let attemptBackend = Self.currentBackendEnv()
        NSLog("[LlamaBridgeImpl] TTS attempt start backend=\(attemptBackend) bundle=\(bundleDir) textBytes=\(text.lengthOfBytes(using: .utf8)) maxSamples=\(maxSamples)")
        guard FileManager.default.fileExists(atPath: bundleDir) else {
            NSLog("[LlamaBridgeImpl] TTS attempt failed stage=bundle-check backend=\(attemptBackend) bundle=\(bundleDir)")
            return .failure("eliza_tts_synthesize: bundle not found at \(bundleDir)")
        }
        guard let abiPtr = c_eliza_inference_abi_version() else {
            NSLog("[LlamaBridgeImpl] TTS attempt failed stage=abi backend=\(attemptBackend) reason=missing")
            return .failure("eliza_tts_synthesize: missing eliza inference ABI")
        }
        let abi = String(cString: abiPtr)
        guard let abiVersion = Int(abi), abiVersion >= 4 else {
            NSLog("[LlamaBridgeImpl] TTS attempt failed stage=abi backend=\(attemptBackend) abi=\(abi)")
            return .failure("eliza_tts_synthesize: linked iOS inference slice is the smoke-build ABI \(abi); rebuild with fused iOS local inference")
        }
        if Self.currentTtsBackendEnv() == "kokoro" && !Self.experimentalKokoroGgufTtsEnabled() {
            NSLog("[LlamaBridgeImpl] TTS attempt blocked stage=backend-gate backend=\(attemptBackend) ttsBackend=kokoro")
            return .failure("iOS Kokoro GGUF TTS is not enabled because this fork path does not produce production speech. Use the CoreML/ONNX Kokoro backend for real local voice.")
        }

        let start = DispatchTime.now()
        let prepared = prepareTtsContext(bundleDir: bundleDir, backend: attemptBackend)
        guard let ctx = prepared.context else {
            let error = prepared.error ?? "eliza_inference_mmap_acquire(tts) failed"
            return .failure(error)
        }

        let boundedMaxSamples = min(max(maxSamples, 24_000), 24_000 * 120)
        var pcm = [Float](repeating: 0, count: boundedMaxSamples)
        var ttsError: UnsafeMutablePointer<CChar>? = nil
        let textLength = text.lengthOfBytes(using: .utf8)
        NSLog("[LlamaBridgeImpl] TTS stage=synthesize begin backend=\(attemptBackend) maxSamples=\(boundedMaxSamples)")
        let sampleCount = pcm.withUnsafeMutableBufferPointer { pcmBuffer -> Int32 in
            guard let pcmPtr = pcmBuffer.baseAddress else { return -2 }
            return text.withCString { textPtr in
                if let speakerPresetId, !speakerPresetId.isEmpty {
                    return speakerPresetId.withCString { speakerPtr in
                        c_eliza_inference_tts_synthesize(
                            ctx,
                            textPtr,
                            textLength,
                            speakerPtr,
                            pcmPtr,
                            boundedMaxSamples,
                            &ttsError
                        )
                    }
                }
                return c_eliza_inference_tts_synthesize(
                    ctx,
                    textPtr,
                    textLength,
                    nil,
                    pcmPtr,
                    boundedMaxSamples,
                    &ttsError
                )
            }
        }
        guard sampleCount >= 0 else {
            let error = Self.takeInferenceError(&ttsError, fallback: "eliza_inference_tts_synthesize failed with code \(sampleCount)")
            NSLog("[LlamaBridgeImpl] TTS stage=synthesize failed backend=\(attemptBackend) code=\(sampleCount) error=\(error)")
            clearCachedTtsContext()
            return .failure(error)
        }
        NSLog("[LlamaBridgeImpl] TTS stage=synthesize ok backend=\(attemptBackend) samples=\(sampleCount)")
        let samples = Array(pcm.prefix(Int(sampleCount)))
        let wav = Self.wavData(from: samples, sampleRate: 24_000)
        let audioFileUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent("eliza-tts-\(UUID().uuidString)")
            .appendingPathExtension("wav")
        do {
            try wav.write(to: audioFileUrl, options: [.atomic])
        } catch {
            NSLog("[LlamaBridgeImpl] TTS stage=write-wav failed backend=\(attemptBackend) error=\(error.localizedDescription)")
            return .failure("eliza_tts_synthesize: failed to write synthesized audio: \(error.localizedDescription)")
        }
        let elapsedNs = DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds
        NSLog("[LlamaBridgeImpl] TTS attempt ok backend=\(attemptBackend) samples=\(samples.count) durationMs=\(Double(elapsedNs) / 1_000_000.0)")
        return .success(
            audioFilePath: audioFileUrl.path,
            sampleRate: 24_000,
            samples: samples.count,
            durationMs: Double(elapsedNs) / 1_000_000.0
        )
    }

    private func prepareTtsContext(
        bundleDir: String,
        backend: String
    ) -> (context: ElizaInferenceContextPtr?, error: String?) {
        return prepareVoiceContext(bundleDir: bundleDir, backend: backend, region: "tts")
    }

    private func prepareAsrContext(
        bundleDir: String,
        backend: String
    ) -> (context: ElizaInferenceContextPtr?, error: String?) {
        return prepareVoiceContext(bundleDir: bundleDir, backend: backend, region: "asr")
    }

    private func prepareVoiceContext(
        bundleDir: String,
        backend: String,
        region: String
    ) -> (context: ElizaInferenceContextPtr?, error: String?) {
        let cachedContext = region == "asr" ? cachedAsrContext : cachedTtsContext
        if let cachedContext,
           cachedContext.bundleDir == bundleDir,
           cachedContext.backend == backend {
            NSLog("[LlamaBridgeImpl] \(region.uppercased()) stage=mmap-acquire cached backend=\(backend) region=\(region)")
            return (cachedContext.context, nil)
        }
        clearCachedVoiceContext(region: region)

        var createError: UnsafeMutablePointer<CChar>? = nil
        NSLog("[LlamaBridgeImpl] \(region.uppercased()) stage=create begin backend=\(backend)")
        guard let ctx = bundleDir.withCString({ bundlePtr in
            c_eliza_inference_create(bundlePtr, &createError)
        }) else {
            let error = Self.takeInferenceError(&createError, fallback: "eliza_inference_create failed")
            NSLog("[LlamaBridgeImpl] \(region.uppercased()) stage=create failed backend=\(backend) error=\(error)")
            return (nil, error)
        }
        NSLog("[LlamaBridgeImpl] \(region.uppercased()) stage=create ok backend=\(backend)")

        var acquireError: UnsafeMutablePointer<CChar>? = nil
        NSLog("[LlamaBridgeImpl] \(region.uppercased()) stage=mmap-acquire begin backend=\(backend) region=\(region)")
        let acquireCode = region.withCString { regionPtr in
            c_eliza_inference_mmap_acquire(ctx, regionPtr, &acquireError)
        }
        guard acquireCode >= 0 else {
            let error = Self.takeInferenceError(&acquireError, fallback: "eliza_inference_mmap_acquire(\(region)) failed with code \(acquireCode)")
            NSLog("[LlamaBridgeImpl] \(region.uppercased()) stage=mmap-acquire failed backend=\(backend) code=\(acquireCode) error=\(error)")
            c_eliza_inference_destroy(ctx)
            return (nil, error)
        }
        NSLog("[LlamaBridgeImpl] \(region.uppercased()) stage=mmap-acquire ok backend=\(backend) region=\(region)")
        let context = CachedVoiceContext(bundleDir: bundleDir, backend: backend, context: ctx)
        if region == "asr" {
            cachedAsrContext = context
        } else {
            cachedTtsContext = context
        }
        return (ctx, nil)
    }

    private func clearCachedTtsContext() {
        clearCachedVoiceContext(region: "tts")
    }

    private func clearCachedAsrContext() {
        clearCachedVoiceContext(region: "asr")
    }

    private func clearCachedVoiceContext(region: String) {
        if region == "asr" {
            if let cachedAsrContext {
                c_eliza_inference_destroy(cachedAsrContext.context)
                self.cachedAsrContext = nil
            }
            return
        }
        if let cachedTtsContext {
            c_eliza_inference_destroy(cachedTtsContext.context)
            self.cachedTtsContext = nil
        }
    }

    private static func shouldRetryTtsOnCpu(_ error: String) -> Bool {
        let lower = error.lowercased()
        return lower.contains("ov_init failed")
            || lower.contains("pipeline_tts_load failed")
            || lower.contains("failed to allocate backend buffer")
            || lower.contains("metal")
    }

    private static func shouldPreferCpuTtsBackend() -> Bool {
        if currentBackendEnv() != "default" {
            return false
        }
        let override = getenv("ELIZA_IOS_TTS_BACKEND").map { String(cString: $0).lowercased() }
        return override != "gpu" && override != "metal"
    }

    private static func elizaInferenceAbiVersion() -> String? {
        guard let abiPtr = c_eliza_inference_abi_version() else {
            return nil
        }
        return String(cString: abiPtr)
    }

    private static func currentBackendEnv() -> String {
        getenv("GGML_BACKEND").map { String(cString: $0) } ?? "default"
    }

    private static func currentTtsBackendEnv() -> String {
        getenv("ELIZA_TTS_BACKEND").map { String(cString: $0) } ?? "default"
    }

    private static func kokoroCoreMlDirectory(bundleDir: String) -> URL? {
        guard #available(iOS 18.0, *) else { return nil }
        return KokoroCoreMlEngine.modelDirectory(in: bundleDir)
    }

    private static func kokoroCoreMlDiagnostics(bundleDir: String) -> [String: Any] {
        if #available(iOS 18.0, *) {
            return KokoroCoreMlEngine.shared.diagnostics(
                modelDirectory: kokoroCoreMlDirectory(bundleDir: bundleDir)
            )
        }
        return [
            "available": false,
            "requiresIos": "18.0",
            "error": "iOS Kokoro CoreML TTS requires iOS 18 or newer",
        ]
    }

    private static func experimentalKokoroGgufTtsEnabled() -> Bool {
        guard let value = getenv("ELIZA_IOS_ALLOW_EXPERIMENTAL_KOKORO_GGUF_TTS").map({ String(cString: $0).lowercased() }) else {
            return false
        }
        return value == "1" || value == "true" || value == "yes" || value == "on"
    }

    private static func kokoroCoreMlTtsEnabled() -> Bool {
        guard let value = getenv("ELIZA_IOS_ENABLE_KOKORO_COREML_TTS").map({ String(cString: $0).lowercased() }) else {
            return false
        }
        return value == "1" || value == "true" || value == "yes" || value == "on"
    }

    private static func withTemporaryEnvironment<T>(_ name: String, value: String, body: () -> T) -> T {
        let previous = getenv(name).map { String(cString: $0) }
        setenv(name, value, 1)
        defer {
            if let previous {
                setenv(name, previous, 1)
            } else {
                unsetenv(name)
            }
        }
        return body()
    }

    /// Releases the model + context backing `contextId`. The session's work
    /// queue serializes the free against any in-flight generate.
    public func free(contextId: Int64) {
        if let session = SessionRegistry.shared.remove(contextId) {
            session.workQueue.async { session.free() }
        }
    }

    /// Returns the work queue for a context_id, or nil. The bridge uses this
    /// to schedule `generate(...)` on the per-session serial queue, keeping
    /// multiple JS calls into the same context naturally serialized.
    public func workQueue(for contextId: Int64) -> DispatchQueue? {
        return SessionRegistry.shared.get(contextId)?.workQueue
    }

    /// Reports runtime capabilities. Synchronous and cheap to call.
    ///
    /// `mtpSupported` reflects three conjuncted conditions:
    ///   1. The linked slice exposes `common_speculative_draft_gen`
    ///      (probed via `shim_speculative_supported()`).
    ///   2. Metal is usable (we won't claim mtp on the simulator).
    ///   3. The device has enough free RAM to plausibly host target +
    ///      drafter side-by-side. The 3 GB threshold matches the
    ///      headroom required for an Eliza-1 1B drafter + 7B target
    ///      with f16 KV cache.
    public func hardwareInfo() -> LlamaHardwareInfo {
        let pi = ProcessInfo.processInfo
        let isSim = Self.isRunningInSimulator
        let totalRAM = Double(pi.physicalMemory) / (1024.0 * 1024.0 * 1024.0)
        let availRAM = LlamaBridgeImpl.availableMemoryGB()
        let metalSupported = shim_has_metal() && !isSim
        let specSlice = shim_speculative_supported()
        let memoryHeadroom = availRAM >= 3.0
        let mtpSupported = specSlice && metalSupported && memoryHeadroom
        let mtpReason: String?
        if mtpSupported {
            mtpReason = nil
        } else if !specSlice {
            mtpReason = "linked llama slice has no common_speculative_draft_gen"
        } else if !metalSupported {
            mtpReason = isSim ? "simulator: GPU unavailable" : "Metal unsupported"
        } else if !memoryHeadroom {
            mtpReason = "insufficient free RAM (need >= 3 GB, got \(String(format: "%.2f", availRAM)))"
        } else {
            mtpReason = "unknown"
        }
        return LlamaHardwareInfo(
            backend: metalSupported ? "metal" : "cpu",
            totalRamGB: totalRAM,
            availableRamGB: availRAM,
            cpuCores: pi.activeProcessorCount,
            isSimulator: isSim,
            metalSupported: metalSupported,
            mtpSupported: mtpSupported,
            mtpReason: mtpReason
        )
    }

    // MARK: - Private helpers

    /// Per-process memory still grantable before jetsam kills the app
    /// (`os_proc_available_memory`, iOS 13+). Returns 0 when the value is
    /// unavailable (e.g. simulator), in which case the load-time memory
    /// budget guard is skipped.
    private static func jetsamHeadroomBytes() -> UInt64 {
#if targetEnvironment(simulator)
        return 0
#else
        return UInt64(max(0, os_proc_available_memory()))
#endif
    }

    private static func fileSizeBytes(_ path: String) -> UInt64 {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let size = attrs[.size] as? NSNumber else {
            return 0
        }
        return size.uint64Value
    }

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

    private static func takeInferenceError(
        _ errorPtr: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>,
        fallback: String
    ) -> String {
        guard let pointer = errorPtr.pointee else { return fallback }
        let message = String(cString: pointer)
        c_eliza_inference_free_string(pointer)
        errorPtr.pointee = nil
        return message.isEmpty ? fallback : message
    }

    private static func wavData(from pcm: [Float], sampleRate: Int) -> Data {
        var data = Data()
        let bytesPerSample = 2
        let channelCount = 1
        let byteRate = sampleRate * channelCount * bytesPerSample
        let blockAlign = channelCount * bytesPerSample
        let dataSize = pcm.count * bytesPerSample

        data.append(contentsOf: "RIFF".utf8)
        appendLittleEndian(UInt32(36 + dataSize), to: &data)
        data.append(contentsOf: "WAVE".utf8)
        data.append(contentsOf: "fmt ".utf8)
        appendLittleEndian(UInt32(16), to: &data)
        appendLittleEndian(UInt16(1), to: &data)
        appendLittleEndian(UInt16(channelCount), to: &data)
        appendLittleEndian(UInt32(sampleRate), to: &data)
        appendLittleEndian(UInt32(byteRate), to: &data)
        appendLittleEndian(UInt16(blockAlign), to: &data)
        appendLittleEndian(UInt16(16), to: &data)
        data.append(contentsOf: "data".utf8)
        appendLittleEndian(UInt32(dataSize), to: &data)

        for sample in pcm {
            let clamped = max(-1.0, min(1.0, sample))
            let scaled = clamped < 0
                ? Int16((clamped * 32768.0).rounded())
                : Int16((clamped * 32767.0).rounded())
            appendLittleEndian(scaled, to: &data)
        }
        return data
    }

    private static func appendLittleEndian<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { bytes in
            data.append(contentsOf: bytes)
        }
    }
}

#else

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

public struct LlamaTtsSynthesizeResult {
    public let audioBase64: String
    public let audioFilePath: String?
    public let contentType: String
    public let sampleRate: Int
    public let samples: Int
    public let durationMs: Double
    public let error: String?

    public static func failure(_ msg: String) -> LlamaTtsSynthesizeResult {
        .init(
            audioBase64: "",
            audioFilePath: nil,
            contentType: "audio/wav",
            sampleRate: 24_000,
            samples: 0,
            durationMs: 0,
            error: msg
        )
    }
}

public struct LlamaAsrTranscribeResult {
    public let text: String
    public let durationMs: Double
    public let error: String?

    public static func success(text: String, durationMs: Double) -> LlamaAsrTranscribeResult {
        .init(text: text, durationMs: durationMs, error: nil)
    }

    public static func failure(_ msg: String) -> LlamaAsrTranscribeResult {
        .init(text: "", durationMs: 0, error: msg)
    }
}

public enum SpecDecodeMode {
    case auto
    case on
    case off
}

public struct LlamaHardwareInfo {
    public let backend: String
    public let totalRamGB: Double
    public let availableRamGB: Double
    public let cpuCores: Int
    public let isSimulator: Bool
    public let metalSupported: Bool
    public let mtpSupported: Bool
    public let mtpReason: String?

    public func asDict() -> [String: Any] {
        var dict: [String: Any] = [
            "backend": backend,
            "total_ram_gb": NSNumber(value: totalRamGB),
            "available_ram_gb": NSNumber(value: availableRamGB),
            "cpu_cores": NSNumber(value: cpuCores),
            "is_simulator": NSNumber(value: isSimulator),
            "metal_supported": NSNumber(value: metalSupported),
            "mtp_supported": NSNumber(value: mtpSupported)
        ]
        if let reason = mtpReason {
            dict["mtp_reason"] = reason
        }
        return dict
    }
}

public final class LlamaBridgeImpl {
    public static let shared = LlamaBridgeImpl()

    private init() {}

    private static var isRunningInSimulator: Bool {
#if targetEnvironment(simulator)
        return true
#else
        return false
#endif
    }

    public func loadModel(
        path: String,
        contextSize: UInt32 = 4096,
        useGPU: Bool = true,
        threads: Int32? = nil,
        draftModelPath: String? = nil,
        draftContextSize: UInt32 = 4096,
        draftGpuLayers: Int32? = nil,
        draftMin: Int32 = 1,
        draftMax: Int32 = 3,
        cacheTypeK: String? = nil,
        cacheTypeV: String? = nil
    ) -> LlamaLoadResult {
        return .failure("llama.cpp is not bundled in this iOS build")
    }

    public func generate(
        contextId: Int64,
        prompt: String,
        maxTokens: Int32 = 256,
        temperature: Float = 0.7,
        topP: Float = 0.95,
        topK: Int32 = 40,
        stopSequences: [String] = [],
        specDecode: SpecDecodeMode = .auto,
        draftMin: Int32? = nil,
        draftMax: Int32? = nil,
        tokenTreeTrie: Data? = nil,
        onToken: ((String, Bool) -> Void)? = nil
    ) -> LlamaGenerateResult {
        onToken?("", true)
        return .failure("llama.cpp is not bundled in this iOS build")
    }

    public func cancel(contextId: Int64) {}

    public func synthesizeSpeech(
        bundleDir: String,
        text: String,
        speakerPresetId: String? = nil,
        maxSamples: Int = 24_000 * 60
    ) -> LlamaTtsSynthesizeResult {
        return .failure("llama.cpp is not bundled in this iOS build")
    }

    public func transcribeSpeech(
        bundleDir: String,
        pcm: [Float],
        sampleRate: Int
    ) -> LlamaAsrTranscribeResult {
        return .failure("llama.cpp is not bundled in this iOS build")
    }

    public func ttsEngineDiagnostics(bundleDir: String?) -> [String: Any] {
        var payload: [String: Any] = [
            "available": false,
            "message": "llama.cpp is not bundled in this iOS build",
            "hardware": hardwareInfo().asDict(),
        ]
        if let bundleDir {
            payload["bundleDir"] = bundleDir
        }
        return payload
    }

    public func free(contextId: Int64) {}

    public func workQueue(for contextId: Int64) -> DispatchQueue? {
        return nil
    }

    public func hardwareInfo() -> LlamaHardwareInfo {
        let pi = ProcessInfo.processInfo
        let totalRAM = Double(pi.physicalMemory) / (1024.0 * 1024.0 * 1024.0)
        return LlamaHardwareInfo(
            backend: "unavailable",
            totalRamGB: totalRAM,
            availableRamGB: totalRAM,
            cpuCores: pi.activeProcessorCount,
            isSimulator: Self.isRunningInSimulator,
            metalSupported: false,
            mtpSupported: false,
            mtpReason: "llama.cpp is not bundled in this iOS build"
        )
    }
}

#endif
