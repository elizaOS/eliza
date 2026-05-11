import FamilyControls
import DeviceActivity
import Foundation
import Security

enum ScreenTimeSupport {
    private static let familyControlsEntitlement = "com.apple.developer.family-controls"
    private static let requiredFrameworks = ["FamilyControls", "DeviceActivity"]

    private struct EntitlementInspection {
        let familyControls: Bool
        let inspected: String
        let reason: String?

        var satisfied: Bool {
            familyControls
        }

        var canAttemptAuthorization: Bool {
            inspected == "not-inspectable" || familyControls
        }
    }

    static func buildStatus(reasonOverride: String? = nil) -> [String: Any] {
        let entitlementInspection = inspectEntitlements()
        let familyControlsEnabled = entitlementInspection.familyControls
        let authorizationEntitlementAvailable = entitlementInspection.canAttemptAuthorization
        let authorizationStatus = authorizationStatusString()
        let provisioningSatisfied = entitlementInspection.satisfied

        let reason = reasonOverride ?? derivedReason(
            familyControlsEnabled: authorizationEntitlementAvailable,
            authorizationStatus: authorizationStatus
        )
        let provisioningReason: Any = provisioningSatisfied
            ? NSNull()
            : (entitlementInspection.reason ?? reason)

        return [
            "supported": provisioningSatisfied || entitlementInspection.inspected == "not-inspectable",
            "requirements": [
                "entitlements": [
                    "familyControls": familyControlsEntitlement,
                ],
                "frameworks": requiredFrameworks,
                "deviceActivityReportExtension": false,
                "deviceActivityMonitorExtension": false,
            ],
            "entitlements": [
                "familyControls": familyControlsEnabled,
            ],
            "provisioning": [
                "satisfied": provisioningSatisfied,
                "inspected": entitlementInspection.inspected,
                "reason": provisioningReason,
            ],
            "authorization": [
                "status": authorizationStatus,
                "canRequest": canRequestAuthorization(
                    familyControlsEnabled: authorizationEntitlementAvailable,
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

    static func requestAuthorizationIfAvailable(
        completion: @escaping (String?) -> Void
    ) {
        let entitlementInspection = inspectEntitlements()
        let authorizationStatus = authorizationStatusString()
        guard canRequestAuthorization(
            familyControlsEnabled: entitlementInspection.canAttemptAuthorization,
            authorizationStatus: authorizationStatus
        ) else {
            DispatchQueue.main.async {
                completion(nil)
            }
            return
        }

        if #available(iOS 16.0, *) {
            Task { @MainActor in
                do {
                    try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
                    completion(nil)
                } catch {
                    completion("Screen Time authorization request failed: \(error.localizedDescription)")
                }
            }
            return
        }

        DispatchQueue.main.async {
            AuthorizationCenter.shared.requestAuthorization { result in
                DispatchQueue.main.async {
                    switch result {
                    case .success:
                        completion(nil)
                    case .failure(let error):
                        completion("Screen Time authorization request failed: \(error.localizedDescription)")
                    }
                }
            }
        }
    }

    private static func authorizationStatusString() -> String {
        runOnMain {
            switch AuthorizationCenter.shared.authorizationStatus {
            case .approved:
                return "approved"
            #if compiler(>=6.2)
            // .approvedWithDataAccess shipped in iOS 26 (Xcode 26 / Swift 6.2).
            // Older Xcode/SDK combinations don't know the case at all, so it
            // has to be guarded at compile time, not via #available.
            case .approvedWithDataAccess:
                return "approved"
            #endif
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
        familyControlsEnabled && authorizationStatus == "not-determined"
    }

    private static func derivedReason(
        familyControlsEnabled: Bool,
        authorizationStatus: String
    ) -> String {
        if !familyControlsEnabled {
            return "Family Controls entitlement is missing from the app bundle."
        }
        if authorizationStatus == "not-determined" {
            return "Screen Time authorization has not been granted yet."
        }
        if authorizationStatus == "denied" {
            return "Screen Time authorization was denied on this device."
        }
        return "DeviceActivity report and monitor extensions are not wired in this checkout."
    }

    private static func inspectEntitlements() -> EntitlementInspection {
        #if os(macOS)
        return EntitlementInspection(
            familyControls: entitlementIsEnabled(familyControlsEntitlement),
            inspected: "code-signature",
            reason: nil
        )
        #else
        return EntitlementInspection(
            familyControls: false,
            inspected: "not-inspectable",
            reason: "iOS entitlement inspection is handled by build validation and provisioning profile checks."
        )
        #endif
    }

    #if os(macOS)
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
    #endif

    private static func runOnMain<T>(_ work: () -> T) -> T {
        if Thread.isMainThread {
            return work()
        }
        return DispatchQueue.main.sync(execute: work)
    }
}
