package ai.eliza.plugins.screencapture

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for `@elizaos/capacitor-screencapture`'s recording
 * config resolution (#9967) — the quality-preset → fps/bitrate mapping a mocked
 * Chromium bridge never exercised. Runs the real [RecordingConfigResolver] on the
 * device runtime; no live MediaProjection session needed.
 */
@RunWith(AndroidJUnit4::class)
class RecordingConfigResolverInstrumentedTest {

    private val w = 1920
    private val h = 1080

    @Test
    fun estimateBitrate_clampsToOneToTwelveMbps() {
        assertEquals("tiny clamps to 1 Mbps floor", 1_000_000, RecordingConfigResolver.estimateBitrate(10, 10, 1))
        assertEquals("4K60 clamps to 12 Mbps ceiling", 12_000_000, RecordingConfigResolver.estimateBitrate(3840, 2160, 60))
        assertEquals("mid-range is the exact estimate", 320L * 240 * 30 * 2, RecordingConfigResolver.estimateBitrate(320, 240, 30).toLong())
    }

    @Test
    fun resolve_lowPresetIs15fpsAtHalfTheEstimate() {
        val c = RecordingConfigResolver.resolve("low", null, null, null, null, false, false, w, h)
        assertEquals(15, c.fps)
        assertEquals(RecordingConfigResolver.estimateBitrate(w, h, 15) / 2, c.bitrate)
    }

    @Test
    fun resolve_highestPresetIs60fpsAtDoubleTheEstimate() {
        val c = RecordingConfigResolver.resolve("highest", null, null, null, null, false, false, w, h)
        assertEquals(60, c.fps)
        assertEquals(RecordingConfigResolver.estimateBitrate(w, h, 60) * 2, c.bitrate)
    }

    @Test
    fun resolve_mediumHighUnknownLeaveBitrateForDownstreamEstimate() {
        val medium = RecordingConfigResolver.resolve("medium", null, null, null, null, false, false, w, h)
        assertEquals(24, medium.fps)
        assertNull(medium.bitrate)
        assertEquals(30, RecordingConfigResolver.resolve("high", null, null, null, null, false, false, w, h).fps)
        val unknown = RecordingConfigResolver.resolve("banana", null, null, null, null, false, false, w, h)
        assertEquals("unknown quality defaults to 30 fps", 30, unknown.fps)
        assertNull(unknown.bitrate)
    }

    @Test
    fun resolve_explicitOverridesWinAndFpsClampsTo1To60() {
        assertEquals("fps above 60 clamps down", 60, RecordingConfigResolver.resolve("low", 120, null, null, null, false, false, w, h).fps)
        assertEquals("fps below 1 clamps up", 1, RecordingConfigResolver.resolve("low", 0, null, null, null, false, false, w, h).fps)
        assertEquals("explicit bitrate beats the preset", 5_000_000, RecordingConfigResolver.resolve("low", null, 5_000_000, null, null, false, false, w, h).bitrate)
    }

    @Test
    fun resolve_passesThroughDurationFileSizeAndAudioFlags() {
        val c = RecordingConfigResolver.resolve("high", null, null, 30.0, 1_000L, true, true, w, h)
        assertEquals(30.0, c.maxDuration!!, 1e-9)
        assertEquals(1_000L, c.maxFileSize)
        assertTrue(c.captureMicrophone)
        assertTrue(c.captureSystemAudio)
        assertEquals("high", c.quality)
    }
}
