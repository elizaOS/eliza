package ai.eliza.plugins.swabble

import android.Manifest
import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.*
import java.util.Locale
import kotlin.math.abs
import kotlin.math.min

/**
 * Swabble (Voice Wake) Plugin for Capacitor Android
 *
 * Provides continuous voice wake word detection and speech-to-text using
 * Android SpeechRecognizer with Levenshtein fuzzy matching, state machine,
 * audio focus, and device enumeration.
 *
 * State machine: idle → listening → triggered → capturing → listening
 */
@CapacitorPlugin(
    name = "Swabble",
    permissions = [
        Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])
    ]
)
class SwabblePlugin : Plugin() {

    // ── State ───────────────────────────────────────────────────────────

    private var speechRecognizer: SpeechRecognizer? = null
    private var config: SwabbleConfig? = null
    private var currentState = SwabbleState.IDLE
    private var lastTranscript = ""
    private var lastDispatchedCommand: String? = null
    private var segments = mutableListOf<SpeechSegment>()
    private val scope = CoroutineScope(Dispatchers.Main + SupervisorJob())
    private var restartJob: Job? = null
    private var silenceJob: Job? = null
    private var segmentStartTime = 0L
    private var pendingCall: PluginCall? = null
    private var stopRequested = false

    // Audio focus
    private var audioManager: AudioManager? = null
    private var audioFocusRequest: AudioFocusRequest? = null
    private var hasAudioFocus = false
    private var selectedDeviceId: String? = null

    // Silence detection
    private var lastSpeechTime = 0L
    private val silenceThresholdMs = 1500L // ms of silence before ending capture

    // ── Data classes ────────────────────────────────────────────────────

    enum class SwabbleState(val value: String) {
        IDLE("idle"),
        LISTENING("listening"),
        TRIGGERED("triggered"),
        CAPTURING("capturing"),
        ERROR("error")
    }

    data class SwabbleConfig(
        var triggers: List<String>,
        var minPostTriggerGap: Double,
        var minCommandLength: Int,
        var locale: String,
        var sampleRate: Int
    ) {
        companion object {
            fun fromJSObject(obj: JSObject): SwabbleConfig {
                val triggersArray = obj.optJSONArray("triggers")
                val triggers = if (triggersArray != null) {
                    (0 until triggersArray.length()).map { triggersArray.getString(it) }
                } else {
                    listOf("eliza")
                }

                return SwabbleConfig(
                    triggers = triggers,
                    minPostTriggerGap = obj.optDouble("minPostTriggerGap", 0.45),
                    minCommandLength = obj.optInt("minCommandLength", 1),
                    locale = obj.optString("locale", Locale.getDefault().toLanguageTag()),
                    sampleRate = obj.optInt("sampleRate", 16000)
                )
            }
        }

        fun toJSObject(): JSObject {
            val obj = JSObject()
            obj.put("triggers", JSArray(triggers))
            obj.put("minPostTriggerGap", minPostTriggerGap)
            obj.put("minCommandLength", minCommandLength)
            obj.put("locale", locale)
            obj.put("sampleRate", sampleRate)
            return obj
        }
    }

    data class SpeechSegment(
        val text: String,
        val start: Double,
        val duration: Double
    ) {
        val end: Double get() = start + duration
    }

    data class WakeWordMatch(
        val wakeWord: String,
        val command: String,
        val postGap: Double
    )

    // ── Plugin methods ──────────────────────────────────────────────────

    @PluginMethod
    fun start(call: PluginCall) {
        val configObj = call.getObject("config")
        if (configObj == null) {
            call.reject("Missing config parameter")
            return
        }

        config = SwabbleConfig.fromJSObject(configObj)

        if (!hasRequiredPermissions()) {
            pendingCall = call
            requestPermissionForAlias("microphone", call, "handlePermissionResult")
            return
        }

        startRecognition(call)
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        stopRecognitionInternal()
        transitionState(SwabbleState.IDLE)
        call.resolve()
    }

    @PluginMethod
    fun isListening(call: PluginCall) {
        call.resolve(JSObject().apply {
            put("listening", currentState == SwabbleState.LISTENING ||
                    currentState == SwabbleState.TRIGGERED ||
                    currentState == SwabbleState.CAPTURING)
        })
    }

    @PluginMethod
    fun getConfig(call: PluginCall) {
        val result = JSObject()
        config?.let {
            result.put("config", it.toJSObject())
        } ?: result.put("config", JSObject.NULL)
        call.resolve(result)
    }

    @PluginMethod
    fun updateConfig(call: PluginCall) {
        val configObj = call.getObject("config")
        if (configObj == null) {
            call.reject("Missing config parameter")
            return
        }

        config?.let { current ->
            configObj.optJSONArray("triggers")?.let { arr ->
                current.triggers = (0 until arr.length()).map { arr.getString(it) }
            }
            if (configObj.has("minPostTriggerGap")) {
                current.minPostTriggerGap = configObj.getDouble("minPostTriggerGap")
            }
            if (configObj.has("minCommandLength")) {
                current.minCommandLength = configObj.getInt("minCommandLength")
            }
            if (configObj.has("locale")) {
                current.locale = configObj.getString("locale")!!
            }
            if (configObj.has("sampleRate")) {
                current.sampleRate = configObj.getInt("sampleRate")
            }
            config = current
        }

        call.resolve()
    }

    @PluginMethod
    override fun checkPermissions(call: PluginCall) {
        call.resolve(buildPermissionResult())
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        requestPermissionForAlias("microphone", call, "handlePermissionCheckResult")
    }

    @PluginMethod
    fun getAudioDevices(call: PluginCall) {
        val am = getAudioManager()
        val devices = JSArray()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val inputDevices = am.getDevices(AudioManager.GET_DEVICES_INPUTS)
            for (device in inputDevices) {
                devices.put(JSObject().apply {
                    put("id", device.id.toString())
                    put("name", getDeviceTypeName(device.type) +
                            if (device.productName.isNotEmpty()) " (${device.productName})" else "")
                    put("isDefault", device.id.toString() == (selectedDeviceId ?: inputDevices.firstOrNull()?.id?.toString()))
                })
            }
        }

        // Always include a default entry if no devices found
        if (devices.length() == 0) {
            devices.put(JSObject().apply {
                put("id", "default")
                put("name", "Default Microphone")
                put("isDefault", true)
            })
        }

        call.resolve(JSObject().apply {
            put("devices", devices)
        })
    }

    @PluginMethod
    fun setAudioDevice(call: PluginCall) {
        val deviceId = call.getString("deviceId")
        if (deviceId == null) {
            call.reject("Missing deviceId")
            return
        }

        selectedDeviceId = deviceId

        // If using API 23+ and currently recording, try to route to the device
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val am = getAudioManager()
            val inputDevices = am.getDevices(AudioManager.GET_DEVICES_INPUTS)
            val target = inputDevices.find { it.id.toString() == deviceId }
            if (target != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                speechRecognizer?.let {
                    // SpeechRecognizer doesn't expose preferred device directly;
                    // store the preference for next recognition session
                }
            }
        }

        call.resolve()
    }

    // ── Permission callbacks ────────────────────────────────────────────

    @PermissionCallback
    private fun handlePermissionResult(call: PluginCall) {
        if (hasRequiredPermissions()) {
            startRecognition(call)
        } else {
            call.resolve(JSObject().apply {
                put("started", false)
                put("error", "Microphone permission denied")
            })
        }
    }

    @PermissionCallback
    private fun handlePermissionCheckResult(call: PluginCall) {
        call.resolve(buildPermissionResult())
    }

    // ── Recognition lifecycle ───────────────────────────────────────────

    private fun startRecognition(call: PluginCall) {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            call.resolve(JSObject().apply {
                put("started", false)
                put("error", "Speech recognition not available on this device")
            })
            return
        }

        val cfg = config
        if (cfg == null) {
            call.reject("Configuration not set")
            return
        }

        // Stop any existing recognition
        stopRecognitionInternal()
        stopRequested = false

        // Request audio focus
        requestAudioFocus()

        activity.runOnUiThread {
            try {
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context)
                speechRecognizer?.setRecognitionListener(createRecognitionListener())

                segmentStartTime = System.currentTimeMillis()
                lastSpeechTime = segmentStartTime
                speechRecognizer?.startListening(createRecognitionIntent(cfg))

                transitionState(SwabbleState.LISTENING)

                call.resolve(JSObject().apply {
                    put("started", true)
                })
            } catch (err: Throwable) {
                transitionState(SwabbleState.ERROR, "Start failed: ${err.message}")
                call.resolve(JSObject().apply {
                    put("started", false)
                    put("error", err.message ?: "Unknown error")
                })
            }
        }
    }

    private fun stopRecognitionInternal() {
        stopRequested = true
        restartJob?.cancel()
        restartJob = null
        silenceJob?.cancel()
        silenceJob = null
        lastDispatchedCommand = null

        activity.runOnUiThread {
            speechRecognizer?.stopListening()
            speechRecognizer?.cancel()
            speechRecognizer?.destroy()
            speechRecognizer = null
        }

        abandonAudioFocus()
        segments.clear()
        lastTranscript = ""
    }

    private fun createRecognitionIntent(config: SwabbleConfig): Intent {
        return Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, config.locale)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        }
    }

    private fun createRecognitionListener(): RecognitionListener {
        return object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                if (currentState != SwabbleState.CAPTURING) {
                    transitionState(SwabbleState.LISTENING)
                }
            }

            override fun onBeginningOfSpeech() {
                lastSpeechTime = System.currentTimeMillis()
            }

            override fun onRmsChanged(rmsdB: Float) {
                // RMS is typically -2 to 10 dB; normalize to 0..1
                val level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
                notifyListeners("audioLevel", JSObject().apply {
                    put("level", level.toDouble())
                    put("peak", level.toDouble())
                })

                // Track speech activity for silence detection
                if (rmsdB > 0f) {
                    lastSpeechTime = System.currentTimeMillis()
                }
            }

            override fun onBufferReceived(buffer: ByteArray?) {
                // Not used
            }

            override fun onEndOfSpeech() {
                // SpeechRecognizer finished a segment; will restart if still active
                if (currentState == SwabbleState.CAPTURING) {
                    startSilenceTimer()
                }
            }

            override fun onError(error: Int) {
                if (stopRequested) return

                val errorMessage = getErrorMessage(error)
                val recoverable = error == SpeechRecognizer.ERROR_NO_MATCH ||
                        error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ||
                        error == SpeechRecognizer.ERROR_CLIENT

                notifyListeners("error", JSObject().apply {
                    put("code", error.toString())
                    put("message", errorMessage)
                    put("recoverable", recoverable)
                })

                if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                    transitionState(SwabbleState.ERROR, "Microphone permission required")
                    return
                }

                if (recoverable) {
                    scheduleRestart(delayMs = 500)
                } else {
                    transitionState(SwabbleState.ERROR, errorMessage)
                    // Try to recover from non-fatal errors after a longer delay
                    scheduleRestart(delayMs = 2000)
                }
            }

            override fun onResults(results: Bundle?) {
                handleResults(results, isFinal = true)

                if (!stopRequested) {
                    // After final results, restart for continuous listening
                    scheduleRestart(delayMs = 350)
                }
            }

            override fun onPartialResults(partialResults: Bundle?) {
                handleResults(partialResults, isFinal = false)
            }

            override fun onEvent(eventType: Int, params: Bundle?) {
                // Not used
            }
        }
    }

    // ── Result handling ─────────────────────────────────────────────────

    private fun handleResults(results: Bundle?, isFinal: Boolean) {
        val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
        val confidence = results?.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES)

        if (matches.isNullOrEmpty()) return

        val transcript = matches[0]
        if (transcript.isBlank()) return

        // Build estimated segments from words
        val words = transcript.split("\\s+".toRegex()).filter { it.isNotEmpty() }
        val avgWordDuration = 0.3
        segments.clear()
        var time = 0.0

        for (word in words) {
            segments.add(SpeechSegment(
                text = word,
                start = time,
                duration = avgWordDuration
            ))
            time += avgWordDuration + 0.1
        }

        // Build JS segments array
        val jsSegments = JSArray()
        for (segment in segments) {
            jsSegments.put(JSObject().apply {
                put("text", segment.text)
                put("start", segment.start)
                put("duration", segment.duration)
                put("isFinal", isFinal)
            })
        }

        // Emit transcript event
        notifyListeners("transcript", JSObject().apply {
            put("transcript", transcript)
            put("segments", jsSegments)
            put("isFinal", isFinal)
            put("confidence", confidence?.firstOrNull()?.toDouble() ?: 0.0)
        })

        // Check for wake word — use all recognition alternatives for robustness
        val cfg = config ?: return
        for (alternative in matches) {
            val match = matchWakeWord(alternative, segments, cfg)
            if (match != null) {
                // Dedup: skip if we already dispatched this exact command
                if (match.command == lastDispatchedCommand) continue
                lastDispatchedCommand = match.command

                transitionState(SwabbleState.TRIGGERED)

                notifyListeners("wakeWord", JSObject().apply {
                    put("wakeWord", match.wakeWord)
                    put("command", match.command)
                    put("transcript", alternative)
                    put("postGap", match.postGap)
                    put("confidence", confidence?.firstOrNull()?.toDouble() ?: 0.0)
                })

                // Move to capturing state briefly, then back to listening
                scope.launch {
                    transitionState(SwabbleState.CAPTURING)
                    delay(650)
                    if (currentState == SwabbleState.CAPTURING && !stopRequested) {
                        transitionState(SwabbleState.LISTENING)
                    }
                }

                break
            }
        }

        lastTranscript = transcript
    }

    // ── Wake word matching (regex + Levenshtein fuzzy) ──────────────────

    /**
     * Two-pass wake word matching:
     * 1. Exact regex match (ported from classic VoiceWakeCommandExtractor)
     * 2. Fuzzy match using Levenshtein distance for misheard trigger words
     */
    private fun matchWakeWord(
        transcript: String,
        segments: List<SpeechSegment>,
        config: SwabbleConfig
    ): WakeWordMatch? {
        // Pass 1: exact regex match (from classic VoiceWakeCommandExtractor)
        for (trigger in config.triggers) {
            val command = extractCommandExact(transcript, trigger)
            if (command != null && command.length >= config.minCommandLength) {
                return WakeWordMatch(
                    wakeWord = trigger,
                    command = command,
                    postGap = config.minPostTriggerGap
                )
            }
        }

        // Pass 2: fuzzy match using Levenshtein distance
        val words = transcript.split("\\s+".toRegex()).filter { it.isNotEmpty() }
        for ((wordIndex, _) in words.withIndex()) {
            for (trigger in config.triggers) {
                val triggerWords = trigger.split("\\s+".toRegex()).filter { it.isNotEmpty() }
                val triggerLen = triggerWords.size

                // Check if enough words remain to form the trigger
                if (wordIndex + triggerLen > words.size) continue

                val candidate = words.subList(wordIndex, wordIndex + triggerLen).joinToString(" ")
                val distance = levenshteinDistance(candidate.lowercase(), trigger.lowercase())
                val maxLen = maxOf(candidate.length, trigger.length)

                // Accept if within 30% edit distance (fuzzy threshold)
                if (maxLen > 0 && distance.toDouble() / maxLen <= 0.3) {
                    val commandStart = wordIndex + triggerLen
                    if (commandStart >= words.size) continue

                    val command = words.subList(commandStart, words.size).joinToString(" ").trim()
                    if (command.length < config.minCommandLength) continue

                    // Estimate post-trigger gap from segments
                    val gap = if (commandStart < segments.size && wordIndex + triggerLen - 1 < segments.size) {
                        val triggerEnd = segments[wordIndex + triggerLen - 1].end
                        val commandBegin = segments[commandStart].start
                        commandBegin - triggerEnd
                    } else {
                        config.minPostTriggerGap
                    }

                    return WakeWordMatch(
                        wakeWord = trigger,
                        command = cleanCommand(command),
                        postGap = gap
                    )
                }
            }
        }

        return null
    }

    /**
     * Exact command extraction using regex — ported from classic
     * VoiceWakeCommandExtractor.extractCommand()
     */
    private fun extractCommandExact(text: String, trigger: String): String? {
        val raw = text.trim()
        if (raw.isEmpty()) return null

        val normalizedTrigger = trigger.trim().lowercase()
        if (normalizedTrigger.isEmpty()) return null

        val escaped = Regex.escape(normalizedTrigger)
        val regex = Regex("(?i)(?:^|\\s)($escaped)\\b[\\s\\p{Punct}]*([\\s\\S]+)$")
        val match = regex.find(raw) ?: return null
        val extracted = match.groupValues.getOrNull(2)?.trim() ?: return null
        if (extracted.isEmpty()) return null

        return cleanCommand(extracted)
    }

    /** Strip leading punctuation/whitespace from a command string. */
    private fun cleanCommand(text: String): String {
        return text.trimStart { it.isWhitespace() || it.isPunctuation() }.trim()
    }

    private fun Char.isPunctuation(): Boolean {
        return when (Character.getType(this)) {
            Character.CONNECTOR_PUNCTUATION.toInt(),
            Character.DASH_PUNCTUATION.toInt(),
            Character.START_PUNCTUATION.toInt(),
            Character.END_PUNCTUATION.toInt(),
            Character.INITIAL_QUOTE_PUNCTUATION.toInt(),
            Character.FINAL_QUOTE_PUNCTUATION.toInt(),
            Character.OTHER_PUNCTUATION.toInt() -> true
            else -> false
        }
    }

    /**
     * Levenshtein edit distance between two strings.
     * Used for fuzzy trigger word matching (handles speech recognition errors).
     */
    private fun levenshteinDistance(a: String, b: String): Int {
        val m = a.length
        val n = b.length
        if (m == 0) return n
        if (n == 0) return m

        // Single-row DP to save memory
        var prev = IntArray(n + 1) { it }
        var curr = IntArray(n + 1)

        for (i in 1..m) {
            curr[0] = i
            for (j in 1..n) {
                val cost = if (a[i - 1] == b[j - 1]) 0 else 1
                curr[j] = minOf(
                    prev[j] + 1,       // deletion
                    curr[j - 1] + 1,   // insertion
                    prev[j - 1] + cost  // substitution
                )
            }
            val tmp = prev
            prev = curr
            curr = tmp
        }
        return prev[n]
    }

    // ── State machine ───────────────────────────────────────────────────

    private fun transitionState(newState: SwabbleState, reason: String? = null) {
        if (currentState == newState) return
        currentState = newState

        notifyListeners("stateChange", JSObject().apply {
            put("state", newState.value)
            if (reason != null) {
                put("reason", reason)
            }
        })
    }

    // ── Restart / silence detection ─────────────────────────────────────

    private fun scheduleRestart(delayMs: Long = 350) {
        if (stopRequested) return
        restartJob?.cancel()
        restartJob = scope.launch {
            delay(delayMs)
            if (!stopRequested) {
                activity.runOnUiThread {
                    if (stopRequested) return@runOnUiThread
                    try {
                        val cfg = config ?: return@runOnUiThread
                        segmentStartTime = System.currentTimeMillis()
                        lastSpeechTime = segmentStartTime
                        lastDispatchedCommand = null
                        speechRecognizer?.cancel()
                        speechRecognizer?.startListening(createRecognitionIntent(cfg))
                    } catch (_: Throwable) {
                        // Will be picked up by onError and retried
                    }
                }
            }
        }
    }

    /** Start a silence timer during capture state; return to listening if silence exceeds threshold. */
    private fun startSilenceTimer() {
        silenceJob?.cancel()
        silenceJob = scope.launch {
            delay(silenceThresholdMs)
            if (currentState == SwabbleState.CAPTURING && !stopRequested) {
                transitionState(SwabbleState.LISTENING)
            }
        }
    }

    // ── Audio focus ─────────────────────────────────────────────────────

    private fun getAudioManager(): AudioManager {
        if (audioManager == null) {
            audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        }
        return audioManager!!
    }

    private fun requestAudioFocus() {
        val am = getAudioManager()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setOnAudioFocusChangeListener { focusChange ->
                    when (focusChange) {
                        AudioManager.AUDIOFOCUS_LOSS -> {
                            // Another app took focus permanently — stop
                            if (!stopRequested) {
                                stopRecognitionInternal()
                                transitionState(SwabbleState.IDLE, "Audio focus lost")
                            }
                        }
                        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                            // Temporary loss (e.g. phone call) — pause
                            notifyListeners("error", JSObject().apply {
                                put("code", "AUDIO_FOCUS_LOST")
                                put("message", "Audio focus temporarily lost")
                                put("recoverable", true)
                            })
                        }
                        AudioManager.AUDIOFOCUS_GAIN -> {
                            hasAudioFocus = true
                        }
                    }
                }
                .build()

            audioFocusRequest = focusRequest
            val result = am.requestAudioFocus(focusRequest)
            hasAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else {
            @Suppress("DEPRECATION")
            val result = am.requestAudioFocus(
                { /* legacy listener */ },
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK
            )
            hasAudioFocus = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
    }

    private fun abandonAudioFocus() {
        val am = getAudioManager()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { am.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            am.abandonAudioFocus(null)
        }
        hasAudioFocus = false
        audioFocusRequest = null
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    override fun hasRequiredPermissions(): Boolean {
        return getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED
    }

    private fun buildPermissionResult(): JSObject {
        val micStatus = getPermissionState("microphone")
        val speechAvailable = SpeechRecognizer.isRecognitionAvailable(context)

        return JSObject().apply {
            put("microphone", when (micStatus) {
                com.getcapacitor.PermissionState.GRANTED -> "granted"
                com.getcapacitor.PermissionState.DENIED -> "denied"
                else -> "prompt"
            })
            put("speechRecognition", if (speechAvailable) "granted" else "not_supported")
        }
    }

    private fun getErrorMessage(error: Int): String {
        return when (error) {
            SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
            SpeechRecognizer.ERROR_CLIENT -> "Client error"
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Insufficient permissions"
            SpeechRecognizer.ERROR_NETWORK -> "Network error"
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
            SpeechRecognizer.ERROR_NO_MATCH -> "No speech match"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy"
            SpeechRecognizer.ERROR_SERVER -> "Server error"
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "Speech timeout"
            else -> "Unknown error: $error"
        }
    }

    /** Human-readable name for AudioDeviceInfo types. */
    private fun getDeviceTypeName(type: Int): String {
        return when (type) {
            AudioDeviceInfo.TYPE_BUILTIN_MIC -> "Built-in Microphone"
            AudioDeviceInfo.TYPE_WIRED_HEADSET -> "Wired Headset"
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "Bluetooth SCO"
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "Bluetooth A2DP"
            AudioDeviceInfo.TYPE_USB_DEVICE -> "USB Device"
            AudioDeviceInfo.TYPE_USB_ACCESSORY -> "USB Accessory"
            AudioDeviceInfo.TYPE_TELEPHONY -> "Telephony"
            else -> "Audio Input"
        }
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    override fun handleOnDestroy() {
        super.handleOnDestroy()
        stopRecognitionInternal()
        scope.cancel()
    }
}
