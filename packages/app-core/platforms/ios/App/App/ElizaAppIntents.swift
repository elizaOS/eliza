import AppIntents
import Foundation
import UIKit

@available(iOS 16.0, *)
private enum ElizaAppIntentRouter {
    private static let scheme = "elizaos"
    private static let source = "ios-app-intents"

    @MainActor
    static func open(path: String, action: String? = nil, text: String? = nil, extraItems: [URLQueryItem] = []) {
        guard let url = makeURL(path: path, action: action, text: text, extraItems: extraItems) else {
            return
        }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }

    private static func makeURL(path: String, action: String?, text: String?, extraItems: [URLQueryItem]) -> URL? {
        var components = URLComponents()
        components.scheme = scheme

        let parts = path.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: true)
        guard let host = parts.first else {
            return nil
        }
        components.host = String(host)
        if parts.count > 1 {
            components.path = "/" + parts[1]
        }

        var items = [URLQueryItem(name: "source", value: source)]
        if let action = normalized(action) {
            items.append(URLQueryItem(name: "action", value: action))
        }
        if let text = normalized(text) {
            items.append(URLQueryItem(name: "text", value: text))
        }
        items.append(contentsOf: extraItems.filter { normalized($0.value) != nil })
        components.queryItems = items
        return components.url
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

@available(iOS 16.0, *)
struct AskElizaIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Eliza"
    static var description = IntentDescription("Ask Eliza a question or hand off a request to chat.")
    static var openAppWhenRun = true

    @Parameter(title: "Prompt", requestValueDialog: "What would you like to ask Eliza?")
    var prompt: String?

    @MainActor
    func perform() async throws -> some IntentResult {
        ElizaAppIntentRouter.open(path: "assistant", action: "ask", text: prompt)
        return .result()
    }
}

@available(iOS 16.0, *)
struct StartElizaVoiceIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Voice Chat"
    static var description = IntentDescription("Open Eliza directly into voice chat.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        ElizaAppIntentRouter.open(
            path: "voice",
            action: "voice",
            extraItems: [URLQueryItem(name: "voice", value: "1")]
        )
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenElizaDailyBriefIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Daily Brief"
    static var description = IntentDescription("Open the LifeOps daily brief in Eliza.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        ElizaAppIntentRouter.open(path: "lifeops/daily-brief", action: "lifeops.daily-brief")
        return .result()
    }
}

@available(iOS 16.0, *)
struct CreateElizaTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Create LifeOps Task"
    static var description = IntentDescription("Ask Eliza to create or plan a LifeOps task.")
    static var openAppWhenRun = true

    @Parameter(title: "Task", requestValueDialog: "What task should Eliza create?")
    var task: String?

    @MainActor
    func perform() async throws -> some IntentResult {
        ElizaAppIntentRouter.open(path: "lifeops/task/new", action: "lifeops.create", text: task)
        return .result()
    }
}

@available(iOS 16.0, *)
struct DraftElizaSmartReplyIntent: AppIntent {
    static var title: LocalizedStringResource = "Draft Smart Reply"
    static var description = IntentDescription("Ask Eliza to draft a reply from copied or dictated context.")
    static var openAppWhenRun = true

    @Parameter(title: "Context", requestValueDialog: "What should Eliza reply to?")
    var context: String?

    @MainActor
    func perform() async throws -> some IntentResult {
        ElizaAppIntentRouter.open(path: "chat", action: "smart-reply", text: context)
        return .result()
    }
}

@available(iOS 16.0, *)
struct ElizaAppShortcutsProvider: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        // NOTE: App Shortcut phrases may only interpolate AppEntity/AppEnum
        // parameters, never a plain String? (the iOS 26 SDK hard-errors:
        // "Invalid parameter type … AppEntity and AppEnum are the only allowed
        // types"). The free-text parameter is still collected at run time via
        // the intent's `requestValueDialog`, so only the inline-spoken-parameter
        // phrase variants are dropped here, not the capability.
        AppShortcut(
            intent: AskElizaIntent(),
            phrases: [
                "Ask \(.applicationName)",
            ],
            shortTitle: "Ask Eliza",
            systemImageName: "sparkles"
        )

        AppShortcut(
            intent: StartElizaVoiceIntent(),
            phrases: [
                "Start voice with \(.applicationName)",
                "Start \(.applicationName) voice",
            ],
            shortTitle: "Voice",
            systemImageName: "waveform"
        )

        AppShortcut(
            intent: OpenElizaDailyBriefIntent(),
            phrases: [
                "Open \(.applicationName) daily brief",
                "Show my daily brief in \(.applicationName)",
            ],
            shortTitle: "Daily Brief",
            systemImageName: "sun.max"
        )

        AppShortcut(
            intent: CreateElizaTaskIntent(),
            phrases: [
                "Create a task in \(.applicationName)",
            ],
            shortTitle: "New Task",
            systemImageName: "checklist"
        )

        AppShortcut(
            intent: DraftElizaSmartReplyIntent(),
            phrases: [
                "Draft a reply with \(.applicationName)",
            ],
            shortTitle: "Smart Reply",
            systemImageName: "text.bubble"
        )
    }
}
