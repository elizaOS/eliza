import XCTest
@testable import MobileSignalsHealthContract

/// Contract tests for ScreenTimeCapabilityPolicy.
///
/// These tests enforce the truthful capability boundary:
/// - coarseSummaryAvailable MUST be false (no lawful host producer exists)
/// - thresholdEventsAvailable MUST be false (no threshold scheduled/handled)
/// - reportAvailable is the ONLY capability that can be true today
final class ScreenTimeCapabilityPolicyTests: XCTestCase {

    // MARK: - Compile-time constant contract

    func testCoarseSummaryAvailableIsFalse() {
        XCTAssertFalse(ScreenTimeCapabilityPolicy.coarseSummaryAvailable,
            "coarseSummaryAvailable MUST be false: Apple's DeviceActivity privacy sandbox prevents category summaries from leaving the report extension. No lawful host-readable producer exists.")
    }

    func testThresholdEventsAvailableIsFalse() {
        XCTAssertFalse(ScreenTimeCapabilityPolicy.thresholdEventsAvailable,
            "thresholdEventsAvailable MUST be false: Bundling the monitor extension is insufficient. A typed threshold must be scheduled, persisted, and its callback implemented.")
    }

    func testRawUsageExportAvailableIsFalse() {
        XCTAssertFalse(ScreenTimeCapabilityPolicy.rawUsageExportAvailable,
            "rawUsageExportAvailable is permanently false by platform constraint.")
    }

    // MARK: - reportAvailable contract

    func testReportAvailableTrueWhenAuthorizedAndBundled() {
        XCTAssertTrue(ScreenTimeCapabilityPolicy.reportAvailable(
            extensionInspectionReport: true,
            authorizationStatus: "approved"
        ))
    }

    func testReportAvailableFalseWhenNotAuthorized() {
        XCTAssertFalse(ScreenTimeCapabilityPolicy.reportAvailable(
            extensionInspectionReport: true,
            authorizationStatus: "not-determined"
        ))
        XCTAssertFalse(ScreenTimeCapabilityPolicy.reportAvailable(
            extensionInspectionReport: true,
            authorizationStatus: "denied"
        ))
        XCTAssertFalse(ScreenTimeCapabilityPolicy.reportAvailable(
            extensionInspectionReport: true,
            authorizationStatus: "unavailable"
        ))
    }

    func testReportAvailableFalseWhenExtensionNotBundled() {
        XCTAssertFalse(ScreenTimeCapabilityPolicy.reportAvailable(
            extensionInspectionReport: false,
            authorizationStatus: "approved"
        ))
    }

    // MARK: - Policy immutability guard
    // If a future iOS release adds a lawful host-readable producer, the
    // constants above should be flipped AND this test updated accordingly.
    // This test exists to make any future change explicit and intentional.

    func testPolicyConstantsAreDocumentedAsIntentional() {
        // This test passes by virtue of the constants existing with the
        // documented rationale. If you change a constant, update the
        // corresponding test above and this guard.
        XCTAssertEqual(ScreenTimeCapabilityPolicy.coarseSummaryAvailable, false)
        XCTAssertEqual(ScreenTimeCapabilityPolicy.thresholdEventsAvailable, false)
        XCTAssertEqual(ScreenTimeCapabilityPolicy.rawUsageExportAvailable, false)
    }
}