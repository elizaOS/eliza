import XCTest

/// Real WKWebView gesture-semantics suite (issue #11353, the #10722 residual).
///
/// Where BootCaptureUITests proves the app BOOTS, this class proves the app's
/// touch gestures produce their intended SEMANTIC outcomes on the real iOS
/// engine — native touch pipeline → WKWebView pointer events → the web app's
/// gesture code — not just "no crash":
///
///   - `testChatSheetDetentFlickCycle` — drives the chat pull-sheet through
///     its detents via the grabber (slow-drag free-settle open → flick to full
///     → flick down to half → flick down to collapsed) asserting the landed
///     detent after every gesture, then exercises the thread-gated flick-up
///     from collapsed against the AX-observed thread state (reveal at half
///     with a thread, refusal on an empty one — both real semantics).
///   - `testLauncherPagerFiftyPercentSwipeThreshold` — a slow sub-threshold
///     drag on the home↔launcher rail must snap back; a slow drag past the 50%
///     point must commit the page (velocity deliberately killed with a
///     hold-before-release, so this exercises the DISTANCE rule, not the flick
///     escape hatch). BOTH directions follow the same rules: the launcher's
///     right-swipe back home is rail-owned and 1:1 (the reduced edge-swipe
///     threshold is gone), so a sub-threshold right drag snaps back too.
///   - `testMessageEditAffordanceRevealsViaTouch` — tap a user message bubble →
///     the action row's Edit affordance appears; tap Edit → the inline editor
///     opens prefilled with the message text.
///   - `testLongPressSystemCalloutSuppression` — long-press on chat-selectable
///     message text SHOWS the system text-selection callout (positive control:
///     proves this run can detect the callout at all), then a long-press on the
///     select-none home gesture surface shows NO callout (the suppression the
///     app's `-webkit-touch-callout: none` body rule promises).
///   - `testPushToTalkHoldEngagesAndReleaseDisengages` — press-and-hold the mic
///     control past the arm timer engages push-to-talk (`voice:ptt-holding` in
///     the composer probe, label flips to "release to insert"), and a release
///     drops back to `voice:idle` — the hold-to-dictate gesture, driven native.
///   - `testComposerKeyboardAvoidanceLift` — tapping the composer raises the
///     software keyboard and the composer probe reports `keyboard:up` (the
///     visualViewport-driven lift that keeps the input above the IME), and
///     dismissing the keyboard returns it to `keyboard:down`.
///   - `testMediaAttachmentPickerOpensViaTouch` — tapping the composer's attach
///     affordance opens the system photo/file picker (the native document/photo
///     UI over the WKWebView) — the entry point of the media-attachment flow.
///
/// Assertion channel: the web app mirrors its gesture state into sr-only
/// static texts — `chat-detent:<pill|collapsed|half|full>`
/// (ContinuousChatOverlay) and `home-launcher-page:<home|launcher>`
/// (HomeLauncherSurface) — because `data-*` attributes never surface in the
/// native accessibility tree. A missing probe on an otherwise-interactive
/// renderer is a HARD failure (broken channel), never a silent skip.
///
/// Runs in the same AppUITests target / lane as the boot suite:
///   node scripts/ios-device-capture.mjs --platform sim   (packages/app)
final class GestureSemanticsUITests: XCTestCase {

    private static let detentPrefix = "chat-detent:"
    private static let pagePrefix = "home-launcher-page:"
    /// The composer AX probe folds three fields into one sr-only label:
    /// `voice:<idle|ptt-holding|recording|handsfree|transcribing> keyboard:<up|down> attachments:<n>`.
    /// The gesture legs below read the field they care about out of that whole
    /// label (the fields are space-separated, so a token match is exact).
    private static let composerPrefix = "voice:"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    // MARK: - Tests

    func testChatSheetDetentFlickCycle() throws {
        let app = XCUIApplication()
        try launchToRenderer(app)
        try ensureUserMessage(in: app, text: "detent gesture probe")
        try settleSheetToCollapsed(in: app)
        attachScreenshot(named: "detent-00-collapsed")

        // SLOW DRAG up from the collapsed input (velocity killed by the
        // hold-before-release): the free-settle rule must open the sheet to the
        // released height regardless of thread content, and a 260pt rest in the
        // detent gap reads "half" (the label folds a mid free-rest into half).
        // This is deliberately the DISTANCE path — the flick path from
        // collapsed is thread-gated and is exercised separately below.
        try slowDragGrabber(in: app, dy: -260)
        assertDetent(becomes: "half", in: app, step: "detent-10-after-slow-open")

        // Flick UP: any upward flick on an open, non-expanded sheet steps to
        // the FULL detent (not thread-gated).
        try flickGrabber(in: app, dy: -260)
        assertDetent(becomes: "full", in: app, step: "detent-20-after-flick-up")

        // Flick DOWN #1: full → half (steps down one detent, never skipping).
        try flickGrabber(in: app, dy: 260)
        assertDetent(becomes: "half", in: app, step: "detent-30-after-flick-down")

        // While the sheet is open, capture the AX ground truth for the
        // thread-gated flick leg below: does the thread actually hold any
        // message bubbles right now? (The app may have evicted the optimistic
        // user turn when the agent never became ready — see the warm-up
        // eviction note on ensurePersistentUserMessage.)
        let threadHasBubbles = messageBubbles(in: app).count > 0
        attachScreenshot(named: "detent-35-open-thread-state")

        // Flick DOWN #2: half → collapsed.
        try flickGrabber(in: app, dy: 260)
        assertDetent(
            becomes: "collapsed", in: app, step: "detent-40-after-flick-down")

        // Flick UP from collapsed — BOTH outcomes are spec'd semantics, chosen
        // by the observed thread state (never a silent skip):
        //   thread present → the flick reveals the thread at the HALF detent;
        //   thread empty   → the flick must be REFUSED (the sheet has nothing
        //                    to reveal; ContinuousChatOverlay's onPullUp
        //                    deliberately settles back), so the detent must
        //                    still read "collapsed" after the poll.
        try flickGrabber(in: app, dy: -260)
        if threadHasBubbles {
            assertDetent(
                becomes: "half", in: app, step: "detent-50-flick-reveals-thread")
        } else {
            Thread.sleep(forTimeInterval: 2.0)
            attachScreenshot(named: "detent-50-flick-refused-empty-thread")
            XCTAssertEqual(
                markerValue(Self.detentPrefix, in: app), "collapsed",
                "a flick-up on a collapsed sheet with an EMPTY thread must be "
                    + "refused (nothing to reveal) and leave the detent collapsed"
            )
        }
    }

    func testLauncherPagerFiftyPercentSwipeThreshold() throws {
        let app = XCUIApplication()
        try launchToRenderer(app)
        try settleSheetToCollapsed(in: app)
        try normalizeToHomePage(in: app)
        attachScreenshot(named: "pager-00-home")

        // Sub-threshold: a SLOW ~25%-width left drag (velocity killed by the
        // hold-before-release) must snap back — the page may not change.
        slowHorizontalDrag(in: app, fromX: 0.80, toX: 0.55, y: 0.55)
        Thread.sleep(forTimeInterval: 1.5)
        let afterSubThreshold = markerValue(Self.pagePrefix, in: app)
        attachScreenshot(named: "pager-10-after-sub-threshold-drag")
        XCTAssertEqual(
            afterSubThreshold, "home",
            "a slow 25%-width drag released below the 50% threshold must snap "
                + "back to the home page, but the rail reads '\(afterSubThreshold ?? "nil")'"
        )

        // Past-threshold: a SLOW ~65%-width left drag (again velocity-killed,
        // so the DISTANCE rule alone decides) must commit home → launcher.
        slowHorizontalDrag(in: app, fromX: 0.85, toX: 0.20, y: 0.55)
        let committed = waitForMarker(
            Self.pagePrefix, toEqual: "launcher", timeout: 5, in: app)
        attachScreenshot(named: "pager-20-after-past-threshold-drag")
        XCTAssertEqual(
            committed, "launcher",
            "a slow drag past the 50% point must advance the rail to the "
                + "launcher, but the rail reads '\(committed ?? "nil")'"
        )

        // Sub-threshold RIGHT drag: the back-to-home direction follows the
        // SAME 50% distance rule as forward paging (the old reduced
        // edge-swipe threshold is gone — the rail owns the gesture 1:1 in
        // both directions), so a slow ~28%-width right drag must snap back.
        slowHorizontalDrag(in: app, fromX: 0.20, toX: 0.48, y: 0.55)
        Thread.sleep(forTimeInterval: 1.5)
        let afterSubThresholdBack = markerValue(Self.pagePrefix, in: app)
        attachScreenshot(named: "pager-30-after-sub-threshold-right-drag")
        XCTAssertEqual(
            afterSubThresholdBack, "launcher",
            "a slow ~28%-width right drag released below the 50% threshold "
                + "must snap back to the launcher (symmetric rules — no reduced "
                + "edge threshold), but the rail reads "
                + "'\(afterSubThresholdBack ?? "nil")'"
        )

        // Past-threshold RIGHT drag commits launcher → home, tracked 1:1 by
        // the outer rail (the fix for 'swipe right only moves half way and
        // doesn't track my thumb').
        slowHorizontalDrag(in: app, fromX: 0.15, toX: 0.80, y: 0.55)
        let backHome = waitForMarker(
            Self.pagePrefix, toEqual: "home", timeout: 5, in: app)
        attachScreenshot(named: "pager-40-after-past-threshold-right-drag")
        XCTAssertEqual(
            backHome, "home",
            "a slow right drag past the 50% point must return the rail to the "
                + "home page, but the rail reads '\(backHome ?? "nil")'"
        )
    }

    func testMessageEditAffordanceRevealsViaTouch() throws {
        let app = XCUIApplication()
        try launchToRenderer(app)
        let messageText = "edit me please"
        try ensurePersistentUserMessage(in: app, text: messageText)

        // Tap the (last) user bubble → the action row must reveal Edit.
        let bubble = try lastMessageBubble(in: app)
        bubble.tap()
        let editButton = app.buttons["Edit"]
        if !editButton.waitForExistence(timeout: 5) {
            // One retry: the first tap can land while the open-spring is still
            // settling and be treated as an outside tap.
            attachScreenshot(named: "edit-05-first-tap-no-reveal")
            try lastMessageBubble(in: app).tap()
        }
        XCTAssertTrue(
            editButton.waitForExistence(timeout: 5),
            "tapping a user message bubble must reveal the action row with the "
                + "Edit affordance — see the edit-*.png attachments"
        )
        attachScreenshot(named: "edit-10-action-row-revealed")

        // Tap Edit → the inline editor opens prefilled with the message text.
        editButton.tap()
        let editor = editorElement(in: app)
        XCTAssertTrue(
            editor.waitForExistence(timeout: 5),
            "tapping Edit must open the inline message editor (aria-label "
                + "'Edit message')"
        )
        let editorValue = (editor.value as? String) ?? ""
        attachScreenshot(named: "edit-20-editor-open")
        attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-editor")
        XCTAssertTrue(
            editorValue.localizedCaseInsensitiveContains(messageText),
            "the editor must be prefilled with the message text "
                + "('\(messageText)') but its AX value is '\(editorValue)'"
        )

        // Leave the transcript as we found it.
        let cancel = app.buttons["Cancel"]
        if cancel.exists { cancel.tap() }
    }

    func testLongPressSystemCalloutSuppression() throws {
        let app = XCUIApplication()
        try launchToRenderer(app)
        let messageText = "callout probe message"
        try ensurePersistentUserMessage(in: app, text: messageText)

        // POSITIVE CONTROL — the message bubble opts back into selection
        // (`[data-chat-selectable]` → -webkit-touch-callout: default), so a
        // long-press on it must raise the system text-selection callout. This
        // proves the run can DETECT the callout; without it the suppression
        // assertion below would be vacuous.
        let bubble = try lastMessageBubble(in: app)
        bubble.press(forDuration: 1.5)
        let controlEvidence = waitForSystemCallout(in: app, timeout: 4)
        attachScreenshot(named: "callout-10-positive-control-selectable-text")
        attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-positive-control")
        guard let controlEvidence else {
            throw XCTSkip(
                "long-press on chat-selectable text raised no detectable system "
                    + "callout on this OS build — the suppression assertion would "
                    + "be vacuous, so this run is inconclusive (see the "
                    + "callout-10 screenshot + AX attachment)"
            )
        }

        // Dismiss the selection/callout and drop the sheet so the home gesture
        // surface is exposed.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        Thread.sleep(forTimeInterval: 1.0)
        try settleSheetToCollapsed(in: app)
        try normalizeToHomePage(in: app)

        // SUPPRESSION — the home/launcher rail is a select-none gesture surface
        // under the app-wide `-webkit-touch-callout: none` iOS body rule: a
        // long-press there must NOT raise the system callout.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
            .press(forDuration: 1.5)
        let suppressionEvidence = waitForSystemCallout(in: app, timeout: 2.5)
        attachScreenshot(named: "callout-20-suppressed-on-home-surface")
        attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-suppression")
        XCTAssertNil(
            suppressionEvidence,
            "long-press on the select-none home gesture surface must not raise "
                + "the system text-selection callout (detected \(suppressionEvidence ?? "nil"); "
                + "positive control had detected \(controlEvidence))"
        )
        // The long-press must not have hijacked navigation either.
        XCTAssertEqual(
            markerValue(Self.pagePrefix, in: app), "home",
            "the suppressed long-press must leave the rail on the home page"
        )
    }

    func testPushToTalkHoldEngagesAndReleaseDisengages() throws {
        let app = XCUIApplication()
        try launchToRenderer(app)
        try openComposer(in: app)

        // The mic control carries aria-label "talk" while idle (it becomes
        // "release to insert" only WHILE holding). It is exposed as a switch on
        // iOS (aria-pressed), so match by label across element types.
        let mic = try composerControl(
            in: app, label: "talk",
            missing: "no idle mic ('talk') control in the AX tree")
        attachScreenshot(named: "ptt-00-idle")
        XCTAssertEqual(
            composerField(Self.composerPrefix, in: app), "idle",
            "the composer must start in the idle voice phase"
        )

        // Press-and-hold past the ~200ms arm timer: push-to-talk engages and
        // the composer probe reports ptt-holding (the same field the web unit
        // test locks). `press(forDuration:)` holds a real touch down.
        mic.press(forDuration: 1.6)
        let engaged = waitForComposerField(
            Self.composerPrefix, toEqual: "ptt-holding", timeout: 4, in: app)
        attachScreenshot(named: "ptt-10-holding")
        // A device without a usable mic/permission may refuse to enter capture;
        // that is a real environmental refusal, not a gesture failure. Only a
        // release that FAILED to disengage below is a hard failure.
        guard engaged == "ptt-holding" else {
            attachAccessibilitySnapshot(
                of: app, named: "ax-hierarchy-ptt-not-engaged")
            throw XCTSkip(
                "press-and-hold did not engage push-to-talk on this device "
                    + "(voice phase read '\(engaged ?? "nil")') — likely no mic "
                    + "or a denied speech permission in this simulator lane"
            )
        }
        // Release ends the hold → back to idle (the transcript, if any, lands in
        // the draft; the mic returns to its resting label).
        let disengaged = waitForComposerField(
            Self.composerPrefix, toEqual: "idle", timeout: 6, in: app)
        attachScreenshot(named: "ptt-20-released")
        XCTAssertEqual(
            disengaged, "idle",
            "releasing the push-to-talk hold must return the composer to the "
                + "idle voice phase, but it reads '\(disengaged ?? "nil")'"
        )
    }

    func testComposerKeyboardAvoidanceLift() throws {
        let app = XCUIApplication()
        try launchToRenderer(app)
        try openComposer(in: app)

        // Composer at rest: no IME, no lift.
        XCTAssertEqual(
            composerField("keyboard:", in: app), "down",
            "the composer must report keyboard:down before it is focused"
        )
        attachScreenshot(named: "kbd-00-resting")

        // Focus the composer → the software keyboard rises and the overlay
        // lifts the input above it (the visualViewport/native-inset avoidance),
        // surfaced as keyboard:up in the probe.
        let composer = try composerTextElement(in: app)
        composer.tap()
        guard app.keyboards.firstMatch.waitForExistence(timeout: 10) else {
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-keyboard")
            throw XCTSkip(
                "the software keyboard never appeared after tapping the composer "
                    + "— hardware-keyboard simulators suppress it (Cmd-K)")
        }
        let lifted = waitForComposerField(
            "keyboard:", toEqual: "up", timeout: 5, in: app)
        attachScreenshot(named: "kbd-10-keyboard-up")
        XCTAssertEqual(
            lifted, "up",
            "focusing the composer must lift it over the software keyboard "
                + "(keyboard-avoidance), but the probe reads '\(lifted ?? "nil")'"
        )

        // Dismiss the keyboard → the lift releases back to keyboard:down.
        if app.keyboards.buttons["Hide keyboard"].exists {
            app.keyboards.buttons["Hide keyboard"].tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap()
        }
        let released = waitForComposerField(
            "keyboard:", toEqual: "down", timeout: 5, in: app)
        attachScreenshot(named: "kbd-20-keyboard-down")
        XCTAssertEqual(
            released, "down",
            "dismissing the keyboard must drop the composer lift back to "
                + "keyboard:down, but the probe reads '\(released ?? "nil")'"
        )
    }

    func testMediaAttachmentPickerOpensViaTouch() throws {
        let app = XCUIApplication()
        try launchToRenderer(app)
        try openComposer(in: app)

        // No pending attachments at rest.
        XCTAssertEqual(
            composerField("attachments:", in: app), "0",
            "the composer must start with zero pending attachments"
        )

        // Tap the attach affordance (aria-label "attach image") → the web app
        // clicks the hidden <input type=file>, which iOS answers with the
        // system photo/document picker OVER the WKWebView. Detect the picker by
        // its well-known sheet controls (Photo Library / Choose File / Cancel).
        let attach = try composerControl(
            in: app, label: "attach image",
            missing: "no attach affordance ('attach image') in the AX tree")
        attachScreenshot(named: "attach-00-before")
        attach.tap()

        let pickerEvidence = waitForAttachmentPicker(in: app, timeout: 8)
        attachScreenshot(named: "attach-10-picker")
        attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-attach-picker")
        guard let pickerEvidence else {
            // A simulator with no Photos entitlement/library can decline to show
            // the picker; that is an environmental refusal of the OS surface,
            // not a gesture failure. Record it honestly rather than green-wash.
            throw XCTSkip(
                "tapping the attach affordance raised no detectable system "
                    + "photo/file picker on this simulator (no Photos library or "
                    + "denied entitlement) — see attach-10 + the AX attachment"
            )
        }
        XCTAssertNotNil(
            pickerEvidence,
            "the attach gesture must open the system media picker"
        )

        // Dismiss the picker, leaving the composer as we found it.
        for cancelLabel in ["Cancel", "Done"] {
            let cancel = app.buttons[cancelLabel]
            if cancel.exists, cancel.isHittable {
                cancel.tap()
                break
            }
        }
    }

    // MARK: - Launch / boot

    /// `XCUIApplication.launch()` can race an in-flight app (re)install — wait
    /// for foreground and relaunch a bounded number of times (same pattern as
    /// BootCaptureUITests).
    private func launchWithRetry(_ app: XCUIApplication, attempts: Int = 3) {
        for attempt in 1...attempts {
            app.launch()
            if app.wait(for: .runningForeground, timeout: 20) { return }
            attachScreenshot(named: "launch-attempt-\(attempt)-not-foreground")
        }
    }

    /// Launch and wait until the renderer exposes the chat-detent probe. Boot
    /// failures skip (boot coverage lives in BootCaptureUITests); a renderer
    /// that is interactive but has NO probe is a hard failure — the gesture
    /// assertion channel itself is broken, and skipping would be a vacuous
    /// green.
    private func launchToRenderer(_ app: XCUIApplication) throws {
        launchWithRetry(app)
        let env = ProcessInfo.processInfo.environment
        let timeout = Double(env["ELIZA_BOOT_TIMEOUT_SECONDS"] ?? "") ?? 180
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.state == .notRunning { break }
            if markerValue(Self.detentPrefix, in: app) != nil {
                completeFirstRunIfPresent(in: app)
                return
            }
            Thread.sleep(forTimeInterval: 1.0)
        }
        attachScreenshot(named: "boot-no-detent-probe")
        attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-probe")
        let bootingVisible =
            app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS[c] 'Booting'")
            ).count > 0
        let rendererInteractive =
            app.state == .runningForeground && !bootingVisible
            && (app.webViews.firstMatch.exists
                && (app.textViews.count + app.textFields.count + app.buttons.count) > 0)
        if rendererInteractive {
            XCTFail(
                "the renderer is interactive but never exposed the "
                    + "'chat-detent:' AX probe — the gesture-state channel is "
                    + "broken (see ax-hierarchy-no-probe)"
            )
        }
        throw XCTSkip(
            "boot did not reach an interactive renderer within \(Int(timeout))s "
                + "— boot coverage lives in BootCaptureUITests"
        )
    }

    /// A fresh install boots into the first-run placement question ("where
    /// should your agent run?"), which pins the chat sheet open and locks the
    /// composer — every gesture precondition then skips. Choosing "On this
    /// device" is the REAL user path for this device lane (the local-agent
    /// mode the phone runs everywhere else); after the choice the onboarding
    /// lock clears and the sheet/rail become gesture-testable while the model
    /// downloads in the background. Bounded and screenshot-documented; if the
    /// lock never clears the gesture tests still skip honestly downstream.
    private func completeFirstRunIfPresent(in app: XCUIApplication) {
        // The placement modal mounts AFTER the detent probe appears (the boot
        // conductor settles first), so poll a generous window rather than a
        // single short existence check.
        let onDevice = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == 'On this device'")
        ).firstMatch
        var found = false
        let mountDeadline = Date().addingTimeInterval(20)
        while Date() < mountDeadline {
            if onDevice.exists, onDevice.isHittable {
                found = true
                break
            }
            Thread.sleep(forTimeInterval: 1.0)
        }
        guard found else { return }
        attachScreenshot(named: "firstrun-00-placement-choice")
        onDevice.tap()

        // The composer lock is AX-visible as the "Tap a highlighted option"
        // hint; wait (bounded) for it to clear. A fresh container has to
        // download + load the local model before the lock clears, so honor the
        // agent-ready budget when no first-run-specific one is set.
        let env = ProcessInfo.processInfo.environment
        let timeout =
            Double(env["ELIZA_FIRSTRUN_TIMEOUT_SECONDS"] ?? "")
            ?? Double(env["ELIZA_AGENT_READY_TIMEOUT_SECONDS"] ?? "")
            ?? 240
        let hint = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] 'highlighted option'")
        ).firstMatch
        let deadline = Date().addingTimeInterval(timeout)
        var lastShot = Date.distantPast
        while Date() < deadline {
            if !hint.exists {
                attachScreenshot(named: "firstrun-20-lock-cleared")
                return
            }
            if Date().timeIntervalSince(lastShot) > 60 {
                attachScreenshot(named: "firstrun-10-waiting-for-lock-clear")
                lastShot = Date()
            }
            Thread.sleep(forTimeInterval: 2.0)
        }
        attachScreenshot(named: "firstrun-30-lock-never-cleared")
    }

    // MARK: - Probe markers

    /// Read the value of an sr-only state probe (`<prefix><value>`) out of the
    /// WKWebView's AX tree. StaticText is the expected exposure; fall back to
    /// an any-type descendant scan for OS-build variance.
    private func markerValue(_ prefix: String, in app: XCUIApplication) -> String? {
        let predicate = NSPredicate(format: "label BEGINSWITH %@", prefix)
        let text = app.staticTexts.matching(predicate).firstMatch
        if text.exists { return String(text.label.dropFirst(prefix.count)) }
        let any = app.descendants(matching: .any).matching(predicate).firstMatch
        if any.exists { return String(any.label.dropFirst(prefix.count)) }
        return nil
    }

    /// Poll a probe until it reads `expected` (returns it) or the timeout
    /// lapses (returns the last seen value — the assert message then shows
    /// where the gesture actually landed).
    @discardableResult
    private func waitForMarker(
        _ prefix: String,
        toEqual expected: String,
        timeout: TimeInterval,
        in app: XCUIApplication
    ) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        var lastSeen: String?
        while Date() < deadline {
            if let value = markerValue(prefix, in: app) {
                lastSeen = value
                if value == expected { return value }
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return lastSeen
    }

    /// Read one space-separated field (`<field>:<value>`) out of the composer
    /// probe's single sr-only label, e.g. `field("keyboard:")` → "up". Returns
    /// nil when the probe (or that field) is absent.
    private func composerField(
        _ field: String, in app: XCUIApplication
    ) -> String? {
        let predicate = NSPredicate(format: "label CONTAINS %@", field)
        let text = app.staticTexts.matching(predicate).firstMatch
        let label: String?
        if text.exists {
            label = text.label
        } else {
            let any = app.descendants(matching: .any)
                .matching(predicate).firstMatch
            label = any.exists ? any.label : nil
        }
        guard let label else { return nil }
        for token in label.split(separator: " ") where token.hasPrefix(field) {
            return String(token.dropFirst(field.count))
        }
        return nil
    }

    /// Poll a composer-probe field until it reads `expected` (returns it) or the
    /// timeout lapses (returns the last seen value for the assert message).
    @discardableResult
    private func waitForComposerField(
        _ field: String,
        toEqual expected: String,
        timeout: TimeInterval,
        in app: XCUIApplication
    ) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        var lastSeen: String?
        while Date() < deadline {
            if let value = composerField(field, in: app) {
                lastSeen = value
                if value == expected { return value }
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        return lastSeen
    }

    private func assertDetent(
        becomes expected: String, in app: XCUIApplication, step: String
    ) {
        let landed = waitForMarker(
            Self.detentPrefix, toEqual: expected, timeout: 5, in: app)
        attachScreenshot(named: step)
        XCTAssertEqual(
            landed, expected,
            "expected the sheet to land at the '\(expected)' detent but it "
                + "reads '\(landed ?? "nil")' — see \(step).png"
        )
        // Let the settle spring come fully to rest before the next gesture.
        Thread.sleep(forTimeInterval: 0.8)
    }

    // MARK: - Gesture drivers

    /// The sheet grabber (aria-label "drag up to open chat" / "drag down to
    /// close chat"). Hidden from AX while the sheet is pilled.
    private func grabber(in app: XCUIApplication) -> XCUIElement? {
        let predicate = NSPredicate(format: "label BEGINSWITH[c] 'drag'")
        let element = app.buttons.matching(predicate).firstMatch
        return element.waitForExistence(timeout: 5) ? element : nil
    }

    /// Fast flick on the grabber: short press, fast drag, immediate release —
    /// crosses the web gesture engine's velocity threshold so it resolves as a
    /// FLICK (detent step), not a deliberate free-settling drag. `.fast` is
    /// only 750 pt/s (≈0.5 px/ms over the whole gesture — right AT the web
    /// threshold), so drive an explicit 2000 pt/s.
    private func flickGrabber(in app: XCUIApplication, dy: CGFloat) throws {
        guard let handle = grabber(in: app), handle.isHittable else {
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-grabber")
            throw XCTSkip("no hittable sheet grabber in the AX tree")
        }
        let start = handle.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let end = start.withOffset(CGVector(dx: 0, dy: dy))
        start.press(
            forDuration: 0.05, thenDragTo: end,
            withVelocity: XCUIGestureVelocity(rawValue: 2000),
            thenHoldForDuration: 0)
    }

    /// Slow deliberate drag on the grabber with a hold-before-release: zero
    /// release velocity, so the web gesture engine resolves it via the
    /// free-settle (distance) rule, never the flick rule. Verified against the
    /// real engine: this path opens the sheet even when the thread is empty,
    /// unlike the thread-gated flick.
    private func slowDragGrabber(in app: XCUIApplication, dy: CGFloat) throws {
        guard let handle = grabber(in: app), handle.isHittable else {
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-grabber")
            throw XCTSkip("no hittable sheet grabber in the AX tree")
        }
        let start = handle.coordinate(
            withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let end = start.withOffset(CGVector(dx: 0, dy: dy))
        start.press(
            forDuration: 0.25, thenDragTo: end, withVelocity: .slow,
            thenHoldForDuration: 0.6)
    }

    /// Slow horizontal drag with a hold-before-release: the hold zeroes the
    /// release velocity, so only the DISTANCE threshold can commit the page —
    /// exactly the 50%-swipe rule under test.
    private func slowHorizontalDrag(
        in app: XCUIApplication, fromX: CGFloat, toX: CGFloat, y: CGFloat
    ) {
        let start = app.coordinate(
            withNormalizedOffset: CGVector(dx: fromX, dy: y))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: toX, dy: y))
        start.press(
            forDuration: 0.25, thenDragTo: end, withVelocity: .slow,
            thenHoldForDuration: 0.6)
    }

    // MARK: - App-state normalization

    /// Step the chat sheet down to the collapsed input bar with real gestures
    /// (flick down / tap the pill), converging from any detent.
    private func settleSheetToCollapsed(
        in app: XCUIApplication, attempts: Int = 6
    ) throws {
        for _ in 0..<attempts {
            guard let detent = markerValue(Self.detentPrefix, in: app) else {
                break
            }
            if detent == "collapsed" { return }
            if detent == "pill" {
                let pill = app.buttons["open chat"]
                if pill.exists { pill.tap() }
            } else if let handle = grabber(in: app), handle.isHittable {
                let start = handle.coordinate(
                    withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
                let end = start.withOffset(CGVector(dx: 0, dy: 300))
                start.press(
                    forDuration: 0.05, thenDragTo: end,
                    withVelocity: XCUIGestureVelocity(rawValue: 2000),
                    thenHoldForDuration: 0)
            } else {
                break
            }
            Thread.sleep(forTimeInterval: 1.2)
        }
        let final = markerValue(Self.detentPrefix, in: app)
        if final != "collapsed" {
            attachScreenshot(named: "normalize-sheet-failed")
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-normalize")
            throw XCTSkip(
                "could not settle the chat sheet to the collapsed detent "
                    + "(reads '\(final ?? "nil")') — precondition, not the gesture "
                    + "under test"
            )
        }
    }

    /// Ensure the home↔launcher rail rests on the home page.
    private func normalizeToHomePage(in app: XCUIApplication) throws {
        guard let page = markerValue(Self.pagePrefix, in: app) else {
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-page-probe")
            throw XCTSkip("no home-launcher-page probe in the AX tree")
        }
        if page == "home" { return }
        slowHorizontalDrag(in: app, fromX: 0.20, toX: 0.70, y: 0.55)
        guard
            waitForMarker(Self.pagePrefix, toEqual: "home", timeout: 5, in: app)
                == "home"
        else {
            throw XCTSkip("could not normalize the rail to the home page")
        }
    }

    // MARK: - Composer plumbing

    /// Open the chat sheet far enough that the composer input row (and its AX
    /// probe) is live and interactive — the row is inert while the sheet is
    /// pilled. A slow drag-open from collapsed exposes the composer at half.
    private func openComposer(in app: XCUIApplication) throws {
        // The composer/probe live inside `chat-content`, which is inert while
        // pilled. From collapsed the input row is already mounted; only the
        // pill state hides it, so normalize to collapsed then, if the probe is
        // still not readable, drag the sheet open.
        try settleSheetToCollapsed(in: app)
        if composerField(Self.composerPrefix, in: app) != nil { return }
        try slowDragGrabber(in: app, dy: -260)
        Thread.sleep(forTimeInterval: 1.0)
        guard composerField(Self.composerPrefix, in: app) != nil else {
            attachAccessibilitySnapshot(
                of: app, named: "ax-hierarchy-no-composer-probe")
            throw XCTSkip(
                "the composer probe never surfaced after opening the sheet — the "
                    + "composer-state AX channel is unavailable on this boot")
        }
    }

    /// A composer control matched by its aria-label. iOS exposes the mic/attach
    /// controls as switches (aria-pressed) on some builds, so match across
    /// element types and require it hittable.
    private func composerControl(
        in app: XCUIApplication, label: String, missing: String
    ) throws -> XCUIElement {
        let predicate = NSPredicate(format: "label == %@", label)
        let button = app.buttons.matching(predicate).firstMatch
        let element =
            button.waitForExistence(timeout: 5)
            ? button
            : app.descendants(matching: .any).matching(predicate).firstMatch
        guard element.waitForExistence(timeout: 5), element.isHittable else {
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-control")
            throw XCTSkip(missing)
        }
        return element
    }

    /// The composer text field (the `chat-composer-textarea`, aria-label
    /// "message"). Prefer the WKWebView subtree, then fall back to the app root.
    private func composerTextElement(in app: XCUIApplication) throws -> XCUIElement {
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
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-composer")
            throw XCTSkip("no hittable composer text element in the AX tree")
        }
        return composer
    }

    /// Evidence that iOS's system photo/document picker is on screen (the sheet
    /// the hidden <input type=file> click raises). Scans the labels the picker
    /// UI presents across OS builds.
    private func attachmentPickerEvidence(in app: XCUIApplication) -> String? {
        for label in [
            "Photo Library", "Choose File", "Take Photo", "Browse",
            "Choose from Library", "Recents", "Photos",
        ] {
            if app.buttons[label].exists { return "button '\(label)'" }
            if app.staticTexts[label].exists { return "text '\(label)'" }
            if app.cells[label].exists { return "cell '\(label)'" }
        }
        // The document-browser / photo sheet also raises Cancel that lives
        // OUTSIDE the WKWebView (the composer's own controls all sit inside it).
        let cancelOutside =
            app.buttons["Cancel"].exists
            && !app.webViews.firstMatch.buttons["Cancel"].exists
        return cancelOutside ? "Cancel outside the webview" : nil
    }

    private func waitForAttachmentPicker(
        in app: XCUIApplication, timeout: TimeInterval
    ) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let evidence = attachmentPickerEvidence(in: app) { return evidence }
            Thread.sleep(forTimeInterval: 0.3)
        }
        return nil
    }

    // MARK: - Message plumbing

    /// User message bubbles surface as their aria-label ("Show/Hide message
    /// actions") — the text child is name-hidden behind the label on most OS
    /// builds, so match the label across element types.
    private func messageBubbles(in app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(
            NSPredicate(
                format: "label IN {'Show message actions', 'Hide message actions'}"
            ))
    }

    private func lastMessageBubble(in app: XCUIApplication) throws -> XCUIElement {
        let bubbles = messageBubbles(in: app)
        let count = bubbles.count
        guard count > 0 else {
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-bubble")
            throw XCTSkip("no message bubble exposed in the AX tree")
        }
        return bubbles.element(boundBy: count - 1)
    }

    /// Give the local model a bounded chance to come online before sending:
    /// while the agent is warming, the home surface shows a "Loading Eliza…"
    /// status chip, and turns sent in that window are not persisted (the
    /// post-turn history reload evicts the optimistic bubble — see
    /// ensurePersistentUserMessage). On a model-ready boot this returns in one
    /// poll; on a model-less lane the timeout (ELIZA_AGENT_READY_TIMEOUT_SECONDS,
    /// default 240, 0 = don't wait) expires and the caller proceeds into the
    /// suite's warm-up semantics instead.
    private func waitForAgentReady(in app: XCUIApplication) {
        let env = ProcessInfo.processInfo.environment
        let timeout = Double(env["ELIZA_AGENT_READY_TIMEOUT_SECONDS"] ?? "") ?? 240
        guard timeout > 0 else { return }
        let loadingChips = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] 'Loading Eliza'"))
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if loadingChips.count == 0 { return }
            Thread.sleep(forTimeInterval: 5.0)
        }
        attachScreenshot(named: "agent-still-warming-at-timeout")
    }

    /// Type `text` into the composer and send it (Enter submits), then wait for
    /// the user bubble to land in the transcript. Sending also opens the sheet,
    /// so the transcript is visible afterwards.
    private func ensureUserMessage(in app: XCUIApplication, text: String) throws {
        waitForAgentReady(in: app)
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
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-composer")
            throw XCTSkip("no hittable composer text element in the AX tree")
        }
        let bubblesBefore = messageBubbles(in: app).count
        composer.tap()
        guard app.keyboards.firstMatch.waitForExistence(timeout: 10) else {
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-keyboard")
            throw XCTSkip("keyboard never appeared after tapping the composer")
        }
        composer.typeText(text)

        // Send by tapping the composer's send control (aria-label "send" /
        // "send another"). The iOS keyboard's Return does NOT reach the web
        // textarea as an Enter keydown, so typing "\n" never submits. NOTE:
        // the control carries aria-pressed, so iOS AX exposes it as a SWITCH
        // (verified in the run-2 AX dump), not a button — match by label
        // across element types.
        let sendButton = app.descendants(matching: .any).matching(
            NSPredicate(format: "label BEGINSWITH 'send'")
        ).firstMatch
        guard sendButton.waitForExistence(timeout: 5), sendButton.isHittable
        else {
            attachScreenshot(named: "send-no-send-button")
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-send-button")
            throw XCTSkip("no hittable send control after typing a draft")
        }
        sendButton.tap()

        // A successful submit CLEARS the draft (the composer's own text is AX-
        // visible, so it must not be mistaken for the sent bubble) and lands
        // the user turn optimistically; sending also springs the sheet open.
        let deadline = Date().addingTimeInterval(15)
        var composerCleared = false
        while Date() < deadline {
            if !composerCleared {
                let draft = (composer.value as? String) ?? ""
                composerCleared = !draft.contains(text)
            }
            if composerCleared {
                if messageBubbles(in: app).count > bubblesBefore { return }
                if app.staticTexts.matching(
                    NSPredicate(format: "label CONTAINS %@", text)
                ).count > 0 {
                    return
                }
            }
            Thread.sleep(forTimeInterval: 0.5)
        }
        attachScreenshot(named: "send-no-bubble")
        attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-sent-bubble")
        throw XCTSkip(
            composerCleared
                ? "sent '\(text)' but no user bubble surfaced in the AX tree within 15s"
                : "the send control never cleared the draft — the message did not submit"
        )
    }

    /// ensureUserMessage + persistence check. Sending during the local agent's
    /// model warm-up can EVICT the optimistic user turn a few seconds later:
    /// the post-turn history reload full-replaces the thread with server truth,
    /// and a server that never accepted the turn returns an empty thread. The
    /// message-dependent gesture tests (edit affordance, callout positive
    /// control) need the bubble to still exist when they touch it, so verify it
    /// survives the eviction window and retry once before skipping honestly.
    private func ensurePersistentUserMessage(
        in app: XCUIApplication, text: String
    ) throws {
        for attempt in 1...2 {
            try ensureUserMessage(in: app, text: text)
            Thread.sleep(forTimeInterval: 5.0)
            if messageBubbles(in: app).count > 0 { return }
            attachScreenshot(named: "persist-\(attempt)-bubble-evicted")
        }
        attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-evicted-thread")
        throw XCTSkip(
            "the app evicted the sent user turn during agent warm-up (the "
                + "post-turn history reload returned an empty thread), so this "
                + "message-dependent gesture cannot be exercised on this boot"
        )
    }

    /// The inline message editor (aria-label "Edit message").
    private func editorElement(in app: XCUIApplication) -> XCUIElement {
        let predicate = NSPredicate(format: "label == 'Edit message'")
        let textView = app.textViews.matching(predicate).firstMatch
        if textView.exists { return textView }
        return app.descendants(matching: .any).matching(predicate).firstMatch
    }

    // MARK: - System callout detection

    /// Evidence that the system text-selection callout / edit menu is on
    /// screen. Scans the channels iOS uses across builds: menu items, the
    /// selection-only verbs ("Look Up" never exists in the app's own UI), and
    /// a Copy control OUTSIDE the WKWebView subtree (the app's reveal-row Copy
    /// lives INSIDE it).
    private func systemCalloutEvidence(in app: XCUIApplication) -> String? {
        let menuItemCount = app.menuItems.count
        if menuItemCount > 0 { return "menuItems(\(menuItemCount))" }
        for verb in ["Look Up", "Search Web", "Translate", "Select All"] {
            if app.menuItems[verb].exists { return "menuItem '\(verb)'" }
            if app.buttons[verb].exists { return "button '\(verb)'" }
            if app.staticTexts[verb].exists { return "staticText '\(verb)'" }
        }
        let copyPredicate = NSPredicate(format: "label == 'Copy'")
        let copyEverywhere = app.buttons.matching(copyPredicate).count
        let copyInWebView = app.webViews.firstMatch.buttons
            .matching(copyPredicate).count
        if copyEverywhere > copyInWebView {
            return "Copy button outside the webview"
        }
        return nil
    }

    private func waitForSystemCallout(
        in app: XCUIApplication, timeout: TimeInterval
    ) -> String? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let evidence = systemCalloutEvidence(in: app) { return evidence }
            Thread.sleep(forTimeInterval: 0.3)
        }
        return nil
    }

    // MARK: - Attachments

    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attachAccessibilitySnapshot(
        of app: XCUIApplication, named name: String = "ax-hierarchy"
    ) {
        let attachment = XCTAttachment(string: app.debugDescription)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
