// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ElizaosCapacitorSwabbleIOSContracts",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    targets: [
        .target(
            name: "SwabbleIOSContracts",
            path: "Sources/SwabbleBridgeContract"
        ),
        .testTarget(
            name: "SwabbleBridgeContractTests",
            dependencies: ["SwabbleIOSContracts"],
            path: "Tests/SwabbleBridgeContractTests"
        ),
    ]
)
