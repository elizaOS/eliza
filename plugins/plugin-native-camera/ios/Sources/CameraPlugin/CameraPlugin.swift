import Foundation
import Capacitor
import AVFoundation
import UIKit
import Photos
import ImageIO

// MARK: - ElizaCameraPlugin

@objc(ElizaCameraPlugin)
public class ElizaCameraPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaCameraPlugin"
    public let jsName = "ElizaCamera"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getDevices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startPreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopPreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "switchCamera", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capturePhoto", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRecordingState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setZoom", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setFocusPoint", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setExposurePoint", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
    ]

    // MARK: - Properties

    private var captureSession: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var videoInput: AVCaptureDeviceInput?
    private var photoOutput: AVCapturePhotoOutput?
    private var movieOutput: AVCaptureMovieFileOutput?
    private var videoDataOutput: AVCaptureVideoDataOutput?
    private var currentDevice: AVCaptureDevice?
    private var previewView: UIView?
    private var isRecording = false
    private var recordingStartTime: Date?
    private var pendingPhotoCall: CAPPluginCall?
    private var pendingVideoCall: CAPPluginCall?
    private var currentPhotoOptions: [String: Any]?
    private var currentVideoOptions: [String: Any]?
    private var recordingTimer: Timer?

    /// Timestamp of last emitted frame event; used to throttle to ~2/s.
    private var lastFrameEmitTime: CFAbsoluteTime = 0

    /// Serial queue for video data output sample buffer callbacks (frame events).
    private let videoDataQueue = DispatchQueue(label: "eliza.camera.videodata", qos: .userInitiated)

    /// All device types to discover. Ported from classic CameraController to include
    /// dual, triple, TrueDepth, and LiDAR cameras.
    private static let discoveryDeviceTypes: [AVCaptureDevice.DeviceType] = {
        var types: [AVCaptureDevice.DeviceType] = [
            .builtInWideAngleCamera,
            .builtInUltraWideCamera,
            .builtInTelephotoCamera,
            .builtInDualCamera,
            .builtInDualWideCamera,
            .builtInTripleCamera,
            .builtInTrueDepthCamera
        ]
        if #available(iOS 15.4, *) {
            types.append(.builtInLiDARDepthCamera)
        }
        return types
    }()

    private var currentSettings: [String: Any] = [
        "flash": "off",
        "zoom": 1.0,
        "focusMode": "continuous",
        "exposureMode": "continuous",
        "exposureCompensation": 0.0,
        "whiteBalance": "auto"
    ]

    // MARK: - Helpers (ported from classic CameraController)

    /// Pick a camera by deviceId or direction, with fallback to any available camera.
    /// Ported from classic CameraController.pickCamera.
    private func pickCamera(direction: String, deviceId: String?) -> AVCaptureDevice? {
        if let deviceId = deviceId, !deviceId.isEmpty {
            let all = AVCaptureDevice.DiscoverySession(
                deviceTypes: Self.discoveryDeviceTypes,
                mediaType: .video,
                position: .unspecified
            ).devices
            if let match = all.first(where: { $0.uniqueID == deviceId }) {
                return match
            }
        }
        let position: AVCaptureDevice.Position = direction == "front" ? .front : .back
        if let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) {
            return device
        }
        // Fallback to any default camera (e.g. simulator or unusual device configs).
        return AVCaptureDevice.default(for: .video)
    }

    /// Clamp quality from 0-100 integer range to 0.05-1.0 float.
    /// Ported from classic JPEGTranscoder.clampQuality.
    private static func clampQuality(_ quality: Float) -> Float {
        let q = quality / 100.0
        return min(1.0, max(0.05, q))
    }

    /// Emit an error event to JS listeners.
    private func emitError(code: String, message: String) {
        notifyListeners("error", data: [
            "code": code,
            "message": message,
        ])
    }

    // MARK: - getDevices

    @objc func getDevices(_ call: CAPPluginCall) {
        var devices: [[String: Any]] = []

        let discoverySession = AVCaptureDevice.DiscoverySession(
            deviceTypes: Self.discoveryDeviceTypes,
            mediaType: .video,
            position: .unspecified
        )

        for device in discoverySession.devices {
            var direction: String
            switch device.position {
            case .front:  direction = "front"
            case .back:   direction = "back"
            default:      direction = "external"
            }

            // Deduplicated resolutions, sorted largest-first, capped at 10.
            var resolutions: [[String: Int]] = []
            for format in device.formats {
                let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
                let res = ["width": Int(dims.width), "height": Int(dims.height)]
                if !resolutions.contains(where: { $0["width"] == res["width"] && $0["height"] == res["height"] }) {
                    resolutions.append(res)
                }
            }
            resolutions.sort { ($0["width"] ?? 0) * ($0["height"] ?? 0) > ($1["width"] ?? 0) * ($1["height"] ?? 0) }
            if resolutions.count > 10 {
                resolutions = Array(resolutions.prefix(10))
            }

            // Deduplicated max frame rates, sorted highest-first.
            var frameRates: [Int] = []
            for format in device.formats {
                for range in format.videoSupportedFrameRateRanges {
                    let maxRate = Int(range.maxFrameRate)
                    if !frameRates.contains(maxRate) {
                        frameRates.append(maxRate)
                    }
                }
            }
            frameRates.sort(by: >)

            devices.append([
                "deviceId": device.uniqueID,
                "label": device.localizedName,
                "direction": direction,
                "hasFlash": device.hasFlash,
                "hasZoom": true,
                "maxZoom": device.maxAvailableVideoZoomFactor,
                "supportedResolutions": resolutions,
                "supportedFrameRates": frameRates,
            ])
        }

        call.resolve(["devices": devices])
    }

    // MARK: - startPreview

    @objc func startPreview(_ call: CAPPluginCall) {
        guard let webView = self.webView else {
            call.reject("WebView not available")
            return
        }

        let direction = call.getString("direction") ?? "back"
        let deviceId = call.getString("deviceId")
        let width = call.getInt("resolution.width") ?? 1920
        let height = call.getInt("resolution.height") ?? 1080
        let frameRate = call.getInt("frameRate") ?? 30
        let mirror = call.getBool("mirror") ?? (direction == "front")

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }

            self.stopPreviewInternal()

            let session = AVCaptureSession()
            session.sessionPreset = .high

            guard let captureDevice = self.pickCamera(direction: direction, deviceId: deviceId) else {
                call.reject("No camera device available")
                self.emitError(code: "CAMERA_UNAVAILABLE", message: "No camera device available")
                return
            }

            do {
                let input = try AVCaptureDeviceInput(device: captureDevice)
                if session.canAddInput(input) {
                    session.addInput(input)
                    self.videoInput = input
                    self.currentDevice = captureDevice
                }

                let photoOutput = AVCapturePhotoOutput()
                if session.canAddOutput(photoOutput) {
                    session.addOutput(photoOutput)
                    photoOutput.maxPhotoQualityPrioritization = .quality
                    self.photoOutput = photoOutput
                }

                let movieOutput = AVCaptureMovieFileOutput()
                if session.canAddOutput(movieOutput) {
                    session.addOutput(movieOutput)
                    self.movieOutput = movieOutput
                }

                // Video data output for lightweight frame events.
                let videoDataOutput = AVCaptureVideoDataOutput()
                videoDataOutput.alwaysDiscardsLateVideoFrames = true
                videoDataOutput.setSampleBufferDelegate(self, queue: self.videoDataQueue)
                if session.canAddOutput(videoDataOutput) {
                    session.addOutput(videoDataOutput)
                    self.videoDataOutput = videoDataOutput
                }

                try captureDevice.lockForConfiguration()
                let targetFrameRate = CMTime(value: 1, timescale: CMTimeScale(frameRate))
                captureDevice.activeVideoMinFrameDuration = targetFrameRate
                captureDevice.activeVideoMaxFrameDuration = targetFrameRate
                captureDevice.unlockForConfiguration()
            } catch {
                call.reject("Failed to configure camera: \(error.localizedDescription)")
                self.emitError(code: "CAMERA_CONFIG_FAILED", message: error.localizedDescription)
                return
            }

            self.captureSession = session

            let previewView = UIView(frame: webView.bounds)
            previewView.backgroundColor = .black
            previewView.autoresizingMask = [.flexibleWidth, .flexibleHeight]

            let previewLayer = AVCaptureVideoPreviewLayer(session: session)
            previewLayer.frame = previewView.bounds
            previewLayer.videoGravity = .resizeAspectFill

            if mirror {
                previewLayer.setAffineTransform(CGAffineTransform(scaleX: -1, y: 1))
            }

            previewView.layer.addSublayer(previewLayer)

            webView.superview?.insertSubview(previewView, belowSubview: webView)
            webView.isOpaque = false
            webView.backgroundColor = .clear
            webView.scrollView.backgroundColor = .clear

            self.previewView = previewView
            self.previewLayer = previewLayer

            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()

                // Short warm-up delay to reduce blank first frames.
                // Ported from classic CameraController.warmUpCaptureSession (150ms).
                Thread.sleep(forTimeInterval: 0.15)

                DispatchQueue.main.async {
                    let formatDesc = self.currentDevice?.activeFormat.formatDescription
                    let dimensions = formatDesc.map { CMVideoFormatDescriptionGetDimensions($0) }
                        ?? CMVideoDimensions(width: Int32(width), height: Int32(height))

                    call.resolve([
                        "width": Int(dimensions.width),
                        "height": Int(dimensions.height),
                        "deviceId": captureDevice.uniqueID,
                    ])
                }
            }
        }
    }

    // MARK: - stopPreview

    @objc func stopPreview(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.stopPreviewInternal()
            call.resolve()
        }
    }

    private func stopPreviewInternal() {
        if isRecording {
            movieOutput?.stopRecording()
            isRecording = false
        }

        recordingTimer?.invalidate()
        recordingTimer = nil

        captureSession?.stopRunning()
        captureSession = nil

        previewLayer?.removeFromSuperlayer()
        previewLayer = nil

        previewView?.removeFromSuperview()
        previewView = nil

        videoInput = nil
        photoOutput = nil
        movieOutput = nil
        videoDataOutput = nil
        currentDevice = nil

        if let webView = self.webView {
            webView.isOpaque = true
            webView.backgroundColor = .white
        }
    }

    // MARK: - switchCamera

    @objc func switchCamera(_ call: CAPPluginCall) {
        guard captureSession != nil else {
            call.reject("Preview not started")
            return
        }

        let direction = call.getString("direction") ?? "back"
        let deviceId = call.getString("deviceId")

        DispatchQueue.main.async { [weak self] in
            guard let self = self, let session = self.captureSession else { return }

            session.beginConfiguration()

            if let currentInput = self.videoInput {
                session.removeInput(currentInput)
            }

            guard let device = self.pickCamera(direction: direction, deviceId: deviceId) else {
                session.commitConfiguration()
                call.reject("Camera device not found")
                return
            }

            do {
                let input = try AVCaptureDeviceInput(device: device)
                if session.canAddInput(input) {
                    session.addInput(input)
                    self.videoInput = input
                    self.currentDevice = device
                }

                let mirror = direction == "front"
                if let previewLayer = self.previewLayer {
                    previewLayer.setAffineTransform(
                        mirror ? CGAffineTransform(scaleX: -1, y: 1) : .identity
                    )
                }

                session.commitConfiguration()

                let dimensions = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
                call.resolve([
                    "width": Int(dimensions.width),
                    "height": Int(dimensions.height),
                    "deviceId": device.uniqueID,
                ])
            } catch {
                session.commitConfiguration()
                call.reject("Failed to switch camera: \(error.localizedDescription)")
                self.emitError(code: "CAMERA_SWITCH_FAILED", message: error.localizedDescription)
            }
        }
    }

    // MARK: - capturePhoto

    @objc func capturePhoto(_ call: CAPPluginCall) {
        guard let photoOutput = self.photoOutput else {
            call.reject("Camera not ready")
            return
        }

        let quality = call.getFloat("quality") ?? 90
        let format = call.getString("format") ?? "jpeg"
        let saveToGallery = call.getBool("saveToGallery") ?? false
        let includeExif = call.getBool("exifOrientation") ?? true

        currentPhotoOptions = [
            "quality": quality,
            "format": format,
            "saveToGallery": saveToGallery,
            "width": call.getInt("width") as Any,
            "height": call.getInt("height") as Any,
            "includeExif": includeExif,
        ]

        pendingPhotoCall = call

        // Always capture as JPEG; format conversion happens in the delegate.
        var settings: AVCapturePhotoSettings
        if photoOutput.availablePhotoCodecTypes.contains(.jpeg) {
            settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
        } else {
            settings = AVCapturePhotoSettings()
        }
        settings.photoQualityPrioritization = .quality

        if let device = currentDevice, device.hasFlash {
            let flashMode = currentSettings["flash"] as? String ?? "off"
            switch flashMode {
            case "on":   settings.flashMode = .on
            case "auto": settings.flashMode = .auto
            default:     settings.flashMode = .off
            }
        }

        photoOutput.capturePhoto(with: settings, delegate: self)
    }

    // MARK: - startRecording

    @objc func startRecording(_ call: CAPPluginCall) {
        guard let movieOutput = self.movieOutput, !isRecording else {
            call.reject("Cannot start recording")
            return
        }

        let quality = call.getString("quality") ?? "high"
        let maxDuration = call.getDouble("maxDuration")
        let maxFileSize = call.getInt("maxFileSize")
        let saveToGallery = call.getBool("saveToGallery") ?? false
        let includeAudio = call.getBool("audio") ?? true
        let frameRate = call.getInt("frameRate")

        currentVideoOptions = [
            "quality": quality,
            "maxDuration": maxDuration as Any,
            "maxFileSize": maxFileSize as Any,
            "saveToGallery": saveToGallery,
            "audio": includeAudio,
        ]

        if includeAudio {
            addAudioInput()
        }

        if let maxDuration = maxDuration {
            movieOutput.maxRecordedDuration = CMTime(seconds: maxDuration, preferredTimescale: 600)
        }

        if let maxFileSize = maxFileSize {
            movieOutput.maxRecordedFileSize = Int64(maxFileSize)
        }

        // Apply recording frame rate if specified.
        if let frameRate = frameRate, let device = currentDevice {
            do {
                try device.lockForConfiguration()
                let target = CMTime(value: 1, timescale: CMTimeScale(frameRate))
                device.activeVideoMinFrameDuration = target
                device.activeVideoMaxFrameDuration = target
                device.unlockForConfiguration()
            } catch {
                print("Failed to set recording frame rate: \(error)")
            }
        }

        let tempDir = FileManager.default.temporaryDirectory
        let fileName = "video_\(Date().timeIntervalSince1970).mov"
        let outputURL = tempDir.appendingPathComponent(fileName)

        pendingVideoCall = call
        isRecording = true
        recordingStartTime = Date()

        movieOutput.startRecording(to: outputURL, recordingDelegate: self)

        // Periodic recording-state updates (~2/s).
        recordingTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self = self, self.isRecording, let startTime = self.recordingStartTime else { return }
            let duration = Date().timeIntervalSince(startTime)
            let fileSize = self.movieOutput?.recordedFileSize ?? 0
            self.notifyListeners("recordingState", data: [
                "isRecording": true,
                "duration": duration,
                "fileSize": fileSize,
            ])
        }

        notifyListeners("recordingState", data: [
            "isRecording": true,
            "duration": 0,
            "fileSize": 0,
        ])

        call.resolve()
    }

    private func addAudioInput() {
        guard let session = captureSession else { return }
        guard let audioDevice = AVCaptureDevice.default(for: .audio) else { return }
        do {
            let audioInput = try AVCaptureDeviceInput(device: audioDevice)
            if session.canAddInput(audioInput) {
                session.addInput(audioInput)
            }
        } catch {
            print("Could not add audio input: \(error)")
        }
    }

    // MARK: - stopRecording

    @objc func stopRecording(_ call: CAPPluginCall) {
        guard isRecording, let movieOutput = self.movieOutput else {
            call.reject("Not recording")
            return
        }

        pendingVideoCall = call
        recordingTimer?.invalidate()
        recordingTimer = nil
        movieOutput.stopRecording()
    }

    // MARK: - getRecordingState

    @objc func getRecordingState(_ call: CAPPluginCall) {
        let duration = recordingStartTime.map { Date().timeIntervalSince($0) } ?? 0
        let fileSize = movieOutput?.recordedFileSize ?? 0

        call.resolve([
            "isRecording": isRecording,
            "duration": duration,
            "fileSize": fileSize,
        ])
    }

    // MARK: - getSettings

    @objc func getSettings(_ call: CAPPluginCall) {
        var settings = currentSettings

        // Read live values from device when available.
        if let device = currentDevice {
            settings["zoom"] = Double(device.videoZoomFactor)

            if device.hasTorch && device.torchMode == .on {
                settings["flash"] = "torch"
            }

            // Live ISO.
            settings["iso"] = Double(device.iso)

            // Live shutter speed (exposure duration in seconds).
            let duration = device.exposureDuration
            if duration.timescale > 0 {
                settings["shutterSpeed"] = Double(duration.value) / Double(duration.timescale)
            }
        }

        call.resolve(["settings": settings])
    }

    // MARK: - setSettings

    @objc func setSettings(_ call: CAPPluginCall) {
        guard let settingsObj = call.getObject("settings") else {
            call.reject("Missing settings parameter")
            return
        }

        // Persist all incoming keys.
        for (key, value) in settingsObj {
            currentSettings[key] = value
        }

        guard let device = currentDevice else {
            call.resolve()
            return
        }

        do {
            try device.lockForConfiguration()

            // Zoom.
            if let zoom = settingsObj["zoom"] as? Double {
                let clamped = max(1.0, min(device.maxAvailableVideoZoomFactor, CGFloat(zoom)))
                device.videoZoomFactor = clamped
            }

            // Flash / torch.
            if let flash = settingsObj["flash"] as? String {
                applyFlashOrTorch(flash, device: device)
            }

            // Focus mode.
            if let focus = settingsObj["focusMode"] as? String {
                applyFocusMode(focus, device: device)
            }

            // Exposure mode.
            if let exposure = settingsObj["exposureMode"] as? String {
                applyExposureMode(exposure, device: device)
            }

            // Exposure compensation.
            if let compensation = settingsObj["exposureCompensation"] as? Double {
                let clamped = max(
                    Double(device.minExposureTargetBias),
                    min(Double(device.maxExposureTargetBias), compensation)
                )
                device.setExposureTargetBias(Float(clamped), completionHandler: nil)
            }

            // White balance.
            if let wb = settingsObj["whiteBalance"] as? String {
                applyWhiteBalance(wb, device: device)
            }

            // ISO (requires custom exposure mode).
            if let iso = settingsObj["iso"] as? Double {
                let clampedISO = Float(max(
                    Double(device.activeFormat.minISO),
                    min(Double(device.activeFormat.maxISO), iso)
                ))
                device.setExposureModeCustom(
                    duration: device.exposureDuration,
                    iso: clampedISO,
                    completionHandler: nil
                )
            }

            // Shutter speed in seconds (requires custom exposure mode).
            if let speed = settingsObj["shutterSpeed"] as? Double {
                let minSec = CMTimeGetSeconds(device.activeFormat.minExposureDuration)
                let maxSec = CMTimeGetSeconds(device.activeFormat.maxExposureDuration)
                let clampedSpeed = max(minSec, min(maxSec, speed))
                let duration = CMTime(seconds: clampedSpeed, preferredTimescale: 1_000_000)
                device.setExposureModeCustom(
                    duration: duration,
                    iso: device.iso,
                    completionHandler: nil
                )
            }

            device.unlockForConfiguration()
            call.resolve()
        } catch {
            call.reject("Failed to apply settings: \(error.localizedDescription)")
            emitError(code: "SETTINGS_FAILED", message: error.localizedDescription)
        }
    }

    // MARK: - Settings helpers

    /// Apply flash mode or enable torch. Device must already be locked for configuration.
    private func applyFlashOrTorch(_ mode: String, device: AVCaptureDevice) {
        if mode == "torch" {
            if device.hasTorch {
                do {
                    try device.setTorchModeOn(level: AVCaptureDevice.maxAvailableTorchLevel)
                } catch {
                    print("Failed to enable torch: \(error)")
                }
            }
        } else {
            // Turn off torch when switching to a regular flash mode.
            if device.hasTorch && device.torchMode == .on {
                device.torchMode = .off
            }
        }
    }

    /// Apply focus mode. Device must already be locked for configuration.
    private func applyFocusMode(_ mode: String, device: AVCaptureDevice) {
        switch mode {
        case "auto":
            if device.isFocusModeSupported(.autoFocus) { device.focusMode = .autoFocus }
        case "continuous":
            if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
        case "manual":
            if device.isFocusModeSupported(.locked) { device.focusMode = .locked }
        default:
            break
        }
    }

    /// Apply exposure mode. Device must already be locked for configuration.
    private func applyExposureMode(_ mode: String, device: AVCaptureDevice) {
        switch mode {
        case "auto":
            if device.isExposureModeSupported(.autoExpose) { device.exposureMode = .autoExpose }
        case "continuous":
            if device.isExposureModeSupported(.continuousAutoExposure) { device.exposureMode = .continuousAutoExposure }
        case "manual":
            if device.isExposureModeSupported(.custom) { device.exposureMode = .custom }
        default:
            break
        }
    }

    /// Apply white balance preset. Device must already be locked for configuration.
    private func applyWhiteBalance(_ preset: String, device: AVCaptureDevice) {
        switch preset {
        case "auto":
            if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                device.whiteBalanceMode = .continuousAutoWhiteBalance
            }
        case "daylight", "cloudy", "tungsten", "fluorescent":
            if device.isWhiteBalanceModeSupported(.locked) {
                let temperature: Float
                switch preset {
                case "daylight":    temperature = 5500
                case "cloudy":      temperature = 6500
                case "tungsten":    temperature = 3200
                case "fluorescent": temperature = 4000
                default:            temperature = 5500
                }
                let tempTint = AVCaptureDevice.WhiteBalanceTemperatureAndTintValues(
                    temperature: temperature, tint: 0
                )
                let gains = device.deviceWhiteBalanceGains(for: tempTint)
                let clamped = clampWhiteBalanceGains(gains, for: device)
                device.setWhiteBalanceModeLocked(with: clamped, completionHandler: nil)
            }
        default:
            break
        }
    }

    /// Clamp white balance gains to the device's valid range.
    private func clampWhiteBalanceGains(
        _ gains: AVCaptureDevice.WhiteBalanceGains,
        for device: AVCaptureDevice
    ) -> AVCaptureDevice.WhiteBalanceGains {
        let maxGain = device.maxWhiteBalanceGain
        return AVCaptureDevice.WhiteBalanceGains(
            redGain: max(1.0, min(maxGain, gains.redGain)),
            greenGain: max(1.0, min(maxGain, gains.greenGain)),
            blueGain: max(1.0, min(maxGain, gains.blueGain))
        )
    }

    // MARK: - setZoom

    @objc func setZoom(_ call: CAPPluginCall) {
        guard let zoom = call.getDouble("zoom") else {
            call.reject("Missing zoom parameter")
            return
        }

        applyZoom(zoom)
        currentSettings["zoom"] = zoom
        call.resolve()
    }

    private func applyZoom(_ zoom: Double) {
        guard let device = currentDevice else { return }
        do {
            try device.lockForConfiguration()
            let clamped = max(1.0, min(device.maxAvailableVideoZoomFactor, CGFloat(zoom)))
            device.videoZoomFactor = clamped
            device.unlockForConfiguration()
        } catch {
            print("Failed to set zoom: \(error)")
        }
    }

    // MARK: - setFocusPoint

    @objc func setFocusPoint(_ call: CAPPluginCall) {
        guard let x = call.getDouble("x"), let y = call.getDouble("y") else {
            call.reject("Missing focus point coordinates")
            return
        }

        guard let device = currentDevice, device.isFocusPointOfInterestSupported else {
            call.reject("Focus point not supported")
            return
        }

        do {
            try device.lockForConfiguration()
            device.focusPointOfInterest = CGPoint(x: x, y: y)
            device.focusMode = .autoFocus
            device.unlockForConfiguration()
            call.resolve()
        } catch {
            call.reject("Failed to set focus point: \(error.localizedDescription)")
        }
    }

    // MARK: - setExposurePoint

    @objc func setExposurePoint(_ call: CAPPluginCall) {
        guard let x = call.getDouble("x"), let y = call.getDouble("y") else {
            call.reject("Missing exposure point coordinates")
            return
        }

        guard let device = currentDevice, device.isExposurePointOfInterestSupported else {
            call.reject("Exposure point not supported")
            return
        }

        do {
            try device.lockForConfiguration()
            device.exposurePointOfInterest = CGPoint(x: x, y: y)
            device.exposureMode = .autoExpose
            device.unlockForConfiguration()
            call.resolve()
        } catch {
            call.reject("Failed to set exposure point: \(error.localizedDescription)")
        }
    }

    // MARK: - Permissions

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        let cameraStatus = AVCaptureDevice.authorizationStatus(for: .video)
        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        let photosStatus = PHPhotoLibrary.authorizationStatus()

        call.resolve([
            "camera": permissionString(from: cameraStatus),
            "microphone": permissionString(from: micStatus),
            "photos": photosPermissionString(from: photosStatus),
        ])
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        let group = DispatchGroup()

        var cameraResult: AVAuthorizationStatus = .notDetermined
        var micResult: AVAuthorizationStatus = .notDetermined
        var photosResult: PHAuthorizationStatus = .notDetermined

        group.enter()
        AVCaptureDevice.requestAccess(for: .video) { _ in
            cameraResult = AVCaptureDevice.authorizationStatus(for: .video)
            group.leave()
        }

        group.enter()
        AVCaptureDevice.requestAccess(for: .audio) { _ in
            micResult = AVCaptureDevice.authorizationStatus(for: .audio)
            group.leave()
        }

        group.enter()
        PHPhotoLibrary.requestAuthorization { status in
            photosResult = status
            group.leave()
        }

        group.notify(queue: .main) { [weak self] in
            guard let self = self else { return }
            call.resolve([
                "camera": self.permissionString(from: cameraResult),
                "microphone": self.permissionString(from: micResult),
                "photos": self.photosPermissionString(from: photosResult),
            ])
        }
    }

    private func permissionString(from status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized:        return "granted"
        case .denied, .restricted: return "denied"
        default:                 return "prompt"
        }
    }

    private func photosPermissionString(from status: PHAuthorizationStatus) -> String {
        switch status {
        case .authorized:        return "granted"
        case .limited:           return "limited"
        case .denied, .restricted: return "denied"
        default:                 return "prompt"
        }
    }

    // MARK: - EXIF Extraction

    /// Extract EXIF metadata from a captured photo for the PhotoResult.exif field.
    private func extractExifMetadata(from photo: AVCapturePhoto) -> [String: Any]? {
        let metadata = photo.metadata
        var exif: [String: Any] = [:]

        if let exifDict = metadata[kCGImagePropertyExifDictionary as String] as? [String: Any] {
            if let v = exifDict[kCGImagePropertyExifExposureTime as String]    { exif["ExposureTime"] = v }
            if let v = exifDict[kCGImagePropertyExifFNumber as String]         { exif["FNumber"] = v }
            if let isos = exifDict[kCGImagePropertyExifISOSpeedRatings as String] as? [Int],
               let iso = isos.first                                            { exif["ISO"] = iso }
            if let v = exifDict[kCGImagePropertyExifFocalLength as String]     { exif["FocalLength"] = v }
            if let v = exifDict[kCGImagePropertyExifLensModel as String]       { exif["LensModel"] = v }
            if let v = exifDict[kCGImagePropertyExifDateTimeOriginal as String] { exif["DateTimeOriginal"] = v }
            if let v = exifDict[kCGImagePropertyExifBrightnessValue as String] { exif["BrightnessValue"] = v }
        }

        if let tiffDict = metadata[kCGImagePropertyTIFFDictionary as String] as? [String: Any] {
            if let v = tiffDict[kCGImagePropertyTIFFMake as String]        { exif["Make"] = v }
            if let v = tiffDict[kCGImagePropertyTIFFModel as String]       { exif["Model"] = v }
            if let v = tiffDict[kCGImagePropertyTIFFOrientation as String] { exif["Orientation"] = v }
        }

        if let gpsDict = metadata[kCGImagePropertyGPSDictionary as String] as? [String: Any] {
            if let v = gpsDict[kCGImagePropertyGPSLatitude as String]  { exif["GPSLatitude"] = v }
            if let v = gpsDict[kCGImagePropertyGPSLongitude as String] { exif["GPSLongitude"] = v }
        }

        return exif.isEmpty ? nil : exif
    }

    // MARK: - MP4 Export (ported from classic CameraController.exportToMP4)

    /// Transcode .mov to .mp4 for easier downstream handling.
    private func exportToMP4(inputURL: URL, completion: @escaping (Result<URL, Error>) -> Void) {
        let mp4URL = FileManager.default.temporaryDirectory
            .appendingPathComponent("video_\(Date().timeIntervalSince1970).mp4")

        let asset = AVURLAsset(url: inputURL)
        guard let exporter = AVAssetExportSession(
            asset: asset,
            presetName: AVAssetExportPresetHighestQuality
        ) else {
            completion(.failure(NSError(domain: "ElizaCamera", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Failed to create export session",
            ])))
            return
        }

        exporter.outputURL = mp4URL
        exporter.outputFileType = .mp4
        exporter.shouldOptimizeForNetworkUse = true

        exporter.exportAsynchronously {
            switch exporter.status {
            case .completed:
                completion(.success(mp4URL))
            case .failed:
                completion(.failure(exporter.error ?? NSError(domain: "ElizaCamera", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "Export failed",
                ])))
            case .cancelled:
                completion(.failure(NSError(domain: "ElizaCamera", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: "Export cancelled",
                ])))
            default:
                completion(.failure(NSError(domain: "ElizaCamera", code: 4, userInfo: [
                    NSLocalizedDescriptionKey: "Export did not complete",
                ])))
            }
        }
    }
}

// MARK: - AVCapturePhotoCaptureDelegate

extension ElizaCameraPlugin: AVCapturePhotoCaptureDelegate {
    public func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        guard let call = pendingPhotoCall else { return }
        pendingPhotoCall = nil

        if let error = error {
            call.reject("Photo capture failed: \(error.localizedDescription)")
            emitError(code: "CAPTURE_FAILED", message: error.localizedDescription)
            return
        }

        guard let imageData = photo.fileDataRepresentation() else {
            call.reject("Failed to get image data")
            emitError(code: "CAPTURE_FAILED", message: "Failed to get image data")
            return
        }

        guard let image = UIImage(data: imageData) else {
            call.reject("Failed to create image")
            return
        }

        let options = currentPhotoOptions ?? [:]
        let rawQuality = options["quality"] as? Float ?? 90
        let quality = Self.clampQuality(rawQuality)
        let format = options["format"] as? String ?? "jpeg"
        let saveToGallery = options["saveToGallery"] as? Bool ?? false
        let targetWidth = options["width"] as? Int
        let targetHeight = options["height"] as? Int
        let includeExif = options["includeExif"] as? Bool ?? true

        var finalImage = image

        // Resize if target dimensions are specified.
        if let width = targetWidth, let height = targetHeight {
            let size = CGSize(width: width, height: height)
            UIGraphicsBeginImageContextWithOptions(size, false, 1.0)
            image.draw(in: CGRect(origin: .zero, size: size))
            if let resized = UIGraphicsGetImageFromCurrentImageContext() {
                finalImage = resized
            }
            UIGraphicsEndImageContext()
        }

        var outputData: Data?
        var outputFormat = format

        switch format {
        case "png":
            outputData = finalImage.pngData()
            outputFormat = "png"
        case "webp":
            // iOS has no native WebP encoder; fall back to JPEG.
            outputData = finalImage.jpegData(compressionQuality: CGFloat(quality))
            outputFormat = "jpeg"
        default:
            outputData = finalImage.jpegData(compressionQuality: CGFloat(quality))
            outputFormat = "jpeg"
        }

        guard let data = outputData else {
            call.reject("Failed to encode image")
            return
        }

        // Save to temp file for the `path` field in PhotoResult.
        let ext = outputFormat == "png" ? "png" : "jpg"
        let tempPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("photo_\(Date().timeIntervalSince1970).\(ext)")
        try? data.write(to: tempPath)

        if saveToGallery {
            PHPhotoLibrary.shared().performChanges({
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: .photo, data: data, options: nil)
            }, completionHandler: nil)
        }

        let base64 = data.base64EncodedString()

        var result: [String: Any] = [
            "base64": base64,
            "format": outputFormat,
            "width": Int(finalImage.size.width),
            "height": Int(finalImage.size.height),
            "path": tempPath.absoluteString,
        ]

        // Include EXIF metadata if requested.
        if includeExif, let exif = extractExifMetadata(from: photo) {
            result["exif"] = exif
        }

        call.resolve(result)
    }
}

// MARK: - AVCaptureFileOutputRecordingDelegate

extension ElizaCameraPlugin: AVCaptureFileOutputRecordingDelegate {
    public func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        isRecording = false
        recordingTimer?.invalidate()
        recordingTimer = nil

        guard let call = pendingVideoCall else { return }
        pendingVideoCall = nil

        // Treat max-duration/max-file-size reached as success (ported from classic).
        if let error = error {
            let ns = error as NSError
            let isExpectedStop = ns.domain == AVFoundationErrorDomain
                && (ns.code == AVError.maximumDurationReached.rawValue
                    || ns.code == AVError.maximumFileSizeReached.rawValue)
            if !isExpectedStop {
                call.reject("Recording failed: \(error.localizedDescription)")
                emitError(code: "RECORDING_FAILED", message: error.localizedDescription)
                try? FileManager.default.removeItem(at: outputFileURL)
                return
            }
        }

        let duration = recordingStartTime.map { Date().timeIntervalSince($0) } ?? 0
        let options = currentVideoOptions ?? [:]
        let saveToGallery = options["saveToGallery"] as? Bool ?? false

        // Transcode .mov -> .mp4 (ported from classic CameraController).
        exportToMP4(inputURL: outputFileURL) { [weak self] result in
            guard let self = self else { return }

            switch result {
            case .success(let mp4URL):
                // Clean up the original .mov.
                try? FileManager.default.removeItem(at: outputFileURL)

                var fileSize: Int64 = 0
                var width = 0
                var height = 0

                if let attrs = try? FileManager.default.attributesOfItem(atPath: mp4URL.path) {
                    fileSize = attrs[.size] as? Int64 ?? 0
                }

                let asset = AVAsset(url: mp4URL)
                if let track = asset.tracks(withMediaType: .video).first {
                    let size = track.naturalSize.applying(track.preferredTransform)
                    width = Int(abs(size.width))
                    height = Int(abs(size.height))
                }

                if saveToGallery {
                    PHPhotoLibrary.shared().performChanges({
                        PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: mp4URL)
                    }, completionHandler: nil)
                }

                self.notifyListeners("recordingState", data: [
                    "isRecording": false,
                    "duration": duration,
                    "fileSize": fileSize,
                ])

                call.resolve([
                    "path": mp4URL.absoluteString,
                    "duration": duration,
                    "width": width,
                    "height": height,
                    "fileSize": fileSize,
                    "mimeType": "video/mp4",
                ])

            case .failure:
                // MP4 export failed; fall back to the original .mov file.
                var fileSize: Int64 = 0
                var width = 0
                var height = 0

                if let attrs = try? FileManager.default.attributesOfItem(atPath: outputFileURL.path) {
                    fileSize = attrs[.size] as? Int64 ?? 0
                }

                let asset = AVAsset(url: outputFileURL)
                if let track = asset.tracks(withMediaType: .video).first {
                    let size = track.naturalSize.applying(track.preferredTransform)
                    width = Int(abs(size.width))
                    height = Int(abs(size.height))
                }

                if saveToGallery {
                    PHPhotoLibrary.shared().performChanges({
                        PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: outputFileURL)
                    }, completionHandler: nil)
                }

                self.notifyListeners("recordingState", data: [
                    "isRecording": false,
                    "duration": duration,
                    "fileSize": fileSize,
                ])

                call.resolve([
                    "path": outputFileURL.absoluteString,
                    "duration": duration,
                    "width": width,
                    "height": height,
                    "fileSize": fileSize,
                    "mimeType": "video/quicktime",
                ])
            }
        }
    }
}

// MARK: - AVCaptureVideoDataOutputSampleBufferDelegate (Frame Events)

extension ElizaCameraPlugin: AVCaptureVideoDataOutputSampleBufferDelegate {
    public func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        // Throttle frame events to ~2/s to avoid overwhelming the JS bridge.
        let now = CFAbsoluteTimeGetCurrent()
        guard now - lastFrameEmitTime >= 0.5 else { return }
        lastFrameEmitTime = now

        guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
        let dims = CMVideoFormatDescriptionGetDimensions(formatDesc)
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let timestampMs = CMTimeGetSeconds(pts).isFinite ? Int(CMTimeGetSeconds(pts) * 1000) : 0

        notifyListeners("frame", data: [
            "timestamp": timestampMs,
            "width": Int(dims.width),
            "height": Int(dims.height),
        ])
    }
}
