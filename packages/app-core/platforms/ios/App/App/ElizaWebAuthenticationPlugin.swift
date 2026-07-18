/**
 Presents first-party Cloud authorization through ASWebAuthenticationSession
 and returns only the claimed HTTPS callback to the Capacitor renderer. The
 native boundary pins both the authorization hosts and callback path so a
 renderer regression cannot turn this bridge into an arbitrary browser or
 custom-scheme credential receiver.
 */
import AuthenticationServices
import Capacitor
import Foundation
import Security
import UIKit

@objc(ElizaWebAuthenticationPlugin)
public class ElizaWebAuthenticationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaWebAuthenticationPlugin"
    public let jsName = "ElizaWebAuthentication"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeCredential", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadCredential", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteCredential", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeAuthorizationState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadAuthorizationState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteAuthorizationState", returnType: CAPPluginReturnPromise),
    ]

    private static let authorizationHostsByEnvironment = [
        "production": "elizacloud.ai",
        "staging": "staging.elizacloud.ai",
    ]
    private static let authorizationPath = "/app-auth/authorize"
    private static let callbackHost = "eliza.app"
    private static let callbackPath = "/auth/callback"
    private static let clientId = "ai.elizaos.app"
    private static let redirectUri = "https://eliza.app/auth/callback"
    private static let credentialService = "ai.elizaos.app.mobile-cloud-auth"
    private static let credentialApiBasesByEnvironment = [
        "production": "https://api.elizacloud.ai",
        "staging": "https://api-staging.elizacloud.ai",
    ]
    private static let allowedEnvironments = Set(["production", "staging"])
    private static let allowedCredentialSlots = Set(["active", "pending"])
    private static let authorizationQueryNames = Set([
        "client_id",
        "redirect_uri",
        "environment",
        "code_challenge",
        "code_challenge_method",
        "state",
    ])
    private static let callbackQueryNames = Set([
        "code",
        "error",
        "error_description",
        "state",
    ])
    private static let pkceValuePattern = "^[A-Za-z0-9_-]{43}$"
    private static let authorizationCodePattern = "^emac_[0-9a-f]{64}$"
    private static let oauthErrorPattern = "^[A-Za-z0-9_]{1,128}$"
    private static let apiKeyPattern = "^eliza_mobile_[0-9a-f]{64}$"

    private final class AuthorizationPresentationContext: NSObject,
        ASWebAuthenticationPresentationContextProviding
    {
        let presentationWindow: UIWindow

        init(presentationWindow: UIWindow) {
            self.presentationWindow = presentationWindow
        }

        func presentationAnchor(
            for session: ASWebAuthenticationSession
        ) -> ASPresentationAnchor {
            presentationWindow
        }
    }

    private struct AuthorizationSessionContext {
        let session: ASWebAuthenticationSession
        let presentationContext: AuthorizationPresentationContext
    }

    private var activeSessionGeneration: UUID?
    private var sessionContextsByGeneration: [UUID: AuthorizationSessionContext] = [:]

    @objc public func start(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("The native Cloud authorization bridge is unavailable")
                return
            }
            guard self.activeSessionGeneration == nil else {
                call.reject("A Cloud authorization session is already active")
                return
            }
            guard let rawUrl = call.getString("url"),
                  let authorizationUrl = URL(string: rawUrl),
                  self.isAllowedAuthorizationUrl(authorizationUrl)
            else {
                call.reject("Cloud authorization requires the canonical HTTPS authorize URL")
                return
            }
            guard let presentationWindow = self.presentationWindow() else {
                call.reject("Cloud authorization has no foreground presentation window")
                return
            }
            guard #available(iOS 17.4, *) else {
                call.reject("Secure Cloud authorization requires iOS 17.4 or later")
                return
            }

            let generation = UUID()
            let callback = ASWebAuthenticationSession.Callback.https(
                host: Self.callbackHost,
                path: Self.callbackPath
            )
            let session = ASWebAuthenticationSession(
                url: authorizationUrl,
                callback: callback
            ) { [weak self] callbackUrl, error in
                DispatchQueue.main.async {
                    guard let self,
                          self.finishAuthorizationSession(generation: generation)
                    else { return }
                    if let sessionError = error as? ASWebAuthenticationSessionError,
                       sessionError.code == .canceledLogin
                    {
                        call.resolve(["status": "canceled"])
                        return
                    }
                    if let error {
                        call.reject(
                            "Cloud authorization failed: \(error.localizedDescription)"
                        )
                        return
                    }
                    guard let callbackUrl,
                          self.isAllowedCallbackUrl(callbackUrl)
                    else {
                        call.reject("Cloud authorization returned an invalid callback")
                        return
                    }
                    call.resolve([
                        "status": "success",
                        "callbackUrl": callbackUrl.absoluteString,
                    ])
                }
            }
            let presentationContext = AuthorizationPresentationContext(
                presentationWindow: presentationWindow
            )
            session.presentationContextProvider = presentationContext
            session.prefersEphemeralWebBrowserSession = false
            guard session.canStart else {
                call.reject("Cloud authorization could not start")
                return
            }
            self.sessionContextsByGeneration[generation] = AuthorizationSessionContext(
                session: session,
                presentationContext: presentationContext
            )
            self.activeSessionGeneration = generation
            guard session.start() else {
                _ = self.finishAuthorizationSession(generation: generation)
                call.reject("Cloud authorization could not start")
                return
            }
        }
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if let self,
               let generation = self.activeSessionGeneration,
               let context = self.sessionContextsByGeneration[generation]
            {
                self.activeSessionGeneration = nil
                context.session.cancel()
            }
            call.resolve(["canceled": true])
        }
    }

    @objc public func storeCredential(_ call: CAPPluginCall) {
        do {
            let parsed = try parseCredential(call)
            let data = try JSONSerialization.data(withJSONObject: parsed.value)
            let slot = try parseCredentialSlot(call)
            let query = keychainQuery(environment: parsed.environment, slot: slot)
            let attributes: [String: Any] = [
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            ]

            let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if updateStatus == errSecItemNotFound {
                var insert = query
                attributes.forEach { insert[$0.key] = $0.value }
                let insertStatus = SecItemAdd(insert as CFDictionary, nil)
                guard insertStatus == errSecSuccess else {
                    throw credentialError("store", status: insertStatus)
                }
            } else if updateStatus != errSecSuccess {
                throw credentialError("store", status: updateStatus)
            }
            call.resolve(["stored": true])
        } catch {
            // error-policy:J1 Capacitor bridge boundary translates Keychain failures into a rejected plugin call.
            call.reject(error.localizedDescription)
        }
    }

    @objc public func loadCredential(_ call: CAPPluginCall) {
        do {
            let environment = try parseEnvironment(call)
            let slot = try parseCredentialSlot(call)
            var query = keychainQuery(environment: environment, slot: slot)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecItemNotFound {
                call.resolve(["credential": NSNull()])
                return
            }
            guard status == errSecSuccess,
                  let data = result as? Data,
                  let credential = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            else {
                throw credentialError("load", status: status)
            }
            call.resolve(["credential": credential])
        } catch {
            // error-policy:J1 Capacitor bridge boundary translates Keychain failures into a rejected plugin call.
            call.reject(error.localizedDescription)
        }
    }

    @objc public func deleteCredential(_ call: CAPPluginCall) {
        do {
            let environment = try parseEnvironment(call)
            let slot = try parseCredentialSlot(call)
            let expectedCredentialId = call.getString("credentialId")?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let expectedCredentialId {
                guard UUID(uuidString: expectedCredentialId) != nil else {
                    throw validationError("Cloud credential ID is invalid")
                }
                if let storedCredentialId = try storedCredentialId(
                    environment: environment,
                    slot: slot
                ) {
                    guard storedCredentialId == expectedCredentialId else {
                        throw validationError("Refusing to delete a different Cloud credential")
                    }
                }
            }

            let status = SecItemDelete(
                keychainQuery(environment: environment, slot: slot) as CFDictionary
            )
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw credentialError("delete", status: status)
            }
            call.resolve(["deleted": true])
        } catch {
            // error-policy:J1 Capacitor bridge boundary translates Keychain failures into a rejected plugin call.
            call.reject(error.localizedDescription)
        }
    }

    @objc public func storeAuthorizationState(_ call: CAPPluginCall) {
        do {
            let environment = try parseEnvironment(call)
            guard let value = call.getString("value"),
                  !value.isEmpty,
                  value.utf8.count <= 16_384,
                  let data = value.data(using: .utf8)
            else {
                throw validationError("Cloud authorization state is invalid")
            }
            let query = authorizationStateKeychainQuery(environment: environment)
            let attributes: [String: Any] = [
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            ]
            let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if updateStatus == errSecItemNotFound {
                var insert = query
                attributes.forEach { insert[$0.key] = $0.value }
                let insertStatus = SecItemAdd(insert as CFDictionary, nil)
                guard insertStatus == errSecSuccess else {
                    throw credentialError("store", status: insertStatus)
                }
            } else if updateStatus != errSecSuccess {
                throw credentialError("store", status: updateStatus)
            }
            call.resolve(["stored": true])
        } catch {
            // error-policy:J1 Capacitor bridge boundary translates Keychain failures into a rejected plugin call.
            call.reject(error.localizedDescription)
        }
    }

    @objc public func loadAuthorizationState(_ call: CAPPluginCall) {
        do {
            let environment = try parseEnvironment(call)
            var query = authorizationStateKeychainQuery(environment: environment)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecItemNotFound {
                call.resolve(["value": NSNull()])
                return
            }
            guard status == errSecSuccess,
                  let data = result as? Data,
                  let value = String(data: data, encoding: .utf8)
            else {
                throw credentialError("load", status: status)
            }
            call.resolve(["value": value])
        } catch {
            // error-policy:J1 Capacitor bridge boundary translates Keychain failures into a rejected plugin call.
            call.reject(error.localizedDescription)
        }
    }

    @objc public func deleteAuthorizationState(_ call: CAPPluginCall) {
        do {
            let environment = try parseEnvironment(call)
            let expectedState = call.getString("expectedState")
            if let expectedState {
                guard matches(expectedState, pattern: Self.pkceValuePattern) else {
                    throw validationError("Cloud authorization state generation is invalid")
                }
                guard let storedValue = try storedAuthorizationState(environment: environment) else {
                    call.resolve(["deleted": true])
                    return
                }
                guard let data = storedValue.data(using: .utf8),
                      let record = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let storedState = record["state"] as? String,
                      storedState == expectedState
                else {
                    throw validationError("Refusing to delete a different Cloud authorization state")
                }
            }
            let status = SecItemDelete(
                authorizationStateKeychainQuery(environment: environment) as CFDictionary
            )
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw credentialError("delete", status: status)
            }
            call.resolve(["deleted": true])
        } catch {
            // error-policy:J1 Capacitor bridge boundary translates Keychain failures into a rejected plugin call.
            call.reject(error.localizedDescription)
        }
    }

    private func finishAuthorizationSession(generation: UUID) -> Bool {
        guard sessionContextsByGeneration.removeValue(forKey: generation) != nil else {
            return false
        }
        if activeSessionGeneration == generation {
            activeSessionGeneration = nil
        }
        return true
    }

    private func presentationWindow() -> UIWindow? {
        if let window = bridge?.viewController?.view.window {
            return window
        }
        return UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }
            .flatMap(\.windows)
            .first(where: { $0.isKeyWindow })
    }

    private func isAllowedAuthorizationUrl(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              url.absoluteString.utf8.count <= 2_048,
              components.scheme?.lowercased() == "https",
              let host = components.host?.lowercased(),
              components.port == nil,
              components.user == nil,
              components.password == nil,
              components.percentEncodedPath == Self.authorizationPath,
              components.fragment == nil,
              let query = uniqueQueryValues(
                  components,
                  allowedNames: Self.authorizationQueryNames
              ),
              query.count == Self.authorizationQueryNames.count,
              query["client_id"] == Self.clientId,
              query["redirect_uri"] == Self.redirectUri,
              query["code_challenge_method"] == "S256",
              let environment = query["environment"],
              Self.authorizationHostsByEnvironment[environment] == host,
              let challenge = query["code_challenge"],
              matches(challenge, pattern: Self.pkceValuePattern),
              let state = query["state"],
              matches(state, pattern: Self.pkceValuePattern)
        else { return false }
        return true
    }

    private func isAllowedCallbackUrl(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              url.absoluteString.utf8.count <= 4_096,
              components.scheme?.lowercased() == "https",
              components.host?.lowercased() == Self.callbackHost,
              components.port == nil,
              components.user == nil,
              components.password == nil,
              components.percentEncodedPath == Self.callbackPath,
              components.fragment == nil,
              let query = uniqueQueryValues(
                  components,
                  allowedNames: Self.callbackQueryNames
              ),
              let state = query["state"],
              matches(state, pattern: Self.pkceValuePattern)
        else { return false }

        let code = query["code"]
        let error = query["error"]
        guard (code == nil) != (error == nil) else { return false }
        if let code, !matches(code, pattern: Self.authorizationCodePattern) {
            return false
        }
        if let error, !matches(error, pattern: Self.oauthErrorPattern) {
            return false
        }
        if let description = query["error_description"] {
            guard error != nil,
                  description.utf8.count <= 1_024,
                  description.unicodeScalars.allSatisfy({
                      !CharacterSet.controlCharacters.contains($0)
                  })
            else { return false }
        }
        return true
    }

    private func uniqueQueryValues(
        _ components: URLComponents,
        allowedNames: Set<String>
    ) -> [String: String]? {
        guard let items = components.queryItems, !items.isEmpty else { return nil }
        var values: [String: String] = [:]
        for item in items {
            guard allowedNames.contains(item.name),
                  values[item.name] == nil,
                  let value = item.value
            else { return nil }
            values[item.name] = value
        }
        return values
    }

    private func matches(_ value: String, pattern: String) -> Bool {
        guard let range = value.range(of: pattern, options: .regularExpression) else {
            return false
        }
        return range == value.startIndex..<value.endIndex
    }

    private func keychainQuery(environment: String, slot: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.credentialService,
            kSecAttrAccount as String: "\(environment):\(slot)",
        ]
    }

    private func authorizationStateKeychainQuery(environment: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.credentialService,
            kSecAttrAccount as String: "\(environment):authorization-state",
        ]
    }

    private func parseEnvironment(_ call: CAPPluginCall) throws -> String {
        guard let environment = call.getString("environment")?.trimmingCharacters(in: .whitespacesAndNewlines),
              Self.allowedEnvironments.contains(environment)
        else {
            throw validationError("Cloud credential environment is invalid")
        }
        return environment
    }

    private func parseCredentialSlot(_ call: CAPPluginCall) throws -> String {
        guard let slot = call.getString("slot")?.trimmingCharacters(in: .whitespacesAndNewlines),
              Self.allowedCredentialSlots.contains(slot)
        else {
            throw validationError("Cloud credential Keychain slot is invalid")
        }
        return slot
    }

    private func parseCredential(
        _ call: CAPPluginCall
    ) throws -> (environment: String, value: [String: Any]) {
        let environment = try parseEnvironment(call)
        guard let credentialId = call.getString("credentialId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              UUID(uuidString: credentialId) != nil
        else {
            throw validationError("Cloud credential ID is invalid")
        }
        guard let secret = call.getString("secret"),
              matches(secret, pattern: Self.apiKeyPattern)
        else {
            throw validationError("Cloud credential secret is invalid")
        }
        guard let rawApiBase = call.getString("apiBase"),
              Self.credentialApiBasesByEnvironment[environment] == rawApiBase
        else {
            throw validationError("Cloud credential API base is invalid")
        }
        guard let expiresAt = call.getString("expiresAt"),
              expiresAt.utf8.count <= 64,
              parseIso8601Date(expiresAt) != nil
        else {
            throw validationError("Cloud credential expiry is invalid")
        }

        return (
            environment,
            [
                "environment": environment,
                "credentialId": credentialId,
                "secret": secret,
                "apiBase": rawApiBase,
                "expiresAt": expiresAt,
            ]
        )
    }

    private func parseIso8601Date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private func storedCredentialId(environment: String, slot: String) throws -> String? {
        var query = keychainQuery(environment: environment, slot: slot)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess,
              let data = result as? Data,
              let credential = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            throw credentialError("load", status: status)
        }
        guard let credentialId = credential["credentialId"] as? String,
              UUID(uuidString: credentialId) != nil
        else {
            throw validationError("Stored Cloud credential ID is invalid")
        }
        return credentialId
    }

    private func storedAuthorizationState(environment: String) throws -> String? {
        var query = authorizationStateKeychainQuery(environment: environment)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8)
        else {
            throw credentialError("load", status: status)
        }
        return value
    }

    private func validationError(_ message: String) -> NSError {
        NSError(
            domain: "ElizaWebAuthentication",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: message]
        )
    }

    private func credentialError(_ operation: String, status: OSStatus) -> NSError {
        let detail = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
        return NSError(
            domain: "ElizaWebAuthentication",
            code: Int(status),
            userInfo: [
                NSLocalizedDescriptionKey: "Unable to \(operation) the Cloud credential in Keychain: \(detail)"
            ]
        )
    }
}
