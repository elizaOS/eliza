import Capacitor
import FamilyControls
import Foundation
import UIKit

@objc(ElizaAppBlockerPlugin)
public class ElizaAppBlockerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaAppBlockerPlugin"
    public let jsName = "ElizaAppBlocker"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getInstalledApps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectApps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "blockApps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unblockApps", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
    ]

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(buildPermissionResult())
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        if #available(iOS 16.0, *) {
            Task { @MainActor in
                var reasonOverride: String?
                do {
                    try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
                } catch {
                    reasonOverride = error.localizedDescription
                }
                call.resolve(buildPermissionResult(reasonOverride: reasonOverride))
            }
            return
        }

        AuthorizationCenter.shared.requestAuthorization { result in
            let reasonOverride: String?
            switch result {
            case .success:
                reasonOverride = nil
            case .failure(let error):
                reasonOverride = error.localizedDescription
            }

            call.resolve(self.buildPermissionResult(reasonOverride: reasonOverride))
        }
    }

    @objc func getInstalledApps(_ call: CAPPluginCall) {
        call.resolve([
            "apps": [],
        ])
    }

    @objc func selectApps(_ call: CAPPluginCall) {
        guard let presenter = bridge?.viewController else {
            call.reject("Could not present the iPhone app picker.")
            return
        }

        Task { @MainActor in
            FamilyActivityPickerBridge.present(from: presenter) { tokens, cancelled in
                let apps = tokens.enumerated().compactMap { index, token -> JSObject? in
                    guard let tokenData = AppBlockerShared.serializeToken(token) else {
                        return nil
                    }
                    var object = JSObject()
                    object["packageName"] = ""
                    object["displayName"] = "Selected App \(index + 1)"
                    object["tokenData"] = tokenData
                    return object
                }

                call.resolve([
                    "apps": JSArray(apps),
                    "cancelled": cancelled,
                ])
            }
        }
    }

    @objc func blockApps(_ call: CAPPluginCall) {
        if AuthorizationCenter.shared.authorizationStatus != .approved {
            call.resolve([
                "success": false,
                "endsAt": NSNull(),
                "error": nullable(permissionReason(for: AuthorizationCenter.shared.authorizationStatus)),
                "blockedCount": 0,
            ])
            return
        }

        let durationMinutes = call.getInt("durationMinutes")
        if let durationMinutes, durationMinutes > 0 {
            call.resolve([
                "success": false,
                "endsAt": NSNull(),
                "error": "Timed iPhone app blocking still needs a DeviceActivity extension. Start an indefinite block for now and unblock it manually.",
                "blockedCount": 0,
            ])
            return
        }

        let tokenDataArray = (call.getArray("appTokens") ?? []).compactMap { $0 as? String }
        let tokens = AppBlockerShared.deserializeTokens(tokenDataArray)
        guard !tokens.isEmpty else {
            call.resolve([
                "success": false,
                "endsAt": NSNull(),
                "error": "Select at least one iPhone app to block.",
                "blockedCount": 0,
            ])
            return
        }

        AppBlockerShared.startBlock(tokens: tokens)
        call.resolve([
            "success": true,
            "endsAt": NSNull(),
            "blockedCount": tokens.count,
        ])
    }

    @objc func unblockApps(_ call: CAPPluginCall) {
        AppBlockerShared.stopBlock()
        call.resolve([
            "success": true,
        ])
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        let state = AppBlockerShared.loadState()
        let permission = buildPermissionResult()
        let permissionStatus = permission["status"] as? String ?? "not-determined"
        let reason = permission["reason"] as? String
        let blockedCount = state?.tokenDataArray.count ?? 0

        call.resolve([
            "available": true,
            "active": permissionStatus == "granted" && blockedCount > 0,
            "platform": "ios",
            "engine": "family-controls",
            "blockedCount": blockedCount,
            "blockedPackageNames": [],
            "endsAt": nullable(AppBlockerShared.endsAtString(for: state)),
            "permissionStatus": permissionStatus,
            "reason": nullable(reason),
        ])
    }

    private func buildPermissionResult(reasonOverride: String? = nil) -> [String: Any] {
        let status = AuthorizationCenter.shared.authorizationStatus
        let mappedStatus: String
        let canRequest: Bool

        switch status {
        case .approved:
            mappedStatus = "granted"
            canRequest = false
        case .notDetermined:
            mappedStatus = "not-determined"
            canRequest = true
        default:
            mappedStatus = "denied"
            canRequest = true
        }

        var result: [String: Any] = [
            "status": mappedStatus,
            "canRequest": canRequest,
        ]

        if let reason = reasonOverride ?? permissionReason(for: status) {
            result["reason"] = reason
        }

        return result
    }

    private func permissionReason(for status: AuthorizationStatus) -> String? {
        switch status {
        case .approved:
            return nil
        case .notDetermined:
            return "Authorize Family Controls before Eliza can choose and shield apps on this iPhone."
        default:
            return "Family Controls access is currently denied for this app. Re-run authorization on this iPhone developer build."
        }
    }

    private func nullable(_ value: Any?) -> Any {
        value ?? NSNull()
    }
}
