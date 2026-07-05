import XCTest

/// Seeded launcher gesture-loop on the real iOS engine (issue #12179 WI-8).
///
/// The web/desktop lanes run the shared fast-check model loop through CDP touch;
/// WKWebView exposes no CDP surface, so this ports the AX-reachable subset of the
/// §D matrix to XCUITest: N seeded rounds of REAL home↔launcher rail gestures
/// (native touch → WKWebView pointer events → the pager), asserting after every
/// round that the `home-launcher-page:<home|launcher>` AX probe tracks the SAME
/// pure commit model the TypeScript engine uses (`fast || frac >= 0.5`, with the
/// direction guard). A committing swipe the native input pipeline drops leaves
/// the rail unmoved, so it gets a bounded, logged re-dispatch — the probe
/// assertion after it stays strict, so a genuine model/engine divergence still
/// fails. The seed comes from `ELIZA_LOOP_SEED` (default random, always attached
/// to the report) so any failure replays exactly.
///
/// Scope: rail navigation + probe stability + app-alive — the [L]/[I] subset
/// that survives in the AX tree. Tile launches (which navigate away from the
/// launcher) are covered by the scripted GestureSemanticsUITests and the
/// web/android loops, not by this page-stability loop. The old notification
/// pull-down sheet was removed on develop by #13414, so it is no longer listed
/// as a covered surface here.
///
/// Runs in the AppUITests target / lane as the boot + gesture-semantics suites:
///   node scripts/ios-device-capture.mjs --platform sim   (packages/app)
final class LauncherGestureLoopUITests: XCTestCase {

    private static let pagePrefix = "home-launcher-page:"

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSeededRailGestureLoop() throws {
        let app = XCUIApplication()
        try launchToRenderer(app)
        try settleSheetToCollapsed(in: app)
        try normalizeToHomePage(in: app)

        let env = ProcessInfo.processInfo.environment
        let seed = resolveSeed(env["ELIZA_LOOP_SEED"])
        let rounds = Int(env["ELIZA_LOOP_ACTIONS"] ?? "") ?? 60
        attachText("ELIZA_LOOP_SEED=\(seed) rounds=\(rounds)", named: "loop-seed")

        var rng = Mulberry32(seed: seed)
        var expectedPage = "home"

        for round in 0..<rounds {
            // Mirror the shared model's railSwipe arbitrary: bias toward the
            // navigating direction, random speed, drag length kept clear of the
            // 50% boundary so the commit prediction is never borderline.
            let navDir = expectedPage == "home" ? "left" : "right"
            let dir = rng.next() < 0.75 ? navDir : (navDir == "left" ? "right" : "left")
            let fast = rng.next() < 0.5
            let frac: CGFloat = fast
                ? 0.22 + CGFloat(rng.next()) * 0.28
                : (rng.next() < 0.5
                    ? 0.26 + CGFloat(rng.next()) * 0.14
                    : 0.58 + CGFloat(rng.next()) * 0.14)

            let commits = fast || frac >= 0.5
            let willNavigate =
                commits
                && ((dir == "left" && expectedPage == "home")
                    || (dir == "right" && expectedPage == "launcher"))
            let target = willNavigate
                ? (expectedPage == "home" ? "launcher" : "home")
                : expectedPage

            drive(app, dir: dir, fast: fast, frac: frac, target: target, round: round)
            expectedPage = target
        }

        attachScreenshot(named: "loop-\(rounds)-final-\(expectedPage)")
        XCTAssertNotEqual(app.state, .notRunning, "app crashed during the loop")
    }

    // MARK: - Gesture + assertion

    /// Dispatch one rail swipe and assert the probe lands on `target`. A
    /// navigating swipe the input pipeline dropped leaves the rail on the source
    /// page, so re-dispatch (bounded, logged) before the strict assertion.
    private func drive(
        _ app: XCUIApplication, dir: String, fast: Bool, frac: CGFloat,
        target: String, round: Int
    ) {
        let attempts = 3
        var landed: String?
        for attempt in 1...attempts {
            if dir == "left" {
                horizontalDrag(in: app, fromX: 0.85, toX: 0.85 - clampReach(frac), fast: fast)
            } else {
                horizontalDrag(in: app, fromX: 0.15, toX: 0.15 + clampReach(frac), fast: fast)
            }
            landed = waitForMarker(Self.pagePrefix, toEqual: target, timeout: 5, in: app)
            if landed == target { break }
            if attempt < attempts {
                attachScreenshot(named: "loop-\(round)-redispatch-\(attempt)")
            }
        }
        XCTAssertEqual(
            landed, target,
            "round \(round): a \(fast ? "fast" : "slow") \(dir) swipe (frac=\(String(format: "%.2f", frac))) "
                + "must leave the rail on '\(target)' but the probe reads "
                + "'\(landed ?? "nil")' — replay ELIZA_LOOP_SEED from loop-seed"
        )
    }

    private func clampReach(_ frac: CGFloat) -> CGFloat {
        min(max(frac, 0.15), 0.75)
    }

    /// Horizontal rail drag. Fast = a flick (crosses the velocity threshold);
    /// slow = velocity killed by a hold-before-release, so only the 50%-distance
    /// rule can commit — matching the shared model's commit prediction.
    private func horizontalDrag(
        in app: XCUIApplication, fromX: CGFloat, toX: CGFloat, fast: Bool
    ) {
        let y: CGFloat = 0.55
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: fromX, dy: y))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: toX, dy: y))
        if fast {
            start.press(
                forDuration: 0.05, thenDragTo: end,
                withVelocity: XCUIGestureVelocity(rawValue: 2000),
                thenHoldForDuration: 0)
        } else {
            start.press(
                forDuration: 0.25, thenDragTo: end, withVelocity: .slow,
                thenHoldForDuration: 0.6)
        }
        Thread.sleep(forTimeInterval: 0.3)
    }

    // MARK: - Probe markers (AX tree)

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
        _ prefix: String, toEqual expected: String, timeout: TimeInterval,
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

    // MARK: - Launch / normalize (mirrors GestureSemanticsUITests)

    private func launchWithRetry(_ app: XCUIApplication, attempts: Int = 3) {
        for attempt in 1...attempts {
            app.launch()
            if app.wait(for: .runningForeground, timeout: 20) { return }
            attachScreenshot(named: "launch-attempt-\(attempt)-not-foreground")
        }
    }

    private func launchToRenderer(_ app: XCUIApplication) throws {
        launchWithRetry(app)
        let env = ProcessInfo.processInfo.environment
        let timeout = Double(env["ELIZA_BOOT_TIMEOUT_SECONDS"] ?? "") ?? 180
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.state == .notRunning { break }
            if markerValue(Self.pagePrefix, in: app) != nil {
                completeFirstRunIfPresent(in: app)
                return
            }
            Thread.sleep(forTimeInterval: 1.0)
        }
        attachScreenshot(named: "boot-no-page-probe")
        attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-probe")
        let bootingVisible =
            app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS[c] 'Booting'")
            ).count > 0
        let rendererInteractive =
            app.state == .runningForeground && !bootingVisible
            && app.webViews.firstMatch.exists
        if rendererInteractive {
            XCTFail(
                "the renderer is interactive but never exposed the "
                    + "'home-launcher-page:' AX probe — the gesture-state channel "
                    + "is broken (see ax-hierarchy-no-probe)"
            )
        }
        throw XCTSkip(
            "boot did not reach an interactive renderer within \(Int(timeout))s "
                + "— boot coverage lives in BootCaptureUITests"
        )
    }

    private func completeFirstRunIfPresent(in app: XCUIApplication) {
        let onDevice = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == 'On this device'")
        ).firstMatch
        let mountDeadline = Date().addingTimeInterval(20)
        while Date() < mountDeadline {
            if onDevice.exists, onDevice.isHittable { break }
            Thread.sleep(forTimeInterval: 1.0)
        }
        guard onDevice.exists, onDevice.isHittable else { return }
        onDevice.tap()
        let env = ProcessInfo.processInfo.environment
        let timeout =
            Double(env["ELIZA_FIRSTRUN_TIMEOUT_SECONDS"] ?? "")
            ?? Double(env["ELIZA_AGENT_READY_TIMEOUT_SECONDS"] ?? "") ?? 240
        let hint = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] 'highlighted option'")
        ).firstMatch
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !hint.exists { return }
            Thread.sleep(forTimeInterval: 2.0)
        }
    }

    private func settleSheetToCollapsed(in app: XCUIApplication, attempts: Int = 6) throws {
        let detentPrefix = "chat-detent:"
        for _ in 0..<attempts {
            guard let detent = markerValue(detentPrefix, in: app) else { break }
            if detent == "collapsed" { return }
            if detent == "pill" {
                let pill = app.buttons["open chat"]
                if pill.exists { pill.tap() }
            } else {
                let grabber = app.buttons.matching(
                    NSPredicate(format: "label BEGINSWITH[c] 'drag'")
                ).firstMatch
                if grabber.waitForExistence(timeout: 5), grabber.isHittable {
                    let start = grabber.coordinate(
                        withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
                    let end = start.withOffset(CGVector(dx: 0, dy: 300))
                    start.press(
                        forDuration: 0.05, thenDragTo: end,
                        withVelocity: XCUIGestureVelocity(rawValue: 2000),
                        thenHoldForDuration: 0)
                } else {
                    break
                }
            }
            Thread.sleep(forTimeInterval: 1.2)
        }
        // Not fatal for the rail loop: the collapsed sheet just keeps the home
        // gesture surface clear. If it never collapses the swipes below still
        // drive the rail underneath, and a broken probe fails loudly there.
    }

    private func normalizeToHomePage(in app: XCUIApplication) throws {
        guard let page = markerValue(Self.pagePrefix, in: app) else {
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-page-probe")
            throw XCTSkip("no home-launcher-page probe in the AX tree")
        }
        if page == "home" { return }
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.20, dy: 0.55))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.80, dy: 0.55))
        start.press(
            forDuration: 0.25, thenDragTo: end, withVelocity: .slow,
            thenHoldForDuration: 0.6)
        guard
            waitForMarker(Self.pagePrefix, toEqual: "home", timeout: 5, in: app) == "home"
        else {
            throw XCTSkip("could not normalize the rail to the home page")
        }
    }

    // MARK: - Seeded PRNG (mulberry32 — matches the TS engine)

    private func resolveSeed(_ raw: String?) -> UInt32 {
        if let raw, let value = UInt32(raw) { return value }
        return UInt32.random(in: 1...UInt32.max)
    }

    private struct Mulberry32 {
        private var a: UInt32
        init(seed: UInt32) { self.a = seed }
        mutating func next() -> Double {
            a = a &+ 0x6d2b_79f5
            var t = a
            t = (t ^ (t >> 15)) &* (t | 1)
            t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
            return Double((t ^ (t >> 14))) / 4_294_967_296.0
        }
    }

    // MARK: - Attachments

    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attachText(_ body: String, named name: String) {
        let attachment = XCTAttachment(string: body)
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
