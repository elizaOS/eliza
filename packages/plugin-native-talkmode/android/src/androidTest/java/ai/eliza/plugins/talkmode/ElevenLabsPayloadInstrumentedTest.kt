package ai.eliza.plugins.talkmode

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device instrumented test for the ElevenLabs TTS request wire format (#9967).
 *
 * The HTTP body + Accept header are hand-rolled strings; this runs them on the
 * device's real JSON runtime ([JSONObject]) to prove the payload is well-formed,
 * escapes correctly, and nests `voice_settings` exactly as the ElevenLabs API
 * expects — logic a mocked Capacitor bridge in Chromium never exercised.
 */
@RunWith(AndroidJUnit4::class)
class ElevenLabsPayloadInstrumentedTest {

    private fun req(
        text: String = "t",
        modelId: String? = null,
        outputFormat: String? = null,
        speed: Double? = null,
        stability: Double? = null,
        similarity: Double? = null,
        style: Double? = null,
        speakerBoost: Boolean? = null,
        seed: Long? = null,
        normalize: String? = null,
        language: String? = null,
    ) = ElevenLabsRequest(text, modelId, outputFormat, speed, stability, similarity, style, speakerBoost, seed, normalize, language, null)

    @Test
    fun resolveAcceptHeader_pcmGetsPcmEverythingElseMpeg() {
        assertEquals("audio/pcm", ElevenLabsPayload.resolveAcceptHeader("pcm_16000"))
        assertEquals("case-insensitive", "audio/pcm", ElevenLabsPayload.resolveAcceptHeader("  PCM_24000  "))
        assertEquals("audio/mpeg", ElevenLabsPayload.resolveAcceptHeader("mp3_44100_128"))
        assertEquals("audio/mpeg", ElevenLabsPayload.resolveAcceptHeader(null))
        assertEquals("audio/mpeg", ElevenLabsPayload.resolveAcceptHeader(""))
    }

    @Test
    fun buildRequestPayload_minimalRequestIsJustText() {
        assertEquals("""{"text":"hi"}""", ElevenLabsPayload.buildRequestPayload(req(text = "hi")))
    }

    @Test
    fun buildRequestPayload_escapingRoundTripsThroughTheJsonParser() {
        val text = "say \"hi\"\n\tbye\\"
        val json = ElevenLabsPayload.buildRequestPayload(req(text = text, modelId = ""))
        // valid JSON whose text decodes back to the exact input → escaping is correct
        assertEquals(text, JSONObject(json).getString("text"))
        assertFalse("empty modelId is omitted", json.contains("model_id"))
    }

    @Test
    fun buildRequestPayload_nestsVoiceSettingsWithOnlyTheProvidedFields() {
        val json = ElevenLabsPayload.buildRequestPayload(
            req(
                text = "t", modelId = "m1", outputFormat = "pcm_16000",
                speed = 1.1, stability = 0.5, similarity = 0.8, speakerBoost = true,
                seed = 42L, normalize = "auto", language = "en",
            ),
        )
        val parsed = JSONObject(json)
        assertEquals("m1", parsed.getString("model_id"))
        assertEquals("pcm_16000", parsed.getString("output_format"))
        assertEquals(42L, parsed.getLong("seed"))
        assertEquals("auto", parsed.getString("apply_text_normalization"))
        assertEquals("en", parsed.getString("language_code"))

        val vs = parsed.getJSONObject("voice_settings")
        assertEquals(1.1, vs.getDouble("speed"), 1e-9)
        assertEquals(0.5, vs.getDouble("stability"), 1e-9)
        assertEquals(0.8, vs.getDouble("similarity_boost"), 1e-9)
        assertTrue(vs.getBoolean("use_speaker_boost"))
        assertFalse("style is omitted when null", vs.has("style"))
    }

    @Test
    fun buildRequestPayload_omitsVoiceSettingsWhenNoVoiceFieldsAreSet() {
        val json = ElevenLabsPayload.buildRequestPayload(req(text = "t", modelId = "m"))
        assertFalse("no voice_settings sub-object", json.contains("voice_settings"))
        // still valid JSON with just text + model_id
        val parsed = JSONObject(json)
        assertEquals("t", parsed.getString("text"))
        assertEquals("m", parsed.getString("model_id"))
    }
}
