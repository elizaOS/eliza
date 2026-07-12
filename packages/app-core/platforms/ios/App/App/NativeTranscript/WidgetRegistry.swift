import SwiftUI

/// Native widget seam for the transcript renderer: maps a segment's
/// `widgetKind` to a SwiftUI view builder, with a placeholder card for every
/// kind that has no native body yet — the transcript never crashes or blanks
/// on a kind it does not know.
///
/// Two lanes share this registry WITHOUT sharing files:
///   - this file (core lane) owns the registry, the context/protocol types,
///     and the placeholder;
///   - the ios-widgets lane implements widget bodies in ITS OWN files and
///     provides the one extension point, in its own file:
///
///       @available(iOS 16.0, *)
///       extension TranscriptWidgetRegistry {
///           static func registerBuiltins() {
///               register("choice", ChoiceTranscriptWidget.self)
///               register("followups", FollowupsTranscriptWidget.self)
///               // … form, workflow, checklist, task, background,
///               //   permissionKind, uiSpecKind, configKind …
///           }
///       }
///
/// The seam compiles in BOTH states: `TranscriptWidgetBuiltins` supplies a
/// no-op `registerBuiltins()` protocol-extension default, and a concrete
/// member declared in a type extension shadows a protocol-extension member
/// for direct calls — so `TranscriptWidgetRegistry.registerBuiltins()` (the
/// plugin's `load()` call) is the default no-op until the widgets lane's file
/// lands, then their implementation, with zero edits to this file.
///
/// Action protocol: widget bodies emit plain action strings through
/// `TranscriptWidgetContext.sendAction` — byte-identical to the DOM widgets'
/// `sendActionMessage` payloads (documented at the bottom of
/// `packages/ui/src/chat/native-transcript/spec.ts`). Never add a second
/// action channel.

/// Everything a native widget body needs: the kind, the decoded JSON payload
/// (the segment's `data`), and the single action channel back to JS.
@available(iOS 16.0, *)
struct TranscriptWidgetContext {
    let widgetKind: String
    let data: TranscriptJSONValue
    /// Emits one `kind: "message"` action — the same strings the DOM widgets
    /// pass to `sendActionMessage`.
    let sendAction: (String) -> Void
    /// Emits a typed envelope (navigate / prefill / background — the intents
    /// whose DOM equivalents are LOCAL, never chat text; see spec.ts).
    let sendEnvelope: ([String: String]) -> Void
}

/// Conformance shape for widget bodies registered by type. Closures work too
/// (`register(_:builder:)`) when a widget needs extra construction context.
@available(iOS 16.0, *)
protocol TranscriptWidgetView: View {
    init(context: TranscriptWidgetContext)
}

/// Seam carrier — see the header. Do NOT add members here; the only purpose
/// of this protocol is the shadowable `registerBuiltins()` default.
protocol TranscriptWidgetBuiltins {}

extension TranscriptWidgetBuiltins {
    /// Default: no native widget bodies — every kind renders the placeholder
    /// card. The ios-widgets lane shadows this via a concrete
    /// `extension TranscriptWidgetRegistry { static func registerBuiltins() }`
    /// in its own file.
    static func registerBuiltins() {}
}

/// Main-thread only (register at plugin load, resolve during SwiftUI render);
/// mirrors GlassBridge's queue-confined state style.
@available(iOS 16.0, *)
enum TranscriptWidgetRegistry: TranscriptWidgetBuiltins {
    /// Reserved kinds: non-widget segment kinds routed through this same
    /// registry so the widgets lane can take them over without a second seam.
    /// `permissionKind` data is the permission segment's `payload`;
    /// `uiSpecKind` data is `.string(raw)` (the raw GenUI JSON — native
    /// re-validates); `configKind` data is `.string(pluginId)`.
    static let permissionKind = "permission"
    static let uiSpecKind = "ui-spec"
    static let configKind = "config"

    private static var builders: [String: (TranscriptWidgetContext) -> AnyView] = [:]

    static func register(
        _ kind: String,
        builder: @escaping (TranscriptWidgetContext) -> AnyView
    ) {
        builders[kind] = builder
    }

    static func register<W: TranscriptWidgetView>(_ kind: String, _ widget: W.Type) {
        builders[kind] = { AnyView(W(context: $0)) }
    }

    static func view(for context: TranscriptWidgetContext) -> AnyView {
        if let builder = builders[context.widgetKind] {
            return builder(context)
        }
        return AnyView(TranscriptWidgetPlaceholder(kind: context.widgetKind))
    }

    /// Test seam: drop every registration between cases.
    static func resetForTests() {
        builders = [:]
    }
}

/// Unfilled-slot card for widget kinds with no native body yet: names the
/// kind, never crashes. The dashed hairline is load-bearing chrome — it marks
/// the slot as pending rather than styling a card.
@available(iOS 16.0, *)
struct TranscriptWidgetPlaceholder: View {
    let kind: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "square.dashed")
                .font(.system(size: 12))
                .foregroundStyle(Color.white.opacity(0.45))
            Text(kind)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Color.white.opacity(0.6))
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(
                    Color.white.opacity(0.14),
                    style: StrokeStyle(lineWidth: 1, dash: [4, 4])
                )
        }
        .accessibilityLabel("\(kind) widget")
    }
}
