/**
 * Defines which Screen Time capabilities the host may truthfully advertise.
 * DeviceActivity report data remains inside Apple's report-extension sandbox;
 * monitor events become available only after a concrete schedule is installed.
 */
public enum ScreenTimeCapabilityPolicy {
    public enum HostEnvironment: String {
        case device
        case simulator
    }

    public static var hostEnvironment: HostEnvironment {
        #if targetEnvironment(simulator)
        return .simulator
        #else
        return .device
        #endif
    }

    public static func availability(
        environment: HostEnvironment,
        provisioningSatisfied: Bool,
        provisioningInspected: Bool
    ) -> String {
        if environment == .simulator { return "simulator-unavailable" }
        if provisioningSatisfied { return "host-unavailable" }
        return provisioningInspected ? "provisioning-missing" : "provisioning-unknown"
    }

    public static func platformSupported(
        environment: HostEnvironment,
        provisioningSatisfied: Bool
    ) -> Bool {
        environment == .device && provisioningSatisfied
    }
    public static let unavailableReason =
        "Screen Time reports are unavailable because the host app has no DeviceActivity presenter."
    public static let authorizationRequestAvailable = false
    public static let reportAvailable = false
    public static let coarseSummaryAvailable = false
    public static let thresholdEventsAvailable = false
    public static let rawUsageExportAvailable = false
}
