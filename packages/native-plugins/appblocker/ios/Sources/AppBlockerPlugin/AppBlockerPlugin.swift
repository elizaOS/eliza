import Capacitor
import FamilyControls
import ManagedSettings

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

    private var pickerBridge: AnyObject?

    // MARK: - Permissions

    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        if #available(iOS 16.0, *) {
            let status = AuthorizationCenter.shared.authorizationStatus
            call.resolve(permissionResult(status))
        } else {
            call.resolve([
                "status": "not-applicable",
                "canRequest": false,
                "reason": "App blocking requires iOS 16 or later.",
            ])
        }
    }

    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else {
            call.resolve([
                "status": "not-applicable",
                "canRequest": false,
                "reason": "App blocking requires iOS 16 or later.",
            ])
            return
        }

        Task {
            do {
                try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
                let status = AuthorizationCenter.shared.authorizationStatus
                call.resolve(self.permissionResult(status))
            } catch {
                call.resolve([
                    "status": "denied",
                    "canRequest": true,
                    "reason": "Authorization request failed: \(error.localizedDescription)",
                ])
            }
        }
    }

    // MARK: - App Selection

    @objc func getInstalledApps(_ call: CAPPluginCall) {
        // iOS uses opaque tokens — cannot enumerate installed apps.
        call.resolve(["apps": []])
    }

    @objc func selectApps(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else {
            call.resolve(["apps": [], "cancelled": true])
            return
        }

        guard isAuthorized(AuthorizationCenter.shared.authorizationStatus) else {
            call.reject("FamilyControls authorization is required before selecting apps. Call requestPermissions() first.")
            return
        }

        DispatchQueue.main.async {
            guard let viewController = self.bridge?.viewController else {
                call.reject("No view controller available to present the app picker.")
                return
            }

            let pickerBridge = FamilyActivityPickerBridge()
            self.pickerBridge = pickerBridge
            pickerBridge.present(from: viewController) { tokenDataArray, cancelled in
                if cancelled {
                    self.pickerBridge = nil
                    call.resolve(["apps": [], "cancelled": true])
                    return
                }

                let apps = tokenDataArray.enumerated().map { index, tokenData in
                    return [
                        "packageName": "",
                        "displayName": "App \(index + 1)",
                        "tokenData": tokenData,
                    ]
                }
                self.pickerBridge = nil
                call.resolve(["apps": apps, "cancelled": false])
            }
        }
    }

    // MARK: - Blocking

    @objc func blockApps(_ call: CAPPluginCall) {
        guard #available(iOS 16.0, *) else {
            call.resolve([
                "success": false,
                "endsAt": NSNull(),
                "error": "App blocking requires iOS 16 or later.",
                "blockedCount": 0,
            ])
            return
        }

        guard isAuthorized(AuthorizationCenter.shared.authorizationStatus) else {
            call.resolve([
                "success": false,
                "endsAt": NSNull(),
                "error": "FamilyControls authorization is required.",
                "blockedCount": 0,
            ])
            return
        }

        let appTokens = call.getArray("appTokens", String.self) ?? []
        guard !appTokens.isEmpty else {
            call.resolve([
                "success": false,
                "endsAt": NSNull(),
                "error": "No app tokens provided. Call selectApps() first to get tokens.",
                "blockedCount": 0,
            ])
            return
        }

        let durationMinutes: Double? = {
            if call.hasOption("durationMinutes") {
                let val = call.getDouble("durationMinutes")
                return val
            }
            return nil
        }()

        if let durationMinutes, durationMinutes > 0 {
            call.resolve([
                "success": false,
                "endsAt": NSNull(),
                "error": "Timed iPhone app blocking still needs a DeviceActivity extension. Start an indefinite block for now and unblock it manually.",
                "blockedCount": 0,
            ])
            return
        }

        let result = AppBlockerShared.startBlock(tokenDataArray: appTokens, durationMinutes: durationMinutes)

        call.resolve([
            "success": result.success,
            "endsAt": result.endsAt ?? NSNull(),
            "blockedCount": appTokens.count,
        ])
    }

    @objc func unblockApps(_ call: CAPPluginCall) {
        AppBlockerShared.stopBlock()
        call.resolve(["success": true])
    }

    // MARK: - Status

    @objc func getStatus(_ call: CAPPluginCall) {
        if #available(iOS 16.0, *) {
            let authStatus = AuthorizationCenter.shared.authorizationStatus
            let state = AppBlockerShared.loadState()
            let active = state != nil && !(state?.tokenDataArray.isEmpty ?? true)

            var endsAtISO: String? = nil
            if let endsAtMs = state?.endsAtEpochMs {
                let date = Date(timeIntervalSince1970: endsAtMs / 1000)
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                endsAtISO = formatter.string(from: date)
            }

            call.resolve([
                "available": true,
                "active": active,
                "platform": "ios",
                "engine": "family-controls",
                "blockedCount": state?.tokenDataArray.count ?? 0,
                "blockedPackageNames": [],
                "endsAt": endsAtISO ?? NSNull(),
                "permissionStatus": permissionStatusString(authStatus),
            ])
        } else {
            call.resolve([
                "available": false,
                "active": false,
                "platform": "ios",
                "engine": "none",
                "blockedCount": 0,
                "blockedPackageNames": [],
                "endsAt": NSNull(),
                "permissionStatus": "not-applicable",
                "reason": "App blocking requires iOS 16 or later.",
            ])
        }
    }

    // MARK: - Helpers

    @available(iOS 16.0, *)
    private func permissionResult(_ status: AuthorizationStatus) -> [String: Any] {
        return [
            "status": permissionStatusString(status),
            "canRequest": !isAuthorized(status),
        ]
    }

    @available(iOS 16.0, *)
    private func permissionStatusString(_ status: AuthorizationStatus) -> String {
        switch status {
        case .denied: return "denied"
        case .notDetermined: return "not-determined"
        default: return "granted"
        }
    }

    @available(iOS 16.0, *)
    private func isAuthorized(_ status: AuthorizationStatus) -> Bool {
        switch status {
        case .denied, .notDetermined:
            return false
        default:
            return true
        }
    }
}
