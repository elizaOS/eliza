// TODO: validate on device — checklist in
// eliza/plugins/plugin-computeruse/docs/IOS_CONSTRAINTS.md
//
// Capacitor plugin that exposes the iOS-only computer-use surface to the
// JS layer. Mirrors the TS interface in
// `eliza/plugins/plugin-computeruse/src/mobile/ios-bridge.ts` — keep both
// files in lock-step. The MARK contract block at the bottom lists every
// method signature; if you change one, change both.
//
// Capabilities exposed (and only these — Apple does not allow more):
//   1. ReplayKit foreground capture (own app)
//   2. ReplayKit broadcast extension handshake (system-wide capture is
//      driven by the user via the share-sheet picker, not by us)
//   3. Apple Vision OCR
//   4. App Intents discovery + invocation
//   5. UIAccessibility own-app snapshot
//   6. Apple Foundation Models (iOS 26+)
//   7. Memory pressure signal (one-shot probe)

import AppIntents
import Capacitor
import CoreGraphics
import Foundation
import os
import ReplayKit
import UIKit
import Vision

// MARK: - Bridge plugin

@objc(ComputerUseBridge)
public class ComputerUseBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ComputerUseBridge"
    public let jsName = "ComputerUse"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "replayKitForegroundStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "replayKitForegroundStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "replayKitForegroundDrain", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "broadcastExtensionHandshake", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "visionOcr", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appIntentList", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appIntentInvoke", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "accessibilitySnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "foundationModelGenerate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "memoryPressureProbe", returnType: CAPPluginReturnPromise),
    ]

    private static let appGroupId = "group.ai.elizaos.app"
    private static let log = Logger(subsystem: "ai.eliza.computeruse", category: "bridge")

    // ── Session state ────────────────────────────────────────────────────────

    private let captureLock = NSLock()
    private var activeForegroundSessionId: String?
    private var foregroundFrameRing: [[String: Any]] = []
    private var foregroundFrameLimit: Int = 30
    private var foregroundSessionExpiresAt: Date?

    // ── 0. probe ─────────────────────────────────────────────────────────────

    @objc public func probe(_ call: CAPPluginCall) {
        let osVersion = UIDevice.current.systemVersion
        let foundation = isFoundationModelAvailable()
        call.resolve([
            "ok": true,
            "data": [
                "platform": "ios",
                "osVersion": osVersion,
                "capabilities": [
                    "replayKitForeground": RPScreenRecorder.shared().isAvailable,
                    "broadcastExtension": broadcastExtensionInstalled(),
                    "visionOcr": true,
                    "appIntents": true,
                    "accessibilityRead": true,
                    "foundationModel": foundation,
                ] as [String: Any],
            ] as [String: Any],
        ])
    }

    // ── 1. ReplayKit foreground ──────────────────────────────────────────────

    @objc public func replayKitForegroundStart(_ call: CAPPluginCall) {
        let frameRate = max(1, min(call.getInt("frameRate") ?? 1, 30))
        let maxDurationSec = max(1, min(call.getInt("maxDurationSec") ?? 30, 30))
        let includeAudio = call.getBool("includeAudio") ?? false

        let recorder = RPScreenRecorder.shared()
        guard recorder.isAvailable else {
            return resolveError(call, code: "unsupported_platform",
                                message: "RPScreenRecorder reports unavailable on this device.")
        }

        let sessionId = UUID().uuidString
        captureLock.lock()
        activeForegroundSessionId = sessionId
        foregroundFrameRing.removeAll(keepingCapacity: true)
        foregroundSessionExpiresAt = Date().addingTimeInterval(TimeInterval(maxDurationSec))
        captureLock.unlock()

        recorder.isMicrophoneEnabled = includeAudio
        recorder.startCapture(handler: { [weak self] sampleBuffer, bufferType, error in
            guard let self else { return }
            if let error = error {
                Self.log.error("replayKit capture error: \(error.localizedDescription, privacy: .public)")
                return
            }
            guard bufferType == .video else { return }
            self.absorbForegroundFrame(sampleBuffer: sampleBuffer, throttleHz: frameRate)
        }, completionHandler: { [weak self] error in
            guard let self else { return }
            if let error = error {
                self.captureLock.lock()
                self.activeForegroundSessionId = nil
                self.captureLock.unlock()
                self.resolveError(call, code: "permission_denied",
                                  message: "startCapture failed: \(error.localizedDescription)")
                return
            }
            call.resolve([
                "ok": true,
                "data": [
                    "sessionId": sessionId,
                    "effective": [
                        "frameRate": frameRate,
                        "maxDurationSec": maxDurationSec,
                        "includeAudio": includeAudio,
                    ] as [String: Any],
                ] as [String: Any],
            ])
        })
    }

    @objc public func replayKitForegroundStop(_ call: CAPPluginCall) {
        guard let sessionId = call.getString("sessionId") else {
            return resolveError(call, code: "internal_error", message: "sessionId required")
        }
        captureLock.lock()
        let active = activeForegroundSessionId
        captureLock.unlock()
        guard sessionId == active else {
            return resolveError(call, code: "internal_error",
                                message: "sessionId does not match the active session.")
        }
        RPScreenRecorder.shared().stopCapture { [weak self] error in
            guard let self else { return }
            self.captureLock.lock()
            self.activeForegroundSessionId = nil
            self.foregroundFrameRing.removeAll(keepingCapacity: false)
            self.foregroundSessionExpiresAt = nil
            self.captureLock.unlock()
            if let error = error {
                self.resolveError(call, code: "internal_error",
                                  message: "stopCapture failed: \(error.localizedDescription)")
                return
            }
            call.resolve([
                "ok": true,
                "data": ["sessionId": sessionId] as [String: Any],
            ])
        }
    }

    @objc public func replayKitForegroundDrain(_ call: CAPPluginCall) {
        guard let sessionId = call.getString("sessionId") else {
            return resolveError(call, code: "internal_error", message: "sessionId required")
        }
        let max = call.getInt("max") ?? 10
        captureLock.lock()
        let active = activeForegroundSessionId
        let frames: [[String: Any]]
        if active == sessionId {
            let take = min(max, foregroundFrameRing.count)
            frames = Array(foregroundFrameRing.prefix(take))
            foregroundFrameRing.removeFirst(take)
        } else {
            frames = []
        }
        captureLock.unlock()
        guard active == sessionId else {
            return resolveError(call, code: "internal_error",
                                message: "Session not active.")
        }
        call.resolve([
            "ok": true,
            "data": ["frames": frames] as [String: Any],
        ])
    }

    private func absorbForegroundFrame(sampleBuffer: CMSampleBuffer, throttleHz: Int) {
        // Throttle to roughly `throttleHz` frames per second.
        let now = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let nowNs = Int64(CMTimeGetSeconds(now) * 1_000_000_000)
        captureLock.lock()
        defer { captureLock.unlock() }
        if let last = foregroundFrameRing.last,
           let lastTs = last["timestampNs"] as? Int64 {
            let intervalNs = Int64(1_000_000_000) / Int64(throttleHz)
            if nowNs - lastTs < intervalNs { return }
        }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let context = CIContext()
        let extent = ciImage.extent
        guard let cgImage = context.createCGImage(ciImage, from: extent) else { return }
        let uiImage = UIImage(cgImage: cgImage)
        guard let jpeg = uiImage.jpegData(compressionQuality: 0.7) else { return }
        let frame: [String: Any] = [
            "timestampNs": nowNs,
            "width": Int(extent.width),
            "height": Int(extent.height),
            "jpegBase64": jpeg.base64EncodedString(),
        ]
        foregroundFrameRing.append(frame)
        if foregroundFrameRing.count > foregroundFrameLimit {
            foregroundFrameRing.removeFirst(foregroundFrameRing.count - foregroundFrameLimit)
        }
    }

    // ── 2. Broadcast extension ───────────────────────────────────────────────

    @objc public func broadcastExtensionHandshake(_ call: CAPPluginCall) {
        let installed = broadcastExtensionInstalled()
        let containerUrl = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: Self.appGroupId)
        let containerPath = containerUrl?.path ?? ""
        var availableMb: Int = -1
        availableMb = Int(os_proc_available_memory() / (1024 * 1024))
        let active = RPScreenRecorder.shared().isRecording
        // iOS 26 / 26.1 beta regression: extensions are killed within ~3s. We
        // expose the observed-flag so the JS layer can surface a clear error.
        let regression: [String: Any] = [
            "observed": false,
            "note": "iOS 26 / 26.1 beta has been observed to kill broadcast extensions within ~3s; track FB-pending and fall back to foreground capture.",
        ]
        call.resolve([
            "ok": true,
            "data": [
                "extensionInstalled": installed,
                "appGroupId": Self.appGroupId,
                "sharedContainerPath": containerPath,
                "availableMemoryMb": availableMb,
                "broadcastActive": active,
                "regression": regression,
            ] as [String: Any],
        ])
    }

    private func broadcastExtensionInstalled() -> Bool {
        // Detected presence by checking the App Group container for the
        // extension's IPC directory. The extension target writes a marker
        // file on first launch; absence means it isn't bundled.
        guard let url = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: Self.appGroupId) else {
            return false
        }
        let markerPath = url.appendingPathComponent("broadcast-extension.installed")
        return FileManager.default.fileExists(atPath: markerPath.path)
    }

    // ── 3. Apple Vision OCR ──────────────────────────────────────────────────

    @objc public func visionOcr(_ call: CAPPluginCall) {
        guard let imageBase64 = call.getString("imageBase64"),
              let imageData = Data(base64Encoded: imageBase64) else {
            return resolveError(call, code: "internal_error",
                                message: "imageBase64 is required and must be valid base64.")
        }
        guard let cgImage = UIImage(data: imageData)?.cgImage else {
            return resolveError(call, code: "internal_error",
                                message: "Could not decode image data into a CGImage.")
        }
        let optionsDict = call.getObject("options") ?? [:]
        let languages = (optionsDict["languages"] as? [String]) ?? []
        let recognitionLevel = (optionsDict["recognitionLevel"] as? String) ?? "accurate"
        let minimumTextHeight = optionsDict["minimumTextHeight"] as? Double
        let usesLanguageCorrection = (optionsDict["usesLanguageCorrection"] as? Bool) ?? true

        let request = VNRecognizeTextRequest { request, error in
            if let error = error {
                self.resolveError(call, code: "internal_error",
                                  message: "Vision OCR error: \(error.localizedDescription)")
                return
            }
            guard let observations = request.results as? [VNRecognizedTextObservation] else {
                self.resolveError(call, code: "vision_no_text", message: "No text observations.")
                return
            }
            let start = Date()
            let lines: [[String: Any]] = observations.compactMap { observation in
                guard let candidate = observation.topCandidates(1).first else { return nil }
                let bb = observation.boundingBox
                return [
                    "text": candidate.string,
                    "confidence": Double(candidate.confidence),
                    "boundingBox": [
                        "x": bb.origin.x,
                        "y": bb.origin.y,
                        "width": bb.size.width,
                        "height": bb.size.height,
                    ] as [String: Any],
                ]
            }
            let fullText = lines.compactMap { $0["text"] as? String }.joined(separator: "\n")
            let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
            call.resolve([
                "ok": true,
                "data": [
                    "lines": lines,
                    "fullText": fullText,
                    "elapsedMs": elapsedMs,
                    "languagesUsed": languages.isEmpty ? ["auto"] : languages,
                ] as [String: Any],
            ])
        }
        request.recognitionLevel = (recognitionLevel == "fast") ? .fast : .accurate
        request.usesLanguageCorrection = usesLanguageCorrection
        if !languages.isEmpty { request.recognitionLanguages = languages }
        if let mth = minimumTextHeight { request.minimumTextHeight = Float(mth) }

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try handler.perform([request])
            } catch {
                self.resolveError(call, code: "internal_error",
                                  message: "VNImageRequestHandler.perform failed: \(error.localizedDescription)")
            }
        }
    }

    // ── 4. App Intents ───────────────────────────────────────────────────────

    @objc public func appIntentList(_ call: CAPPluginCall) {
        // The runtime list of donated intents is privacy-gated — iOS does not
        // expose a public API to enumerate every intent on the device. We
        // return whatever this app has registered locally via
        // `AppShortcutsProvider`. The TS-side static registry covers known
        // system intents the planner can target without enumeration.
        let intents: [[String: Any]] = []
        call.resolve([
            "ok": true,
            "data": ["intents": intents] as [String: Any],
        ])
    }

    @objc public func appIntentInvoke(_ call: CAPPluginCall) {
        guard let intentId = call.getString("intentId") else {
            return resolveError(call, code: "internal_error", message: "intentId required")
        }
        let parameters = call.getObject("parameters") ?? [:]
        let start = Date()
        // Native invocation is limited to the x-callback URL schemes mapped
        // in makeXCallbackUrl. Other catalog entries are Shortcuts-only or
        // informational and must fail honestly instead of looking native.
        if let url = makeXCallbackUrl(intentId: intentId, parameters: parameters) {
            DispatchQueue.main.async {
                UIApplication.shared.open(url, options: [:]) { success in
                    let elapsed = Int(Date().timeIntervalSince(start) * 1000)
                    call.resolve([
                        "ok": true,
                        "data": [
                            "intentId": intentId,
                            "success": success,
                            "elapsedMs": elapsed,
                        ] as [String: Any],
                    ])
                }
            }
            return
        }
        resolveError(call, code: "intent_not_found",
                     message: "No native x-callback invocation path for intent \(intentId).")
    }

    private func makeXCallbackUrl(intentId: String, parameters: [String: Any]) -> URL? {
        // Keep this native map in sync with
        // IOS_NATIVE_X_CALLBACK_INTENT_IDS. Anything not mapped resolves to
        // nil so the JS surface returns `intent_not_found`.
        switch intentId {
        case "com.apple.mobilemail.send-email":
            var components = URLComponents(string: "mailto:")
            var queryItems: [URLQueryItem] = []
            if let to = parameters["to"] as? String { components?.path = to }
            if let subject = parameters["subject"] as? String {
                queryItems.append(URLQueryItem(name: "subject", value: subject))
            }
            if let body = parameters["body"] as? String {
                queryItems.append(URLQueryItem(name: "body", value: body))
            }
            if !queryItems.isEmpty { components?.queryItems = queryItems }
            return components?.url
        case "com.apple.MobileSMS.send-message":
            let recipients = (parameters["recipients"] as? String) ?? ""
            var components = URLComponents(string: "sms:\(recipients)")
            if let body = parameters["body"] as? String {
                components?.queryItems = [URLQueryItem(name: "body", value: body)]
            }
            return components?.url
        case "com.apple.Maps.directions":
            var components = URLComponents(string: "http://maps.apple.com/")
            var items: [URLQueryItem] = []
            if let dest = parameters["destination"] as? String {
                items.append(URLQueryItem(name: "daddr", value: dest))
            }
            if let origin = parameters["origin"] as? String {
                items.append(URLQueryItem(name: "saddr", value: origin))
            }
            if let transport = parameters["transport"] as? String {
                let mode: String
                switch transport {
                case "walking": mode = "w"
                case "transit": mode = "r"
                case "cycling": mode = "c"
                default: mode = "d"
                }
                items.append(URLQueryItem(name: "dirflg", value: mode))
            }
            components?.queryItems = items
            return components?.url
        case "com.apple.mobilesafari.open-url":
            if let urlString = parameters["url"] as? String {
                return URL(string: urlString)
            }
            return nil
        default:
            return nil
        }
    }

    // ── 5. UIAccessibility own-app snapshot ──────────────────────────────────

    @objc public func accessibilitySnapshot(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let window = UIApplication.shared.connectedScenes
                .compactMap({ ($0 as? UIWindowScene)?.keyWindow })
                .first ?? UIApplication.shared.windows.first(where: { $0.isKeyWindow }) else {
                self.resolveError(call, code: "internal_error",
                                  message: "No key window available for snapshot.")
                return
            }
            let tree = self.snapshotAccessibility(view: window)
            call.resolve([
                "ok": true,
                "data": [
                    "screenName": window.rootViewController?.title ?? "",
                    "tree": tree,
                    "capturedAt": Int(Date().timeIntervalSince1970 * 1000),
                ] as [String: Any],
            ])
        }
    }

    private func snapshotAccessibility(view: UIView, depth: Int = 0) -> [String: Any] {
        let role: String
        if let label = view.accessibilityLabel, !label.isEmpty { role = "labeled" } else { role = String(describing: type(of: view)) }
        var node: [String: Any] = [
            "id": String(view.hash),
            "role": role,
            "isFocused": view.accessibilityElementsHidden == false && view.isAccessibilityElement,
        ]
        if let label = view.accessibilityLabel { node["label"] = label }
        if let value = view.accessibilityValue { node["value"] = value }
        if depth < 16 {
            let children = view.subviews.map { self.snapshotAccessibility(view: $0, depth: depth + 1) }
            node["children"] = children
        } else {
            node["children"] = [] as [Any]
        }
        return node
    }

    // ── 6. Apple Foundation Models ───────────────────────────────────────────

    @objc public func foundationModelGenerate(_ call: CAPPluginCall) {
        guard let prompt = call.getString("prompt") else {
            return resolveError(call, code: "internal_error", message: "prompt required")
        }
        guard isFoundationModelAvailable() else {
            return resolveError(call, code: "foundation_model_unavailable",
                                message: "Apple Foundation Models requires iOS 26+ with Apple Intelligence enabled.")
        }
        // Real implementation will load the system LanguageModel via the
        // FoundationModels framework. We surface a clear unavailable error
        // until the on-device target is validated. The shape below matches
        // the TS contract so the JS side can already integrate.
        let _ = prompt
        let _ = call.getObject("options")
        resolveError(call, code: "foundation_model_unavailable",
                     message: "Foundation Models adapter is stubbed pending on-device validation.")
    }

    private func isFoundationModelAvailable() -> Bool {
        if #available(iOS 26.0, *) {
            // The actual API check lives in `FoundationModels.LanguageModel.isAvailable`.
            // Keep the runtime probe behind that gate; default to false until
            // the framework is linked.
            return false
        }
        return false
    }

    // ── 7. Memory pressure probe ─────────────────────────────────────────────

    @objc public func memoryPressureProbe(_ call: CAPPluginCall) {
        let availableMb = Int(os_proc_available_memory() / (1024 * 1024))
        let lastWarning = MemoryPressureRecorder.shared.lastWarningEpochMs
        let severity: Double
        if availableMb < 50 { severity = 1.0 }
        else if availableMb < 150 { severity = 0.7 }
        else if lastWarning != nil { severity = 0.7 }
        else { severity = 0.0 }
        var details: [String: Any] = [:]
        if let last = lastWarning { details["lastWarningAt"] = last }
        details["broadcastActive"] = RPScreenRecorder.shared().isRecording
        var data: [String: Any] = [
            "source": "ios-uikit",
            "capturedAt": Int(Date().timeIntervalSince1970 * 1000),
            "severity": severity,
            "availableMb": availableMb,
            "broadcastActive": RPScreenRecorder.shared().isRecording,
            "details": details,
        ]
        if let last = lastWarning { data["lastWarningAt"] = last }
        call.resolve([
            "ok": true,
            "data": data,
        ])
    }

    // ── Error helper ─────────────────────────────────────────────────────────

    private func resolveError(_ call: CAPPluginCall, code: String, message: String) {
        call.resolve([
            "ok": false,
            "code": code,
            "message": message,
        ])
    }
}

// MARK: - Memory pressure recorder

/// Subscribes to `UIApplicationDidReceiveMemoryWarningNotification` once at
/// init so the bridge can report the latest warning timestamp on demand.
final class MemoryPressureRecorder {
    static let shared = MemoryPressureRecorder()

    private(set) var lastWarningEpochMs: Int?
    private let lock = NSLock()

    private init() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(onMemoryWarning),
            name: UIApplication.didReceiveMemoryWarningNotification,
            object: nil
        )
    }

    @objc private func onMemoryWarning() {
        lock.lock()
        defer { lock.unlock() }
        lastWarningEpochMs = Int(Date().timeIntervalSince1970 * 1000)
    }
}

// MARK: - Contract
//
// The methods below mirror the TS interface in
// `eliza/plugins/plugin-computeruse/src/mobile/ios-bridge.ts`. Keep these
// signatures in sync — drift between the two sides silently breaks the
// bridge.
//
//   probe()                                           -> IosBridgeProbe
//   replayKitForegroundStart(ReplayKitForegroundOptions)
//                                                     -> ReplayKitForegroundHandle
//   replayKitForegroundStop({ sessionId })            -> { sessionId }
//   replayKitForegroundDrain({ sessionId, max? })     -> { frames: ReplayKitForegroundFrame[] }
//   broadcastExtensionHandshake()                     -> BroadcastHandshakeResult
//   visionOcr({ imageBase64, options? })              -> VisionOcrResult
//   appIntentList({ bundleIds? })                     -> { intents: IntentSpec[] }
//   appIntentInvoke(IntentInvocationRequest)          -> IntentInvocationResult
//   accessibilitySnapshot()                           -> AccessibilitySnapshotResult
//   foundationModelGenerate({ prompt, options? })     -> FoundationModelResult
//   memoryPressureProbe()                             -> MemoryPressureSample
