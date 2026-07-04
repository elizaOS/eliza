import XCTest

/// Widget/control gallery capture harness (issue #12185).
///
/// Drives SpringBoard (not the app) to open the Home Screen widget gallery and
/// the Control Center "Add a Control" gallery, searches for Eliza, and attaches
/// `.keepAlways` screenshots at every step so
/// `xcrun xcresulttool export attachments` yields the evidence filmstrip
/// (run via packages/app/scripts/ios-device-capture.mjs
/// --only-testing AppUITests/WidgetGalleryCaptureUITests).
///
/// SpringBoard's edit/gallery chrome differs across iOS majors, so each leg is
/// best-effort: it screenshots whatever state it reached instead of failing the
/// whole capture on a missing button. Requires the app (and therefore the
/// ElizaWidgets extension) to already be installed on the target simulator.
///
/// Signing gotcha: a `CODE_SIGNING_ALLOWED=NO` simulator build registers the
/// WIDGETS (static metadata) but the CONTROLS never appear in the gallery —
/// control enumeration launches the appex, and a fully unsigned appex faults
/// in XPC peer attribution (EXC_GUARD in `xpc_connection_copy_bundle_id`,
/// `ExcUserFault_ElizaWidgets` crash log). Build with at least ad-hoc signing
/// (`CODE_SIGNING_ALLOWED=YES CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=-`)
/// before capturing the control gallery.
final class WidgetGalleryCaptureUITests: XCTestCase {

    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    func testCaptureHomeScreenWidgetGallery() throws {
        goHome()
        attachScreenshot(named: "widget-00-home-screen")

        // Long-press an empty Home Screen spot to enter jiggle mode.
        springboard
            .coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
            .press(forDuration: 2.5)
        attachScreenshot(named: "widget-01-jiggle-mode")

        // iOS 18: Edit (top-left) → Add Widget. iOS 16/17: a direct "+".
        let edit = springboard.buttons["Edit"]
        if edit.waitForExistence(timeout: 5) {
            edit.tap()
            let addWidget = springboard.buttons["Add Widget"]
            if addWidget.waitForExistence(timeout: 5) {
                addWidget.tap()
            }
        } else {
            let legacyAdd = springboard.buttons["Add widget"]
            if legacyAdd.waitForExistence(timeout: 5) {
                legacyAdd.tap()
            }
        }
        Thread.sleep(forTimeInterval: 1.5)
        attachScreenshot(named: "widget-02-gallery")

        let search = springboard.searchFields.firstMatch
        if search.waitForExistence(timeout: 5) {
            search.tap()
            search.typeText("Eliza")
            Thread.sleep(forTimeInterval: 2)
            attachScreenshot(named: "widget-03-gallery-search-eliza")

            let appRow = springboard.staticTexts["elizaOS"].firstMatch
            if appRow.waitForExistence(timeout: 5) {
                // The result row is often "visible but not hittable" to XCUI's
                // hit-tester inside the gallery sheet; a coordinate tap works.
                appRow.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                Thread.sleep(forTimeInterval: 1.5)
                attachScreenshot(named: "widget-04-detail-small")

                // Page to the medium (5-action) family.
                springboard.swipeLeft()
                Thread.sleep(forTimeInterval: 1)
                attachScreenshot(named: "widget-05-detail-medium")

                let confirm = springboard.buttons[" Add Widget"].exists
                    ? springboard.buttons[" Add Widget"]
                    : springboard.buttons["Add Widget"]
                if confirm.waitForExistence(timeout: 5) {
                    confirm.tap()
                    Thread.sleep(forTimeInterval: 1.5)
                    XCUIDevice.shared.press(.home)
                    Thread.sleep(forTimeInterval: 1.5)
                    attachScreenshot(named: "widget-06-added-to-home")
                }
            }
        }
        attachAccessibilitySnapshot()
        goHome()
    }

    func testCaptureControlCenterGallery() throws {
        goHome()

        // Open Control Center: drag down from the top-right corner.
        let pull = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.02))
        pull.press(
            forDuration: 0.1,
            thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.6))
        )
        Thread.sleep(forTimeInterval: 1.5)
        attachScreenshot(named: "control-00-control-center")

        // iOS 18 edit mode: long-press the Control Center background, then
        // "Add a Control" opens the controls gallery.
        springboard
            .coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
            .press(forDuration: 2.0)
        Thread.sleep(forTimeInterval: 1)
        attachScreenshot(named: "control-01-edit-mode")

        let addControl = springboard.buttons["Add a Control"]
        if addControl.waitForExistence(timeout: 5) {
            addControl.tap()
        } else {
            // The edit chrome sometimes belongs to a different remote element
            // tree; the button sits at the bottom center either way.
            springboard
                .coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
                .tap()
        }
        Thread.sleep(forTimeInterval: 1.5)
        attachScreenshot(named: "control-02-gallery")

        let search = springboard.searchFields.firstMatch
        if search.waitForExistence(timeout: 5) {
            search.tap()
            search.typeText("Eliza")
            Thread.sleep(forTimeInterval: 2)
            attachScreenshot(named: "control-03-gallery-search-eliza")
        }
        attachAccessibilitySnapshot()
        goHome()
    }

    /// Runs last (alphabetically after the gallery legs, which place the
    /// widget): taps the "Ask" quick action on the home-screen widget and
    /// screenshots the app landing, proving the widget Link actually fires the
    /// `elizaos://assistant?source=ios-widget` deep link end to end.
    func testZDeepLinkFromHomeScreenWidget() throws {
        goHome()
        let ask = springboard.staticTexts["Ask"].firstMatch
        guard ask.waitForExistence(timeout: 5) else {
            attachScreenshot(named: "widget-tap-00-no-widget-on-home")
            throw XCTSkip("no Eliza widget on the home screen — run the gallery leg first")
        }
        attachScreenshot(named: "widget-tap-00-home-with-widget")
        ask.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        Thread.sleep(forTimeInterval: 8)
        attachScreenshot(named: "widget-tap-01-app-landing")
    }

    /// Legs run back-to-back and SpringBoard overlays (widget gallery sheet,
    /// Control Center edit mode, search keyboards) survive a single Home
    /// press, so dismiss any leftover chrome before starting a leg.
    private func goHome() {
        for _ in 0..<3 {
            let cancel = springboard.buttons["Cancel"]
            if cancel.exists, cancel.isHittable {
                cancel.tap()
                Thread.sleep(forTimeInterval: 0.8)
            }
            XCUIDevice.shared.press(.home)
            Thread.sleep(forTimeInterval: 1)
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

    private func attachAccessibilitySnapshot() {
        let attachment = XCTAttachment(string: springboard.debugDescription)
        attachment.name = "springboard-accessibility-tree"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
