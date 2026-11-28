// swift-tools-version: 5.9
import PackageDescription

// Test-only manifest (same layout as plugin-native-swabble / -talkmode): the
// CocoaPods build compiles everything under ios/Sources/** into the plugin,
// while this package builds just the platform-agnostic health contract so
// `swift test` can run the entitlement-gate tests on macOS.
let package = Package(
    name: "ElizaosCapacitorMobileSignalsIOSContracts",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    targets: [
        .target(
            name: "MobileSignalsHealthContract",
            path: "Sources/MobileSignalsHealthContract"
        ),
        .testTarget(
            name: "MobileSignalsHealthContractTests",
            dependencies: ["MobileSignalsHealthContract"],
            path: "Tests/MobileSignalsHealthContractTests"
        ),
    ]
)
