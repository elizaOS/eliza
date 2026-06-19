package ai.eliza.plugins.talkmode

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.os.Build
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
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.*
import java.io.BufferedInputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.max
import org.json.JSONObject

@CapacitorPlugin(
    name = "TalkMode",
    permissions = [
        Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])
    ]
)
class TalkModePlugin : Plugin() {
    companion object {
        private const val TAG = "TalkMode"
        private const val DEFAULT_MODEL_ID = "eleven_flash_v2_5"
        private const val DEFAULT_OUTPUT_FORMAT = "pcm_24000"
        private const val LOCAL_INFERENCE_TTS_URL = "http://127.0.0.1:31337/api/tts/local-inference"
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
    // The recognizer's own onResults AND our silence monitor can both finalize
    // the same utterance; dedup so a turn is emitted (and sent) exactly once.
    private var lastEmittedFinal = ""
    private var lastEmittedFinalAtMs = 0L

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
    @Volatile private var activePcmConnection: HttpURLConnection? = null

    // Voice audio session (communication-mode routing + focus, mirrors the iOS
    // .playAndRecord/.voiceChat/.defaultToSpeaker session). Held for the whole
    // conversation so the platform AEC has a stable speaker reference to cancel.
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var audioSessionActive = false
    private var savedAudioMode = AudioManager.MODE_NORMAL
    private var savedSpeakerphoneOn = false
    // Streams we mute for the session to suppress the platform recognizer's
    // start/stop earcons (the "on/off" beeps heard as it re-arms continuously).
    // TTS plays on STREAM_VOICE_CALL (USAGE_VOICE_COMMUNICATION) so it stays
    // audible. Tracked so we only unmute streams we muted.
    private val earconStreams = intArrayOf(
        AudioManager.STREAM_MUSIC,
        AudioManager.STREAM_SYSTEM,
        AudioManager.STREAM_NOTIFICATION,
    )
    private var earconStreamsMuted = false

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
                systemTts?.setAudioAttributes(voiceAudioAttributes())
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

        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "handleStartPermission")
            return
        }

        startInternal(call)
    }

    @PermissionCallback
    private fun handleStartPermission(call: PluginCall) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
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
        configureVoiceAudioSession()
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
                // Recognizer creation failed AFTER the audio session was
                // configured — release it so the earcon streams aren't left
                // muted and the device isn't stuck in MODE_IN_COMMUNICATION.
                enabled = false
                listeningMode = false
                releaseVoiceAudioSession()
                setState("idle", "Off")
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
        releaseVoiceAudioSession()
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
        val useLocalInferenceTts = call.getBoolean("useLocalInferenceTts", false) ?: false
        val directive = call.getObject("directive")

        speakingJob = scope.launch {
            speakInternal(text, useSystemTts, useLocalInferenceTts, directive, call)
        }
    }

    @PluginMethod
    fun stopSpeaking(call: PluginCall) {
        val interruptedAt = computeInterruptedAt()
        lastInterruptedAtSeconds = interruptedAt
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
    override fun checkPermissions(call: PluginCall) {
        call.resolve(buildPermissionResult())
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        if (!isPermissionGranted(Manifest.permission.RECORD_AUDIO)) {
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
            tts.stringOrNull("apiKey")?.takeIf { it.isNotEmpty() }?.let { apiKey = it }
            tts.stringOrNull("voiceId")?.takeIf { it.isNotEmpty() }?.let { voiceId = it }
            tts.stringOrNull("modelId")?.takeIf { it.isNotEmpty() }?.let { modelId = it }
            tts.stringOrNull("outputFormat")?.takeIf { it.isNotEmpty() }?.let {
                outputFormat = validatedOutputFormat(it) ?: outputFormat
            }
            if (tts.has("interruptOnSpeech")) {
                interruptOnSpeech = tts.optBoolean("interruptOnSpeech", true)
            }

            val aliases = tts.optJSONObject("voiceAliases")
            if (aliases != null) {
                val map = mutableMapOf<String, String>()
                aliases.keys().forEach { key ->
                    val value = aliases.stringOrNull(key)?.trim()
                    if (!value.isNullOrEmpty()) {
                        map[key.trim().lowercase()] = value
                    }
                }
                voiceAliases = map
            }
        }

        val stt = config.optJSONObject("stt")
        if (stt != null) {
            stt.stringOrNull("language")?.takeIf { it.isNotEmpty() }?.let {
                sttLanguage = validatedLanguage(it)
            }
        }

        config.stringOrNull("sessionKey")?.takeIf { it.isNotEmpty() }?.let { sessionKey = it }

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
            // On-device recognizer (no network round-trip; works offline). The
            // platform recognizer's open/close cadence during continuous use is
            // intrinsic and not controllable via the silence-length extras (the
            // on-device SODA engine ignores them); we silence the AUDIBLE part of
            // that churn by muting the earcon streams for the session instead
            // (see configureVoiceAudioSession).
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
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

        // Finalize this turn (deduped against the recognizer's own onResults),
        // then restart the recognizer so the next utterance is a CLEAN session —
        // Android SpeechRecognizer accumulates within a session, so without the
        // restart the next turn's partials would prepend the words we just sent.
        lastTranscript = ""
        lastHeardAtMs = null
        emitFinalOnce(transcript)
        scheduleRestart()
    }

    private fun handleTranscript(transcript: String, isFinal: Boolean) {
        if (transcript.isEmpty()) return

        // If speaking and interrupt enabled, check for interruption
        if (isSpeaking && interruptOnSpeech) {
            if (shouldInterrupt(transcript)) {
                val interruptedAt = computeInterruptedAt()
                lastInterruptedAtSeconds = interruptedAt
                stopSpeakingInternal()
            }
            return
        }

        if (!isListening) return

        if (isFinal) {
            // A real end-of-turn from the recognizer: emit once and clear the
            // pending buffer so the silence monitor doesn't re-finalize the same
            // words (the double-send bug).
            lastTranscript = ""
            lastHeardAtMs = null
            emitFinalOnce(transcript)
        } else {
            lastTranscript = transcript
            lastHeardAtMs = SystemClock.elapsedRealtime()
            notifyListeners("transcript", JSObject().apply {
                put("transcript", transcript)
                put("isFinal", false)
            })
        }
    }

    /**
     * Emit a FINAL transcript exactly once. Both the recognizer's `onResults`
     * and the silence monitor can finalize the same utterance; collapse them so
     * the turn is sent a single time (a repeated final within 2s is dropped).
     */
    private fun emitFinalOnce(transcript: String) {
        val text = transcript.trim()
        if (text.isEmpty()) return
        val now = SystemClock.elapsedRealtime()
        if (text == lastEmittedFinal && now - lastEmittedFinalAtMs < 2000L) return
        lastEmittedFinal = text
        lastEmittedFinalAtMs = now
        notifyListeners("transcript", JSObject().apply {
            put("transcript", text)
            put("isFinal", true)
        })
    }

    /**
     * Decide whether heard speech should barge in on the agent's TTS. Tuned to
     * avoid FALSE interrupts (which cut the reply mid-sentence and read as
     * "intermittent audio"): a one-word ASR blip, background noise, or the
     * agent's own voice bleeding back into the mic must NOT interrupt — only a
     * genuine couple-of-words utterance from the user does.
     */
    private fun shouldInterrupt(transcript: String): Boolean {
        val trimmed = transcript.trim()
        val lower = trimmed.lowercase()
        val words = lower.split(Regex("\\s+")).filter { it.isNotBlank() }
        // Need real intent: at least two words, or one long word (≥ 8 chars).
        if (words.size < 2 && trimmed.length < 8) return false
        val spoken = lastSpokenText?.lowercase() ?: return true
        // Exact echo of what we're saying → speaker bleed, not the user.
        if (spoken.contains(lower)) return false
        // Fuzzy echo: if most of the heard words appear in the text we're
        // currently speaking, treat it as echo (ASR mishears of our own audio).
        val echoed = words.count { spoken.contains(it) }
        if (words.isNotEmpty() && echoed.toDouble() / words.size >= 0.6) {
            return false
        }
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
        useLocalInferenceTts: Boolean,
        directive: JSObject?,
        call: PluginCall
    ) {
        isSpeaking = true
        usedSystemTts = false
        lastSpokenText = text
        speakStartTimeMs = SystemClock.elapsedRealtime()
        pcmStopRequested.set(false)
        lastInterruptedAtSeconds = null
        setState("speaking", "Speaking")

        val effectiveVoiceId = directive.stringOrNull("voiceId")?.let(::resolveVoiceAlias) ?: voiceId
        val effectiveApiKey = apiKey

        notifyListeners("speaking", JSObject().apply {
            put("text", text)
            put(
                "isSystemTts",
                !useLocalInferenceTts &&
                    (forceSystemTts || effectiveApiKey.isNullOrEmpty() || effectiveVoiceId.isNullOrEmpty())
            )
        })

        // Stop listening during speech (we keep recognizer for interrupt detection)
        mainHandler.post { recognizer?.stopListening() }
        ensureInterruptListener()

        // Ensure the communication-mode session + audio focus are active even
        // for a standalone speak() that wasn't preceded by start().
        configureVoiceAudioSession()
        // Re-assert loudspeaker routing right before playback. configureVoice…
        // only routes on the FIRST activation; if the session was already up (the
        // STT path opened it) the speaker route may have drifted, leaving TTS on
        // the earpiece. Re-route here so replies are audible out the speaker.
        audioManager?.let { routeVoiceOutput(it) }

        try {
            val canUseLocalInference = useLocalInferenceTts && !forceSystemTts
            val canUseElevenLabs = !canUseLocalInference &&
                !forceSystemTts &&
                !effectiveApiKey.isNullOrEmpty() &&
                !effectiveVoiceId.isNullOrEmpty()

            if (canUseLocalInference) {
                try {
                    streamAndPlayLocalInferenceTts(text, directive)

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
                        // The on-device OmniVoice TTS assets aren't always staged
                        // (it 502s "TEXT_TO_SPEECH not available"). Rather than go
                        // silent — the JS browser-SpeechSynthesis fallback doesn't
                        // exist in the Android WebView — fall back to the platform
                        // TextToSpeech so replies are always spoken aloud.
                        Log.w(TAG, "Local inference TTS failed, falling back to system TTS", e)
                        speakWithSystemTts(text, call)
                    }
                }
            } else if (canUseElevenLabs) {
                try {
                    val request = buildElevenLabsRequest(text, directive)
                    streamAndPlayPcm(
                        voiceId = effectiveVoiceId,
                        apiKey = effectiveApiKey,
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
            val wasInterrupted = pcmStopRequested.get()
            val interruptedAt = lastInterruptedAtSeconds
            isSpeaking = false
            pcmStopRequested.set(false)

            notifyListeners("speakComplete", JSObject().apply {
                put("completed", !wasInterrupted)
                if (wasInterrupted) {
                    interruptedAt?.let { put("interruptedAt", it) }
                }
            })

            if (enabled) {
                listeningMode = true
                setState("listening", "Listening")
                mainHandler.post { startListeningInternal(markListening = true) }
            } else {
                // Standalone speak (no active conversation): release the session.
                releaseVoiceAudioSession()
                setState("idle", "Off")
            }
        }
    }

    /**
     * Build the full ElevenLabs request parameters from directive + defaults,
     * applying all validation from the classic TalkModeRuntime.
     */
    private fun buildElevenLabsRequest(text: String, directive: JSObject?): ElevenLabsRequest {
        val effectiveModelId = directive.stringOrNull("modelId")?.takeIf { it.isNotEmpty() }
            ?: modelId
            ?: DEFAULT_MODEL_ID
        val effectiveFormat = validatedOutputFormat(
            directive.stringOrNull("outputFormat") ?: outputFormat
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

        val rawNormalize = directive.stringOrNull("normalize")
        val normalize = validatedNormalize(rawNormalize)

        val rawLanguage = directive.stringOrNull("language")
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

    private fun JSObject?.stringOrNull(key: String): String? {
        if (this == null || !has(key) || isNull(key)) return null
        val value = opt(key)
        return if (value == null || value === JSONObject.NULL) null else value.toString()
    }

    private fun JSONObject?.stringOrNull(key: String): String? {
        if (this == null || !has(key) || isNull(key)) return null
        val value = opt(key)
        return if (value == null || value === JSONObject.NULL) null else value.toString()
    }

    private data class PcmStreamFormat(
        val sampleRate: Int,
        val channels: Int,
        val bitsPerSample: Int,
        val dataBytes: Int
    )

    /**
     * Stream local-inference TTS from the embedded agent and play it natively.
     *
     * The agent currently returns a buffered WAV, but keeping playback in
     * AudioTrack means this path is ready for a chunked PCM/WAV response without
     * going back through WebView decodeAudioData.
     */
    private suspend fun streamAndPlayLocalInferenceTts(
        text: String,
        directive: JSObject?
    ) = withContext(Dispatchers.IO) {
        pcmStopRequested.set(false)
        val conn = openLocalInferenceTtsConnection()
        activePcmConnection = conn
        try {
            val payload = buildLocalInferenceTtsPayload(text, directive)
            conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }

            val code = conn.responseCode
            if (code >= 400) {
                val errBody = conn.errorStream?.readBytes()?.toString(Charsets.UTF_8) ?: ""
                throw IllegalStateException("Local inference TTS error: $code $errBody")
            }

            BufferedInputStream(conn.inputStream).use { input ->
                val format = readWavPcmFormat(input)
                val track = createPcmAudioTrack(format)
                pcmTrack = track
                track.play()

                Log.d(
                    TAG,
                    "Local inference PCM play start sampleRate=${format.sampleRate} channels=${format.channels}"
                )
                notifyListeners("playbackStart", JSObject().apply {
                    put("provider", "local-inference")
                    put("sampleRate", format.sampleRate)
                    put("channels", format.channels)
                })
                val framesWritten = writePcmStreamToTrack(input, track, format)
                drainPcmTrack(track, framesWritten, format.sampleRate)
                if (!pcmStopRequested.get()) {
                    track.stop()
                }
                Log.d(TAG, "Local inference PCM play done frames=$framesWritten")
            }
        } finally {
            cleanupPcmTrack()
            if (activePcmConnection === conn) {
                activePcmConnection = null
            }
            conn.disconnect()
        }
    }

    private fun openLocalInferenceTtsConnection(): HttpURLConnection {
        val tokenFile = File(context.filesDir, "auth/local-agent-token")
        val token = tokenFile.takeIf { it.isFile }?.readText()?.trim().orEmpty()
        if (token.isEmpty()) {
            throw IllegalStateException("Local agent auth token is missing")
        }

        val conn = URL(LOCAL_INFERENCE_TTS_URL).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = 30_000
        conn.readTimeout = 180_000
        conn.setRequestProperty("Authorization", "Bearer $token")
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Accept", "audio/wav")
        conn.doOutput = true
        return conn
    }

    private fun buildLocalInferenceTtsPayload(text: String, directive: JSObject?): String {
        val payload = JSONObject()
        payload.put("text", text)
        directive.stringOrNull("voiceId")?.let { payload.put("voiceId", it) }
        directive.stringOrNull("voice")?.let { payload.put("voice", it) }
        directive.stringOrNull("modelId")?.let { payload.put("modelId", it) }
        directive.stringOrNull("model")?.let { payload.put("model", it) }
        val speed = directive?.optDouble("speed", Double.NaN)
        if (speed != null && speed.isFinite() && speed > 0.0) {
            payload.put("speed", speed)
        }
        return payload.toString()
    }

    private fun readExactly(input: BufferedInputStream, size: Int): ByteArray {
        val bytes = ByteArray(size)
        var offset = 0
        while (offset < size) {
            val read = input.read(bytes, offset, size - offset)
            if (read < 0) {
                throw IllegalStateException("Unexpected end of WAV stream")
            }
            offset += read
        }
        return bytes
    }

    private fun skipFully(input: BufferedInputStream, count: Int) {
        var remaining = count
        while (remaining > 0) {
            val skipped = input.skip(remaining.toLong()).toInt()
            if (skipped > 0) {
                remaining -= skipped
                continue
            }
            if (input.read() < 0) {
                throw IllegalStateException("Unexpected end of WAV stream")
            }
            remaining -= 1
        }
    }

    private fun littleEndianShort(bytes: ByteArray, offset: Int): Int {
        return (bytes[offset].toInt() and 0xff) or
            ((bytes[offset + 1].toInt() and 0xff) shl 8)
    }

    private fun littleEndianInt(bytes: ByteArray, offset: Int): Int {
        return (bytes[offset].toInt() and 0xff) or
            ((bytes[offset + 1].toInt() and 0xff) shl 8) or
            ((bytes[offset + 2].toInt() and 0xff) shl 16) or
            ((bytes[offset + 3].toInt() and 0xff) shl 24)
    }

    private fun chunkId(bytes: ByteArray): String {
        return String(bytes, 0, 4, Charsets.US_ASCII)
    }

    private fun readWavPcmFormat(input: BufferedInputStream): PcmStreamFormat {
        val riff = readExactly(input, 12)
        if (
            String(riff, 0, 4, Charsets.US_ASCII) != "RIFF" ||
            String(riff, 8, 4, Charsets.US_ASCII) != "WAVE"
        ) {
            throw IllegalStateException("Local inference TTS returned non-WAV audio")
        }

        var format: PcmStreamFormat? = null
        while (true) {
            val header = readExactly(input, 8)
            val id = chunkId(header)
            val size = littleEndianInt(header, 4)
            if (size < 0) {
                throw IllegalStateException("Invalid WAV chunk size for $id")
            }

            if (id == "fmt ") {
                val fmt = readExactly(input, size)
                if (fmt.size < 16) {
                    throw IllegalStateException("Invalid WAV fmt chunk")
                }
                val audioFormat = littleEndianShort(fmt, 0)
                val channels = littleEndianShort(fmt, 2)
                val sampleRate = littleEndianInt(fmt, 4)
                val bitsPerSample = littleEndianShort(fmt, 14)
                if (audioFormat != 1) {
                    throw IllegalStateException("Only PCM WAV is supported, got format=$audioFormat")
                }
                if (bitsPerSample != 16) {
                    throw IllegalStateException("Only 16-bit PCM WAV is supported, got bits=$bitsPerSample")
                }
                if (channels !in 1..2 || sampleRate <= 0) {
                    throw IllegalStateException("Invalid WAV format sampleRate=$sampleRate channels=$channels")
                }
                format = PcmStreamFormat(sampleRate, channels, bitsPerSample, 0)
                if (size % 2 == 1) skipFully(input, 1)
                continue
            }

            if (id == "data") {
                val parsed = format ?: throw IllegalStateException("WAV data arrived before fmt chunk")
                return parsed.copy(dataBytes = size)
            }

            skipFully(input, size)
            if (size % 2 == 1) skipFully(input, 1)
        }
    }

    private fun createPcmAudioTrack(format: PcmStreamFormat): AudioTrack {
        val channelMask = when (format.channels) {
            1 -> AudioFormat.CHANNEL_OUT_MONO
            2 -> AudioFormat.CHANNEL_OUT_STEREO
            else -> throw IllegalStateException("Unsupported PCM channel count ${format.channels}")
        }
        val minBuffer = AudioTrack.getMinBufferSize(
            format.sampleRate,
            channelMask,
            AudioFormat.ENCODING_PCM_16BIT
        )
        if (minBuffer <= 0) {
            throw IllegalStateException("AudioTrack buffer size invalid: $minBuffer")
        }
        val bufferSize = max(minBuffer * 2, 8 * 1024)
        val track = AudioTrack.Builder()
            .setAudioAttributes(voiceAudioAttributes())
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(format.sampleRate)
                    .setChannelMask(channelMask)
                    .build()
            )
            .setBufferSizeInBytes(bufferSize)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()

        if (track.state != AudioTrack.STATE_INITIALIZED) {
            track.release()
            throw IllegalStateException("AudioTrack init failed")
        }
        return track
    }

    private fun writePcmStreamToTrack(
        input: BufferedInputStream,
        track: AudioTrack,
        format: PcmStreamFormat
    ): Long {
        val bytesPerFrame = format.channels * (format.bitsPerSample / 8)
        var bytesWrittenTotal = 0L
        var remainingBytes = format.dataBytes
        val buffer = ByteArray(8 * 1024)
        while (remainingBytes > 0) {
            if (pcmStopRequested.get()) break
            val requestBytes = if (remainingBytes < buffer.size) remainingBytes else buffer.size
            val bytesRead = input.read(buffer, 0, requestBytes)
            if (bytesRead <= 0) break
            remainingBytes -= bytesRead

            var offset = 0
            while (offset < bytesRead) {
                if (pcmStopRequested.get()) break
                val wrote = track.write(buffer, offset, bytesRead - offset)
                if (wrote <= 0) {
                    throw IllegalStateException("AudioTrack write failed: $wrote")
                }
                offset += wrote
                bytesWrittenTotal += wrote.toLong()
            }
        }
        return if (bytesPerFrame > 0) bytesWrittenTotal / bytesPerFrame else 0L
    }

    private fun drainPcmTrack(track: AudioTrack, framesWritten: Long, sampleRate: Int) {
        if (framesWritten <= 0L || sampleRate <= 0) return
        val maxDrainMs = (framesWritten * 1000L / sampleRate).coerceAtMost(30_000L) + 1_000L
        val deadline = SystemClock.elapsedRealtime() + maxDrainMs
        while (
            !pcmStopRequested.get() &&
            track.playbackHeadPosition.toLong() < framesWritten &&
            SystemClock.elapsedRealtime() < deadline
        ) {
            SystemClock.sleep(20)
        }
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
            .setAudioAttributes(voiceAudioAttributes())
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
        activePcmConnection = conn
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
            if (activePcmConnection === conn) {
                activePcmConnection = null
            }
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

    // ── Voice audio session ─────────────────────────────────────────────
    //
    // The Android analog of the iOS `.playAndRecord` / `.voiceChat` /
    // `.defaultToSpeaker` session. Putting the device in MODE_IN_COMMUNICATION
    // for the whole conversation routes capture + playback through the
    // telephony path, which engages the platform hardware AEC so TTS coming out
    // the speaker is cancelled from the mic (the core fix for the mic+speaker
    // echo loop in hands-free mode). We also hold voice-communication audio
    // focus and route to the loudspeaker (unless a headset is connected) so
    // hands-free playback is audible.

    private fun voiceAudioAttributes(): AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

    private fun configureVoiceAudioSession() {
        if (audioSessionActive) return
        val am = audioManager ?: return

        savedAudioMode = am.mode
        @Suppress("DEPRECATION")
        savedSpeakerphoneOn = am.isSpeakerphoneOn

        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            .setAudioAttributes(voiceAudioAttributes())
            .setOnAudioFocusChangeListener { focusChange ->
                if (
                    focusChange == AudioManager.AUDIOFOCUS_LOSS ||
                    focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
                ) {
                    // Another app took audio; stop speaking if we are.
                    if (isSpeaking) stopSpeakingInternal()
                }
            }
            .build()
        audioFocusRequest = request
        am.requestAudioFocus(request)

        am.mode = AudioManager.MODE_IN_COMMUNICATION
        routeVoiceOutput(am)
        muteEarconStreams(am)
        audioSessionActive = true
        Log.d(TAG, "Voice audio session active (communication mode)")
    }

    /** Mute the recognizer earcon streams for the session; idempotent. */
    private fun muteEarconStreams(am: AudioManager) {
        if (earconStreamsMuted) return
        for (stream in earconStreams) {
            try {
                am.adjustStreamVolume(stream, AudioManager.ADJUST_MUTE, 0)
            } catch (_: Throwable) {
                // Some OEMs disallow muting certain streams without DND access.
            }
        }
        earconStreamsMuted = true
    }

    private fun unmuteEarconStreams(am: AudioManager) {
        if (!earconStreamsMuted) return
        for (stream in earconStreams) {
            try {
                am.adjustStreamVolume(stream, AudioManager.ADJUST_UNMUTE, 0)
            } catch (_: Throwable) {}
        }
        earconStreamsMuted = false
    }

    /**
     * Default playback to the loudspeaker for hands-free use, but let a wired or
     * Bluetooth headset win — the iOS `.defaultToSpeaker` semantic.
     */
    private fun routeVoiceOutput(am: AudioManager) {
        val hasHeadset = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { device ->
            device.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                device.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                device.type == AudioDeviceInfo.TYPE_USB_HEADSET ||
                device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                device.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
        }
        if (hasHeadset) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = false
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val speaker = am.availableCommunicationDevices.firstOrNull {
                it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
            }
            if (speaker != null && am.setCommunicationDevice(speaker)) return
        }
        @Suppress("DEPRECATION")
        am.isSpeakerphoneOn = true
    }

    private fun releaseVoiceAudioSession() {
        if (!audioSessionActive) return
        val am = audioManager ?: return
        unmuteEarconStreams(am)
        audioFocusRequest?.let { am.abandonAudioFocusRequest(it) }
        audioFocusRequest = null
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
        @Suppress("DEPRECATION")
        am.isSpeakerphoneOn = savedSpeakerphoneOn
        am.mode = savedAudioMode
        audioSessionActive = false
        Log.d(TAG, "Voice audio session released")
    }

    // ── Cleanup helpers ─────────────────────────────────────────────────

    private fun stopSpeakingInternal() {
        pcmStopRequested.set(true)
        val conn = activePcmConnection
        activePcmConnection = null
        conn?.disconnect()
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
        val micGranted = isPermissionGranted(Manifest.permission.RECORD_AUDIO)
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

    private fun isPermissionGranted(permission: String): Boolean {
        if (permission == Manifest.permission.RECORD_AUDIO) {
            return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
        }
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
        releaseVoiceAudioSession()
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
