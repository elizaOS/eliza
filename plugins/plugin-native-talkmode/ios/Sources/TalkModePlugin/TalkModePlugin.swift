import Foundation
import Capacitor
import AVFoundation
import Speech

// MARK: - TalkModePlugin

@objc(TalkModePlugin)
public class TalkModePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TalkModePlugin"
    public let jsName = "TalkMode"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeaking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isSpeaking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
    ]

    private static let defaultModelId = "eleven_flash_v2_5"

    // MARK: - State

    private var enabled = false
    private var state: String = "idle"
    private var statusText: String = "Off"

    // MARK: - Speech Recognition

    private let audioEngine = AVAudioEngine()
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var silenceTask: Task<Void, Never>?
    private var lastTranscript = ""
    private var lastHeard: Date?
    private var silenceWindow: TimeInterval = 0.7

    // MARK: - TTS

    private let systemSynthesizer = AVSpeechSynthesizer()
    private var systemSpeechDelegate: SystemSpeechDelegate?
    private var isSpeakingValue = false
    private var usedSystemTts = false
    private var lastSpokenText: String?
    private var lastInterruptedAtSeconds: Double?

    // MARK: - PCM Streaming Playback

    private var pcmEngine: AVAudioEngine?
    private var pcmPlayerNode: AVAudioPlayerNode?
    private var pcmStopRequested = false
    private var pcmPlaybackStartTime: Date?

    // MARK: - MP3 Playback

    private var audioPlayer: AVAudioPlayer?
    private var mp3PlaybackStartTime: Date?

    // MARK: - Active Tasks

    private var speakTask: Task<Void, Error>?

    // MARK: - Config

    private var apiKey: String?
    private var defaultVoiceId: String?
    private var currentVoiceId: String?
    private var defaultModelId: String? = TalkModePlugin.defaultModelId
    private var currentModelId: String? = TalkModePlugin.defaultModelId
    private var defaultOutputFormat: String? = "pcm_24000"
    private var voiceAliases: [String: String] = [:]
    private var interruptOnSpeech = true
    private var sessionKey = "main"
    private var voiceOverrideActive = false
    private var modelOverrideActive = false

    // MARK: - Lifecycle

    public override func load() {
        speechRecognizer = SFSpeechRecognizer()
    }

    // MARK: - Plugin Methods

    @objc func start(_ call: CAPPluginCall) {
        // Parse config first so STT language is set before availability check
        if let config = call.getObject("config") {
            applyConfig(config)
        }

        guard let recognizer = speechRecognizer, recognizer.isAvailable else {
            call.resolve(["started": false, "error": "Speech recognition not available"])
            return
        }

        Task { @MainActor in
            let micOk = await self.requestMicrophonePermission()
            guard micOk else {
                call.resolve(["started": false, "error": "Microphone permission denied"])
                return
            }

            let speechOk = await self.requestSpeechPermission()
            guard speechOk else {
                call.resolve(["started": false, "error": "Speech recognition permission denied"])
                return
            }

            do {
                try self.configureAudioSession()
                try self.startRecognition()
                self.enabled = true
                self.setState("listening", "Listening")
                self.startSilenceMonitor()
                call.resolve(["started": true])
            } catch {
                self.emitError(code: "start_failed", message: error.localizedDescription, recoverable: true)
                call.resolve(["started": false, "error": error.localizedDescription])
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        enabled = false
        stopRecognition()
        stopSpeakingInternal()
        silenceTask?.cancel()
        silenceTask = nil
        lastTranscript = ""
        lastHeard = nil
        lastInterruptedAtSeconds = nil
        setState("idle", "Off")

        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            // Ignore deactivation errors
        }

        call.resolve()
    }

    @objc func isEnabled(_ call: CAPPluginCall) {
        call.resolve(["enabled": enabled])
    }

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve(["state": state, "statusText": statusText])
    }

    @objc func updateConfig(_ call: CAPPluginCall) {
        guard let config = call.getObject("config") else {
            call.resolve()
            return
        }
        applyConfig(config)
        call.resolve()
    }

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else {
            call.resolve(["completed": true, "interrupted": false, "usedSystemTts": false])
            return
        }

        let useSystemTts = call.getBool("useSystemTts") ?? false
        let directive = call.getObject("directive")

        speakTask?.cancel()
        speakTask = Task { @MainActor in
            await self.speakInternal(text: text, forceSystemTts: useSystemTts, directive: directive, call: call)
        }
    }

    @objc func stopSpeaking(_ call: CAPPluginCall) {
        let interruptedAt = stopSpeakingInternal()
        var result: JSObject = [:]
        if let interruptedAt {
            result["interruptedAt"] = interruptedAt
        }
        call.resolve(result)
    }

    @objc func isSpeaking(_ call: CAPPluginCall) {
        call.resolve(["speaking": isSpeakingValue])
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(buildPermissionResult())
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        Task { @MainActor in
            _ = await self.requestMicrophonePermission()
            _ = await self.requestSpeechPermission()
            call.resolve(self.buildPermissionResult())
        }
    }

    // MARK: - Config Application

    private func applyConfig(_ config: JSObject) {
        if let tts = config["tts"] as? [String: Any] {
            if let key = tts["apiKey"] as? String {
                apiKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let voice = tts["voiceId"] as? String {
                defaultVoiceId = voice.trimmingCharacters(in: .whitespacesAndNewlines)
                if !voiceOverrideActive { currentVoiceId = defaultVoiceId }
            }
            if let model = tts["modelId"] as? String {
                let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
                defaultModelId = trimmed.isEmpty ? Self.defaultModelId : trimmed
                if !modelOverrideActive { currentModelId = defaultModelId }
            }
            if let format = tts["outputFormat"] as? String {
                defaultOutputFormat = format.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let interrupt = tts["interruptOnSpeech"] as? Bool {
                interruptOnSpeech = interrupt
            }

            if let aliases = tts["voiceAliases"] as? [String: String] {
                var normalized: [String: String] = [:]
                for (key, value) in aliases {
                    let k = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                    let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !k.isEmpty, !v.isEmpty { normalized[k] = v }
                }
                voiceAliases = normalized
            }
        }

        if let stt = config["stt"] as? [String: Any] {
            if let lang = stt["language"] as? String, !lang.isEmpty {
                speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: lang))
            }
        }

        if let silenceMs = config["silenceWindowMs"] as? Int, silenceMs > 0 {
            silenceWindow = TimeInterval(silenceMs) / 1000.0
        }

        if let interrupt = config["interruptOnSpeech"] as? Bool {
            interruptOnSpeech = interrupt
        }

        if let key = config["sessionKey"] as? String {
            sessionKey = key
        }
    }

    // MARK: - Speech Recognition

    private func startRecognition() throws {
        #if targetEnvironment(simulator)
        throw NSError(domain: "TalkMode", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Speech recognition not supported on simulator"
        ])
        #endif

        stopRecognition()

        guard let recognizer = speechRecognizer, recognizer.isAvailable else {
            throw NSError(domain: "TalkMode", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Speech recognizer unavailable"
            ])
        }

        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        recognitionRequest?.shouldReportPartialResults = true

        guard let request = recognitionRequest else { return }

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)

        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "TalkMode", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Invalid audio input format"
            ])
        }

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            request.append(buffer)
        }

        audioEngine.prepare()
        try audioEngine.start()

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }

            if let error {
                if !self.isSpeakingValue {
                    print("[TalkMode] Recognition error: \(error.localizedDescription)")
                }
                return
            }

            guard let result else { return }
            let transcript = result.bestTranscription.formattedString

            DispatchQueue.main.async {
                self.handleTranscript(transcript: transcript, isFinal: result.isFinal)
            }
        }
    }

    private func stopRecognition() {
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
    }

    private func handleTranscript(transcript: String, isFinal: Bool) {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)

        // During TTS playback, only listen for interrupt triggers
        if isSpeakingValue, interruptOnSpeech {
            if shouldInterrupt(with: trimmed) {
                stopSpeakingInternal()
            }
            return
        }

        guard enabled else { return }

        if !trimmed.isEmpty {
            lastTranscript = trimmed
            lastHeard = Date()
        }

        if isFinal {
            lastTranscript = trimmed
        }

        notifyListeners("transcript", data: [
            "transcript": trimmed,
            "isFinal": isFinal
        ])
    }

    /// Determines whether detected speech should interrupt current TTS playback.
    /// Filters out echo where the mic picks up our own TTS output.
    private func shouldInterrupt(with transcript: String) -> Bool {
        let trimmed = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 3 else { return false }

        // Echo detection: if the transcript is a substring of the text being spoken,
        // it's likely the microphone picking up the TTS output, not user speech.
        if let spoken = lastSpokenText?.lowercased() {
            let probe = trimmed.lowercased()
            if spoken.contains(probe) { return false }
        }

        return true
    }

    // MARK: - Silence Detection

    private func startSilenceMonitor() {
        silenceTask?.cancel()
        silenceTask = Task { [weak self] in
            while self?.enabled == true {
                try? await Task.sleep(nanoseconds: 200_000_000) // 200ms poll
                // Re-capture `self` explicitly in the inner MainActor
                // closure. Without this, Swift 6 strict concurrency
                // rejects it with:
                //   error: reference to captured var 'self' in
                //   concurrently-executing code
                // because the outer `[weak self]` list does not
                // propagate into the nested `MainActor.run` closure.
                await MainActor.run { [weak self] in self?.checkSilence() }
            }
        }
    }

    /// Check if the user stopped speaking and enough silence has elapsed.
    /// When silence exceeds the configured window, finalize the transcript
    /// so the JS layer can send it to the agent.
    private func checkSilence() {
        guard enabled, !isSpeakingValue, state == "listening" else { return }
        let transcript = lastTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return }
        guard let lastHeard else { return }

        if Date().timeIntervalSince(lastHeard) >= silenceWindow {
            finalizeTranscript(transcript)
        }
    }

    /// Emit the final transcript and transition to processing state.
    /// The JS layer picks this up to send the transcript to the agent.
    private func finalizeTranscript(_ transcript: String) {
        lastTranscript = ""
        lastHeard = nil
        setState("processing", "Processing")
        stopRecognition()

        notifyListeners("transcript", data: [
            "transcript": transcript,
            "isFinal": true
        ])
    }

    // MARK: - TTS Orchestration

    private func speakInternal(
        text: String,
        forceSystemTts: Bool,
        directive: [String: Any]?,
        call: CAPPluginCall
    ) async {
        isSpeakingValue = true
        usedSystemTts = false
        pcmStopRequested = false
        lastSpokenText = text
        setState("speaking", "Speaking")

        // Resolve voice/model from directive, with override persistence
        let requestedVoice = (directive?["voiceId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedVoice = resolveVoiceAlias(requestedVoice)
        let isOnce = directive?["once"] as? Bool ?? false

        if let voice = resolvedVoice, !isOnce {
            currentVoiceId = voice
            voiceOverrideActive = true
        }
        if let model = directive?["modelId"] as? String, !model.isEmpty, !isOnce {
            currentModelId = model
            modelOverrideActive = true
        }

        let effectiveVoiceId = resolvedVoice ?? currentVoiceId ?? defaultVoiceId
        let effectiveModelId = (directive?["modelId"] as? String)
            ?? currentModelId ?? defaultModelId ?? Self.defaultModelId
        let rawFormat = (directive?["outputFormat"] as? String)
            ?? defaultOutputFormat ?? "pcm_24000"
        let effectiveFormat = Self.validatedOutputFormat(rawFormat) ?? "pcm_24000"
        let effectiveApiKey = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines)

        let canUseElevenLabs = !forceSystemTts
            && !(effectiveApiKey ?? "").isEmpty
            && !(effectiveVoiceId ?? "").isEmpty

        notifyListeners("speaking", data: [
            "text": text,
            "isSystemTts": !canUseElevenLabs
        ])

        // Enable STT during playback for interrupt detection
        if interruptOnSpeech {
            do { try startRecognition() } catch {
                print("[TalkMode] Recognition for interrupt detection failed: \(error)")
            }
        } else {
            stopRecognition()
        }

        var interrupted = false
        let language = Self.validatedLanguage(directive?["language"] as? String)

        do {
            if canUseElevenLabs {
                do {
                    try await streamElevenLabsTts(
                        text: text,
                        voiceId: effectiveVoiceId ?? "",
                        apiKey: effectiveApiKey ?? "",
                        modelId: effectiveModelId,
                        outputFormat: effectiveFormat,
                        directive: directive
                    )
                    interrupted = pcmStopRequested
                } catch {
                    // Fallback to system TTS on ElevenLabs failure
                    print("[TalkMode] ElevenLabs failed, falling back to system TTS: \(error)")
                    emitError(
                        code: "elevenlabs_failed",
                        message: error.localizedDescription,
                        recoverable: true
                    )
                    try await speakWithSystemTts(text: text, language: language)
                }
            } else {
                try await speakWithSystemTts(text: text, language: language)
            }
        } catch {
            emitError(code: "tts_failed", message: error.localizedDescription, recoverable: true)
            call.resolve([
                "completed": false,
                "interrupted": false,
                "usedSystemTts": usedSystemTts,
                "error": error.localizedDescription
            ])
            finishSpeaking()
            return
        }

        var result: JSObject = [
            "completed": !interrupted,
            "interrupted": interrupted,
            "usedSystemTts": usedSystemTts
        ]
        if interrupted, let at = lastInterruptedAtSeconds {
            result["interruptedAt"] = at
        }
        call.resolve(result)

        notifyListeners("speakComplete", data: [
            "completed": !interrupted
        ])

        finishSpeaking()
    }

    /// Clean up after speech and restart recognition if talk mode is still enabled.
    private func finishSpeaking() {
        isSpeakingValue = false
        pcmStopRequested = false
        stopRecognition()

        if enabled {
            setState("listening", "Listening")
            do {
                try startRecognition()
                startSilenceMonitor()
            } catch {
                print("[TalkMode] Failed to restart recognition: \(error)")
                emitError(
                    code: "recognition_restart_failed",
                    message: error.localizedDescription,
                    recoverable: true
                )
            }
        } else {
            setState("idle", "Off")
        }
    }

    // MARK: - ElevenLabs Streaming TTS

    private func streamElevenLabsTts(
        text: String,
        voiceId: String,
        apiKey: String,
        modelId: String,
        outputFormat: String,
        directive: [String: Any]?
    ) async throws {
        let urlString = "https://api.elevenlabs.io/v1/text-to-speech/\(voiceId)/stream"
        guard let url = URL(string: urlString) else {
            throw NSError(domain: "TalkMode", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Invalid ElevenLabs URL"
            ])
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "xi-api-key")

        // Build voice settings from directive values
        let speed = Self.resolveSpeed(
            speed: directive?["speed"] as? Double,
            rateWpm: directive?["rateWpm"] as? Int
        )
        let stability = Self.validatedUnit(directive?["stability"] as? Double) ?? 0.5
        let similarity = Self.validatedUnit(directive?["similarity"] as? Double) ?? 0.75

        var voiceSettings: [String: Any] = [
            "stability": stability,
            "similarity_boost": similarity
        ]
        if let speed { voiceSettings["speed"] = speed }
        if let style = Self.validatedUnit(directive?["style"] as? Double) {
            voiceSettings["style"] = style
        }
        if let boost = directive?["speakerBoost"] as? Bool {
            voiceSettings["use_speaker_boost"] = boost
        }

        var body: [String: Any] = [
            "text": text,
            "model_id": modelId,
            "output_format": outputFormat,
            "voice_settings": voiceSettings
        ]
        if let seed = Self.validatedSeed(directive?["seed"] as? Int) {
            body["seed"] = seed
        }
        if let normalize = Self.validatedNormalize(directive?["normalize"] as? String) {
            body["apply_text_normalization"] = normalize
        }
        if let language = Self.validatedLanguage(directive?["language"] as? String) {
            body["language_code"] = language
        }
        if let tier = Self.validatedLatencyTier(directive?["latencyTier"] as? Int) {
            body["optimize_streaming_latency"] = tier
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let isPCM = outputFormat.hasPrefix("pcm_")
        let sampleRate = Self.pcmSampleRate(from: outputFormat)

        if isPCM, let sampleRate {
            do {
                try await streamPCMPlayback(request: request, sampleRate: sampleRate)
            } catch {
                // PCM playback failed; retry as MP3 as a fallback
                guard !pcmStopRequested else { return }
                print("[TalkMode] PCM playback failed, retrying as MP3: \(error)")

                let mp3Format = "mp3_44100_128"
                var retryBody = body
                retryBody["output_format"] = mp3Format

                var retryRequest = request
                retryRequest.httpBody = try JSONSerialization.data(withJSONObject: retryBody)
                try await downloadAndPlayAudio(request: retryRequest)
            }
        } else {
            try await downloadAndPlayAudio(request: request)
        }
    }

    /// Stream PCM audio from the network directly into an AVAudioPlayerNode.
    /// Chunks are scheduled onto the player as they arrive for low-latency playback.
    private func streamPCMPlayback(request: URLRequest, sampleRate: Double) async throws {
        let engine = AVAudioEngine()
        let playerNode = AVAudioPlayerNode()

        let format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: true
        )!

        engine.attach(playerNode)
        engine.connect(playerNode, to: engine.mainMixerNode, format: format)
        try engine.start()

        pcmEngine = engine
        pcmPlayerNode = playerNode
        pcmPlaybackStartTime = Date()
        playerNode.play()

        defer {
            engine.stop()
            pcmEngine = nil
            pcmPlayerNode = nil
        }

        let (bytes, response) = try await URLSession.shared.bytes(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw NSError(domain: "TalkMode", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Invalid HTTP response from ElevenLabs"
            ])
        }

        guard httpResponse.statusCode == 200 else {
            // Read a bit of the error body for diagnostics
            var errorData = Data()
            for try await byte in bytes {
                errorData.append(byte)
                if errorData.count > 2048 { break }
            }
            let errorMsg = String(data: errorData, encoding: .utf8) ?? "status \(httpResponse.statusCode)"
            throw NSError(domain: "TalkMode", code: httpResponse.statusCode, userInfo: [
                NSLocalizedDescriptionKey: "ElevenLabs API error: \(errorMsg)"
            ])
        }

        // Accumulate bytes into chunks; schedule each on the player node.
        // Chunk size is ~0.5s of audio for smooth playback without excessive latency.
        // 16-bit mono PCM: sampleRate * 2 bytes per second.
        let chunkSize = Int(sampleRate) // ~0.5s of 16-bit mono audio
        var buffer = Data()
        var scheduledCount = 0
        let completionGroup = DispatchGroup()

        for try await byte in bytes {
            if pcmStopRequested { break }

            buffer.append(byte)

            if buffer.count >= chunkSize {
                try scheduleChunk(buffer, on: playerNode, format: format, group: completionGroup)
                scheduledCount += 1
                buffer = Data()
            }
        }

        // Schedule any remaining data
        if !buffer.isEmpty, !pcmStopRequested {
            try scheduleChunk(buffer, on: playerNode, format: format, group: completionGroup)
            scheduledCount += 1
        }

        // Wait for all scheduled buffers to finish playback
        if scheduledCount > 0, !pcmStopRequested {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                completionGroup.notify(queue: .main) {
                    continuation.resume()
                }
            }
        }
    }

    /// Create a PCM buffer from raw bytes and schedule it on the player node.
    private func scheduleChunk(
        _ data: Data,
        on playerNode: AVAudioPlayerNode,
        format: AVAudioFormat,
        group: DispatchGroup
    ) throws {
        let frameCount = UInt32(data.count / 2) // 16-bit = 2 bytes per sample
        guard frameCount > 0 else { return }

        guard let pcmBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
            throw NSError(domain: "TalkMode", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Failed to create PCM buffer"
            ])
        }

        pcmBuffer.frameLength = frameCount
        data.withUnsafeBytes { bytes in
            guard let baseAddress = bytes.baseAddress else { return }
            memcpy(pcmBuffer.int16ChannelData![0], baseAddress, data.count)
        }

        group.enter()
        playerNode.scheduleBuffer(pcmBuffer) {
            group.leave()
        }
    }

    /// Download a full audio response (MP3 etc.) and play it with AVAudioPlayer.
    private func downloadAndPlayAudio(request: URLRequest) async throws {
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            let msg = String(data: data.prefix(2048), encoding: .utf8) ?? "Unknown error"
            throw NSError(domain: "TalkMode", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "ElevenLabs API error: \(msg)"
            ])
        }

        mp3PlaybackStartTime = Date()

        let player = try AVAudioPlayer(data: data)
        audioPlayer = player
        player.prepareToPlay()

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let delegate = AudioPlayerDelegate {
                continuation.resume()
            }
            // Retain delegate for the lifetime of playback
            objc_setAssociatedObject(player, "delegate", delegate, .OBJC_ASSOCIATION_RETAIN)
            player.delegate = delegate
            player.play()
        }

        audioPlayer = nil
        mp3PlaybackStartTime = nil
    }

    // MARK: - System TTS

    private func speakWithSystemTts(text: String, language: String? = nil) async throws {
        usedSystemTts = true
        setState("speaking", "Speaking (System)")

        let utterance = AVSpeechUtterance(string: text)
        if let language, let voice = AVSpeechSynthesisVoice(language: language) {
            utterance.voice = voice
        } else {
            let lang = Locale.current.languageCode ?? "en"
            utterance.voice = AVSpeechSynthesisVoice(language: lang)
        }

        // Watchdog timeout: estimate from text length (0.08s per character, bounded)
        let estimatedSeconds = max(3.0, min(180.0, Double(text.count) * 0.08))

        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                let delegate = SystemSpeechDelegate(continuation: cont)
                self.systemSpeechDelegate = delegate // retain
                self.systemSynthesizer.delegate = delegate
                self.systemSynthesizer.speak(utterance)

                // Watchdog: force-finish if TTS takes too long
                delegate.watchdog = Task { @MainActor in
                    try? await Task.sleep(nanoseconds: UInt64(estimatedSeconds * 1_000_000_000))
                    guard !delegate.isFinished else { return }
                    self.systemSynthesizer.stopSpeaking(at: .immediate)
                    delegate.finish(error: NSError(domain: "TalkMode", code: 408, userInfo: [
                        NSLocalizedDescriptionKey: "System TTS timed out after \(Int(estimatedSeconds))s"
                    ]))
                }
            }
        } onCancel: {
            Task { @MainActor in
                self.systemSynthesizer.stopSpeaking(at: .immediate)
                self.systemSpeechDelegate?.finish(
                    error: NSError(domain: "TalkMode", code: -999, userInfo: [
                        NSLocalizedDescriptionKey: "System TTS cancelled"
                    ])
                )
            }
        }
    }

    // MARK: - Stop Speaking

    /// Stop all TTS playback. Returns the interrupted-at time in seconds, if available.
    @discardableResult
    private func stopSpeakingInternal() -> Double? {
        guard isSpeakingValue else { return nil }

        pcmStopRequested = true

        // Compute how far into playback we were
        var interruptedAt: Double?
        if let start = pcmPlaybackStartTime {
            interruptedAt = Date().timeIntervalSince(start)
        } else if let start = mp3PlaybackStartTime {
            interruptedAt = Date().timeIntervalSince(start)
        }
        lastInterruptedAtSeconds = interruptedAt

        // Stop PCM streaming engine
        pcmPlayerNode?.stop()
        pcmEngine?.stop()
        pcmEngine = nil
        pcmPlayerNode = nil
        pcmPlaybackStartTime = nil

        // Stop MP3 player
        audioPlayer?.stop()
        audioPlayer = nil
        mp3PlaybackStartTime = nil

        // Stop system TTS
        systemSynthesizer.stopSpeaking(at: .immediate)
        systemSpeechDelegate?.finish(
            error: NSError(domain: "TalkMode", code: -1, userInfo: [
                NSLocalizedDescriptionKey: "Speech interrupted by user"
            ])
        )

        // Cancel in-flight speak task
        speakTask?.cancel()

        isSpeakingValue = false

        return interruptedAt
    }

    // MARK: - Permissions

    private func requestMicrophonePermission() async -> Bool {
        await withCheckedContinuation { continuation in
            if #available(iOS 17.0, *) {
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            } else {
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        }
    }

    private func requestSpeechPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    private func buildPermissionResult() -> JSObject {
        let micStatus: String
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: micStatus = "granted"
        case .denied: micStatus = "denied"
        case .undetermined: micStatus = "prompt"
        @unknown default: micStatus = "prompt"
        }

        let speechStatus: String
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: speechStatus = "granted"
        case .denied: speechStatus = "denied"
        case .notDetermined: speechStatus = "prompt"
        case .restricted: speechStatus = "denied"
        @unknown default: speechStatus = "prompt"
        }

        return [
            "microphone": micStatus,
            "speechRecognition": speechStatus
        ]
    }

    // MARK: - Audio Session

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [
            .duckOthers,
            .mixWithOthers,
            .allowBluetoothA2DP,
            .defaultToSpeaker
        ])
        try session.setActive(true)
    }

    // MARK: - State & Events

    private func setState(_ newState: String, _ newStatusText: String) {
        let previousState = state
        state = newState
        statusText = newStatusText

        notifyListeners("stateChange", data: [
            "state": newState,
            "previousState": previousState,
            "statusText": newStatusText,
            "usingSystemTts": usedSystemTts
        ])
    }

    private func emitError(code: String, message: String, recoverable: Bool) {
        notifyListeners("error", data: [
            "code": code,
            "message": message,
            "recoverable": recoverable
        ])
    }

    // MARK: - Voice Alias Resolution

    private func resolveVoiceAlias(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }

        let normalized = trimmed.lowercased()

        // Check alias map
        if let mapped = voiceAliases[normalized] { return mapped }

        // Check if the value is already a known voice ID in aliases values
        if voiceAliases.values.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
            return trimmed
        }

        // If it looks like a raw ElevenLabs voice ID (alphanumeric, 10+ chars), pass through
        if trimmed.count >= 10,
           trimmed.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }) {
            return trimmed
        }

        return nil
    }

    // MARK: - TTS Parameter Validation

    /// Resolve speed from either explicit speed or words-per-minute rate.
    /// ElevenLabs accepts 0.5–2.0; WPM is normalized against 175 WPM baseline.
    private static func resolveSpeed(speed: Double?, rateWpm: Int?) -> Double? {
        if let rateWpm, rateWpm > 0 {
            let resolved = Double(rateWpm) / 175.0
            guard resolved >= 0.5, resolved <= 2.0 else { return nil }
            return resolved
        }
        if let speed {
            guard speed >= 0.5, speed <= 2.0 else { return nil }
            return speed
        }
        return nil
    }

    /// Validate a 0–1 unit range parameter (stability, similarity, style).
    private static func validatedUnit(_ value: Double?) -> Double? {
        guard let value, value >= 0, value <= 1 else { return nil }
        return value
    }

    /// Validate seed (unsigned 32-bit integer range).
    private static func validatedSeed(_ value: Int?) -> Int? {
        guard let value, value >= 0, value <= 4_294_967_295 else { return nil }
        return value
    }

    /// Validate text normalization mode (auto/on/off).
    private static func validatedNormalize(_ value: String?) -> String? {
        guard let value else { return nil }
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["auto", "on", "off"].contains(normalized) ? normalized : nil
    }

    /// Validate language code (2-letter ISO only).
    static func validatedLanguage(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard trimmed.count == 2, trimmed.allSatisfy({ $0.isLetter }) else { return nil }
        return trimmed
    }

    /// Validate latency optimization tier (1–4).
    private static func validatedLatencyTier(_ value: Int?) -> Int? {
        guard let value, value >= 1, value <= 4 else { return nil }
        return value
    }

    /// Validate ElevenLabs output format string.
    static func validatedOutputFormat(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let validFormats: Set<String> = [
            "mp3_22050_32", "mp3_44100_32", "mp3_44100_64",
            "mp3_44100_96", "mp3_44100_128", "mp3_44100_192",
            "pcm_16000", "pcm_22050", "pcm_24000", "pcm_44100",
            "ulaw_8000"
        ]
        return validFormats.contains(trimmed) ? trimmed : nil
    }

    /// Extract sample rate from a PCM output format string (e.g. "pcm_24000" → 24000).
    static func pcmSampleRate(from format: String?) -> Double? {
        guard let format, format.hasPrefix("pcm_") else { return nil }
        if format.contains("44100") { return 44100 }
        if format.contains("24000") { return 24000 }
        if format.contains("22050") { return 22050 }
        if format.contains("16000") { return 16000 }
        return nil
    }
}

// MARK: - SystemSpeechDelegate

/// Delegate for AVSpeechSynthesizer that bridges the callback-based API to async/await
/// via a CheckedContinuation, with a watchdog timeout for safety.
private class SystemSpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
    private var continuation: CheckedContinuation<Void, Error>?
    var isFinished = false
    var watchdog: Task<Void, Never>?

    init(continuation: CheckedContinuation<Void, Error>) {
        self.continuation = continuation
        super.init()
    }

    func finish(error: Error? = nil) {
        guard !isFinished else { return }
        isFinished = true
        watchdog?.cancel()
        watchdog = nil
        let cont = continuation
        continuation = nil
        if let error {
            cont?.resume(throwing: error)
        } else {
            cont?.resume(returning: ())
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        finish()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        finish(error: NSError(domain: "TalkMode", code: -1, userInfo: [
            NSLocalizedDescriptionKey: "System TTS cancelled"
        ]))
    }
}

// MARK: - AudioPlayerDelegate

/// Delegate for AVAudioPlayer (MP3 playback) that signals completion via a closure.
private class AudioPlayerDelegate: NSObject, AVAudioPlayerDelegate {
    private var onComplete: (() -> Void)?

    init(onComplete: @escaping () -> Void) {
        self.onComplete = onComplete
        super.init()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        onComplete?()
        onComplete = nil
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        onComplete?()
        onComplete = nil
    }
}
