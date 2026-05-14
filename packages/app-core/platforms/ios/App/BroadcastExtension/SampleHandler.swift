// TODO: validate on device — checklist in
// eliza/plugins/plugin-computeruse/docs/IOS_CONSTRAINTS.md
//
// ReplayKit broadcast extension target. Runs in a separate process with a
// ~50MB memory ceiling enforced by iOS. Streams compressed JPEG frames into
// the shared App Group container so the main app can read them.
//
// iOS 26 / 26.1 beta regression: the extension is killed within ~3 seconds
// even when memory headroom is fine. We write a `regression-detected`
// sentinel into the shared container on `broadcastFinished` with an unknown
// reason so the main app can surface this clearly. Track Apple feedback
// status before deciding to ship this target on iOS 26.
//
// The Xcode target for this file is configured separately — it does not
// build with the main app target. Add it as a `Broadcast Upload Extension`
// in the project before linking.

import os
import ReplayKit
import UIKit

class SampleHandler: RPBroadcastSampleHandler {
    private static let appGroupId = "group.ai.elizaos.app"
    private static let frameSubdir = "broadcast-frames"
    private static let regressionSentinel = "regression-detected"
    private static let log = Logger(subsystem: "ai.eliza.computeruse",
                                    category: "broadcast-extension")

    private var startedAt = Date()
    private var frameCounter = 0

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        startedAt = Date()
        frameCounter = 0
        Self.log.info("broadcast started")
        // Clear stale sentinel
        if let url = sharedSentinelUrl() {
            try? FileManager.default.removeItem(at: url)
        }
        if let dir = framesDir() {
            try? FileManager.default.createDirectory(at: dir,
                                                     withIntermediateDirectories: true)
        }
    }

    override func broadcastFinished() {
        let elapsed = Date().timeIntervalSince(startedAt)
        Self.log.info("broadcast finished after \(elapsed, privacy: .public)s frames=\(self.frameCounter, privacy: .public)")
        // Heuristic regression detector — if we lasted < 5s with < 5 frames,
        // mark the regression sentinel so the main app's broadcast handshake
        // can surface it to JS.
        if elapsed < 5, frameCounter < 5 {
            if let url = sharedSentinelUrl() {
                let body: [String: Any] = [
                    "observedAt": Int(Date().timeIntervalSince1970 * 1000),
                    "elapsedSec": elapsed,
                    "frames": frameCounter,
                ]
                if let data = try? JSONSerialization.data(withJSONObject: body) {
                    try? data.write(to: url)
                }
            }
        }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer,
                                      with sampleBufferType: RPSampleBufferType) {
        guard sampleBufferType == .video else { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let context = CIContext(options: [.useSoftwareRenderer: false])
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return }
        let uiImage = UIImage(cgImage: cgImage)
        guard let jpeg = uiImage.jpegData(compressionQuality: 0.6) else { return }
        guard let dir = framesDir() else { return }
        let filename = "\(Int(Date().timeIntervalSince1970 * 1000)).jpg"
        let target = dir.appendingPathComponent(filename)
        do {
            try jpeg.write(to: target, options: .atomic)
            frameCounter += 1
        } catch {
            Self.log.error("frame write failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: helpers

    private func sharedContainerUrl() -> URL? {
        return FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: Self.appGroupId)
    }

    private func framesDir() -> URL? {
        return sharedContainerUrl()?.appendingPathComponent(Self.frameSubdir)
    }

    private func sharedSentinelUrl() -> URL? {
        return sharedContainerUrl()?.appendingPathComponent(Self.regressionSentinel)
    }
}
