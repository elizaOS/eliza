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

}

extension AppDelegate: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }
}
