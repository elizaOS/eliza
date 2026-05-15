import AppIntents
import UIKit

@available(iOS 16.0, *)
enum ElizaAssistantShortcutRouter {
    @MainActor
    static func open(
        host: String,
        path: String = "",
        source: String,
        action: String,
        text: String? = nil
    ) {
        var components = URLComponents()
        components.scheme = "elizaos"
        components.host = host
        components.path = path

        var queryItems = [
            URLQueryItem(name: "source", value: source),
            URLQueryItem(name: "action", value: action),
        ]
        if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            queryItems.append(URLQueryItem(name: "text", value: text))
        }
        components.queryItems = queryItems

        guard let url = components.url else {
            return
        }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }
}

@available(iOS 16.0, *)
struct AskElizaIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Eliza"
    static var description = IntentDescription("Send a request to Eliza.")
    static var openAppWhenRun = true

    @Parameter(title: "Request")
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Eliza \(\.$text)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        ElizaAssistantShortcutRouter.open(
            host: "assistant",
            source: "ios-app-shortcuts",
            action: "ask",
            text: text
        )
        return .result()
    }
}

@available(iOS 16.0, *)
struct CreateElizaLifeOpsTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Create LifeOps Task"
    static var description = IntentDescription("Send a LifeOps task request to Eliza.")
    static var openAppWhenRun = true

    @Parameter(title: "Task")
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Create LifeOps task \(\.$text)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        ElizaAssistantShortcutRouter.open(
            host: "lifeops",
            path: "/create",
            source: "ios-app-shortcuts",
            action: "task",
            text: text
        )
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenElizaVoiceIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Eliza Voice"
    static var description = IntentDescription("Open Eliza voice mode.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        ElizaAssistantShortcutRouter.open(
            host: "voice",
            source: "ios-app-shortcuts",
            action: "voice"
        )
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenElizaDailyBriefIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Eliza Daily Brief"
    static var description = IntentDescription("Open the LifeOps daily brief in Eliza.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        ElizaAssistantShortcutRouter.open(
            host: "lifeops",
            path: "/daily-brief",
            source: "ios-app-shortcuts",
            action: "daily-brief"
        )
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenElizaTasksIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Eliza Tasks"
    static var description = IntentDescription("Open LifeOps tasks in Eliza.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        ElizaAssistantShortcutRouter.open(
            host: "lifeops",
            path: "/tasks",
            source: "ios-app-shortcuts",
            action: "tasks"
        )
        return .result()
    }
}

@available(iOS 16.0, *)
struct ElizaAppShortcuts: AppShortcutsProvider {
    static var shortcutTileColor: ShortcutTileColor = .blue

    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskElizaIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) a question",
            ],
            shortTitle: "Ask",
            systemImageName: "sparkles"
        )
        AppShortcut(
            intent: CreateElizaLifeOpsTaskIntent(),
            phrases: [
                "Create a task in \(.applicationName)",
                "Remind me with \(.applicationName)",
            ],
            shortTitle: "New Task",
            systemImageName: "checklist"
        )
        AppShortcut(
            intent: OpenElizaVoiceIntent(),
            phrases: [
                "Start voice in \(.applicationName)",
                "Talk to \(.applicationName)",
            ],
            shortTitle: "Voice",
            systemImageName: "waveform"
        )
        AppShortcut(
            intent: OpenElizaDailyBriefIntent(),
            phrases: [
                "Open daily brief in \(.applicationName)",
            ],
            shortTitle: "Daily Brief",
            systemImageName: "sun.max"
        )
        AppShortcut(
            intent: OpenElizaTasksIntent(),
            phrases: [
                "Open tasks in \(.applicationName)",
            ],
            shortTitle: "Tasks",
            systemImageName: "list.bullet"
        )
    }
}
