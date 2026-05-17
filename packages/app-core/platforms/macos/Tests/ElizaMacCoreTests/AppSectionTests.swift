@testable import ElizaMacCore
import XCTest

final class AppSectionTests: XCTestCase {
    func testPrimarySectionsAreRegistered() {
        XCTAssertTrue(AppSection.allCases.contains(.dashboard))
        XCTAssertTrue(AppSection.allCases.contains(.chat))
        XCTAssertTrue(AppSection.allCases.contains(.agents))
        XCTAssertTrue(AppSection.allCases.contains(.plugins))
        XCTAssertTrue(AppSection.allCases.contains(.connectors))
        XCTAssertTrue(AppSection.allCases.contains(.heartbeats))
        XCTAssertTrue(AppSection.allCases.contains(.lifeOps))
        XCTAssertTrue(AppSection.allCases.contains(.health))
        XCTAssertTrue(AppSection.allCases.contains(.wallets))
        XCTAssertTrue(AppSection.allCases.contains(.browser))
        XCTAssertTrue(AppSection.allCases.contains(.cloud))
        XCTAssertTrue(AppSection.allCases.contains(.release))
        XCTAssertTrue(AppSection.allCases.contains(.diagnostics))
        XCTAssertEqual(Set(AppSection.allCases.map(\.id)).count, AppSection.allCases.count)
    }
}
