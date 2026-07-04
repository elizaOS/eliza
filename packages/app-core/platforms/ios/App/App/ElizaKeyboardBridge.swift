import Capacitor
import Foundation

/// Native app-group bridge for the iOS custom keyboard extension.
///
/// The keyboard extension cannot record audio or host the Bun runtime. It
/// writes a pending request into the shared app group, opens
/// `elizaos://keyboard-dictation?...`, and waits for the containing app to
/// write the completed transcript back through this bridge.
@objc(ElizaKeyboardBridgePlugin)
public class ElizaKeyboardBridgePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaKeyboardBridgePlugin"
    public let jsName = "ElizaKeyboardBridge"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPendingRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "completeDictation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearCompletedTranscript", returnType: CAPPluginReturnPromise),
    ]

    private static let pendingRequestKey = "com.elizaos.keyboard.pendingRequest"
    private static let completedTranscriptKey = "com.elizaos.keyboard.completedTranscript"

    private var appGroupIdentifier: String {
        let appBundleIdentifier = Bundle.main.bundleIdentifier ?? "ai.elizaos.app"
        return "group.\(appBundleIdentifier)"
    }

    private var sharedDefaults: UserDefaults? {
        UserDefaults(suiteName: appGroupIdentifier)
    }

    @objc public func getPendingRequest(_ call: CAPPluginCall) {
        guard let defaults = sharedDefaults else {
            call.reject("App group is unavailable: \(appGroupIdentifier)")
            return
        }
        call.resolve(defaults.dictionary(forKey: Self.pendingRequestKey) ?? [:])
    }

    @objc public func completeDictation(_ call: CAPPluginCall) {
        guard let defaults = sharedDefaults else {
            call.reject("App group is unavailable: \(appGroupIdentifier)")
            return
        }
        guard let requestId = call.getString("requestId"), !requestId.isEmpty else {
            call.reject("completeDictation requires requestId")
            return
        }
        guard
            let transcript = call.getString("transcript")?.trimmingCharacters(in: .whitespacesAndNewlines),
            !transcript.isEmpty
        else {
            call.reject("completeDictation requires transcript")
            return
        }

        let payload: [String: Any] = [
            "requestId": requestId,
            "transcript": transcript,
            "completedAt": ISO8601DateFormatter().string(from: Date()),
            "source": "ios-app",
        ]
        defaults.set(payload, forKey: Self.completedTranscriptKey)
        defaults.removeObject(forKey: Self.pendingRequestKey)
        defaults.synchronize()
        call.resolve(["requestId": requestId, "completed": true])
    }

    @objc public func clearCompletedTranscript(_ call: CAPPluginCall) {
        sharedDefaults?.removeObject(forKey: Self.completedTranscriptKey)
        sharedDefaults?.synchronize()
        call.resolve(["cleared": true])
    }
}
