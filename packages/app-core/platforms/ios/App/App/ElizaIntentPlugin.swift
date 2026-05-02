import Capacitor
import Foundation
import UserNotifications

/// MiladyIntentPlugin — native bridge for the phone-companion surface.
///
/// Exposes four methods to the JS layer:
///   - `scheduleAlarm({ timeIso, title, body })`
///       Schedules a local `UNUserNotificationCenter` notification at the
///       provided ISO-8601 time.
///   - `receiveIntent(intent)`
///       Handoff from the device-bus push channel. The JS side forwards
///       decoded intents; alarms and reminders schedule local notifications.
///       Blocking and chat intents stay in the app layer where their
///       permission-specific plugins and conversation context live.
///   - `getPairingStatus()`
///       Reads the pairing record from `UserDefaults.standard` (keys below).
///       There is no keychain path yet — keep this aligned with `setPairingStatus`.
///   - `setPairingStatus({ deviceId, agentUrl })`
///       Persists the same keys after a QR handshake or `session.start` push so
///       cold launches can restore `paired: true` via `getPairingStatus`.
@objc(MiladyIntentPlugin)
public class MiladyIntentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MiladyIntentPlugin"
    public let jsName = "MiladyIntent"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scheduleAlarm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "receiveIntent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPairingStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPairingStatus", returnType: CAPPluginReturnPromise),
    ]

    private static let pairingDeviceIdKey = "com.milady.companion.pairing.deviceId"
    private static let pairingAgentUrlKey = "com.milady.companion.pairing.agentUrl"

    @objc public func scheduleAlarm(_ call: CAPPluginCall) {
        guard let timeIso = call.getString("timeIso"),
              let title = call.getString("title"),
              let body = call.getString("body") else {
            call.reject("scheduleAlarm requires timeIso, title, body")
            return
        }

        scheduleNotification(timeIso: timeIso, title: title, body: body) { result, errorMessage in
            if let errorMessage = errorMessage {
                call.reject(errorMessage)
                return
            }
            call.resolve(result ?? [:])
        }
    }

    private func scheduleNotification(
        timeIso: String,
        title: String,
        body: String,
        completion: @escaping ([String: Any]?, String?) -> Void
    ) {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fireDate = formatter.date(from: timeIso) ?? ISO8601DateFormatter().date(from: timeIso)
        guard let resolvedDate = fireDate else {
            completion(nil, "Notification intent received malformed timeIso: \(timeIso)")
            return
        }

        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error {
                completion(nil, "UN authorization failed: \(error.localizedDescription)")
                return
            }
            if !granted {
                completion(nil, "User denied notification authorization")
                return
            }

            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default

            let triggerComponents = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute, .second],
                from: resolvedDate
            )
            let trigger = UNCalendarNotificationTrigger(
                dateMatching: triggerComponents,
                repeats: false
            )
            let scheduledId = UUID().uuidString
            let request = UNNotificationRequest(
                identifier: scheduledId,
                content: content,
                trigger: trigger
            )
            center.add(request) { addError in
                if let addError = addError {
                    completion(nil, "Failed to schedule notification: \(addError.localizedDescription)")
                    return
                }
                completion([
                    "scheduledId": scheduledId,
                    "timeIso": timeIso,
                ], nil)
            }
        }
    }

    @objc public func receiveIntent(_ call: CAPPluginCall) {
        guard let kind = call.getString("kind") else {
            call.reject("receiveIntent requires kind")
            return
        }
        guard let payload = call.getObject("payload") else {
            call.reject("receiveIntent requires payload object")
            return
        }

        switch kind {
        case "alarm", "reminder":
            guard let timeIso = payload["timeIso"] as? String,
                  let title = payload["title"] as? String,
                  let body = payload["body"] as? String else {
                call.reject("\(kind) intent missing timeIso/title/body")
                return
            }
            scheduleNotification(timeIso: timeIso, title: title, body: body) { result, errorMessage in
                if let errorMessage = errorMessage {
                    call.resolve([
                        "accepted": false,
                        "reason": errorMessage,
                    ])
                    return
                }
                var merged = result ?? [:]
                merged["accepted"] = true
                merged["reason"] = "scheduled"
                call.resolve(merged as PluginCallResultData)
            }
        case "block":
            call.resolve([
                "accepted": false,
                "reason": "block intents must be handled by the app-layer Screen Time bridge",
            ])
        case "chat":
            call.resolve([
                "accepted": false,
                "reason": "chat intents must be handled by the app-layer conversation runtime",
            ])
        default:
            call.resolve([
                "accepted": false,
                "reason": "unknown intent kind: \(kind)",
            ])
        }
    }

    @objc public func getPairingStatus(_ call: CAPPluginCall) {
        let defaults = UserDefaults.standard
        let deviceId = defaults.string(forKey: MiladyIntentPlugin.pairingDeviceIdKey)
        let agentUrl = defaults.string(forKey: MiladyIntentPlugin.pairingAgentUrlKey)
        let paired = deviceId != nil && agentUrl != nil

        call.resolve([
            "paired": paired,
            "agentUrl": agentUrl as Any,
            "deviceId": deviceId as Any,
        ])
    }

    /// Writes the pairing record read by `getPairingStatus`. `deviceId` is the
    /// paired agent id from the QR / push payload; `agentUrl` is the ingress URL.
    @objc public func setPairingStatus(_ call: CAPPluginCall) {
        guard let deviceId = call.getString("deviceId"),
              let agentUrl = call.getString("agentUrl") else {
            call.reject("setPairingStatus requires deviceId and agentUrl")
            return
        }
        let defaults = UserDefaults.standard
        defaults.set(deviceId, forKey: MiladyIntentPlugin.pairingDeviceIdKey)
        defaults.set(agentUrl, forKey: MiladyIntentPlugin.pairingAgentUrlKey)
        call.resolve(["ok": true])
    }
}
