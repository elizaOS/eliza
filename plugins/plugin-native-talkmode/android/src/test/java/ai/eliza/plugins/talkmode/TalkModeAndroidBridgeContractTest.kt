package ai.eliza.plugins.talkmode

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TalkModeAndroidBridgeContractTest {
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
