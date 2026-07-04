import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

// Lock Screen + Dynamic Island rendering for a voice/dictation session. The
// `ElizaLiveActivityBridge` in the app target drives the `ContentState`; this
// file only presents it. Interactive Stop/Save buttons are iOS 18+ (they use
// `OpenURLIntent`, same gate as the widget controls); on 16.1–17 the whole
// activity taps through to the app via `widgetURL`. Every entry routes the
// `elizaos://` spine tagged `source=ios-live-activity`.

// MARK: - Interactive buttons (iOS 18+)

// Thin open-the-app shims: `openAppWhenRun` foregrounds the app (stopping the
// mic / saving the note happens in the app, which owns the audio session and
// the ActivityKit handle) and the returned URL routes the deep-link spine.
// `OpenURLIntent` is iOS 18+ (same gate as the ElizaWidgets controls); on
// 16.1–17 the whole activity taps through via `widgetURL`.

@available(iOS 18.0, *)
struct StopElizaDictationIntent: AppIntent {
    static var title: LocalizedStringResource = "Stop Dictation"
    static var description = IntentDescription("Stop the current Eliza voice session.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(ElizaWidgetDeepLink.dictation(action: "stop")))
    }
}

@available(iOS 18.0, *)
struct SaveElizaDictationIntent: AppIntent {
    static var title: LocalizedStringResource = "Save Dictation"
    static var description = IntentDescription("Save the current Eliza voice transcript.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(ElizaWidgetDeepLink.dictation(action: "save")))
    }
}

// MARK: - Phase presentation

@available(iOS 16.1, *)
extension ElizaDictationAttributes.ContentState.Phase {
    var label: String {
        switch self {
        case .recording: return "Recording"
        case .transcribing: return "Transcribing"
        case .thinking: return "Thinking"
        case .speaking: return "Speaking"
        }
    }

    var systemImage: String {
        switch self {
        case .recording: return "mic.fill"
        case .transcribing: return "waveform"
        case .thinking: return "ellipsis"
        case .speaking: return "speaker.wave.2.fill"
        }
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

            if !context.state.transcriptSnippet.isEmpty {
                Text(context.state.transcriptSnippet)
                    .font(.callout)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
            }

            if #available(iOS 18.0, *) {
                HStack(spacing: 10) {
                    Button(intent: StopElizaDictationIntent()) {
                        Label("Stop", systemImage: "stop.fill")
                            .font(.caption.bold())
                    }
                    .tint(elizaWidgetAccent)

                    Button(intent: SaveElizaDictationIntent()) {
                        Label("Save", systemImage: "square.and.arrow.down")
                            .font(.caption.bold())
                    }
                    .tint(.secondary)
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
                        if !context.state.transcriptSnippet.isEmpty {
                            Text(context.state.transcriptSnippet)
                                .font(.callout)
                                .lineLimit(2)
                        }
                        if #available(iOS 18.0, *) {
                            HStack(spacing: 10) {
                                Button(intent: StopElizaDictationIntent()) {
                                    Label("Stop", systemImage: "stop.fill")
                                }
                                .tint(elizaWidgetAccent)
                                Button(intent: SaveElizaDictationIntent()) {
                                    Label("Save", systemImage: "square.and.arrow.down")
                                }
                                .tint(.secondary)
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
