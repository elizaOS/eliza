import XCTest

/// Launcher → promoted-view walkthrough (mobile UI/UX polish lane).
///
/// Drives the REAL launcher grid on-device: settles the chat sheet, pages the
/// home↔launcher rail to the launcher, then for every promoted tile taps it,
/// screenshots the opened view, asserts the view actually rendered (the shared
/// "Back to launcher" header control is present and the view's content markers
/// are in the AX tree), and returns to the launcher before the next leg.
///
/// The Transcripts and Memories legs are the on-device proof for the iOS
/// local-agent kernel's `/api/transcripts` and `/api/memories/*` WebView
/// routes: before those routes existed the views surfaced their fetch-error
/// notices ("Failed to load transcripts" / "Failed to load memory feed.")
/// because the kernel 404'd the path. Those error strings are hard-forbidden
/// here.
///
/// Screenshot filmstrip: every leg attaches `walkthrough-NN-<view>-*.png` with
/// `.keepAlways`, so `xcrun xcresulttool export attachments` yields the whole
/// tour even on failure. Runs in the AppUITests lane:
///   node scripts/ios-device-capture.mjs --platform sim \
///     --only-testing AppUITests/ViewWalkthroughUITests   (packages/app)
final class ViewWalkthroughUITests: XCTestCase {

    private static let detentPrefix = "chat-detent:"
    private static let pagePrefix = "home-launcher-page:"

    /// One leg of the tour: the launcher tile's accessible label, content
    /// markers that prove the view rendered (ANY match passes; empty = the
    /// back control alone is the proof), and error markers that must NOT be
    /// on screen (route-miss / fetch-failure notices).
    private struct ViewLeg {
        let tile: String
        let anyOf: [String]
        let forbidden: [String]
    }

    private static let legs: [ViewLeg] = [
        ViewLeg(tile: "Settings", anyOf: ["Settings"], forbidden: []),
        ViewLeg(tile: "Wallet", anyOf: ["Wallet"], forbidden: []),
        ViewLeg(tile: "Tasks", anyOf: ["Tasks"], forbidden: []),
        ViewLeg(tile: "Character", anyOf: ["Character"], forbidden: []),
        ViewLeg(tile: "Relationships", anyOf: ["Relationships"], forbidden: []),
        ViewLeg(tile: "Knowledge", anyOf: ["Knowledge"], forbidden: []),
        ViewLeg(tile: "Skills", anyOf: ["Skills"], forbidden: []),
        ViewLeg(tile: "Experience", anyOf: ["Experience"], forbidden: []),
        ViewLeg(
            tile: "Transcripts",
            anyOf: ["No transcripts yet", "Transcripts"],
            forbidden: ["Failed to load transcripts"]
        ),
        ViewLeg(
            tile: "Memories",
            anyOf: ["No memories yet", "Memories"],
            forbidden: ["Failed to load memory feed"]
        ),
        ViewLeg(tile: "Help", anyOf: ["Help"], forbidden: []),
    ]

    override func setUpWithError() throws {
        // Keep touring after a failed leg — the filmstrip covers every view
        // either way, and each leg raises its own assertion.
        continueAfterFailure = true
    }

    func testLauncherOpensEveryPromotedView() throws {
        let app = XCUIApplication()
        try launchToRenderer(app)
        exitMountedHeaderView(in: app)
        try settleSheetToCollapsed(in: app)
        try pageToLauncher(in: app)
        attachScreenshot(named: "walkthrough-00-launcher")

        // Leg 1 — Messages: the tile opens the chat sheet (detent leaves
        // "collapsed"/"pill"), not a header view; close it again afterwards.
        try messagesLeg(in: app)

        // Legs 2..n — header views: tile → view (Back-to-launcher header
        // control + content markers) → back.
        for (index, leg) in Self.legs.enumerated() {
            try viewLeg(leg, index: index + 2, in: app)
        }

        attachScreenshot(named: "walkthrough-99-launcher-restored")
    }

    // MARK: - Legs

    private func messagesLeg(in app: XCUIApplication) throws {
        guard let tile = launcherTile("Messages", in: app) else {
            attachAccessibilitySnapshot(of: app, named: "ax-no-messages-tile")
            XCTFail("no hittable 'Messages' tile on the launcher")
            return
        }
        tapTile(tile)
        // The chat sheet must open: the detent probe leaves the collapsed/pill
        // family within the poll window.
        let deadline = Date().addingTimeInterval(10)
        var detent: String?
        while Date() < deadline {
            detent = markerValue(Self.detentPrefix, in: app)
            if let value = detent, value != "collapsed", value != "pill" { break }
            Thread.sleep(forTimeInterval: 0.5)
        }
        Thread.sleep(forTimeInterval: 1.0)
        attachScreenshot(named: "walkthrough-01-messages")
        XCTAssertTrue(
            detent != nil && detent != "collapsed" && detent != "pill",
            "tapping the Messages tile must open the chat sheet, but the detent "
                + "reads '\(detent ?? "nil")' — see walkthrough-01-messages.png"
        )
        // Drop the keyboard if the composer grabbed focus, then close the sheet
        // so the launcher is tappable for the next leg.
        dismissKeyboardIfPresent(in: app)
        try settleSheetToCollapsed(in: app)
        try pageToLauncher(in: app)
    }

    private func viewLeg(_ leg: ViewLeg, index: Int, in app: XCUIApplication) throws {
        let shotPrefix = String(format: "walkthrough-%02d-%@", index, leg.tile.lowercased())
        guard let tile = launcherTile(leg.tile, in: app) else {
            attachScreenshot(named: "\(shotPrefix)-no-tile")
            attachAccessibilitySnapshot(of: app, named: "ax-no-\(leg.tile.lowercased())-tile")
            XCTFail("no hittable '\(leg.tile)' tile on the launcher")
            return
        }
        tapTile(tile)

        // Opened proof: every promoted header view mounts the shared
        // ViewBackButton (aria-label "Back to launcher").
        let back = backToLauncherControl(in: app)
        let opened = back.waitForExistence(timeout: 10)
        // Give slow content (kernel fetches) a beat before the evidence shot.
        Thread.sleep(forTimeInterval: 2.0)
        attachScreenshot(named: shotPrefix)
        if !opened {
            attachAccessibilitySnapshot(of: app, named: "ax-\(leg.tile.lowercased())-no-back")
        }
        XCTAssertTrue(
            opened,
            "tapping the '\(leg.tile)' tile never mounted a view with the shared "
                + "'Back to launcher' header control — see \(shotPrefix).png"
        )

        for marker in leg.forbidden {
            let hits = app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS[c] %@", marker))
            if hits.count > 0 {
                attachAccessibilitySnapshot(of: app, named: "ax-\(leg.tile.lowercased())-error")
            }
            XCTAssertEqual(
                hits.count, 0,
                "the \(leg.tile) view surfaced '\(marker)' — its backing "
                    + "local-kernel route failed — see \(shotPrefix).png"
            )
        }

        if !leg.anyOf.isEmpty {
            let found = leg.anyOf.contains { marker in
                app.staticTexts.matching(
                    NSPredicate(format: "label CONTAINS[c] %@", marker)
                ).count > 0
            }
            if !found {
                attachAccessibilitySnapshot(of: app, named: "ax-\(leg.tile.lowercased())-no-marker")
            }
            XCTAssertTrue(
                found,
                "the \(leg.tile) view rendered none of its content markers "
                    + "\(leg.anyOf) — see \(shotPrefix).png"
            )
        }

        // Return to the launcher for the next leg.
        if opened {
            tapTile(back)
        }
        try pageToLauncher(in: app)
    }

    // MARK: - Launcher helpers

    /// The launcher tiles are ghost Buttons carrying the view label as their
    /// aria-label (Launcher.tsx IconTile); a same-labeled StaticText caption
    /// sits just below each one. The interactive control is the Button — the
    /// caption is inert, so tapping it navigates nowhere. Prefer the Button
    /// (even when the WebView misreports its activation point as non-hittable —
    /// `tapTile` falls back to a frame-center coordinate tap), then fall back to
    /// any hittable label match for OS builds that fold the role differently.
    private func launcherTile(_ label: String, in app: XCUIApplication) -> XCUIElement? {
        let buttons = app.buttons.matching(NSPredicate(format: "label == %@", label))
        for i in 0..<min(buttons.count, 8) {
            let element = buttons.element(boundBy: i)
            if element.exists { return element }
        }
        let byLabel = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", label))
        for i in 0..<min(byLabel.count, 8) {
            let element = byLabel.element(boundBy: i)
            if element.exists, element.isHittable { return element }
        }
        return nil
    }

    /// Tap a launcher tile. WebView Buttons often report `isHittable == false`
    /// even when on-screen and tappable (the AX activation point resolves onto
    /// a covering container), which silently drops `.tap()`. Fall back to a
    /// coordinate tap on the element's own frame center, which fires regardless.
    private func tapTile(_ element: XCUIElement) {
        if element.isHittable {
            element.tap()
        } else {
            element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
    }

    /// A boot (or a leg's back-tap) can land on a mounted header view instead
    /// of the home/launcher rail — e.g. the post-first-run character-select
    /// redirect target. The shared ViewBackButton always returns to the
    /// launcher; take it when it's on screen.
    private func exitMountedHeaderView(in app: XCUIApplication) {
        let back = backToLauncherControl(in: app)
        guard back.waitForExistence(timeout: 5) else { return }
        attachScreenshot(named: "normalize-exit-restored-view")
        tapTile(back)
        Thread.sleep(forTimeInterval: 1.5)
    }

    /// Ensure the home↔launcher rail rests on the LAUNCHER page (the tile
    /// grid), paging with the same slow 65%-width drag the pager suite proves.
    ///
    /// A leg can strand the app on a mounted view whose header does NOT expose
    /// the shared "Back to launcher" control (e.g. the Wallet view), so neither
    /// the rail probe nor the back button can recover the launcher. Rather than
    /// abort the whole tour on one such leg, fall back to a full relaunch of the
    /// persisted (already-first-run-complete) container and retry once — every
    /// remaining leg still gets exercised and screenshotted.
    private func pageToLauncher(in app: XCUIApplication, attempts: Int = 4) throws {
        if attemptPageToLauncher(in: app, attempts: attempts) { return }
        attachScreenshot(named: "normalize-relaunch-recover")
        relaunchToInteractive(app)
        if attemptPageToLauncher(in: app, attempts: attempts) { return }
        attachScreenshot(named: "normalize-launcher-failed")
        attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-launcher")
        throw XCTSkip(
            "could not page the rail to the launcher even after a relaunch "
                + "(reads '\(markerValue(Self.pagePrefix, in: app) ?? "nil")')"
        )
    }

    private func attemptPageToLauncher(
        in app: XCUIApplication, attempts: Int
    ) -> Bool {
        for _ in 0..<attempts {
            guard let page = markerValue(Self.pagePrefix, in: app) else {
                // No rail probe — a header view may still be mounted (its own
                // back control replaces the rail); exit it and re-poll.
                exitMountedHeaderView(in: app)
                Thread.sleep(forTimeInterval: 1.0)
                continue
            }
            if page == "launcher" { return true }
            slowHorizontalDrag(in: app, fromX: 0.85, toX: 0.20, y: 0.55)
            if waitForMarker(Self.pagePrefix, toEqual: "launcher", timeout: 5, in: app)
                == "launcher" {
                return true
            }
        }
        return false
    }

    /// Terminate and relaunch the app, waiting for an interactive renderer.
    /// First-run has already completed on the initial boot (the container
    /// persists), so this lands on the home/launcher rail; normalize any
    /// mounted view + open sheet before returning.
    private func relaunchToInteractive(_ app: XCUIApplication) {
        app.terminate()
        Thread.sleep(forTimeInterval: 1.0)
        launchWithRetry(app)
        let env = ProcessInfo.processInfo.environment
        let timeout = Double(env["ELIZA_BOOT_TIMEOUT_SECONDS"] ?? "") ?? 180
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.state == .notRunning { break }
            let booting = app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS[c] 'Booting'"))
            if booting.count == 0,
               app.webViews.firstMatch.exists,
               app.buttons.count + app.textFields.count + app.textViews.count > 0 {
                break
            }
            Thread.sleep(forTimeInterval: 1.0)
        }
        exitMountedHeaderView(in: app)
        try? settleSheetToCollapsed(in: app)
    }

    private func dismissKeyboardIfPresent(in app: XCUIApplication) {
        guard app.keyboards.firstMatch.exists else { return }
        // The keyboard accessory bar's Done ends editing without side effects.
        let done = app.toolbars.buttons["Done"]
        if done.exists, done.isHittable {
            done.tap()
        } else {
            // Tap dead space above the sheet.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        }
        Thread.sleep(forTimeInterval: 0.8)
    }

    /// The shared ViewBackButton ("Back to launcher"): AX may expose it as a
    /// button or fold it into another role — match the label across types.
    private func backToLauncherControl(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(
            NSPredicate(format: "label == 'Back to launcher'")
        ).firstMatch
    }

    // MARK: - Launch / boot (same conventions as the sibling suites)

    private func launchWithRetry(_ app: XCUIApplication, attempts: Int = 3) {
        for attempt in 1...attempts {
            app.launch()
            if app.wait(for: .runningForeground, timeout: 20) { return }
            attachScreenshot(named: "launch-attempt-\(attempt)-not-foreground")
        }
    }

    /// Launch and wait for an interactive renderer (past "Booting up…", web
    /// content + at least one interactive element). Boot failures skip — boot
    /// coverage lives in BootCaptureUITests.
    private func launchToRenderer(_ app: XCUIApplication) throws {
        launchWithRetry(app)
        let env = ProcessInfo.processInfo.environment
        let timeout = Double(env["ELIZA_BOOT_TIMEOUT_SECONDS"] ?? "") ?? 180
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.state == .notRunning { break }
            let booting = app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS[c] 'Booting'"))
            if booting.count == 0,
               app.webViews.firstMatch.exists,
               app.buttons.count + app.textFields.count + app.textViews.count > 0 {
                completeFirstRunIfPresent(in: app)
                return
            }
            Thread.sleep(forTimeInterval: 1.0)
        }
        attachScreenshot(named: "boot-not-interactive")
        throw XCTSkip(
            "boot did not reach an interactive renderer within \(Int(timeout))s "
                + "— boot coverage lives in BootCaptureUITests"
        )
    }

    /// A fresh container boots into the first-run placement question; choose
    /// "On this device" (the real local-agent path this lane proves) and step
    /// past the follow-up prompts so the launcher becomes reachable. Bounded;
    /// a container that already finished first-run returns immediately.
    private func completeFirstRunIfPresent(in app: XCUIApplication) {
        let onDevice = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == 'On this device'")
        ).firstMatch
        var found = false
        let mountDeadline = Date().addingTimeInterval(15)
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
        Thread.sleep(forTimeInterval: 2.0)

        // Provider step: defer model setup — the walkthrough proves views and
        // local kernel routes, not inference.
        let configureLater = app.descendants(matching: .any).matching(
            NSPredicate(format: "label BEGINSWITH[c] 'Other / configure'")
        ).firstMatch
        if configureLater.waitForExistence(timeout: 10), configureLater.isHittable {
            configureLater.tap()
            Thread.sleep(forTimeInterval: 2.0)
        }

        // Tour step: skip.
        let skipTour = app.descendants(matching: .any).matching(
            NSPredicate(format: "label BEGINSWITH[c] 'Skip for now'")
        ).firstMatch
        if skipTour.waitForExistence(timeout: 10), skipTour.isHittable {
            skipTour.tap()
            Thread.sleep(forTimeInterval: 2.0)
        }
        attachScreenshot(named: "firstrun-10-completed")
    }

    // MARK: - Sheet / rail plumbing (same semantics as GestureSemanticsUITests)

    private func settleSheetToCollapsed(
        in app: XCUIApplication, attempts: Int = 6
    ) throws {
        for _ in 0..<attempts {
            guard let detent = markerValue(Self.detentPrefix, in: app) else {
                break
            }
            if detent == "collapsed" || detent == "pill" { return }
            if let handle = grabber(in: app), handle.isHittable {
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
        if final != "collapsed", final != "pill", final != nil {
            attachScreenshot(named: "normalize-sheet-failed")
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-normalize")
            throw XCTSkip(
                "could not settle the chat sheet (reads '\(final ?? "nil")') — "
                    + "precondition, not the walkthrough under test"
            )
        }
    }

    /// The sheet grabber (aria-label "drag up to open chat" / "drag down to
    /// close chat"). Hidden from AX while the sheet is pilled.
    private func grabber(in app: XCUIApplication) -> XCUIElement? {
        let predicate = NSPredicate(format: "label BEGINSWITH[c] 'drag'")
        let element = app.buttons.matching(predicate).firstMatch
        return element.waitForExistence(timeout: 5) ? element : nil
    }

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

    // MARK: - Probe markers

    private func markerValue(_ prefix: String, in app: XCUIApplication) -> String? {
        let predicate = NSPredicate(format: "label BEGINSWITH %@", prefix)
        let text = app.staticTexts.matching(predicate).firstMatch
        if text.exists { return String(text.label.dropFirst(prefix.count)) }
        let any = app.descendants(matching: .any).matching(predicate).firstMatch
        if any.exists { return String(any.label.dropFirst(prefix.count)) }
        return nil
    }

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
