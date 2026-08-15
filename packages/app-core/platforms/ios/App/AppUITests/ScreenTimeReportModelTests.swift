/**
 * Executes the private Screen Time report reducer and formatter without
 * requesting Family Controls authorization or exporting activity data.
 */
import XCTest

final class ScreenTimeReportModelTests: XCTestCase {
    func testSubMinuteDurationIsNotRoundedUp() {
        XCTAssertEqual(
            ScreenTimeReportModel.formatDuration(
                59,
                locale: Locale(identifier: "en_US"),
                lessThanMinute: "Less than a minute"
            ),
            "Less than a minute"
        )
        let oneMinute = ScreenTimeReportModel.formatDuration(
            60,
            locale: Locale(identifier: "en_US"),
            lessThanMinute: "Less than a minute"
        )
        XCTAssertNotEqual(oneMinute, "Less than a minute")
        XCTAssertTrue(oneMinute.contains("1"))
    }

    func testTopCategoriesArePositiveOrderedAndBounded() {
        let result = ScreenTimeReportModel.topCategories(from: [
            "Work": 300,
            "Social": 180,
            "Audio": 180,
            "Travel": 60,
            "Reading": 30,
            "Games": 10,
            "Ignored": 0,
        ])

        XCTAssertEqual(result.map(\.name), ["Work", "Audio", "Social", "Travel", "Reading"])
        XCTAssertEqual(result.map(\.duration), [300, 180, 180, 60, 30])
    }
}
