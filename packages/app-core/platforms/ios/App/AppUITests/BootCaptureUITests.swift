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

    /// Drive one REAL chat exchange end-to-end on the device: tap the
    /// composer, type a prompt, press Return (the composer's Enter-to-send
    /// path in ChatSurface/glass-composer), then watch the screen for an
    /// assistant reply, attaching a screenshot filmstrip the whole time.
    ///
    /// Preconditions skip (same philosophy as testComposerAcceptsTypedText);
    /// the hard assertions are that the send actually left the composer (its
    /// AX value no longer holds the prompt) and that the app survived the
    /// reply wait. Reply arrival is detected as any NEW static-text label
    /// (absent before the send, not the prompt echo, ≥ 12 chars) and is
    /// recorded in the final screenshot name + a `reply-text` attachment —
    /// on local-inference devices this reply leg is the entire point of the
    /// run (issue #11612 on-device generation).
    ///
    /// Knobs (TEST_RUNNER_ env):
    ///   ELIZA_BOOT_TIMEOUT_SECONDS              boot budget (default 180)
    ///   ELIZA_SEND_PROMPT                       prompt (default below)
    ///   ELIZA_REPLY_TIMEOUT_SECONDS             reply budget (default 300)
    ///   ELIZA_REPLY_SCREENSHOT_INTERVAL_SECONDS filmstrip cadence (default 15)
    func testComposerSendsPromptAndWaitsForReply() throws {
        let env = ProcessInfo.processInfo.environment
        let bootTimeout = Double(env["ELIZA_BOOT_TIMEOUT_SECONDS"] ?? "") ?? 180
        let prompt = env["ELIZA_SEND_PROMPT"] ?? "Hello, introduce yourself briefly."
        let replyTimeout = Double(env["ELIZA_REPLY_TIMEOUT_SECONDS"] ?? "") ?? 300
        let shotInterval = max(1, Double(env["ELIZA_REPLY_SCREENSHOT_INTERVAL_SECONDS"] ?? "") ?? 15)

        let app = XCUIApplication()
        launchWithRetry(app)

        let bootDeadline = Date().addingTimeInterval(bootTimeout)
        var reachedHome = false
        while Date() < bootDeadline {
            if app.state == .notRunning { break }
            if let terminal = classifyBootState(of: app) {
                reachedHome = terminal == .home
                break
            }
            Thread.sleep(forTimeInterval: 1.0)
        }
        attachScreenshot(named: "send-000-home")
        guard reachedHome else {
            throw XCTSkip("boot did not reach home — send not attempted")
        }

        // Wait out the local model warm-up (the "Loading Eliza…" chip) so the
        // send lands on a ready agent — same detector as
        // GestureSemanticsUITests.waitForAgentReady. On a device where the
        // warm-up never completes the timeout expires and the send proceeds
        // anyway; the filmstrip records what the user would see.
        let agentReadyTimeout = Double(env["ELIZA_AGENT_READY_TIMEOUT_SECONDS"] ?? "") ?? 240
        if agentReadyTimeout > 0 {
            let loadingChips = app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS[c] 'Loading Eliza'"))
            let warmDeadline = Date().addingTimeInterval(agentReadyTimeout)
            while Date() < warmDeadline {
                if loadingChips.count == 0 { break }
                Thread.sleep(forTimeInterval: 5.0)
            }
            attachScreenshot(named: "send-005-after-warmup-wait")
        }

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
            throw XCTSkip("no hittable composer text element in the AX tree")
        }

        // Baseline of visible static-text labels BEFORE the send, so the
        // reply detector only fires on genuinely new content.
        var baseline = Set<String>()
        for text in app.staticTexts.allElementsBoundByIndex.prefix(80) {
            baseline.insert(text.label)
        }

        composer.tap()
        guard app.keyboards.firstMatch.waitForExistence(timeout: 10) else {
            attachAccessibilitySnapshot(of: app)
            throw XCTSkip("keyboard never appeared after tapping the composer")
        }
        composer.typeText(prompt)
        attachScreenshot(named: "send-010-typed-prompt")

        // Submit by tapping the composer's send control. The iOS keyboard's
        // Return does NOT reach the web textarea as an Enter keydown (see
        // GestureSemanticsUITests.ensureUserMessage), and the control carries
        // aria-pressed so AX may expose it as a switch — match by label
        // across element types.
        let sendButton = app.descendants(matching: .any).matching(
            NSPredicate(format: "label BEGINSWITH[c] 'send'")
        ).firstMatch
        guard sendButton.waitForExistence(timeout: 5), sendButton.isHittable else {
            attachScreenshot(named: "send-015-no-send-button")
            attachAccessibilitySnapshot(of: app)
            throw XCTSkip("no hittable send control after typing the prompt")
        }
        sendButton.tap()
        Thread.sleep(forTimeInterval: 2.0)
        attachScreenshot(named: "send-020-after-send-tap")

        // Hard assertion: the tap actually submitted — the composer must no
        // longer be holding the full prompt.
        let residual = (composer.exists ? (composer.value as? String) : nil) ?? ""
        XCTAssertFalse(
            residual.contains(prompt),
            "tapped the send control but the composer still holds the prompt ('\(residual)') — the send never fired."
        )

        let start = Date()
        let deadline = start.addingTimeInterval(replyTimeout)
        var replyLabel: String? = nil
        var nextShot = start.addingTimeInterval(shotInterval)
        let promptPrefix = String(prompt.prefix(24))
        while Date() < deadline {
            if app.state == .notRunning { break }
            for text in app.staticTexts.allElementsBoundByIndex.prefix(120) {
                let label = text.label
                if label.count >= 12,
                   !baseline.contains(label),
                   !label.contains(promptPrefix) {
                    replyLabel = label
                    break
                }
            }
            if replyLabel != nil { break }
            Thread.sleep(forTimeInterval: 2.0)
            if Date() >= nextShot {
                let seconds = Int(Date().timeIntervalSince(start).rounded())
                attachScreenshot(named: String(format: "send-wait-%03ds", seconds))
                nextShot = Date().addingTimeInterval(shotInterval)
            }
        }

        let outcome = app.state == .notRunning
            ? "app-terminated"
            : (replyLabel != nil ? "reply" : "no-reply-timeout")
        attachScreenshot(named: "send-final-\(outcome)")
        if app.state != .notRunning {
            attachAccessibilitySnapshot(of: app)
        }
        if let replyLabel {
            let attachment = XCTAttachment(string: replyLabel)
            attachment.name = "reply-text"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        XCTAssertNotEqual(
            outcome, "app-terminated",
            "the app died while waiting for the reply — see the send-wait filmstrip."
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
