/**
 * Verifies the host-visible Screen Time capability policy independently of
 * entitlement availability and the DeviceActivity extension process.
 */
import XCTest
@testable import MobileSignalsHealthContract

final class ScreenTimeCapabilityPolicyTests: XCTestCase {
    func testHostDoesNotAdvertiseSandboxedOrUnimplementedData() {
        XCTAssertFalse(ScreenTimeCapabilityPolicy.unavailableReason.isEmpty)
        XCTAssertTrue(ScreenTimeCapabilityPolicy.unavailableReason.contains("no DeviceActivity presenter"))
        XCTAssertFalse(ScreenTimeCapabilityPolicy.authorizationRequestAvailable)
        XCTAssertFalse(ScreenTimeCapabilityPolicy.reportAvailable)
        XCTAssertFalse(ScreenTimeCapabilityPolicy.coarseSummaryAvailable)
        XCTAssertFalse(ScreenTimeCapabilityPolicy.thresholdEventsAvailable)
        XCTAssertFalse(ScreenTimeCapabilityPolicy.rawUsageExportAvailable)
    }
}
