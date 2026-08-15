import Foundation

/// Pure policy contract for iOS Screen Time / DeviceActivity capability reporting.
/// 
/// This module is the single source of truth for `coarseSummaryAvailable` and
/// `thresholdEventsAvailable`. It deliberately contains NO DeviceActivity or
/// FamilyControls imports — it is pure Swift Foundation so it can be unit-tested
/// on macOS via `swift test` without a full iOS SDK.
///
/// Apple's DeviceActivity privacy model (iOS 15+):
/// - `DeviceActivityReport` runs in a privacy sandbox; results cannot leave the
///   extension process. There is NO lawful host-readable producer for coarse
///   category summaries today.
/// - `DeviceActivityMonitor` threshold events require the app to schedule a
///   typed threshold (via `DeviceActivityMonitor.scheduleMonitoring`),
///   persist it, and implement `eventDidReachThreshold(_:activity:)`.
///   Bundling the monitor extension alone is insufficient.
///
/// Therefore both capabilities MUST remain false until a lawful host-readable
/// producer exists. This module encodes that as compile-time constants.
public enum ScreenTimeCapabilityPolicy {
    /// Coarse, in-extension-rendered category summaries available to the host.
    /// Permanently `false` — Apple provides no API to exfiltrate these from the
    /// report extension. If a future iOS version adds a host-readable summary
    /// API, flip this constant and update the test contract.
    public static let coarseSummaryAvailable = false

    /// `DeviceActivityMonitor` threshold-crossing events available to the host.
    /// Permanently `false` until the app actually schedules and handles a typed
    /// threshold event. Bundling the monitor extension is NOT sufficient.
    public static let thresholdEventsAvailable = false

    /// Raw per-app usage export — permanently `false` (platform constraint).
    public static let rawUsageExportAvailable = false

    /// Report extension surface is available (authorized + bundled).
    /// This is the ONLY Screen Time capability that can be true today.
    public static func reportAvailable(
        extensionInspectionReport: Bool,
        authorizationStatus: String
    ) -> Bool {
        extensionInspectionReport && authorizationStatus == "approved"
    }
}