import Capacitor
import Foundation
import UIKit
import WebKit

/// NativeComposer — Capacitor plugin that renders the chat INPUT as a real
/// native `UITextView` mounted ABOVE the webview at a webview-anchored rect, used
/// only in the maximized chat (the one at-rest, full-bleed state; the gate lives
/// in ChatOverlay). TS half: `packages/ui/src/glass/native-composer-bridge.ts`;
/// shared lifecycle: `packages/ui/src/glass/native-surface.ts`.
///
/// Layering mirrors NativeTranscript: the field sits ABOVE the webview so it
/// takes touches/first-responder; the DOM textarea underneath is hidden but keeps
/// layout. Rects arrive viewport-relative in CSS px (== UIKit points) and are
/// offset into container coordinates by the webview's frame origin, exactly like
/// GlassBridge's `containerFrame`.
///
/// Native owns the text buffer, first responder, and IME; it forwards only
/// high-level INTENTS on the single `composerEvent` listener
/// (change/submit/focus/blur) — the composer's send/slash/paste BRAINS stay in
/// JS. `setProps({draft})` is the JS→native mirror for prefill/dictation/clear;
/// an echo of our own change is skipped by the `lastPushedText` guard so the
/// cursor never jumps (standard controlled-input echo guard).
@objc(NativeComposer)
public class NativeComposerPlugin: CAPPlugin, CAPBridgedPlugin, UITextViewDelegate {
    public let identifier = "NativeComposerPlugin"
    public let jsName = "NativeComposer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateRect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setProps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "detach", returnType: CAPPluginReturnPromise),
    ]

    private var regionId: String?
    private var textView: UITextView?
    private var placeholderLabel: UILabel?
    /// Last text WE pushed to (or read from) the field. `setProps` skips a draft
    /// equal to this so the JS mirror of our own change never resets the cursor.
    private var lastPushedText: String = ""

    @objc public func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": true])
    }

    @objc public func attach(_ call: CAPPluginCall) {
        guard let id = call.getString("id"),
            let rect = Self.parseRect(call.getObject("rect"))
        else {
            call.reject("attach requires id + a finite, positive rect")
            return
        }
        let draft = call.getString("draft") ?? ""
        let placeholder = call.getString("placeholder") ?? ""
        let disabled = call.getBool("disabled") ?? false
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("plugin deallocated")
                return
            }
            guard let webView = self.webView, let container = webView.superview
            else {
                call.resolve(["attached": false])
                return
            }
            // Replace any stray prior mount (same id reattaching).
            self.teardown()

            let frame = rect.offsetBy(
                dx: webView.frame.origin.x, dy: webView.frame.origin.y)

            let field = UITextView()
            field.frame = frame
            field.backgroundColor = .clear
            field.isOpaque = false
            field.text = draft
            field.font = .systemFont(ofSize: 16)
            field.textColor = .white
            field.tintColor = .white
            field.isEditable = !disabled
            field.isScrollEnabled = true
            field.keyboardAppearance = .dark
            field.returnKeyType = .send
            field.enablesReturnKeyAutomatically = false
            field.autocorrectionType = .default
            field.textContainerInset = UIEdgeInsets(
                top: 6, left: 2, bottom: 6, right: 2)
            field.delegate = self

            let label = UILabel()
            label.text = placeholder
            label.font = .systemFont(ofSize: 16)
            label.textColor = UIColor(white: 1, alpha: 0.5)
            label.frame = Self.placeholderFrame(for: frame)
            label.isHidden = !draft.isEmpty

            container.insertSubview(field, aboveSubview: webView)
            container.insertSubview(label, aboveSubview: field)

            self.regionId = id
            self.textView = field
            self.placeholderLabel = label
            self.lastPushedText = draft
            call.resolve(["attached": true])
        }
    }

    @objc public func updateRect(_ call: CAPPluginCall) {
        guard let rect = Self.parseRect(call.getObject("rect")) else {
            call.resolve()
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, let field = self.textView, let webView = self.webView
            else {
                call.resolve()
                return
            }
            let frame = rect.offsetBy(
                dx: webView.frame.origin.x, dy: webView.frame.origin.y)
            UIView.animate(withDuration: 0.15) {
                field.frame = frame
                self.placeholderLabel?.frame = Self.placeholderFrame(for: frame)
            }
            call.resolve()
        }
    }

    @objc public func setProps(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let field = self.textView else {
                call.resolve()
                return
            }
            if let draft = call.getString("draft"),
                draft != self.lastPushedText, draft != field.text
            {
                field.text = draft
                self.lastPushedText = draft
                self.placeholderLabel?.isHidden = !draft.isEmpty
            }
            if let placeholder = call.getString("placeholder") {
                self.placeholderLabel?.text = placeholder
            }
            if let disabled = call.getBool("disabled") {
                field.isEditable = !disabled
            }
            call.resolve()
        }
    }

    @objc public func detach(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.teardown()
            call.resolve()
        }
    }

    // MARK: - UITextViewDelegate

    public func textViewDidChange(_ textView: UITextView) {
        let text = textView.text ?? ""
        lastPushedText = text
        placeholderLabel?.isHidden = !text.isEmpty
        emit("change", value: text)
    }

    public func textViewDidBeginEditing(_ textView: UITextView) {
        emit("focus", value: nil)
    }

    public func textViewDidEndEditing(_ textView: UITextView) {
        emit("blur", value: nil)
    }

    public func textView(
        _ textView: UITextView, shouldChangeTextIn range: NSRange,
        replacementText text: String
    ) -> Bool {
        // Return sends (chat idiom); it does not insert a newline. Multi-line is
        // Stage-2 (needs a soft-keyboard modifier the return key can't express).
        if text == "\n" {
            emit("submit", value: nil)
            return false
        }
        return true
    }

    // MARK: - Helpers

    private func teardown() {
        textView?.resignFirstResponder()
        textView?.removeFromSuperview()
        placeholderLabel?.removeFromSuperview()
        textView = nil
        placeholderLabel = nil
        regionId = nil
    }

    private func emit(_ kind: String, value: String?) {
        guard let id = regionId else { return }
        var data: [String: Any] = ["id": id, "kind": kind]
        if let value { data["value"] = value }
        notifyListeners("composerEvent", data: data)
    }

    private static func placeholderFrame(for frame: CGRect) -> CGRect {
        CGRect(
            x: frame.minX + 6, y: frame.minY + 8,
            width: max(0, frame.width - 12), height: 20)
    }

    /// Untrusted-boundary rect bound (CSS px) — mirrors GlassBridge/NativeTranscript.
    private static let maxRectCoordCssPx: Double = 100_000

    // error-policy:J3 untrusted Capacitor boundary — a malformed rect produces
    // nil → resolve as a no-op; nothing is clamped into a fake-valid rect.
    private static func parseRect(_ object: JSObject?) -> CGRect? {
        guard
            let object,
            let x = object["x"] as? Double
                ?? (object["x"] as? Int).map(Double.init),
            let y = object["y"] as? Double
                ?? (object["y"] as? Int).map(Double.init),
            let width = object["width"] as? Double
                ?? (object["width"] as? Int).map(Double.init),
            let height = object["height"] as? Double
                ?? (object["height"] as? Int).map(Double.init)
        else { return nil }
        guard x.isFinite, y.isFinite, width.isFinite, height.isFinite else {
            return nil
        }
        guard width > 0, height > 0 else { return nil }
        guard
            abs(x) <= Self.maxRectCoordCssPx, abs(y) <= Self.maxRectCoordCssPx,
            width <= Self.maxRectCoordCssPx, height <= Self.maxRectCoordCssPx
        else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }
}
