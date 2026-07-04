import SwiftUI
import WidgetKit

/// Deep-link construction for widget and control entry points. Mirrors
/// `ElizaAppIntentRouter` in the app target: every native entry point mints an
/// `elizaos://<host>?source=<entry>&action=…` URL that routes through the app
/// shell's deep-link handler, and the `source` tag proves which surface fired.
enum ElizaWidgetDeepLink {
    private static let scheme = "elizaos"

    enum Source: String {
        case widget = "ios-widget"
        case control = "ios-control"
        case liveActivity = "ios-live-activity"
    }

    static func ask(source: Source) -> URL {
        url(path: "assistant", action: "ask", source: source)
    }

    /// Live Activity tap/button target: opens the voice surface tagged
    /// `source=ios-live-activity` with the given action (`open`/`stop`/`save`)
    /// so the app can act on the button and logs prove the entry point.
    static func dictation(action: String) -> URL {
        url(
            path: "voice",
            action: action,
            source: .liveActivity,
            extraItems: [URLQueryItem(name: "voice", value: "1")]
        )
    }

    static func voice(source: Source) -> URL {
        url(
            path: "voice",
            action: "voice",
            source: source,
            extraItems: [URLQueryItem(name: "voice", value: "1")]
        )
    }

    static func dailyBrief(source: Source) -> URL {
        url(path: "lifeops/daily-brief", action: "lifeops.daily-brief", source: source)
    }

    static func newTask(source: Source) -> URL {
        url(path: "lifeops/task/new", action: "lifeops.create", source: source)
    }

    static func smartReply(source: Source) -> URL {
        url(path: "chat", action: "smart-reply", source: source)
    }

    private static func url(
        path: String,
        action: String,
        source: Source,
        extraItems: [URLQueryItem] = []
    ) -> URL {
        var components = URLComponents()
        components.scheme = scheme

        let parts = path.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true)
        components.host = parts.first.map(String.init) ?? path
        if parts.count > 1 {
            components.path = "/" + parts[1]
        }

        var items = [
            URLQueryItem(name: "source", value: source.rawValue),
            URLQueryItem(name: "action", value: action),
        ]
        items.append(contentsOf: extraItems)
        components.queryItems = items

        guard let url = components.url else {
            preconditionFailure("ElizaWidgetDeepLink: invalid components for path \(path)")
        }
        return url
    }
}

/// elizaOS brand accent (#FF5800) — accent only, on neutral backgrounds.
let elizaWidgetAccent = Color(red: 1.0, green: 0.345, blue: 0.0)

struct ElizaWidgetEntry: TimelineEntry {
    let date: Date
}

struct ElizaWidgetTimelineProvider: TimelineProvider {
    func placeholder(in _: Context) -> ElizaWidgetEntry {
        ElizaWidgetEntry(date: .now)
    }

    func getSnapshot(in _: Context, completion: @escaping (ElizaWidgetEntry) -> Void) {
        completion(ElizaWidgetEntry(date: .now))
    }

    func getTimeline(in _: Context, completion: @escaping (Timeline<ElizaWidgetEntry>) -> Void) {
        completion(Timeline(entries: [ElizaWidgetEntry(date: .now)], policy: .never))
    }
}

/// The five quick actions mirror the app target's App Intents
/// (`ElizaAppIntents.swift`): Ask, Voice, Daily Brief, New Task, Smart Reply.
private struct ElizaQuickAction: Identifiable {
    let id: String
    let title: String
    let systemImage: String
    let url: URL
}

private let elizaQuickActions: [ElizaQuickAction] = [
    ElizaQuickAction(
        id: "ask",
        title: "Ask",
        systemImage: "sparkles",
        url: ElizaWidgetDeepLink.ask(source: .widget)
    ),
    ElizaQuickAction(
        id: "voice",
        title: "Voice",
        systemImage: "waveform",
        url: ElizaWidgetDeepLink.voice(source: .widget)
    ),
    ElizaQuickAction(
        id: "daily-brief",
        title: "Brief",
        systemImage: "sun.max",
        url: ElizaWidgetDeepLink.dailyBrief(source: .widget)
    ),
    ElizaQuickAction(
        id: "new-task",
        title: "Task",
        systemImage: "checklist",
        url: ElizaWidgetDeepLink.newTask(source: .widget)
    ),
    ElizaQuickAction(
        id: "smart-reply",
        title: "Reply",
        systemImage: "text.bubble",
        url: ElizaWidgetDeepLink.smartReply(source: .widget)
    ),
]

extension View {
    /// `containerBackground(_:for:)` is required on iOS 17+ (widgets render a
    /// placeholder without it) but unavailable on the iOS 16 deployment floor.
    @ViewBuilder
    func elizaWidgetBackground() -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(.background, for: .widget)
        } else {
            background(Color(uiColor: .systemBackground))
        }
    }
}

struct ElizaQuickActionsWidgetView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        switch family {
        case .accessoryCircular:
            accessoryCircular
        case .accessoryRectangular:
            accessoryRectangular
        case .systemMedium:
            systemMedium
        default:
            systemSmall
        }
    }

    private var systemSmall: some View {
        VStack(alignment: .leading, spacing: 6) {
            Image(systemName: "sparkles")
                .font(.title2)
                .foregroundStyle(elizaWidgetAccent)
            Spacer(minLength: 0)
            Text("Ask Eliza")
                .font(.headline)
            Text("Chat · Voice · Tasks")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .elizaWidgetBackground()
        .widgetURL(ElizaWidgetDeepLink.ask(source: .widget))
    }

    private var systemMedium: some View {
        HStack(spacing: 0) {
            ForEach(elizaQuickActions) { action in
                Link(destination: action.url) {
                    VStack(spacing: 6) {
                        Image(systemName: action.systemImage)
                            .font(.title3)
                            .foregroundStyle(elizaWidgetAccent)
                            .frame(height: 24)
                        Text(action.title)
                            .font(.caption2)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .elizaWidgetBackground()
    }

    private var accessoryCircular: some View {
        ZStack {
            AccessoryWidgetBackground()
            Image(systemName: "waveform")
                .font(.title2)
        }
        .elizaWidgetBackground()
        .widgetURL(ElizaWidgetDeepLink.voice(source: .widget))
    }

    private var accessoryRectangular: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles")
                .font(.title3)
            VStack(alignment: .leading, spacing: 1) {
                Text("Ask Eliza")
                    .font(.headline)
                Text("Chat · Voice · Tasks")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .elizaWidgetBackground()
        .widgetURL(ElizaWidgetDeepLink.ask(source: .widget))
    }
}

struct ElizaQuickActionsWidget: Widget {
    static let kind = "ElizaQuickActionsWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: ElizaWidgetTimelineProvider()) { _ in
            ElizaQuickActionsWidgetView()
        }
        .configurationDisplayName("Eliza Quick Actions")
        .description("Ask, talk, and plan with Eliza from your Home and Lock Screen.")
        .supportedFamilies([
            .systemSmall,
            .systemMedium,
            .accessoryCircular,
            .accessoryRectangular,
        ])
    }
}

@main
struct ElizaWidgetsBundle: WidgetBundle {
    var body: some Widget {
        ElizaQuickActionsWidget()
        if #available(iOS 16.1, *) {
            ElizaDictationLiveActivity()
        }
        if #available(iOS 18.0, *) {
            ElizaAskControl()
        }
        if #available(iOS 18.0, *) {
            ElizaVoiceControl()
        }
    }
}
