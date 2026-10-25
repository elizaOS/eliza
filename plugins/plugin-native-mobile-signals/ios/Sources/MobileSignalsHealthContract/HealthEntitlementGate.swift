/**
 * Resolves the canonical native build marker that authorizes HealthKit calls.
 *
 * The app build writes this marker only when its signed configuration is
 * expected to include HealthKit. Disabled or malformed values fail closed so
 * unsigned Simulator and development builds never probe protected APIs.
 */
import Foundation

public enum HealthEntitlementGate {
    public static let infoPlistKey = "ELIZA_HEALTHKIT_ENABLED"

    public enum Access: Equatable {
        case enabled
        case disabled
        case malformed

        public var allowsHealthKitCalls: Bool {
            self == .enabled
        }

        public var unavailableReason: String? {
            switch self {
            case .enabled:
                return nil
            case .disabled:
                return "HealthKit is unavailable because this app build does not enable the HealthKit capability."
            case .malformed:
                return "HealthKit is unavailable because this app build has an invalid HealthKit capability marker."
            }
        }
    }

    public static func resolve(plistValue: Any?) -> Access {
        guard let plistValue else { return .disabled }
        guard let value = plistValue as? String else { return .malformed }
        switch value {
        case "1":
            return .enabled
        case "", "0":
            return .disabled
        default:
            return .malformed
        }
    }
}
