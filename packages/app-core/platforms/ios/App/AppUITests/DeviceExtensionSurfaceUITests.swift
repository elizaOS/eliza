import XCTest

/// Assert-level lane for iOS extension surfaces (#13695).
///
/// This suite is intentionally separate from WidgetGalleryCaptureUITests:
/// the capture harness keeps `continueAfterFailure = true` and only produces
/// screenshots, while this suite fails when an expected simulator-reachable
/// surface disappears. Hardware-only verification remains out of scope here:
/// Action Button physical press, device signing/profile faults, and custom
/// keyboard enablement still require the provisioned-device lane called out in
/// #13567/#13563.
final class DeviceExtensionSurfaceUITests: XCTestCase {

    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testControlCenterGalleryListsElizaControls() throws {
        guard #available(iOS 18.0, *) else {
            throw XCTSkip("Control Center controls are iOS 18+ only")
        }

        try openControlGalleryAndSearchEliza()

        XCTAssertTrue(
            springboard.staticTexts["Ask Eliza"].waitForExistence(timeout: 8),
            "Control Center gallery search must list the Ask Eliza control; a missing result means the ElizaWidgets appex/control registration path regressed."
        )
        XCTAssertTrue(
            springboard.staticTexts["Eliza Voice"].waitForExistence(timeout: 8),
            "Control Center gallery search must list the Eliza Voice control; a missing result means the ElizaWidgets appex/control registration path regressed."
        )

        attachAccessibilitySnapshot(named: "control-gallery-eliza-results")
        goHome()
    }

    func testHomeScreenWidgetTapForegroundsApp() throws {
        try installHomeScreenWidgetFromGallery()

        let ask = springboard.staticTexts["Ask Eliza"].firstMatch
        XCTAssertTrue(
            ask.waitForExistence(timeout: 8),
            "The Eliza home-screen widget must expose the Ask Eliza quick action after being added from the widget gallery."
        )

        attachScreenshot(named: "widget-assert-00-home-with-widget")
        ask.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()

        let app = XCUIApplication()
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 15),
            "Tapping the Ask quick action must foreground the container app via elizaos://assistant?source=ios-widget&action=ask."
        )
        attachScreenshot(named: "widget-assert-01-app-foregrounded")
    }

    func testKeyboardDictationSurfaceNeedsProvisionedDeviceLane() throws {
        throw XCTSkip(
            "Custom keyboard enablement, globe switching, Full Access/App Group round-trip, and textDocumentProxy insertion are device-lane verification items. Checklist: install signed app + ElizaKeyboard appex, enable Settings > General > Keyboard > ElizaKeyboard with Full Access, focus a text field, switch via globe, tap Dictate with Eliza, write recording/transcribing/ready/error records through the ElizaKeyboard bridge, then assert inserted/failed/needsFullAccess states."
        )
    }

    // MARK: - Control Center controls

    @available(iOS 18.0, *)
    private func openControlGalleryAndSearchEliza() throws {
        goHome()

        let pull = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.02))
        pull.press(
            forDuration: 0.1,
            thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.6))
        )
        Thread.sleep(forTimeInterval: 1.5)
        attachScreenshot(named: "control-assert-00-control-center")

        springboard
            .coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
            .press(forDuration: 2.0)
        Thread.sleep(forTimeInterval: 1.0)
        attachScreenshot(named: "control-assert-01-edit-mode")

        let addControl = springboard.buttons["Add a Control"]
        if addControl.waitForExistence(timeout: 5) {
            addControl.tap()
        } else {
            springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)).tap()
        }
        Thread.sleep(forTimeInterval: 1.5)
        attachScreenshot(named: "control-assert-02-gallery")

        let search = springboard.searchFields.firstMatch
        XCTAssertTrue(
            search.waitForExistence(timeout: 8),
            "Control Center add-control gallery must expose a search field before Eliza controls can be asserted."
        )
        search.tap()
        search.typeText("Eliza")
        Thread.sleep(forTimeInterval: 2.0)
        attachScreenshot(named: "control-assert-03-gallery-search-eliza")
    }

    // MARK: - Home/Lock Screen widget

    private func installHomeScreenWidgetFromGallery() throws {
        goHome()
        attachScreenshot(named: "widget-assert-00-home-screen")

        springboard
            .coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
            .press(forDuration: 2.5)
        Thread.sleep(forTimeInterval: 1.0)
        attachScreenshot(named: "widget-assert-01-jiggle-mode")

        let edit = springboard.buttons["Edit"]
        if edit.waitForExistence(timeout: 5) {
            edit.tap()
            let addWidget = springboard.buttons["Add Widget"]
            XCTAssertTrue(addWidget.waitForExistence(timeout: 5), "Edit menu must expose Add Widget")
            addWidget.tap()
        } else {
            let legacyAdd = springboard.buttons["Add widget"]
            XCTAssertTrue(legacyAdd.waitForExistence(timeout: 5), "Home Screen edit mode must expose the widget gallery add affordance")
            legacyAdd.tap()
        }

        Thread.sleep(forTimeInterval: 1.5)
        let search = springboard.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 8), "Widget gallery must expose a search field")
        search.tap()
        search.typeText("Eliza")
        Thread.sleep(forTimeInterval: 2.0)
        attachScreenshot(named: "widget-assert-02-gallery-search-eliza")

        let appRow = springboard.staticTexts["elizaOS"].firstMatch
        XCTAssertTrue(appRow.waitForExistence(timeout: 8), "Widget gallery search must list elizaOS")
        appRow.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        Thread.sleep(forTimeInterval: 1.5)
        attachScreenshot(named: "widget-assert-03-detail")

        let confirm = springboard.buttons[" Add Widget"].exists
            ? springboard.buttons[" Add Widget"]
            : springboard.buttons["Add Widget"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 8), "Eliza widget detail must expose Add Widget")
        confirm.tap()
        Thread.sleep(forTimeInterval: 1.5)
        goHome()
    }

    // MARK: - Shared helpers

    private func goHome() {
        for _ in 0..<3 {
            let cancel = springboard.buttons["Cancel"]
            if cancel.exists, cancel.isHittable {
                cancel.tap()
                Thread.sleep(forTimeInterval: 0.8)
            }
            XCUIDevice.shared.press(.home)
            Thread.sleep(forTimeInterval: 1.0)
        }
        springboard.activate()
        _ = springboard.wait(for: .runningForeground, timeout: 10)
    }

    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attachAccessibilitySnapshot(named name: String) {
        let attachment = XCTAttachment(string: springboard.debugDescription)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
