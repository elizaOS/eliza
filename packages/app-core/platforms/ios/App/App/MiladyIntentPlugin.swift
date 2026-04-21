import Capacitor
import Foundation
import UserNotifications

/// MiladyIntentPlugin — native bridge for the phone-companion surface.
///
/// Exposes four methods to the JS layer:
///   - `scheduleAlarm({ timeIso, title, body })`
///       Schedules a local `UNUserNotificationCenter` notification at the
///       provided ISO-8601 time with a critical-alert sound.
///   - `receiveIntent(intent)`
///       Handoff from the device-bus push channel (plan §6.24). The JS
///       side forwards decoded intents; this native method dispatches
///       them to the correct iOS subsystem (alarm → UN, block → Screen
///       Time helper, etc.). Only the `alarm` branch is wired in T8c;
///       other branches return `accepted: false` with a reason string.
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

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fireDate = formatter.date(from: timeIso) ?? ISO8601DateFormatter().date(from: timeIso)
        guard let resolvedDate = fireDate else {
            call.reject("scheduleAlarm received malformed timeIso: \(timeIso)")
            return
        }

        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            if let error = error {
                call.reject("UN authorization failed: \(error.localizedDescription)")
                return
            }
            if !granted {
                call.reject("User denied notification authorization")
                return
            }

            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .defaultCritical

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
                    call.reject("Failed to schedule alarm: \(addError.localizedDescription)")
                    return
                }
                call.resolve([
                    "scheduledId": scheduledId,
                    "timeIso": timeIso,
                ])
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
        case "alarm":
            guard let timeIso = payload["timeIso"] as? String,
                  let title = payload["title"] as? String,
                  let body = payload["body"] as? String else {
                call.reject("alarm intent missing timeIso/title/body")
                return
            }
            let innerCall = CAPPluginCall(
                callbackId: call.callbackId,
                options: [
                    "timeIso": timeIso,
                    "title": title,
                    "body": body,
                ],
                success: { result, _ in
                    var merged: [String: Any] = result?.data ?? [:]
                    merged["accepted"] = true
                    merged["reason"] = "scheduled"
                    call.resolve(merged as PluginCallResultData)
                },
                error: { err in
                    call.resolve([
                        "accepted": false,
                        "reason": err?.message ?? "scheduleAlarm failed",
                    ])
                }
            )
            if let innerCall = innerCall {
                scheduleAlarm(innerCall)
            } else {
                call.reject("Failed to construct inner scheduleAlarm call")
            }
        case "reminder", "block", "chat":
            call.resolve([
                "accepted": false,
                "reason": "T8c skeleton: \(kind) intent handler deferred to T9c",
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
