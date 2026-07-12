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
/// `setBackdrop` extends the same model with an ambient full-container view at
/// index 0 — below the webview AND every glass region — rendered as a warm
/// radial ember gradient (slow luminance breathing when asked and motion is
/// allowed) or a flat color; `clearBackdrop` removes it and restores the
/// opaque webview once no glass region still needs transparency.
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
        CAPPluginMethod(name: "setBackdrop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearBackdrop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    ]

    /// Attached glass views by caller id. Main-thread only.
    private var regions: [String: UIVisualEffectView] = [:]
    /// Requested UIGlassContainerEffect spacing; stored and applied on the
    /// next attach (see setGrouping).
    private var groupingSpacing: CGFloat = 0
    private var webViewMadeTransparent = false
    /// Ambient backdrop at container index 0 (below the webview and every
    /// glass region). Main-thread only; nil when no backdrop is active.
    private var backdropView: UIView?

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
            // Optional live radius: the chat sheet's corners ANIMATE during the
            // maximize morph, so a radius frozen at attach time visibly drifts
            // from the DOM corners. Callers resync it with each rect.
            let cornerRadius = call.getDouble("cornerRadius")
            UIView.animate(withDuration: 0.15) {
                effectView.frame = frame
                if let cornerRadius {
                    effectView.layer.cornerRadius = CGFloat(cornerRadius)
                }
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

    @objc public func setBackdrop(_ call: CAPPluginCall) {
        // Same support floor as glass: below iOS 26 resolve inactive without
        // touching the webview so callers stay on the CSS tier. The backdrop
        // itself uses no iOS-26-only symbols, so no compiler guard is needed.
        guard Self.glassSupported else {
            call.resolve(["active": false])
            return
        }
        let kind = call.getString("kind") ?? "ember"
        let rawColors = (call.getArray("colors") ?? []).compactMap { $0 as? String }
        let colors = Self.parseBackdropColors(rawColors)
        let animated = call.getBool("animated") ?? false

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let webView = self.webView, let container = webView.superview else {
                call.resolve(["active": false])
                return
            }
            // Replace-in-place: a second setBackdrop swaps the whole config.
            self.backdropView?.removeFromSuperview()
            self.backdropView = nil

            let backdrop: UIView
            if kind == "color" {
                backdrop = UIView(frame: container.bounds)
                backdrop.backgroundColor = colors.first
            } else {
                backdrop = Self.makeEmberBackdrop(
                    colors: colors, bounds: container.bounds, animated: animated)
            }
            backdrop.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            backdrop.isUserInteractionEnabled = false
            // Index 0 keeps the backdrop below the webview AND below every
            // glass region view — attachGlass inserts regions belowSubview:
            // webView, which lands them above anything already at the bottom.
            container.insertSubview(backdrop, at: 0)
            self.backdropView = backdrop
            self.makeWebViewTransparentOnce(webView)
            call.resolve(["active": true])
        }
    }

    @objc public func clearBackdrop(_ call: CAPPluginCall) {
        guard Self.glassSupported else {
            call.resolve()
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve()
                return
            }
            self.backdropView?.removeFromSuperview()
            self.backdropView = nil
            // Glass regions also require the transparent webview; restore the
            // opaque backing only when nothing else depends on it.
            if self.regions.isEmpty, self.webViewMadeTransparent, let webView = self.webView {
                webView.isOpaque = true
                webView.backgroundColor = nil
                webView.scrollView.backgroundColor = nil
                self.webViewMadeTransparent = false
            }
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

    // MARK: - Backdrop

    /// Default warm ember palette, darkest first — mirrors the TS contract's
    /// documented default (#1a0c06, #7a2d0c, #ef5a1f).
    private static let defaultEmberColors: [UIColor] = [
        UIColor(red: 0x1A / 255.0, green: 0x0C / 255.0, blue: 0x06 / 255.0, alpha: 1),
        UIColor(red: 0x7A / 255.0, green: 0x2D / 255.0, blue: 0x0C / 255.0, alpha: 1),
        UIColor(red: 0xEF / 255.0, green: 0x5A / 255.0, blue: 0x1F / 255.0, alpha: 1),
    ]

    // error-policy:J3 untrusted Capacitor boundary — invalid hex entries are
    // dropped rather than crashing, and an all-invalid/missing list falls back
    // to the default ember palette (the contract's documented default, not a
    // fabricated success: the TS side asked for a backdrop and gets one).
    private static func parseBackdropColors(_ raw: [String]) -> [UIColor] {
        let parsed = raw.compactMap { entry -> UIColor? in
            let trimmed = entry.trimmingCharacters(in: .whitespacesAndNewlines)
            return color(fromCSSHex: trimmed.hasPrefix("#") ? trimmed : "#" + trimmed)
        }
        return parsed.isEmpty ? defaultEmberColors : parsed
    }

    /// Backing view whose root layer IS the gradient, so autoresizing keeps
    /// the field sized with the container without a layout observer.
    private final class EmberBackdropView: UIView {
        override static var layerClass: AnyClass { CAGradientLayer.self }

        /// CoreAnimation strips layer animations on backgrounding regardless of
        /// isRemovedOnCompletion, so an animated backdrop would stop breathing
        /// after one background/foreground cycle. Re-install on foreground (and
        /// on window attach), re-checking reduce-motion at re-add time.
        var breathes = false
        private var foregroundObserver: NSObjectProtocol?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if window != nil {
                installBreatheIfNeeded()
                if foregroundObserver == nil {
                    foregroundObserver = NotificationCenter.default.addObserver(
                        forName: UIApplication.didBecomeActiveNotification,
                        object: nil,
                        queue: .main
                    ) { [weak self] _ in self?.installBreatheIfNeeded() }
                }
            } else if let observer = foregroundObserver {
                NotificationCenter.default.removeObserver(observer)
                foregroundObserver = nil
            }
        }

        func installBreatheIfNeeded() {
            guard breathes, !UIAccessibility.isReduceMotionEnabled,
                layer.animation(forKey: "emberBreathe") == nil
            else { return }
            let breathe = CABasicAnimation(keyPath: "opacity")
            breathe.fromValue = 1.0
            breathe.toValue = 0.8
            breathe.duration = 9
            breathe.autoreverses = true
            breathe.repeatCount = .infinity
            breathe.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            layer.add(breathe, forKey: "emberBreathe")
        }

        deinit {
            if let observer = foregroundObserver {
                NotificationCenter.default.removeObserver(observer)
            }
        }
    }

    /// Warm radial ember field: brightest color at a low-center focus fading
    /// to the darkest at the edges. Colors arrive darkest-first (TS contract);
    /// the radial layer wants brightest at the focus, so the order reverses.
    private static func makeEmberBackdrop(colors: [UIColor], bounds: CGRect, animated: Bool)
        -> UIView
    {
        let view = EmberBackdropView(frame: bounds)
        // The darkest tone backs the layer so the opacity "breathing" reads as
        // a luminance dip into the ember base, not into whatever sits behind.
        view.backgroundColor = colors.first
        guard let gradient = view.layer as? CAGradientLayer else { return view }
        var stops = Array(colors.reversed())
        if stops.count == 1 {
            // CAGradientLayer needs two stops; a single color is a flat field.
            stops.append(stops[0])
        }
        gradient.type = .radial
        gradient.colors = stops.map(\.cgColor)
        gradient.locations = (0..<stops.count).map {
            NSNumber(value: Double($0) / Double(stops.count - 1))
        }
        // Focus at bottom-center; radii large enough to sweep the whole
        // container so the darkest stop lands past the top corners.
        gradient.startPoint = CGPoint(x: 0.5, y: 1.0)
        gradient.endPoint = CGPoint(x: 1.6, y: -0.4)
        view.breathes = animated
        view.installBreatheIfNeeded()
        return view
    }
}
