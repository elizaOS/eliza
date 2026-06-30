// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ElizaosCapacitorTalkModeIOSContracts",
    platforms: [
        .iOS(.v13),
        .macOS(.v13),
    ],
    targets: [
        .target(
            name: "TalkModeIOSContracts",
            path: "Sources/TalkModeBridgeContract"
        ),
        .testTarget(
            name: "TalkModeBridgeContractTests",
            dependencies: ["TalkModeIOSContracts"],
            path: "Tests/TalkModeBridgeContractTests"
        ),
    ]
)
