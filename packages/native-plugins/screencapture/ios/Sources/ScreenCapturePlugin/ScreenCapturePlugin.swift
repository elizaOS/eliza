import Foundation
import Capacitor
import ReplayKit
import AVFoundation
import ImageIO

@objc(ScreenCapturePlugin)
public class ScreenCapturePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenCapturePlugin"
    public let jsName = "ScreenCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "captureScreenshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pauseRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resumeRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRecordingState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
    ]

    // MARK: - Thread-safe capture state

    /// Serializes access to the AVAssetWriter and its inputs from the ReplayKit
    /// capture handler, which may fire on arbitrary background queues.
    private final class CaptureState: @unchecked Sendable {
        private let lock = NSLock()

        var writer: AVAssetWriter?
        var videoInput: AVAssetWriterInput?
        var audioInput: AVAssetWriterInput?
        var sessionStarted = false
        var sawVideo = false
        var lastVideoTime: CMTime?
        var handlerError: Error?
        var isPaused = false
        var outputURL: URL?

        // Config captured at recording start
        var targetFps: Double = 30
        var videoBitrate: Int = 6_000_000
        var includeSystemAudio = true
        var includeMicrophone = false

        func withLock<T>(_ body: (CaptureState) -> T) -> T {
            lock.lock()
            defer { lock.unlock() }
            return body(self)
        }
    }

    private let recorder = RPScreenRecorder.shared()
    private var captureState: CaptureState?
    private var recordingStartTime: Date?
    private var pausedDuration: TimeInterval = 0
    private var lastPauseStart: Date?
    private var recordingTimer: Timer?
    private var maxDurationTimer: Timer?
    private var pendingStopCall: CAPPluginCall?
    private let captureQueue = DispatchQueue(label: "screencapture.record", qos: .userInitiated)

    // MARK: - isSupported

    @objc func isSupported(_ call: CAPPluginCall) {
        var features: [String] = ["screenshot"]  // always available via UIKit

        if recorder.isAvailable {
            features.append("recording")
            features.append("systemAudio")
            features.append("microphone")
        }

        call.resolve([
            "supported": recorder.isAvailable,
            "features": features,
        ])
    }

    // MARK: - captureScreenshot

    @objc func captureScreenshot(_ call: CAPPluginCall) {
        let format = call.getString("format") ?? "png"
        let quality = call.getFloat("quality") ?? 100
        let scale = call.getFloat("scale") ?? 1
        let captureSystemUI = call.getBool("captureSystemUI") ?? false

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            let windows = self.gatherWindows(captureSystemUI: captureSystemUI)
            guard let primaryWindow = windows.first else {
                call.reject("No window available")
                return
            }

            let bounds = primaryWindow.bounds

            // UIGraphicsImageRenderer: modern replacement for UIGraphicsBeginImageContextWithOptions
            let rendererFormat = UIGraphicsImageRendererFormat()
            rendererFormat.scale = CGFloat(scale)
            rendererFormat.opaque = true

            let renderer = UIGraphicsImageRenderer(bounds: bounds, format: rendererFormat)
            let image = renderer.image { ctx in
                for window in windows {
                    window.layer.render(in: ctx.cgContext)
                }
            }

            // Encode to the requested format
            var data: Data?
            var outputFormat = format

            switch format {
            case "jpeg":
                data = image.jpegData(compressionQuality: CGFloat(quality / 100))
            case "webp":
                // Attempt WebP encoding via ImageIO (iOS 14+)
                data = self.encodeWebP(image: image, quality: CGFloat(quality / 100))
                if data == nil {
                    data = image.pngData()
                    outputFormat = "png"
                }
            default:
                data = image.pngData()
                outputFormat = "png"
            }

            guard let imageData = data else {
                call.reject("Failed to encode image")
                return
            }

            let outputWidth = Int(bounds.width * CGFloat(scale))
            let outputHeight = Int(bounds.height * CGFloat(scale))

            call.resolve([
                "base64": imageData.base64EncodedString(),
                "format": outputFormat,
                "width": outputWidth,
                "height": outputHeight,
                "timestamp": Date().timeIntervalSince1970 * 1000,
            ])
        }
    }

    // MARK: - startRecording

    @objc func startRecording(_ call: CAPPluginCall) {
        guard recorder.isAvailable else {
            call.reject("Screen recording not available")
            return
        }

        if captureState != nil {
            call.reject("Recording already in progress")
            return
        }

        // Parse options matching the TS ScreenRecordingOptions interface
        let qualityPreset = call.getString("quality") ?? "high"
        let maxDuration = call.getDouble("maxDuration")   // seconds
        let fps = call.getDouble("fps")
        let bitrate = call.getInt("bitrate")
        let captureAudio = call.getBool("captureAudio") ?? true
        let captureSystemAudio = call.getBool("captureSystemAudio") ?? captureAudio
        let captureMicrophone = call.getBool("captureMicrophone") ?? false

        // Resolve bitrate: explicit value takes precedence over quality preset
        let resolvedBitrate = bitrate ?? Self.bitrateForQuality(qualityPreset)
        let resolvedFps = Self.clampFps(fps ?? 30)

        recorder.isMicrophoneEnabled = captureMicrophone

        // Prepare temp output file
        let tempDir = FileManager.default.temporaryDirectory
        let fileName = "screen_\(Int(Date().timeIntervalSince1970))_\(UUID().uuidString.prefix(8)).mp4"
        let outputURL = tempDir.appendingPathComponent(fileName)
        try? FileManager.default.removeItem(at: outputURL)

        // Thread-safe state with deferred writer init (ported from classic ScreenRecordService)
        let state = CaptureState()
        state.outputURL = outputURL
        state.targetFps = resolvedFps
        state.videoBitrate = resolvedBitrate
        state.includeSystemAudio = captureSystemAudio
        state.includeMicrophone = captureMicrophone
        self.captureState = state

        recorder.startCapture(handler: { [weak self] sampleBuffer, sampleType, error in
            guard let self = self else { return }
            // Serialize writes on a dedicated queue (classic ScreenRecordService pattern)
            self.captureQueue.async {
                self.handleSample(sampleBuffer, type: sampleType, error: error, state: state)
            }
        }) { [weak self] error in
            guard let self = self else { return }

            DispatchQueue.main.async {
                if let error = error {
                    self.captureState = nil
                    call.reject("Failed to start recording: \(error.localizedDescription)")
                    return
                }

                self.recordingStartTime = Date()
                self.pausedDuration = 0
                self.lastPauseStart = nil
                self.startRecordingTimer()

                // Auto-stop after maxDuration (safety limit)
                if let maxDuration = maxDuration, maxDuration > 0 {
                    self.maxDurationTimer = Timer.scheduledTimer(
                        withTimeInterval: maxDuration,
                        repeats: false
                    ) { [weak self] _ in
                        self?.autoStopRecording()
                    }
                }

                self.notifyListeners("recordingState", data: [
                    "isRecording": true,
                    "duration": 0,
                    "fileSize": 0,
                    "fps": resolvedFps,
                ])

                call.resolve()
            }
        }
    }

    // MARK: - stopRecording

    @objc func stopRecording(_ call: CAPPluginCall) {
        guard let state = captureState else {
            call.reject("Not recording")
            return
        }

        pendingStopCall = call
        recordingTimer?.invalidate()
        recordingTimer = nil
        maxDurationTimer?.invalidate()
        maxDurationTimer = nil

        recorder.stopCapture { [weak self] error in
            guard let self = self else { return }

            DispatchQueue.main.async {
                if let error = error {
                    self.cleanup()
                    call.reject("Failed to stop recording: \(error.localizedDescription)")
                    return
                }
                self.finishRecording(state: state)
            }
        }
    }

    // MARK: - pauseRecording

    @objc func pauseRecording(_ call: CAPPluginCall) {
        guard let state = captureState else {
            call.reject("Not recording")
            return
        }

        let alreadyPaused = state.withLock { $0.isPaused }
        if alreadyPaused {
            call.reject("Already paused")
            return
        }

        state.withLock { $0.isPaused = true }
        lastPauseStart = Date()

        notifyListeners("recordingState", data: [
            "isRecording": true,
            "duration": currentDuration(),
            "fileSize": currentFileSize(),
        ])

        call.resolve()
    }

    // MARK: - resumeRecording

    @objc func resumeRecording(_ call: CAPPluginCall) {
        guard let state = captureState else {
            call.reject("Not recording")
            return
        }

        let wasPaused = state.withLock { $0.isPaused }
        if !wasPaused {
            call.reject("Not paused")
            return
        }

        // Accumulate elapsed pause time
        if let pauseStart = lastPauseStart {
            pausedDuration += Date().timeIntervalSince(pauseStart)
        }
        lastPauseStart = nil

        state.withLock { $0.isPaused = false }

        notifyListeners("recordingState", data: [
            "isRecording": true,
            "duration": currentDuration(),
            "fileSize": currentFileSize(),
        ])

        call.resolve()
    }

    // MARK: - getRecordingState

    @objc func getRecordingState(_ call: CAPPluginCall) {
        let isRecording = captureState != nil
        let isPaused = captureState?.withLock { $0.isPaused } ?? false
        let targetFps = captureState?.withLock { $0.targetFps } ?? 0

        // state string supplements the boolean for richer state reporting
        let state: String
        if !isRecording { state = "idle" }
        else if isPaused { state = "paused" }
        else { state = "recording" }

        call.resolve([
            "isRecording": isRecording,
            "state": state,
            "duration": currentDuration(),
            "fileSize": currentFileSize(),
            "fps": targetFps,
        ])
    }

    // MARK: - Permissions

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)

        call.resolve([
            "screenCapture": recorder.isAvailable ? "granted" : "not_supported",
            "microphone": permissionString(from: micStatus),
        ])
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] _ in
            guard let self = self else { return }

            DispatchQueue.main.async {
                let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)

                call.resolve([
                    "screenCapture": self.recorder.isAvailable ? "granted" : "not_supported",
                    "microphone": self.permissionString(from: micStatus),
                ])
            }
        }
    }

    // MARK: - Sample handling (ported from classic ScreenRecordService)

    private func handleSample(
        _ sample: CMSampleBuffer,
        type: RPSampleBufferType,
        error: Error?,
        state: CaptureState
    ) {
        if let error = error {
            state.withLock { s in
                if s.handlerError == nil { s.handlerError = error }
            }
            DispatchQueue.main.async { [weak self] in
                self?.notifyListeners("error", data: [
                    "code": "CAPTURE_ERROR",
                    "message": error.localizedDescription,
                ])
            }
            return
        }

        guard CMSampleBufferDataIsReady(sample) else { return }

        // Discard samples while paused (recording resumes seamlessly on unpause)
        let isPaused = state.withLock { $0.isPaused }
        if isPaused { return }

        switch type {
        case .video:
            handleVideoSample(sample, state: state)
        case .audioApp:
            if state.withLock({ $0.includeSystemAudio }) {
                handleAudioSample(sample, state: state)
            }
        case .audioMic:
            if state.withLock({ $0.includeMicrophone }) {
                handleAudioSample(sample, state: state)
            }
        @unknown default:
            break
        }
    }

    /// Process a video sample with FPS throttling and deferred writer initialization.
    private func handleVideoSample(_ sample: CMSampleBuffer, state: CaptureState) {
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let targetFps = state.withLock { $0.targetFps }

        // FPS throttling: skip frames that arrive faster than requested (classic pattern)
        let shouldSkip = state.withLock { s in
            if let lastTime = s.lastVideoTime {
                let delta = CMTimeSubtract(pts, lastTime)
                return delta.seconds < (1.0 / targetFps)
            }
            return false
        }
        if shouldSkip { return }

        // Deferred writer init on first video sample to get exact pixel dimensions (classic pattern)
        let hasWriter = state.withLock { $0.writer != nil }
        if !hasWriter {
            prepareWriter(from: sample, state: state, pts: pts)
        }

        let (vInput, started) = state.withLock { ($0.videoInput, $0.sessionStarted) }
        guard let vInput = vInput, started else { return }

        if vInput.isReadyForMoreMediaData {
            if vInput.append(sample) {
                state.withLock { s in
                    s.sawVideo = true
                    s.lastVideoTime = pts
                }
            } else {
                let err = state.withLock { $0.writer?.error }
                if let err = err {
                    state.withLock { s in
                        if s.handlerError == nil { s.handlerError = err }
                    }
                }
            }
        }
    }

    /// Create the AVAssetWriter lazily from the first video sample's actual pixel dimensions.
    /// This is more robust than pre-calculating from UIScreen (classic ScreenRecordService pattern).
    private func prepareWriter(from sample: CMSampleBuffer, state: CaptureState, pts: CMTime) {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sample) else {
            state.withLock { s in
                if s.handlerError == nil {
                    s.handlerError = NSError(domain: "ScreenCapture", code: 1, userInfo: [
                        NSLocalizedDescriptionKey: "Missing image buffer in video sample",
                    ])
                }
            }
            return
        }

        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)
        let bitrate = state.withLock { $0.videoBitrate }

        guard let url = state.withLock({ $0.outputURL }) else { return }

        do {
            let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)

            let videoSettings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: bitrate,
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                ],
            ]

            let vInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
            vInput.expectsMediaDataInRealTime = true
            guard writer.canAdd(vInput) else {
                throw NSError(domain: "ScreenCapture", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "Cannot add video input to writer",
                ])
            }
            writer.add(vInput)

            // Audio input for system audio and/or microphone
            let needsAudio = state.withLock { $0.includeSystemAudio || $0.includeMicrophone }
            if needsAudio {
                let audioSettings: [String: Any] = [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVSampleRateKey: 44100,
                    AVNumberOfChannelsKey: 2,
                    AVEncoderBitRateKey: 128000,
                ]
                let aInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
                aInput.expectsMediaDataInRealTime = true
                if writer.canAdd(aInput) {
                    writer.add(aInput)
                    state.withLock { $0.audioInput = aInput }
                }
            }

            guard writer.startWriting() else {
                throw NSError(domain: "ScreenCapture", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: writer.error?.localizedDescription
                        ?? "Failed to start asset writer",
                ])
            }

            // Start session at first sample PTS, not .zero, for correct timing
            writer.startSession(atSourceTime: pts)

            state.withLock { s in
                s.writer = writer
                s.videoInput = vInput
                s.sessionStarted = true
            }
        } catch {
            state.withLock { s in
                if s.handlerError == nil { s.handlerError = error }
            }
        }
    }

    private func handleAudioSample(_ sample: CMSampleBuffer, state: CaptureState) {
        let (aInput, started) = state.withLock { ($0.audioInput, $0.sessionStarted) }
        guard let aInput = aInput, started else { return }
        if aInput.isReadyForMoreMediaData {
            _ = aInput.append(sample)
        }
    }

    // MARK: - Recording lifecycle helpers

    private func startRecordingTimer() {
        recordingTimer?.invalidate()
        recordingTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self = self, let state = self.captureState else { return }
            let isPaused = state.withLock { $0.isPaused }

            self.notifyListeners("recordingState", data: [
                "isRecording": true,
                "isPaused": isPaused,
                "duration": self.currentDuration(),
                "fileSize": self.currentFileSize(),
            ])
        }
    }

    /// Auto-stop triggered by maxDuration timer
    private func autoStopRecording() {
        guard let state = captureState else { return }

        recordingTimer?.invalidate()
        recordingTimer = nil
        maxDurationTimer?.invalidate()
        maxDurationTimer = nil

        recorder.stopCapture { [weak self] error in
            guard let self = self else { return }

            DispatchQueue.main.async {
                if error != nil {
                    self.notifyListeners("error", data: [
                        "code": "AUTO_STOP_FAILED",
                        "message": error!.localizedDescription,
                    ])
                    self.cleanup()
                    return
                }
                self.finishRecording(state: state)
            }
        }
    }

    private func finishRecording(state: CaptureState) {
        let call = pendingStopCall
        pendingStopCall = nil

        let duration = currentDuration()

        // Check for capture handler errors
        if let err = state.withLock({ $0.handlerError }) {
            cleanup()
            call?.reject("Recording failed: \(err.localizedDescription)")
            return
        }

        let vInput = state.withLock { $0.videoInput }
        let aInput = state.withLock { $0.audioInput }
        let writer = state.withLock { $0.writer }
        let sawVideo = state.withLock { $0.sawVideo }

        guard let writer = writer, sawVideo else {
            cleanup()
            call?.reject("No video frames were captured")
            return
        }

        vInput?.markAsFinished()
        aInput?.markAsFinished()

        writer.finishWriting { [weak self] in
            guard let self = self else { return }

            DispatchQueue.main.async {
                if let writerError = writer.error {
                    self.cleanup()
                    call?.reject("Failed to finalize recording: \(writerError.localizedDescription)")
                    return
                }

                guard let url = state.withLock({ $0.outputURL }) else {
                    self.cleanup()
                    call?.reject("No output file")
                    return
                }

                var fileSize: Int64 = 0
                var width = 0
                var height = 0

                if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) {
                    fileSize = attrs[.size] as? Int64 ?? 0
                }

                // Read actual video track dimensions from the written file
                let asset = AVAsset(url: url)
                if let track = asset.tracks(withMediaType: .video).first {
                    let size = track.naturalSize.applying(track.preferredTransform)
                    width = Int(abs(size.width))
                    height = Int(abs(size.height))
                }

                self.notifyListeners("recordingState", data: [
                    "isRecording": false,
                    "duration": duration,
                    "fileSize": fileSize,
                ])

                call?.resolve([
                    "path": url.absoluteString,
                    "duration": duration,
                    "width": width,
                    "height": height,
                    "fileSize": fileSize,
                    "mimeType": "video/mp4",
                ])

                self.cleanup()
            }
        }
    }

    private func cleanup() {
        captureState = nil
        recordingStartTime = nil
        pausedDuration = 0
        lastPauseStart = nil
        recordingTimer?.invalidate()
        recordingTimer = nil
        maxDurationTimer?.invalidate()
        maxDurationTimer = nil
    }

    // MARK: - Screenshot helpers

    /// Gather UIWindows to render. When captureSystemUI is true, include all windows
    /// (status bar, alerts, etc.) sorted by window level.
    private func gatherWindows(captureSystemUI: Bool) -> [UIWindow] {
        if captureSystemUI {
            let scenes = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
            let allWindows = scenes.flatMap { $0.windows }
                .sorted { $0.windowLevel.rawValue < $1.windowLevel.rawValue }
            return allWindows
        } else {
            if let window = bridge?.webView?.window {
                return [window]
            }
            return []
        }
    }

    /// Encode a UIImage to WebP using ImageIO (available iOS 14+).
    /// Returns nil if WebP encoding is not supported on this OS version.
    private func encodeWebP(image: UIImage, quality: CGFloat) -> Data? {
        guard let cgImage = image.cgImage else { return nil }
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            data as CFMutableData,
            "public.webp" as CFString,
            1,
            nil
        ) else {
            return nil
        }

        let options: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: quality,
        ]
        CGImageDestinationAddImage(dest, cgImage, options as CFDictionary)

        guard CGImageDestinationFinalize(dest) else { return nil }
        return data as Data
    }

    // MARK: - Recording state helpers

    /// Compute active recording duration, excluding time spent paused.
    private func currentDuration() -> Double {
        guard let start = recordingStartTime else { return 0 }
        var elapsed = Date().timeIntervalSince(start)
        elapsed -= pausedDuration
        // Subtract ongoing pause if currently paused
        if let pauseStart = lastPauseStart {
            elapsed -= Date().timeIntervalSince(pauseStart)
        }
        return max(0, elapsed)
    }

    private func currentFileSize() -> Int64 {
        guard let url = captureState?.withLock({ $0.outputURL }) else { return 0 }
        return (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
    }

    /// Map quality preset string to video bitrate in bits per second.
    private static func bitrateForQuality(_ quality: String) -> Int {
        switch quality {
        case "low":     return 1_000_000   // 1 Mbps
        case "medium":  return 3_000_000   // 3 Mbps
        case "high":    return 6_000_000   // 6 Mbps
        case "highest": return 10_000_000  // 10 Mbps
        default:        return 6_000_000
        }
    }

    /// Clamp FPS to a sane range (ported from classic ScreenRecordService).
    private static func clampFps(_ fps: Double) -> Double {
        if !fps.isFinite { return 30 }
        return min(60, max(1, fps))
    }

    private func permissionString(from status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized:            return "granted"
        case .denied, .restricted:   return "denied"
        default:                     return "prompt"
        }
    }
}
