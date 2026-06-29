import Foundation

enum TalkModeBridgeContract {
    static func transcriptPayload(transcript: String, isFinal: Bool) -> [String: Any] {
        [
            "transcript": transcript,
            "isFinal": isFinal,
        ]
    }

    static func statePayload(
        state: String,
        previousState: String,
        statusText: String,
        usingSystemTts: Bool
    ) -> [String: Any] {
        [
            "state": state,
            "previousState": previousState,
            "statusText": statusText,
            "usingSystemTts": usingSystemTts,
        ]
    }

    static func permissionPayload(microphone: String, speechRecognition: String) -> [String: Any] {
        [
            "microphone": microphone,
            "speechRecognition": speechRecognition,
        ]
    }

    static func shouldInterruptSpeech(transcript: String, lastSpokenText: String?) -> Bool {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { return false }

        if let spoken = lastSpokenText?.lowercased() {
            let probe = trimmed.lowercased()
            if spoken.contains(probe) { return false }
        }

        return true
    }
}
