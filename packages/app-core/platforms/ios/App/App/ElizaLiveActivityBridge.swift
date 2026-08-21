/**
 The Capacitor bridge owns ActivityKit lifecycle calls and translates the web
 voice session into localized native Live Activity attributes and state.
 */
import ActivityKit
import Capacitor
import Foundation

/// ElizaLiveActivity — Capacitor bridge that starts/updates/ends the voice
/// Live Activity from the app when the canonical batch-or-realtime session
/// begins, progresses, and ends. The ElizaWidgets extension renders the
/// `ElizaDictationAttributes` content state on the Lock Screen and Dynamic
/// Island; keyboard dictation reuses the same bridge with its recording phase.
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
///   - `start({ sessionTitleKind?, sessionTitle?, phase? })` → `{ activityId }`
///   - `update({ activityId?, phase })` → `{ updated }`
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
    @MainActor private static var currentActivityId: String?
    @MainActor private static var currentStartedAt: Date?
    // Every start/end advances the generation. A late async start can only
    // create an activity when it still owns the newest lifecycle request.
    @MainActor private static var lifecycleGeneration = 0

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

        let title = Self.sessionTitle(from: call)
        let phase = Self.phase(from: call.getString("phase")) ?? .ready
        Task { @MainActor in
            Self.lifecycleGeneration += 1
            let generation = Self.lifecycleGeneration
            let previousStartedAt = Self.currentStartedAt ?? Date()
            // A new start claims native ownership before the orphan cleanup
            // yields. An explicit late end for the previous id can then finish
            // only that activity without cancelling this generation.
            Self.currentActivityId = nil
            Self.currentStartedAt = nil
            // A terminated app can leave an ActivityKit surface behind. A new
            // explicit session first clears every orphan so one session owns at
            // most one Live Activity across relaunches.
            await Self.endActivities(
                id: nil,
                phase: .ended,
                startedAt: previousStartedAt,
                dismissalPolicy: .immediate
            )
            guard generation == Self.lifecycleGeneration else {
                call.reject("Live Activity start was superseded")
                return
            }

            let startedAt = Date()
            let attributes = ElizaDictationAttributes(sessionTitle: title)
            let state = ElizaDictationAttributes.ContentState(
                phase: phase,
                startedAt: startedAt,
                transcriptSnippet: ""
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
    }

    private enum SessionTitleKind: String {
        case keyboardDictation = "keyboard-dictation"
    }

    private static func sessionTitle(from call: CAPPluginCall) -> String {
        if
            let requestedTitle = call.getString("sessionTitle"),
            !requestedTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            // Genuine caller-supplied titles remain verbatim. App-owned titles
            // cross the bridge as semantic kinds and localize natively.
            return requestedTitle
        }

        switch call.getString("sessionTitleKind").flatMap(SessionTitleKind.init(rawValue:)) {
        case .keyboardDictation:
            return String(localized: "Keyboard dictation")
        case .none:
            return String(localized: "Voice session")
        }
    }

    @objc public func update(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.reject("Live Activities require iOS 16.1 or later")
            return
        }
        let explicitId = call.getString("activityId")
        let phase = Self.phase(from: call.getString("phase")) ?? .ready

        Task { @MainActor in
            let requestedId = explicitId ?? Self.currentActivityId
            guard
                let requestedId,
                let activity = Activity<ElizaDictationAttributes>.activities
                    .first(where: { $0.id == requestedId })
            else {
                call.reject("No active Live Activity to update")
                return
            }
            let startedAt = requestedId == Self.currentActivityId
                ? Self.currentStartedAt ?? Date()
                : Date()
            let state = ElizaDictationAttributes.ContentState(
                phase: phase,
                startedAt: startedAt,
                transcriptSnippet: ""
            )
            let generation = Self.lifecycleGeneration
            if #available(iOS 16.2, *) {
                await activity.update(ActivityContent(state: state, staleDate: nil))
            } else {
                await activity.update(using: state)
            }
            call.resolve(["updated": generation == Self.lifecycleGeneration])
        }
    }

    @objc public func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve(["ended": false])
            return
        }
        let explicitId = call.getString("activityId")
        let phase = Self.phase(from: call.getString("phase")) ?? .ended

        Task { @MainActor in
            let requestedId = explicitId ?? Self.currentActivityId
            let ownsCurrent = explicitId == nil || explicitId == Self.currentActivityId
            let startedAt = ownsCurrent ? Self.currentStartedAt ?? Date() : Date()
            if ownsCurrent {
                Self.lifecycleGeneration += 1
                Self.currentActivityId = nil
                Self.currentStartedAt = nil
            }
            let dismissalPolicy: ActivityUIDismissalPolicy = phase == .error
                ? .after(Date().addingTimeInterval(10))
                : .immediate
            await Self.endActivities(
                id: requestedId,
                phase: phase,
                startedAt: startedAt,
                dismissalPolicy: dismissalPolicy
            )
            call.resolve(["ended": true])
        }
    }

    @available(iOS 16.1, *)
    @MainActor
    private static func endActivities(
        id: String?,
        phase: ElizaDictationAttributes.ContentState.Phase,
        startedAt: Date,
        dismissalPolicy: ActivityUIDismissalPolicy
    ) async {
        let activities = Activity<ElizaDictationAttributes>.activities
            .filter { id == nil || $0.id == id }
        let finalState = ElizaDictationAttributes.ContentState(
            phase: phase,
            startedAt: startedAt,
            transcriptSnippet: ""
        )
        for activity in activities {
            if #available(iOS 16.2, *) {
                await activity.end(
                    ActivityContent(state: finalState, staleDate: nil),
                    dismissalPolicy: dismissalPolicy
                )
            } else {
                await activity.end(using: finalState, dismissalPolicy: dismissalPolicy)
            }
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
