import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        UNUserNotificationCenter.current().delegate = self

        // APNs registration is gated on a build-time Info.plist flag
        // (MILADY_APNS_ENABLED=1). When the flag is absent the app boots
        // without requesting push permission — required because APNs
        // registration needs provisioning-profile entitlements that aren't
        // enabled on the default signing identity.
        let apnsEnabled = Bundle.main.object(forInfoDictionaryKey: "MILADY_APNS_ENABLED") as? String == "1"
        if apnsEnabled {
            registerForPushNotifications(application: application)
        }
        return true
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Capacitor 8 handles Universal Links via the URL open handler.
        return false
    }

    private func registerForPushNotifications(application: UIApplication) {
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound, .badge]
        ) { granted, error in
            if let error = error {
                NSLog("[MiladyCompanion] APNs authorization error: %@", error.localizedDescription)
                return
            }
            guard granted else {
                NSLog("[MiladyCompanion] APNs authorization denied")
                return
            }
            DispatchQueue.main.async {
                application.registerForRemoteNotifications()
            }
        }
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let tokenHex = deviceToken.map { String(format: "%02x", $0) }.joined()
        NSLog("[MiladyCompanion] APNs device token registered (%d bytes)", tokenHex.count)
        NotificationCenter.default.post(
            name: Notification.Name("MiladyCompanionApnsToken"),
            object: nil,
            userInfo: ["tokenHex": tokenHex]
        )
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        NSLog("[MiladyCompanion] APNs registration failed: %@", error.localizedDescription)
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
