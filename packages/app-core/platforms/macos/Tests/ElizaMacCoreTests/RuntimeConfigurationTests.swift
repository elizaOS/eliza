import Foundation
@testable import ElizaMacCore
import XCTest

final class RuntimeConfigurationTests: XCTestCase {
    func testBuildsDefaultLocalURLs() {
        let configuration = RuntimeConfiguration(repositoryRoot: "/repo")

        XCTAssertEqual(configuration.apiBaseURL, URL(string: "http://127.0.0.1:31337"))
        XCTAssertEqual(configuration.rendererURL, URL(string: "http://127.0.0.1:2138"))
    }

    func testExternalAPIBaseOverridesLocalPort() throws {
        let external = try XCTUnwrap(URL(string: "http://127.0.0.1:4000"))
        let configuration = RuntimeConfiguration(
            repositoryRoot: "/repo",
            apiPort: 31337,
            uiPort: 2138,
            launchMode: .external,
            externalAPIBaseURL: external
        )

        XCTAssertEqual(configuration.apiBaseURL, external)
    }

    func testDefaultConfigurationPrefersRepositoryArgument() {
        let configuration = RuntimeConfiguration.defaultConfiguration(
            arguments: ["ElizaMac", "--eliza-repository-root", "/workspace/eliza"],
            environment: ["ELIZA_REPOSITORY_ROOT": "/env/eliza"]
        )

        XCTAssertEqual(configuration.repositoryRoot, "/workspace/eliza")
    }

    func testDefaultConfigurationReadsRepositoryEnvironment() {
        let configuration = RuntimeConfiguration.defaultConfiguration(
            arguments: ["ElizaMac"],
            environment: ["ELIZA_REPOSITORY_ROOT": "/env/eliza"]
        )

        XCTAssertEqual(configuration.repositoryRoot, "/env/eliza")
    }
}
