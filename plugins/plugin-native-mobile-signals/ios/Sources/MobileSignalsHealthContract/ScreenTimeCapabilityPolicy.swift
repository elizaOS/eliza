/**
 * Defines the host-readable iOS Screen Time capability boundary without Apple-only SDK imports.
 */
import Foundation

public struct ScreenTimeCapabilityStatus: Equatable, Sendable {
    public let reportAvailable: Bool
    public let coarseSummaryAvailable: Bool
    public let thresholdEventsAvailable: Bool
    public let rawUsageExportAvailable: Bool
}

public enum ScreenTimeCapabilityPolicy {
    /**
     * Computes the capabilities that the host application may truthfully consume.
     *
     * DeviceActivity report data remains inside the report extension. A bundled, authorized
     * report therefore enables only the in-extension report surface. Host-readable summaries,
     * threshold events, and raw exports remain unavailable until lawful producers exist.
     */
    public static func status(
        reportExtensionAvailable: Bool,
        authorizationStatus: String
    ) -> ScreenTimeCapabilityStatus {
        ScreenTimeCapabilityStatus(
            reportAvailable: reportExtensionAvailable && authorizationStatus == "approved",
            coarseSummaryAvailable: false,
            thresholdEventsAvailable: false,
            rawUsageExportAvailable: false
        )
    }
}
