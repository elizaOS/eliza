package ai.milaidy.plugins.talkmode

import android.Manifest
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.*
import java.io.BufferedInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max

@CapacitorPlugin(
    name = "TalkMode",
    permissions = [
        Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])
    ]
)
class TalkModePlugin : Plugin() {
    companion object {
        private const val TAG = "TalkMode"
        private const val DEFAULT_MODEL_ID = "eleven_v3"
        private const val DEFAULT_OUTPUT_FORMAT = "pcm_24000"
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())

    // State
    private var enabled = false
    private var state = "idle"
    private var statusText = "Off"

    // Speech recognition
    private var recognizer: SpeechRecognizer? = null
    private var isListening = false
    private var listeningMode = false
    private var stopRequested = false
    private var restartJob: Job? = null
    private var lastTranscript = ""
    private var lastHeardAtMs: Long? = null
    private var silenceJob: Job? = null
    private val silenceWindowMs = 700L

    // TTS
    private var systemTts: TextToSpeech? = null
    private var systemTtsReady = false
    private var systemTtsPendingId: String? = null
    private var systemTtsPending: CompletableDeferred<Unit>? = null
    private var pcmTrack: AudioTrack? = null
    private val pcmStopRequested = AtomicBoolean(false)
    private var speakingJob: Job? = null
    private var isSpeaking = false
    private var usedSystemTts = false
    private var lastSpokenText: String? = null
    private var speakStartTimeMs: Long = 0
    private var lastInterruptedAtSeconds: Double? = null

    // Audio focus
    private var audioManager: AudioManager? = null

    // Config
    private var apiKey: String? = null
    private var voiceId: String? = null
    private var modelId: String? = DEFAULT_MODEL_ID
    private var outputFormat: String? = DEFAULT_OUTPUT_FORMAT
    private var voiceAliases: Map<String, String> = emptyMap()
    private var interruptOnSpeech = true
    private var sessionKey = "main"
    private var sttLanguage: String? = null

    // ── Recognition listener ────────────────────────────────────────────

    private val recognitionListener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {
            Log.d(TAG, "Ready for speech")
            if (enabled && isListening) {
                setState("listening", "Listening")
            }
        }

        override fun onBeginningOfSpeech() {
            Log.d(TAG, "Beginning of speech")
        }

        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}

        override fun onEndOfSpeech() {
            Log.d(TAG, "End of speech")
            scheduleRestart()
        }

        override fun onError(error: Int) {
            if (stopRequested) return

            val errorMsg = when (error) {
                SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
                SpeechRecognizer.ERROR_CLIENT -> "Client error"
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Insufficient permissions"
                SpeechRecognizer.ERROR_NETWORK -> "Network error"
                SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
                SpeechRecognizer.ERROR_NO_MATCH -> "No match"
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy"
                SpeechRecognizer.ERROR_SERVER -> "Server error"
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Speech timeout"
                else -> "Unknown error"
            }
            Log.d(TAG, "Recognition error: $errorMsg ($error)")

            if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                notifyListeners("error", JSObject().apply {
                    put("code", "recognition_error")
                    put("message", "Microphone permission required")
                    put("recoverable", false)
                })
                return
            }

            // Don't notify error for no-match / speech-timeout, just restart
            if (error != SpeechRecognizer.ERROR_NO_MATCH &&
                error != SpeechRecognizer.ERROR_SPEECH_TIMEOUT
            ) {
                notifyListeners("error", JSObject().apply {
                    put("code", "recognition_error")
                    put("message", errorMsg)
                    put("recoverable", true)
                })
            }

            scheduleRestart(delayMs = 600)
        }

        override fun onResults(results: Bundle?) {
            val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            val transcript = matches?.firstOrNull()?.trim() ?: ""
            if (transcript.isNotEmpty()) {
                handleTranscript(transcript, isFinal = true)
            }
            scheduleRestart()
        }

        override fun onPartialResults(partialResults: Bundle?) {
            val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            val transcript = matches?.firstOrNull()?.trim() ?: ""
            if (transcript.isNotEmpty()) {
                handleTranscript(transcript, isFinal = false)
            }
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    override fun load() {
        super.load()
        audioManager = context.getSystemService(android.content.Context.AUDIO_SERVICE) as? AudioManager
        initSystemTts()
    }

    private fun initSystemTts() {
        systemTts = TextToSpeech(context) { status ->
            systemTtsReady = status == TextToSpeech.SUCCESS
            if (systemTtsReady) {
                systemTts?.language = Locale.getDefault()
                systemTts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                    override fun onStart(id: String?) {}

                    override fun onDone(id: String?) {
                        if (id != null && id == systemTtsPendingId) {
                            systemTtsPending?.complete(Unit)
                            systemTtsPending = null
                            systemTtsPendingId = null
                        }
                    }

                    @Deprecated("Deprecated in Java")
                    override fun onError(id: String?) {
                        if (id != null && id == systemTtsPendingId) {
                            systemTtsPending?.completeExceptionally(
                                IllegalStateException("System TTS error")
                            )
                            systemTtsPending = null
                            systemTtsPendingId = null
                        }
                    }

                    override fun onError(id: String?, errorCode: Int) {
                        if (id != null && id == systemTtsPendingId) {
                            systemTtsPending?.completeExceptionally(
                                IllegalStateException("System TTS error $errorCode")
                            )
                            systemTtsPending = null
                            systemTtsPendingId = null
                        }
                    }
                })
                Log.d(TAG, "System TTS initialized")
            } else {
                Log.w(TAG, "System TTS init failed")
            }
        }
    }

    // ── Plugin methods ──────────────────────────────────────────────────

    @PluginMethod
    fun start(call: PluginCall) {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            call.resolve(JSObject().apply {
                put("started", false)
                put("error", "Speech recognition not available")
            })
            return
        }

        if (!hasPermission(Manifest.permission.RECORD_AUDIO)) {
            requestPermissionForAlias("microphone", call, "handleStartPermission")
            return
        }

        startInternal(call)
    }

    @PermissionCallback
    private fun handleStartPermission(call: PluginCall) {
        if (hasPermission(Manifest.permission.RECORD_AUDIO)) {
            startInternal(call)
        } else {
            call.resolve(JSObject().apply {
                put("started", false)
                put("error", "Microphone permission denied")
            })
        }
    }

    private fun startInternal(call: PluginCall) {
        // Parse config
        val config = call.getObject("config")
        if (config != null) {
            applyConfig(config)
        }

        enabled = true
        stopRequested = false
        listeningMode = true
        setState("listening", "Listening")

        mainHandler.post {
            try {
                recognizer?.destroy()
                recognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
                    setRecognitionListener(recognitionListener)
                }
                startListeningInternal(markListening = true)
                startSilenceMonitor()

                call.resolve(JSObject().apply {
                    put("started", true)
                })
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start", e)
                call.resolve(JSObject().apply {
                    put("started", false)
                    put("error", e.message ?: "Failed to start")
                })
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        enabled = false
        stopRequested = true
        listeningMode = false
        isListening = false
        restartJob?.cancel()
        restartJob = null
        silenceJob?.cancel()
        silenceJob = null
        lastTranscript = ""
        lastHeardAtMs = null

        mainHandler.post {
            recognizer?.cancel()
            recognizer?.destroy()
            recognizer = null
        }

        stopSpeakingInternal()
        setState("idle", "Off")
        call.resolve()
    }

    @PluginMethod
    fun isEnabled(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("enabled", enabled)
        })
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("state", state)
            put("statusText", statusText)
        })
    }

    @PluginMethod
    fun updateConfig(call: PluginCall) {
        val config = call.getObject("config") ?: run {
            call.resolve()
            return
        }
        applyConfig(config)
        call.resolve()
    }

    @PluginMethod
    fun speak(call: PluginCall) {
        val text = call.getString("text")?.trim() ?: run {
            call.resolve(JSObject().apply {
                put("completed", true)
                put("interrupted", false)
                put("usedSystemTts", false)
            })
            return
        }

        if (text.isEmpty()) {
            call.resolve(JSObject().apply {
                put("completed", true)
                put("interrupted", false)
                put("usedSystemTts", false)
            })
            return
        }

        val useSystemTts = call.getBoolean("useSystemTts", false) ?: false
        val directive = call.getObject("directive")

        speakingJob = scope.launch {
            speakInternal(text, useSystemTts, directive, call)
        }
    }

    @PluginMethod
    fun stopSpeaking(call: PluginCall) {
        val interruptedAt = computeInterruptedAt()
        stopSpeakingInternal()
        call.resolve(JSObject().apply {
            if (interruptedAt != null) {
                put("interruptedAt", interruptedAt)
            }
        })
    }

    @PluginMethod
    fun isSpeaking(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("speaking", isSpeaking)
        })
    }

    @PluginMethod
    fun checkPermissions(call: PluginCall) {
        call.resolve(buildPermissionResult())
    }

    @PluginMethod
    fun requestPermissions(call: PluginCall) {
        if (!hasPermission(Manifest.permission.RECORD_AUDIO)) {
            requestPermissionForAlias("microphone", call, "handlePermissionResult")
        } else {
            call.resolve(buildPermissionResult())
        }
    }

    @PermissionCallback
    private fun handlePermissionResult(call: PluginCall) {
        call.resolve(buildPermissionResult())
    }

    // ── Config ──────────────────────────────────────────────────────────

    private fun applyConfig(config: JSObject) {
        val tts = config.optJSONObject("tts")
        if (tts != null) {
            tts.optString("apiKey", null)?.takeIf { it.isNotEmpty() }?.let { apiKey = it }
            tts.optString("voiceId", null)?.takeIf { it.isNotEmpty() }?.let { voiceId = it }
            tts.optString("modelId", null)?.takeIf { it.isNotEmpty() }?.let { modelId = it }
            tts.optString("outputFormat", null)?.takeIf { it.isNotEmpty() }?.let {
                outputFormat = validatedOutputFormat(it) ?: outputFormat
            }
            if (tts.has("interruptOnSpeech")) {
                interruptOnSpeech = tts.optBoolean("interruptOnSpeech", true)
            }

            val aliases = tts.optJSONObject("voiceAliases")
            if (aliases != null) {
                val map = mutableMapOf<String, String>()
                aliases.keys().forEach { key ->
                    val value = aliases.optString(key)?.trim()
                    if (!value.isNullOrEmpty()) {
                        map[key.trim().lowercase()] = value
                    }
                }
                voiceAliases = map
            }
        }

        val stt = config.optJSONObject("stt")
        if (stt != null) {
            stt.optString("language", null)?.takeIf { it.isNotEmpty() }?.let {
                sttLanguage = validatedLanguage(it)
            }
        }

        config.optString("sessionKey", null)?.takeIf { it.isNotEmpty() }?.let { sessionKey = it }

        if (config.has("silenceWindowMs")) {
            // silenceWindowMs is final for stability; log but don't change
            Log.d(TAG, "silenceWindowMs config ignored on Android (fixed at ${silenceWindowMs}ms)")
        }
    }

    // ── STT internals ───────────────────────────────────────────────────

    private fun startListeningInternal(markListening: Boolean) {
        if (stopRequested) return
        val r = recognizer ?: return

        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            sttLanguage?.let { putExtra(RecognizerIntent.EXTRA_LANGUAGE, it) }
        }

        if (markListening) {
            isListening = true
            setState("listening", "Listening")
        }

        try {
            r.startListening(intent)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start listening", e)
        }
    }

    private fun scheduleRestart(delayMs: Long = 350) {
        if (stopRequested) return
        restartJob?.cancel()
        restartJob = scope.launch {
            delay(delayMs)
            mainHandler.post {
                if (stopRequested) return@post
                try {
                    recognizer?.cancel()
                    val shouldListen = listeningMode
                    val shouldInterrupt = isSpeaking && interruptOnSpeech
                    if (!shouldListen && !shouldInterrupt) return@post
                    startListeningInternal(markListening = shouldListen)
                } catch (_: Throwable) {
                    // Will be picked up by onError and retry again
                }
            }
        }
    }

    private fun startSilenceMonitor() {
        silenceJob?.cancel()
        silenceJob = scope.launch {
            while (enabled) {
                delay(200)
                checkSilence()
            }
        }
    }

    private fun checkSilence() {
        if (!isListening) return
        val transcript = lastTranscript.trim()
        if (transcript.isEmpty()) return
        val lastHeard = lastHeardAtMs ?: return
        val elapsed = SystemClock.elapsedRealtime() - lastHeard
        if (elapsed < silenceWindowMs) return

        // Finalize: emit a final transcript event
        notifyListeners("transcript", JSObject().apply {
            put("transcript", transcript)
            put("isFinal", true)
        })
        lastTranscript = ""
        lastHeardAtMs = null
    }

    private fun handleTranscript(transcript: String, isFinal: Boolean) {
        if (transcript.isEmpty()) return

        // If speaking and interrupt enabled, check for interruption
        if (isSpeaking && interruptOnSpeech) {
            if (shouldInterrupt(transcript)) {
                val interruptedAt = computeInterruptedAt()
                stopSpeakingInternal()
                lastInterruptedAtSeconds = interruptedAt
            }
            return
        }

        if (!isListening) return

        if (transcript.isNotEmpty()) {
            lastTranscript = transcript
            lastHeardAtMs = SystemClock.elapsedRealtime()
        }

        notifyListeners("transcript", JSObject().apply {
            put("transcript", transcript)
            put("isFinal", isFinal)
        })
    }

    /**
     * Avoid false interrupts: don't interrupt if the heard text is just a
     * substring of what we're currently speaking (echo from speaker).
     */
    private fun shouldInterrupt(transcript: String): Boolean {
        val trimmed = transcript.trim()
        if (trimmed.length < 3) return false
        val spoken = lastSpokenText?.lowercase()
        if (spoken != null && spoken.contains(trimmed.lowercase())) return false
        return true
    }

    /**
     * Ensure the recognizer is active during speech so we can detect
     * interruption from the user speaking over TTS playback.
     */
    private fun ensureInterruptListener() {
        if (!interruptOnSpeech || !enabled) return
        mainHandler.post {
            if (stopRequested) return@post
            if (!SpeechRecognizer.isRecognitionAvailable(context)) return@post
            try {
                if (recognizer == null) {
                    recognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
                        setRecognitionListener(recognitionListener)
                    }
                }
                recognizer?.cancel()
                startListeningInternal(markListening = false)
            } catch (_: Throwable) {}
        }
    }

    // ── TTS internals ───────────────────────────────────────────────────

    private suspend fun speakInternal(
        text: String,
        forceSystemTts: Boolean,
        directive: JSObject?,
        call: PluginCall
    ) {
        isSpeaking = true
        usedSystemTts = false
        lastSpokenText = text
        speakStartTimeMs = SystemClock.elapsedRealtime()
        pcmStopRequested.set(false)
        setState("speaking", "Speaking")

        val effectiveVoiceId = directive?.optString("voiceId", null)
            ?.let { resolveVoiceAlias(it) }
            ?: voiceId
        val effectiveApiKey = apiKey

        notifyListeners("speaking", JSObject().apply {
            put("text", text)
            put("isSystemTts", forceSystemTts || effectiveApiKey.isNullOrEmpty() || effectiveVoiceId.isNullOrEmpty())
        })

        // Stop listening during speech (we keep recognizer for interrupt detection)
        mainHandler.post { recognizer?.stopListening() }
        ensureInterruptListener()

        // Request audio focus
        requestAudioFocus()

        try {
            val canUseElevenLabs = !forceSystemTts &&
                !effectiveApiKey.isNullOrEmpty() &&
                !effectiveVoiceId.isNullOrEmpty()

            if (canUseElevenLabs) {
                try {
                    val request = buildElevenLabsRequest(text, directive)
                    streamAndPlayPcm(
                        voiceId = effectiveVoiceId!!,
                        apiKey = effectiveApiKey!!,
                        request = request
                    )

                    if (!pcmStopRequested.get()) {
                        call.resolve(JSObject().apply {
                            put("completed", true)
                            put("interrupted", false)
                            put("usedSystemTts", false)
                        })
                    } else {
                        call.resolve(JSObject().apply {
                            put("completed", false)
                            put("interrupted", true)
                            put("usedSystemTts", false)
                            lastInterruptedAtSeconds?.let { put("interruptedAt", it) }
                        })
                    }
                } catch (e: Exception) {
                    if (pcmStopRequested.get()) {
                        call.resolve(JSObject().apply {
                            put("completed", false)
                            put("interrupted", true)
                            put("usedSystemTts", false)
                        })
                    } else {
                        Log.w(TAG, "ElevenLabs TTS failed, falling back to system", e)
                        speakWithSystemTts(text, call)
                    }
                }
            } else {
                speakWithSystemTts(text, call)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Speak failed", e)
            call.resolve(JSObject().apply {
                put("completed", false)
                put("interrupted", false)
                put("usedSystemTts", usedSystemTts)
                put("error", e.message ?: "Speak failed")
            })
        } finally {
            isSpeaking = false
            pcmStopRequested.set(false)
            abandonAudioFocus()

            notifyListeners("speakComplete", JSObject().apply {
                put("completed", !pcmStopRequested.get())
                lastInterruptedAtSeconds?.let { put("interruptedAt", it) }
            })

            if (enabled) {
                listeningMode = true
                setState("listening", "Listening")
                mainHandler.post { startListeningInternal(markListening = true) }
            } else {
                setState("idle", "Off")
            }
        }
    }

    /**
     * Build the full ElevenLabs request parameters from directive + defaults,
     * applying all validation from the classic TalkModeRuntime.
     */
    private fun buildElevenLabsRequest(text: String, directive: JSObject?): ElevenLabsRequest {
        val effectiveModelId = directive?.optString("modelId", null)?.takeIf { it.isNotEmpty() }
            ?: modelId ?: DEFAULT_MODEL_ID
        val effectiveFormat = validatedOutputFormat(
            directive?.optString("outputFormat", null) ?: outputFormat
        ) ?: DEFAULT_OUTPUT_FORMAT

        val rawSpeed = directive?.optDouble("speed", -1.0)?.takeIf { it > 0 }
        val rawRateWpm = directive?.optInt("rateWpm", -1)?.takeIf { it > 0 }
        val speed = resolveSpeed(rawSpeed, rawRateWpm)

        val rawStability = directive?.optDouble("stability", -1.0)?.takeIf { it >= 0 }
        val stability = validatedStability(rawStability, effectiveModelId)

        val rawSimilarity = directive?.optDouble("similarity", -1.0)?.takeIf { it >= 0 }
        val similarity = validatedUnit(rawSimilarity)

        val rawStyle = directive?.optDouble("style", -1.0)?.takeIf { it >= 0 }
        val style = validatedUnit(rawStyle)

        val speakerBoost = if (directive?.has("speakerBoost") == true) {
            directive.optBoolean("speakerBoost", false)
        } else null

        val rawSeed = directive?.optLong("seed", -1)?.takeIf { it >= 0 }
        val seed = validatedSeed(rawSeed)

        val rawNormalize = directive?.optString("normalize", null)
        val normalize = validatedNormalize(rawNormalize)

        val rawLanguage = directive?.optString("language", null)
        val language = validatedLanguage(rawLanguage)

        val rawLatencyTier = directive?.optInt("latencyTier", -1)?.takeIf { it >= 0 }
        val latencyTier = validatedLatencyTier(rawLatencyTier)

        return ElevenLabsRequest(
            text = text,
            modelId = effectiveModelId,
            outputFormat = effectiveFormat,
            speed = speed,
            stability = stability,
            similarity = similarity,
            style = style,
            speakerBoost = speakerBoost,
            seed = seed,
            normalize = normalize,
            language = language,
            latencyTier = latencyTier
        )
    }

    /**
     * Stream PCM audio from ElevenLabs and play via AudioTrack.
     * Ported from classic TalkModeManager with proper offset-based writes.
     */
    private suspend fun streamAndPlayPcm(
        voiceId: String,
        apiKey: String,
        request: ElevenLabsRequest
    ) = withContext(Dispatchers.IO) {
        pcmStopRequested.set(false)

        val sampleRate = parsePcmSampleRate(request.outputFormat) ?: 24000
        val minBuffer = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuffer <= 0) {
            throw IllegalStateException("AudioTrack buffer size invalid: $minBuffer")
        }

        val bufferSize = max(minBuffer * 2, 8 * 1024)
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build()
            )
            .setBufferSizeInBytes(bufferSize)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()

        if (track.state != AudioTrack.STATE_INITIALIZED) {
            track.release()
            throw IllegalStateException("AudioTrack init failed")
        }
        pcmTrack = track
        track.play()

        Log.d(TAG, "PCM play start sampleRate=$sampleRate bufferSize=$bufferSize")
        val conn = openTtsConnection(voiceId, apiKey, request)
        try {
            val payload = buildRequestPayload(request)
            conn.outputStream.use { it.write(payload.toByteArray()) }

            val code = conn.responseCode
            if (code >= 400) {
                val errBody = conn.errorStream?.readBytes()?.toString(Charsets.UTF_8) ?: ""
                throw IllegalStateException("ElevenLabs API error: $code $errBody")
            }

            BufferedInputStream(conn.inputStream).use { input ->
                val buffer = ByteArray(8 * 1024)
                while (true) {
                    if (pcmStopRequested.get()) return@withContext
                    val bytesRead = input.read(buffer)
                    if (bytesRead <= 0) break

                    // Write all bytes, handling partial writes
                    var offset = 0
                    while (offset < bytesRead) {
                        if (pcmStopRequested.get()) return@withContext
                        val wrote = try {
                            track.write(buffer, offset, bytesRead - offset)
                        } catch (e: Throwable) {
                            if (pcmStopRequested.get()) return@withContext
                            throw e
                        }
                        if (wrote <= 0) {
                            if (pcmStopRequested.get()) return@withContext
                            throw IllegalStateException("AudioTrack write failed: $wrote")
                        }
                        offset += wrote
                    }
                }
            }

            // Wait for playback buffer to drain
            if (!pcmStopRequested.get()) {
                track.stop()
            }
            Log.d(TAG, "PCM play done")
        } finally {
            cleanupPcmTrack()
            conn.disconnect()
        }
    }

    /**
     * Open HTTP connection to ElevenLabs streaming TTS endpoint.
     * Includes Accept header and latency tier query parameter.
     */
    private fun openTtsConnection(
        voiceId: String,
        apiKey: String,
        request: ElevenLabsRequest
    ): HttpURLConnection {
        val baseUrl = "https://api.elevenlabs.io/v1/text-to-speech/$voiceId/stream"
        val url = if (request.latencyTier != null) {
            URL("$baseUrl?optimize_streaming_latency=${request.latencyTier}")
        } else {
            URL(baseUrl)
        }

        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 30_000
        conn.readTimeout = 30_000
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Accept", resolveAcceptHeader(request.outputFormat))
        conn.setRequestProperty("xi-api-key", apiKey)
        conn.doOutput = true
        return conn
    }

    private fun resolveAcceptHeader(outputFormat: String?): String {
        val normalized = outputFormat?.trim()?.lowercase().orEmpty()
        return if (normalized.startsWith("pcm_")) "audio/pcm" else "audio/mpeg"
    }

    /**
     * Build the full JSON request payload with all ElevenLabs voice_settings.
     */
    private fun buildRequestPayload(request: ElevenLabsRequest): String {
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

    /** Escape a string for JSON. */
    private fun jsonString(value: String): String {
        val escaped = value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t")
        return "\"$escaped\""
    }

    private suspend fun speakWithSystemTts(text: String, call: PluginCall) {
        usedSystemTts = true
        setState("speaking", "Speaking (System)")

        if (!systemTtsReady || systemTts == null) {
            call.resolve(JSObject().apply {
                put("completed", false)
                put("interrupted", false)
                put("usedSystemTts", true)
                put("error", "System TTS not available")
            })
            return
        }

        val utteranceId = "talkmode-${UUID.randomUUID()}"
        val deferred = CompletableDeferred<Unit>()
        systemTtsPending?.cancel()
        systemTtsPending = deferred
        systemTtsPendingId = utteranceId

        withContext(Dispatchers.Main) {
            val params = Bundle()
            systemTts?.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
        }

        try {
            withContext(Dispatchers.IO) {
                kotlinx.coroutines.withTimeout(180_000) { deferred.await() }
            }
            call.resolve(JSObject().apply {
                put("completed", true)
                put("interrupted", false)
                put("usedSystemTts", true)
            })
        } catch (e: Exception) {
            call.resolve(JSObject().apply {
                put("completed", false)
                put("interrupted", false)
                put("usedSystemTts", true)
                put("error", e.message ?: "System TTS error")
            })
        }
    }

    // ── Audio focus ─────────────────────────────────────────────────────

    private fun requestAudioFocus() {
        val am = audioManager ?: return
        val focusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
            when (focusChange) {
                AudioManager.AUDIOFOCUS_LOSS,
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                    // Another app took audio; stop speaking if we are
                    if (isSpeaking) {
                        stopSpeakingInternal()
                    }
                }
            }
        }
        audioFocusRequest = focusListener

        @Suppress("DEPRECATION")
        am.requestAudioFocus(
            focusListener,
            AudioManager.STREAM_MUSIC,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
        )
    }

    private fun abandonAudioFocus() {
        val am = audioManager ?: return
        val listener = audioFocusRequest ?: return
        @Suppress("DEPRECATION")
        am.abandonAudioFocus(listener)
        audioFocusRequest = null
    }

    // ── Cleanup helpers ─────────────────────────────────────────────────

    private fun stopSpeakingInternal() {
        pcmStopRequested.set(true)
        cleanupPcmTrack()
        systemTts?.stop()
        systemTtsPending?.cancel()
        systemTtsPending = null
        systemTtsPendingId = null
        speakingJob?.cancel()
        isSpeaking = false
    }

    private fun cleanupPcmTrack() {
        val track = pcmTrack ?: return
        try {
            track.pause()
            track.flush()
            track.stop()
        } catch (_: Throwable) {
            // ignore cleanup errors
        } finally {
            track.release()
        }
        pcmTrack = null
    }

    private fun computeInterruptedAt(): Double? {
        if (!isSpeaking) return null
        val elapsed = SystemClock.elapsedRealtime() - speakStartTimeMs
        return elapsed.toDouble() / 1000.0
    }

    // ── Voice alias resolution ──────────────────────────────────────────

    private fun resolveVoiceAlias(value: String?): String? {
        val trimmed = value?.trim() ?: return null
        if (trimmed.isEmpty()) return null

        val normalized = trimmed.lowercase()

        // Check alias map
        voiceAliases[normalized]?.let { return it }

        // Check if it's already a known voice ID (direct passthrough)
        if (voiceAliases.values.any { it.equals(trimmed, ignoreCase = true) }) return trimmed

        // Looks like a raw ElevenLabs voice ID
        if (isLikelyVoiceId(trimmed)) return trimmed

        return null
    }

    private fun isLikelyVoiceId(value: String): Boolean {
        if (value.length < 10) return false
        return value.all { it.isLetterOrDigit() || it == '-' || it == '_' }
    }

    // ── Validation helpers (from classic TalkModeRuntime) ───────────────

    private fun resolveSpeed(speed: Double?, rateWpm: Int?): Double? {
        if (rateWpm != null && rateWpm > 0) {
            val resolved = rateWpm.toDouble() / 175.0
            if (resolved <= 0.5 || resolved >= 2.0) return null
            return resolved
        }
        if (speed != null) {
            if (speed <= 0.5 || speed >= 2.0) return null
            return speed
        }
        return null
    }

    private fun validatedUnit(value: Double?): Double? {
        if (value == null) return null
        if (value < 0 || value > 1) return null
        return value
    }

    private fun validatedStability(value: Double?, modelId: String?): Double? {
        if (value == null) return null
        val normalized = modelId?.trim()?.lowercase()
        if (normalized == "eleven_v3") {
            // v3 only supports discrete stability values
            return if (value == 0.0 || value == 0.5 || value == 1.0) value else null
        }
        return validatedUnit(value)
    }

    private fun validatedSeed(value: Long?): Long? {
        if (value == null) return null
        if (value < 0 || value > 4294967295L) return null
        return value
    }

    private fun validatedNormalize(value: String?): String? {
        val normalized = value?.trim()?.lowercase() ?: return null
        return if (normalized in listOf("auto", "on", "off")) normalized else null
    }

    private fun validatedLanguage(value: String?): String? {
        val normalized = value?.trim()?.lowercase() ?: return null
        if (normalized.length != 2) return null
        if (!normalized.all { it in 'a'..'z' }) return null
        return normalized
    }

    private fun validatedOutputFormat(value: String?): String? {
        val trimmed = value?.trim()?.lowercase() ?: return null
        if (trimmed.isEmpty()) return null
        if (trimmed.startsWith("mp3_")) return trimmed
        return if (parsePcmSampleRate(trimmed) != null) trimmed else null
    }

    private fun validatedLatencyTier(value: Int?): Int? {
        if (value == null) return null
        if (value < 0 || value > 4) return null
        return value
    }

    private fun parsePcmSampleRate(value: String?): Int? {
        val trimmed = value?.trim()?.lowercase() ?: return null
        if (!trimmed.startsWith("pcm_")) return null
        val suffix = trimmed.removePrefix("pcm_")
        val digits = suffix.takeWhile { it.isDigit() }
        val rate = digits.toIntOrNull() ?: return null
        return if (rate in setOf(16000, 22050, 24000, 44100)) rate else null
    }

    // ── State management ────────────────────────────────────────────────

    private fun setState(newState: String, newStatusText: String) {
        val previousState = state
        state = newState
        statusText = newStatusText

        notifyListeners("stateChange", JSObject().apply {
            put("state", newState)
            put("previousState", previousState)
            put("statusText", newStatusText)
            put("usingSystemTts", usedSystemTts)
        })
    }

    private fun buildPermissionResult(): JSObject {
        val micGranted = hasPermission(Manifest.permission.RECORD_AUDIO)
        val speechAvailable = SpeechRecognizer.isRecognitionAvailable(context)

        return JSObject().apply {
            put("microphone", if (micGranted) "granted" else "denied")
            put("speechRecognition", if (speechAvailable) {
                if (micGranted) "granted" else "prompt"
            } else {
                "not_supported"
            })
        }
    }

    private fun hasPermission(permission: String): Boolean {
        return getPermissionState(permission) == com.getcapacitor.PermissionState.GRANTED
    }

    // ── Cleanup ─────────────────────────────────────────────────────────

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        enabled = false
        stopRequested = true
        recognizer?.destroy()
        recognizer = null
        systemTts?.shutdown()
        systemTts = null
        cleanupPcmTrack()
        silenceJob?.cancel()
        restartJob?.cancel()
        speakingJob?.cancel()
        abandonAudioFocus()
        scope.cancel()
    }

    // ── Data class ──────────────────────────────────────────────────────

    private data class ElevenLabsRequest(
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
        val latencyTier: Int?
    )
}
