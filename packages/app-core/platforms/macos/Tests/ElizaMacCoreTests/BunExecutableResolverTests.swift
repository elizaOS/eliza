@testable import ElizaMacCore
import XCTest

final class BunExecutableResolverTests: XCTestCase {
    func testFallsBackToEnvWhenNoCandidateExists() {
        let path = BunExecutableResolver.resolve(
            environment: [
                "HOME": "/no/such/home",
                "BUN_INSTALL": "/no/such/bun"
            ]
        )

        XCTAssertEqual(path, "/usr/bin/env")
    }
}
