import Capacitor
import Foundation

// MARK: - llama.cpp bridge
//
// This plugin wraps llama.cpp as an iOS `xcframework`. The framework is NOT
// committed to the repo — see README.md for the build-from-source steps.
// Until the framework is dropped into `ios/Frameworks/llama.xcframework`,
// every method returns an "unavailable" error so the JS layer falls back
// to the server-side engine without crashing.
//
// The bridge itself is intentionally a thin shim: it owns a single
// `llama_context` per plugin instance, serialises generate calls, and
// fans token streams out as Capacitor notifications.

// swiftlint:disable file_length

@objc(LlamaPlugin)
public class LlamaPlugin: CAPPlugin {
    public static let identifier = "LlamaPlugin"
    public static let jsName = "Llama"

    public override class func pluginMethods() -> [CAPPluginMethod] {
        [
            CAPPluginMethod(name: "getHardwareInfo", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "isLoaded", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "loadModel", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "unloadModel", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
            CAPPluginMethod(name: "cancelGenerate", returnType: CAPPluginReturnPromise),
        ]
    }

    // MARK: - State

    /// Serialised queue so generate calls don't interleave on the native side.
    private let inferenceQueue = DispatchQueue(
        label: "ai.eliza.llama.inference",
        qos: .userInitiated
    )

    private var loadedModelPath: String?
    private var cancelRequested = false

    // MARK: - Hardware probing

    @objc func getHardwareInfo(_ call: CAPPluginCall) {
        let device = UIDevice.current
        let physicalMemory = ProcessInfo.processInfo.physicalMemory
        let ramGb = Double(physicalMemory) / 1_073_741_824.0
        let cpuCores = ProcessInfo.processInfo.activeProcessorCount

        call.resolve([
            "platform": "ios",
            "deviceModel": device.model,
            "totalRamGb": ramGb,
            "availableRamGb": NSNull(),
            "gpu": [
                "backend": "metal",
                "available": true,
            ],
            "cpuCores": cpuCores,
            "gpuSupported": Self.llamaBackendAvailable,
        ])
    }

    // MARK: - Load / unload

    @objc func isLoaded(_ call: CAPPluginCall) {
        call.resolve([
            "loaded": loadedModelPath != nil,
            "modelPath": loadedModelPath ?? NSNull(),
        ])
    }

    @objc func loadModel(_ call: CAPPluginCall) {
        guard Self.llamaBackendAvailable else {
            call.reject(Self.unavailableMessage)
            return
        }
        guard let modelPath = call.getString("modelPath"), !modelPath.isEmpty else {
            call.reject("modelPath is required")
            return
        }

        let contextSize = call.getInt("contextSize") ?? 4096
        let useGpu = call.getBool("useGpu") ?? true

        inferenceQueue.async { [weak self] in
            guard let self = self else { return }
            // TODO(llama.cpp): when `llama.xcframework` is integrated:
            //   1. `llama_backend_init()` once at plugin init
            //   2. `llama_model_params = llama_model_default_params()`
            //      with `n_gpu_layers = useGpu ? Int32.max : 0`
            //   3. `llama_load_model_from_file(path, params)`
            //   4. `llama_context_params.n_ctx = contextSize`
            //   5. `llama_new_context_with_model(model, ctxParams)`
            // For now, store the path and resolve so higher-level coordination
            // flows can be tested on the JS side end-to-end.
            self.loadedModelPath = modelPath
            DispatchQueue.main.async {
                call.resolve()
            }
            _ = contextSize
            _ = useGpu
        }
    }

    @objc func unloadModel(_ call: CAPPluginCall) {
        inferenceQueue.async { [weak self] in
            guard let self = self else { return }
            // TODO(llama.cpp): dispose context + model:
            //   llama_free(ctx); llama_free_model(model);
            self.loadedModelPath = nil
            DispatchQueue.main.async {
                call.resolve()
            }
        }
    }

    // MARK: - Generate

    @objc func generate(_ call: CAPPluginCall) {
        guard Self.llamaBackendAvailable else {
            call.reject(Self.unavailableMessage)
            return
        }
        guard loadedModelPath != nil else {
            call.reject("No model loaded. Call loadModel first.")
            return
        }
        guard let prompt = call.getString("prompt") else {
            call.reject("prompt is required")
            return
        }

        let maxTokens = call.getInt("maxTokens") ?? 512
        let temperature = call.getFloat("temperature") ?? 0.7
        let topP = call.getFloat("topP") ?? 0.9
        let stream = call.getBool("stream") ?? false
        let stopSequences = call.getArray("stopSequences", String.self) ?? []

        cancelRequested = false
        let startedAt = Date()
        let owner = self

        inferenceQueue.async {
            // TODO(llama.cpp): the real implementation:
            //   1. Tokenise prompt via `llama_tokenize`
            //   2. Feed tokens into the decoder via `llama_decode` batches
            //   3. On each new token, apply sampling (temperature, top_p)
            //      via `llama_sampler_chain_add`
            //   4. If `stream`, notify listeners via `notifyListeners("token", ...)`
            //   5. Check `cancelRequested` between tokens for abort support
            //   6. Honour stopSequences by scanning the cumulative string
            //
            // Until the framework is in place we surface a deterministic
            // placeholder so the higher UI can still be exercised in
            // development builds.
            let placeholder = "[llama.cpp not yet compiled for this build]"

            DispatchQueue.main.async {
                let duration = Int(Date().timeIntervalSince(startedAt) * 1000)
                let result: [String: Any] = [
                    "text": stream ? "" : placeholder,
                    "promptTokens": prompt.count / 4,
                    "outputTokens": placeholder.count / 4,
                    "durationMs": duration,
                ]
                if stream {
                    owner.notifyListeners("generationComplete", data: result)
                }
                call.resolve(result)
            }
            _ = maxTokens
            _ = temperature
            _ = topP
            _ = stopSequences
        }
    }

    @objc func cancelGenerate(_ call: CAPPluginCall) {
        cancelRequested = true
        call.resolve()
    }

    // MARK: - Backend availability

    /// Flips to true once `llama.xcframework` is linked and
    /// `llama_backend_init()` succeeds. See README for build steps.
    private static let llamaBackendAvailable = false
    private static let unavailableMessage =
        "llama.cpp framework is not compiled into this build. See @elizaos/capacitor-llama/README.md for build instructions."
}
