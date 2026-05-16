import Foundation
import Capacitor
import CoreLocation

/// Native iOS implementation of the ElizaLocation Capacitor plugin.
///
/// Bridges CLLocationManager to the TypeScript LocationPlugin interface, providing:
///   - getCurrentPosition (one-shot with accuracy, maxAge cache, timeout)
///   - watchPosition (continuous updates with minDistance + minInterval throttle)
///   - clearWatch (stop a running watch)
///   - checkPermissions / requestPermissions (whenInUse or always)
///   - Events: locationChange, error
@objc(ElizaLocationPlugin)
public class ElizaLocationPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "ElizaLocationPlugin"
    public let jsName = "ElizaLocation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCurrentPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "watchPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearWatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
    ]

    // MARK: - State

    /// Primary manager used for permission requests and cached-location reads.
    private var locationManager: CLLocationManager!

    /// Retained manager for an in-flight one-shot location request.
    /// Must be kept alive until the delegate fires or the timeout expires.
    private var singleRequestManager: CLLocationManager?
    private var singleRequestTimer: DispatchWorkItem?

    /// Active watch sessions keyed by watch ID.
    private var watches: [String: WatchState] = [:]

    /// A pending plugin call waiting for authorization before it can proceed.
    private var pendingCall: CAPPluginCall?
    private var pendingAction: PendingAction?

    private enum PendingAction {
        case getCurrentPosition
        case watchPosition
        case requestPermissions
        case singleLocation
    }

    /// Per-watch bookkeeping.
    private struct WatchState {
        let manager: CLLocationManager
        /// Minimum interval (seconds) between emitted events. 0 = no throttle.
        let minInterval: TimeInterval
        /// Timestamp of the last emitted locationChange for this watch.
        var lastEmitted: Date?
    }

    // MARK: - Lifecycle

    public override func load() {
        locationManager = CLLocationManager()
        locationManager.delegate = self
    }

    // MARK: - getCurrentPosition

    @objc func getCurrentPosition(_ call: CAPPluginCall) {
        guard CLLocationManager.locationServicesEnabled() else {
            call.reject("Location services disabled", "POSITION_UNAVAILABLE")
            return
        }

        let status = currentAuthStatus()

        if status == .notDetermined {
            pendingCall = call
            pendingAction = .getCurrentPosition
            locationManager.requestWhenInUseAuthorization()
            return
        }

        guard status == .authorizedWhenInUse || status == .authorizedAlways else {
            call.reject("Location permission denied", "PERMISSION_DENIED")
            return
        }

        getCurrentPositionInternal(call)
    }

    private func getCurrentPositionInternal(_ call: CAPPluginCall) {
        let accuracy = call.getString("accuracy") ?? "high"
        let timeout = call.getDouble("timeout") ?? 10000
        let maxAge = call.getDouble("maxAge") ?? 0

        // Return a cached location if fresh enough (mirrors classic LocationService).
        if maxAge > 0, let cached = locationManager.location {
            let ageMs = Date().timeIntervalSince(cached.timestamp) * 1000
            if ageMs <= maxAge {
                call.resolve(buildLocationResult(from: cached, cached: true))
                return
            }
        }

        // Spin up a dedicated manager so desiredAccuracy is isolated.
        let manager = CLLocationManager()
        manager.delegate = self
        manager.desiredAccuracy = clAccuracy(from: accuracy)

        // Retain to prevent dealloc before the delegate fires.
        singleRequestManager = manager
        pendingCall = call
        pendingAction = .singleLocation

        manager.requestLocation()

        // Timeout guard.
        let timer = DispatchWorkItem { [weak self] in
            guard let self, self.pendingAction == .singleLocation else { return }
            self.cleanupSingleRequest()?.reject("Location request timed out", "TIMEOUT")
        }
        singleRequestTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout / 1000, execute: timer)
    }

    /// Cancel in-flight single-request state and return the call (if any) for the caller to resolve/reject.
    @discardableResult
    private func cleanupSingleRequest() -> CAPPluginCall? {
        singleRequestTimer?.cancel()
        singleRequestTimer = nil
        singleRequestManager?.delegate = nil
        singleRequestManager = nil
        let call = pendingCall
        pendingCall = nil
        pendingAction = nil
        return call
    }

    // MARK: - watchPosition

    @objc func watchPosition(_ call: CAPPluginCall) {
        guard CLLocationManager.locationServicesEnabled() else {
            call.reject("Location services disabled", "POSITION_UNAVAILABLE")
            return
        }

        let status = currentAuthStatus()

        if status == .notDetermined {
            pendingCall = call
            pendingAction = .watchPosition
            locationManager.requestWhenInUseAuthorization()
            return
        }

        guard status == .authorizedWhenInUse || status == .authorizedAlways else {
            call.reject("Location permission denied", "PERMISSION_DENIED")
            return
        }

        watchPositionInternal(call)
    }

    private func watchPositionInternal(_ call: CAPPluginCall) {
        let accuracy = call.getString("accuracy") ?? "high"
        let minDistance = call.getDouble("minDistance") ?? 0
        let minInterval = call.getDouble("minInterval") ?? 0

        let watchId = UUID().uuidString
        let manager = CLLocationManager()
        manager.delegate = self
        manager.desiredAccuracy = clAccuracy(from: accuracy)
        manager.distanceFilter = minDistance > 0 ? minDistance : kCLDistanceFilterNone

        watches[watchId] = WatchState(
            manager: manager,
            minInterval: minInterval / 1000, // ms → seconds
            lastEmitted: nil
        )

        manager.startUpdatingLocation()

        call.resolve(["watchId": watchId])
    }

    // MARK: - clearWatch

    @objc func clearWatch(_ call: CAPPluginCall) {
        guard let watchId = call.getString("watchId") else {
            call.reject("Missing watchId")
            return
        }

        if let state = watches.removeValue(forKey: watchId) {
            state.manager.stopUpdatingLocation()
            state.manager.delegate = nil
        }
        call.resolve()
    }

    // MARK: - Permissions

    @objc public override func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(buildPermissionResult())
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        guard CLLocationManager.locationServicesEnabled() else {
            call.reject("Location services disabled", "POSITION_UNAVAILABLE")
            return
        }

        let status = currentAuthStatus()
        let level = call.getString("level") ?? "whenInUse"

        if status == .notDetermined {
            pendingCall = call
            pendingAction = .requestPermissions
            if level == "always" {
                locationManager.requestAlwaysAuthorization()
            } else {
                locationManager.requestWhenInUseAuthorization()
            }
            return
        }

        // Escalate whenInUse → always if requested (mirrors classic ensureAuthorization).
        if level == "always" && status == .authorizedWhenInUse {
            pendingCall = call
            pendingAction = .requestPermissions
            locationManager.requestAlwaysAuthorization()
            return
        }

        // Already determined — return current state.
        call.resolve(buildPermissionResult())
    }

    // MARK: - CLLocationManagerDelegate

    public func locationManager(
        _ manager: CLLocationManager,
        didUpdateLocations locations: [CLLocation]
    ) {
        guard let location = locations.last else { return }

        // One-shot request?
        if pendingAction == .singleLocation, manager === singleRequestManager {
            cleanupSingleRequest()?.resolve(buildLocationResult(from: location, cached: false))
            return
        }

        // Watch update — find the matching watch and apply minInterval throttle.
        for (watchId, var state) in watches where state.manager === manager {
            if state.minInterval > 0, let last = state.lastEmitted,
               Date().timeIntervalSince(last) < state.minInterval
            {
                return // throttled
            }
            state.lastEmitted = Date()
            watches[watchId] = state
            notifyListeners("locationChange", data: buildLocationResult(from: location, cached: false))
            return
        }
    }

    public func locationManager(
        _ manager: CLLocationManager,
        didFailWithError error: Error
    ) {
        // One-shot request?
        if pendingAction == .singleLocation, manager === singleRequestManager {
            cleanupSingleRequest()?.reject(
                "Location error: \(error.localizedDescription)", "POSITION_UNAVAILABLE"
            )
            return
        }

        // Watch error — emit event.
        for (_, state) in watches where state.manager === manager {
            notifyListeners("error", data: [
                "code": "POSITION_UNAVAILABLE",
                "message": error.localizedDescription,
            ])
            return
        }
    }

    public func locationManager(
        _ manager: CLLocationManager,
        didChangeAuthorization status: CLAuthorizationStatus
    ) {
        guard let call = pendingCall, let action = pendingAction else { return }

        // Still waiting for user to decide.
        if status == .notDetermined { return }

        // Clear pending state *before* calling internal methods — they may set new values.
        pendingCall = nil
        pendingAction = nil

        switch action {
        case .getCurrentPosition:
            if status == .authorizedWhenInUse || status == .authorizedAlways {
                getCurrentPositionInternal(call)
            } else {
                call.reject("Location permission denied", "PERMISSION_DENIED")
            }

        case .watchPosition:
            if status == .authorizedWhenInUse || status == .authorizedAlways {
                watchPositionInternal(call)
            } else {
                call.reject("Location permission denied", "PERMISSION_DENIED")
            }

        case .requestPermissions:
            call.resolve(buildPermissionResult())

        case .singleLocation:
            // Shouldn't happen — singleLocation is set after auth is granted.
            break
        }
    }

    // MARK: - Helpers

    private func currentAuthStatus() -> CLAuthorizationStatus {
        CLLocationManager.authorizationStatus()
    }

    /// Map the TypeScript LocationAccuracy string to a CLLocationAccuracy constant.
    private func clAccuracy(from accuracy: String) -> CLLocationAccuracy {
        switch accuracy {
        case "best":    return kCLLocationAccuracyBest
        case "high":    return kCLLocationAccuracyNearestTenMeters
        case "medium":  return kCLLocationAccuracyHundredMeters
        case "low":     return kCLLocationAccuracyKilometer
        case "passive": return kCLLocationAccuracyThreeKilometers
        default:        return kCLLocationAccuracyNearestTenMeters
        }
    }

    /// Build the permission result matching LocationPermissionStatus in definitions.ts.
    private func buildPermissionResult() -> JSObject {
        let status = currentAuthStatus()
        let location: String
        let background: String

        switch status {
        case .authorizedAlways:
            location = "granted"
            background = "granted"
        case .authorizedWhenInUse:
            location = "granted"
            background = "prompt"
        case .denied, .restricted:
            location = "denied"
            background = "denied"
        default:
            location = "prompt"
            background = "prompt"
        }

        return ["location": location, "background": background]
    }

    /// Build a LocationResult matching the TypeScript interface:
    /// `{ coords: LocationCoordinates, cached: boolean }`
    private func buildLocationResult(from location: CLLocation, cached: Bool) -> JSObject {
        var coords: JSObject = [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracy": location.horizontalAccuracy,
            "timestamp": location.timestamp.timeIntervalSince1970 * 1000,
        ]

        // Altitude data is valid when verticalAccuracy >= 0.
        if location.verticalAccuracy >= 0 {
            coords["altitude"] = location.altitude
            coords["altitudeAccuracy"] = location.verticalAccuracy
        }
        if location.speed >= 0 {
            coords["speed"] = location.speed
        }
        if location.course >= 0 {
            coords["heading"] = location.course
        }

        return ["coords": coords, "cached": cached]
    }
}
