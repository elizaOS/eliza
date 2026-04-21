import Foundation
import Capacitor
import HealthKit
import UIKit

@objc(MobileSignalsPlugin)
public class MobileSignalsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "MobileSignalsPlugin"
    public let jsName = "MobileSignals"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopMonitoring", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSnapshot", returnType: CAPPluginReturnPromise),
    ]

    private struct HealthCapture {
        let source: String
        let screenTime: [String: Any]
        let permissions: [String: Bool]
        let sleep: [String: Any]
        let biometrics: [String: Any]
        let warnings: [String]
    }

    private var monitoring = false
    private var observers: [NSObjectProtocol] = []
    private let healthStore = HKHealthStore()
    private let healthQueue = DispatchQueue(label: "ai.eliza.mobile-signals.health", qos: .utility)

    public override func load() {
        UIDevice.current.isBatteryMonitoringEnabled = true
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
        call.resolve(buildPermissionResult())
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        let types = requestedHealthTypes()
        guard !types.isEmpty else {
            call.resolve(buildPermissionResult(
                status: "not-applicable",
                canRequest: false,
                reason: "HealthKit sleep and biometric types are unavailable on this device."
            ))
            return
        }

        healthStore.requestAuthorization(toShare: nil, read: Set(types)) { [weak self] success, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                var result = self.buildPermissionResult()
                if !success, let error {
                    result["reason"] = "HealthKit permission request failed: \(error.localizedDescription)"
                }
                call.resolve(result)
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
        guard HKHealthStore.isHealthDataAvailable() else {
            return [
                "status": overrideStatus ?? "not-applicable",
                "canRequest": overrideCanRequest ?? false,
                "reason": overrideReason ?? "HealthKit is not available on this device.",
                "permissions": [
                    "sleep": false,
                    "biometrics": false,
                ],
                "screenTime": ScreenTimeSupport.buildStatus(),
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
            "screenTime": ScreenTimeSupport.buildStatus(),
            "permissions": [
                "sleep": sleepGranted,
                "biometrics": biometricGranted,
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

            let latestSleep = categories.last(where: { Self.isSleepSample($0.value) })
            let latestAwake = categories.last(where: { $0.value == HKCategoryValueSleepAnalysis.awake.rawValue })
            let isSleeping = latestSleep != nil && (latestAwake == nil || latestSleep!.startDate > latestAwake!.endDate)
            let asleepAt = latestSleep?.startDate
            let awakeAt = isSleeping ? nil : latestAwake?.endDate ?? latestAwake?.startDate
            let durationMinutes: Double? = {
                if let sleep = latestSleep {
                    return sleep.endDate.timeIntervalSince(sleep.startDate) / 60.0
                }
                if let asleepAt, let awakeAt {
                    return awakeAt.timeIntervalSince(asleepAt) / 60.0
                }
                return nil
            }()
            let stage = latestSleep.map { Self.sleepStageName(for: $0.value) } ?? (isSleeping ? "sleeping" : "awake")
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
