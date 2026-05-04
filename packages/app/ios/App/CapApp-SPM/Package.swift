// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.3.1"),
        .package(name: "CapacitorBarcodeScanner", path: "../../../../../../node_modules/.bun/@capacitor+barcode-scanner@3.0.2+2a604cb248d57ff2/node_modules/@capacitor/barcode-scanner"),
        .package(name: "CapacitorBrowser", path: "../../../../../../node_modules/.bun/@capacitor+browser@8.0.0+2a604cb248d57ff2/node_modules/@capacitor/browser"),
        .package(name: "CapacitorHaptics", path: "../../../../../../node_modules/.bun/@capacitor+haptics@8.0.2+2a604cb248d57ff2/node_modules/@capacitor/haptics"),
        .package(name: "CapacitorKeyboard", path: "../../../../../../node_modules/.bun/@capacitor+keyboard@8.0.3+2a604cb248d57ff2/node_modules/@capacitor/keyboard"),
        .package(name: "CapacitorPushNotifications", path: "../../../../../../node_modules/.bun/@capacitor+push-notifications@8.0.3+2a604cb248d57ff2/node_modules/@capacitor/push-notifications"),
        .package(name: "LlamaCppCapacitor", path: "../../../../../../node_modules/.bun/llama-cpp-capacitor@0.1.5+2a604cb248d57ff2/node_modules/llama-cpp-capacitor")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorBarcodeScanner", package: "CapacitorBarcodeScanner"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapacitorHaptics", package: "CapacitorHaptics"),
                .product(name: "CapacitorKeyboard", package: "CapacitorKeyboard"),
                .product(name: "CapacitorPushNotifications", package: "CapacitorPushNotifications"),
                .product(name: "LlamaCppCapacitor", package: "LlamaCppCapacitor")
            ]
        )
    ]
)
