/**
 * Capacitor boundary for iOS native transcript surfaces. Renderer envelopes are
 * independently reduced, persisted in the app group, and published as native
 * view-model events for SwiftUI extensions and diagnostics.
 */

import Capacitor
import Foundation

@objc(NativeTranscriptPlugin)
public final class NativeTranscriptPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeTranscriptPlugin"
    public let jsName = "NativeTranscript"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "publishStream", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readViewModel", returnType: CAPPluginReturnPromise),
    ]

    private static let viewKey = "nativeTranscript.viewModel"
    private let reducer = NativeTranscriptReducer()
    private let reducerLock = NSLock()

    @objc public func publishStream(_ call: CAPPluginCall) {
        guard
            let schema = call.getString("schema"),
            let events = call.getArray("events")
        else {
            call.reject("Native transcript stream requires schema and events")
            return
        }

        do {
            reducerLock.lock()
            defer { reducerLock.unlock() }
            let result = try reducer.applyEnvelope(["schema": schema, "events": events])
            guard JSONSerialization.isValidJSONObject(result.view) else {
                call.reject("Native transcript view model is not JSON serializable")
                return
            }
            let data = try JSONSerialization.data(withJSONObject: result.view)
            Self.sharedDefaults.set(data, forKey: Self.viewKey)
            let response: [String: Any] = [
                "view": result.view,
                "rejectedIndexes": result.rejectedIndexes,
            ]
            notifyListeners("viewModel", data: response)
            call.resolve(response)
        } catch {
            // error-policy:J1 Capacitor is the transport boundary; malformed
            // envelopes become an explicit rejected plugin call.
            call.reject("Could not apply native transcript stream: \(error.localizedDescription)")
        }
    }

    @objc public func readViewModel(_ call: CAPPluginCall) {
        do {
            let view: [String: Any]
            if let data = Self.sharedDefaults.data(forKey: Self.viewKey) {
                guard let decoded = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    call.reject("Persisted native transcript view model is malformed")
                    return
                }
                view = decoded
            } else {
                reducerLock.lock()
                defer { reducerLock.unlock() }
                view = reducer.viewModel()
            }
            call.resolve(["view": view])
        } catch {
            // error-policy:J1 Capacitor read boundary translates corrupt native
            // persistence into an explicit rejection, never an empty view.
            call.reject("Could not read native transcript view model: \(error.localizedDescription)")
        }
    }

    private static var sharedDefaults: UserDefaults {
        let bundleId = Bundle.main.bundleIdentifier ?? "ai.elizaos.app"
        let suffix = bundleId.hasSuffix(".App") ? String(bundleId.dropLast(4)) : bundleId
        return UserDefaults(suiteName: "group.\(suffix)") ?? .standard
    }
}
