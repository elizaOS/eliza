/**
 * Verifies the host-visible Screen Time capability policy independently of
 * entitlement availability and the DeviceActivity extension process.
 */
import XCTest
@testable import MobileSignalsHealthContract

final class ScreenTimeCapabilityPolicyTests: XCTestCase {
    func testHostDoesNotAdvertiseSandboxedOrUnimplementedData() {
        XCTAssertTrue(ScreenTimeCapabilityPolicy.reportAvailable(
            environment: .device,
            provisioning: .verified,
            authorizationApproved: true,
            reportExtensionBundled: true,
            presenterAvailable: true
        ))
        XCTAssertFalse(ScreenTimeCapabilityPolicy.coarseSummaryAvailable)
        XCTAssertFalse(ScreenTimeCapabilityPolicy.thresholdEventsAvailable)
        XCTAssertFalse(ScreenTimeCapabilityPolicy.rawUsageExportAvailable)
    }

    func testSimulatorAndMissingProvisioningFailClosed() {
        XCTAssertEqual(
            ScreenTimeCapabilityPolicy.availability(
                environment: .simulator,
                provisioning: .unknown,
                authorizationApproved: false,
                reportExtensionBundled: true,
                presenterAvailable: true
            ),
            "simulator-unavailable"
        )
        XCTAssertFalse(ScreenTimeCapabilityPolicy.platformSupported(
            environment: .simulator,
            provisioning: .verified
        ))
        XCTAssertEqual(
            ScreenTimeCapabilityPolicy.availability(
                environment: .device,
                provisioning: .missing,
                authorizationApproved: false,
                reportExtensionBundled: true,
                presenterAvailable: true
            ),
            "provisioning-missing"
        )
        XCTAssertFalse(ScreenTimeCapabilityPolicy.platformSupported(
            environment: .device,
            provisioning: .missing
        ))
    }

    func testUnknownPhysicalProvisioningRemainsRestrictedButSupported() {
        XCTAssertTrue(ScreenTimeCapabilityPolicy.platformSupported(
            environment: .device,
            provisioning: .unknown
        ))
        XCTAssertTrue(ScreenTimeCapabilityPolicy.authorizationRequestAvailable(
            environment: .device,
            provisioning: .unknown,
            reportExtensionBundled: true,
            presenterAvailable: true
        ))
        XCTAssertEqual(
            ScreenTimeCapabilityPolicy.availability(
                environment: .device,
                provisioning: .unknown,
                authorizationApproved: false,
                reportExtensionBundled: true,
                presenterAvailable: true
            ),
            "authorization-required"
        )
    }
}
