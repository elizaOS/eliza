/**
 * Defines which Screen Time capabilities the host may truthfully advertise.
 * DeviceActivity report data remains inside Apple's report-extension sandbox;
 * monitor events become available only after a concrete schedule is installed.
 */
public enum ScreenTimeCapabilityPolicy {
    public static let unavailableReason =
        "Screen Time reports are unavailable because the host app has no DeviceActivity presenter."
    public static let authorizationRequestAvailable = false
    public static let reportAvailable = false
    public static let coarseSummaryAvailable = false
    public static let thresholdEventsAvailable = false
    public static let rawUsageExportAvailable = false
}
