/**
 * Native iOS half of `ElizaSurfaceManager` (#15245): layers one `WKWebView` per
 * Browser tab above the Capacitor host webview, each in its OWN renderer process
 * and storage partition. A computed outer clip follows the rounded React host
 * while independent rounded occlusion holes expose host-rendered chrome without
 * resizing or hiding the live page.
 *
 * An `isolated` process gets a fresh `WKProcessPool`; isolated storage gets a
 * non-persistent `WKWebsiteDataStore`. `shared` reuses a plugin-owned pool and
 * the default store, never an implicit policy.
 */
import Foundation
import Capacitor
import WebKit
import UIKit

@objc(ElizaSurfaceManagerPlugin)
public class ElizaSurfaceManagerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaSurfaceManagerPlugin"
    public let jsName = "ElizaSurfaceManager"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "createSurface", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBounds", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setOcclusionRects", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "navigate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "foregroundSurface", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backgroundSurface", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "destroySurface", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "foregroundHost", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSurfaceState", returnType: CAPPluginReturnPromise),
    ]

    private struct Surface {
        let container: OccludingSurfaceView
        let webView: WKWebView
        let process: String
        let storage: String
    }

    private var surfaces: [String: Surface] = [:]
    // One plugin-owned pool for every `shared`-process surface — deliberate, so a
    // shared surface still never lands in the host's implicit default pool.
    private let sharedProcessPool = WKProcessPool()

    @objc func createSurface(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("createSurface requires an id")
            return
        }
        // Explicit-policy invariant: both axes must be stated. No default.
        guard let process = call.getString("process"),
              process == "isolated" || process == "shared" else {
            call.reject("createSurface requires an explicit process policy (isolated|shared)")
            return
        }
        guard let storage = call.getString("storage"),
              storage == "isolated" || storage == "shared" else {
            call.reject("createSurface requires an explicit storage policy (isolated|shared)")
            return
        }
        let urlString = call.getString("url")

        DispatchQueue.main.async {
            guard let hostView = self.bridge?.viewController?.view else {
                call.reject("no host view controller to attach the surface to")
                return
            }
            if self.surfaces[id] != nil {
                call.resolve()
                return
            }

            let config = WKWebViewConfiguration()
            // Fresh pool ⇒ distinct content process; shared ⇒ the plugin pool.
            config.processPool = process == "isolated" ? WKProcessPool() : self.sharedProcessPool
            // Non-persistent store ⇒ private, per-surface cookies/localStorage.
            config.websiteDataStore = storage == "isolated"
                ? WKWebsiteDataStore.nonPersistent()
                : WKWebsiteDataStore.default()

            let container = OccludingSurfaceView(frame: .zero)
            container.isHidden = true
            let webView = WKWebView(frame: container.bounds, configuration: config)
            webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            container.installContentView(webView)
            hostView.addSubview(container)

            if let urlString = urlString, let url = URL(string: urlString) {
                webView.load(URLRequest(url: url))
            }
            self.surfaces[id] = Surface(
                container: container,
                webView: webView,
                process: process,
                storage: storage
            )
            call.resolve()
        }
    }

    @objc func setBounds(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("setBounds requires an id")
            return
        }
        guard let x = call.getDouble("x"), let y = call.getDouble("y"),
              let width = call.getDouble("width"), let height = call.getDouble("height"),
              let rawOuterClip = call.getObject("outerClip"),
              let rawCornerRadii = rawOuterClip["cornerRadii"] as? [String: Any],
              let clipX = (rawOuterClip["x"] as? NSNumber)?.doubleValue,
              let clipY = (rawOuterClip["y"] as? NSNumber)?.doubleValue,
              let clipWidth = (rawOuterClip["width"] as? NSNumber)?.doubleValue,
              let clipHeight = (rawOuterClip["height"] as? NSNumber)?.doubleValue,
              let topLeft = (rawCornerRadii["topLeft"] as? NSNumber)?.doubleValue,
              let topRight = (rawCornerRadii["topRight"] as? NSNumber)?.doubleValue,
              let bottomRight = (rawCornerRadii["bottomRight"] as? NSNumber)?.doubleValue,
              let bottomLeft = (rawCornerRadii["bottomLeft"] as? NSNumber)?.doubleValue else {
            call.reject("setBounds requires page bounds and an outerClip with cornerRadii")
            return
        }
        let outerClip = HostOuterClip(
            x: clipX,
            y: clipY,
            width: clipWidth,
            height: clipHeight,
            topLeftRadius: topLeft,
            topRightRadius: topRight,
            bottomRightRadius: bottomRight,
            bottomLeftRadius: bottomLeft
        )
        guard x.isFinite, y.isFinite, width.isFinite, height.isFinite,
              width >= 0, height >= 0, outerClip.hasValidGeometry else {
            call.reject("setBounds has invalid page or outer clip geometry")
            return
        }
        DispatchQueue.main.async {
            guard let surface = self.surfaces[id] else {
                call.reject("no surface \(id)")
                return
            }
            // CSS px map 1:1 to UIKit points, so no density conversion is needed.
            let frame = CGRect(x: x, y: y, width: width, height: height)
            if surface.container.frame != frame {
                surface.container.frame = frame
            }
            surface.container.setSurfaceGeometry(
                origin: CGPoint(x: x, y: y),
                outerClip: outerClip
            )
            call.resolve()
        }
    }

    @objc func setOcclusionRects(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("setOcclusionRects requires an id")
            return
        }
        guard let rawRects = call.getArray("rects") as? [[String: Any]] else {
            call.reject("setOcclusionRects requires a rects array")
            return
        }
        var rects: [HostOcclusionRect] = []
        rects.reserveCapacity(rawRects.count)
        for (index, raw) in rawRects.enumerated() {
            guard let x = (raw["x"] as? NSNumber)?.doubleValue,
                  let y = (raw["y"] as? NSNumber)?.doubleValue,
                  let width = (raw["width"] as? NSNumber)?.doubleValue,
                  let height = (raw["height"] as? NSNumber)?.doubleValue else {
                call.reject("setOcclusionRects rect \(index) has invalid geometry")
                return
            }
            let cornerRadius = (raw["cornerRadius"] as? NSNumber)?.doubleValue ?? 0
            guard x.isFinite, y.isFinite, width.isFinite, height.isFinite,
                  cornerRadius.isFinite, width >= 0, height >= 0, cornerRadius >= 0 else {
                call.reject("setOcclusionRects rect \(index) has invalid geometry")
                return
            }
            rects.append(
                HostOcclusionRect(
                    x: x,
                    y: y,
                    width: width,
                    height: height,
                    cornerRadius: cornerRadius
                )
            )
        }
        DispatchQueue.main.async {
            guard let surface = self.surfaces[id] else {
                call.reject("no surface \(id)")
                return
            }
            surface.container.setHostOcclusions(rects)
            call.resolve()
        }
    }

    @objc func navigate(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let urlString = call.getString("url"),
              let url = URL(string: urlString) else {
            call.reject("navigate requires an id and a valid url")
            return
        }
        DispatchQueue.main.async {
            guard let surface = self.surfaces[id] else {
                call.reject("no surface \(id)")
                return
            }
            surface.webView.load(URLRequest(url: url))
            call.resolve()
        }
    }

    @objc func foregroundSurface(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("foregroundSurface requires an id")
            return
        }
        DispatchQueue.main.async {
            guard let surface = self.surfaces[id] else {
                call.reject("no surface \(id)")
                return
            }
            surface.container.superview?.bringSubviewToFront(surface.container)
            surface.container.isHidden = false
            call.resolve()
        }
    }

    @objc func backgroundSurface(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("backgroundSurface requires an id")
            return
        }
        DispatchQueue.main.async {
            guard let surface = self.surfaces[id] else {
                call.reject("no surface \(id)")
                return
            }
            surface.container.isHidden = true
            call.resolve()
        }
    }

    @objc func destroySurface(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("destroySurface requires an id")
            return
        }
        DispatchQueue.main.async {
            if let surface = self.surfaces.removeValue(forKey: id) {
                surface.webView.stopLoading()
                surface.container.removeFromSuperview()
            }
            call.resolve()
        }
    }

    @objc func foregroundHost(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            for surface in self.surfaces.values {
                surface.container.isHidden = true
            }
            call.resolve()
        }
    }

    @objc func getSurfaceState(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("getSurfaceState requires an id")
            return
        }
        DispatchQueue.main.async {
            guard let surface = self.surfaces[id] else {
                call.resolve([
                    "exists": false,
                    "foregrounded": false,
                    "currentUrl": NSNull(),
                    "process": NSNull(),
                    "storage": NSNull(),
                ])
                return
            }
            call.resolve([
                "exists": true,
                "foregrounded": !surface.container.isHidden,
                "currentUrl": surface.webView.url?.absoluteString ?? NSNull(),
                "process": surface.process,
                "storage": surface.storage,
            ])
        }
    }
}

private struct HostOuterClip: Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let topLeftRadius: Double
    let topRightRadius: Double
    let bottomRightRadius: Double
    let bottomLeftRadius: Double

    var hasValidGeometry: Bool {
        x.isFinite && y.isFinite && width.isFinite && height.isFinite &&
            topLeftRadius.isFinite && topRightRadius.isFinite &&
            bottomRightRadius.isFinite && bottomLeftRadius.isFinite &&
            width >= 0 && height >= 0 && topLeftRadius >= 0 &&
            topRightRadius >= 0 && bottomRightRadius >= 0 && bottomLeftRadius >= 0
    }
}

private struct HostOcclusionRect {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let cornerRadius: Double
}

/// Clips native page pixels to the rounded React host, then subtracts overlay
/// holes so UIKit can continue hit-testing the Capacitor host in either region.
private final class OccludingSurfaceView: UIView {
    private var hostOcclusions: [HostOcclusionRect] = []
    private var hostOuterClip: HostOuterClip?
    private var surfaceOrigin: CGPoint = .zero
    private var maskContainers: [OcclusionMaskContainerView] = []
    private var contentView: UIView?
    private let outerClipMask = CAShapeLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        outerClipMask.fillColor = UIColor.white.cgColor
        outerClipMask.frame = bounds
        outerClipMask.path = UIBezierPath(rect: bounds).cgPath
        layer.mask = outerClipMask
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func installContentView(_ view: UIView) {
        guard contentView !== view else { return }
        contentView?.removeFromSuperview()
        contentView = view
        rebuildMaskHierarchy()
    }

    func setSurfaceGeometry(origin: CGPoint, outerClip: HostOuterClip) {
        if surfaceOrigin == origin, hostOuterClip == outerClip { return }
        surfaceOrigin = origin
        hostOuterClip = outerClip
        layoutMaskHierarchy()
    }

    func setHostOcclusions(_ rects: [HostOcclusionRect]) {
        hostOcclusions = rects
        rebuildMaskHierarchy()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        layoutMaskHierarchy()
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard super.point(inside: point, with: event) else { return false }
        guard localOuterClipPath()?.contains(point) != false else { return false }
        return !localOcclusionPaths().contains { $0.contains(point) }
    }

    private func localOuterClipPath() -> UIBezierPath? {
        guard let clip = hostOuterClip else { return nil }
        return roundedOuterClipPath(
            rect: CGRect(
                x: CGFloat(clip.x) - surfaceOrigin.x,
                y: CGFloat(clip.y) - surfaceOrigin.y,
                width: CGFloat(clip.width),
                height: CGFloat(clip.height)
            ),
            radii: (
                topLeft: CGFloat(clip.topLeftRadius),
                topRight: CGFloat(clip.topRightRadius),
                bottomRight: CGFloat(clip.bottomRightRadius),
                bottomLeft: CGFloat(clip.bottomLeftRadius)
            )
        )
    }

    private func localOcclusionPaths() -> [UIBezierPath] {
        hostOcclusions.map { occlusion in
            UIBezierPath(
                roundedRect: CGRect(
                    x: CGFloat(occlusion.x) - surfaceOrigin.x,
                    y: CGFloat(occlusion.y) - surfaceOrigin.y,
                    width: CGFloat(occlusion.width),
                    height: CGFloat(occlusion.height)
                ),
                cornerRadius: CGFloat(occlusion.cornerRadius)
            )
        }
    }

    private func rebuildMaskHierarchy() {
        let paths = localOcclusionPaths()
        if maskContainers.count != paths.count {
            contentView?.removeFromSuperview()
            maskContainers.forEach { $0.removeFromSuperview() }
            maskContainers = paths.map { _ in OcclusionMaskContainerView(frame: bounds) }

            var parent: UIView = self
            for container in maskContainers {
                parent.addSubview(container)
                parent = container
            }
        }

        let expectedContentParent: UIView = maskContainers.last ?? self
        if let contentView, contentView.superview !== expectedContentParent {
            expectedContentParent.addSubview(contentView)
        }
        layoutMaskHierarchy()
    }

    private func layoutMaskHierarchy() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        outerClipMask.frame = bounds
        outerClipMask.path = (localOuterClipPath() ?? UIBezierPath(rect: bounds)).cgPath
        CATransaction.commit()
        maskContainers.forEach { $0.frame = bounds }
        contentView?.frame = bounds
        for (container, path) in zip(maskContainers, localOcclusionPaths()) {
            container.setOcclusionPath(path)
        }
    }
}

private func roundedOuterClipPath(
    rect: CGRect,
    radii: (topLeft: CGFloat, topRight: CGFloat, bottomRight: CGFloat, bottomLeft: CGFloat)
) -> UIBezierPath {
    let raw = [
        max(0, radii.topLeft),
        max(0, radii.topRight),
        max(0, radii.bottomRight),
        max(0, radii.bottomLeft),
    ]
    func edgeScale(_ length: CGFloat, _ first: CGFloat, _ second: CGFloat) -> CGFloat {
        let total = first + second
        return total > 0 ? max(0, length) / total : 1
    }
    let scale = [
        CGFloat(1),
        edgeScale(rect.width, raw[0], raw[1]),
        edgeScale(rect.width, raw[3], raw[2]),
        edgeScale(rect.height, raw[0], raw[3]),
        edgeScale(rect.height, raw[1], raw[2]),
    ].min() ?? 1
    let topLeft = raw[0] * scale
    let topRight = raw[1] * scale
    let bottomRight = raw[2] * scale
    let bottomLeft = raw[3] * scale
    let path = UIBezierPath()
    path.move(to: CGPoint(x: rect.minX + topLeft, y: rect.minY))
    path.addLine(to: CGPoint(x: rect.maxX - topRight, y: rect.minY))
    if topRight > 0 {
        path.addArc(
            withCenter: CGPoint(x: rect.maxX - topRight, y: rect.minY + topRight),
            radius: topRight,
            startAngle: -.pi / 2,
            endAngle: 0,
            clockwise: true
        )
    }
    path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - bottomRight))
    if bottomRight > 0 {
        path.addArc(
            withCenter: CGPoint(x: rect.maxX - bottomRight, y: rect.maxY - bottomRight),
            radius: bottomRight,
            startAngle: 0,
            endAngle: .pi / 2,
            clockwise: true
        )
    }
    path.addLine(to: CGPoint(x: rect.minX + bottomLeft, y: rect.maxY))
    if bottomLeft > 0 {
        path.addArc(
            withCenter: CGPoint(x: rect.minX + bottomLeft, y: rect.maxY - bottomLeft),
            radius: bottomLeft,
            startAngle: .pi / 2,
            endAngle: .pi,
            clockwise: true
        )
    }
    path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + topLeft))
    if topLeft > 0 {
        path.addArc(
            withCenter: CGPoint(x: rect.minX + topLeft, y: rect.minY + topLeft),
            radius: topLeft,
            startAngle: .pi,
            endAngle: .pi * 1.5,
            clockwise: true
        )
    }
    path.close()
    return path
}

/// Each wrapper subtracts exactly one rounded hole. Nesting wrappers composes
/// their alpha masks by intersection, so partially overlapping holes remain a
/// union instead of the XOR produced by one even-odd path.
private final class OcclusionMaskContainerView: UIView {
    private let shapeMask = CAShapeLayer()
    private var occlusionPath = UIBezierPath()

    override init(frame: CGRect) {
        super.init(frame: frame)
        shapeMask.fillColor = UIColor.white.cgColor
        shapeMask.fillRule = .evenOdd
        layer.mask = shapeMask
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func setOcclusionPath(_ path: UIBezierPath) {
        occlusionPath = path
        updateMask()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateMask()
    }

    private func updateMask() {
        let visiblePath = UIBezierPath(rect: bounds)
        visiblePath.append(occlusionPath)
        shapeMask.frame = bounds
        shapeMask.path = visiblePath.cgPath
    }
}
