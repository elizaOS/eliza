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

    public enum ProvisioningState: String {
        case verified
        case unknown
        case missing
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
        provisioning: ProvisioningState,
        authorizationApproved: Bool,
        reportExtensionBundled: Bool,
        presenterAvailable: Bool
    ) -> String {
        if environment == .simulator { return "simulator-unavailable" }
        if provisioning == .missing { return "provisioning-missing" }
        if !reportExtensionBundled { return "extension-missing" }
        if !presenterAvailable { return "presenter-missing" }
        if !authorizationApproved { return "authorization-required" }
        return "report-available"
    }

    public static func platformSupported(
        environment: HostEnvironment,
        provisioning: ProvisioningState
    ) -> Bool {
        environment == .device && provisioning != .missing
    }

    public static func authorizationRequestAvailable(
        environment: HostEnvironment,
        provisioning: ProvisioningState,
        reportExtensionBundled: Bool,
        presenterAvailable: Bool
    ) -> Bool {
        platformSupported(environment: environment, provisioning: provisioning)
            && reportExtensionBundled
            && presenterAvailable
    }

    public static func reportAvailable(
        environment: HostEnvironment,
        provisioning: ProvisioningState,
        authorizationApproved: Bool,
        reportExtensionBundled: Bool,
        presenterAvailable: Bool
    ) -> Bool {
        authorizationRequestAvailable(
            environment: environment,
            provisioning: provisioning,
            reportExtensionBundled: reportExtensionBundled,
            presenterAvailable: presenterAvailable
        ) && authorizationApproved
    }

    public static let coarseSummaryAvailable = false
    public static let thresholdEventsAvailable = false
    public static let rawUsageExportAvailable = false
}
