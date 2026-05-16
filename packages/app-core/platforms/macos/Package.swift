// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ElizaMac",
    defaultLocalization: "en",
    platforms: [
        .macOS(.v26)
    ],
    products: [
        .executable(name: "ElizaMac", targets: ["ElizaMac"])
    ],
    targets: [
        .target(name: "ElizaMacCore"),
        .executableTarget(
            name: "ElizaMac",
            dependencies: ["ElizaMacCore"]
        ),
        .testTarget(
            name: "ElizaMacCoreTests",
            dependencies: ["ElizaMacCore"]
        )
    ],
    swiftLanguageModes: [.v5]
)
