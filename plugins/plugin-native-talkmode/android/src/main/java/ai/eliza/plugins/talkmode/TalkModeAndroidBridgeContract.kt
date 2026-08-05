package ai.eliza.plugins.talkmode

import com.getcapacitor.JSObject
import org.json.JSONObject

internal object TalkModeAndroidBridgeContract {
    const val FINAL_TRANSCRIPT_DEDUP_WINDOW_MS = 2000L
    const val LOCAL_AGENT_SOCKET_NAME = "eliza_local_agent_v1"

    fun localAgentTtsFrame(
        requestId: String,
        token: String,
        body: JSONObject
    ): String = JSONObject().apply {
        put("id", requestId)
        put("method", "http_request")
        put("payload", JSONObject().apply {
            put("method", "POST")
            put("path", "/api/tts/local-inference")
            put("headers", JSONObject().apply {
                put("Authorization", "Bearer $token")
                put("Content-Type", "application/json")
                put("Accept", "audio/wav")
            })
            put("body", body)
        })
    }.toString()

    fun decodeLocalAgentWavResponse(
        line: String,
        decodeBase64: (String) -> ByteArray
    ): ByteArray {
        val frame = JSONObject(line)
        if (!frame.optBoolean("ok", false)) {
            throw IllegalStateException("Local agent TTS request failed")
        }
        val result = frame.optJSONObject("result")
            ?: throw IllegalStateException("Local agent TTS returned no result")
        val status = result.optInt("status", 0)
        if (status !in 200..299) {
            throw IllegalStateException("Local agent TTS error: $status")
        }
        if (result.optString("bodyEncoding") != "base64") {
            throw IllegalStateException("Local agent TTS returned an unsupported body encoding")
        }
        val bytes = decodeBase64(result.optString("bodyBase64"))
        if (bytes.isEmpty()) {
            throw IllegalStateException("Local agent TTS returned no audio")
        }
        return bytes
    }

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
