/**
 * Provides the iOS Keychain boundary for the fixed, app-scoped credential
 * slots shared by the renderer storage bridge.
 */
import Capacitor
import Foundation
import Security

@objc(ElizaSecureStorePlugin)
public class ElizaSecureStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaSecureStorePlugin"
    public let jsName = "ElizaSecureStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise),
    ]

    private let service = "ai.elizaos.secure-store"
    private let maximumValueBytes = 256 * 1024
    private let allowedKeys: Set<String> = [
        "session.device_auth",
        "session.steward_token",
        "runtime.active_server",
        "runtime.agent_profiles",
    ]

    @objc func get(_ call: CAPPluginCall) {
        guard let key = validatedKey(call) else { return }
        var query = baseQuery(key)
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            call.resolve(errorResult("not_found", "Secure value was not found."))
            return
        }
        guard status == errSecSuccess, let data = item as? Data,
              let value = String(data: data, encoding: .utf8)
        else {
            call.resolve(statusResult(status))
            return
        }
        call.resolve(["ok": true, "value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = validatedKey(call) else { return }
        guard let value = call.getString("value"),
              let valueData = value.data(using: .utf8),
              valueData.count <= maximumValueBytes
        else {
            call.resolve(errorResult("invalid_input", "Secure value is missing or too large."))
            return
        }

        let query = baseQuery(key)
        let attributes: [String: Any] = [
            kSecValueData as String: valueData,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var add = query
            add.merge(attributes) { _, replacement in replacement }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        if status == errSecSuccess {
            call.resolve(["ok": true])
        } else {
            call.resolve(statusResult(status))
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = validatedKey(call) else { return }
        let status = SecItemDelete(baseQuery(key) as CFDictionary)
        if status == errSecSuccess {
            call.resolve(["ok": true, "deleted": true])
            return
        }
        if status == errSecItemNotFound {
            call.resolve(["ok": true, "deleted": false])
            return
        }
        call.resolve(statusResult(status))
    }

    @objc func status(_ call: CAPPluginCall) {
        call.resolve([
            "ok": true,
            "available": true,
            "backend": "apple_keychain",
            "accessibility": "after_first_unlock_this_device_only",
            "synchronized": false,
            "accessGroup": "app_only",
        ])
    }

    private func validatedKey(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key"), allowedKeys.contains(key) else {
            call.resolve(errorResult("invalid_input", "Secure-store key is not allowed."))
            return nil
        }
        return key
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            // Never opt these application credentials into iCloud Keychain.
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
    }

    private func statusResult(_ status: OSStatus) -> [String: Any] {
        if status == errSecAuthFailed || status == errSecInteractionNotAllowed || status == errSecUserCanceled {
            return errorResult("denied", "Apple Keychain access was denied.")
        }
        if status == errSecNotAvailable {
            return errorResult("unavailable", "Apple Keychain is unavailable on this device.")
        }
        return errorResult("native_error", "Apple Keychain operation failed (\(status)).")
    }

    private func errorResult(_ code: String, _ message: String) -> [String: Any] {
        return ["ok": false, "error": code, "message": message]
    }
}
