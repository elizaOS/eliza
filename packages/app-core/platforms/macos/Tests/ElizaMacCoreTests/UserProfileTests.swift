@testable import ElizaMacCore
import XCTest

final class UserProfileTests: XCTestCase {
    func testNormalizesDisplayNameWhitespace() {
        let profile = UserProfile(displayName: "  Ada   Lovelace  ")

        XCTAssertEqual(profile.displayName, "Ada Lovelace")
        XCTAssertTrue(profile.hasDisplayName)
    }

    func testCapsDisplayNameLength() {
        let profile = UserProfile(displayName: String(repeating: "a", count: 80))

        XCTAssertEqual(profile.displayName.count, 64)
    }

    func testAnonymousProfileHasNoDisplayName() {
        XCTAssertFalse(UserProfile.anonymous.hasDisplayName)
    }
}
