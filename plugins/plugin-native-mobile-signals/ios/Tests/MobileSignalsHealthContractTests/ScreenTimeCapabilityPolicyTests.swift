/**
 * Verifies the deterministic iOS Screen Time capability policy without Apple framework mocks.
 */
import XCTest
@testable import MobileSignalsHealthContract

final class ScreenTimeCapabilityPolicyTests: XCTestCase {
    func testAuthorizedBundledReportEnablesOnlyTheReportSurface() {
        let status = ScreenTimeCapabilityPolicy.status(
            reportExtensionAvailable: true,
            authorizationStatus: "approved"
        )

        XCTAssertTrue(status.reportAvailable)
        XCTAssertFalse(status.coarseSummaryAvailable)
        XCTAssertFalse(status.thresholdEventsAvailable)
        XCTAssertFalse(status.rawUsageExportAvailable)
    }

    func testReportRequiresBothAuthorizationAndTheBundledExtension() {
        XCTAssertFalse(
            ScreenTimeCapabilityPolicy.status(
                reportExtensionAvailable: false,
                authorizationStatus: "approved"
            ).reportAvailable
        )

        for authorizationStatus in ["denied", "not-determined", "unavailable"] {
            XCTAssertFalse(
                ScreenTimeCapabilityPolicy.status(
                    reportExtensionAvailable: true,
                    authorizationStatus: authorizationStatus
                ).reportAvailable,
                "Unexpected report capability for \(authorizationStatus)"
            )
        }
    }

    func testHostReadableCapabilitiesRemainUnavailableForEveryInput() {
        for reportExtensionAvailable in [false, true] {
            for authorizationStatus in ["approved", "denied", "not-determined", "unavailable"] {
                let status = ScreenTimeCapabilityPolicy.status(
                    reportExtensionAvailable: reportExtensionAvailable,
                    authorizationStatus: authorizationStatus
                )

                XCTAssertFalse(status.coarseSummaryAvailable)
                XCTAssertFalse(status.thresholdEventsAvailable)
                XCTAssertFalse(status.rawUsageExportAvailable)
            }
        }
    }
}
