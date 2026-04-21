import FamilyControls
import Foundation
import Security

enum ScreenTimeSupport {
    private static let familyControlsEntitlement = "com.apple.developer.family-controls"
    private static let appAndWebsiteUsageEntitlement = "com.apple.developer.family-controls.app-and-website-usage"

    static func buildStatus(reasonOverride: String? = nil) -> [String: Any] {
        let familyControlsEnabled = entitlementIsEnabled(familyControlsEntitlement)
        let appAndWebsiteUsageEnabled = entitlementIsEnabled(appAndWebsiteUsageEntitlement)
        let authorizationStatus = authorizationStatusString()

        let reason = reasonOverride ?? derivedReason(
            familyControlsEnabled: familyControlsEnabled,
            appAndWebsiteUsageEnabled: appAndWebsiteUsageEnabled,
            authorizationStatus: authorizationStatus
        )

        return [
            "supported": familyControlsEnabled && appAndWebsiteUsageEnabled,
            "entitlements": [
                "familyControls": familyControlsEnabled,
                "appAndWebsiteUsage": appAndWebsiteUsageEnabled,
            ],
            "authorization": [
                "status": authorizationStatus,
                "canRequest": canRequestAuthorization(
                    familyControlsEnabled: familyControlsEnabled,
                    authorizationStatus: authorizationStatus
                ),
            ],
            "reportAvailable": false,
            "coarseSummaryAvailable": false,
            "thresholdEventsAvailable": false,
            "rawUsageExportAvailable": false,
            "reason": reason,
        ]
    }

    private static func authorizationStatusString() -> String {
        runOnMain {
            switch AuthorizationCenter.shared.authorizationStatus {
            case .approved:
                return "approved"
            case .denied:
                return "denied"
            case .notDetermined:
                return "not-determined"
            @unknown default:
                return "unavailable"
            }
        }
    }

    private static func canRequestAuthorization(
        familyControlsEnabled: Bool,
        authorizationStatus: String
    ) -> Bool {
        familyControlsEnabled && authorizationStatus != "approved"
    }

    private static func derivedReason(
        familyControlsEnabled: Bool,
        appAndWebsiteUsageEnabled: Bool,
        authorizationStatus: String
    ) -> String {
        if !familyControlsEnabled {
            return "Family Controls entitlement is missing from the app bundle."
        }
        if !appAndWebsiteUsageEnabled {
            return "Family Controls app-and-website-usage entitlement is missing from the app bundle."
        }
        if authorizationStatus == "not-determined" {
            return "Screen Time authorization has not been granted yet."
        }
        if authorizationStatus == "denied" {
            return "Screen Time authorization was denied on this device."
        }
        return "DeviceActivity report and monitor extensions are not wired in this checkout."
    }

    private static func entitlementIsEnabled(_ key: String) -> Bool {
        guard let task = SecTaskCreateFromSelf(nil) else {
            return false
        }
        guard let value = SecTaskCopyValueForEntitlement(task, key as CFString, nil) else {
            return false
        }
        if let boolean = value as? Bool {
            return boolean
        }
        return false
    }

    private static func runOnMain<T>(_ work: () -> T) -> T {
        if Thread.isMainThread {
            return work()
        }
        return DispatchQueue.main.sync(execute: work)
    }
}
