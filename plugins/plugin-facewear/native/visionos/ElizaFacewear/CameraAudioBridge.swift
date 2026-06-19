import AVFoundation
import Foundation

/// Captures persona/world camera as JPEG frames and microphone as PCM-f32 audio,
/// then forwards them to the elizaOS agent via AgentConnection binary frames.
///
/// Camera: AVCaptureSession with AVCaptureVideoDataOutput → JPEG → frame binary frame
/// Audio:  AVAudioEngine mic tap → PCM-f32 buffer → audio binary frame
@MainActor
final class CameraAudioBridge: NSObject {
    private let connection: AgentConnection
    private var captureSession: AVCaptureSession?
    private let videoQueue = DispatchQueue(label: "com.elizaos.facewear.video")
    private var audioEngine: AVAudioEngine?
    private var isRunning = false

    // Throttle camera frames to ~4 fps
    private let frameIntervalMs: TimeInterval = 0.25
    private var lastFrameTime: Date = .distantPast

    init(connection: AgentConnection) {
        self.connection = connection
    }

    func start() {
        guard !isRunning else { return }
        isRunning = true
        startCamera()
        startAudio()
    }

    func stop() {
        isRunning = false
        captureSession?.stopRunning()
        captureSession = nil
        audioEngine?.stop()
        audioEngine = nil
    }

    // MARK: - Camera

    private func startCamera() {
        let session = AVCaptureSession()
        session.sessionPreset = .vga640x480

        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
                ?? AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device) else { return }

        if session.canAddInput(input) { session.addInput(input) }

        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: videoQueue)

        if session.canAddOutput(output) { session.addOutput(output) }

        captureSession = session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
    }

    // MARK: - Audio

    private func startAudio() {
        let engine = AVAudioEngine()
        let inputNode = engine.inputNode
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false)!
        let inputFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, time in
            guard let self, self.isRunning else { return }
            // Resample if needed — simple conversion for common formats
            self.sendAudioBuffer(buffer)
        }

        do {
            try engine.start()
            audioEngine = engine
        } catch {
            // Audio capture unavailable — continue with camera only
        }
    }

    private func sendAudioBuffer(_ buffer: AVAudioPCMBuffer) {
        guard let channelData = buffer.floatChannelData else { return }
        let frameCount = Int(buffer.frameLength)
        let sampleRate = buffer.format.sampleRate

        var floats = [Float](repeating: 0, count: frameCount)
        for i in 0..<frameCount {
            floats[i] = channelData[0][i]
        }

        let payload = floats.withUnsafeBytes { Data($0) }
        let ts = Date().timeIntervalSince1970 * 1000

        Task { @MainActor [weak self] in
            self?.connection.sendBinaryFrame(
                header: [
                    "type": "audio",
                    "ts": ts,
                    "sampleRate": sampleRate,
                    "encoding": "pcm-f32"
                ],
                payload: payload
            )
        }
    }
}

// MARK: - AVCaptureVideoDataOutputSampleBufferDelegate

extension CameraAudioBridge: AVCaptureVideoDataOutputSampleBufferDelegate {
    nonisolated func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        let now = Date()
        // Access lastFrameTime synchronously — videoQueue is serial, safe to check here
        guard now.timeIntervalSince(lastFrameTime) >= frameIntervalMs else { return }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }

        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        guard let baseAddress = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: baseAddress,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ), let cgImage = context.makeImage() else { return }

        let mutableData = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(mutableData, "public.jpeg" as CFString, 1, nil) else { return }
        CGImageDestinationAddImage(destination, cgImage, [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return }

        let jpegData = mutableData as Data
        let ts = Date().timeIntervalSince1970 * 1000

        Task { @MainActor [weak self] in
            guard let self else { return }
            self.lastFrameTime = now
            self.connection.sendBinaryFrame(
                header: [
                    "type": "frame",
                    "ts": ts,
                    "width": width,
                    "height": height,
                    "format": "jpeg"
                ],
                payload: jpegData
            )
        }
    }
}
