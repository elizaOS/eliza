package ai.eliza.plugins.swabble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class SwabbleWakeBridgeContractTest {
    private val config = SwabbleWakeBridgeContract.Config(
        triggers = listOf("eliza"),
        minPostTriggerGap = 0.45,
        minCommandLength = 3
    )

    @Test
    fun `exact wake phrase extracts command and builds bridge event payload`() {
        val match = SwabbleWakeBridgeContract.matchWakeWord(
            transcript = "hey eliza, turn on the lights",
            segments = emptyList(),
            config = config
        )

        assertNotNull(match)
        assertEquals("eliza", match!!.wakeWord)
        assertEquals("turn on the lights", match.command)
        assertEquals(0.45, match.postGap, 0.001)

        val payload = SwabbleWakeBridgeContract.wakeWordPayload(
            match = match,
            transcript = "hey eliza, turn on the lights",
            confidence = 0.92
        )
        assertEquals("eliza", payload["wakeWord"])
        assertEquals("turn on the lights", payload["command"])
        assertEquals("hey eliza, turn on the lights", payload["transcript"])
        assertEquals(0.92, payload["confidence"])
    }

    @Test
    fun `fuzzy wake phrase still fires when speech recognizer mishears trigger`() {
        val match = SwabbleWakeBridgeContract.matchWakeWord(
            transcript = "hey aliza start the timer",
            segments = listOf(
                SwabbleWakeBridgeContract.Segment("hey", 0.0, 0.2),
                SwabbleWakeBridgeContract.Segment("aliza", 0.3, 0.3),
                SwabbleWakeBridgeContract.Segment("start", 1.0, 0.3),
                SwabbleWakeBridgeContract.Segment("the", 1.4, 0.2),
                SwabbleWakeBridgeContract.Segment("timer", 1.7, 0.3)
            ),
            config = config
        )

        assertNotNull(match)
        assertEquals("start the timer", match!!.command)
        assertEquals(0.4, match.postGap, 0.001)
    }

    @Test
    fun `command shorter than minimum length does not dispatch wake event`() {
        val match = SwabbleWakeBridgeContract.matchWakeWord(
            transcript = "eliza go",
            segments = emptyList(),
            config = config.copy(minCommandLength = 3)
        )

        assertNull(match)
    }

    @Test
    fun `oversized no-space tokens skip fuzzy match`() {
        val left = "a".repeat(32_768)
        val right = "b".repeat(32_768)
        val hostile = config.copy(triggers = listOf(right))
        val match = SwabbleWakeBridgeContract.matchWakeWord(
            transcript = "$left turn on the lights",
            segments = emptyList(),
            config = hostile
        )
        assertNull(match)
    }

    @Test
    fun `fuzzy token cap accepts 64 UTF-16 units and rejects 65`() {
        val acceptedTrigger = "a".repeat(64)
        val acceptedCandidate = "a".repeat(63) + "b"
        val rejectedTrigger = "a".repeat(65)
        val rejectedCandidate = "a".repeat(64) + "b"

        assertNotNull(SwabbleWakeBridgeContract.matchWakeWord(
            transcript = "$acceptedCandidate run diagnostics",
            segments = emptyList(),
            config = config.copy(triggers = listOf(acceptedTrigger))
        ))
        assertNull(SwabbleWakeBridgeContract.matchWakeWord(
            transcript = "$rejectedCandidate run diagnostics",
            segments = emptyList(),
            config = config.copy(triggers = listOf(rejectedTrigger))
        ))
    }
}
