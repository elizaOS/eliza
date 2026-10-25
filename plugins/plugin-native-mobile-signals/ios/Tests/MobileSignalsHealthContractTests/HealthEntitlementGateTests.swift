/**
 * Verifies that only the exact canonical plist marker authorizes HealthKit.
 */
import XCTest
@testable import MobileSignalsHealthContract

final class HealthEntitlementGateTests: XCTestCase {
    func testMissingEmptyAndZeroMarkersDisableHealthKit() {
        for value: Any? in [nil, "", "0"] {
            let access = HealthEntitlementGate.resolve(plistValue: value)
            XCTAssertEqual(access, .disabled)
            XCTAssertFalse(access.allowsHealthKitCalls)
            XCTAssertNotNil(access.unavailableReason)
        }
    }

    func testOnlyExactOneEnablesHealthKit() {
        let access = HealthEntitlementGate.resolve(plistValue: "1")
        XCTAssertEqual(access, .enabled)
        XCTAssertTrue(access.allowsHealthKitCalls)
        XCTAssertNil(access.unavailableReason)
    }

    func testWhitespaceAndBooleanLikeValuesFailClosed() {
        for value: Any in [" 1 ", "true", "yes", "01", true, 1] {
            let access = HealthEntitlementGate.resolve(plistValue: value)
            XCTAssertEqual(access, .malformed)
            XCTAssertFalse(access.allowsHealthKitCalls)
            XCTAssertNotNil(access.unavailableReason)
        }
    }
}
