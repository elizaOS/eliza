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
        if let deepLinkOnTap, isSafeOpenDestination(deepLinkOnTap) {
            userInfo["deepLinkOnTap"] = deepLinkOnTap
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

    private static func isSafeOpenDestination(_ value: String) -> Bool {
        guard let scheme = URL(string: value)?.scheme?.lowercased() else {
            return false
        }
        return scheme == "elizaos" || scheme == "http" || scheme == "https"
    }
}
