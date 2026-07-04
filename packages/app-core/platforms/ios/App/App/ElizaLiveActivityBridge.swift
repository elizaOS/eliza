import ActivityKit
import Capacitor
import Foundation

/// ElizaLiveActivity — Capacitor bridge that starts/updates/ends the voice
/// dictation Live Activity from the app when a voice/talkmode session begins,
/// progresses, and ends (issue #12185, sub-issue 2). The JS voice layer
/// (`ui/src/voice/ios-live-activity.ts`, driven from `useContinuousChat`) calls
/// these; the ElizaWidgets extension renders the `ElizaDictationAttributes`
/// content state on the Lock Screen and Dynamic Island.
///
/// First-party thin Swift (design decision D2 — no community Live-Activity
/// plugin). ActivityKit delivers the content state to the widget process, so
/// there is no App Group round-trip here; the `Activity` class is app-only
/// (not extension-safe), which is why start/update/end live in the app target
/// and only `ElizaDictationAttributes` is shared with the extension.
///
/// Exposes:
///   - `isSupported()` → `{ supported, enabled }` — iOS 16.1 gate + the user's
///     system Live-Activities toggle (`ActivityAuthorizationInfo`).
///   - `start({ sessionTitle?, phase?, transcript? })` → `{ activityId }`
///   - `update({ activityId?, phase, transcript? })` → `{ updated }`
///   - `end({ activityId?, phase? })` → `{ ended }`
@objc(ElizaLiveActivityPlugin)
public class ElizaLiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ElizaLiveActivityPlugin"
    public let jsName = "ElizaLiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
    ]

    // At most one dictation activity is live at a time. Track its id and start
    // anchor so `update` keeps the same live timer running without reading the
    // content state back (the readback API differs across 16.1/16.2).
    private static var currentActivityId: String?
    private static var currentStartedAt: Date?

    @objc public func isSupported(_ call: CAPPluginCall) {
        if #available(iOS 16.1, *) {
            let info = ActivityAuthorizationInfo()
            call.resolve(["supported": true, "enabled": info.areActivitiesEnabled])
        } else {
            call.resolve(["supported": false, "enabled": false])
        }
    }

    @objc public func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.reject("Live Activities require iOS 16.1 or later")
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.reject("Live Activities are disabled in Settings")
            return
        }

        let title = call.getString("sessionTitle") ?? "Voice session"
        let phase = Self.phase(from: call.getString("phase")) ?? .recording
        let transcript = call.getString("transcript") ?? ""
        let startedAt = Date()

        let attributes = ElizaDictationAttributes(sessionTitle: title)
        let state = ElizaDictationAttributes.ContentState(
            phase: phase,
            startedAt: startedAt,
            transcriptSnippet: transcript
        )

        do {
            let activity: Activity<ElizaDictationAttributes>
            if #available(iOS 16.2, *) {
                activity = try Activity.request(
                    attributes: attributes,
                    content: ActivityContent(state: state, staleDate: nil),
                    pushType: nil
                )
            } else {
                activity = try Activity.request(
                    attributes: attributes,
                    contentState: state,
                    pushType: nil
                )
            }
            Self.currentActivityId = activity.id
            Self.currentStartedAt = startedAt
            call.resolve(["activityId": activity.id])
        } catch {
            call.reject("Failed to start Live Activity: \(error.localizedDescription)")
        }
    }

    @objc public func update(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.reject("Live Activities require iOS 16.1 or later")
            return
        }
        let requestedId = call.getString("activityId") ?? Self.currentActivityId
        guard
            let requestedId,
            let activity = Activity<ElizaDictationAttributes>.activities
                .first(where: { $0.id == requestedId })
        else {
            call.reject("No active Live Activity to update")
            return
        }

        let phase = Self.phase(from: call.getString("phase")) ?? .recording
        let transcript = call.getString("transcript") ?? ""
        let startedAt = Self.currentStartedAt ?? Date()
        let state = ElizaDictationAttributes.ContentState(
            phase: phase,
            startedAt: startedAt,
            transcriptSnippet: transcript
        )

        Task {
            if #available(iOS 16.2, *) {
                await activity.update(ActivityContent(state: state, staleDate: nil))
            } else {
                await activity.update(using: state)
            }
            call.resolve(["updated": true])
        }
    }

    @objc public func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve(["ended": false])
            return
        }
        let requestedId = call.getString("activityId") ?? Self.currentActivityId
        let phase = Self.phase(from: call.getString("phase")) ?? .transcribing
        let startedAt = Self.currentStartedAt ?? Date()
        Self.currentActivityId = nil
        Self.currentStartedAt = nil

        let activities = Activity<ElizaDictationAttributes>.activities
            .filter { requestedId == nil || $0.id == requestedId }
        let finalState = ElizaDictationAttributes.ContentState(
            phase: phase,
            startedAt: startedAt,
            transcriptSnippet: ""
        )

        Task {
            for activity in activities {
                if #available(iOS 16.2, *) {
                    await activity.end(
                        ActivityContent(state: finalState, staleDate: nil),
                        dismissalPolicy: .immediate
                    )
                } else {
                    await activity.end(using: finalState, dismissalPolicy: .immediate)
                }
            }
            call.resolve(["ended": true])
        }
    }

    @available(iOS 16.1, *)
    private static func phase(
        from raw: String?
    ) -> ElizaDictationAttributes.ContentState.Phase? {
        guard let raw else { return nil }
        return ElizaDictationAttributes.ContentState.Phase(rawValue: raw)
    }
}
