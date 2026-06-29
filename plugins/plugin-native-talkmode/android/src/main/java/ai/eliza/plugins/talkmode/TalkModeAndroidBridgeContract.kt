package ai.eliza.plugins.talkmode

import com.getcapacitor.JSObject

internal object TalkModeAndroidBridgeContract {
    const val FINAL_TRANSCRIPT_DEDUP_WINDOW_MS = 2000L

    fun audioFramesStartedPayload(
        sampleRate: Int,
        frameSamples: Int,
        suspendedStt: Boolean
    ): Map<String, Any?> = mapOf(
        "started" to true,
        "sampleRate" to sampleRate,
        "frameSamples" to frameSamples,
        "suspendedStt" to suspendedStt
    )

    fun transcriptPayload(transcript: String, isFinal: Boolean): Map<String, Any?> =
        mapOf("transcript" to transcript, "isFinal" to isFinal)

    fun statePayload(
        state: String,
        previousState: String,
        statusText: String,
        usingSystemTts: Boolean
    ): Map<String, Any?> = mapOf(
        "state" to state,
        "previousState" to previousState,
        "statusText" to statusText,
        "usingSystemTts" to usingSystemTts
    )

    fun permissionPayload(
        microphoneGranted: Boolean,
        speechRecognitionAvailable: Boolean
    ): Map<String, Any?> = mapOf(
        "microphone" to if (microphoneGranted) "granted" else "denied",
        "speechRecognition" to if (speechRecognitionAvailable) {
            if (microphoneGranted) "granted" else "prompt"
        } else {
            "not_supported"
        }
    )

    fun shouldDropDuplicateFinal(
        transcript: String,
        previousTranscript: String,
        nowElapsedMs: Long,
        previousElapsedMs: Long
    ): Boolean {
        val text = transcript.trim()
        return text.isNotEmpty() &&
            text == previousTranscript &&
            nowElapsedMs - previousElapsedMs < FINAL_TRANSCRIPT_DEDUP_WINDOW_MS
    }

    fun interruptedAtSeconds(
        isSpeaking: Boolean,
        nowElapsedMs: Long,
        speakStartTimeMs: Long
    ): Double? {
        if (!isSpeaking) return null
        return (nowElapsedMs - speakStartTimeMs).toDouble() / 1000.0
    }

    fun shouldInterruptSpeech(transcript: String, lastSpokenText: String?): Boolean {
        val trimmed = transcript.trim()
        val lower = trimmed.lowercase()
        val words = lower.split(Regex("\\s+")).filter { it.isNotBlank() }
        // Need real intent: at least two words, or one long word.
        if (words.size < 2 && trimmed.length < 8) return false
        val spoken = lastSpokenText?.lowercase() ?: return true
        if (spoken.contains(lower)) return false
        val echoed = words.count { spoken.contains(it) }
        return words.isEmpty() || echoed.toDouble() / words.size < 0.6
    }
}

internal fun Map<String, Any?>.toJSObject(): JSObject {
    val obj = JSObject()
    for ((key, value) in this) {
        obj.put(key, value)
    }
    return obj
}
