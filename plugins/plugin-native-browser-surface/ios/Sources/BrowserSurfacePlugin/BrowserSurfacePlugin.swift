import Foundation
import Capacitor
import WebKit
import UIKit

/// Native iOS half of `ElizaSurfaceManager` (#15245): layers one `WKWebView` per
/// Browser tab above the Capacitor host webview, each in its OWN renderer
/// process and storage partition, so third-party content can never reach the
/// host realm or a sibling tab.
///
/// Isolation is realised by the two WebKit primitives the JS policy maps onto:
/// an `isolated` process gets a fresh `WKProcessPool` (a distinct content
/// process); an `isolated` storage gets a non-persistent `WKWebsiteDataStore`
/// (its own cookies/localStorage/IndexedDB, nothing shared). `shared` reuses a
/// plugin-owned pool/the default store — never an implicit default, which is why
/// `createSurface` rejects when the policy fields are absent.
@objc(ElizaSurfaceManagerPlugin)
public class ElizaSurfaceManagerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaSurfaceManagerPlugin"
    public let jsName = "ElizaSurfaceManager"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "createSurface", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBounds", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "navigate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "foregroundSurface", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "backgroundSurface", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "destroySurface", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "foregroundHost", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSurfaceState", returnType: CAPPluginReturnPromise),
    ]

    private struct Surface {
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

            let webView = WKWebView(frame: hostView.bounds, configuration: config)
            webView.isHidden = true
            hostView.addSubview(webView)

            if let urlString = urlString, let url = URL(string: urlString) {
                webView.load(URLRequest(url: url))
            }
            self.surfaces[id] = Surface(webView: webView, process: process, storage: storage)
            call.resolve()
        }
    }

    @objc func setBounds(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("setBounds requires an id")
            return
        }
        let x = call.getDouble("x") ?? 0
        let y = call.getDouble("y") ?? 0
        let width = call.getDouble("width") ?? 0
        let height = call.getDouble("height") ?? 0
        DispatchQueue.main.async {
            guard let surface = self.surfaces[id] else {
                call.reject("no surface \(id)")
                return
            }
            // CSS px map 1:1 to UIKit points, so no density conversion is needed.
            surface.webView.frame = CGRect(x: x, y: y, width: width, height: height)
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
            surface.webView.superview?.bringSubviewToFront(surface.webView)
            surface.webView.isHidden = false
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
            surface.webView.isHidden = true
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
                surface.webView.removeFromSuperview()
            }
            call.resolve()
        }
    }

    @objc func foregroundHost(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            for surface in self.surfaces.values {
                surface.webView.isHidden = true
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
                "foregrounded": !surface.webView.isHidden,
                "currentUrl": surface.webView.url?.absoluteString ?? NSNull(),
                "process": surface.process,
                "storage": surface.storage,
            ])
        }
    }
}
