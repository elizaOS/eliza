// llama-bridge-smoke-main.swift — manual smoke test for LlamaBridgeImpl.
//
// This is NOT a unit test — it's a top-level Swift script for sanity-checking
// the real backend (`LlamaBridgeImpl`) against a real GGUF model. Run after
// `build-ios.sh` produces `LlamaCpp.xcframework` and `download-first-light.sh`
// places a model on disk.
//
// The smoke does NOT exercise the JS bridge surface — that's `LlamaBridge.swift`'s
// job. Here we just confirm that the C-API bindings, sampler chain, and decode
// loop produce coherent text.
//
// Usage on an iOS device (the only platform where this can actually run,
// since the static lib targets iOS device or simulator, not macOS):
//
//   1. Add this file + LlamaBridgeImpl.swift to an iOS test target inside
//      Xcode. Set the target's "Other Linker Flags" to include the path to
//      LlamaCpp.xcframework (or list it under Frameworks/Libraries).
//
//   2. Run as a unit test, or as the main entry point of an iOS test app.
//
//   3. Pass the model path via Info.plist (LlamaSmokeModelPath) or hardcode
//      it for a quick manual run.
//
// Expected output:
//   [smoke] Hardware: backend=metal, total_ram=8.0 GB, metal_supported=true
//   [smoke] Loading model …
//   [smoke] context_id=1
//   [smoke] Generating …
//   [smoke] >>> Hello! I'm an AI assistant. How can I help you today?
//   [smoke] Generated 16 tokens in 234 ms.

import Foundation

@main
struct LlamaSmoke {
    static func main() {
        guard CommandLine.arguments.count >= 2 else {
            FileHandle.standardError.write(Data("usage: llama-bridge-smoke <model.gguf>\n".utf8))
            exit(2)
        }
        let modelPath = CommandLine.arguments[1]

        let impl = LlamaBridgeImpl.shared

        // 1. Hardware probe.
        let hw = impl.hardwareInfo()
        print("[smoke] Hardware: backend=\(hw.backend), total_ram=\(String(format: "%.2f", hw.totalRamGB)) GB, metal_supported=\(hw.metalSupported), simulator=\(hw.isSimulator)")

        // 2. Load model.
        print("[smoke] Loading model from \(modelPath) …")
        let loadResult = impl.loadModel(
            path: modelPath,
            contextSize: 2048,
            useGPU: true
        )
        guard let contextId = loadResult.contextId else {
            FileHandle.standardError.write(Data("[smoke] load failed: \(loadResult.error ?? "unknown")\n".utf8))
            exit(3)
        }
        print("[smoke] context_id=\(contextId)")

        // 3. Generate (streaming).
        print("[smoke] Generating …")
        print("[smoke] >>> ", terminator: "")
        fflush(stdout)
        let genResult = impl.generate(
            contextId: contextId,
            prompt: "<|im_start|>user\nSay hello in one short sentence.<|im_end|>\n<|im_start|>assistant\n",
            maxTokens: 64,
            temperature: 0.7,
            topP: 0.9,
            stopSequences: ["<|im_end|>"],
            onToken: { tok, last in
                if !last {
                    print(tok, terminator: "")
                    fflush(stdout)
                }
            }
        )
        print()  // newline after streamed tokens

        if let err = genResult.error {
            FileHandle.standardError.write(Data("[smoke] generate failed: \(err)\n".utf8))
        } else {
            print("[smoke] Generated \(genResult.outputTokens) tokens in \(String(format: "%.0f", genResult.durationMs)) ms (prompt was \(genResult.promptTokens) tokens).")
        }

        // 4. Free.
        impl.free(contextId: contextId)
        print("[smoke] Freed context \(contextId). Done.")
    }
}
