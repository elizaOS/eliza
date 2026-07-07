import Capacitor
import Foundation
import MetricKit
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
        CAPPluginMethod(name: "getResourceSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getMetricKitPayloads", returnType: CAPPluginReturnPromise),
    ]

    /// Register the MetricKit subscriber once the plugin loads so daily
    /// `MXMetricPayload`s (CPU, energy, app-runtime) are captured to disk for the
    /// Mobile Resource Workbench to ingest. MetricKit is iOS 13+; on older OSes
    /// this is a no-op and `getMetricKitPayloads` returns an empty list.
    public override func load() {
        super.load()
        if #available(iOS 13.0, *) {
            MXMetricManager.shared.add(ElizaMetricKitSink.shared)
        }
    }

    private static let pairingDeviceIdKey = "com.eliza.companion.pairing.deviceId"
    private static let pairingAgentUrlKey = "com.eliza.companion.pairing.agentUrl"

    @objc public func scheduleAlarm(_ call: CAPPluginCall) {
        guard let timeIso = call.getString("timeIso"),
              let title = call.getString("title"),
              let body = call.getString("body") else {
            call.reject("scheduleAlarm requires timeIso, title, body")
            return
        }
        let deepLinkOnTap = call.getString("deepLinkOnTap")

        scheduleNotification(
            timeIso: timeIso,
            title: title,
            body: body,
            deepLinkOnTap: deepLinkOnTap
        ) { result, errorMessage in
            if let errorMessage = errorMessage {
                call.reject(errorMessage)
                return
            }
            call.resolve(result ?? [:])
        }
    }

    /// Schedule a local `UNNotification`.
    ///
    /// `deepLinkOnTap` is stashed in `UNNotificationContent.userInfo` under
    /// the literal key `deepLinkOnTap`. When the user taps the notification,
    /// `AppDelegate.userNotificationCenter(_:didReceive:withCompletionHandler:)`
    /// reads that key and calls `UIApplication.shared.open(URL(string:))` so
    /// the app routes to the right surface (e.g. `elizaos://chat/<convoId>`).
    private func scheduleNotification(
        timeIso: String,
        title: String,
        body: String,
        deepLinkOnTap: String?,
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
            if let deepLinkOnTap, !deepLinkOnTap.isEmpty {
                // userInfo carries the deep-link URL to the AppDelegate's
                // notification-response handler. Stored as a plain string so
                // the JSON round-trip through Apple's notification storage
                // doesn't drop it.
                content.userInfo = ["deepLinkOnTap": deepLinkOnTap]
            }

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
                var result: [String: Any] = [
                    "scheduledId": scheduledId,
                    "timeIso": timeIso,
                ]
                if let deepLinkOnTap {
                    result["deepLinkOnTap"] = deepLinkOnTap
                }
                completion(result, nil)
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
            let deepLinkOnTap = payload["deepLinkOnTap"] as? String
            scheduleNotification(
                timeIso: timeIso,
                title: title,
                body: body,
                deepLinkOnTap: deepLinkOnTap
            ) { result, errorMessage in
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
    /// (`eliza/plugins/plugin-native-llama/src/device-bridge-client.ts`).
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

    /// Returns a *live* resource snapshot for the Mobile Resource Workbench
    /// (issue #8800) — distinct from the one-shot `getDeviceCapabilities`. Every
    /// numeric field is sampled fresh on each call so the harness can build a
    /// thermal/RSS/battery timeline across a sustained run. A value the OS cannot
    /// provide is returned as `NSNull()`, never a fabricated zero.
    ///
    /// Sources:
    ///   - `residentMemoryMb` — `task_vm_info.phys_footprint` (the figure Jetsam
    ///     uses to kill the app), not `os.totalmem`.
    ///   - `availableRamMb` — `os_proc_available_memory()` (iOS 13+): bytes left
    ///     before Jetsam pressure; the real inference RAM budget.
    ///   - `thermalState` / `lowPowerMode` — `ProcessInfo`.
    ///   - `cpuTimeMs` — summed user+system time across live threads.
    ///   - `batteryLevelPct` — `UIDevice` (monitoring toggled on for the read).
    @objc public func getResourceSnapshot(_ call: CAPPluginCall) {
        let info = ProcessInfo.processInfo

        let thermal: String
        switch info.thermalState {
        case .nominal: thermal = "nominal"
        case .fair: thermal = "fair"
        case .serious: thermal = "serious"
        case .critical: thermal = "critical"
        @unknown default: thermal = "unknown"
        }

        let residentMb: Any = ElizaIntentPlugin.physFootprintBytes()
            .map { Double($0) / 1_048_576.0 } ?? NSNull()
        let availableMb: Any = ElizaIntentPlugin.availableMemoryBytes()
            .map { Double($0) / 1_048_576.0 } ?? NSNull()
        let cpuMs: Any = ElizaIntentPlugin.cpuTimeMs() ?? NSNull()

        // Battery level is -1 when monitoring is disabled; toggle it on for the
        // read, then restore. Returns NSNull when the device can't report it
        // (e.g. some simulators).
        let device = UIDevice.current
        let priorMonitoring = device.isBatteryMonitoringEnabled
        device.isBatteryMonitoringEnabled = true
        let rawLevel = device.batteryLevel
        let batteryPct: Any = rawLevel >= 0 ? Double(rawLevel) * 100.0 : NSNull()
        let charging = device.batteryState == .charging || device.batteryState == .full
        device.isBatteryMonitoringEnabled = priorMonitoring

        // Device total physical RAM: feeds the renderer's RAM-tier gating
        // (#14390) alongside the marketed-GB figure in getDeviceCapabilities.
        let totalRamMb: Any = info.physicalMemory > 0
            ? Double(info.physicalMemory) / 1_048_576.0
            : NSNull()

        call.resolve([
            "platform": "ios",
            "thermalState": thermal,
            "lowPowerMode": info.isLowPowerModeEnabled,
            "residentMemoryMb": residentMb,
            "availableRamMb": availableMb,
            "totalRamMb": totalRamMb,
            "cpuTimeMs": cpuMs,
            "batteryLevelPct": batteryPct,
            "isCharging": charging,
            "capturedAtMs": Date().timeIntervalSince1970 * 1000.0,
        ])
    }

    /// Drains the MetricKit payloads captured since the last call (CPU / energy /
    /// app-runtime) as an array of JSON strings, then clears them. Empty on
    /// iOS < 13 or before the first daily delivery.
    @objc public func getMetricKitPayloads(_ call: CAPPluginCall) {
        if #available(iOS 13.0, *) {
            let payloads = ElizaMetricKitSink.shared.drainPayloads()
            call.resolve(["payloads": payloads])
        } else {
            call.resolve(["payloads": []])
        }
    }

    /// `task_vm_info.phys_footprint` in bytes — the resident footprint Jetsam
    /// measures. nil when the mach call fails.
    private static func physFootprintBytes() -> UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(
            MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size
        )
        let kr = withUnsafeMutablePointer(to: &info) { ptr -> kern_return_t in
            ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return nil }
        return UInt64(info.phys_footprint)
    }

    /// Bytes available before Jetsam pressure (`os_proc_available_memory`,
    /// iOS 13+). nil on older OSes / when it returns 0.
    private static func availableMemoryBytes() -> UInt64? {
        if #available(iOS 13.0, *) {
            let available = os_proc_available_memory()
            return available > 0 ? UInt64(available) : nil
        }
        return nil
    }

    /// Total user+system CPU time across live (non-idle) threads, in ms.
    private static func cpuTimeMs() -> Double? {
        var threadList: thread_act_array_t?
        var threadCount = mach_msg_type_number_t(0)
        guard task_threads(mach_task_self_, &threadList, &threadCount) == KERN_SUCCESS,
              let threads = threadList else {
            return nil
        }
        defer {
            vm_deallocate(
                mach_task_self_,
                vm_address_t(UInt(bitPattern: threads)),
                vm_size_t(threadCount) * vm_size_t(MemoryLayout<thread_t>.stride)
            )
        }
        var totalMs: Double = 0
        let basicInfoCount = mach_msg_type_number_t(
            MemoryLayout<thread_basic_info_data_t>.size / MemoryLayout<integer_t>.size
        )
        for index in 0..<Int(threadCount) {
            var info = thread_basic_info_data_t()
            var count = basicInfoCount
            let kr = withUnsafeMutablePointer(to: &info) { ptr -> kern_return_t in
                ptr.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                    thread_info(threads[index], thread_flavor_t(THREAD_BASIC_INFO), $0, &count)
                }
            }
            if kr == KERN_SUCCESS, (info.flags & TH_FLAGS_IDLE) == 0 {
                totalMs += Double(info.user_time.seconds) * 1000.0
                    + Double(info.user_time.microseconds) / 1000.0
                totalMs += Double(info.system_time.seconds) * 1000.0
                    + Double(info.system_time.microseconds) / 1000.0
            }
        }
        return totalMs
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

/// MetricKit subscriber that captures the OS-delivered `MXMetricPayload`s
/// (CPU, energy, app-runtime, animation) — the Apple-sanctioned on-device
/// energy/CPU source — to disk so the Mobile Resource Workbench can ingest them.
///
/// MetricKit delivers payloads roughly once per day (and on the simulator via
/// Xcode's "Simulate MetricKit Payloads"), so this is a nightly-trend source,
/// not a per-run gate. Payloads are written as one JSON file each under
/// Application Support/`ElizaMetricKit/`; `drainPayloads()` reads and removes
/// them. Bounded to the most recent files so a long-lived install can't grow the
/// directory without limit.
@available(iOS 13.0, *)
final class ElizaMetricKitSink: NSObject, MXMetricManagerSubscriber {
    static let shared = ElizaMetricKitSink()

    private static let maxStoredPayloads = 32

    private let directory: URL? = {
        let fm = FileManager.default
        guard let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }
        let dir = base.appendingPathComponent("ElizaMetricKit", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    func didReceive(_ payloads: [MXMetricPayload]) {
        guard let dir = directory else { return }
        let fm = FileManager.default
        for payload in payloads {
            let json = payload.jsonRepresentation()
            guard !json.isEmpty else { continue }
            let name = "metric-\(Int(Date().timeIntervalSince1970 * 1000))-\(UUID().uuidString).json"
            try? json.write(to: dir.appendingPathComponent(name))
        }
        pruneOldest(in: dir, fileManager: fm)
    }

    /// Reads and removes every stored payload JSON, returning each as a string.
    func drainPayloads() -> [String] {
        guard let dir = directory else { return [] }
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: nil
        ) else { return [] }
        var out: [String] = []
        for file in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            if let data = try? Data(contentsOf: file),
               let text = String(data: data, encoding: .utf8) {
                out.append(text)
            }
            try? fm.removeItem(at: file)
        }
        return out
    }

    private func pruneOldest(in dir: URL, fileManager fm: FileManager) {
        guard let files = try? fm.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: nil
        ) else { return }
        let sorted = files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent })
        let overflow = sorted.count - ElizaMetricKitSink.maxStoredPayloads
        guard overflow > 0 else { return }
        for file in sorted.prefix(overflow) {
            try? fm.removeItem(at: file)
        }
    }
}
