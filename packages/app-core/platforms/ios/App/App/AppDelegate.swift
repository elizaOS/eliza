import UIKit
import Capacitor
import CapacitorBackgroundRunner
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        BackgroundRunnerPlugin.registerBackgroundTask()
        BackgroundRunnerPlugin.handleApplicationDidFinishLaunching(launchOptions: launchOptions)

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
