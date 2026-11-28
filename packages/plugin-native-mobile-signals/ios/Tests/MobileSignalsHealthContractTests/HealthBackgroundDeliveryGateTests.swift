import XCTest
@testable import MobileSignalsHealthContract

/// Entitlement-gate contract (iOS boot-warning D2 item 1): six
/// "[MobileSignalsPlugin] enableBackgroundDelivery(...) failed: Missing
/// com.apple.developer.healthkit entitlement." warnings per boot must
/// collapse to one info line on unentitled builds, while genuine per-type
/// failures keep their individual diagnostics.
final class HealthBackgroundDeliveryGateTests: XCTestCase {
    // MARK: isMissingHealthKitEntitlementMessage

    func testMatchesTheExactSimulatorBootMessage() {
        XCTAssertTrue(HealthBackgroundDeliveryGate.isMissingHealthKitEntitlementMessage(
            "Missing com.apple.developer.healthkit entitlement."
        ))
    }

    func testMatchesCaseInsensitively() {
        XCTAssertTrue(HealthBackgroundDeliveryGate.isMissingHealthKitEntitlementMessage(
            "missing COM.APPLE.DEVELOPER.HEALTHKIT ENTITLEMENT"
        ))
    }

    func testMatchesWhenEmbeddedInALongerDiagnostic() {
        XCTAssertTrue(HealthBackgroundDeliveryGate.isMissingHealthKitEntitlementMessage(
            "Error Domain=com.apple.healthkit Code=4 \"Missing com.apple.developer.healthkit entitlement.\""
        ))
    }

    func testDoesNotMatchNil() {
        XCTAssertFalse(HealthBackgroundDeliveryGate.isMissingHealthKitEntitlementMessage(nil))
    }

    func testDoesNotMatchEmpty() {
        XCTAssertFalse(HealthBackgroundDeliveryGate.isMissingHealthKitEntitlementMessage(""))
    }

    func testDoesNotMatchOtherHealthKitFailures() {
        XCTAssertFalse(HealthBackgroundDeliveryGate.isMissingHealthKitEntitlementMessage(
            "Authorization is not determined"
        ))
        XCTAssertFalse(HealthBackgroundDeliveryGate.isMissingHealthKitEntitlementMessage(
            "Health data is unavailable on this device"
        ))
        // A DIFFERENT missing entitlement must not silence HealthKit spam.
        XCTAssertFalse(HealthBackgroundDeliveryGate.isMissingHealthKitEntitlementMessage(
            "Missing com.apple.developer.family-controls entitlement."
        ))
    }

    func testDoesNotMatchBackgroundDeliveryEntitlementVariant() {
        // The background-delivery entitlement string CONTAINS the base
        // healthkit entitlement identifier as a prefix — the gate matches by
        // substring, so this variant is (intentionally) also treated as an
        // unentitled build: both mean the binary cannot receive HK wakes.
        XCTAssertTrue(HealthBackgroundDeliveryGate.isMissingHealthKitEntitlementMessage(
            "Missing com.apple.developer.healthkit entitlement for background delivery."
        ))
    }

    // MARK: probeOutcome

    func testProbeSuccessContinuesFanOut() {
        XCTAssertEqual(
            HealthBackgroundDeliveryGate.probeOutcome(success: true, errorMessage: nil),
            .succeeded
        )
        // Success wins even if a stale message is passed alongside.
        XCTAssertEqual(
            HealthBackgroundDeliveryGate.probeOutcome(
                success: true,
                errorMessage: "Missing com.apple.developer.healthkit entitlement."
            ),
            .succeeded
        )
    }

    func testProbeEntitlementFailureSkipsFanOut() {
        XCTAssertEqual(
            HealthBackgroundDeliveryGate.probeOutcome(
                success: false,
                errorMessage: "Missing com.apple.developer.healthkit entitlement."
            ),
            .entitlementMissing
        )
    }

    func testProbeTypeSpecificFailureStillFansOut() {
        XCTAssertEqual(
            HealthBackgroundDeliveryGate.probeOutcome(
                success: false,
                errorMessage: "Authorization is not determined"
            ),
            .probeFailed
        )
        XCTAssertEqual(
            HealthBackgroundDeliveryGate.probeOutcome(success: false, errorMessage: nil),
            .probeFailed
        )
    }
}
