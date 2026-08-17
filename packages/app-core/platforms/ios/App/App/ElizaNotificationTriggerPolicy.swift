/**
 Selects a fireable UserNotifications trigger after authorization completes.

 Immediate intents can age into the past while the system permission sheet is
 open, so they use a short interval trigger; genuinely future requests retain
 their requested calendar date.
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
