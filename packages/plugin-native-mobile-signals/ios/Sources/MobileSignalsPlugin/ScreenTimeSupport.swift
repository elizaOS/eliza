/**
 * Inspects iOS Screen Time provisioning and exposes only capabilities that the
 * app process can actually use without crossing Apple's extension sandbox.
 */
import FamilyControls
import DeviceActivity
import Foundation
import Security
import SwiftUI

enum ScreenTimeSupport {
    private static let familyControlsEntitlement = "com.apple.developer.family-controls"
    private static let requiredFrameworks = ["FamilyControls", "DeviceActivity"]
    private static let deviceActivityMonitorExtensionPoint = "com.apple.deviceactivity.monitor-extension"
    private static let deviceActivityReportExtensionPoint = "com.apple.deviceactivityui.report-extension"

    private struct ExtensionInspection {
        let monitor: Bool
        let report: Bool
        let inspected: String
        let bundles: [[String: Any]]

        var complete: Bool {
            monitor && report
        }
    }

    private struct EntitlementInspection {
        let familyControls: Bool
        let inspected: String
        let reason: String?

        var satisfied: Bool {
            familyControls
        }

        var provisioningState: ScreenTimeCapabilityPolicy.ProvisioningState {
            if familyControls { return .verified }
            return inspected == "not-inspectable" ? .unknown : .missing
        }
    }

    static func buildStatus() -> [String: Any] {
        let entitlementInspection = inspectEntitlements()
        let extensionInspection = inspectBundledExtensions()
        let familyControlsEnabled = entitlementInspection.familyControls
        let provisioningSatisfied = entitlementInspection.satisfied
        let provisioningState = entitlementInspection.provisioningState
        let environment = ScreenTimeCapabilityPolicy.hostEnvironment
        let authorizationStatus = environment == .simulator
            ? "unavailable"
            : authorizationStatusString()
        let authorizationApproved = authorizationStatus == "approved"
        let presenterAvailable = reportPresenterAvailable
        let availability = ScreenTimeCapabilityPolicy.availability(
            environment: environment,
            provisioning: provisioningState,
            authorizationApproved: authorizationApproved,
            reportExtensionBundled: extensionInspection.report,
            presenterAvailable: presenterAvailable
        )

        let reason = derivedReason(
            provisioning: provisioningState,
            authorizationStatus: authorizationStatus,
            extensionInspection: extensionInspection,
            presenterAvailable: presenterAvailable
        )
        let provisioningReason: Any
        if provisioningSatisfied {
            provisioningReason = NSNull()
        } else if let unavailableReason = entitlementInspection.reason ?? reason {
            provisioningReason = unavailableReason
        } else {
            provisioningReason = NSNull()
        }
        return [
            "supported": ScreenTimeCapabilityPolicy.platformSupported(
                environment: environment,
                provisioning: provisioningState
            ),
            "hostEnvironment": environment.rawValue,
            "availability": availability,
            "requirements": [
                "entitlements": [
                    "familyControls": familyControlsEntitlement,
                ],
                "frameworks": requiredFrameworks,
                "deviceActivityReportExtension": true,
                "deviceActivityMonitorExtension": true,
                "deviceActivityReportExtensionPoint": deviceActivityReportExtensionPoint,
                "deviceActivityMonitorExtensionPoint": deviceActivityMonitorExtensionPoint,
            ],
            "entitlements": [
                "familyControls": familyControlsEnabled,
            ],
            "provisioning": [
                "satisfied": provisioningSatisfied,
                "status": provisioningState.rawValue,
                "inspected": entitlementInspection.inspected,
                "reason": provisioningReason,
            ],
            "authorization": [
                "status": authorizationStatus,
                "canRequest": ScreenTimeCapabilityPolicy.authorizationRequestAvailable(
                    environment: environment,
                    provisioning: provisioningState,
                    reportExtensionBundled: extensionInspection.report,
                    presenterAvailable: presenterAvailable
                ),
            ],
            "extensions": [
                "deviceActivityReportExtension": extensionInspection.report,
                "deviceActivityMonitorExtension": extensionInspection.monitor,
                "inspected": extensionInspection.inspected,
                "bundles": extensionInspection.bundles,
            ],
            "reportAvailable": ScreenTimeCapabilityPolicy.reportAvailable(
                environment: environment,
                provisioning: provisioningState,
                authorizationApproved: authorizationApproved,
                reportExtensionBundled: extensionInspection.report,
                presenterAvailable: presenterAvailable
            ),
            "coarseSummaryAvailable": ScreenTimeCapabilityPolicy.coarseSummaryAvailable,
            "thresholdEventsAvailable": ScreenTimeCapabilityPolicy.thresholdEventsAvailable,
            "rawUsageExportAvailable": ScreenTimeCapabilityPolicy.rawUsageExportAvailable,
            "reason": reason ?? NSNull(),
        ]
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

    private static func derivedReason(
        provisioning: ScreenTimeCapabilityPolicy.ProvisioningState,
        authorizationStatus: String,
        extensionInspection: ExtensionInspection,
        presenterAvailable: Bool
    ) -> String? {
        if provisioning == .missing {
            return "Family Controls entitlement is missing from the app bundle."
        }
        if !extensionInspection.report {
            return "DeviceActivity report extension is not bundled with the app."
        }
        if !presenterAvailable {
            return "This iOS version cannot present DeviceActivity reports."
        }
        if authorizationStatus == "denied" {
            return "Screen Time authorization was denied."
        }
        if authorizationStatus != "approved" {
            return "Screen Time authorization is required to present the private report."
        }
        return nil
    }

    static var reportPresenterAvailable: Bool {
        if #available(iOS 16.0, *) { return true }
        return false
    }

    static func canRequestAuthorization() -> Bool {
        let entitlementInspection = inspectEntitlements()
        let extensionInspection = inspectBundledExtensions()
        return ScreenTimeCapabilityPolicy.authorizationRequestAvailable(
            environment: ScreenTimeCapabilityPolicy.hostEnvironment,
            provisioning: entitlementInspection.provisioningState,
            reportExtensionBundled: extensionInspection.report,
            presenterAvailable: reportPresenterAvailable
        )
    }

    private static func inspectBundledExtensions() -> ExtensionInspection {
        guard let plugInsURL = Bundle.main.builtInPlugInsURL else {
            return ExtensionInspection(
                monitor: false,
                report: false,
                inspected: "bundle-plug-ins",
                bundles: []
            )
        }

        let extensionURLs = (
            try? FileManager.default.contentsOfDirectory(
                at: plugInsURL,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            )
        ) ?? []

        var monitor = false
        var report = false
        var bundles: [[String: Any]] = []

        for extensionURL in extensionURLs where extensionURL.pathExtension == "appex" {
            guard let bundle = Bundle(url: extensionURL) else {
                continue
            }
            let extensionInfo = bundle.object(forInfoDictionaryKey: "NSExtension") as? [String: Any]
            let extensionPoint = extensionInfo?["NSExtensionPointIdentifier"] as? String
            if extensionPoint == deviceActivityMonitorExtensionPoint {
                monitor = true
            }
            if extensionPoint == deviceActivityReportExtensionPoint {
                report = true
            }
            bundles.append([
                "bundleIdentifier": bundle.bundleIdentifier ?? extensionURL.deletingPathExtension().lastPathComponent,
                "extensionPoint": extensionPoint ?? NSNull(),
                "path": extensionURL.lastPathComponent,
            ])
        }

        return ExtensionInspection(
            monitor: monitor,
            report: report,
            inspected: "bundle-plug-ins",
            bundles: bundles
        )
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

@available(iOS 16.0, *)
struct ElizaScreenTimeReportView: View {
    @Environment(\.dismiss) private var dismiss

    private let filter = DeviceActivityFilter(
        segment: .daily(
            during: DateInterval(
                start: Calendar.current.date(byAdding: .day, value: -6, to: .now)
                    ?? Calendar.current.startOfDay(for: .now),
                end: .now
            )
        ),
        devices: .all
    )

    var body: some View {
        NavigationStack {
            DeviceActivityReport(.elizaScreenTimeSummary, filter: filter)
                .navigationTitle("Screen Time")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}

@available(iOS 16.0, *)
private extension DeviceActivityReport.Context {
    static let elizaScreenTimeSummary = Self("eliza.screen-time.summary")
}
