package ai.eliza.plugins.talkmode

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64
import org.json.JSONObject

class TalkModeAndroidBridgeContractTest {
    @Test
    fun `local TTS request uses the port-free agent IPC contract`() {
        val frame = JSONObject(
            TalkModeAndroidBridgeContract.localAgentTtsFrame(
                requestId = "tts-1",
                token = "secret-token",
                body = JSONObject().put("text", "hello")
            )
        )
        assertEquals("http_request", frame.getString("method"))
        val payload = frame.getJSONObject("payload")
        assertEquals("POST", payload.getString("method"))
        assertEquals("/api/tts/local-inference", payload.getString("path"))
        assertEquals(
            "Bearer secret-token",
            payload.getJSONObject("headers").getString("Authorization")
        )
        assertEquals("hello", payload.getJSONObject("body").getString("text"))
    }

    @Test
    fun `local TTS response decodes exact WAV bytes and rejects failures`() {
        val wav = byteArrayOf(82, 73, 70, 70)
        val success = JSONObject().apply {
            put("ok", true)
            put("result", JSONObject().apply {
                put("status", 200)
                put("bodyEncoding", "base64")
                put("bodyBase64", Base64.getEncoder().encodeToString(wav))
            })
        }
        assertTrue(
            TalkModeAndroidBridgeContract.decodeLocalAgentWavResponse(
                success.toString(),
                Base64.getDecoder()::decode
            ).contentEquals(wav)
        )

        val failure = JSONObject().put("ok", true).put(
            "result",
            JSONObject().put("status", 503).put("bodyEncoding", "base64")
        )
        try {
            TalkModeAndroidBridgeContract.decodeLocalAgentWavResponse(
                failure.toString(),
                Base64.getDecoder()::decode
            )
            throw AssertionError("expected a provider failure")
        } catch (error: IllegalStateException) {
            assertTrue(error.message?.contains("503") == true)
        }
    }

    @Test
    fun `audio frame capture start payload preserves lifecycle fields`() {
        val payload = TalkModeAndroidBridgeContract.audioFramesStartedPayload(
            sampleRate = 16000,
            frameSamples = 320,
            suspendedStt = true
        )

        assertEquals(true, payload["started"])
        assertEquals(16000, payload["sampleRate"])
        assertEquals(320, payload["frameSamples"])
        assertEquals(true, payload["suspendedStt"])
    }

    @Test
    fun `transcript bridge payload distinguishes interim and final turns`() {
        assertEquals(
            mapOf("transcript" to " hello eliza ", "isFinal" to false),
            TalkModeAndroidBridgeContract.transcriptPayload(" hello eliza ", false)
        )
        assertEquals(
            mapOf("transcript" to "hello eliza", "isFinal" to true),
            TalkModeAndroidBridgeContract.transcriptPayload("hello eliza", true)
        )
    }

    @Test
    fun `duplicate final transcript is suppressed only inside the debounce window`() {
        assertTrue(
            TalkModeAndroidBridgeContract.shouldDropDuplicateFinal(
                transcript = "hello eliza",
                previousTranscript = "hello eliza",
                nowElapsedMs = 11_000,
                previousElapsedMs = 10_000
            )
        )
        assertFalse(
            TalkModeAndroidBridgeContract.shouldDropDuplicateFinal(
                transcript = "hello eliza",
                previousTranscript = "hello eliza",
                nowElapsedMs = 13_000,
                previousElapsedMs = 10_000
            )
        )
    }

    @Test
    fun `barge in ignores one word blips and self echo but accepts user speech`() {
        assertFalse(
            TalkModeAndroidBridgeContract.shouldInterruptSpeech(
                transcript = "ok",
                lastSpokenText = "The answer is coming now"
            )
        )
        assertFalse(
            TalkModeAndroidBridgeContract.shouldInterruptSpeech(
                transcript = "The answer is coming",
                lastSpokenText = "The answer is coming now"
            )
        )
        assertTrue(
            TalkModeAndroidBridgeContract.shouldInterruptSpeech(
                transcript = "stop talking",
                lastSpokenText = "The answer is coming now"
            )
        )
    }

    @Test
    fun `permission payload exposes speech recognition availability separately`() {
        assertEquals(
            mapOf("microphone" to "denied", "speechRecognition" to "prompt"),
            TalkModeAndroidBridgeContract.permissionPayload(
                microphoneGranted = false,
                speechRecognitionAvailable = true
            )
        )
        assertEquals(
            mapOf("microphone" to "granted", "speechRecognition" to "not_supported"),
            TalkModeAndroidBridgeContract.permissionPayload(
                microphoneGranted = true,
                speechRecognitionAvailable = false
            )
        )
    }
}
