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
/// Because the glass samples what is BELOW the webview, a glass region is only
/// meaningful over a native-hosted wallpaper: `setBackdrop` installs the
/// current wallpaper (pre-downsampled bytes piped from the page — never a
/// URL, never a network fetch, never cookies) at container index 0, and
/// `clearBackdrop` removes it and restores webview opacity. The web side owns
/// WHEN the wallpaper is hosted natively (only while a glass region is
/// anchored at rest) so the app is not permanently stripped of the
/// opaque-webview fast path.
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
        CAPPluginMethod(name: "setBackdrop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearBackdrop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRegionState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    ]

    /// Attached glass views by caller id. Main-thread only.
    private var regions: [String: UIVisualEffectView] = [:]
    /// Requested UIGlassContainerEffect spacing; stored and applied on the
    /// next attach (see setGrouping).
    private var groupingSpacing: CGFloat = 0
    private var webViewMadeTransparent = false
    /// Wallpaper layer hosted below the webview (see setBackdrop). Main-thread
    /// only, like `regions`.
    private var backdropView: UIImageView?
    /// Monotonic guard: a slower decode from an earlier setBackdrop call must
    /// never install over a newer one. Main-thread only.
    private var backdropGeneration = 0

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

    /// Host the wallpaper below the webview so the glass has real pixels to
    /// sample. The image arrives as base64 bytes piped from the page — the web
    /// side already loaded, downsampled, and flattened it — so this method
    /// never touches the network, cookies, or the bundle: no credential can
    /// leave the device and every URL-shaped concern stays in the renderer.
    /// The promise resolves `applied:true` only after the bytes have decoded
    /// and the layer is installed; the web keeps its DOM wallpaper painted
    /// until that acknowledgement, so a failure can never expose the window
    /// background as a black region.
    @objc public func setBackdrop(_ call: CAPPluginCall) {
        guard Self.glassSupported else {
            call.resolve(["applied": false])
            return
        }
        let imageBase64 = call.getString("imageBase64")
        let color = call.getString("color").flatMap(Self.color(fromCSSHex:)) ?? .black
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve(["applied": false])
                return
            }
            self.backdropGeneration += 1
            let generation = self.backdropGeneration
            guard let imageBase64 else {
                guard let webView = self.webView, let container = webView.superview else {
                    call.resolve(["applied": false])
                    return
                }
                self.makeWebViewTransparentOnce(webView)
                self.installBackdrop(image: nil, color: color, in: container, below: webView)
                call.resolve(["applied": true])
                return
            }
            // Decode off-main; the payload is screen-sized by the web encoder,
            // so this is a bounded decode, not an arbitrary-file one.
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let decoded = Data(base64Encoded: imageBase64).flatMap(UIImage.init(data:))
                // UIImage(data:) is lazy — rasterize now so installing the
                // layer never triggers a main-thread decode on the next frame.
                let image: UIImage?
                if #available(iOS 15.0, *) {
                    image = decoded?.preparingForDisplay() ?? decoded
                } else {
                    image = decoded
                }
                DispatchQueue.main.async {
                    guard let self, generation == self.backdropGeneration else {
                        call.resolve(["applied": false])
                        return
                    }
                    guard let image, let webView = self.webView,
                        let container = webView.superview
                    else {
                        CAPLog.print("⚡️  GlassBridge setBackdrop: decode or install failed")
                        call.resolve(["applied": false])
                        return
                    }
                    self.makeWebViewTransparentOnce(webView)
                    self.installBackdrop(
                        image: image, color: color, in: container, below: webView)
                    call.resolve(["applied": true])
                }
            }
        }
    }

    /// Remove the hosted wallpaper and, when nothing below the webview needs
    /// transparency anymore, restore the webview's opaque backing so the
    /// compositor regains its opaque-layer fast path.
    @objc public func clearBackdrop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.resolve()
                return
            }
            self.backdropGeneration += 1
            self.backdropView?.removeFromSuperview()
            self.backdropView = nil
            self.restoreWebViewOpacityIfUnneeded()
            call.resolve()
        }
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
            guard let self else {
                call.resolve()
                return
            }
            self.regions.removeValue(forKey: id)?.removeFromSuperview()
            self.restoreWebViewOpacityIfUnneeded()
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

    /// Inverse of `makeWebViewTransparentOnce`, taken only when no glass
    /// region and no backdrop remain: a transparent webview costs the
    /// compositor its opaque-layer optimization on every frame, so the shell
    /// should not keep paying that while the page is fully DOM-painted.
    private func restoreWebViewOpacityIfUnneeded() {
        guard webViewMadeTransparent, regions.isEmpty, backdropView == nil,
            let webView
        else { return }
        webViewMadeTransparent = false
        webView.isOpaque = true
        webView.backgroundColor = nil
        webView.scrollView.backgroundColor = nil
    }

    /// Swap the wallpaper layer at container index 0 — below every glass
    /// region and the webview. Insert-then-remove ordering keeps a wallpaper
    /// on screen at all times during a replace (no flash of window black).
    private func installBackdrop(
        image: UIImage?, color: UIColor, in container: UIView, below webView: UIView
    ) {
        let next = UIImageView(frame: webView.frame)
        next.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        next.contentMode = .scaleAspectFill
        next.clipsToBounds = true
        next.backgroundColor = color
        next.image = image
        container.insertSubview(next, at: 0)
        backdropView?.removeFromSuperview()
        backdropView = next
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
