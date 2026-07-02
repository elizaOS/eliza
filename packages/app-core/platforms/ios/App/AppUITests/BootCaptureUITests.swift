import XCTest

/// Boot-watchability harness (issue #11030 follow-up, leg D3).
///
/// Launches the app, screenshots the real pixels at a fixed interval via
/// `XCUIScreen.main.screenshot()`, and asserts that the boot terminates in one
/// of the two legitimate end states within the budget:
///   - HOME: the renderer is past the "Booting up…" splash and showing live UI, or
///   - ERROR CARD: the leg-A bounded-boot surface ("Startup failed:" +
///     a "Retry startup" button) — a real, retryable error UI, never a hang.
///
/// Every screenshot is attached with `.keepAlways`, so
/// `xcrun xcresulttool export attachments` yields the full boot filmstrip even
/// when the assertion fails. Driven by packages/app/scripts/ios-device-capture.mjs;
/// knobs arrive as env vars through xcodebuild's TEST_RUNNER_ prefix:
///   ELIZA_BOOT_TIMEOUT_SECONDS (default 180)
///   ELIZA_BOOT_SCREENSHOT_INTERVAL_SECONDS (default 15)
final class BootCaptureUITests: XCTestCase {

    private enum BootOutcome: String {
        case home
        case errorCard = "error-card"
        case timedOut = "timed-out"
        case terminated
    }

    override func setUpWithError() throws {
        // Keep capturing after a failed poll — the filmstrip is the point.
        continueAfterFailure = true
    }

    func testBootReachesHomeOrErrorCard() throws {
        let env = ProcessInfo.processInfo.environment
        let timeoutSeconds = Double(env["ELIZA_BOOT_TIMEOUT_SECONDS"] ?? "") ?? 180
        let intervalSeconds = max(1, Double(env["ELIZA_BOOT_SCREENSHOT_INTERVAL_SECONDS"] ?? "") ?? 15)

        let app = XCUIApplication()
        launchWithRetry(app)

        let start = Date()
        let deadline = start.addingTimeInterval(timeoutSeconds)
        var outcome: BootOutcome = .timedOut

        attachScreenshot(named: "boot-000s")

        var nextShot = start.addingTimeInterval(intervalSeconds)
        while Date() < deadline {
            // A dead app cannot make progress and its element queries throw —
            // classify the termination explicitly instead (real boot-crash signal).
            if app.state == .notRunning {
                outcome = .terminated
                break
            }
            if let terminal = classifyBootState(of: app) {
                outcome = terminal
                break
            }
            // Sleep in short slices so terminal-state detection stays responsive.
            Thread.sleep(forTimeInterval: 1.0)
            if Date() >= nextShot {
                attachScreenshot(named: screenshotName(since: start))
                nextShot = Date().addingTimeInterval(intervalSeconds)
            }
        }

        attachScreenshot(named: "boot-final-\(outcome.rawValue)")
        if app.state != .notRunning {
            attachAccessibilitySnapshot(of: app)
        }

        let elapsed = Int(Date().timeIntervalSince(start).rounded())
        XCTAssertTrue(
            outcome == .home || outcome == .errorCard,
            "Boot ended in state '\(outcome.rawValue)' after \(elapsed)s " +
            "(budget \(Int(timeoutSeconds))s) — expected home or the startup-failure card. " +
            "See the boot-*.png attachments for the filmstrip."
        )
    }

    /// One watchable interaction beyond boot: tap the chat composer, type
    /// "hello", screenshot each step. WKWebView AX exposure of web content
    /// varies by OS build, so every precondition that fails skips (XCTSkip)
    /// instead of failing — boot coverage stays in
    /// testBootReachesHomeOrErrorCard. The one hard assertion: once the
    /// keyboard is up, typing must not leave the composer empty.
    func testComposerAcceptsTypedText() throws {
        let env = ProcessInfo.processInfo.environment
        let timeoutSeconds = Double(env["ELIZA_BOOT_TIMEOUT_SECONDS"] ?? "") ?? 180

        let app = XCUIApplication()
        launchWithRetry(app)

        // Reach home first, reusing the boot classifier.
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        var reachedHome = false
        while Date() < deadline {
            if app.state == .notRunning { break }
            if let terminal = classifyBootState(of: app) {
                reachedHome = terminal == .home
                break
            }
            Thread.sleep(forTimeInterval: 1.0)
        }
        attachScreenshot(named: "interaction-000-home")
        guard reachedHome else {
            throw XCTSkip("boot did not reach home — composer interaction not attempted")
        }

        // The composer is a web <textarea> — surfaces as a textView (or
        // textField) inside the WKWebView's AX tree.
        let webView = app.webViews.firstMatch
        let candidates: [XCUIElement] = [
            webView.textViews.firstMatch,
            webView.textFields.firstMatch,
            app.textViews.firstMatch,
            app.textFields.firstMatch,
        ]
        guard
            let composer = candidates.first(where: {
                $0.waitForExistence(timeout: 10) && $0.isHittable
            })
        else {
            attachAccessibilitySnapshot(of: app)
            throw XCTSkip("no hittable composer text element in the AX tree — see ax-hierarchy attachment")
        }

        composer.tap()
        attachScreenshot(named: "interaction-010-composer-tapped")
        guard app.keyboards.firstMatch.waitForExistence(timeout: 10) else {
            attachAccessibilitySnapshot(of: app)
            throw XCTSkip("keyboard never appeared after tapping the composer")
        }

        composer.typeText("hello")
        attachScreenshot(named: "interaction-020-typed-hello")
        attachAccessibilitySnapshot(of: app)

        let value = (composer.value as? String) ?? ""
        XCTAssertTrue(
            value.localizedCaseInsensitiveContains("hello"),
            "typed 'hello' but the composer's AX value is '\(value)' — " +
            "see interaction-020-typed-hello.png for the real pixels."
        )
    }

    /// `XCUIApplication.launch()` can race an in-flight app (re)install —
    /// FrontBoard force-quits the fresh pid (exit code 0xfbfbfbfb) and the
    /// session is left driving a dead app. Wait for foreground and relaunch a
    /// bounded number of times before giving up.
    private func launchWithRetry(_ app: XCUIApplication, attempts: Int = 3) {
        for attempt in 1...attempts {
            app.launch()
            if app.wait(for: .runningForeground, timeout: 20) {
                return
            }
            attachScreenshot(named: "launch-attempt-\(attempt)-not-foreground")
        }
    }

    /// Terminal-state detection against the real renderer strings:
    ///   error card — i18n keys startupfailureview.StartupFailed ("Startup failed:")
    ///                and startupfailureview.RetryStartup ("Retry startup"),
    ///   splash     — the "Booting up…" text the un-hangable splash renders.
    /// Home = web content present, no "Booting" text, at least one interactive element.
    private func classifyBootState(of app: XCUIApplication) -> BootOutcome? {
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
            app.buttons.count + app.textFields.count + app.textViews.count + app.otherElements
                .matching(NSPredicate(format: "isEnabled == true AND hasFocus == true")).count
        if interactiveElements > 0 {
            return .home
        }
        return nil
    }

    private func screenshotName(since start: Date) -> String {
        let seconds = Int(Date().timeIntervalSince(start).rounded())
        return String(format: "boot-%03ds", seconds)
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
