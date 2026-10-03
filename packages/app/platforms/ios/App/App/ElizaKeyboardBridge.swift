import Capacitor
import Foundation

/// ElizaKeyboard — Capacitor bridge for the keyboard app-handoff dictation
/// (issue #12185, sub 3). The ElizaKeyboard extension opens the app via
/// `elizaos://keyboard-dictation`; the JS dictation session (packages/app
/// `keyboard-dictation.ts`) records + transcribes, then calls these methods to
/// publish the `ElizaKeyboardDictationState.Record` into the shared App Group,
/// which the keyboard polls and inserts from.
///
/// Every stage is written explicitly (`recording` → `transcribing` → `ready` |
/// `error`) so the keyboard renders a real state when the engine is not
/// running or ASR fails — never a silent nothing.
@objc(ElizaKeyboardPlugin)
public class ElizaKeyboardPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaKeyboardPlugin"
    public let jsName = "ElizaKeyboard"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setDictationState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearDictationState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDictationState", returnType: CAPPluginReturnPromise),
    ]

    @objc public func setDictationState(_ call: CAPPluginCall) {
        guard
            let statusRaw = call.getString("status"),
            let status = ElizaKeyboardDictationState.Status(rawValue: statusRaw)
        else {
            call.reject(
                "setDictationState requires status: recording | transcribing | ready | error"
            )
            return
        }
        let transcript = call.getString("transcript")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if status == .ready, transcript?.isEmpty != false {
            call.reject("setDictationState(ready) requires a non-empty transcript")
            return
        }
        let record = ElizaKeyboardDictationState.Record(
            status: status,
            transcript: transcript,
            errorMessage: call.getString("errorMessage"),
            sessionId: call.getString("sessionId"),
            updatedAtEpochMs: Date().timeIntervalSince1970 * 1000
        )
        do {
            try ElizaKeyboardDictationState.save(record)
            call.resolve(["saved": true])
        } catch {
            call.reject(
                "Failed to write keyboard dictation state: \(error.localizedDescription)"
            )
        }
    }

    @objc public func clearDictationState(_ call: CAPPluginCall) {
        ElizaKeyboardDictationState.clear()
        call.resolve(["cleared": true])
    }

    @objc public func getDictationState(_ call: CAPPluginCall) {
        guard let record = ElizaKeyboardDictationState.load() else {
            call.resolve(["pending": false])
            return
        }
        var result: [String: Any] = [
            "pending": true,
            "status": record.status.rawValue,
            "updatedAtEpochMs": record.updatedAtEpochMs,
        ]
        if let transcript = record.transcript {
            result["transcript"] = transcript
        }
        if let errorMessage = record.errorMessage {
            result["errorMessage"] = errorMessage
        }
        if let sessionId = record.sessionId {
            result["sessionId"] = sessionId
        }
        call.resolve(result)
    }
}
