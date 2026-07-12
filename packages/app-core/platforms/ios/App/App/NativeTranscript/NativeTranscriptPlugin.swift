import Capacitor
import Foundation
import SwiftUI
import UIKit
import WebKit

/// NativeTranscript — Capacitor plugin that renders the chat transcript as a
/// native SwiftUI list mounted ABOVE the webview at a webview-anchored rect.
/// TS half: `packages/ui/src/glass/native-transcript-bridge.ts`; frame
/// contract: `packages/ui/src/chat/native-transcript/spec.ts` (v1).
///
/// Layering model (inverse of GlassBridge): glass/backdrop materials sit
/// BELOW the webview and show through its transparent regions, while this
/// transcript sits ABOVE the webview so its SwiftUI controls receive touches.
/// The list's own background is clear, so the stack still reads bottom-up as
/// backdrop → glass → (transparent webview pixels) → native transcript. Rects
/// arrive viewport-relative in CSS px (== UIKit points) and are offset into
/// container coordinates by the webview's frame origin, exactly like
/// GlassBridge's `containerFrame`.
///
/// `setTranscript` replaces the whole frame (the SwiftUI layer diffs by
/// message id); `show` mounts or moves the hosting controller; `hide` removes
/// it. Every widget action returns to JS as a plain string on the single
/// `transcriptAction` listener — byte-identical to the DOM widgets'
/// `sendActionMessage` payloads. There is no second action channel.
///
/// Floor: iOS 16 (`isAvailable` answers false below it and `show` no-ops, so
/// callers stay on the DOM renderer).
@objc(NativeTranscript)
public class NativeTranscriptPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeTranscriptPlugin"
    public let jsName = "NativeTranscript"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTranscript", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "show", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hide", returnType: CAPPluginReturnPromise),
    ]

    /// Latest frame, shared with the SwiftUI list. Main-thread only.
    private let store = TranscriptFrameStore()
    /// Mounted UIHostingController (typed loosely so the class itself needs
    /// no availability gate). Main-thread only; nil while hidden.
    private var hostController: UIViewController?

    override public func load() {
        // Builtin widget bodies come from the ios-widgets lane through the
        // WidgetRegistry seam; until that lands this is the no-op default and
        // every kind renders the placeholder card.
        DispatchQueue.main.async {
            if #available(iOS 16.0, *) {
                TranscriptWidgetRegistry.registerBuiltins()
            }
        }
    }

    @objc public func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 16.0, *) {
            call.resolve(["available": true])
        } else {
            call.resolve(["available": false])
        }
    }

    @objc public func setTranscript(_ call: CAPPluginCall) {
        guard let frameObject = call.getObject("frame") else {
            call.reject("setTranscript requires frame")
            return
        }
        // error-policy:J3 untrusted webview boundary — a frame that is not
        // valid v1 JSON rejects the call with the decode failure; nothing is
        // clamped into a fake-valid transcript.
        let frame: TranscriptFrame
        do {
            let data = try JSONSerialization.data(withJSONObject: frameObject)
            frame = try JSONDecoder().decode(TranscriptFrame.self, from: data)
        } catch {
            call.reject("setTranscript frame failed to decode: \(error)")
            return
        }
        guard frame.schema == TranscriptFrame.supportedSchema else {
            call.reject(
                "unsupported transcript schema \"\(frame.schema)\" — this build speaks \(TranscriptFrame.supportedSchema)"
            )
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.store.frame = frame
            call.resolve()
        }
    }

    @objc public func show(_ call: CAPPluginCall) {
        guard let rect = Self.parseRect(call.getObject("rect")) else {
            call.reject("show requires a finite, positive rect{x,y,width,height}")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("plugin deallocated")
                return
            }
            guard #available(iOS 16.0, *) else {
                // isAvailable already answered false on this OS; a stray show
                // stays a no-op so callers remain on the DOM renderer.
                call.resolve()
                return
            }
            guard let webView = self.webView, let container = webView.superview,
                let parent = self.bridge?.viewController
            else {
                call.reject("webview not ready")
                return
            }
            let frame = rect.offsetBy(dx: webView.frame.origin.x, dy: webView.frame.origin.y)
            if let host = self.hostController {
                // Mount-once, move-thereafter: same 0.15s glide GlassBridge
                // uses for rect resyncs so the two native layers track the
                // DOM in step.
                UIView.animate(withDuration: 0.15) {
                    host.view.frame = frame
                }
                call.resolve()
                return
            }
            let host = UIHostingController(
                rootView: TranscriptListView(
                    store: self.store,
                    sendAction: { [weak self] message in
                        // kind "message" — the DOM sendActionMessage strings.
                        self?.notifyListeners(
                            "transcriptAction",
                            data: ["kind": "message", "message": message])
                    },
                    sendEnvelope: { [weak self] envelope in
                        // Typed local intents (navigate/prefill/background) —
                        // the JS listener routes them like the DOM widgets do;
                        // they are never chat text (spec.ts contract).
                        var data: [String: Any] = [:]
                        for (key, value) in envelope { data[key] = value }
                        self?.notifyListeners("transcriptAction", data: data)
                    }
                )
                // The rect is the full layout truth from the web layer; safe
                // areas are already accounted for on that side.
                .ignoresSafeArea()
            )
            host.view.backgroundColor = .clear
            host.view.isOpaque = false
            host.view.frame = frame
            parent.addChild(host)
            container.insertSubview(host.view, aboveSubview: webView)
            host.didMove(toParent: parent)
            self.hostController = host
            call.resolve()
        }
    }

    @objc public func hide(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if let host = self?.hostController {
                host.willMove(toParent: nil)
                host.view.removeFromSuperview()
                host.removeFromParent()
                self?.hostController = nil
            }
            call.resolve()
        }
    }

    // MARK: - Helpers

    /// Untrusted-boundary rect bound (CSS px) — mirrors GlassBridge.
    private static let maxRectCoordCssPx: Double = 100_000

    // error-policy:J3 untrusted Capacitor boundary — a malformed rect
    // (missing/non-finite/non-positive/out-of-envelope values) produces nil →
    // the method rejects; nothing is clamped into a fake-valid rect. Kept in
    // lockstep with GlassBridge.parseRect.
    private static func parseRect(_ object: JSObject?) -> CGRect? {
        guard
            let object,
            let x = object["x"] as? Double ?? (object["x"] as? Int).map(Double.init),
            let y = object["y"] as? Double ?? (object["y"] as? Int).map(Double.init),
            let width = object["width"] as? Double ?? (object["width"] as? Int).map(Double.init),
            let height = object["height"] as? Double
                ?? (object["height"] as? Int).map(Double.init)
        else { return nil }
        guard x.isFinite, y.isFinite, width.isFinite, height.isFinite else { return nil }
        guard width > 0, height > 0 else { return nil }
        guard
            abs(x) <= Self.maxRectCoordCssPx, abs(y) <= Self.maxRectCoordCssPx,
            width <= Self.maxRectCoordCssPx, height <= Self.maxRectCoordCssPx
        else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }
}
