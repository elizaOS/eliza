import ActivityKit
import Foundation

// Shared Live Activity contract for a voice/dictation session. Compiled into
// BOTH the App target (which starts/updates/ends the Activity via
// `ElizaLiveActivityBridge`) and the ElizaWidgets extension (which renders the
// Lock Screen + Dynamic Island). ActivityKit delivers `ContentState` to the
// widget render process, so this struct is the only state channel between the
// two — no App Group round-trip. Extension-safe (no `Activity` class usage),
// which the widget's APPLICATION_EXTENSION_API_ONLY requires.
//
// Live Activities are iOS 16.1+, so every reference is availability-gated.

@available(iOS 16.1, *)
struct ElizaDictationAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        // The four states a voice turn passes through. `recording` and
        // `transcribing` are the Wispr dictation UX; `thinking`/`speaking`
        // cover the continuous-chat turn once the agent responds.
        enum Phase: String, Codable, Hashable {
            case recording
            case transcribing
            case thinking
            case speaking
        }

        var phase: Phase
        // Session anchor for the Lock Screen / Dynamic Island live timer
        // (`Text(timerInterval:)`), so elapsed time renders without a per-second
        // Activity update burning the ActivityKit budget.
        var startedAt: Date
        // Latest partial/committed transcript, trimmed by the app before push.
        var transcriptSnippet: String
    }

    // Immutable for the session's lifetime; shown as the activity's label.
    var sessionTitle: String
}
