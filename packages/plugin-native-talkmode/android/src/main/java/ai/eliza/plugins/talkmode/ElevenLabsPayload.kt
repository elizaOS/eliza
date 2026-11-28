package ai.eliza.plugins.talkmode

/** The ElevenLabs TTS request parameters resolved from a speak directive. */
data class ElevenLabsRequest(
    val text: String,
    val modelId: String?,
    val outputFormat: String?,
    val speed: Double?,
    val stability: Double?,
    val similarity: Double?,
    val style: Double?,
    val speakerBoost: Boolean?,
    val seed: Long?,
    val normalize: String?,
    val language: String?,
    val latencyTier: Int?,
)

/**
 * Pure, Bridge-free serialization of the ElevenLabs TTS request (#9967).
 *
 * Extracted out of [TalkModePlugin] so the exact wire format the TTS HTTP call
 * sends — the JSON body (with its nested `voice_settings`) and the `Accept`
 * header — can be exercised by an on-device instrumented test. The directive →
 * [ElevenLabsRequest] resolution (clamping/validation against many helpers +
 * plugin defaults) stays in the plugin; only the permission-free serialization
 * moves here, so behavior is unchanged.
 */
object ElevenLabsPayload {
    /** PCM output formats want an `audio/pcm` Accept header; everything else `audio/mpeg`. */
    fun resolveAcceptHeader(outputFormat: String?): String {
        val normalized = outputFormat?.trim()?.lowercase().orEmpty()
        return if (normalized.startsWith("pcm_")) "audio/pcm" else "audio/mpeg"
    }

    /** Serializes the request to the ElevenLabs JSON body; optional fields are omitted. */
    fun buildRequestPayload(request: ElevenLabsRequest): String {
        val sb = StringBuilder()
        sb.append("{")
        sb.append("\"text\":").append(jsonString(request.text))
        request.modelId?.takeIf { it.isNotEmpty() }?.let {
            sb.append(",\"model_id\":").append(jsonString(it))
        }
        request.outputFormat?.takeIf { it.isNotEmpty() }?.let {
            sb.append(",\"output_format\":").append(jsonString(it))
        }
        request.seed?.let { sb.append(",\"seed\":$it") }
        request.normalize?.let { sb.append(",\"apply_text_normalization\":").append(jsonString(it)) }
        request.language?.let { sb.append(",\"language_code\":").append(jsonString(it)) }

        // voice_settings sub-object
        val vsEntries = mutableListOf<String>()
        request.speed?.let { vsEntries.add("\"speed\":$it") }
        request.stability?.let { vsEntries.add("\"stability\":$it") }
        request.similarity?.let { vsEntries.add("\"similarity_boost\":$it") }
        request.style?.let { vsEntries.add("\"style\":$it") }
        request.speakerBoost?.let { vsEntries.add("\"use_speaker_boost\":$it") }
        if (vsEntries.isNotEmpty()) {
            sb.append(",\"voice_settings\":{")
            sb.append(vsEntries.joinToString(","))
            sb.append("}")
        }

        sb.append("}")
        return sb.toString()
    }

    private fun jsonString(value: String): String {
        val escaped = value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
        return "\"$escaped\""
    }
}
