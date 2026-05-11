import Foundation
import BackgroundTasks
import Capacitor
import HealthKit
import UIKit
import UserNotifications

@objc(MobileSignalsPlugin)
public class MobileSignalsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MobileSignalsPlugin"
    public let jsName = "MobileSignals"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSnapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleBackgroundRefresh", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelBackgroundRefresh", returnType: CAPPluginReturnPromise),
    ]

    // Background task identifier — must be listed in the host app's Info.plist
    // under `BGTaskSchedulerPermittedIdentifiers`. When it is not listed,
    // registration fails silently (see `registerBackgroundTaskIfAvailable`)
    // and the plugin still works with foreground-only HealthKit polling.
    private static let backgroundRefreshIdentifier = "ai.eliza.mobile-signals.sleep-refresh"
    private static let backgroundRefreshInterval: TimeInterval = 30 * 60
    private var backgroundTaskRegistered = false

    private struct HealthCapture {
        let source: String
        let screenTime: [String: Any]
        let permissions: [String: Bool]
        let sleep: [String: Any]
        let biometrics: [String: Any]
        let warnings: [String]
    }

    private struct SleepEpisode {
        let startDate: Date
        let endDate: Date
        let durationMinutes: Double
        let latestStageValue: Int
    }

    private var monitoring = false
    private var observers: [NSObjectProtocol] = []
    private let healthStore = HKHealthStore()
    private let healthQueue = DispatchQueue(label: "ai.eliza.mobile-signals.health", qos: .utility)

    public override func load() {
        UIDevice.current.isBatteryMonitoringEnabled = true
        registerBackgroundTaskIfAvailable()
    }

    private func registerBackgroundTaskIfAvailable() {
        if #available(iOS 13.0, *) {
            guard !backgroundTaskRegistered else { return }
            let identifier = Self.backgroundRefreshIdentifier
            let registered = BGTaskScheduler.shared.register(
                forTaskWithIdentifier: identifier,
                using: nil
            ) { [weak self] task in
                guard let self = self, let refreshTask = task as? BGAppRefreshTask else {
                    task.setTaskCompleted(success: false)
                    return
                }
                self.handleBackgroundRefresh(task: refreshTask)
            }
            backgroundTaskRegistered = registered
            if !registered {
                FileHandle.standardError.write(
                    "[mobile-signals] BGTaskScheduler registration declined. Add `\(identifier)` to Info.plist BGTaskSchedulerPermittedIdentifiers to enable background HealthKit polling.\n"
                        .data(using: .utf8) ?? Data()
                )
            }
        }
    }

    @available(iOS 13.0, *)
    private func handleBackgroundRefresh(task: BGAppRefreshTask) {
        let expirationHandler = { [weak task] in
            guard let task = task else { return }
            task.setTaskCompleted(success: false)
        }
        task.expirationHandler = expirationHandler
        buildHealthSnapshot(reason: "background-refresh") { [weak self] healthSnapshot in
            self?.notifyListeners("signal", data: healthSnapshot)
            self?.scheduleNextBackgroundRefresh()
            task.setTaskCompleted(success: true)
        }
    }

    @available(iOS 13.0, *)
    private func scheduleNextBackgroundRefresh() {
        guard backgroundTaskRegistered else { return }
        let request = BGAppRefreshTaskRequest(
            identifier: Self.backgroundRefreshIdentifier
        )
        request.earliestBeginDate = Date(timeIntervalSinceNow: Self.backgroundRefreshInterval)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            FileHandle.standardError.write(
                "[mobile-signals] Failed to schedule background refresh: \(error.localizedDescription)\n"
                    .data(using: .utf8) ?? Data()
            )
        }
    }

    @objc func scheduleBackgroundRefresh(_ call: CAPPluginCall) {
        if #available(iOS 13.0, *) {
            if !backgroundTaskRegistered {
                call.resolve([
                    "scheduled": false,
                    "reason": "BGTaskSchedulerPermittedIdentifiers missing \(Self.backgroundRefreshIdentifier)",
                ])
                return
            }
            scheduleNextBackgroundRefresh()
            call.resolve([
                "scheduled": true,
                "identifier": Self.backgroundRefreshIdentifier,
                "earliestBeginInSeconds": Int(Self.backgroundRefreshInterval),
            ])
        } else {
            call.resolve([
                "scheduled": false,
                "reason": "BackgroundTasks requires iOS 13.0 or later.",
            ])
        }
    }

    @objc func cancelBackgroundRefresh(_ call: CAPPluginCall) {
        if #available(iOS 13.0, *) {
            BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.backgroundRefreshIdentifier)
            call.resolve(["cancelled": true])
        } else {
            call.resolve([
                "cancelled": false,
                "reason": "BackgroundTasks requires iOS 13.0 or later.",
            ])
        }
    }

    deinit {
        stopInternal()
        UIDevice.current.isBatteryMonitoringEnabled = false
    }

    @objc func startMonitoring(_ call: CAPPluginCall) {
        if monitoring {
            call.resolve(buildStartResult())
            return
        }

        monitoring = true
        registerObservers()
        call.resolve(buildStartResult())

        if call.getBool("emitInitial") ?? true {
            emitSignal(reason: "start")
            emitHealthSignal(reason: "start")
        }
    }

    @objc func stopMonitoring(_ call: CAPPluginCall) {
        stopInternal()
        call.resolve(["stopped": true])
    }

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        buildPermissionResult { result in
            call.resolve(result)
        }
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        let target = call.getString("target") ?? "all"
        if target == "screenTime" {
            resolvePermissionAfterScreenTimeRequest(call)
            return
        }
        if target == "notifications" {
            requestNotificationPermissions(call)
            return
        }

        let shouldRequestScreenTime = target != "health"
        let types = requestedHealthTypes()
        guard !types.isEmpty else {
            resolvePermissionResult(
                call,
                status: "not-applicable",
                canRequest: false,
                reason: "HealthKit sleep and biometric types are unavailable on this device.",
                requestScreenTime: shouldRequestScreenTime
            )
            return
        }

        healthStore.requestAuthorization(toShare: nil, read: Set(types)) { [weak self] success, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                let healthReason = !success
                    ? "HealthKit permission request failed: \(error?.localizedDescription ?? "unknown error")"
                    : nil
                self.resolvePermissionResult(
                    call,
                    reason: healthReason,
                    requestScreenTime: shouldRequestScreenTime
                )
            }
        }
    }

    private func requestNotificationPermissions(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { [weak self] _, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.buildPermissionResult(reason: error?.localizedDescription) { result in
                    call.resolve(result)
                }
            }
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        let target = call.getString("target") ?? "app"
        let reason: String?
        let actualTarget: String
        let urlString: String

        if target == "notification", #available(iOS 16.0, *) {
            actualTarget = "notification"
            urlString = UIApplication.openNotificationSettingsURLString
            reason = nil
        } else {
            actualTarget = "app"
            urlString = UIApplication.openSettingsURLString
            reason = target == "app" || target == "health" || target == "localNetwork"
                ? nil
                : "iOS only supports stable public deep links to this app's Settings screen."
        }

        guard let url = URL(string: urlString) else {
            call.resolve([
                "opened": false,
                "target": target,
                "actualTarget": actualTarget,
                "reason": "Unable to build iOS settings URL.",
            ])
            return
        }

        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                let resolvedReason: Any
                if opened {
                    if let reason {
                        resolvedReason = reason
                    } else {
                        resolvedReason = NSNull()
                    }
                } else {
                    resolvedReason = "iOS declined to open Settings."
                }
                call.resolve([
                    "opened": opened,
                    "target": target,
                    "actualTarget": actualTarget,
                    "reason": resolvedReason,
                ])
            }
        }
    }

    @objc func getSnapshot(_ call: CAPPluginCall) {
        let device = buildSnapshot(reason: "snapshot")
        buildHealthSnapshot(reason: "snapshot") { health in
            call.resolve([
                "supported": true,
                "snapshot": device,
                "healthSnapshot": health,
            ])
        }
    }

    private func registerObservers() {
        let center = NotificationCenter.default
        let names: [Notification.Name] = [
            UIApplication.didBecomeActiveNotification,
            UIApplication.willResignActiveNotification,
            UIApplication.didEnterBackgroundNotification,
            UIApplication.willEnterForegroundNotification,
            UIApplication.protectedDataDidBecomeAvailableNotification,
            UIApplication.protectedDataWillBecomeUnavailableNotification,
            Notification.Name.NSProcessInfoPowerStateDidChange,
            UIDevice.batteryStateDidChangeNotification,
        ]

        for name in names {
            let observer = center.addObserver(
                forName: name,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.emitSignal(reason: name.rawValue)
                if name == UIApplication.didBecomeActiveNotification ||
                    name == UIApplication.willEnterForegroundNotification ||
                    name == UIApplication.protectedDataDidBecomeAvailableNotification {
                    self?.emitHealthSignal(reason: name.rawValue)
                }
            }
            observers.append(observer)
        }
    }

    private func stopInternal() {
        let center = NotificationCenter.default
        for observer in observers {
            center.removeObserver(observer)
        }
        observers.removeAll()
        monitoring = false
    }

    private func buildStartResult() -> [String: Any] {
        [
            "enabled": monitoring,
            "supported": true,
            "platform": "ios",
            "snapshot": buildSnapshot(reason: "start"),
            "healthSnapshot": NSNull(),
        ]
    }

    private func requestedHealthTypes() -> [HKObjectType] {
        var types: [HKObjectType] = []
        if let sleepType = self.sleepHealthType() {
            types.append(sleepType)
        }
        types.append(contentsOf: biometricHealthTypes())
        return types
    }

    private func sleepHealthType() -> HKObjectType? {
        HKObjectType.categoryType(forIdentifier: .sleepAnalysis)
    }

    private func biometricHealthTypes() -> [HKObjectType] {
        let biometricIdentifiers: [HKQuantityTypeIdentifier] = [
            .heartRate,
            .restingHeartRate,
            .heartRateVariabilitySDNN,
            .respiratoryRate,
            .oxygenSaturation,
        ]
        return biometricIdentifiers.compactMap {
            HKObjectType.quantityType(forIdentifier: $0)
        }
    }

    private func buildPermissionResult(
        status overrideStatus: String? = nil,
        canRequest overrideCanRequest: Bool? = nil,
        reason overrideReason: String? = nil
    ) -> [String: Any] {
        let screenTimeStatus = ScreenTimeSupport.buildStatus()
        guard HKHealthStore.isHealthDataAvailable() else {
            return [
                "status": overrideStatus ?? "not-applicable",
                "canRequest": overrideCanRequest ?? false,
                "reason": overrideReason ?? "HealthKit is not available on this device.",
                "permissions": [
                    "sleep": false,
                    "biometrics": false,
                ],
                "screenTime": screenTimeStatus,
                "setupActions": buildSetupActions(
                    healthStatus: overrideStatus ?? "not-applicable",
                    healthCanRequest: overrideCanRequest ?? false,
                    screenTimeStatus: screenTimeStatus
                ),
            ]
        }

        let sleepType = sleepHealthType()
        let biometricTypes = biometricHealthTypes()
        let sleepGranted = sleepType.map { healthStore.authorizationStatus(for: $0) == .sharingAuthorized } ?? false
        let biometricGranted = biometricTypes.isEmpty
            ? false
            : biometricTypes.allSatisfy { healthStore.authorizationStatus(for: $0) == .sharingAuthorized }
        let hasRequestedTypes = sleepType != nil || !biometricTypes.isEmpty
        let hasDenied = (sleepType.map { healthStore.authorizationStatus(for: $0) == .sharingDenied } ?? false) ||
            biometricTypes.contains { healthStore.authorizationStatus(for: $0) == .sharingDenied }
        let hasPending = (sleepType.map { healthStore.authorizationStatus(for: $0) == .notDetermined } ?? false) ||
            biometricTypes.contains { healthStore.authorizationStatus(for: $0) == .notDetermined }
        let status = overrideStatus ?? {
            if !hasRequestedTypes {
                return "not-applicable"
            }
            if sleepGranted || biometricGranted {
                return "granted"
            }
            if hasDenied {
                return "denied"
            }
            if hasPending {
                return "not-determined"
            }
            return "not-determined"
        }()

        return [
            "status": status,
            "canRequest": overrideCanRequest ?? (status != "granted" && hasRequestedTypes),
            "reason": overrideReason ?? NSNull(),
            "screenTime": screenTimeStatus,
            "setupActions": buildSetupActions(
                healthStatus: status,
                healthCanRequest: overrideCanRequest ?? (status != "granted" && hasRequestedTypes),
                screenTimeStatus: screenTimeStatus
            ),
            "permissions": [
                "sleep": sleepGranted,
                "biometrics": biometricGranted,
            ],
        ]
    }

    private func resolvePermissionAfterScreenTimeRequest(
        _ call: CAPPluginCall,
        status: String? = nil,
        canRequest: Bool? = nil,
        reason: String? = nil
    ) {
        ScreenTimeSupport.requestAuthorizationIfAvailable { [weak self] screenTimeReason in
            guard let self = self else { return }
            var result = self.buildPermissionResult(
                status: status,
                canRequest: canRequest,
                reason: reason
            )
            if let screenTimeReason {
                if let existingReason = result["reason"] as? String, !existingReason.isEmpty {
                    result["reason"] = "\(existingReason) \(screenTimeReason)"
                } else {
                    result["reason"] = screenTimeReason
                }
            }
            call.resolve(result)
        }
    }

    private func resolvePermissionResult(
        _ call: CAPPluginCall,
        status: String? = nil,
        canRequest: Bool? = nil,
        reason: String? = nil,
        requestScreenTime: Bool
    ) {
        if requestScreenTime {
            resolvePermissionAfterScreenTimeRequest(
                call,
                status: status,
                canRequest: canRequest,
                reason: reason
            )
            return
        }

        call.resolve(buildPermissionResult(
            status: status,
            canRequest: canRequest,
            reason: reason
        ))
    }

    private func buildSetupActions(
        healthStatus: String,
        healthCanRequest: Bool,
        screenTimeStatus: [String: Any]
    ) -> [[String: Any]] {
        let healthReady = healthStatus == "granted"
        let authorization = screenTimeStatus["authorization"] as? [String: Any] ?? [:]
        let screenTimeAuthStatus = authorization["status"] as? String ?? "unavailable"
        let screenTimeCanRequest = authorization["canRequest"] as? Bool ?? false
        let screenTimeSupported = screenTimeStatus["supported"] as? Bool ?? false
        let screenTimeReady = screenTimeAuthStatus == "approved"
        let screenTimeReason = screenTimeStatus["reason"] ?? NSNull()

        return [
            [
                "id": "health_permissions",
                "label": "HealthKit",
                "status": healthReady
                    ? "ready"
                    : (healthStatus == "not-applicable" ? "unavailable" : "needs-action"),
                "canRequest": healthCanRequest,
                "canOpenSettings": true,
                "settingsTarget": "health",
                "reason": healthReady
                    ? NSNull()
                    : "Grant Health read access for sleep, heart rate, HRV, respiratory rate, and oxygen saturation.",
            ],
            [
                "id": "screen_time_authorization",
                "label": "Screen Time",
                "status": screenTimeReady
                    ? "ready"
                    : (screenTimeSupported ? "needs-action" : "unavailable"),
                "canRequest": screenTimeCanRequest,
                "canOpenSettings": true,
                "settingsTarget": "screenTime",
                "reason": screenTimeReady ? NSNull() : screenTimeReason,
            ],
            [
                "id": "local_network",
                "label": "Local Network",
                "status": "needs-action",
                "canRequest": false,
                "canOpenSettings": true,
                "settingsTarget": "localNetwork",
                "reason": "Allow Local Network when this phone sends data to a Mac or LAN agent.",
            ],
            [
                "id": "notification_settings",
                "label": "Notifications",
                "status": "needs-action",
                "canRequest": false,
                "canOpenSettings": true,
                "settingsTarget": "notification",
                "reason": "Open notification settings if reminders or telemetry prompts are muted.",
            ],
        ]
    }

    private func buildSnapshot(reason: String) -> [String: Any] {
        let app = UIApplication.shared
        let protectedAvailable = app.isProtectedDataAvailable
        let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        let batteryState = UIDevice.current.batteryState
        let batteryLevel = UIDevice.current.batteryLevel
        let onBattery: Bool? = {
            switch batteryState {
            case .charging, .full:
                return false
            case .unplugged:
                return true
            case .unknown:
                return nil
            @unknown default:
                return nil
            }
        }()
        let state: String = {
            if !protectedAvailable {
                return "locked"
            }
            switch app.applicationState {
            case .active:
                return lowPower ? "idle" : "active"
            case .inactive:
                return "idle"
            case .background:
                return "background"
            @unknown default:
                return "background"
            }
        }()
        let idleState: String = {
            if !protectedAvailable {
                return "locked"
            }
            if lowPower {
                return "idle"
            }
            return state == "active" ? "active" : "idle"
        }()
        let level = batteryLevel >= 0 ? Double(batteryLevel) : nil
        let onBatteryValue: Any = onBattery ?? NSNull()
        let levelValue: Any = level ?? NSNull()

        return [
            "source": "mobile_device",
            "platform": "ios",
            "state": state,
            "observedAt": Int64(Date().timeIntervalSince1970 * 1000),
            "idleState": idleState,
            "idleTimeSeconds": NSNull(),
            "onBattery": onBatteryValue,
            "metadata": [
                "reason": reason,
                "applicationState": app.applicationState.rawValue,
                "isProtectedDataAvailable": protectedAvailable,
                "isLowPowerModeEnabled": lowPower,
                "batteryState": batteryState.rawValue,
                "batteryLevel": levelValue,
            ],
        ]
    }

    private func emitSignal(reason: String) {
        guard monitoring else { return }
        notifyListeners("signal", data: buildSnapshot(reason: reason))
    }

    private func emitHealthSignal(reason: String) {
        guard monitoring else { return }
        buildHealthSnapshot(reason: reason) { [weak self] healthSnapshot in
            guard let self = self, self.monitoring else { return }
            self.notifyListeners("signal", data: healthSnapshot)
        }
    }

    private func buildHealthSnapshot(
        reason: String,
        completion: @escaping ([String: Any]) -> Void
    ) {
        guard HKHealthStore.isHealthDataAvailable() else {
            completion(makeHealthSnapshot(
                reason: reason,
                capture: HealthCapture(
                    source: "healthkit",
                    screenTime: ScreenTimeSupport.buildStatus(),
                    permissions: ["sleep": false, "biometrics": false],
                    sleep: [
                        "available": false,
                        "isSleeping": false,
                        "asleepAt": NSNull(),
                        "awakeAt": NSNull(),
                        "durationMinutes": NSNull(),
                        "stage": NSNull(),
                    ],
                    biometrics: [
                        "sampleAt": NSNull(),
                        "heartRateBpm": NSNull(),
                        "restingHeartRateBpm": NSNull(),
                        "heartRateVariabilityMs": NSNull(),
                        "respiratoryRate": NSNull(),
                        "bloodOxygenPercent": NSNull(),
                    ],
                    warnings: ["HealthKit is not available on this device"]
                )
            ))
            return
        }

        healthQueue.async {
            let group = DispatchGroup()
            var sleepSummary: HealthCapture?
            var biometricsSummary: HealthCapture?
            var warnings: [String] = []

            group.enter()
            self.fetchSleepSummary { capture, fetchWarning in
                sleepSummary = capture
                if let fetchWarning {
                    warnings.append(fetchWarning)
                }
                group.leave()
            }

            group.enter()
            self.fetchBiometrics { capture, fetchWarning in
                biometricsSummary = capture
                if let fetchWarning {
                    warnings.append(fetchWarning)
                }
                group.leave()
            }

            group.notify(queue: .main) {
                let capture = HealthCapture(
                    source: "healthkit",
                    screenTime: ScreenTimeSupport.buildStatus(),
                    permissions: [
                        "sleep": sleepSummary?.permissions["sleep"] ?? false,
                        "biometrics": biometricsSummary?.permissions["biometrics"] ?? false,
                    ],
                    sleep: sleepSummary?.sleep ?? [
                        "available": false,
                        "isSleeping": false,
                        "asleepAt": NSNull(),
                        "awakeAt": NSNull(),
                        "durationMinutes": NSNull(),
                        "stage": NSNull(),
                    ],
                    biometrics: biometricsSummary?.biometrics ?? [
                        "sampleAt": NSNull(),
                        "heartRateBpm": NSNull(),
                        "restingHeartRateBpm": NSNull(),
                        "heartRateVariabilityMs": NSNull(),
                        "respiratoryRate": NSNull(),
                        "bloodOxygenPercent": NSNull(),
                    ],
                    warnings: warnings
                )
                completion(
                    self.makeHealthSnapshot(
                        reason: reason,
                        capture: capture
                    )
                )
            }
        }
    }

    private func makeHealthSnapshot(
        reason: String,
        capture: HealthCapture
    ) -> [String: Any] {
        let deviceBatteryState = UIDevice.current.batteryState
        let onBattery: Bool? = {
            switch deviceBatteryState {
            case .charging, .full:
                return false
            case .unplugged:
                return true
            case .unknown:
                return nil
            @unknown default:
                return nil
            }
        }()
        let state = (capture.sleep["isSleeping"] as? Bool) == true ? "sleeping" : "idle"
        return [
            "source": "mobile_health",
            "platform": "ios",
            "state": state,
            "observedAt": Int64(Date().timeIntervalSince1970 * 1000),
            "idleState": NSNull(),
            "idleTimeSeconds": NSNull(),
            "onBattery": onBattery ?? NSNull(),
            "healthSource": capture.source,
            "screenTime": capture.screenTime,
            "permissions": capture.permissions,
            "sleep": capture.sleep,
            "biometrics": capture.biometrics,
            "warnings": capture.warnings,
            "metadata": [
                "reason": reason,
                "healthSource": capture.source,
                "deviceState": UIApplication.shared.applicationState.rawValue,
            ],
        ]
    }

    private func fetchSleepSummary(
        completion: @escaping (HealthCapture?, String?) -> Void
    ) {
        guard let sampleType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else {
            completion(nil, "Sleep analysis type unavailable")
            return
        }

        let startDate = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date().addingTimeInterval(-7 * 24 * 60 * 60)
        let predicate = HKQuery.predicateForSamples(
            withStart: startDate,
            end: nil,
            options: .strictStartDate
        )
        let sortDescriptors = [
            NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
        ]

        let query = HKSampleQuery(
            sampleType: sampleType,
            predicate: predicate,
            limit: HKObjectQueryNoLimit,
            sortDescriptors: sortDescriptors
        ) { _, samples, error in
            guard error == nil else {
                completion(nil, "Sleep analysis query failed")
                return
            }
            let categories = (samples as? [HKCategorySample]) ?? []
            guard !categories.isEmpty else {
                completion(
                    HealthCapture(
                        source: "healthkit",
                        screenTime: ScreenTimeSupport.buildStatus(),
                        permissions: ["sleep": false, "biometrics": false],
                        sleep: [
                            "available": false,
                            "isSleeping": false,
                            "asleepAt": NSNull(),
                            "awakeAt": NSNull(),
                            "durationMinutes": NSNull(),
                            "stage": NSNull(),
                        ],
                        biometrics: [
                            "sampleAt": NSNull(),
                            "heartRateBpm": NSNull(),
                            "restingHeartRateBpm": NSNull(),
                            "heartRateVariabilityMs": NSNull(),
                            "respiratoryRate": NSNull(),
                            "bloodOxygenPercent": NSNull(),
                        ],
                        warnings: []
                    ),
                    nil
                )
                return
            }

            let latestEpisode = Self.latestSleepEpisode(from: categories)
            let latestAwake = categories.last(where: { $0.value == HKCategoryValueSleepAnalysis.awake.rawValue })
            let now = Date()
            let sleepFreshnessWindow: TimeInterval = 15 * 60
            let isSleeping =
                latestEpisode != nil &&
                latestEpisode!.endDate >= now.addingTimeInterval(-sleepFreshnessWindow) &&
                (latestAwake == nil || latestAwake!.endDate <= latestEpisode!.endDate)
            let asleepAt = latestEpisode?.startDate
            let awakeAt = isSleeping ? nil : latestEpisode?.endDate
            let durationMinutes = latestEpisode?.durationMinutes
            let stage = latestEpisode.map { episode in
                isSleeping ? Self.sleepStageName(for: episode.latestStageValue) : "awake"
            } ?? "awake"
            completion(
                HealthCapture(
                    source: "healthkit",
                    screenTime: ScreenTimeSupport.buildStatus(),
                    permissions: ["sleep": true, "biometrics": false],
                    sleep: [
                        "available": true,
                        "isSleeping": isSleeping,
                        "asleepAt": asleepAt.map { Int64($0.timeIntervalSince1970 * 1000) } ?? NSNull(),
                        "awakeAt": awakeAt.map { Int64($0.timeIntervalSince1970 * 1000) } ?? NSNull(),
                        "durationMinutes": durationMinutes.map { Int64($0.rounded()) } ?? NSNull(),
                        "stage": stage,
                    ],
                    biometrics: [
                        "sampleAt": NSNull(),
                        "heartRateBpm": NSNull(),
                        "restingHeartRateBpm": NSNull(),
                        "heartRateVariabilityMs": NSNull(),
                        "respiratoryRate": NSNull(),
                        "bloodOxygenPercent": NSNull(),
                    ],
                    warnings: []
                ),
                nil
            )
        }
        healthStore.execute(query)
    }

    private func fetchBiometrics(
        completion: @escaping (HealthCapture?, String?) -> Void
    ) {
        let startDate = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date().addingTimeInterval(-7 * 24 * 60 * 60)
        let endDate = Date()
        let predicate = HKQuery.predicateForSamples(
            withStart: startDate,
            end: endDate,
            options: .strictStartDate
        )

        let group = DispatchGroup()
        var latestHeartRate: (value: Double, at: Date)?
        var latestRestingHeartRate: (value: Double, at: Date)?
        var latestHrv: (value: Double, at: Date)?
        var latestRespiratoryRate: (value: Double, at: Date)?
        var latestBloodOxygen: (value: Double, at: Date)?

        func fetchLatest(
            identifier: HKQuantityTypeIdentifier,
            unit: HKUnit,
            assign: @escaping (Double, Date) -> Void
        ) {
            guard let sampleType = HKObjectType.quantityType(forIdentifier: identifier) else {
                return
            }
            group.enter()
            let query = HKSampleQuery(
                sampleType: sampleType,
                predicate: predicate,
                limit: 1,
                sortDescriptors: [
                    NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
                ]
            ) { _, samples, error in
                defer { group.leave() }
                guard error == nil,
                      let sample = samples?.first as? HKQuantitySample else {
                    return
                }
                assign(sample.quantity.doubleValue(for: unit), sample.startDate)
            }
            healthStore.execute(query)
        }

        fetchLatest(identifier: .heartRate, unit: HKUnit(from: "count/min")) { value, at in
            latestHeartRate = (value, at)
        }
        fetchLatest(identifier: .restingHeartRate, unit: HKUnit(from: "count/min")) { value, at in
            latestRestingHeartRate = (value, at)
        }
        fetchLatest(identifier: .heartRateVariabilitySDNN, unit: HKUnit.secondUnit(with: .milli)) { value, at in
            latestHrv = (value, at)
        }
        fetchLatest(identifier: .respiratoryRate, unit: HKUnit(from: "count/min")) { value, at in
            latestRespiratoryRate = (value, at)
        }
        fetchLatest(identifier: .oxygenSaturation, unit: HKUnit.percent()) { value, at in
            latestBloodOxygen = (value * 100.0, at)
        }

        group.notify(queue: .main) {
            let sampleAt = [
                latestHeartRate?.at,
                latestRestingHeartRate?.at,
                latestHrv?.at,
                latestRespiratoryRate?.at,
                latestBloodOxygen?.at,
            ].compactMap { $0 }.sorted().last
            let hasBiometrics =
                latestHeartRate != nil ||
                latestRestingHeartRate != nil ||
                latestHrv != nil ||
                latestRespiratoryRate != nil ||
                latestBloodOxygen != nil
            let sleep: [String: Any] = [
                "available": false,
                "isSleeping": false,
                "asleepAt": NSNull(),
                "awakeAt": NSNull(),
                "durationMinutes": NSNull(),
                "stage": NSNull(),
            ]
            let biometrics: [String: Any] = [
                "sampleAt": sampleAt.map { Int64($0.timeIntervalSince1970 * 1000) } ?? NSNull(),
                "heartRateBpm": latestHeartRate.map { Int64($0.value.rounded()) } ?? NSNull(),
                "restingHeartRateBpm": latestRestingHeartRate.map { Int64($0.value.rounded()) } ?? NSNull(),
                "heartRateVariabilityMs": latestHrv?.value ?? NSNull(),
                "respiratoryRate": latestRespiratoryRate?.value ?? NSNull(),
                "bloodOxygenPercent": latestBloodOxygen?.value ?? NSNull(),
            ]

            completion(
                HealthCapture(
                    source: "healthkit",
                    screenTime: ScreenTimeSupport.buildStatus(),
                    permissions: [
                        "sleep": false,
                        "biometrics": hasBiometrics,
                    ],
                    sleep: sleep,
                    biometrics: biometrics,
                    warnings: []
                ),
                nil
            )
        }
    }

    private static func isSleepSample(_ value: Int) -> Bool {
        value != HKCategoryValueSleepAnalysis.awake.rawValue &&
        value != HKCategoryValueSleepAnalysis.inBed.rawValue
    }

    private static func latestSleepEpisode(from categories: [HKCategorySample]) -> SleepEpisode? {
        let sleepSamples = categories
            .filter { isSleepSample($0.value) }
            .sorted { left, right in left.startDate < right.startDate }
        guard let first = sleepSamples.first else {
            return nil
        }

        let maxStageGap: TimeInterval = 90 * 60
        var episodes: [SleepEpisode] = []
        var episodeStart = first.startDate
        var episodeEnd = first.endDate
        var episodeDuration = first.endDate.timeIntervalSince(first.startDate) / 60.0
        var latestStageValue = first.value

        for sample in sleepSamples.dropFirst() {
            if sample.startDate.timeIntervalSince(episodeEnd) <= maxStageGap {
                episodeEnd = max(episodeEnd, sample.endDate)
                episodeDuration += sample.endDate.timeIntervalSince(sample.startDate) / 60.0
                latestStageValue = sample.value
                continue
            }
            episodes.append(SleepEpisode(
                startDate: episodeStart,
                endDate: episodeEnd,
                durationMinutes: episodeDuration,
                latestStageValue: latestStageValue
            ))
            episodeStart = sample.startDate
            episodeEnd = sample.endDate
            episodeDuration = sample.endDate.timeIntervalSince(sample.startDate) / 60.0
            latestStageValue = sample.value
        }

        episodes.append(SleepEpisode(
            startDate: episodeStart,
            endDate: episodeEnd,
            durationMinutes: episodeDuration,
            latestStageValue: latestStageValue
        ))
        return episodes.sorted { left, right in left.endDate < right.endDate }.last
    }

    private static func sleepStageName(for value: Int) -> String {
        switch value {
        case HKCategoryValueSleepAnalysis.awake.rawValue:
            return "awake"
        case HKCategoryValueSleepAnalysis.inBed.rawValue:
            return "in_bed"
        default:
            return "asleep"
        }
    }
}
