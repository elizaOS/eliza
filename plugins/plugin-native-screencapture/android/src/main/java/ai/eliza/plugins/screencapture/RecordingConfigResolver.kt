package ai.eliza.plugins.screencapture

/** Resolved screen-recording configuration (shared by the plugin + its test). */
data class RecordingConfig(
    val quality: String? = null,
    val maxDuration: Double? = null,
    val maxFileSize: Long? = null,
    val fps: Int = 30,
    val bitrate: Int? = null,
    val captureMicrophone: Boolean = false,
    val captureSystemAudio: Boolean = false,
)

/**
 * Pure, Bridge-free resolution of screen-recording config (#9967).
 *
 * Extracted out of `ScreenCapturePlugin.parseRecordingConfig` so the quality-
 * preset → fps/bitrate mapping, the bitrate estimate, and the fps clamp can be
 * exercised by an on-device instrumented test without a mocked Capacitor bridge
 * or a live MediaProjection session. The plugin reads the values off the
 * `PluginCall` and delegates here, so behavior is unchanged.
 */
object RecordingConfigResolver {
    /** Heuristic H.264 bitrate for a `width × height @ fps` capture, clamped to a sane range. */
    fun estimateBitrate(width: Int, height: Int, fps: Int): Int {
        val pixels = width.toLong() * height.toLong()
        val raw = (pixels * fps.toLong() * 2L).toInt()
        return raw.coerceIn(1_000_000, 12_000_000)
    }

    /**
     * Resolves the final config from the (already-parsed) request fields + the
     * measured screen size. Explicit `fpsOverride` / `bitrateOverride` win over
     * the quality preset; the final fps is clamped to [1, 60].
     */
    fun resolve(
        quality: String?,
        fpsOverride: Int?,
        bitrateOverride: Int?,
        maxDuration: Double?,
        maxFileSize: Long?,
        captureMicrophone: Boolean,
        captureSystemAudio: Boolean,
        screenWidth: Int,
        screenHeight: Int,
    ): RecordingConfig {
        val presetFps: Int
        val presetBitrate: Int?
        when (quality?.lowercase()) {
            "low" -> {
                presetFps = 15
                presetBitrate = estimateBitrate(screenWidth, screenHeight, 15) / 2
            }
            "medium" -> {
                presetFps = 24
                presetBitrate = null // use estimate downstream
            }
            "high" -> {
                presetFps = 30
                presetBitrate = null // use estimate downstream
            }
            "highest" -> {
                presetFps = 60
                presetBitrate = estimateBitrate(screenWidth, screenHeight, 60) * 2
            }
            else -> {
                presetFps = 30
                presetBitrate = null
            }
        }

        val fps = fpsOverride ?: presetFps
        val bitrate = bitrateOverride ?: presetBitrate

        return RecordingConfig(
            quality = quality,
            maxDuration = maxDuration,
            maxFileSize = maxFileSize,
            fps = fps.coerceIn(1, 60),
            bitrate = bitrate,
            captureMicrophone = captureMicrophone,
            captureSystemAudio = captureSystemAudio,
        )
    }
}
