import UIKit
import Capacitor
import CapacitorBackgroundRunner
import ObjectiveC
import UserNotifications
#if canImport(ElizaosCapacitorBunRuntime)
import ElizaosCapacitorBunRuntime
#endif

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Boot-trace sink first: every later stage (watchdog, Agent plugin,
        // renderer poll) appends to Documents/eliza-boot-trace.jsonl so an
        // unattended launch (icon tap / XCUITest) is fully observable via
        // `devicectl device copy from` — no console required.
        ElizaStartupTrace.bootstrap()
        ElizaHomeIndicator.install()

        // Brand tint on native surfaces the WebView can't reach. elizaOS ships
        // orange as its single accent and never blue; without an app tint iOS
        // falls back to system blue for system-presented UIKit — the deep-link
        // "Open in Eliza?" UIAlertController buttons (verified blue on device),
        // share sheets, and any default-tinted control. #FF5800 mirrors shared
        // brand `--eliza-brand-orange`. Appearance proxy covers windows created
        // later; the direct set covers the Capacitor key window already up.
        let elizaBrandOrange = UIColor(red: 1.0, green: 0x58 / 255.0, blue: 0.0, alpha: 1.0)
        UIWindow.appearance().tintColor = elizaBrandOrange
        window?.tintColor = elizaBrandOrange

        UNUserNotificationCenter.current().delegate = self
        BackgroundRunnerPlugin.registerBackgroundTask()
        BackgroundRunnerPlugin.handleApplicationDidFinishLaunching(launchOptions: launchOptions)

        // Local-agent crash/restart supervisor — the iOS parity equivalent of
        // Android's ElizaAgentService watchdog (issue #10197). Dormant until a
        // local agent is running; a no-op in cloud/remote mode. See AgentWatchdog.swift.
        AgentWatchdog.shared.bootstrap()

        // APNs registration is gated on a build-time Info.plist flag
        // (ELIZA_APNS_ENABLED=1). Registration does not request alert
        // authorization; visible notification prompts are handled by the
        // canonical permission flow when the user activates that feature.
        let apnsEnabled = Bundle.main.object(forInfoDictionaryKey: "ELIZA_APNS_ENABLED") as? String == "1"
        if apnsEnabled {
            registerForPushNotifications(application: application)
        }
        return true
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    /// Background `URLSession` relaunch hook. iOS wakes the app in the
    /// background when the on-device model download (#11841) finishes while the
    /// app is suspended; it hands us a completion handler that must be invoked
    /// once every queued session delegate event has been delivered. Forward it
    /// to the runtime's background-download bridge, which owns that session and
    /// calls the handler from `urlSessionDidFinishEvents`.
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        #if canImport(ElizaosCapacitorBunRuntime)
        BackgroundDownloadBridge.shared.handleEventsForBackgroundURLSession(
            identifier: identifier,
            completionHandler: completionHandler
        )
        #else
        completionHandler()
        #endif
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

    private func registerForPushNotifications(application: UIApplication) {
        DispatchQueue.main.async {
            application.registerForRemoteNotifications()
        }
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let tokenHex = deviceToken.map { String(format: "%02x", $0) }.joined()
        NSLog("[ElizaCompanion] APNs device token registered (%d bytes)", deviceToken.count)
        NotificationCenter.default.post(
            name: Notification.Name("ElizaCompanionApnsToken"),
            object: nil,
            userInfo: ["tokenHex": tokenHex]
        )
        // `@capacitor/push-notifications` observes `Notification.Name.capacitorDidRegisterForRemoteNotifications`
        // and reads the device token from `notification.object` (Data or String). Include hex in userInfo for debugging.
        NotificationCenter.default.post(
            name: .capacitorDidRegisterForRemoteNotifications,
            object: deviceToken,
            userInfo: ["token": tokenHex]
        )
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        NSLog("[ElizaCompanion] APNs registration failed: %@", error.localizedDescription)
        NotificationCenter.default.post(
            name: .capacitorDidFailToRegisterForRemoteNotifications,
            object: error,
            userInfo: ["error": error.localizedDescription]
        )
    }

    /// Silent-push wake handler.
    ///
    /// Contract: APNs sends a `content-available: 1` push with arbitrary JSON
    /// userInfo. We forward the userInfo to the ElizaTasks Capacitor plugin
    /// through an `ElizaCompanionRemotePush` NotificationCenter notification.
    /// The plugin observes that and emits a `wake` event of kind `remote-push`
    /// to the JS layer (mirrored shape with the BGTaskScheduler-driven wakes).
    ///
    /// We complete the iOS fetch handler immediately with `.newData` when
    /// userInfo is non-empty, otherwise `.noData`. The actual delivery work
    /// happens via the same `/api/internal/wake` loopback path the BG-task
    /// runner uses, so durability is owned by the agent runtime, not this
    /// handler. iOS gives us ~30s before force-killing; we beat that with
    /// fire-and-forget.
    ///
    /// Default off: APNs registration is gated on `ELIZA_APNS_ENABLED=1` in
    /// Info.plist. This method still runs if a push lands while the flag is
    /// off (an out-of-band APNs route), but no token is ever returned to the
    /// server, so in practice no push is delivered.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        // Strip the `aps` envelope before forwarding — the JS layer only
        // wants the developer-controlled payload keys.
        var payload: [AnyHashable: Any] = userInfo
        payload.removeValue(forKey: "aps")

        NSLog(
            "[ElizaCompanion] APNs remote notification received (%d non-aps keys)",
            payload.count
        )
        NotificationCenter.default.post(
            name: Notification.Name("ElizaCompanionRemotePush"),
            object: userInfo,
            userInfo: nil
        )
        // Keep a raw notification hook for any Capacitor push integration
        // that observes remote-push payloads. Capacitor 8 exposes typed
        // constants for registration success/failure only.
        NotificationCenter.default.post(
            name: Notification.Name("CapacitorDidReceiveRemoteNotificationNotification"),
            object: userInfo
        )

        completionHandler(payload.isEmpty ? .noData : .newData)
    }
}

extension AppDelegate: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    /// Deep-link-on-tap handler. `ElizaIntentPlugin.scheduleAlarm` (and any
    /// other intent that schedules a local notification) may stash a
    /// `deepLinkOnTap` URL in the `UNNotificationContent.userInfo`. When the
    /// user taps the notification, we open that URL via `UIApplication.open`
    /// so the app routes to the correct surface (chat, alarm detail, etc.).
    ///
    /// We always call `completionHandler()` — the OS expects it within
    /// 30 seconds, and we don't have any visible work to do here.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        if let urlString = userInfo["deepLinkOnTap"] as? String,
           let url = URL(string: urlString) {
            NSLog("[ElizaCompanion] Notification tapped — opening deep link: %@", urlString)
            DispatchQueue.main.async {
                UIApplication.shared.open(url, options: [:], completionHandler: nil)
            }
        }
        completionHandler()
    }
}

/// Auto-hides the iOS home indicator (the bottom "pull" bar) so it doesn't sit
/// over the floating chat composer. `CAPBridgeViewController` overrides
/// `prefersHomeIndicatorAutoHidden` as non-`open`, so an app-module subclass
/// cannot override it; instead we swizzle the getter on the Capacitor bridge
/// controller to return `true`. iOS still reveals the indicator on the next
/// upward swipe — it cannot be permanently removed, only auto-hidden while the
/// app is in use. Installed once from `didFinishLaunchingWithOptions`, before
/// the bridge view controller first appears.
enum ElizaHomeIndicator {
    private static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true
        let cls = CAPBridgeViewController.self
        guard
            let original = class_getInstanceMethod(
                cls,
                #selector(getter: UIViewController.prefersHomeIndicatorAutoHidden)
            ),
            let replacement = class_getInstanceMethod(
                cls,
                #selector(getter: CAPBridgeViewController.eliza_prefersHomeIndicatorAutoHidden)
            )
        else { return }
        method_exchangeImplementations(original, replacement)
    }
}

extension CAPBridgeViewController {
    @objc var eliza_prefersHomeIndicatorAutoHidden: Bool { true }
}
