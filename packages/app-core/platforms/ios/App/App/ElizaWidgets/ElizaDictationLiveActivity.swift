/**
 The widget extension renders the localized Lock Screen and Dynamic Island
 presentation for the app-owned voice and dictation Live Activity.
 */
import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

// Lock Screen + Dynamic Island rendering for a voice/dictation session. The
// `ElizaLiveActivityBridge` in the app target drives the `ContentState`; this
// file only presents it. The interactive Stop button is iOS 18+ (it uses
// `OpenURLIntent`, same gate as the widget controls); on 16.1–17 the whole
// activity taps through to the app via `widgetURL`. Every entry routes the
// `elizaos://` spine tagged `source=ios-live-activity`.

// MARK: - Interactive buttons (iOS 18+)

// Thin open-the-app shim: `openAppWhenRun` foregrounds the app (stopping the
// mic happens in the app, which owns the audio session and
// the ActivityKit handle) and the returned URL routes the deep-link spine.
// `OpenURLIntent` is iOS 18+ (same gate as the ElizaWidgets controls); on
// 16.1–17 the whole activity taps through via `widgetURL`.

@available(iOS 18.0, *)
struct StopElizaVoiceIntent: AppIntent {
    static var title: LocalizedStringResource = "Stop"
    static var description = IntentDescription("Stop the current Eliza voice session.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(ElizaWidgetDeepLink.dictation(action: "stop-voice")))
    }
}

// MARK: - Phase presentation

@available(iOS 16.1, *)
extension ElizaDictationAttributes.ContentState.Phase {
    var label: LocalizedStringResource {
        switch self {
        case .recording: return "Recording"
        case .ready: return "Ready"
        case .listening: return "Listening"
        case .transcribing: return "Transcribing"
        case .thinking: return "Thinking"
        case .speaking: return "Speaking"
        case .error: return "Error"
        case .ended: return "Ended"
        }
    }

    var systemImage: String {
        switch self {
        case .recording: return "mic.fill"
        case .ready: return "waveform"
        case .listening: return "mic.fill"
        case .transcribing: return "waveform"
        case .thinking: return "ellipsis"
        case .speaking: return "speaker.wave.2.fill"
        case .error: return "exclamationmark.triangle.fill"
        case .ended: return "checkmark.circle.fill"
        }
    }

    var isTerminal: Bool {
        self == .error || self == .ended
    }
}

// MARK: - Lock Screen / banner view

@available(iOS 16.1, *)
struct ElizaDictationLockScreenView: View {
    let context: ActivityViewContext<ElizaDictationAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: context.state.phase.systemImage)
                    .foregroundStyle(elizaWidgetAccent)
                Text(context.attributes.sessionTitle)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 0)
                Text(context.state.startedAt, style: .timer)
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 56, alignment: .trailing)
            }

            Text(context.state.phase.label)
                .font(.caption)
                .foregroundStyle(elizaWidgetAccent)

            if #available(iOS 18.0, *), !context.state.phase.isTerminal {
                HStack {
                    Button(intent: StopElizaVoiceIntent()) {
                        Label("Stop", systemImage: "stop.fill")
                            .font(.caption.bold())
                    }
                    .tint(elizaWidgetAccent)
                }
                .buttonStyle(.bordered)
            }
        }
        .padding()
        .activityBackgroundTint(Color(uiColor: .systemBackground).opacity(0.6))
        .activitySystemActionForegroundColor(elizaWidgetAccent)
    }
}

// MARK: - Configuration

@available(iOS 16.1, *)
struct ElizaDictationLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ElizaDictationAttributes.self) { context in
            ElizaDictationLockScreenView(context: context)
                .widgetURL(ElizaWidgetDeepLink.dictation(action: "open"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Label {
                        Text(context.attributes.sessionTitle).lineLimit(1)
                    } icon: {
                        Image(systemName: context.state.phase.systemImage)
                            .foregroundStyle(elizaWidgetAccent)
                    }
                    .font(.headline)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(context.state.startedAt, style: .timer)
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: 56, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(context.state.phase.label)
                            .font(.caption)
                            .foregroundStyle(elizaWidgetAccent)
                        if #available(iOS 18.0, *), !context.state.phase.isTerminal {
                            HStack {
                                Button(intent: StopElizaVoiceIntent()) {
                                    Label("Stop", systemImage: "stop.fill")
                                }
                                .tint(elizaWidgetAccent)
                            }
                            .buttonStyle(.bordered)
                            .font(.caption.bold())
                        }
                    }
                }
            } compactLeading: {
                Image(systemName: context.state.phase.systemImage)
                    .foregroundStyle(elizaWidgetAccent)
            } compactTrailing: {
                Text(context.state.startedAt, style: .timer)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: 44, alignment: .trailing)
            } minimal: {
                Image(systemName: context.state.phase.systemImage)
                    .foregroundStyle(elizaWidgetAccent)
            }
            .widgetURL(ElizaWidgetDeepLink.dictation(action: "open"))
        }
    }
}
