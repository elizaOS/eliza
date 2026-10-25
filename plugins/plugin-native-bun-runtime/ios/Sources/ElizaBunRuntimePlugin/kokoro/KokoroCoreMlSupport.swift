import Foundation
import os

enum AudioModelError: LocalizedError {
    case modelLoadFailed(modelId: String, reason: String)
    case inferenceFailed(operation: String, reason: String)
    case voiceNotFound(voice: String, searchPath: String)

    var errorDescription: String? {
        switch self {
        case let .modelLoadFailed(modelId, reason):
            return "Kokoro CoreML model load failed for \(modelId): \(reason)"
        case let .inferenceFailed(operation, reason):
            return "Kokoro CoreML inference failed during \(operation): \(reason)"
        case let .voiceNotFound(voice, searchPath):
            return "Kokoro CoreML voice not found: \(voice). \(searchPath)"
        }
    }
}

enum AudioLog {
    static let inference = Logger(subsystem: "ai.eliza.ios", category: "KokoroCoreMLInference")
    static let modelLoading = Logger(subsystem: "ai.eliza.ios", category: "KokoroCoreMLModelLoading")
}
