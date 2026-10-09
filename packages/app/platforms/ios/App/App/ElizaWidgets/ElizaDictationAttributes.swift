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
        // `recording` remains for the keyboard-dictation handoff. The other
        // states mirror the canonical batch-or-realtime Eliza voice session;
        // error/ended are terminal and may be displayed only briefly.
        enum Phase: String, Codable, Hashable {
            case recording
            case ready
            case listening
            case transcribing
            case thinking
            case speaking
            case error
            case ended
        }

        var phase: Phase
        // Session anchor for the Lock Screen / Dynamic Island live timer
        // (`Text(timerInterval:)`), so elapsed time renders without a per-second
        // Activity update burning the ActivityKit budget.
        var startedAt: Date
        // Retained for ActivityKit state compatibility, but the app writes an
        // empty value and the extension never renders private transcript text.
        var transcriptSnippet: String
    }

    // Immutable for the session's lifetime; shown as the activity's label.
    var sessionTitle: String
}
