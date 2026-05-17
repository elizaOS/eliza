@testable import ElizaMacCore
import XCTest

final class RuntimeCommandBuilderTests: XCTestCase {
    func testBuildsLocalRuntimeStartCommand() {
        let configuration = RuntimeConfiguration(
            repositoryRoot: "/repo",
            apiPort: 31337,
            uiPort: 2138,
            launchMode: .local
        )

        let command = RuntimeCommandBuilder.startCommand(
            configuration: configuration,
            bunExecutable: "/opt/homebrew/bin/bun"
        )

        XCTAssertEqual(command.executable, "/opt/homebrew/bin/bun")
        XCTAssertEqual(command.arguments, ["run", "start"])
        XCTAssertEqual(command.workingDirectory, "/repo")
        XCTAssertEqual(command.environment["ELIZA_API_PORT"], "31337")
        XCTAssertEqual(command.environment["ELIZA_PORT"], "2138")
        XCTAssertEqual(command.environment["ELIZA_UI_PORT"], "2138")
        XCTAssertEqual(command.environment["ELIZA_DESKTOP_API_BASE"], "http://127.0.0.1:31337")
        XCTAssertEqual(command.environment["ELIZA_RENDERER_URL"], "http://127.0.0.1:2138")
        XCTAssertEqual(command.environment["ELIZA_NAMESPACE"], "eliza")
    }

    func testBuildsEnvFallbackCommand() {
        let configuration = RuntimeConfiguration(repositoryRoot: "/repo")
        let command = RuntimeCommandBuilder.startCommand(
            configuration: configuration,
            bunExecutable: "/usr/bin/env"
        )

        XCTAssertEqual(command.executable, "/usr/bin/env")
        XCTAssertEqual(command.arguments, ["bun", "run", "start"])
    }

    func testAddsUserNameEnvironmentWhenConfigured() {
        let configuration = RuntimeConfiguration(
            repositoryRoot: "/repo",
            userName: " Ada Lovelace "
        )

        let command = RuntimeCommandBuilder.startCommand(
            configuration: configuration,
            bunExecutable: "/opt/homebrew/bin/bun"
        )

        XCTAssertEqual(command.environment["ELIZA_USER_NAME"], "Ada Lovelace")
        XCTAssertEqual(command.environment["ELIZA_PROFILE_NAME"], "Ada Lovelace")
    }
}
