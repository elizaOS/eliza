import Foundation
import Capacitor
import Speech
import AVFoundation

// ═══════════════════════════════════════════════════════════════════════════════
// MARK: - Thread-safe Audio Buffer Queue
// ═══════════════════════════════════════════════════════════════════════════════

/// Audio tap callbacks fire on a realtime audio thread. We deep-copy buffers into a
/// lock-protected queue and drain them on a main-thread timer for the speech recognition
/// request. This keeps the audio callback tiny and avoids blocking the realtime thread.
/// Pattern: thread-safe lock-protected queue drained on a main-thread timer.
private final class AudioBufferQueue: @unchecked Sendable {
    private let lock = NSLock()
    private var buffers: [AVAudioPCMBuffer] = []

    func enqueue(_ buffer: AVAudioPCMBuffer) {
        guard let copy = buffer.deepCopy() else { return }
        lock.lock()
        buffers.append(copy)
        lock.unlock()
    }

    func drain() -> [AVAudioPCMBuffer] {
        lock.lock()
        let result = buffers
        buffers.removeAll(keepingCapacity: true)
        lock.unlock()
        return result
    }

    func clear() {
        lock.lock()
        buffers.removeAll(keepingCapacity: false)
        lock.unlock()
    }
}

private extension AVAudioPCMBuffer {
    func deepCopy() -> AVAudioPCMBuffer? {
        let fmt = format
        let len = frameLength
        guard let copy = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: len) else { return nil }
        copy.frameLength = len
        if let src = floatChannelData, let dst = copy.floatChannelData {
            for ch in 0..<Int(fmt.channelCount) { dst[ch].update(from: src[ch], count: Int(len)) }
            return copy
        }
        if let src = int16ChannelData, let dst = copy.int16ChannelData {
            for ch in 0..<Int(fmt.channelCount) { dst[ch].update(from: src[ch], count: Int(len)) }
            return copy
        }
        if let src = int32ChannelData, let dst = copy.int32ChannelData {
            for ch in 0..<Int(fmt.channelCount) { dst[ch].update(from: src[ch], count: Int(len)) }
            return copy
        }
        return nil
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARK: - Wake Word Gate (inlined from SwabbleKit)
// ═══════════════════════════════════════════════════════════════════════════════

/// Speech segment with timing data from SFSpeechRecognizer.
private struct WakeSegment {
    let text: String
    let start: TimeInterval
    let duration: TimeInterval
    let range: Range<String.Index>?
    var end: TimeInterval { start + duration }
}

private struct GateConfig {
    var triggers: [String]
    var minPostTriggerGap: TimeInterval
    var minCommandLength: Int

    init(triggers: [String], minPostTriggerGap: TimeInterval = 0.45, minCommandLength: Int = 1) {
        self.triggers = triggers
        self.minPostTriggerGap = minPostTriggerGap
        self.minCommandLength = minCommandLength
    }
}

private struct GateMatch {
    let triggerWord: String
    let triggerEndTime: TimeInterval
    let postGap: TimeInterval
    let command: String
}

/// Wake word detection engine. Matches trigger words against speech segments using timing
/// data to confirm a deliberate pause after the trigger, then extracts the command text.
/// Supports fuzzy matching via Levenshtein edit distance so that imprecise recognition
/// (e.g. "melody" for trigger "eliza") still fires.
private enum WakeGate {

    // MARK: Token types

    private struct Token {
        let normalized: String
        let start: TimeInterval
        let end: TimeInterval
        let range: Range<String.Index>?
    }

    private struct TriggerTokens {
        let original: String
        let tokens: [String]
    }

    // MARK: Primary timing-based match

    /// Match trigger words against speech segments using timing data.
    /// Looks for trigger tokens, confirms a post-trigger gap, and extracts the command.
    static func match(transcript: String, segments: [WakeSegment], config: GateConfig) -> GateMatch? {
        let triggers = normalizeTriggers(config.triggers)
        guard !triggers.isEmpty else { return nil }
        let tokens = normalizeSegments(segments)
        guard !tokens.isEmpty else { return nil }

        struct Candidate {
            let trigger: String; let index: Int; let triggerEnd: TimeInterval; let gap: TimeInterval
        }

        var best: Candidate?
        for trig in triggers {
            let count = trig.tokens.count
            guard count > 0, tokens.count > count else { continue }
            for i in 0...(tokens.count - count - 1) {
                let exact = (0..<count).allSatisfy { tokens[i + $0].normalized == trig.tokens[$0] }
                let fuzzy = !exact && (0..<count).allSatisfy {
                    fuzzyTokenMatch(tokens[i + $0].normalized, trig.tokens[$0])
                }
                guard exact || fuzzy else { continue }
                let trigEnd = tokens[i + count - 1].end
                let gap = tokens[i + count].start - trigEnd
                guard gap >= config.minPostTriggerGap else { continue }
                if let b = best, i <= b.index { continue }
                best = Candidate(trigger: trig.original, index: i, triggerEnd: trigEnd, gap: gap)
            }
        }

        guard let best else { return nil }
        let cmd = commandText(transcript: transcript, segments: segments, triggerEndTime: best.triggerEnd)
            .trimmingCharacters(in: wsPunct)
        guard cmd.count >= config.minCommandLength else { return nil }
        return GateMatch(triggerWord: best.trigger, triggerEndTime: best.triggerEnd,
                         postGap: best.gap, command: cmd)
    }

    // MARK: Command text extraction

    /// Extract command text from segments appearing after the trigger end time.
    static func commandText(transcript: String, segments: [WakeSegment], triggerEndTime: TimeInterval) -> String {
        let threshold = triggerEndTime + 0.001
        for seg in segments where seg.start >= threshold {
            if normalizeToken(seg.text).isEmpty { continue }
            if let range = seg.range {
                return String(transcript[range.lowerBound...]).trimmingCharacters(in: wsPunct)
            }
            break
        }
        return segments
            .filter { $0.start >= threshold && !normalizeToken($0.text).isEmpty }
            .map(\.text).joined(separator: " ")
            .trimmingCharacters(in: wsPunct)
    }

    /// Find the first trigger word and return everything after it.
    /// Supports fuzzy matching so "melody" matches trigger "eliza".
    static func textAfterTrigger(_ text: String, triggers: [String]) -> String {
        let words = text.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return "" }
        for trigger in triggers {
            let tw = trigger.split(whereSeparator: \.isWhitespace)
                .map { normalizeToken(String($0)) }.filter { !$0.isEmpty }
            guard !tw.isEmpty, words.count >= tw.count else { continue }
            for i in 0...(words.count - tw.count) {
                let matched = (0..<tw.count).allSatisfy { j in
                    let w = normalizeToken(words[i + j])
                    return w == tw[j] || fuzzyTokenMatch(w, tw[j])
                }
                if matched {
                    let afterIdx = i + tw.count
                    return afterIdx < words.count
                        ? words[afterIdx...].joined(separator: " ").trimmingCharacters(in: wsPunct)
                        : ""
                }
            }
        }
        return text
    }

    // MARK: Text-only helpers (no timing data required)

    /// Quick text-only check for trigger presence.
    static func matchesTextOnly(text: String, triggers: [String]) -> Bool {
        guard !text.isEmpty else { return false }
        let lower = text.lowercased()
        for trigger in triggers {
            let token = trigger.trimmingCharacters(in: wsPunct).lowercased()
            if token.isEmpty { continue }
            if lower.contains(token) { return true }
            // Fuzzy: check individual words
            let words = lower.split(whereSeparator: \.isWhitespace).map(String.init)
            if words.contains(where: { fuzzyTokenMatch($0, token) }) { return true }
        }
        return false
    }

    /// Check if transcript begins with a trigger word.
    static func startsWithTrigger(transcript: String, triggers: [String]) -> Bool {
        let words = transcript.split(whereSeparator: \.isWhitespace)
            .map { normalizeToken(String($0)) }.filter { !$0.isEmpty }
        guard !words.isEmpty else { return false }
        for trigger in triggers {
            let tw = trigger.split(whereSeparator: \.isWhitespace)
                .map { normalizeToken(String($0)) }.filter { !$0.isEmpty }
            guard !tw.isEmpty, words.count >= tw.count else { continue }
            if zip(tw, words.prefix(tw.count)).allSatisfy({ $0 == $1 || fuzzyTokenMatch($0, $1) }) {
                return true
            }
        }
        return false
    }

    /// Text-only command extraction fallback (when timing data is absent or unreliable).
    static func textOnlyCommand(transcript: String, triggers: [String], minCommandLength: Int) -> String? {
        guard matchesTextOnly(text: transcript, triggers: triggers),
              startsWithTrigger(transcript: transcript, triggers: triggers) else { return nil }
        let after = textAfterTrigger(transcript, triggers: triggers)
        return after.count >= minCommandLength ? after : nil
    }

    // MARK: Fuzzy matching via Levenshtein distance

    /// Returns true if two normalized tokens are "close enough" to be considered a match.
    /// Threshold: ceil(maxLen / 3). e.g. "eliza" (7) ↔ "melody" (6) → threshold 3, distance 3 → match.
    static func fuzzyTokenMatch(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        let maxLen = max(a.count, b.count)
        guard maxLen > 2 else { return false } // Very short words → exact only
        let threshold = max(1, (maxLen + 1) / 3)
        return editDistance(a, b) <= threshold
    }

    private static func editDistance(_ a: String, _ b: String) -> Int {
        let ac = Array(a), bc = Array(b)
        let m = ac.count, n = bc.count
        if m == 0 { return n }
        if n == 0 { return m }
        var prev = Array(0...n), curr = Array(repeating: 0, count: n + 1)
        for i in 1...m {
            curr[0] = i
            for j in 1...n {
                curr[j] = ac[i - 1] == bc[j - 1]
                    ? prev[j - 1]
                    : 1 + min(prev[j], curr[j - 1], prev[j - 1])
            }
            swap(&prev, &curr)
        }
        return prev[n]
    }

    // MARK: Normalization helpers

    private static func normalizeTriggers(_ triggers: [String]) -> [TriggerTokens] {
        triggers.compactMap { trig in
            let t = trig.split(whereSeparator: \.isWhitespace)
                .map { normalizeToken(String($0)) }.filter { !$0.isEmpty }
            return t.isEmpty ? nil : TriggerTokens(original: trig, tokens: t)
        }
    }

    private static func normalizeSegments(_ segments: [WakeSegment]) -> [Token] {
        segments.compactMap { seg in
            let n = normalizeToken(seg.text)
            return n.isEmpty ? nil : Token(normalized: n, start: seg.start, end: seg.end, range: seg.range)
        }
    }

    static func normalizeToken(_ t: String) -> String {
        t.trimmingCharacters(in: wsPunct).lowercased()
    }

    private static let wsPunct = CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters)
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARK: - SFTranscription → WakeSegment
// ═══════════════════════════════════════════════════════════════════════════════

private extension SFTranscription {
    func toWakeSegments(transcript: String) -> [WakeSegment] {
        segments.map { seg in
            WakeSegment(text: seg.substring, start: seg.timestamp, duration: seg.duration,
                        range: Range(seg.substringRange, in: transcript))
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARK: - Swabble Plugin
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Swabble Plugin for Capacitor
 *
 * Provides voice wake word detection and continuous speech-to-text using Apple's
 * Speech framework.
 *
 * State machine: idle → listening → triggered → capturing → listening
 */
@objc(SwabblePlugin)
public class SwabblePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SwabblePlugin"
    public let jsName = "Swabble"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isListening", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateConfig", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAudioDevices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAudioDevice", returnType: CAPPluginReturnPromise),
    ]

    // ── State Machine ──────────────────────────────────────────────────────

    private enum State: String {
        case idle, listening, triggered, capturing
    }

    private var state: State = .idle {
        didSet {
            guard state != oldValue else { return }
            notifyListeners("stateChange", data: ["state": state.rawValue])
        }
    }

    // ── Audio & Speech ─────────────────────────────────────────────────────

    private var audioEngine: AVAudioEngine?
    private var speechRecognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let bufferQueue = AudioBufferQueue()
    private var drainTimer: Timer?
    private var captureTimer: Timer?
    private var recognitionGeneration: Int = 0

    // ── Audio Level Tracking (written from audio thread, read on main) ─────

    private let audioLevelLock = NSLock()
    private var _pendingRMS: Double = 0
    private var _pendingPeak: Double = 0
    private var noiseFloorRMS: Double = 1e-4
    private var lastSpeechTime: Date?
    private var lastAudioLevelEmitTime: Date?

    // Voice-activity detection tunables (from classic VoiceWakeRuntime)
    private let minSpeechRMS: Double = 1e-3
    private let speechBoostFactor: Double = 6.0
    private let audioLevelEmitInterval: TimeInterval = 0.066 // ~15 Hz

    // ── Capture State ──────────────────────────────────────────────────────

    private var captureStartTime: Date?
    private var capturedTranscript: String = ""
    private var activeTriggerEndTime: TimeInterval?
    private var heardBeyondTrigger: Bool = false
    private var lastTranscript: String = ""
    private var lastTranscriptTime: Date?
    private var cooldownUntil: Date?

    // Capture tunables (from classic VoiceWakeRuntime)
    private let silenceWindow: TimeInterval = 2.0
    private let triggerOnlySilenceWindow: TimeInterval = 5.0
    private let captureHardStop: TimeInterval = 120.0
    private let debounceAfterSend: TimeInterval = 0.35
    private let triggerPauseWindow: TimeInterval = 0.55
    private let restartDelay: TimeInterval = 0.5

    // ── Configuration ──────────────────────────────────────────────────────

    private var config: PluginConfig?

    struct PluginConfig {
        var triggers: [String]
        var minPostTriggerGap: TimeInterval
        var minCommandLength: Int
        var locale: String
        var sampleRate: Double

        init(from obj: JSObject) {
            self.triggers = (obj["triggers"] as? [String]) ?? ["eliza"]
            self.minPostTriggerGap = (obj["minPostTriggerGap"] as? Double) ?? 0.45
            self.minCommandLength = (obj["minCommandLength"] as? Int) ?? 1
            self.locale = (obj["locale"] as? String) ?? Locale.current.identifier
            self.sampleRate = (obj["sampleRate"] as? Double) ?? 16000
        }

        func toJSObject() -> JSObject {
            [
                "triggers": triggers,
                "minPostTriggerGap": minPostTriggerGap,
                "minCommandLength": minCommandLength,
                "locale": locale,
                "sampleRate": sampleRate,
            ]
        }

        fileprivate var gateConfig: GateConfig {
            GateConfig(triggers: triggers, minPostTriggerGap: minPostTriggerGap,
                       minCommandLength: minCommandLength)
        }
    }

    // ── Notification Observers ─────────────────────────────────────────────

    private var interruptionObserver: NSObjectProtocol?
    private var routeChangeObserver: NSObjectProtocol?
    private var mediaResetObserver: NSObjectProtocol?

    // ════════════════════════════════════════════════════════════════════════
    // MARK: - Lifecycle
    // ════════════════════════════════════════════════════════════════════════

    override public func load() {
        super.load()
        setupNotificationObservers()
    }

    private func setupNotificationObservers() {
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil, queue: .main
        ) { [weak self] note in self?.handleAudioInterruption(note) }

        routeChangeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil, queue: .main
        ) { [weak self] _ in self?.handleRouteChange() }

        mediaResetObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: nil, queue: .main
        ) { [weak self] _ in self?.handleMediaServicesReset() }
    }

    deinit {
        [interruptionObserver, routeChangeObserver, mediaResetObserver]
            .compactMap { $0 }
            .forEach { NotificationCenter.default.removeObserver($0) }
    }

    // ════════════════════════════════════════════════════════════════════════
    // MARK: - Plugin Methods
    // ════════════════════════════════════════════════════════════════════════

    @objc func start(_ call: CAPPluginCall) {
        guard let configObj = call.getObject("config") else {
            call.reject("Missing config parameter")
            return
        }
        let cfg = PluginConfig(from: configObj)
        config = cfg

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                switch status {
                case .authorized:
                    self.beginListening(config: cfg, call: call)
                case .denied, .restricted:
                    call.resolve(["started": false, "error": "Speech recognition not authorized"])
                case .notDetermined:
                    call.resolve(["started": false, "error": "Speech recognition authorization pending"])
                @unknown default:
                    call.resolve(["started": false, "error": "Unknown authorization status"])
                }
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopInternal()
        call.resolve()
    }

    @objc func isListening(_ call: CAPPluginCall) {
        call.resolve(["listening": state != .idle])
    }

    @objc func getConfig(_ call: CAPPluginCall) {
        if let config {
            call.resolve(["config": config.toJSObject()])
        } else {
            call.resolve(["config": NSNull()])
        }
    }

    @objc func updateConfig(_ call: CAPPluginCall) {
        guard let obj = call.getObject("config") else {
            call.reject("Missing config parameter")
            return
        }
        if var cfg = config {
            if let t = obj["triggers"] as? [String] { cfg.triggers = t }
            if let g = obj["minPostTriggerGap"] as? Double { cfg.minPostTriggerGap = g }
            if let l = obj["minCommandLength"] as? Int { cfg.minCommandLength = l }
            if let loc = obj["locale"] as? String { cfg.locale = loc }
            if let sr = obj["sampleRate"] as? Double { cfg.sampleRate = sr }
            config = cfg
        }
        call.resolve()
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        let speech = SFSpeechRecognizer.authorizationStatus()
        let mic = AVAudioSession.sharedInstance().recordPermission
        call.resolve([
            "microphone": micPermissionString(mic),
            "speechRecognition": speechPermissionString(speech),
        ])
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        SFSpeechRecognizer.requestAuthorization { [weak self] speechStatus in
            AVAudioSession.sharedInstance().requestRecordPermission { micGranted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    call.resolve([
                        "microphone": self.micPermissionString(micGranted ? .granted : .denied),
                        "speechRecognition": self.speechPermissionString(speechStatus),
                    ])
                }
            }
        }
    }

    @objc func getAudioDevices(_ call: CAPPluginCall) {
        let session = AVAudioSession.sharedInstance()
        let inputs = session.availableInputs ?? []
        let currentUID = session.currentRoute.inputs.first?.uid
        let devices: [[String: Any]] = inputs.map { port in
            ["id": port.uid, "name": port.portName, "isDefault": port.uid == currentUID]
        }
        call.resolve(["devices": devices])
    }

    @objc func setAudioDevice(_ call: CAPPluginCall) {
        guard let deviceId = call.getString("deviceId") else {
            call.reject("Missing deviceId")
            return
        }
        let session = AVAudioSession.sharedInstance()
        guard let inputs = session.availableInputs,
              let preferred = inputs.first(where: { $0.uid == deviceId }) else {
            call.reject("Audio device not found")
            return
        }
        do {
            try session.setPreferredInput(preferred)
            call.resolve()
        } catch {
            call.reject("Failed to set audio device: \(error.localizedDescription)")
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // MARK: - Recognition Lifecycle
    // ════════════════════════════════════════════════════════════════════════

    private func beginListening(config: PluginConfig, call: CAPPluginCall) {
        // Clean up any prior session without emitting idle stateChange
        stopInternal(emitIdle: false)

        speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: config.locale))
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            call.resolve(["started": false,
                          "error": "Speech recognizer unavailable for locale \(config.locale)"])
            return
        }

        do {
            try configureAudioSession()
            try startRecognitionPipeline()
            state = .listening
            call.resolve(["started": true])
        } catch {
            call.resolve(["started": false, "error": error.localizedDescription])
        }
    }

    /// Start audio engine + recognition task + drain timer.
    private func startRecognitionPipeline() throws {
        recognitionGeneration &+= 1
        let generation = recognitionGeneration

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
        if #available(iOS 16, *) { request.addsPunctuation = true }
        recognitionRequest = request

        if audioEngine == nil { audioEngine = AVAudioEngine() }
        guard let audioEngine else { throw SwabbleError.audioEngineUnavailable }

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            throw SwabbleError.noAudioInput
        }
        inputNode.removeTap(onBus: 0)

        // Audio tap: copy buffer (thread-safe) and store RMS for main thread to read.
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            self.bufferQueue.enqueue(buffer)
            if let (rms, peak) = Self.calculateRMS(buffer: buffer) {
                self.audioLevelLock.lock()
                self._pendingRMS = rms
                self._pendingPeak = peak
                self.audioLevelLock.unlock()
            }
        }

        audioEngine.prepare()
        try audioEngine.start()
        startDrainTimer()

        recognitionTask = speechRecognizer?.recognitionTask(with: request) {
            [weak self, generation] result, error in
            DispatchQueue.main.async {
                self?.handleRecognitionResult(result: result, error: error, generation: generation)
            }
        }
    }

    /// Soft restart: keep audio engine running, just restart recognition request + task.
    /// Used when the recognizer hits its ~1-minute limit or encounters a transient error.
    private func softRestartRecognition() {
        recognitionGeneration &+= 1
        let generation = recognitionGeneration

        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil

        guard state != .idle, let speechRecognizer, speechRecognizer.isAvailable else { return }

        DispatchQueue.main.asyncAfter(deadline: .now() + restartDelay) { [weak self] in
            guard let self, self.state != .idle else { return }

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            request.taskHint = .dictation
            if #available(iOS 16, *) { request.addsPunctuation = true }
            self.recognitionRequest = request

            let gen = self.recognitionGeneration
            self.recognitionTask = self.speechRecognizer?.recognitionTask(with: request) {
                [weak self] result, error in
                DispatchQueue.main.async {
                    self?.handleRecognitionResult(result: result, error: error, generation: gen)
                }
            }
        }
    }

    /// Hard restart: tear everything down and rebuild.
    /// Used after audio interruptions or media services reset.
    private func hardRestartRecognition() {
        haltRecognitionPipeline()
        guard let config, state != .idle else { return }

        DispatchQueue.main.asyncAfter(deadline: .now() + restartDelay) { [weak self] in
            guard let self, self.state != .idle else { return }
            self.speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: config.locale))
            do {
                try self.configureAudioSession()
                try self.startRecognitionPipeline()
            } catch {
                self.emitError(code: "restart_failed", message: error.localizedDescription,
                               recoverable: true)
                // Exponential backoff retry
                DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
                    self?.hardRestartRecognition()
                }
            }
        }
    }

    /// Halt the speech recognition pipeline. Audio engine, tap, and drain timer are stopped.
    private func haltRecognitionPipeline() {
        recognitionGeneration &+= 1
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest?.endAudio()
        recognitionRequest = nil
        stopDrainTimer()
        bufferQueue.clear()
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
    }

    /// Full stop - return to idle and release all resources.
    private func stopInternal(emitIdle: Bool = true) {
        haltRecognitionPipeline()
        stopCaptureTimer()
        speechRecognizer = nil
        capturedTranscript = ""
        captureStartTime = nil
        activeTriggerEndTime = nil
        heardBeyondTrigger = false
        lastTranscript = ""
        lastTranscriptTime = nil
        lastSpeechTime = nil
        cooldownUntil = nil
        noiseFloorRMS = 1e-4
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if emitIdle { state = .idle }
    }

    // ════════════════════════════════════════════════════════════════════════
    // MARK: - Recognition Result Handling
    // ════════════════════════════════════════════════════════════════════════

    private func handleRecognitionResult(result: SFSpeechRecognitionResult?,
                                         error: Error?, generation: Int) {
        // Drop stale callbacks from superseded recognition sessions
        guard generation == recognitionGeneration else { return }

        if let error {
            if state != .idle {
                emitError(code: "recognition_error", message: error.localizedDescription,
                          recoverable: true)
                softRestartRecognition()
            }
            return
        }

        guard let result else { return }
        let transcript = result.bestTranscription.formattedString
        let isFinal = result.isFinal
        let segments = result.bestTranscription.toWakeSegments(transcript: transcript)
        let confidence = result.bestTranscription.segments.last?.confidence ?? 0

        // Build JS segments for the transcript event
        let jsSegments: [[String: Any]] = segments.map { seg in
            ["text": seg.text, "start": seg.start, "duration": seg.duration, "isFinal": isFinal]
        }
        notifyListeners("transcript", data: [
            "transcript": transcript, "segments": jsSegments,
            "isFinal": isFinal, "confidence": Double(confidence),
        ])

        if !transcript.isEmpty {
            lastTranscript = transcript
            lastTranscriptTime = Date()
        }

        switch state {
        case .listening:
            handleListeningResult(transcript: transcript, segments: segments,
                                  isFinal: isFinal, confidence: confidence)
        case .capturing:
            handleCapturingResult(transcript: transcript, segments: segments, isFinal: isFinal)
        case .triggered, .idle:
            break
        }

        // When recognition ends naturally (time limit), soft-restart to keep listening
        if isFinal, state != .idle {
            softRestartRecognition()
        }
    }

    // ── Listening state: look for wake word ────────────────────────────────

    private func handleListeningResult(transcript: String, segments: [WakeSegment],
                                       isFinal: Bool, confidence: Float) {
        guard let config else { return }
        if let cooldown = cooldownUntil, Date() < cooldown { return }

        // 1) Timing-based match (preferred: uses post-trigger gap from segment timing)
        if let match = WakeGate.match(transcript: transcript, segments: segments,
                                      config: config.gateConfig) {
            triggerWakeWord(match: match, transcript: transcript, confidence: confidence)
            return
        }

        // 2) Text-only fallback on final results (timing data absent/unreliable)
        if isFinal,
           let command = WakeGate.textOnlyCommand(transcript: transcript,
                                                  triggers: config.triggers,
                                                  minCommandLength: config.minCommandLength) {
            let trigger = config.triggers.first ?? ""
            let fallback = GateMatch(triggerWord: trigger, triggerEndTime: 0,
                                     postGap: 0, command: command)
            triggerWakeWord(match: fallback, transcript: transcript, confidence: confidence)
            return
        }

        // 3) Trigger-only detection: user said just the wake word and paused
        if isTriggerOnly(transcript: transcript) {
            scheduleTriggerOnlyCheck(transcript: transcript)
        }
    }

    // ── Capturing state: accumulate post-trigger speech ────────────────────

    private func handleCapturingResult(transcript: String, segments: [WakeSegment],
                                       isFinal: Bool) {
        guard let config else { return }

        // Use timing data if available, fall back to text-based extraction
        let command: String
        if let trigEnd = activeTriggerEndTime, !segments.isEmpty {
            let timed = WakeGate.commandText(transcript: transcript, segments: segments,
                                             triggerEndTime: trigEnd)
            command = timed.isEmpty
                ? WakeGate.textAfterTrigger(transcript, triggers: config.triggers)
                : timed
        } else {
            command = WakeGate.textAfterTrigger(transcript, triggers: config.triggers)
        }

        if !command.isEmpty {
            capturedTranscript = command
            if !heardBeyondTrigger { heardBeyondTrigger = true }
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // MARK: - Wake Word Trigger & Capture
    // ════════════════════════════════════════════════════════════════════════

    private func triggerWakeWord(match: GateMatch, transcript: String, confidence: Float) {
        state = .triggered
        notifyListeners("wakeWord", data: [
            "wakeWord": match.triggerWord,
            "command": match.command,
            "transcript": transcript,
            "postGap": match.postGap,
            "confidence": Double(confidence),
        ])
        beginCapture(initialCommand: match.command, triggerEndTime: match.triggerEndTime)
    }

    private func beginCapture(initialCommand: String, triggerEndTime: TimeInterval) {
        state = .capturing
        capturedTranscript = initialCommand
        captureStartTime = Date()
        activeTriggerEndTime = triggerEndTime
        heardBeyondTrigger = !initialCommand.isEmpty
        lastSpeechTime = Date()
        cooldownUntil = nil
        startCaptureTimer()
    }

    private func startCaptureTimer() {
        stopCaptureTimer()
        captureTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            self?.checkCaptureTimeout()
        }
    }

    private func stopCaptureTimer() {
        captureTimer?.invalidate()
        captureTimer = nil
    }

    private func checkCaptureTimeout() {
        guard state == .capturing else { stopCaptureTimer(); return }
        let now = Date()

        // Hard stop after maximum capture duration
        if let start = captureStartTime, now.timeIntervalSince(start) >= captureHardStop {
            finalizeCapture()
            return
        }

        // Silence detection: different thresholds based on whether we heard post-trigger speech
        let threshold = heardBeyondTrigger ? silenceWindow : triggerOnlySilenceWindow
        if let lastSpeech = lastSpeechTime, now.timeIntervalSince(lastSpeech) >= threshold {
            finalizeCapture()
        }
    }

    private func finalizeCapture() {
        guard state == .capturing else { return }
        stopCaptureTimer()
        cooldownUntil = Date().addingTimeInterval(debounceAfterSend)

        let finalText = capturedTranscript.trimmingCharacters(in: .whitespacesAndNewlines)
        if !finalText.isEmpty {
            notifyListeners("transcript", data: [
                "transcript": finalText, "segments": [] as [[String: Any]],
                "isFinal": true, "confidence": 1.0,
            ])
        }

        // Reset capture state
        capturedTranscript = ""
        captureStartTime = nil
        activeTriggerEndTime = nil
        heardBeyondTrigger = false
        lastSpeechTime = nil

        // Return to listening
        state = .listening
        softRestartRecognition()
    }

    // ════════════════════════════════════════════════════════════════════════
    // MARK: - Trigger-Only Detection
    // ════════════════════════════════════════════════════════════════════════

    /// Check if the transcript is just the trigger word with no command after it.
    private func isTriggerOnly(transcript: String) -> Bool {
        guard let config else { return false }
        guard WakeGate.matchesTextOnly(text: transcript, triggers: config.triggers),
              WakeGate.startsWithTrigger(transcript: transcript, triggers: config.triggers) else {
            return false
        }
        return WakeGate.textAfterTrigger(transcript, triggers: config.triggers).isEmpty
    }

    /// If the transcript hasn't changed after the pause window, start capture.
    private func scheduleTriggerOnlyCheck(transcript: String) {
        let snapshotTime = lastTranscriptTime
        DispatchQueue.main.asyncAfter(deadline: .now() + triggerPauseWindow) { [weak self] in
            guard let self, self.state == .listening else { return }
            guard self.lastTranscriptTime == snapshotTime, self.lastTranscript == transcript else { return }
            guard self.isTriggerOnly(transcript: transcript) else { return }
            if let cooldown = self.cooldownUntil, Date() < cooldown { return }

            let trigger = self.config?.triggers.first ?? ""
            self.state = .triggered
            self.notifyListeners("wakeWord", data: [
                "wakeWord": trigger, "command": "", "transcript": transcript,
                "postGap": 0.0, "confidence": 0.0,
            ])
            self.beginCapture(initialCommand: "", triggerEndTime: 0)
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // MARK: - Audio Level Processing
    // ════════════════════════════════════════════════════════════════════════

    private static func calculateRMS(buffer: AVAudioPCMBuffer) -> (rms: Double, peak: Double)? {
        guard let channelData = buffer.floatChannelData?[0] else { return nil }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return nil }
        var sum: Double = 0
        var peak: Float = 0
        for i in 0..<count {
            let sample = abs(channelData[i])
            sum += Double(sample) * Double(sample)
            if sample > peak { peak = sample }
        }
        return (sqrt(sum / Double(count)), Double(peak))
    }

    /// Called from the drain timer on the main thread. Updates noise floor, speech detection,
    /// and emits throttled audioLevel events.
    private func processAudioLevel() {
        audioLevelLock.lock()
        let rms = _pendingRMS
        let peak = _pendingPeak
        audioLevelLock.unlock()
        guard rms > 0 else { return }

        // Adaptive noise floor: fast decay (quiet room), slow rise (speech/noise)
        let alpha: Double = rms < noiseFloorRMS ? 0.08 : 0.01
        noiseFloorRMS = max(1e-7, noiseFloorRMS + (rms - noiseFloorRMS) * alpha)

        // Mark speech when audio is clearly above adaptive threshold
        let threshold = max(minSpeechRMS, noiseFloorRMS * speechBoostFactor)
        if rms >= threshold {
            lastSpeechTime = Date()
        }

        // Throttle audioLevel events to ~15 Hz
        let now = Date()
        if let lastEmit = lastAudioLevelEmitTime, now.timeIntervalSince(lastEmit) < audioLevelEmitInterval {
            return
        }
        lastAudioLevelEmitTime = now

        let normalized = min(1.0, max(0.0, rms / max(minSpeechRMS, threshold)))
        notifyListeners("audioLevel", data: ["level": normalized, "peak": min(1.0, peak)])
    }

    // ════════════════════════════════════════════════════════════════════════
    // MARK: - Drain Timer
    // ════════════════════════════════════════════════════════════════════════

    private func startDrainTimer() {
        stopDrainTimer()
        // 40ms interval matches the classic iOS implementation's drain cadence
        drainTimer = Timer.scheduledTimer(withTimeInterval: 0.04, repeats: true) { [weak self] _ in
            guard let self else { return }
            let buffers = self.bufferQueue.drain()
            if let request = self.recognitionRequest {
                for buf in buffers { request.append(buf) }
            }
            self.processAudioLevel()
        }
    }

    private func stopDrainTimer() {
        drainTimer?.invalidate()
        drainTimer = nil
    }

    // ════════════════════════════════════════════════════════════════════════
    // MARK: - Audio Session Configuration
    // ════════════════════════════════════════════════════════════════════════

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, options: [
            .duckOthers, .mixWithOthers, .allowBluetooth, .defaultToSpeaker,
        ])
        try session.setActive(true, options: [])
    }

    // ════════════════════════════════════════════════════════════════════════
    // MARK: - Audio Interruption Handling
    // ════════════════════════════════════════════════════════════════════════

    private func handleAudioInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }

        switch type {
        case .began:
            guard state != .idle else { return }
            // Another app (phone call, Siri) took audio focus. Halt gracefully.
            haltRecognitionPipeline()
            stopCaptureTimer()
            capturedTranscript = ""
            captureStartTime = nil
            activeTriggerEndTime = nil
            heardBeyondTrigger = false
            state = .idle
            emitError(code: "audio_interrupted",
                      message: "Audio session interrupted by another app", recoverable: true)

        case .ended:
            let options: AVAudioSession.InterruptionOptions
            if let raw = info[AVAudioSessionInterruptionOptionKey] as? UInt {
                options = AVAudioSession.InterruptionOptions(rawValue: raw)
            } else {
                options = []
            }
            if options.contains(.shouldResume), let config {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                    self?.autoRestart(config: config)
                }
            }

        @unknown default:
            break
        }
    }

    private func handleRouteChange() {
        // Audio route changed (headphones, Bluetooth). Restart to pick up new device.
        guard state != .idle else { return }
        hardRestartRecognition()
    }

    private func handleMediaServicesReset() {
        let savedConfig = config
        stopInternal()
        emitError(code: "media_reset", message: "Media services were reset", recoverable: true)
        if let savedConfig {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                self?.autoRestart(config: savedConfig)
            }
        }
    }

    /// Restart from idle after an interruption or reset.
    private func autoRestart(config: PluginConfig) {
        guard state == .idle else { return }
        self.config = config
        speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: config.locale))
        guard let speechRecognizer, speechRecognizer.isAvailable else {
            emitError(code: "restart_failed", message: "Speech recognizer unavailable",
                      recoverable: false)
            return
        }
        do {
            try configureAudioSession()
            try startRecognitionPipeline()
            state = .listening
        } catch {
            emitError(code: "restart_failed", message: error.localizedDescription,
                      recoverable: false)
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // MARK: - Helpers
    // ════════════════════════════════════════════════════════════════════════

    private func emitError(code: String, message: String, recoverable: Bool) {
        notifyListeners("error", data: [
            "code": code, "message": message, "recoverable": recoverable,
        ])
    }

    private func micPermissionString(_ status: AVAudioSession.RecordPermission) -> String {
        switch status {
        case .granted: return "granted"
        case .denied: return "denied"
        case .undetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }

    private func speechPermissionString(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }

    private enum SwabbleError: LocalizedError {
        case audioEngineUnavailable
        case noAudioInput

        var errorDescription: String? {
            switch self {
            case .audioEngineUnavailable: return "Unable to create audio engine"
            case .noAudioInput: return "No audio input available"
            }
        }
    }
}
