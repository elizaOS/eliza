// swift-tools-version: 5.9
/**
 * Standalone executable proof for the iOS Browser owner and presentation
 * contract. CocoaPods compiles the contract beside the Capacitor plugin; this
 * package keeps its state semantics executable without a bridge host.
 */

import PackageDescription

let package = Package(
    name: "ElizaosCapacitorBrowserSurfaceIOSContracts",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    targets: [
        .target(
            name: "BrowserSurfaceLifecycleContract",
            path: "Sources/BrowserSurfaceLifecycleContract"
        ),
        .executableTarget(
            name: "BrowserSurfaceLifecycleContractProbe",
            dependencies: ["BrowserSurfaceLifecycleContract"],
            path: "Tests/BrowserSurfaceLifecycleContractTests"
        ),
    ]
)
