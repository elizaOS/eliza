/**
 Defines the shared UserNotifications scheduling and tap-payload policy.

 Immediate intents can age into the past while the system permission sheet is
 open, so they use a short interval trigger; genuinely future requests retain
 their requested calendar date. Fallback notifications carry both Capacitor's
 `cap_extra` shape and the AppDelegate URL without making either delegate path
 authoritative over the other.
 */
import Foundation
import UserNotifications

enum ElizaNotificationTriggerPolicy {
    static let immediateDelay: TimeInterval = 1

    static func trigger(
        fireDate: Date,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> UNNotificationTrigger {
        if fireDate <= now.addingTimeInterval(immediateDelay) {
            return UNTimeIntervalNotificationTrigger(
                timeInterval: immediateDelay,
                repeats: false
            )
        }

        let components = calendar.dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: fireDate
        )
        return UNCalendarNotificationTrigger(
            dateMatching: components,
            repeats: false
        )
    }
}

enum ElizaNotificationTapPayload {
    static func userInfo(
        deepLink: String?,
        deepLinkOnTap: String?
    ) -> [AnyHashable: Any] {
        var userInfo: [AnyHashable: Any] = [:]
        if let deepLink, isSafeAppDestination(deepLink) {
            userInfo["cap_extra"] = ["deepLink": deepLink]
        }
        if let destination = safeOpenDestination(deepLinkOnTap) {
            userInfo["deepLinkOnTap"] = destination.absoluteString
        }
        return userInfo
    }

    private static func isSafeAppDestination(_ value: String) -> Bool {
        if value.hasPrefix("/") && !value.hasPrefix("//") {
            return true
        }
        guard let scheme = URL(string: value)?.scheme?.lowercased() else {
            return false
        }
        return scheme == "http" || scheme == "https"
    }

    static func safeOpenDestination(_ value: Any?) -> URL? {
        guard let value = value as? String,
              let url = URL(string: value),
              let scheme = url.scheme?.lowercased() else {
            return nil
        }
        if scheme == "http" || scheme == "https" {
            return url
        }
        guard scheme == "elizaos",
              let destination = url.host?.removingPercentEncoding?.lowercased(),
              !destination.isEmpty else {
            return nil
        }
        let privilegedNativeNamespaces: Set<String> = [
            "aec-loop",
            "auth",
            "connect",
            "first-run",
            "keyboard-dictation",
            "share",
        ]
        return privilegedNativeNamespaces.contains(destination) ? nil : url
    }
}
