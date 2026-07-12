import Combine
import SwiftUI

/// SwiftUI transcript list the NativeTranscript plugin mounts above the
/// webview. Dark-glass design language: the list background stays transparent
/// so the native backdrop/glass shows through; user turns are right-aligned
/// dark chips; assistant turns are left-aligned full-width; #ff7a3d is the
/// ONLY accent (no blue anywhere); chrome is minimal — no card borders unless
/// load-bearing. Information hierarchy mirrors the DOM renderer
/// (`MessageContent` + the ChatWidgetHarness scenes): thinking collapses under
/// an orange THINKING disclosure, tool calls are one-line collapsible rows,
/// failed turns keep an obvious Retry, streaming turns breathe.
///
/// All interactivity funnels through one `sendAction` closure — the plain
/// action strings of `spec.ts`. The view never invents a second channel.

/// Bridge-owned observable frame slot: the plugin replaces the whole frame on
/// every `setTranscript` (main thread only) and SwiftUI diffs by message id
/// via `ForEach`/`Equatable`.
final class TranscriptFrameStore: ObservableObject {
    @Published var frame: TranscriptFrame = .empty
}

/// Single source for the palette so the accent rule is enforced in one place.
@available(iOS 16.0, *)
enum TranscriptTheme {
    /// #ff7a3d — the only accent color in the transcript.
    static let accent = Color(red: 1.0, green: 122.0 / 255.0, blue: 61.0 / 255.0)
    static let primaryText = Color.white.opacity(0.92)
    static let secondaryText = Color.white.opacity(0.62)
    static let faintText = Color.white.opacity(0.45)
    /// User bubble: dark chip over the glass, not a bright card.
    static let chipFill = Color.black.opacity(0.32)
    static let codeFill = Color.white.opacity(0.06)
    static let panelFill = Color.white.opacity(0.05)
    /// Semantic error red (failure rows only — never used as an accent).
    static let error = Color(red: 1.0, green: 0.42, blue: 0.38)
}

@available(iOS 16.0, *)
struct TranscriptListView: View {
    @ObservedObject var store: TranscriptFrameStore
    let sendAction: (String) -> Void

    private static let tailAnchor = "transcript-tail"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 18) {
                    ForEach(store.frame.messages) { message in
                        TranscriptMessageRow(message: message, sendAction: sendAction)
                            .id(message.id)
                    }
                    if let status = store.frame.turnStatus {
                        TranscriptTurnStatusRow(status: status)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.tailAnchor)
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 8)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .background(Color.clear)
            .onAppear {
                proxy.scrollTo(Self.tailAnchor, anchor: .bottom)
            }
            .onChange(of: store.frame) { _ in
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(Self.tailAnchor, anchor: .bottom)
                }
            }
        }
        // The list draws for the dark-glass surface regardless of the system
        // appearance — the backdrop behind it is always dark.
        .environment(\.colorScheme, .dark)
    }
}

// MARK: - Message rows

@available(iOS 16.0, *)
private struct TranscriptMessageRow: View {
    let message: TranscriptMessage
    let sendAction: (String) -> Void

    var body: some View {
        if message.role == .user {
            userRow
        } else {
            assistantRow
        }
    }

    /// User turns are raw text by contract (spec.ts): join the text segments,
    /// render one right-aligned dark chip.
    private var userRow: some View {
        HStack(alignment: .bottom) {
            Spacer(minLength: 48)
            Text(userText)
                .font(.system(size: 16))
                .foregroundStyle(TranscriptTheme.primaryText)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(
                    TranscriptTheme.chipFill,
                    in: RoundedRectangle(cornerRadius: 18, style: .continuous)
                )
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var userText: String {
        message.segments
            .compactMap { segment -> String? in
                if case .text(let text) = segment { return text }
                return nil
            }
            .joined()
    }

    /// Streaming-natural order: thinking, then the tool log, then content,
    /// then side-channel affordances (secret request, failure, dots).
    private var assistantRow: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let reasoning = message.reasoning {
                TranscriptThinkingRow(reasoning: reasoning)
            }
            if let events = message.toolEvents, !events.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                        TranscriptToolEventRow(event: event)
                    }
                }
            }
            ForEach(Array(message.segments.enumerated()), id: \.offset) { _, segment in
                TranscriptSegmentView(segment: segment, sendAction: sendAction)
            }
            if let secretRequest = message.secretRequest {
                TranscriptSecretRequestRow(request: secretRequest)
            }
            if let failureKind = message.failureKind {
                TranscriptFailureRow(failureKind: failureKind, sendAction: sendAction)
            }
            if message.streaming == true {
                TranscriptBreathingDots()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Segments

@available(iOS 16.0, *)
struct TranscriptSegmentView: View {
    let segment: TranscriptSegment
    let sendAction: (String) -> Void

    var body: some View {
        switch segment {
        case .text(let text):
            TranscriptMarkdownText(text: text)
        case .code(let code, let lang, let inline):
            if inline {
                TranscriptInlineCode(code: code)
            } else {
                TranscriptCodeBlock(code: code, lang: lang)
            }
        case .widget(let widgetKind, let data):
            TranscriptWidgetRegistry.view(
                for: TranscriptWidgetContext(
                    widgetKind: widgetKind, data: data, sendAction: sendAction))
        case .permission(let payload):
            TranscriptWidgetRegistry.view(
                for: TranscriptWidgetContext(
                    widgetKind: TranscriptWidgetRegistry.permissionKind,
                    data: payload, sendAction: sendAction))
        case .uiSpec(let raw):
            TranscriptWidgetRegistry.view(
                for: TranscriptWidgetContext(
                    widgetKind: TranscriptWidgetRegistry.uiSpecKind,
                    data: .string(raw), sendAction: sendAction))
        case .config(let pluginId):
            TranscriptWidgetRegistry.view(
                for: TranscriptWidgetContext(
                    widgetKind: TranscriptWidgetRegistry.configKind,
                    data: .string(pluginId), sendAction: sendAction))
        case .unknown:
            // DOM parity: unknown segment kinds render nothing.
            EmptyView()
        }
    }
}

@available(iOS 16.0, *)
struct TranscriptMarkdownText: View {
    let text: String

    var body: some View {
        Text(attributed)
            .font(.system(size: 16))
            .foregroundStyle(TranscriptTheme.primaryText)
            .tint(TranscriptTheme.accent)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var attributed: AttributedString {
        // error-policy:J4 designed degrade — markdown that fails to parse
        // renders as its literal text; the words are always shown, only the
        // inline styling is lost.
        (try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

@available(iOS 16.0, *)
struct TranscriptCodeBlock: View {
    let code: String
    let lang: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let lang, !lang.isEmpty {
                Text(lang.uppercased())
                    .font(.system(size: 10, weight: .semibold))
                    .tracking(1.2)
                    .foregroundStyle(TranscriptTheme.faintText)
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(TranscriptTheme.primaryText)
                    .textSelection(.enabled)
                    .padding(12)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            TranscriptTheme.codeFill,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
    }
}

@available(iOS 16.0, *)
struct TranscriptInlineCode: View {
    let code: String

    var body: some View {
        Text(code)
            .font(.system(size: 14, design: .monospaced))
            .foregroundStyle(TranscriptTheme.primaryText)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(
                TranscriptTheme.codeFill,
                in: RoundedRectangle(cornerRadius: 5, style: .continuous)
            )
    }
}

// MARK: - Side channels

@available(iOS 16.0, *)
struct TranscriptThinkingRow: View {
    let reasoning: String
    @State private var expanded = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(reasoning)
                .font(.system(size: 13))
                .foregroundStyle(TranscriptTheme.secondaryText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 6)
        } label: {
            Text("THINKING")
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.6)
                .foregroundStyle(TranscriptTheme.accent)
        }
        .tint(TranscriptTheme.accent)
    }
}

@available(iOS 16.0, *)
struct TranscriptToolEventRow: View {
    let event: TranscriptToolEvent
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() }
            } label: {
                HStack(spacing: 8) {
                    statusIcon
                    Text(event.resolvedName)
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(TranscriptTheme.secondaryText)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    if let durationMs = event.resolvedDurationMs {
                        Text(Self.formatDuration(durationMs))
                            .font(.system(size: 11))
                            .foregroundStyle(TranscriptTheme.faintText)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(TranscriptTheme.faintText)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                }
            }
            .buttonStyle(.plain)
            if expanded {
                detail
            }
        }
    }

    @ViewBuilder private var statusIcon: some View {
        switch event.resolvedStatus {
        case "error", "failed":
            Image(systemName: "xmark.circle")
                .font(.system(size: 12))
                .foregroundStyle(TranscriptTheme.error)
        case "completed", "success":
            Image(systemName: "checkmark.circle")
                .font(.system(size: 12))
                .foregroundStyle(TranscriptTheme.secondaryText)
        default:
            ProgressView()
                .controlSize(.mini)
                .tint(TranscriptTheme.accent)
        }
    }

    @ViewBuilder private var detail: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let args = event.resolvedArgs {
                detailBlock(args.jsonString(pretty: true))
            }
            if let result = event.resolvedResult {
                detailBlock(result.jsonString(pretty: true))
            }
            if let error = event.error, !error.isEmpty {
                Text(error)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(TranscriptTheme.error)
            }
        }
        .padding(.leading, 20)
    }

    private func detailBlock(_ json: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(json)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(TranscriptTheme.secondaryText)
                .textSelection(.enabled)
                .padding(8)
        }
        .background(
            TranscriptTheme.codeFill,
            in: RoundedRectangle(cornerRadius: 8, style: .continuous)
        )
    }

    static func formatDuration(_ milliseconds: Double) -> String {
        if milliseconds < 1000 {
            return "\(Int(milliseconds))ms"
        }
        return String(format: "%.1fs", milliseconds / 1000)
    }
}

@available(iOS 16.0, *)
struct TranscriptFailureRow: View {
    let failureKind: String
    let sendAction: (String) -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12))
                .foregroundStyle(TranscriptTheme.error)
            Text(Self.label(for: failureKind))
                .font(.system(size: 13))
                .foregroundStyle(TranscriptTheme.secondaryText)
            Spacer(minLength: 8)
            Button("Retry") {
                // Same retry string the DOM's failed-turn affordance sends.
                sendAction("Retry the previous request")
            }
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(TranscriptTheme.accent)
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            TranscriptTheme.error.opacity(0.10),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
    }

    static func label(for kind: String) -> String {
        switch kind {
        case "rate_limited": return "The provider is busy right now."
        case "provider_issue": return "The provider hit a temporary issue."
        case "no_provider": return "No model provider is configured."
        case "insufficient_credits": return "Not enough credits to run this turn."
        default: return "This reply failed."
        }
    }
}

@available(iOS 16.0, *)
struct TranscriptSecretRequestRow: View {
    let request: TranscriptSecretRequest

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "lock.fill")
                .font(.system(size: 13))
                .foregroundStyle(TranscriptTheme.accent)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(TranscriptTheme.primaryText)
                if let reason = request.reason, !reason.isEmpty {
                    Text(reason)
                        .font(.system(size: 13))
                        .foregroundStyle(TranscriptTheme.secondaryText)
                }
                if let status = request.status, status != "pending" {
                    Text(status.capitalized)
                        .font(.system(size: 11))
                        .foregroundStyle(TranscriptTheme.faintText)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            TranscriptTheme.panelFill,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
    }

    private var title: String {
        if let key = request.key, !key.isEmpty {
            return "Secure input requested — \(key)"
        }
        return "Secure input requested"
    }
}

/// Streaming indicator: three accent dots breathing in a phased loop.
@available(iOS 16.0, *)
struct TranscriptBreathingDots: View {
    @State private var breathing = false

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(TranscriptTheme.accent)
                    .frame(width: 6, height: 6)
                    .opacity(breathing ? 0.9 : 0.25)
                    .animation(
                        .easeInOut(duration: 0.7)
                            .repeatForever(autoreverses: true)
                            .delay(Double(index) * 0.18),
                        value: breathing
                    )
            }
        }
        .padding(.vertical, 2)
        .onAppear { breathing = true }
        .accessibilityLabel("Assistant is responding")
    }
}

@available(iOS 16.0, *)
struct TranscriptTurnStatusRow: View {
    let status: TranscriptTurnStatus

    var body: some View {
        HStack(spacing: 8) {
            TranscriptBreathingDots()
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(TranscriptTheme.faintText)
        }
    }

    private var label: String {
        if let explicit = status.label, !explicit.isEmpty { return explicit }
        switch status.kind {
        case "thinking": return "Thinking…"
        case "tool": return "Running tools…"
        default: return status.kind.capitalized
        }
    }
}
