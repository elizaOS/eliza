// swift-tools-version: 5.9
/**
 * Standalone checks for the shared iOS Browser identity predicate. CocoaPods
 * compiles the same predicate beside the Capacitor plugin; this package tests
 * its matching rules without a bridge host.
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
