import Capacitor
import Foundation
import UIKit
import UserNotifications

/// ElizaIntentPlugin — native bridge for the phone-companion surface.
///
/// Exposes the following methods to the JS layer:
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
///   - `getDeviceCapabilities()`
///       Returns a snapshot of the real hardware capabilities — device model
///       identifier (`utsname.machine`, e.g. `iPhone17,2`), simulator flag,
///       physical RAM in GB (`ProcessInfo.processInfo.physicalMemory`), CPU
///       core count, thermal state, low-power mode, and OS version. The JS
///       `device-bridge-client` merges this into the WS `register` payload
///       so the agent's `scoreDevice()` sees real values instead of the
///       broken `deviceModel=ios`, `ram=0GB` fallback from
///       `llama-cpp-capacitor`'s missing iOS hardware probe.
@objc(ElizaIntentPlugin)
public class ElizaIntentPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaIntentPlugin"
    public let jsName = "ElizaIntent"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scheduleAlarm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "receiveIntent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPairingStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPairingStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDeviceCapabilities", returnType: CAPPluginReturnPromise),
    ]

    private static let pairingDeviceIdKey = "com.eliza.companion.pairing.deviceId"
    private static let pairingAgentUrlKey = "com.eliza.companion.pairing.agentUrl"

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
        let deviceId = defaults.string(forKey: ElizaIntentPlugin.pairingDeviceIdKey)
        let agentUrl = defaults.string(forKey: ElizaIntentPlugin.pairingAgentUrlKey)
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
        defaults.set(deviceId, forKey: ElizaIntentPlugin.pairingDeviceIdKey)
        defaults.set(agentUrl, forKey: ElizaIntentPlugin.pairingAgentUrlKey)
        call.resolve(["ok": true])
    }

    /// Returns a snapshot of real device capabilities for the device-bridge
    /// `register` payload. All fields are populated from `UIDevice` /
    /// `ProcessInfo` / `utsname` stdlib calls — no third-party deps.
    ///
    /// Shape matches the JS `DeviceCapabilities` interface
    /// (`eliza/packages/native-plugins/llama/src/device-bridge-client.ts`).
    @objc public func getDeviceCapabilities(_ call: CAPPluginCall) {
        let info = ProcessInfo.processInfo
        let device = UIDevice.current

        let machine = ElizaIntentPlugin.machineIdentifier()
        #if targetEnvironment(simulator)
        let isSimulator = true
        #else
        let isSimulator = false
        #endif

        // physicalMemory is in bytes; round to nearest GB. Most iPhones report
        // 6/8/12GB after the kernel reserves a slice, so rounding (not floor)
        // gives the value users expect from the marketing spec.
        let physicalBytes = Double(info.physicalMemory)
        let totalRamGb = (physicalBytes / 1_073_741_824.0).rounded()

        let thermal: String
        switch info.thermalState {
        case .nominal: thermal = "nominal"
        case .fair: thermal = "fair"
        case .serious: thermal = "serious"
        case .critical: thermal = "critical"
        @unknown default: thermal = "unknown"
        }

        // Metal is available on every supported iOS device and on the
        // simulator under macOS host with Metal-capable GPU. We report it
        // as available unconditionally — the agent-side scoring just uses
        // this to assert non-zero VRAM, not to gate inference.
        let gpu: [String: Any] = [
            "backend": "metal",
            "available": true,
        ]

        call.resolve([
            "platform": "ios",
            "deviceModel": machine,
            "machineId": machine,
            "osVersion": device.systemVersion,
            "isSimulator": isSimulator,
            "totalRamGb": totalRamGb,
            "availableRamGb": NSNull(),
            "cpuCores": info.processorCount,
            "gpu": gpu,
            "gpuSupported": true,
            "lowPowerMode": info.isLowPowerModeEnabled,
            "thermalState": thermal,
        ])
    }

    /// Returns the hardware machine identifier (e.g. `iPhone17,2`). On the
    /// simulator `utsname.machine` returns the host arch, so we fall back
    /// to `SIMULATOR_MODEL_IDENTIFIER` from the env.
    private static func machineIdentifier() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let raw = withUnsafePointer(to: &systemInfo.machine) { pointer -> String in
            pointer.withMemoryRebound(
                to: CChar.self,
                capacity: Int(_SYS_NAMELEN)
            ) { ptr in
                String(cString: ptr)
            }
        }
        #if targetEnvironment(simulator)
        if let envModel = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"],
           !envModel.isEmpty {
            return envModel
        }
        #endif
        return raw
    }
}
