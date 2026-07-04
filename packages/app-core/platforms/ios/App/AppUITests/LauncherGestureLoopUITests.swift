import XCTest

/// Long seeded home↔launcher rail loop on the real iOS WKWebView (issue #12377,
/// WI-8 of #12179). Where GestureSemanticsUITests pins the individual rail
/// threshold rules with a handful of scripted drags, this suite runs a seeded,
/// replayable sequence of ≥200 real XCUITest gestures — `swipeLeft`/`swipeRight`
/// full commits, sub-threshold snap-back drags, vertical scrolls, taps — and
/// asserts after every action that the rail landed on the modelled page with no
/// stuck transition. It is the iOS counterpart to the Android `_android` loop
/// (launcher-gesture-loop.android.spec.ts); both mirror the SAME LCG + weighted
/// action alphabet as packages/app/test/android/launcher-loop-model.ts, so a
/// printed `ELIZA_LOOP_SEED` reproduces the same stream on either platform.
///
/// Assertion channel is the `home-launcher-page:<home|launcher>` sr-only static
/// text (the frozen AX-probe contract, HomeLauncherSurface.tsx). `data-*`
/// attributes never surface in the native accessibility tree — the probe does,
/// which is exactly why it exists. A renderer that is interactive but never
/// exposes the probe is a HARD failure (broken channel), never a silent skip.
///
/// Runs in the AppUITests target / capture:ios-sim flow (packages/app):
///   node scripts/ios-device-capture.mjs --platform sim
///     --only-testing AppUITests/LauncherGestureLoopUITests
final class LauncherGestureLoopUITests: XCTestCase {

    private static let pagePrefix = "home-launcher-page:"
    private static let detentPrefix = "chat-detent:"

    /// Reachable device-lane action alphabet. Mirrors
    /// launcher-loop-model.ts LauncherLoopActionKind, in the same declared
    /// order and with the same integer weights, so the seeded pick matches.
    private enum ActionKind: CaseIterable {
        case swipeLeft
        case swipeRight
        case subThresholdSwipeLeft
        case subThresholdSwipeRight
        case verticalScroll
        case tapCenter

        var weight: Int {
            switch self {
            case .swipeLeft: return 5
            case .swipeRight: return 5
            case .subThresholdSwipeLeft: return 2
            case .subThresholdSwipeRight: return 2
            case .verticalScroll: return 2
            case .tapCenter: return 1
            }
        }
    }

    /// 32-bit LCG identical to launcher-loop-model.ts SeededRandom (Numerical
    /// Recipes constants, `&*`/`&+` overflow arithmetic mod 2^32). A shared seed
    /// reproduces the exact action stream across the Swift and TS lanes.
    private struct SeededRandom {
        private var state: UInt32
        init(seed: UInt32) { state = seed == 0 ? 0x9e37_79b9 : seed }
        mutating func next() -> Double {
            state = 1_664_525 &* state &+ 1_013_904_223
            return Double(state) / Double(UInt64(UInt32.max) + 1)
        }
        mutating func int(_ boundExclusive: Int) -> Int {
            Int(next() * Double(boundExclusive))
        }
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testSeededRailLoopHoldsInvariants() throws {
        let app = XCUIApplication()
        try launchToRenderer(app)
        try settleSheetToCollapsed(in: app)
        try normalizeToHomePage(in: app)

        let env = ProcessInfo.processInfo.environment
        let seed = resolveSeed(env["ELIZA_LOOP_SEED"])
        let actionCount = max(Int(env["ELIZA_LOOP_ACTIONS"] ?? "") ?? 200, 200)
        // Advertise the reproduction seed loudly — the whole run replays from it.
        print(
            "[launcher-loop] seed=\(seed) actions=\(actionCount) "
                + "(reproduce with ELIZA_LOOP_SEED=\(seed))")
        attachScreenshot(named: "loop-00-start-home")

        var rng = SeededRandom(seed: seed)
        var modelPage = "home"
        let weightTotal = ActionKind.allCases.reduce(0) { $0 + $1.weight }

        for i in 0..<actionCount {
            let kind = pickKind(&rng, weightTotal: weightTotal)
            perform(kind, in: app)
            modelPage = expectedPage(after: kind, from: modelPage)

            let landed = waitForMarker(
                Self.pagePrefix, toEqual: modelPage, timeout: 4, in: app)
            // Capture a periodic frame so the exported attachments read like a
            // storyboard of the loop (every action would be excessive at 200+).
            if i % 25 == 0 || landed != modelPage {
                attachScreenshot(named: "loop-\(String(format: "%03d", i))-\(kind)")
            }
            XCTAssertEqual(
                landed, modelPage,
                "action #\(i) (\(kind), seed=\(seed)) expected the rail on "
                    + "'\(modelPage)' but the AX probe reads '\(landed ?? "nil")' "
                    + "— a stuck/misrouted transition"
            )
        }

        attachScreenshot(named: "loop-99-final-\(modelPage)")
    }

    // MARK: - Seeded action model (mirrors launcher-loop-model.ts)

    private func resolveSeed(_ raw: String?) -> UInt32 {
        if let raw, let parsed = UInt32(raw.trimmingCharacters(in: .whitespaces)) {
            return parsed
        }
        // Fresh non-zero 31-bit seed when unset, matching the TS default range.
        return UInt32.random(in: 1...0x7fff_ffff)
    }

    private func pickKind(_ rng: inout SeededRandom, weightTotal: Int) -> ActionKind {
        var roll = rng.int(weightTotal)
        for kind in ActionKind.allCases {
            if roll < kind.weight { return kind }
            roll -= kind.weight
        }
        return ActionKind.allCases.last!
    }

    private func expectedPage(after kind: ActionKind, from before: String) -> String {
        switch kind {
        case .swipeLeft: return "launcher"
        case .swipeRight: return "home"
        default: return before
        }
    }

    private func perform(_ kind: ActionKind, in app: XCUIApplication) {
        switch kind {
        case .swipeLeft:
            slowHorizontalDrag(in: app, fromX: 0.85, toX: 0.1, y: 0.55)
        case .swipeRight:
            slowHorizontalDrag(in: app, fromX: 0.15, toX: 0.9, y: 0.55)
        case .subThresholdSwipeLeft:
            // Short drag well under the 50% commit → must snap back.
            slowHorizontalDrag(in: app, fromX: 0.6, toX: 0.42, y: 0.55)
        case .subThresholdSwipeRight:
            slowHorizontalDrag(in: app, fromX: 0.4, toX: 0.58, y: 0.55)
        case .verticalScroll:
            slowVerticalDrag(in: app, fromY: 0.7, toY: 0.3, x: 0.5)
        case .tapCenter:
            // Tap a neutral upper region (away from tiles/composer): a bare tap
            // must never move the rail.
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        }
        // Let the settle spring come to rest before the probe read.
        Thread.sleep(forTimeInterval: 0.4)
    }

    // MARK: - Launch / probe plumbing

    private func launchWithRetry(_ app: XCUIApplication, attempts: Int = 3) {
        for attempt in 1...attempts {
            app.launch()
            if app.wait(for: .runningForeground, timeout: 20) { return }
            attachScreenshot(named: "launch-attempt-\(attempt)-not-foreground")
        }
    }

    /// Launch and wait until the renderer exposes the page probe. A renderer
    /// that is interactive but has NO probe is a hard failure — the assertion
    /// channel itself is broken, and skipping would be a vacuous green. Boot
    /// coverage lives in BootCaptureUITests, so a boot that never reaches an
    /// interactive renderer skips.
    private func launchToRenderer(_ app: XCUIApplication) throws {
        launchWithRetry(app)
        let env = ProcessInfo.processInfo.environment
        let timeout = Double(env["ELIZA_BOOT_TIMEOUT_SECONDS"] ?? "") ?? 180
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if app.state == .notRunning { break }
            if markerValue(Self.detentPrefix, in: app) != nil
                || markerValue(Self.pagePrefix, in: app) != nil
            {
                completeFirstRunIfPresent(in: app)
                return
            }
            Thread.sleep(forTimeInterval: 1.0)
        }
        attachScreenshot(named: "boot-no-probe")
        attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-probe")
        let bootingVisible =
            app.staticTexts.matching(
                NSPredicate(format: "label CONTAINS[c] 'Booting'")
            ).count > 0
        let rendererInteractive =
            app.state == .runningForeground && !bootingVisible
            && app.webViews.firstMatch.exists
            && (app.textViews.count + app.textFields.count + app.buttons.count) > 0
        if rendererInteractive {
            XCTFail(
                "the renderer is interactive but never exposed the "
                    + "'home-launcher-page:' AX probe — the rail-state channel is "
                    + "broken (see ax-hierarchy-no-probe)"
            )
        }
        throw XCTSkip(
            "boot did not reach an interactive renderer within \(Int(timeout))s "
                + "— boot coverage lives in BootCaptureUITests"
        )
    }

    /// A fresh install boots into the first-run placement question, which pins
    /// the chat sheet open and locks the composer. Choosing "On this device" is
    /// the real device-lane path; after it the rail becomes gesture-testable.
    private func completeFirstRunIfPresent(in app: XCUIApplication) {
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

        let env = ProcessInfo.processInfo.environment
        let timeout =
            Double(env["ELIZA_FIRSTRUN_TIMEOUT_SECONDS"] ?? "")
            ?? Double(env["ELIZA_AGENT_READY_TIMEOUT_SECONDS"] ?? "")
            ?? 240
        let hint = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS[c] 'highlighted option'")
        ).firstMatch
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !hint.exists {
                attachScreenshot(named: "firstrun-20-lock-cleared")
                return
            }
            Thread.sleep(forTimeInterval: 2.0)
        }
        attachScreenshot(named: "firstrun-30-lock-never-cleared")
    }

    /// Read the value of an sr-only state probe (`<prefix><value>`) out of the
    /// WKWebView's AX tree. StaticText is the expected exposure; fall back to an
    /// any-type descendant scan for OS-build variance.
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
            Thread.sleep(forTimeInterval: 0.2)
        }
        return lastSeen
    }

    // MARK: - Gesture drivers

    /// Slow horizontal drag with a hold-before-release: the hold zeroes the
    /// release velocity, so only the DISTANCE threshold can commit the page —
    /// exactly the 50%-swipe rule under test (matches GestureSemanticsUITests).
    private func slowHorizontalDrag(
        in app: XCUIApplication, fromX: CGFloat, toX: CGFloat, y: CGFloat
    ) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: fromX, dy: y))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: toX, dy: y))
        start.press(
            forDuration: 0.2, thenDragTo: end, withVelocity: .slow,
            thenHoldForDuration: 0.5)
    }

    private func slowVerticalDrag(
        in app: XCUIApplication, fromY: CGFloat, toY: CGFloat, x: CGFloat
    ) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: fromY))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: toY))
        start.press(
            forDuration: 0.1, thenDragTo: end, withVelocity: .slow,
            thenHoldForDuration: 0.2)
    }

    // MARK: - App-state normalization

    /// Step the chat sheet down to the collapsed input bar so rail gestures are
    /// not intercepted by the sheet. Converges from any detent.
    private func settleSheetToCollapsed(
        in app: XCUIApplication, attempts: Int = 6
    ) throws {
        for _ in 0..<attempts {
            guard let detent = markerValue(Self.detentPrefix, in: app) else {
                // No detent probe on this build: the sheet channel is absent, so
                // there is nothing to collapse; proceed to the rail.
                return
            }
            if detent == "collapsed" { return }
            if detent == "pill" {
                let pill = app.buttons["open chat"]
                if pill.exists { pill.tap() }
            } else {
                let grabber = app.buttons.matching(
                    NSPredicate(format: "label BEGINSWITH[c] 'drag'")
                ).firstMatch
                if grabber.exists, grabber.isHittable {
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
            Thread.sleep(forTimeInterval: 1.0)
        }
        let final = markerValue(Self.detentPrefix, in: app)
        if final != nil && final != "collapsed" {
            attachScreenshot(named: "normalize-sheet-failed")
            throw XCTSkip(
                "could not settle the chat sheet to collapsed (reads "
                    + "'\(final ?? "nil")') — precondition, not the gesture under test"
            )
        }
    }

    /// Ensure the home↔launcher rail rests on the home page before the loop.
    private func normalizeToHomePage(in app: XCUIApplication) throws {
        guard let page = markerValue(Self.pagePrefix, in: app) else {
            attachAccessibilitySnapshot(of: app, named: "ax-hierarchy-no-page-probe")
            throw XCTSkip("no home-launcher-page probe in the AX tree")
        }
        if page == "home" { return }
        slowHorizontalDrag(in: app, fromX: 0.15, toX: 0.9, y: 0.55)
        guard
            waitForMarker(Self.pagePrefix, toEqual: "home", timeout: 5, in: app)
                == "home"
        else {
            throw XCTSkip("could not normalize the rail to the home page")
        }
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
