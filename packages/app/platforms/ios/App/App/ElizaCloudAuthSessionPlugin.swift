/**
 Presents hosted Eliza Cloud sign-in in an ASWebAuthenticationSession and
 returns the claimed HTTPS callback (https://eliza.app/auth/callback) to the
 renderer, which runs the mobile PKCE token exchange and ACK (#16420).

 The launch URL is restricted to the canonical hosted login origins and the
 callback host/path are fixed here, never supplied by JavaScript. One session
 owns a sign-in at a time. HTTPS callbacks require iOS 17.4; earlier systems
 report `unavailable` so the renderer keeps its existing browser fallback.
 */
import AuthenticationServices
import Capacitor
import Foundation
import UIKit

@objc(ElizaCloudAuthSessionPlugin)
public final class ElizaCloudAuthSessionPlugin: CAPPlugin, CAPBridgedPlugin,
    ASWebAuthenticationPresentationContextProviding
{
    public let identifier = "ElizaCloudAuthSessionPlugin"
    public let jsName = "ElizaCloudAuthSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    static let allowedLoginHosts: Set<String> = [
        "cloud.eliza.app",
        "cloud-staging.eliza.app",
    ]
    static let callbackHost = "eliza.app"
    static let callbackPath = "/auth/callback"

    private var session: ASWebAuthenticationSession?

    private static var supportsHttpsCallback: Bool {
        if #available(iOS 17.4, *) { return true }
        return false
    }

    @objc public func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": Self.supportsHttpsCallback])
    }

    static func isAllowedLoginURL(_ url: URL) -> Bool {
        guard url.scheme == "https", url.user == nil, url.password == nil,
              let host = url.host?.lowercased()
        else { return false }
        return allowedLoginHosts.contains(host) && url.port == nil
    }

    static func isExpectedCallback(_ url: URL) -> Bool {
        url.scheme == "https" && url.host?.lowercased() == callbackHost
            && url.port == nil && url.path == callbackPath
    }

    @objc public func start(_ call: CAPPluginCall) {
        guard let raw = call.getString("url"), let url = URL(string: raw),
              Self.isAllowedLoginURL(url)
        else {
            call.reject("Eliza Cloud sign-in URL is not allowed.", "invalid_url")
            return
        }
        guard #available(iOS 17.4, *) else {
            call.reject("Native Eliza Cloud sign-in requires iOS 17.4.", "unavailable")
            return
        }
        let ephemeral = call.getBool("ephemeral") ?? false
        DispatchQueue.main.async {
            guard self.session == nil else {
                call.reject("An Eliza Cloud sign-in is already open.", "busy")
                return
            }
            let session = ASWebAuthenticationSession(
                url: url,
                callback: .https(host: Self.callbackHost, path: Self.callbackPath)
            ) { [weak self] callbackURL, error in
                self?.session = nil
                if let error = error as? ASWebAuthenticationSessionError,
                   error.code == .canceledLogin
                {
                    call.reject("Eliza Cloud sign-in was cancelled.", "cancelled")
                    return
                }
                if let error {
                    call.reject(error.localizedDescription, "failed", error)
                    return
                }
                guard let callbackURL, Self.isExpectedCallback(callbackURL) else {
                    call.reject("Eliza Cloud returned an unexpected callback.", "failed")
                    return
                }
                call.resolve(["callbackUrl": callbackURL.absoluteString])
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = ephemeral
            self.session = session
            if !session.start() {
                self.session = nil
                call.reject("Eliza Cloud sign-in could not be presented.", "unavailable")
            }
        }
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.session?.cancel()
            self.session = nil
            call.resolve()
        }
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        if let window = bridge?.viewController?.view.window { return window }
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        return scene?.windows.first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
