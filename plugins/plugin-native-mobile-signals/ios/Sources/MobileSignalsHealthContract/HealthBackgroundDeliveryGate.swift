import Foundation

/// Pure decision logic for the HealthKit background-delivery entitlement gate.
///
/// iOS exposes no public API to read the running binary's code-signing
/// entitlements, so `MobileSignalsPlugin.enableHealthBackgroundDelivery()`
/// uses its FIRST `enableBackgroundDelivery` call as the capability probe.
/// When the binary is not signed with `com.apple.developer.healthkit`
/// (simulator lanes built with code signing disabled, sideload/dev builds
/// signed without the capability) every call fails identically with
/// "Missing com.apple.developer.healthkit entitlement." — so the probe
/// failing that way must collapse to a single info line and skip the
/// remaining registrations instead of warning once per sample type.
///
/// Platform-agnostic (Foundation only) so `swift test` covers it on macOS —
/// same layout as the swabble/talkmode bridge-contract targets.
public enum HealthBackgroundDeliveryGate {
    /// What the caller must do after the probe registration completes.
    public enum ProbeOutcome: Equatable {
        /// Binary lacks the HealthKit entitlement: emit ONE info line and
        /// skip every remaining background-delivery registration.
        case entitlementMissing
        /// Probe failed for a type-specific reason: log that one failure,
        /// then continue registering the remaining types (they may succeed).
        case probeFailed
        /// Probe succeeded: register the remaining types.
        case succeeded
    }

    /// True when a HealthKit `enableBackgroundDelivery` error message means
    /// the binary is not signed with `com.apple.developer.healthkit`. The
    /// message is the only stable discriminator across iOS releases (the
    /// HKError code overlaps with unrelated authorization failures), so match
    /// the entitlement identifier in it.
    public static func isMissingHealthKitEntitlementMessage(_ message: String?) -> Bool {
        guard let message else { return false }
        return message.range(
            of: "com.apple.developer.healthkit entitlement",
            options: .caseInsensitive
        ) != nil
    }

    /// Classify the probe registration result.
    public static func probeOutcome(success: Bool, errorMessage: String?) -> ProbeOutcome {
        if success { return .succeeded }
        if isMissingHealthKitEntitlementMessage(errorMessage) { return .entitlementMissing }
        return .probeFailed
    }
}
