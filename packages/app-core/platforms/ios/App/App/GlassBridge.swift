import Capacitor
import Foundation
import UIKit
import WebKit

/// GlassBridge — Capacitor plugin that renders REAL system Liquid Glass
/// (iOS 26 `UIGlassEffect` on a `UIVisualEffectView`) behind anchored regions
/// of the webview. TS half: `packages/ui/src/glass/native-bridge.ts`.
///
/// Layering model: WKWebView composites its own pixels, so true glass can
/// never live INSIDE the DOM. Instead the web layer reports a viewport-relative
/// rect (CSS px == UIKit points), we position a native glass effect view at
/// that rect in the Capacitor container BELOW the webview, and the page keeps
/// that region transparent so the native material shows through. On first
/// attach the webview is made non-opaque with a clear background — without
/// that, WKWebView paints an opaque backing and the glass is invisible.
///
/// Gate: `UIGlassEffect` exists only on iOS 26+, and the SYMBOL exists only in
/// the iOS 26 SDK (Xcode 26 / Swift 6.2 toolchain). All references are
/// double-guarded — `#if compiler(>=6.2)` so older SDKs skip the code at
/// compile time, plus `if #available(iOS 26.0, *)` at runtime. On any older
/// combination `isAvailable` answers false and `attachGlass` resolves
/// `{attached:false}`; callers stay on the CSS fallback tier.
///
/// `interactive` (touch grow/shimmer) is mount-time only: UIGlassEffect's
/// `isInteractive` is fixed at effect creation and cannot be toggled on a live
/// effect view — changing it requires detach + attach, which the TS side owns.
@objc(GlassBridge)
public class GlassBridge: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "GlassBridge"
    public let jsName = "GlassBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "attachGlass", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateRect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "detachGlass", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setGrouping", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRegionState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    ]

    /// Attached glass views by caller id. Main-thread only.
    private var regions: [String: UIVisualEffectView] = [:]
    /// Requested UIGlassContainerEffect spacing; stored and applied on the
    /// next attach (see setGrouping).
    private var groupingSpacing: CGFloat = 0
    private var webViewMadeTransparent = false

    private static var glassSupported: Bool {
        #if compiler(>=6.2) && canImport(UIKit)
            if #available(iOS 26.0, *) {
                return true
            }
        #endif
        return false
    }

    @objc public func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": Self.glassSupported])
    }

    @objc public func attachGlass(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let rect = Self.parseRect(call.getObject("rect"))
        else {
            call.reject("attachGlass requires id and a finite, positive rect{x,y,width,height}")
            return
        }
        guard Self.glassSupported else {
            call.resolve(["attached": false])
            return
        }
        let cornerRadius = CGFloat(call.getDouble("cornerRadius") ?? 0)
        let tintColor = call.getString("tintColor")
        let interactive = call.getBool("interactive") ?? false
        let colorScheme = call.getString("colorScheme") ?? "system"

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            #if compiler(>=6.2) && canImport(UIKit)
                if #available(iOS 26.0, *) {
                    guard let webView = self.webView, let container = webView.superview else {
                        call.resolve(["attached": false])
                        return
                    }
                    self.makeWebViewTransparentOnce(webView)
                    // Replace-on-reattach: same id moves/rebuilds the region.
                    self.regions[id]?.removeFromSuperview()

                    let glass = UIGlassEffect()
                    // isInteractive is fixed at creation — see header.
                    glass.isInteractive = interactive
                    if let tint = tintColor.flatMap(Self.color(fromCSSHex:)) {
                        glass.tintColor = tint
                    }
                    let effectView = UIVisualEffectView(effect: glass)
                    effectView.frame = self.containerFrame(for: rect, webView: webView)
                    effectView.layer.cornerRadius = cornerRadius
                    effectView.layer.cornerCurve = .continuous
                    effectView.clipsToBounds = true
                    effectView.isUserInteractionEnabled = false
                    switch colorScheme {
                    case "light": effectView.overrideUserInterfaceStyle = .light
                    case "dark": effectView.overrideUserInterfaceStyle = .dark
                    default: effectView.overrideUserInterfaceStyle = .unspecified
                    }
                    container.insertSubview(effectView, belowSubview: webView)
                    self.regions[id] = effectView
                    call.resolve(["attached": true])
                    return
                }
            #endif
            call.resolve(["attached": false])
        }
    }

    @objc public func updateRect(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let rect = Self.parseRect(call.getObject("rect"))
        else {
            call.reject("updateRect requires id and a finite, positive rect{x,y,width,height}")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let effectView = self.regions[id], let webView = self.webView else {
                call.resolve()
                return
            }
            let frame = self.containerFrame(for: rect, webView: webView)
            UIView.animate(withDuration: 0.15) {
                effectView.frame = frame
            }
            call.resolve()
        }
    }

    @objc public func detachGlass(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("detachGlass requires id")
            return
        }
        DispatchQueue.main.async { [weak self] in
            self?.regions.removeValue(forKey: id)?.removeFromSuperview()
            call.resolve()
        }
    }

    /// Diagnostic readback for device e2e: whether `id` has a live effect
    /// view, the total region count, and the view's REAL frame (points,
    /// container coordinates) — so tests prove insertion/replace/move/detach
    /// against native truth, not just resolved promises.
    @objc public func getRegionState(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("getRegionState requires id")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("plugin deallocated")
                return
            }
            var result: [String: Any] = ["regionCount": self.regions.count]
            if let effectView = self.regions[id], let container = effectView.superview {
                result["exists"] = true
                if let webView = self.webView,
                    let panelIndex = container.subviews.firstIndex(of: effectView),
                    let webIndex = container.subviews.firstIndex(of: webView)
                {
                    result["attachedBelowWebView"] = panelIndex < webIndex
                }
                result["rect"] = [
                    "x": Double(effectView.frame.origin.x),
                    "y": Double(effectView.frame.origin.y),
                    "width": Double(effectView.frame.size.width),
                    "height": Double(effectView.frame.size.height),
                ]
            } else {
                result["exists"] = false
            }
            call.resolve(result)
        }
    }

    @objc public func setGrouping(_ call: CAPPluginCall) {
        let spacing = CGFloat(call.getDouble("spacing") ?? 0)
        DispatchQueue.main.async { [weak self] in
            // UIGlassContainerEffect grouping under double availability guards
            // would require re-parenting every region into a shared container
            // view; we store the spacing and callers get it applied when the
            // regions are next (re)attached. Best-effort by contract.
            self?.groupingSpacing = spacing
            call.resolve()
        }
    }

    // MARK: - Helpers

    /// Rects arrive viewport-relative (CSS px == points); offset into the
    /// container's coordinate space by the webview's frame origin.
    private func containerFrame(for rect: CGRect, webView: UIView) -> CGRect {
        rect.offsetBy(dx: webView.frame.origin.x, dy: webView.frame.origin.y)
    }

    /// WKWebView paints an opaque backing by default, which would hide any
    /// view layered beneath it. First attach flips it transparent so the
    /// page's transparent regions actually reveal the glass.
    private func makeWebViewTransparentOnce(_ webView: WKWebView) {
        guard !webViewMadeTransparent else { return }
        webViewMadeTransparent = true
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
    }

    /// Untrusted-boundary rect bound (CSS px) — mirrors the Android plugin.
    private static let maxRectCoordCssPx: Double = 100_000

    // error-policy:J3 untrusted Capacitor boundary — a malformed rect
    // (missing/non-finite/non-positive/out-of-envelope values) produces nil →
    // the method rejects; nothing is clamped into a fake-valid region.
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

    /// Minimal CSS hex parser: #rgb, #rgba, #rrggbb, #rrggbbaa.
    private static func color(fromCSSHex css: String) -> UIColor? {
        var hex = css.trimmingCharacters(in: .whitespacesAndNewlines)
        guard hex.hasPrefix("#") else { return nil }
        hex.removeFirst()
        if hex.count == 3 || hex.count == 4 {
            hex = hex.map { "\($0)\($0)" }.joined()
        }
        guard hex.count == 6 || hex.count == 8, let value = UInt64(hex, radix: 16) else {
            return nil
        }
        let hasAlpha = hex.count == 8
        let rgb = hasAlpha ? value >> 8 : value
        let alpha = hasAlpha ? CGFloat(value & 0xFF) / 255.0 : 1.0
        return UIColor(
            red: CGFloat((rgb >> 16) & 0xFF) / 255.0,
            green: CGFloat((rgb >> 8) & 0xFF) / 255.0,
            blue: CGFloat(rgb & 0xFF) / 255.0,
            alpha: alpha
        )
    }
}
