/**
 Assert-level lane for iOS extension surfaces (#13695).

 This suite is intentionally separate from WidgetGalleryCaptureUITests: the
 capture harness keeps `continueAfterFailure = true` and only produces
 screenshots, while this suite fails when an expected surface disappears.
 App-owned background and terminated-process notification delivery runs only
 on a provisioned iPhone; Action Button physical press, signing/profile faults,
 and custom-keyboard enablement remain separate device acceptance boundaries.
 */
import UserNotifications
import XCTest

final class DeviceExtensionSurfaceUITests: XCTestCase {

    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testLocalNotificationTriggerStaysFireableAcrossPermissionDelay() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let immediateDates = [
            now.addingTimeInterval(-30),
            now,
            now.addingTimeInterval(0.5),
        ]

        for fireDate in immediateDates {
            let trigger = ElizaNotificationTriggerPolicy.trigger(
                fireDate: fireDate,
                now: now
            )
            let interval = trigger as? UNTimeIntervalNotificationTrigger
            XCTAssertEqual(interval?.timeInterval, 1)
            XCTAssertEqual(interval?.repeats, false)
        }

        let future = ElizaNotificationTriggerPolicy.trigger(
            fireDate: now.addingTimeInterval(60),
            now: now,
            calendar: Calendar(identifier: .gregorian)
        )
        let calendar = future as? UNCalendarNotificationTrigger
        XCTAssertNotNil(calendar)
        XCTAssertEqual(calendar?.repeats, false)
    }

    func testFallbackNotificationPayloadSupportsCapacitorAndAppDelegateTaps() throws {
        let userInfo = ElizaNotificationTapPayload.userInfo(
            deepLink: "/notifications",
            deepLinkOnTap: "elizaos://notifications"
        )
        let extra = try XCTUnwrap(userInfo["cap_extra"] as? [String: String])

        XCTAssertEqual(extra, ["deepLink": "/notifications"])
        XCTAssertEqual(
            userInfo["deepLinkOnTap"] as? String,
            "elizaos://notifications"
        )
        XCTAssertTrue(
            ElizaNotificationTapPayload.userInfo(
                deepLink: nil,
                deepLinkOnTap: nil
            ).isEmpty
        )
        XCTAssertTrue(
            ElizaNotificationTapPayload.userInfo(
                deepLink: "//attacker.example/notifications",
                deepLinkOnTap: "javascript:alert(1)"
            ).isEmpty
        )
        for privilegedTarget in [
            "elizaos://auth/callback?code=secret",
            "elizaos://first-run/runtime/remote",
            "elizaos://connect?url=https://example.test",
            "elizaos://share?file=/private/note.txt",
            "elizaos://keyboard-dictation",
            "elizaos://aec-loop?duration=30",
            "elizaos://%61uth/callback?code=secret",
        ] {
            XCTAssertNil(
                ElizaNotificationTapPayload.userInfo(
                    deepLink: nil,
                    deepLinkOnTap: privilegedTarget
                )["deepLinkOnTap"]
            )
            XCTAssertNil(
                ElizaNotificationTapPayload.safeOpenDestination(
                    ["deepLinkOnTap": privilegedTarget]["deepLinkOnTap"]
                ),
                "Remote notification payloads must cross the same privileged-route guard as locally scheduled notifications."
            )
        }
        XCTAssertEqual(
            ElizaNotificationTapPayload.safeOpenDestination(
                ["deepLinkOnTap": "elizaos://notifications"]["deepLinkOnTap"]
            )?.absoluteString,
            "elizaos://notifications"
        )
        XCTAssertNil(
            ElizaNotificationTapPayload.safeOpenDestination(
                ["deepLinkOnTap": 42]["deepLinkOnTap"]
            )
        )
    }

    func testNotificationUITestLaunchRequiresExactOptIn() {
        XCTAssertFalse(ElizaNotificationUITestLaunchPolicy.isRequested(environment: [:]))
        XCTAssertFalse(
            ElizaNotificationUITestLaunchPolicy.isRequested(
                environment: [ElizaNotificationUITestLaunchPolicy.enabledEnvironmentKey: "true"]
            )
        )
        XCTAssertTrue(
            ElizaNotificationUITestLaunchPolicy.isRequested(
                environment: [ElizaNotificationUITestLaunchPolicy.enabledEnvironmentKey: "1"]
            )
        )
    }

    func testAppOwnedLocalNotificationDeliversFromBackground() throws {
        guard ProcessInfo.processInfo.environment["SIMULATOR_UDID"] == nil else {
            throw XCTSkip("Physical background notification evidence requires a provisioned iPhone.")
        }

        let app = launchAppSchedulingNotification()
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(
            springboard.wait(for: .runningForeground, timeout: 10),
            "SpringBoard must foreground while the app-owned local notification fires."
        )
        let notification = springboard.staticTexts[ElizaNotificationUITestLaunchPolicy.title].firstMatch
        XCTAssertTrue(
            notification.waitForExistence(timeout: 15),
            "The production scheduler must deliver a visible app-owned notification while Eliza is backgrounded."
        )
        attachElementScreenshot(
            notification,
            named: "local-notification-00-background-banner-element"
        )
        attachAccessibilitySnapshot(named: "local-notification-background-banner")
        attachScreenshot(named: "local-notification-00-background-banner")
        notification.tap()
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 15),
            "Tapping the local notification must foreground Eliza."
        )
        assertRendererSettlesAfterNotificationTap(app)
        attachAccessibilitySnapshot(of: app, named: "local-notification-background-tap")
        attachScreenshot(named: "local-notification-01-background-tap")
    }

    func testAppOwnedLocalNotificationSurvivesTermination() throws {
        guard ProcessInfo.processInfo.environment["SIMULATOR_UDID"] == nil else {
            throw XCTSkip("Physical killed-app notification evidence requires a provisioned iPhone.")
        }

        let app = launchAppSchedulingNotification()
        Thread.sleep(forTimeInterval: 1)
        app.terminate()
        XCTAssertTrue(
            springboard.wait(for: .runningForeground, timeout: 10),
            "SpringBoard must remain available after terminating Eliza."
        )
        let notification = springboard.staticTexts[ElizaNotificationUITestLaunchPolicy.title].firstMatch
        XCTAssertTrue(
            notification.waitForExistence(timeout: 15),
            "The production scheduler must deliver after the scheduling process terminates."
        )
        attachElementScreenshot(
            notification,
            named: "local-notification-02-killed-banner-element"
        )
        attachAccessibilitySnapshot(named: "local-notification-killed-banner")
        attachScreenshot(named: "local-notification-02-killed-banner")
        notification.tap()
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 15),
            "Tapping the killed-app notification must relaunch Eliza."
        )
        assertRendererSettlesAfterNotificationTap(app)
        attachAccessibilitySnapshot(of: app, named: "local-notification-killed-tap")
        attachScreenshot(named: "local-notification-03-killed-tap")
    }

    func testAppShortcutsListsV1Actions() throws {
        try launchShortcutsSearchEliza()

        XCTAssertTrue(
            shortcuts.staticTexts["Message Eliza"].firstMatch.waitForExistence(timeout: 10),
            "The installed app must publish the Message Eliza App Shortcut."
        )
        XCTAssertTrue(
            shortcuts.staticTexts["Talk to Eliza"].firstMatch.waitForExistence(timeout: 10),
            "The installed app must publish the Talk to Eliza App Shortcut."
        )

        attachScreenshot(named: "shortcuts-00-v1-actions")
        attachAccessibilitySnapshot(of: shortcuts, named: "shortcuts-v1-actions")
        XCUIDevice.shared.press(.home)
    }

    func testTalkToElizaAppShortcutForegroundsApp() throws {
        try launchShortcutsSearchEliza()
        attachAccessibilitySnapshot(of: shortcuts, named: "shortcuts-talk-before-tap")
        let talkGroup = shortcuts.otherElements["Talk to Eliza"].firstMatch
        XCTAssertTrue(
            talkGroup.waitForExistence(timeout: 10),
            "The installed Talk to Eliza App Shortcut must expose its labeled action group before invocation."
        )
        let talkButton = talkGroup.buttons["waveform"].firstMatch
        XCTAssertTrue(
            talkButton.waitForExistence(timeout: 5) && talkButton.isHittable,
            "The Talk to Eliza action group must expose its real waveform button as a hittable control."
        )
        talkButton.tap()
        try assertShortcutForegroundsRenderedApp(
            screenshotName: "shortcuts-01-talk-app-foregrounded",
            actionName: "Talk to Eliza"
        )
    }

    func testMessageElizaAppShortcutForegroundsApp() throws {
        try launchShortcutsSearchEliza()
        let messageGroup = shortcuts.otherElements["Message Eliza"].firstMatch
        XCTAssertTrue(
            messageGroup.waitForExistence(timeout: 10),
            "The installed Message Eliza App Shortcut must expose its labeled action group before invocation."
        )
        let messageButton = messageGroup.buttons["sparkles"].firstMatch
        XCTAssertTrue(
            messageButton.waitForExistence(timeout: 5) && messageButton.isHittable,
            "The Message Eliza action group must expose its real sparkles button as a hittable control."
        )
        messageButton.tap()
        try assertShortcutForegroundsRenderedApp(
            screenshotName: "shortcuts-02-message-app-foregrounded",
            actionName: "Message Eliza"
        )
    }

    func testControlCenterGalleryListsElizaControls() throws {
        guard #available(iOS 18.0, *) else {
            throw XCTSkip("Control Center controls are iOS 18+ only")
        }

        try openControlGalleryAndSearchEliza()

        XCTAssertTrue(
            springboard.staticTexts["Message Eliza"].waitForExistence(timeout: 8),
            "Control Center gallery search must list the Message Eliza control; a missing result means the ElizaWidgets appex/control registration path regressed."
        )
        XCTAssertTrue(
            springboard.staticTexts["Talk to Eliza"].waitForExistence(timeout: 8),
            "Control Center gallery search must list the Talk to Eliza control; a missing result means the ElizaWidgets appex/control registration path regressed."
        )

        attachAccessibilitySnapshot(named: "control-gallery-eliza-results")
        goHome()
    }

    func testMessageControlForegroundsApp() throws {
        try assertControlForegroundsApp(
            galleryIdentifier: "ElizaAskControl",
            label: "Message Eliza",
            screenshotPrefix: "control-message"
        )
    }

    func testVoiceControlForegroundsApp() throws {
        try assertControlForegroundsApp(
            galleryIdentifier: "ElizaVoiceControl",
            label: "Talk to Eliza",
            screenshotPrefix: "control-voice"
        )
    }

    private func assertControlForegroundsApp(
        galleryIdentifier: String,
        label: String,
        screenshotPrefix: String
    ) throws {
        guard #available(iOS 18.0, *) else {
            throw XCTSkip("Control Center controls are iOS 18+ only")
        }

        try openControlGalleryAndSearchEliza()
        let galleryControl = springboard.buttons[galleryIdentifier]
        XCTAssertTrue(
            galleryControl.waitForExistence(timeout: 8),
            "The Eliza controls gallery must expose \(label) before it can be installed."
        )
        galleryControl.tap()
        Thread.sleep(forTimeInterval: 1.5)
        attachScreenshot(named: "\(screenshotPrefix)-00-installed")

        springboard
            .coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.72))
            .tap()
        Thread.sleep(forTimeInterval: 1.0)
        let installedControl = springboard.icons[label].firstMatch
        XCTAssertTrue(
            installedControl.waitForExistence(timeout: 8) && installedControl.isHittable,
            "The installed \(label) control must be tappable after Control Center exits edit mode."
        )
        installedControl.tap()

        let app = XCUIApplication()
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 15),
            "Tapping \(label) must foreground the containing app."
        )
        attachScreenshot(named: "\(screenshotPrefix)-01-app-foregrounded")
    }

    func testHomeScreenWidgetTapForegroundsApp() throws {
        try installHomeScreenWidgetFromGallery()

        let ask = springboard.staticTexts["Message Eliza"].firstMatch
        XCTAssertTrue(
            ask.waitForExistence(timeout: 8),
            "The Eliza home-screen widget must expose the Message Eliza quick action after being added from the widget gallery."
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

    func testKeyboardDictationStartsAndEndsLiveActivityOnDevice() throws {
        guard ProcessInfo.processInfo.environment["SIMULATOR_UDID"] == nil else {
            throw XCTSkip("Real microphone and Dynamic Island evidence requires a provisioned iPhone.")
        }
        guard #available(iOS 16.4, *) else {
            throw XCTSkip("Opening the keyboard-dictation deep link requires iOS 16.4 or newer.")
        }
        let app = XCUIApplication()
        let session = UUID().uuidString
        let deepLink = try XCTUnwrap(
            URL(string: "elizaos://keyboard-dictation?source=ios-keyboard&session=\(session)")
        )

        app.open(deepLink)
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 20),
            "The keyboard dictation handoff must foreground the signed Eliza app."
        )
        allowContextualPermissionPromptsIfPresent()
        XCTAssertTrue(
            app.otherElements["Keyboard dictation, web dialog"].waitForExistence(timeout: 20),
            "The real keyboard dictation route must expose its accessible recording dialog."
        )
        XCTAssertTrue(
            app.staticTexts["Listening… speak now."].waitForExistence(timeout: 10),
            "Keyboard dictation must reach its truthful listening state before ActivityKit evidence is captured."
        )
        attachScreenshot(named: "keyboard-dictation-00-listening")

        XCUIDevice.shared.press(.home)
        XCTAssertTrue(
            springboard.wait(for: .runningForeground, timeout: 10),
            "SpringBoard must foreground before the Dynamic Island surface is inspected."
        )
        springboard
            .coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.04))
            .press(forDuration: 1.0)
        XCTAssertTrue(
            springboard.staticTexts["Keyboard dictation"].waitForExistence(timeout: 10),
            "The expanded Dynamic Island must render the real keyboard-dictation Live Activity."
        )
        XCTAssertTrue(
            springboard.staticTexts["Recording"].waitForExistence(timeout: 5),
            "The Live Activity must truthfully expose its recording phase."
        )
        attachAccessibilitySnapshot(named: "keyboard-dictation-live-activity")
        attachScreenshot(named: "keyboard-dictation-01-live-activity")

        app.activate()
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 10),
            "Eliza must return foreground so the dictation session can be cancelled cleanly."
        )
        let cancel = app.buttons["Cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 10) && cancel.isHittable)
        cancel.tap()
        XCUIDevice.shared.press(.home)
        _ = springboard.wait(for: .runningForeground, timeout: 10)
        XCTAssertFalse(
            springboard.staticTexts["Keyboard dictation"].waitForExistence(timeout: 5),
            "Cancelling keyboard dictation must end and remove the Live Activity."
        )
        attachScreenshot(named: "keyboard-dictation-02-ended")
    }

    func testElizaKeyboardAppearsInSystemPicker() throws {
        guard ProcessInfo.processInfo.environment["SIMULATOR_UDID"] == nil else {
            throw XCTSkip("Custom-keyboard enablement requires a provisioned iPhone.")
        }

        shortcuts.launch()
        XCTAssertTrue(
            shortcuts.wait(for: .runningForeground, timeout: 15),
            "Apple Shortcuts must foreground before the system keyboard picker can be inspected."
        )
        let search = shortcuts.searchFields.firstMatch
        XCTAssertTrue(
            search.waitForExistence(timeout: 10),
            "Apple Shortcuts must expose a text field that can host the installed keyboard extension."
        )
        search.tap()
        let dictate = shortcuts.buttons["Dictate with Eliza"].firstMatch
        let keyboard = shortcuts.keyboards.firstMatch
        let activeElizaNextKeyboard = keyboardInputModeButton(in: shortcuts)
        XCTAssertTrue(
            keyboard.waitForExistence(timeout: 2)
                || dictate.waitForExistence(timeout: 8),
            "The focused field must present either the system keyboard or the already-selected Eliza keyboard."
        )
        if dictate.exists {
            XCTAssertTrue(
                activeElizaNextKeyboard.waitForExistence(timeout: 5)
                    && activeElizaNextKeyboard.isHittable,
                "An already-selected Eliza keyboard must expose the system input-mode switcher."
            )
            activeElizaNextKeyboard.tap()
            XCTAssertTrue(
                keyboard.waitForExistence(timeout: 5),
                "Cycling away from Eliza must restore the system keyboard before the extension is reselected."
            )
        }
        // iOS exposes these controls as siblings of the Keyboard element on
        // current devices, so query the owning application rather than the
        // keyboard subtree.
        let inputModePicker = keyboardInputModeButton(in: shortcuts)
        attachAccessibilitySnapshot(of: shortcuts, named: "keyboard-extension-picker-before-open")
        XCTAssertTrue(
            inputModePicker.waitForExistence(timeout: 5) && inputModePicker.isHittable,
            "The system keyboard must expose its input-mode picker as Next keyboard or Emoji."
        )
        inputModePicker.press(forDuration: 1.0)

        let elizaMode = shortcuts.cells.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "Eliza Keyboard")
        ).firstMatch
        XCTAssertTrue(
            elizaMode.waitForExistence(timeout: 5) && elizaMode.isHittable,
            "The provisioned ElizaKeyboard extension must be enabled in iOS Settings before device acceptance."
        )
        elizaMode.tap()
        let fullAccessWarning = shortcuts.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH[c] %@", "Allow Full Access")
        ).firstMatch
        XCTAssertTrue(
            dictate.waitForExistence(timeout: 10),
            "Selecting Eliza from the system picker must render the real custom keyboard extension."
        )

        attachAccessibilitySnapshot(of: shortcuts, named: "keyboard-extension-selected")
        attachScreenshot(named: "keyboard-extension-selected")
        let fullAccessIsMissing = fullAccessWarning.exists
        let restoreSystemKeyboard = keyboardInputModeButton(in: shortcuts)
        if restoreSystemKeyboard.waitForExistence(timeout: 2), restoreSystemKeyboard.isHittable {
            restoreSystemKeyboard.tap()
        }
        XCTAssertFalse(
            fullAccessIsMissing,
            "Device acceptance requires Full Access so the Eliza keyboard can reach the containing app for dictation."
        )
    }

    private func keyboardInputModeButton(in application: XCUIApplication) -> XCUIElement {
        application.descendants(matching: .button).matching(
            NSPredicate(
                format: "label ==[c] %@ OR identifier ==[c] %@ OR label ==[c] %@ OR identifier ==[c] %@",
                "Next keyboard",
                "Next keyboard",
                "Emoji",
                "emoji"
            )
        ).firstMatch
    }

    // MARK: - Control Center controls

    private func launchShortcutsSearchEliza() throws {
        shortcuts.launch()
        XCTAssertTrue(
            shortcuts.wait(for: .runningForeground, timeout: 15),
            "Apple Shortcuts must launch before the installed Eliza App Shortcuts can be inspected."
        )

        let search = shortcuts.searchFields.firstMatch
        XCTAssertTrue(
            search.waitForExistence(timeout: 10),
            "Apple Shortcuts must expose its library search field."
        )
        search.tap()
        let clearText = search.buttons["Clear text"]
        if clearText.waitForExistence(timeout: 1) {
            clearText.tap()
        }
        search.typeText("Eliza")
    }

    private func assertShortcutForegroundsRenderedApp(
        screenshotName: String,
        actionName: String
    ) throws {
        let app = XCUIApplication()
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 15),
            "Running \(actionName) from Apple Shortcuts must foreground the signed Eliza app."
        )
        XCTAssertTrue(
            shortcuts.wait(for: .runningBackground, timeout: 10),
            "Running \(actionName) must finish the Shortcuts-to-Eliza transition before evidence is captured."
        )
        XCTAssertTrue(
            app.webViews.firstMatch.waitForExistence(timeout: 20),
            "Running \(actionName) must expose Eliza's rendered web view, not only start its process."
        )
        attachAccessibilitySnapshot(of: app, named: "\(screenshotName)-ax")
        attachScreenshot(named: screenshotName)
    }

    private func allowContextualPermissionPromptsIfPresent() {
        for _ in 0..<3 {
            let allow = springboard.buttons["Allow"].firstMatch
            guard allow.waitForExistence(timeout: 2), allow.isHittable else { return }
            allow.tap()
        }
    }

    private func launchAppSchedulingNotification() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment[ElizaNotificationUITestLaunchPolicy.enabledEnvironmentKey] = "1"
        app.launch()
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 20),
            "The signed Eliza app must launch before scheduling the native notification."
        )
        allowContextualPermissionPromptsIfPresent()
        return app
    }

    private func assertRendererSettlesAfterNotificationTap(_ app: XCUIApplication) {
        XCTAssertTrue(
            app.webViews.firstMatch.waitForExistence(timeout: 20),
            "A notification tap must reach Eliza's rendered web view."
        )
        let booting = app.staticTexts["Booting up…"]
        if booting.exists {
            XCTAssertTrue(
                booting.waitForNonExistence(timeout: 20),
                "The relaunched app must settle beyond its transient boot screen."
            )
        }
        let stableLabels = [
            "Sign in",
            "Sign in with your password.",
            "How can I help?",
            "Connected",
            "Message Eliza",
            "Can't connect",
        ]
        let stableSurface = app.descendants(matching: .any).matching(
            NSPredicate(format: "label IN %@", stableLabels)
        ).firstMatch
        XCTAssertTrue(
            stableSurface.waitForExistence(timeout: 20),
            "A notification tap must settle on a real signed-out, authenticated, or explicit error surface, not a blank transition frame."
        )
        Thread.sleep(forTimeInterval: 0.5)
    }

    @available(iOS 18.0, *)
    private func openControlGalleryAndSearchEliza() throws {
        goHome()
        openControlCenter()
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
        let clearText = search.buttons["Clear text"]
        if clearText.waitForExistence(timeout: 1) {
            clearText.tap()
            XCTAssertTrue(
                waitForValueToClear(search, timeout: 3),
                "Control Center must clear its retained gallery query before the harness types a fresh Eliza search."
            )
        }
        search.typeText("Eliza")
        Thread.sleep(forTimeInterval: 2.0)
        attachScreenshot(named: "control-assert-03-gallery-search-eliza")
    }

    private func openControlCenter() {
        let pull = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.02))
        pull.press(
            forDuration: 0.1,
            thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.6))
        )
        Thread.sleep(forTimeInterval: 1.5)
    }

    private func waitForValueToClear(
        _ element: XCUIElement,
        timeout: TimeInterval
    ) -> Bool {
        let emptyValue = NSPredicate { object, _ in
            guard let element = object as? XCUIElement else { return false }
            let value = (element.value as? String) ?? ""
            return value.isEmpty || value == element.placeholderValue
        }
        let expectation = XCTNSPredicateExpectation(
            predicate: emptyValue,
            object: element
        )
        return XCTWaiter.wait(
            for: [expectation],
            timeout: timeout
        ) == .completed
    }

    // MARK: - Brand-aware display name

    /// The installed target application's real accessibility label.
    ///
    /// Reads the host app's `label` (which mirrors `CFBundleDisplayName` /
    /// `ELIZA_DISPLAY_NAME` from `app.config.ts`) so the test stays aligned
    /// with the build's actual display name and preserves white-label support.
    /// Based on NubsCarson:c21d9237 — do not silently substitute a canonical
    /// brand when the label is unavailable; fail fast per the repository's
    /// unavailable-state policy.
    private func widgetAppDisplayName() throws -> String {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(
            app.wait(for: .runningForeground, timeout: 15),
            "Installed app must be running before XCUITest can read its display label."
        )

        let label = app.label.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = try XCTUnwrap(
            label.isEmpty ? nil : label,
            "Installed app must have a non-empty display label (CFBundleDisplayName/ELIZA_DISPLAY_NAME)."
        )
        try grantLocalNetworkPermissionIfPresent()
        return displayName
    }

    /// Clears only the development remote-Mac lane's Local Network sheet before
    /// handing control to SpringBoard. Leaving it presented makes Home-screen
    /// presses target the permission sheet instead of entering jiggle mode.
    private func grantLocalNetworkPermissionIfPresent() throws {
        let copy = springboard.descendants(matching: .any).matching(
            NSPredicate(format: "label CONTAINS[c] 'local networks'")
        ).firstMatch
        let deadline = Date().addingTimeInterval(8)
        while Date() < deadline {
            guard copy.exists else { return }
            let allow = springboard.alerts.buttons["Allow"]
            if allow.exists, allow.isHittable {
                attachScreenshot(named: "widget-local-network-permission")
                allow.tap()
            }
            Thread.sleep(forTimeInterval: 0.25)
        }
        XCTAssertFalse(
            copy.exists,
            "The Local Network sheet must dismiss before the widget flow operates SpringBoard."
        )
    }

    // MARK: - Home/Lock Screen widget

    private func installHomeScreenWidgetFromGallery() throws {
        // XCUIApplication.label cannot be snapshotted after SpringBoard sends
        // the app to the background, so resolve the required build identity
        // while the installed target is running and carry it into the flow.
        let displayName = try widgetAppDisplayName()
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
        search.typeText(displayName)
        Thread.sleep(forTimeInterval: 2.0)
        attachScreenshot(named: "widget-assert-02-gallery-search-eliza")

        let appRow = springboard.staticTexts[displayName].firstMatch
        XCTAssertTrue(appRow.waitForExistence(timeout: 8), "Widget gallery search must list \(displayName)")
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

    private func attachElementScreenshot(
        _ element: XCUIElement,
        named name: String
    ) {
        let attachment = XCTAttachment(screenshot: element.screenshot())
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

    private func attachAccessibilitySnapshot(
        of application: XCUIApplication,
        named name: String
    ) {
        let attachment = XCTAttachment(string: application.debugDescription)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
