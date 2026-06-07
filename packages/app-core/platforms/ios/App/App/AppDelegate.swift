import UIKit
import Capacitor
import CapacitorBackgroundRunner
import AVFoundation
import CoreLocation
import EventKit
import HealthKit
import Photos
import Speech
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?
    private let proactivePermissionBootstrap = ProactivePermissionBootstrap()

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
        proactivePermissionBootstrap.start()
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

@MainActor
private final class ProactivePermissionBootstrap: NSObject, CLLocationManagerDelegate {
    private let eventStore = EKEventStore()
    private let healthStore = HKHealthStore()
    private let locationManager = CLLocationManager()
    private var started = false

    func start() {
        guard !started else { return }
        started = true
        locationManager.delegate = self

        Task { @MainActor in
            await requestNotifications()
            await requestCalendar()
            await requestCamera()
            await requestMicrophone()
            await requestSpeech()
            await requestPhotos()
            await requestHealth()
            Self.log("screen-time", granted: false, reason: "Screen Time authorization is deferred because iOS may open Settings.")
            requestLocation()
        }
    }

    private func requestNotifications() async {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
                Self.log("notifications", granted: granted, error: error)
                continuation.resume()
            }
        }
    }

    private func requestCalendar() async {
        await withCheckedContinuation { continuation in
            let completion: (Bool, Error?) -> Void = { granted, error in
                Self.log("calendar", granted: granted, error: error)
                continuation.resume()
            }
            if #available(iOS 17.0, *) {
                eventStore.requestFullAccessToEvents(completion: completion)
            } else {
                eventStore.requestAccess(to: .event, completion: completion)
            }
        }
    }

    private func requestCamera() async {
        await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .video) { granted in
                Self.log("camera", granted: granted, error: nil)
                continuation.resume()
            }
        }
    }

    private func requestMicrophone() async {
        await withCheckedContinuation { continuation in
            let completion: (Bool) -> Void = { granted in
                Self.log("microphone", granted: granted, error: nil)
                continuation.resume()
            }
            if #available(iOS 17.0, *) {
                AVAudioApplication.requestRecordPermission(completionHandler: completion)
            } else {
                AVAudioSession.sharedInstance().requestRecordPermission(completion)
            }
        }
    }

    private func requestSpeech() async {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                Self.log("speech", granted: status == .authorized, error: nil)
                continuation.resume()
            }
        }
    }

    private func requestPhotos() async {
        await withCheckedContinuation { continuation in
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
                Self.log("photos", granted: status == .authorized || status == .limited, error: nil)
                continuation.resume()
            }
        }
    }

    private func requestHealth() async {
        guard HKHealthStore.isHealthDataAvailable() else {
            Self.log("health", granted: false, reason: "HealthKit is unavailable on this device.")
            return
        }
        let readTypes = Set(requestedHealthTypes())
        guard !readTypes.isEmpty else {
            Self.log("health", granted: false, reason: "HealthKit sample types are unavailable.")
            return
        }
        await withCheckedContinuation { continuation in
            healthStore.requestAuthorization(toShare: [], read: readTypes) { granted, error in
                Self.log("health", granted: granted, error: error)
                continuation.resume()
            }
        }
    }

    private func requestLocation() {
        let status = locationManager.authorizationStatus
        if status == .notDetermined {
            locationManager.requestWhenInUseAuthorization()
            return
        }
        if status == .authorizedWhenInUse {
            locationManager.requestAlwaysAuthorization()
            return
        }
        Self.log("location", granted: status == .authorizedAlways || status == .authorizedWhenInUse, error: nil)
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            let status = manager.authorizationStatus
            Self.log("location", granted: status == .authorizedAlways || status == .authorizedWhenInUse, error: nil)
            if status == .authorizedWhenInUse {
                manager.requestAlwaysAuthorization()
            }
        }
    }

    private func requestedHealthTypes() -> [HKObjectType] {
        var types: [HKObjectType] = []
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            types.append(sleep)
        }
        for identifier in [
            HKQuantityTypeIdentifier.heartRate,
            HKQuantityTypeIdentifier.restingHeartRate,
            HKQuantityTypeIdentifier.heartRateVariabilitySDNN,
            HKQuantityTypeIdentifier.respiratoryRate,
            HKQuantityTypeIdentifier.oxygenSaturation,
        ] {
            if let type = HKObjectType.quantityType(forIdentifier: identifier) {
                types.append(type)
            }
        }
        return types
    }

    private static func log(_ permission: String, granted: Bool, error: Error?) {
        if let error {
            NSLog("[ProactivePermissionBootstrap] %@ permission failed: %@", permission, error.localizedDescription)
            return
        }
        log(permission, granted: granted, reason: nil)
    }

    private static func log(_ permission: String, granted: Bool, reason: String?) {
        if let reason {
            NSLog("[ProactivePermissionBootstrap] %@ permission %@: %@", permission, granted ? "granted" : "not granted", reason)
            return
        }
        NSLog("[ProactivePermissionBootstrap] %@ permission %@", permission, granted ? "granted" : "not granted")
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
