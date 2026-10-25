import CoreML
import Foundation

@available(iOS 18.0, *)
final class KokoroCoreMlEngine {
    static let shared = KokoroCoreMlEngine()

    private struct LoadedModel {
        let directory: URL
        let config: KokoroConfig
        let network: KokoroNetwork
        let phonemizer: KokoroPhonemizer
        let voiceEmbeddings: [String: [Float]]
    }

    private let queue = DispatchQueue(label: "ai.eliza.kokoro.coreml")
    private var loaded: LoadedModel?

    private init() {}

    func synthesize(
        modelDirectory: URL,
        text: String,
        voice: String?,
        maxSamples: Int
    ) throws -> (samples: [Float], sampleRate: Int, durationMs: Double, voice: String) {
        try queue.sync {
            let start = DispatchTime.now()
            let model = try loadModel(at: modelDirectory)
            let selectedVoice = resolveVoice(voice, available: model.voiceEmbeddings)
            guard let styleVector = model.voiceEmbeddings[selectedVoice] else {
                throw AudioModelError.voiceNotFound(
                    voice: selectedVoice,
                    searchPath: "Available: \(Array(model.voiceEmbeddings.keys).sorted().prefix(8).joined(separator: ", "))"
                )
            }

            let chunks = chunkText(
                text,
                phonemizer: model.phonemizer,
                maxTokenCount: min(96, model.config.maxPhonemeLength - 4),
                language: language(for: selectedVoice)
            )
            var samples: [Float] = []
            samples.reserveCapacity(min(maxSamples, 24_000 * max(1, chunks.count * 2)))
            for (index, chunk) in chunks.enumerated() {
                let chunkSamples = try synthesizeChunk(
                    model: model,
                    text: chunk,
                    language: language(for: selectedVoice),
                    styleVector: styleVector,
                    maxSamples: maxSamples - samples.count
                )
                samples.append(contentsOf: chunkSamples)
                if index < chunks.count - 1, samples.count < maxSamples {
                    samples.append(contentsOf: Array(repeating: 0, count: min(2_400, maxSamples - samples.count)))
                }
                if samples.count >= maxSamples { break }
            }
            guard !samples.isEmpty else {
                throw AudioModelError.inferenceFailed(operation: "kokoro-coreml", reason: "model returned empty audio")
            }
            conditionAudio(&samples, sampleRate: model.config.sampleRate, maxSamples: maxSamples)
            let elapsedNs = DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds
            return (
                samples,
                model.config.sampleRate,
                Double(elapsedNs) / 1_000_000.0,
                selectedVoice
            )
        }
    }

    private func synthesizeChunk(
        model: LoadedModel,
        text: String,
        language: String,
        styleVector: [Float],
        maxSamples: Int
    ) throws -> [Float] {
        let tokenIds = model.phonemizer.tokenize(
            text,
            maxLength: model.config.maxPhonemeLength,
            language: language
        )
        let tokenCount = min(tokenIds.count, model.config.maxPhonemeLength)
        let paddedIds = model.phonemizer.pad(Array(tokenIds.prefix(model.config.maxPhonemeLength)), to: model.config.maxPhonemeLength)
        let inputIds = try createInt32Array(shape: [1, model.config.maxPhonemeLength], values: paddedIds.map { Int32($0) })
        let mask = try createInt32Array(shape: [1, model.config.maxPhonemeLength], values: (0..<model.config.maxPhonemeLength).map { Int32($0 < tokenCount ? 1 : 0) })
        let refS = try createFloatArray(shape: [1, model.config.styleDim], values: styleVector)
        let speed = try createFloatArray(shape: [1], values: [1.0])
        let output = try model.network.predictE2E(
            inputIds: inputIds,
            attentionMask: mask,
            refS: refS,
            speed: speed
        )
        let validSamples = min(output.audioLengthSamples, output.audio.count, maxSamples)
        guard validSamples > 0 else {
            throw AudioModelError.inferenceFailed(operation: "kokoro-coreml", reason: "model returned empty audio")
        }
        var samples = [Float](repeating: 0, count: validSamples)
        if #available(iOS 16.0, *), output.audio.dataType == .float16 {
            let ptr = output.audio.dataPointer.bindMemory(to: Float16.self, capacity: validSamples)
            for index in 0..<validSamples { samples[index] = Float(ptr[index]) }
        } else {
            let ptr = output.audio.dataPointer.bindMemory(to: Float.self, capacity: validSamples)
            for index in 0..<validSamples { samples[index] = ptr[index] }
        }
        return samples
    }

    private func chunkText(
        _ text: String,
        phonemizer: KokoroPhonemizer,
        maxTokenCount: Int,
        language: String
    ) -> [String] {
        let normalized = text
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "’", with: "'")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return [] }
        if tokenCount(normalized, phonemizer: phonemizer, language: language) <= maxTokenCount {
            return [normalized]
        }
        var segments: [String] = []
        var current = ""
        for char in normalized {
            current.append(char)
            if ".!?,;:".contains(char) {
                let part = current.trimmingCharacters(in: .whitespacesAndNewlines)
                if !part.isEmpty { segments.append(part) }
                current = ""
            }
        }
        let tail = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty { segments.append(tail) }
        var chunks: [String] = []
        for segment in segments {
            appendChunk(segment, to: &chunks, phonemizer: phonemizer, maxTokenCount: maxTokenCount, language: language)
        }
        return chunks.isEmpty ? [normalized] : chunks
    }

    private func appendChunk(
        _ segment: String,
        to chunks: inout [String],
        phonemizer: KokoroPhonemizer,
        maxTokenCount: Int,
        language: String
    ) {
        if tokenCount(segment, phonemizer: phonemizer, language: language) <= maxTokenCount {
            chunks.append(segment)
            return
        }
        var current = ""
        for word in segment.split(separator: " ") {
            let candidate = current.isEmpty ? String(word) : "\(current) \(word)"
            if tokenCount(candidate, phonemizer: phonemizer, language: language) <= maxTokenCount || current.isEmpty {
                current = candidate
            } else {
                chunks.append(current)
                current = String(word)
            }
        }
        if !current.isEmpty { chunks.append(current) }
    }

    private func tokenCount(_ text: String, phonemizer: KokoroPhonemizer, language: String) -> Int {
        phonemizer.tokenize(text, maxLength: 4_096, language: language).count
    }

    func diagnostics(modelDirectory: URL?) -> [String: Any] {
        var payload: [String: Any] = [
            "available": false,
            "loaded": loaded != nil,
            "requiresIos": "18.0",
        ]
        guard let modelDirectory else { return payload }
        payload["directory"] = modelDirectory.path
        payload["files"] = [
            "model": describeFile(modelDirectory.appendingPathComponent("kokoro_5s.mlmodelc", isDirectory: true)),
            "g2pEncoder": describeFile(modelDirectory.appendingPathComponent("G2PEncoder.mlmodelc", isDirectory: true)),
            "g2pDecoder": describeFile(modelDirectory.appendingPathComponent("G2PDecoder.mlmodelc", isDirectory: true)),
            "vocab": describeFile(modelDirectory.appendingPathComponent("vocab_index.json")),
            "voice": describeFile(modelDirectory.appendingPathComponent("voices/af_heart.json")),
        ]
        payload["available"] = Self.hasRequiredAssets(in: modelDirectory)
        if let loaded, loaded.directory.path == modelDirectory.path {
            payload["loadedVoiceCount"] = loaded.voiceEmbeddings.count
        }
        return payload
    }

    static func modelDirectory(in bundleDir: String) -> URL? {
        let dir = URL(fileURLWithPath: bundleDir, isDirectory: true)
            .appendingPathComponent("tts", isDirectory: true)
            .appendingPathComponent("kokoro-coreml", isDirectory: true)
        return hasRequiredAssets(in: dir) ? dir : nil
    }

    static func hasRequiredAssets(in directory: URL) -> Bool {
        let fm = FileManager.default
        let required = [
            directory.appendingPathComponent("kokoro_5s.mlmodelc", isDirectory: true),
            directory.appendingPathComponent("vocab_index.json"),
            directory.appendingPathComponent("voices/af_heart.json"),
        ]
        return required.allSatisfy { fm.fileExists(atPath: $0.path) }
    }

    private func loadModel(at directory: URL) throws -> LoadedModel {
        if let loaded, loaded.directory.path == directory.path {
            return loaded
        }
        guard Self.hasRequiredAssets(in: directory) else {
            throw AudioModelError.modelLoadFailed(modelId: "kokoro-coreml", reason: "missing required CoreML Kokoro assets under \(directory.path)")
        }
        let config = KokoroConfig.default
        let phonemizer = try KokoroPhonemizer.loadVocab(from: directory.appendingPathComponent("vocab_index.json"))
        try phonemizer.loadDictionaries(from: directory)
        let encoder = directory.appendingPathComponent("G2PEncoder.mlmodelc", isDirectory: true)
        let decoder = directory.appendingPathComponent("G2PDecoder.mlmodelc", isDirectory: true)
        let g2pVocab = directory.appendingPathComponent("g2p_vocab.json")
        if FileManager.default.fileExists(atPath: encoder.path),
           FileManager.default.fileExists(atPath: decoder.path),
           FileManager.default.fileExists(atPath: g2pVocab.path) {
            try phonemizer.loadG2PModels(encoderURL: encoder, decoderURL: decoder, vocabURL: g2pVocab)
        }
        let voiceEmbeddings = try loadVoiceEmbeddings(from: directory.appendingPathComponent("voices", isDirectory: true), styleDim: config.styleDim)
        guard !voiceEmbeddings.isEmpty else {
            throw AudioModelError.modelLoadFailed(modelId: "kokoro-coreml", reason: "no Kokoro voice embeddings found")
        }
        let network = try KokoroNetwork(directory: directory, computeUnits: .all)
        let loaded = LoadedModel(
            directory: directory,
            config: config,
            network: network,
            phonemizer: phonemizer,
            voiceEmbeddings: voiceEmbeddings
        )
        self.loaded = loaded
        AudioLog.modelLoading.info("Kokoro CoreML loaded voices=\(voiceEmbeddings.count) directory=\(directory.path)")
        return loaded
    }

    private func loadVoiceEmbeddings(from directory: URL, styleDim: Int) throws -> [String: [Float]] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [:] }
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        var embeddings: [String: [Float]] = [:]
        for file in files where file.pathExtension.lowercased() == "json" {
            let data = try Data(contentsOf: file)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let embedding = json["embedding"] as? [Double] else {
                continue
            }
            embeddings[file.deletingPathExtension().lastPathComponent] = embedding.prefix(styleDim).map(Float.init)
        }
        return embeddings
    }

    private func resolveVoice(_ requested: String?, available: [String: [Float]]) -> String {
        let candidate = requested?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let candidate, !candidate.isEmpty, available[candidate] != nil {
            return candidate
        }
        if available["af_heart"] != nil { return "af_heart" }
        if available["af_bella"] != nil { return "af_bella" }
        return available.keys.sorted().first ?? "af_heart"
    }

    private func language(for voice: String) -> String {
        if voice.hasPrefix("jf_") || voice.hasPrefix("jm_") { return "ja" }
        if voice.hasPrefix("zf_") || voice.hasPrefix("zm_") { return "zh" }
        if voice.hasPrefix("hf_") || voice.hasPrefix("hm_") { return "hi" }
        if voice.hasPrefix("ff_") { return "fr" }
        if voice.hasPrefix("ef_") || voice.hasPrefix("em_") { return "es" }
        if voice.hasPrefix("pf_") || voice.hasPrefix("pm_") { return "pt" }
        if voice.hasPrefix("if_") || voice.hasPrefix("im_") { return "it" }
        return "en"
    }

    private func createInt32Array(shape: [Int], values: [Int32]) throws -> MLMultiArray {
        let arr = try MLMultiArray(shape: shape.map { NSNumber(value: $0) }, dataType: .int32)
        let ptr = arr.dataPointer.assumingMemoryBound(to: Int32.self)
        for index in 0..<values.count { ptr[index] = values[index] }
        return arr
    }

    private func createFloatArray(shape: [Int], values: [Float]) throws -> MLMultiArray {
        let arr = try MLMultiArray(shape: shape.map { NSNumber(value: $0) }, dataType: .float32)
        let ptr = arr.dataPointer.assumingMemoryBound(to: Float.self)
        for index in 0..<values.count { ptr[index] = values[index] }
        return arr
    }

    private func conditionAudio(_ samples: inout [Float], sampleRate: Int, maxSamples: Int) {
        guard !samples.isEmpty else { return }
        for index in samples.indices {
            if !samples[index].isFinite { samples[index] = 0 }
        }
        let trailingSilence = min(Int(0.250 * Double(sampleRate)), max(0, maxSamples - samples.count))
        if trailingSilence > 0 {
            samples.append(contentsOf: repeatElement(Float(0), count: trailingSilence))
        }
        if samples.count > maxSamples {
            samples = Array(samples.prefix(maxSamples))
        }
    }

    private func describeFile(_ url: URL) -> [String: Any] {
        let fm = FileManager.default
        var payload: [String: Any] = [
            "path": url.path,
            "exists": fm.fileExists(atPath: url.path),
            "readable": fm.isReadableFile(atPath: url.path),
        ]
        if let attrs = try? fm.attributesOfItem(atPath: url.path),
           let size = attrs[.size] as? NSNumber {
            payload["bytes"] = size
        }
        return payload
    }
}
