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

    private struct StrictGateFailure: Error, CustomStringConvertible {
        let message: String
        var description: String { message }
    }

    override func setUpWithError() throws {
        // Keep capturing after a failed poll — the filmstrip is the point.
        continueAfterFailure = true
    }

    func testBootReachesHomeOrErrorCard() throws {
        let env = ProcessInfo.processInfo.environment
        let timeoutSeconds = Double(env["ELIZA_BOOT_TIMEOUT_SECONDS"] ?? "") ?? 180
        let intervalSeconds = max(1, Double(env["ELIZA_BOOT_SCREENSHOT_INTERVAL_SECONDS"] ?? "") ?? 15)
        let requireHome = envFlag("ELIZA_REQUIRE_HOME", env: env)

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
        if requireHome {
            XCTAssertEqual(
                outcome,
                .home,
                "Strict boot gate ended in state '\(outcome.rawValue)' after \(elapsed)s " +
                    "(budget \(Int(timeoutSeconds))s) — expected home, not an error card/timeout. " +
                    "See the boot-*.png attachments for the filmstrip."
            )
        } else {
            XCTAssertTrue(
                outcome == .home || outcome == .errorCard,
                "Boot ended in state '\(outcome.rawValue)' after \(elapsed)s " +
                    "(budget \(Int(timeoutSeconds))s) — expected home or the startup-failure card. " +
                    "See the boot-*.png attachments for the filmstrip."
            )
        }
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
            try skipOrFail("boot did not reach home — composer interaction not attempted", env: env)
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
            try skipOrFail(
                "no hittable composer text element in the AX tree — see ax-hierarchy attachment",
                env: env)
        }

        composer.tap()
        attachScreenshot(named: "interaction-010-composer-tapped")
        guard app.keyboards.firstMatch.waitForExistence(timeout: 10) else {
            attachAccessibilitySnapshot(of: app)
            try skipOrFail("keyboard never appeared after tapping the composer", env: env)
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
        let requireReply = envFlag("ELIZA_REQUIRE_REPLY", env: env)

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
            try skipOrFail("boot did not reach home — send not attempted", env: env)
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
            try skipOrFail("no hittable composer text element in the AX tree", env: env)
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
            try skipOrFail("keyboard never appeared after tapping the composer", env: env)
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
            try skipOrFail("no hittable send control after typing the prompt", env: env)
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
        if requireReply {
            XCTAssertEqual(
                outcome,
                "reply",
                "Strict boot gate did not observe an assistant reply within \(Int(replyTimeout))s — " +
                    "outcome was \(outcome). See the send-wait filmstrip."
            )
        }
    }

    // MARK: - Full onboarding → chat → voice (cloud + local)

    private enum OnboardingPath: String {
        case cloud
        case local
    }

    /// Drive the REAL first-run onboarding on the CLOUD path (managed agent),
    /// then verify chat + voice. A fresh install boots into the in-chat
    /// first-run conductor: greeting → runtime choice → (cloud provision) →
    /// tutorial choice. Cloud provisioning needs an Eliza Cloud session on the
    /// device; if none is present the flow stalls at the OAuth prompt and the
    /// filmstrip records exactly where (hard-asserted only past the unlock).
    func testCloudOnboardingChatAndVoice() throws {
        try runFullOnboarding(.cloud)
    }

    /// Drive the REAL first-run onboarding on the LOCAL path ("On this device"),
    /// then verify chat + voice against the on-device model: greeting → "On this
    /// device" → provider "On this device (recommended)" → tutorial choice →
    /// model warm-up → send a prompt + await reply → exercise the mic.
    func testLocalOnboardingChatAndVoice() throws {
        try runFullOnboarding(.local)
    }

    private func runFullOnboarding(_ path: OnboardingPath) throws {
        let env = ProcessInfo.processInfo.environment
        let bootTimeout = Double(env["ELIZA_BOOT_TIMEOUT_SECONDS"] ?? "") ?? 180
        let agentReady = Double(env["ELIZA_AGENT_READY_TIMEOUT_SECONDS"] ?? "") ?? 360

        let app = XCUIApplication()
        launchWithRetry(app)
        let tag = path.rawValue

        // 1. Reach a live renderer (past the boot splash).
        let bootDeadline = Date().addingTimeInterval(bootTimeout)
        var live = false
        while Date() < bootDeadline {
            if app.state == .notRunning { break }
            if classifyBootState(of: app) == .home { live = true; break }
            Thread.sleep(forTimeInterval: 1.0)
        }
        attachScreenshot(named: "\(tag)-000-greeting")
        guard live else {
            attachAccessibilitySnapshot(of: app)
            try skipOrFail("boot never reached a live renderer — onboarding not attempted", env: env)
        }

        // 2. Placement choice. The conductor seeds the greeting + choice ONLY
        //    after client.listLocalAgentBackups() resolves, which waits on the
        //    agent API — on a fresh device the local full-Bun engine is still
        //    "Waking Eliza…", so the greeting can take a couple minutes to
        //    appear. Poll generously (agentReady budget), screenshotting the
        //    wait so a genuine no-show is distinguishable from slow boot.
        let placement = path == .cloud ? "Eliza Cloud (managed)" : "On this device"
        if !tapWebChoice(app, label: placement, timeout: min(agentReady, 300)) {
            attachScreenshot(named: "\(tag)-010-no-placement-choice")
            attachAccessibilitySnapshot(of: app)
            try skipOrFail(
                "first-run placement choice '\(placement)' never surfaced within "
                    + "\(Int(min(agentReady, 300)))s (greeting is gated behind the "
                    + "agent-wake + listLocalAgentBackups). See \(tag)-010.",
                env: env)
        }
        attachScreenshot(named: "\(tag)-010-after-placement")

        if path == .local {
            // 3a. Local sub-step: model provider choice.
            if tapWebChoice(app, label: "On this device (recommended)", timeout: 120) {
                attachScreenshot(named: "\(tag)-020-after-provider")
            } else {
                attachScreenshot(named: "\(tag)-020-no-provider-choice")
            }
        } else {
            // 3b. Cloud sub-step: provisioning (auto if a Cloud session exists;
            //     otherwise an OAuth prompt appears). Give it room, screenshot
            //     the outcome either way.
            Thread.sleep(forTimeInterval: 4.0)
            attachScreenshot(named: "\(tag)-020-cloud-provisioning")
        }

        // 4. Tutorial choice → skip (fastest finish). It only appears once the
        //    runtime path resolved, so poll generously.
        if tapWebChoice(app, label: "Skip for now", timeout: agentReady) {
            attachScreenshot(named: "\(tag)-030-skipped-tutorial")
        } else {
            attachScreenshot(named: "\(tag)-030-no-tutorial-choice")
        }

        // 5. First-run done = the composer unlocks (the "Tap a highlighted
        //    option above to continue" hint disappears). Bounded wait.
        let unlockHint = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] 'highlighted option'")
        ).firstMatch
        let unlockDeadline = Date().addingTimeInterval(agentReady)
        var unlocked = false
        while Date() < unlockDeadline {
            if !unlockHint.exists { unlocked = true; break }
            Thread.sleep(forTimeInterval: 3.0)
        }
        attachScreenshot(named: "\(tag)-040-onboarding-\(unlocked ? "complete" : "stalled")")
        guard unlocked else {
            attachAccessibilitySnapshot(of: app)
            try skipOrFail(
                "onboarding (\(tag)) did not complete — composer stayed locked "
                    + "(cloud OAuth needs a device session, or the local model is "
                    + "still warming). See the \(tag)-*.png filmstrip.",
                env: env)
        }

        // 5b. Local path only: hold the app foregrounded so the fire-and-forget
        //     recommended-model download that first-run finish kicks off can run
        //     to completion instead of dying with the test teardown (that
        //     teardown is exactly why the ~5GB pull never landed in prior runs).
        if path == .local {
            holdForLocalModelDownload(app, tag: tag)
        }

        // 6. Chat: type a prompt, send, await a reply.
        try verifyChat(app, tag: tag, agentReady: agentReady)

        // 7. Voice: tap the mic, assert it enters the recording state.
        try verifyVoice(app, tag: tag)

        attachScreenshot(named: "\(tag)-090-done")
    }

    /// Keep the app foregrounded after local onboarding so the recommended
    /// model download (fired fire-and-forget by first-run finish) completes
    /// instead of being torn down with the test. The WKWebView download UI is
    /// invisible to XCUITest, so this does not assert on progress — it holds the
    /// session alive (touching the AX tree each tick so XCUITest does not
    /// idle-kill it) and films the wait; the `[Downloader]` completion and the
    /// native `keep_awake_set` idle-timer hold are verified from device syslog.
    /// Opt-in via `ELIZA_LOCAL_MODEL_DOWNLOAD_WAIT_SECONDS` (default 0 = skip),
    /// so the default suite is not slowed by a multi-GB download.
    private func holdForLocalModelDownload(_ app: XCUIApplication, tag: String) {
        let env = ProcessInfo.processInfo.environment
        let seconds =
            Double(env["ELIZA_LOCAL_MODEL_DOWNLOAD_WAIT_SECONDS"] ?? "") ?? 0
        guard seconds > 0 else { return }
        let deadline = Date().addingTimeInterval(seconds)
        var tick = 0
        while Date() < deadline {
            if app.state == .notRunning { break }
            _ = app.staticTexts.firstMatch.exists  // keep the session active
            if tick % 4 == 0 {
                attachScreenshot(named: "\(tag)-045-model-download-t\(tick)")
            }
            tick += 1
            Thread.sleep(forTimeInterval: 15.0)
        }
        attachScreenshot(named: "\(tag)-046-model-download-hold-done")
    }

    /// Type a prompt into the composer, tap send, and watch for a reply.
    private func verifyChat(
        _ app: XCUIApplication, tag: String, agentReady: Double
    ) throws {
        // The "Loading eliza-1-2B…" warm-up chip is a WKWebView node invisible to
        // XCUITest (its count is always 0), so it cannot be polled. The gemma4-2b
        // model runs on CPU on-device (n_gpu_layers reduced to fit the A18 budget,
        // #11612) — slow to warm — so give it a fixed head start; the send loop
        // below also re-sends past the "still starting up, retry" fallback.
        Thread.sleep(forTimeInterval: min(agentReady, 150))
        attachScreenshot(named: "\(tag)-050-agent-warmup")

        let composer = firstHittableComposer(app)
        guard let composer else {
            attachAccessibilitySnapshot(of: app)
            let env = ProcessInfo.processInfo.environment
            try skipOrFail("no hittable composer after onboarding", env: env)
        }
        let replyMarker = "IOS_CHAT_OK"
        let prompt =
            "Start your reply with exactly \(replyMarker), then say hello in one short sentence."
        let promptPrefix = String(prompt.prefix(20))
        func looksNotReady(_ s: String) -> Bool {
            let l = s.lowercased()
            return l.contains("didn't reach") || l.contains("starting up")
                || l.contains("retry in a moment") || l.contains("still warming")
                || l.contains("try again in")
        }
        // Consult the SHARED failure-string vocabulary (issue #13687). A reply
        // that matches one of these is an error render / broken pipeline
        // (e.g. the ErrorBoundary "Something went wrong" heading), NOT a genuine
        // model reply — historically the loop went green on it. The list is
        // generated from packages/app/scripts/lib/chat-failure-strings.mjs into
        // ChatFailureStrings.generated.swift and parity-tested, so this verifier
        // and the mobile-local-chat-smoke share exactly one source of truth.
        // Returns the matched fragment so the assertion can quote it.
        func matchedChatFailureString(_ s: String) -> String? {
            let range = NSRange(s.startIndex..<s.endIndex, in: s)
            for fragment in ChatFailureStrings.ios {
                guard
                    let regex = try? NSRegularExpression(
                        pattern: fragment, options: [.caseInsensitive])
                else { continue }
                if regex.firstMatch(in: s, options: [], range: range) != nil {
                    return fragment
                }
            }
            return nil
        }
        var replyClassification: String?
        var failureObservation: String?
        var notReadyObservation: String?
        var unrecognizedObservation: String?

        // On-device warm-up can leave the first sends returning the "message
        // didn't reach the agent — still starting up. Retry" fallback. Re-send
        // until a genuine model reply lands (or attempts exhaust).
        var reply: String?
        let sendAttempts = 10
        attemptLoop: for attempt in 1...sendAttempts {
            if app.state == .notRunning { break }
            var baseline = Set<String>()
            for text in app.staticTexts.allElementsBoundByIndex.prefix(120) {
                baseline.insert(text.label)
            }
            composer.tap()
            guard app.keyboards.firstMatch.waitForExistence(timeout: 12) else {
                Thread.sleep(forTimeInterval: 8.0)
                continue
            }
            composer.typeText(prompt)
            let sendButton = app.descendants(matching: .any).matching(
                NSPredicate(format: "label BEGINSWITH[c] 'send'")
            ).firstMatch
            guard sendButton.waitForExistence(timeout: 6), sendButton.isHittable
            else {
                attachScreenshot(named: "\(tag)-061-no-send-\(attempt)")
                Thread.sleep(forTimeInterval: 10.0)
                continue
            }
            sendButton.tap()
            attachScreenshot(named: "\(tag)-060-sent-\(attempt)")

            // Await a NEW reply static-text (not the prompt echo, ≥ 8 chars).
            let deadline = Date().addingTimeInterval(180)
            var candidate: String?
            while Date() < deadline {
                if app.state == .notRunning { break attemptLoop }
                for text in app.staticTexts.allElementsBoundByIndex.prefix(120) {
                    let label = text.label
                    if label.count >= 8, !baseline.contains(label),
                        !label.contains(promptPrefix),
                        !label.localizedCaseInsensitiveContains("highlighted option")
                    {
                        candidate = label
                        break
                    }
                }
                if candidate != nil { break }
                Thread.sleep(forTimeInterval: 3.0)
            }
            attachScreenshot(named: "\(tag)-070-reply-attempt-\(attempt)")
            if let c = candidate, let failure = matchedChatFailureString(c) {
                // An error render was surfaced. Record it (quoted) and stop —
                // this must FAIL the verifier, never silently retry into a
                // "no reply after N attempts" that hides WHAT went wrong (#13687).
                replyClassification = "failure-string:\(failure)"
                notReadyObservation = nil
                failureObservation = "\(c) [matched failure-string: \(failure)]"
                break
            }
            if let c = candidate,
                c.localizedCaseInsensitiveContains(replyMarker)
            {
                replyClassification = "marker-hit"
                notReadyObservation = nil
                reply = c  // genuine marker-echo model reply
                break
            }
            if let c = candidate, !looksNotReady(c) {
                // A real reply that does not echo the marker is not accepted.
                // Record it as a classified verifier failure instead of
                // treating arbitrary new text as success (#13687).
                replyClassification = "unrecognized-text"
                notReadyObservation = nil
                unrecognizedObservation = c
                break
            }
            if let c = candidate {
                replyClassification = "not-ready"
                notReadyObservation = c
            }
            // Not-ready fallback (or timeout) — let the CPU model warm; retry.
            Thread.sleep(forTimeInterval: 45.0)
        }
        attachScreenshot(named: "\(tag)-075-reply-\(reply != nil ? "arrived" : "timeout")")
        if let reply {
            let att = XCTAttachment(
                string: "\(reply) [classification: \(replyClassification ?? "unknown")]")
            att.name = "\(tag)-reply-text"
            att.lifetime = .keepAlways
            add(att)
        }
        if let failureObservation {
            let att = XCTAttachment(string: failureObservation)
            att.name = "\(tag)-reply-failure-string"
            att.lifetime = .keepAlways
            add(att)
        }
        if let notReadyObservation {
            let att = XCTAttachment(
                string: "\(notReadyObservation) [classification: not-ready]"
            )
            att.name = "\(tag)-reply-not-ready"
            att.lifetime = .keepAlways
            add(att)
        }
        if let unrecognizedObservation {
            let att = XCTAttachment(
                string:
                    "\(unrecognizedObservation) [classification: \(replyClassification ?? "unrecognized-text")]"
            )
            att.name = "\(tag)-reply-unrecognized-text"
            att.lifetime = .keepAlways
            add(att)
        }
        XCTAssertNotEqual(
            app.state, .notRunning,
            "[\(tag)] the app died while waiting for the chat reply.")
        // An error render (matched against the shared failure vocabulary) must
        // fail LOUD with the observed text quoted — never count as a reply,
        // never be swallowed as a bland "no reply" (#13687).
        if let failureObservation {
            XCTFail(
                "[\(tag)] the agent surfaced an error render instead of a genuine "
                    + "model reply: \(failureObservation).")
            return
        }
        if let unrecognizedObservation {
            XCTFail(
                "[\(tag)] the agent replied without the required \(replyMarker) "
                    + "marker: \(unrecognizedObservation).")
            return
        }
        if let notReadyObservation {
            XCTFail(
                "[\(tag)] the agent stayed not-ready after \(sendAttempts) attempts: "
                    + "\(notReadyObservation).")
            return
        }
        XCTAssertNotNil(
            reply,
            "[\(tag)] no genuine model reply after \(sendAttempts) attempts — "
                + "see the \(tag)-070-reply-attempt filmstrip + \(tag)-075.")
    }

    /// Tap the composer mic ("talk") and assert it enters the recording state
    /// ("stop listening"), then stop. Proves the mic capture path is live on
    /// device without needing to assert transcription content.
    private func verifyVoice(_ app: XCUIApplication, tag: String) throws {
        let mic = app.descendants(matching: .any).matching(
            NSPredicate(format: "label ==[c] 'talk'")
        ).firstMatch
        guard mic.waitForExistence(timeout: 8), mic.isHittable else {
            attachScreenshot(named: "\(tag)-080-no-mic")
            attachAccessibilitySnapshot(of: app)
            let env = ProcessInfo.processInfo.environment
            try skipOrFail("mic control ('talk') not hittable — voice not attempted", env: env)
        }
        mic.tap()
        // First voice use raises the SpringBoard microphone-permission alert;
        // grant it so the capture path actually engages.
        grantSystemPermissionIfPresent(named: ["Allow", "OK", "Allow While Using App"])
        Thread.sleep(forTimeInterval: 1.5)
        attachScreenshot(named: "\(tag)-081-mic-tapped")

        // Recording flips the mic label to "stop listening" (and the
        // grabber/pill bar pulses). Poll for either signal.
        let stopListening = app.descendants(matching: .any).matching(
            NSPredicate(format: "label ==[c] 'stop listening'")
        ).firstMatch
        var recording = stopListening.waitForExistence(timeout: 8)
        if !recording {
            // The permission alert may have interrupted the first tap — grant
            // and retry once.
            grantSystemPermissionIfPresent(named: ["Allow", "OK", "Allow While Using App"])
            if mic.exists, mic.isHittable { mic.tap() }
            recording = stopListening.waitForExistence(timeout: 8)
        }
        attachScreenshot(named: "\(tag)-082-voice-\(recording ? "recording" : "no-state")")
        attachAccessibilitySnapshot(of: app)
        XCTAssertTrue(
            recording,
            "[\(tag)] tapping the mic did not enter the recording state "
                + "('stop listening' never appeared) — mic capture may have been "
                + "denied or is not wired. See \(tag)-082.")
        // Stop cleanly so the run doesn't leave the mic hot.
        if stopListening.exists, stopListening.isHittable { stopListening.tap() }
        attachScreenshot(named: "\(tag)-083-voice-stopped")
    }

    /// Tap a first-run in-chat choice widget by its exact visible label.
    private func tapWebChoice(
        _ app: XCUIApplication, label: String, timeout: TimeInterval
    ) -> Bool {
        let exact = NSPredicate(format: "label ==[c] %@", label)
        let contains = NSPredicate(format: "label CONTAINS[c] %@", label)
        // The Capacitor WKWebView first-run rows are frequently invisible to
        // XCUITest's element tree (no button/staticText exposed). For the known
        // onboarding rows, fall back to a RAW normalized-coordinate tap (which
        // bypasses the element tree) once the greeting has had time to render.
        let placementCoords: [String: CGVector] = [
            "eliza cloud (managed)": CGVector(dx: 0.41, dy: 0.236),
            "on this device": CGVector(dx: 0.41, dy: 0.291),
            "connect to a remote agent": CGVector(dx: 0.41, dy: 0.345),
            // Model-provider sub-step (appears below the placement card).
            "on this device (recommended)": CGVector(dx: 0.41, dy: 0.503),
            "eliza cloud inference": CGVector(dx: 0.41, dy: 0.557),
        ]
        let coordFallbackAt = Date().addingTimeInterval(45)
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            // Prefer a button; fall back to any descendant carrying the label;
            // then a non-hittable staticText coordinate; try exact then substring.
            for predicate in [exact, contains] {
                let button = app.buttons.matching(predicate).firstMatch
                if button.exists, button.isHittable { button.tap(); return true }
                let any = app.descendants(matching: .any).matching(predicate)
                    .firstMatch
                if any.exists, any.isHittable { any.tap(); return true }
                let text = app.staticTexts.matching(predicate).firstMatch
                if text.exists {
                    text.coordinate(
                        withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)
                    ).tap()
                    return true
                }
            }
            if Date() > coordFallbackAt,
                let offset = placementCoords[label.lowercased()]
            {
                app.coordinate(withNormalizedOffset: offset).tap()
                return true
            }
            Thread.sleep(forTimeInterval: 1.0)
        }
        return false
    }

    /// Tap the first matching button on a SpringBoard system alert (mic /
    /// speech-recognition permission). No-op when no alert is up.
    private func grantSystemPermissionIfPresent(named labels: [String]) {
        let springboard = XCUIApplication(
            bundleIdentifier: "com.apple.springboard")
        // Give the alert a beat to animate in.
        for _ in 0..<6 {
            for label in labels {
                let button = springboard.buttons[label]
                if button.exists, button.isHittable {
                    attachScreenshot(named: "permission-grant-\(label)")
                    button.tap()
                    return
                }
            }
            if springboard.alerts.count == 0 { Thread.sleep(forTimeInterval: 0.5) }
        }
    }

    private func firstHittableComposer(_ app: XCUIApplication) -> XCUIElement? {
        let webView = app.webViews.firstMatch
        let candidates: [XCUIElement] = [
            webView.textViews.firstMatch,
            webView.textFields.firstMatch,
            app.textViews.firstMatch,
            app.textFields.firstMatch,
        ]
        return candidates.first { $0.waitForExistence(timeout: 10) && $0.isHittable }
    }

    private func envFlag(_ name: String, env: [String: String]) -> Bool {
        let value = (env[name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return value == "1" || value == "true" || value == "yes" || value == "on"
    }

    private func strictNoSkips(_ env: [String: String]) -> Bool {
        envFlag("ELIZA_REQUIRE_NO_SKIPS", env: env)
            || envFlag("ELIZA_FAIL_ON_SKIP", env: env)
            || envFlag("ELIZA_REQUIRE_HOME", env: env)
            || envFlag("ELIZA_REQUIRE_REPLY", env: env)
    }

    private func skipOrFail(_ message: String, env: [String: String]) throws -> Never {
        if strictNoSkips(env) {
            XCTFail("Strict iOS boot gate precondition failed: \(message)")
            throw StrictGateFailure(message: message)
        }
        throw XCTSkip(message)
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
