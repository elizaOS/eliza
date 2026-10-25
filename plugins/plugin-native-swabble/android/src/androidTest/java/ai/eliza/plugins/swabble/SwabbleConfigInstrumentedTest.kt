package ai.eliza.plugins.swabble

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for the Swabble wake-word config (#9967).
 *
 * Drives `SwabblePlugin.SwabbleConfig.fromJSObject` / `toJSObject` against the
 * device's real `JSObject` runtime — the config that decides the wake triggers,
 * the post-trigger gap, and the audio sample rate. A mocked Capacitor bridge in
 * Chromium never exercised this parsing/defaulting.
 */
@RunWith(AndroidJUnit4::class)
class SwabbleConfigInstrumentedTest {

    @Test
    fun fromJSObject_appliesDefaultsForEveryMissingField() {
        val cfg = SwabblePlugin.SwabbleConfig.fromJSObject(JSObject())
        assertEquals("default trigger is 'eliza'", listOf("eliza"), cfg.triggers)
        assertEquals(0.45, cfg.minPostTriggerGap, 1e-9)
        assertEquals(1, cfg.minCommandLength)
        assertEquals(16000, cfg.sampleRate)
        assertTrue("locale defaults to the device locale", cfg.locale.isNotEmpty())
    }

    @Test
    fun fromJSObject_readsEveryProvidedField() {
        val obj = JSObject().apply {
            put("triggers", JSArray(listOf("hey", "yo")))
            put("minPostTriggerGap", 0.9)
            put("minCommandLength", 3)
            put("locale", "fr-FR")
            put("sampleRate", 48000)
        }
        val cfg = SwabblePlugin.SwabbleConfig.fromJSObject(obj)
        assertEquals(listOf("hey", "yo"), cfg.triggers)
        assertEquals(0.9, cfg.minPostTriggerGap, 1e-9)
        assertEquals(3, cfg.minCommandLength)
        assertEquals("fr-FR", cfg.locale)
        assertEquals(48000, cfg.sampleRate)
    }

    @Test
    fun toJSObject_roundTripsBackThroughFromJSObject() {
        val source = JSObject().apply {
            put("triggers", JSArray(listOf("alpha")))
            put("minPostTriggerGap", 0.6)
            put("minCommandLength", 2)
            put("locale", "en-US")
            put("sampleRate", 22050)
        }
        val cfg = SwabblePlugin.SwabbleConfig.fromJSObject(source)
        val roundTripped = SwabblePlugin.SwabbleConfig.fromJSObject(cfg.toJSObject())
        assertEquals(cfg, roundTripped)
    }

    @Test
    fun speechSegment_endIsStartPlusDuration() {
        val segment = SwabblePlugin.SpeechSegment("hello", 1.5, 2.0)
        assertEquals(3.5, segment.end, 1e-9)
    }
}
