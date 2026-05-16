@testable import ElizaMacCore
import XCTest

final class ShellFeatureTests: XCTestCase {
    func testCoreSurfaceDefaultsArePresent() {
        XCTAssertFalse(ShellFeature.chatDefaults.isEmpty)
        XCTAssertFalse(ShellFeature.appDefaults.isEmpty)
        XCTAssertFalse(ShellFeature.pluginDefaults.isEmpty)
        XCTAssertFalse(ShellFeature.heartbeatDefaults.isEmpty)
        XCTAssertFalse(ShellFeature.lifeOpsDefaults.isEmpty)
        XCTAssertFalse(ShellFeature.healthDefaults.isEmpty)
        XCTAssertFalse(ShellFeature.browserDefaults.isEmpty)
        XCTAssertFalse(ShellFeature.cloudDefaults.isEmpty)
        XCTAssertFalse(ShellFeature.releaseDefaults.isEmpty)
    }

    func testDefaultFeatureIDsAreUniquePerSurface() {
        [
            ShellFeature.chatDefaults,
            ShellFeature.appDefaults,
            ShellFeature.pluginDefaults,
            ShellFeature.heartbeatDefaults,
            ShellFeature.lifeOpsDefaults,
            ShellFeature.healthDefaults,
            ShellFeature.browserDefaults,
            ShellFeature.cloudDefaults,
            ShellFeature.releaseDefaults
        ].forEach { features in
            XCTAssertEqual(Set(features.map(\.id)).count, features.count)
        }
    }

    func testFeatureDestinationsIncludeNativeSettingsAndRendererTargets() {
        XCTAssertTrue(ShellFeature.lifeOpsDefaults.contains { feature in
            feature.destination == .settings(.shell)
        })
        XCTAssertTrue(ShellFeature.cloudDefaults.contains { feature in
            feature.destination == .settings(.account)
        })
        XCTAssertTrue(ShellFeature.appDefaults.contains { feature in
            feature.destination == .rendererAppRoute("/apps/lifeops")
        })
        XCTAssertTrue(ShellFeature.appDefaults.contains { feature in
            feature.destination == .rendererAppRoute("/apps/plugins")
        })
        XCTAssertTrue(ShellFeature.pluginDefaults.contains { feature in
            feature.destination == .rendererAppRoute("/apps/runtime")
        })
        XCTAssertTrue(ShellFeature.pluginDefaults.contains { feature in
            feature.destination == .rendererAppRoute("/apps/model-tester")
        })
    }
}
