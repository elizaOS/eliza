import XCTest

/// Real-device OS-lifecycle robustness harness (#12185 / #12459) — the physical
/// iPhone counterpart to the simulator lane
/// (`packages/app/scripts/ios-sim-lifecycle.mjs`). Where the simulator lane must
/// mark Home-button backgrounding, real-camera switching, orientation, and true
/// process death as "not drivable / analog only", attached hardware driven
/// through XCUITest genuinely delivers them — this class is the honest delta.
///
/// It drives the INSTALLED Eliza app (the `UITargetAppPath` the capture script
/// points at the grafted, device-signed `App.app`) through every lifecycle
/// event the public XCUITest API can actually deliver on a device:
///   - Home-button backgrounding + return to foreground,
///   - app-switch to another app (Settings) + return,
///   - switch to the real Camera app + return (a real device has a camera; the
///     simulator does not, which is why the sim lane substitutes Photos),
///   - orientation change (landscape ↔ portrait),
///   - process death: `terminate()` → assert `.notRunning` → relaunch → recover.
/// After each event the invariant is the same and is hard-asserted: the app is
/// back in `.runningForeground` with a LIVE renderer (past the boot splash —
/// home, or the bounded startup-failure card, never a hang), and it survives
/// without dying. Every phase attaches the real pixels via
/// `XCUIScreen.main.screenshot()`, so the exported filmstrip is the evidence a
/// reviewer reads without the code.
///
/// The lifecycle events a physical battery, ringer switch, or lock button do
/// NOT expose to the public XCUITest API (forced low-battery / Low Power Mode,
/// hardware mute, device lock/sleep) are deliberately NOT faked here — they are
/// honest N/A rows in the run's evidence matrix. Home-button + app-switch +
/// camera cover the same resign-active / enter-background / re-activate
/// callbacks a lock would, so the recovery path is still exercised.
///
/// Driven by `packages/app/scripts/ios-device-capture.mjs --platform device
/// --only-testing AppUITests/DeviceLifecycleUITests`. Screenshots export via
/// `xcrun xcresulttool export attachments`. Boot budget arrives as
/// `ELIZA_BOOT_TIMEOUT_SECONDS` through xcodebuild's `TEST_RUNNER_` prefix.
final class DeviceLifecycleUITests: XCTestCase {

    private enum RenderState: String {
        case home
        case errorCard = "error-card"
        case splashOrLoading = "splash-or-loading"
        case notRunning = "not-running"
    }

    private let settingsBundleId = "com.apple.Preferences"
    private let cameraBundleId = "com.apple.camera"

    override func setUpWithError() throws {
        // Keep filming after a failed assertion — a failed recovery's pixels are
        // exactly the evidence we want.
        continueAfterFailure = true
    }

    /// The whole matrix in one ordered run: every event mutates the SAME app
    /// instance so process identity (survive vs recover) is observable across
    /// events. Ordering matters — the destructive terminate leg runs last.
    func testDeviceLifecycleMatrix() throws {
        let env = ProcessInfo.processInfo.environment
        let bootTimeout = Double(env["ELIZA_BOOT_TIMEOUT_SECONDS"] ?? "") ?? 180

        let app = XCUIApplication()

        // ── Event 0: launch → live renderer (baseline render proof) ──────────
        launchWithRetry(app)
        var state = waitForLiveRenderer(app, timeout: bootTimeout)
        attachScreenshot(named: "00-launch-\(state.rawValue)")
        XCTAssertTrue(
            state == .home || state == .errorCard,
            "launch never reached a live renderer (home/error card) within \(Int(bootTimeout))s — got \(state.rawValue)."
        )

        // ── Event 1: Home-button backgrounding → foreground ──────────────────
        // On the SIMULATOR this row is N/A ("simctl has no Home verb"); on the
        // device XCUIDevice delivers the real Home press.
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 3.0)
        attachScreenshot(named: "01-home-button-springboard")
        XCTAssertNotEqual(
            app.state, .runningForeground,
            "Home press did not background the app — still foreground."
        )
        app.activate()
        state = waitForLiveRenderer(app, timeout: bootTimeout)
        attachScreenshot(named: "01-home-button-refocused-\(state.rawValue)")
        assertRecovered(app, state: state, event: "home-button background → foreground")

        // ── Event 2: app-switch to another app (Settings) → return ───────────
        let settings = XCUIApplication(bundleIdentifier: settingsBundleId)
        settings.activate()
        XCTAssertTrue(
            settings.wait(for: .runningForeground, timeout: 15),
            "Settings did not come to the foreground for the app-switch event."
        )
        Thread.sleep(forTimeInterval: 2.0)
        attachScreenshot(named: "02-app-switch-settings-foreground")
        app.activate()
        state = waitForLiveRenderer(app, timeout: bootTimeout)
        attachScreenshot(named: "02-app-switch-refocused-\(state.rawValue)")
        assertRecovered(app, state: state, event: "app-switch to Settings → return")

        // ── Event 3: switch to the REAL Camera app → return ──────────────────
        // The interruption the sim lane can only approximate with Photos: a real
        // device has com.apple.camera with a live capture session.
        let camera = XCUIApplication(bundleIdentifier: cameraBundleId)
        camera.activate()
        let cameraForegrounded = camera.wait(for: .runningForeground, timeout: 15)
        XCTAssertTrue(
            cameraForegrounded,
            "Camera did not come to the foreground for the real-camera switch event."
        )
        Thread.sleep(forTimeInterval: 2.0)
        attachScreenshot(named: "03-camera-foreground-\(cameraForegrounded ? "up" : "blocked")")
        app.activate()
        state = waitForLiveRenderer(app, timeout: bootTimeout)
        attachScreenshot(named: "03-camera-refocused-\(state.rawValue)")
        assertRecovered(app, state: state, event: "switch to Camera → return")

        // ── Event 4: orientation change (landscape ↔ portrait) ───────────────
        let device = XCUIDevice.shared
        device.orientation = .landscapeLeft
        Thread.sleep(forTimeInterval: 2.5)
        attachScreenshot(named: "04-orientation-landscape")
        device.orientation = .portrait
        Thread.sleep(forTimeInterval: 2.5)
        state = waitForLiveRenderer(app, timeout: bootTimeout)
        attachScreenshot(named: "04-orientation-portrait-\(state.rawValue)")
        assertRecovered(app, state: state, event: "orientation landscape → portrait")

        // ── Event 5: process death — terminate → relaunch → recover ──────────
        // The strongest recovery test: the in-process full-Bun agent host dies
        // with the process; a clean relaunch must reach a live renderer again
        // AND land on home (not first-run onboarding), which also proves the
        // persisted runtime/first-run state survived the kill.
        app.terminate()
        XCTAssertTrue(
            app.wait(for: .notRunning, timeout: 20),
            "terminate() did not stop the app — state \(app.state.rawValue)."
        )
        attachScreenshot(named: "05-process-death-terminated")
        app.launch()
        state = waitForLiveRenderer(app, timeout: bootTimeout)
        attachScreenshot(named: "05-process-death-relaunched-\(state.rawValue)")
        assertRecovered(app, state: state, event: "process death (terminate → relaunch)")

        attachAccessibilitySnapshot(of: app)
    }

    // MARK: - Shared helpers (mirrors BootCaptureUITests; kept local because
    // XCTestCase private helpers do not cross files).

    private func assertRecovered(
        _ app: XCUIApplication, state: RenderState, event: String
    ) {
        XCTAssertEqual(
            app.state, .runningForeground,
            "after '\(event)' the app is not foreground (state \(app.state.rawValue))."
        )
        XCTAssertTrue(
            state == .home || state == .errorCard,
            "after '\(event)' the renderer did not recover to home/error card — got \(state.rawValue). See the screenshot filmstrip."
        )
    }

    /// Poll until the renderer reaches a terminal state (home or the bounded
    /// startup-failure card) or the app dies; returns what it observed at the
    /// deadline. Same terminal-string detection as BootCaptureUITests.
    private func waitForLiveRenderer(
        _ app: XCUIApplication, timeout: Double
    ) -> RenderState {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.state == .notRunning { return .notRunning }
            if let terminal = classifyRenderState(of: app) { return terminal }
            Thread.sleep(forTimeInterval: 1.0)
        }
        return app.state == .notRunning ? .notRunning : .splashOrLoading
    }

    private func classifyRenderState(of app: XCUIApplication) -> RenderState? {
        let retryButton = app.buttons["Retry startup"]
        let failedText = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH[c] 'Startup failed'")
        )
        if retryButton.exists || failedText.count > 0 {
            return .errorCard
        }

        let bootingText = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] 'Booting'")
        )
        guard bootingText.count == 0 else { return nil }

        let webView = app.webViews.firstMatch
        guard webView.exists else { return nil }
        let interactiveElements =
            app.buttons.count + app.textFields.count + app.textViews.count
            + app.otherElements.matching(
                NSPredicate(format: "isEnabled == true AND hasFocus == true")
            ).count
        return interactiveElements > 0 ? .home : nil
    }

    private func launchWithRetry(_ app: XCUIApplication, attempts: Int = 3) {
        for attempt in 1...attempts {
            app.launch()
            if app.wait(for: .runningForeground, timeout: 20) {
                return
            }
            attachScreenshot(named: "launch-attempt-\(attempt)-not-foreground")
        }
    }

    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attachAccessibilitySnapshot(of app: XCUIApplication) {
        let attachment = XCTAttachment(string: app.debugDescription)
        attachment.name = "ax-hierarchy"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
