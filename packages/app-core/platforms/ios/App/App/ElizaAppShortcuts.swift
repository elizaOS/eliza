import AppIntents
import Foundation
import UIKit

private enum ElizaShortcutRoute {
    private static let fallbackScheme = "elizaos"
    private static var host: String {
        Bundle.main.bundleIdentifier ?? "app.eliza"
    }

    static func url(path: String, queryItems: [URLQueryItem] = []) -> URL {
        var components = URLComponents()
        components.scheme = configuredScheme()
        components.host = host
        components.path = path
        components.queryItems = queryItems.isEmpty ? nil : queryItems

        guard let url = components.url else {
            return URL(string: "\(fallbackScheme)://\(host)/chat")!
        }
        return url
    }

    @MainActor
    static func open(_ url: URL) async {
        await withCheckedContinuation { continuation in
            UIApplication.shared.open(url, options: [:]) { _ in
                continuation.resume()
            }
        }
    }

    private static func configuredScheme() -> String {
        guard let urlTypes = Bundle.main.object(forInfoDictionaryKey: "CFBundleURLTypes") as? [[String: Any]] else {
            return fallbackScheme
        }

        let bundleIdentifier = Bundle.main.bundleIdentifier
        let preferredType = urlTypes.first { type in
            type["CFBundleURLName"] as? String == bundleIdentifier
        } ?? urlTypes.first

        guard let schemes = preferredType?["CFBundleURLSchemes"] as? [String],
              let scheme = schemes.first(where: { !$0.isEmpty }) else {
            return fallbackScheme
        }
        return scheme
    }
}

@available(iOS 16.0, *)
struct AskElizaIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Eliza"
    static var description = IntentDescription("Send a question to Eliza.")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Question", requestValueDialog: "What would you like to ask Eliza?")
    var question: String

    @MainActor
    func perform() async throws -> some IntentResult {
        await ElizaShortcutRoute.open(ElizaShortcutRoute.url(path: "/ask", queryItems: [
            URLQueryItem(name: "source", value: "ios-app-shortcuts"),
            URLQueryItem(name: "action", value: "ask"),
            URLQueryItem(name: "text", value: question),
        ]))
        return .result()
    }
}

@available(iOS 16.0, *)
struct StartElizaVoiceIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Eliza Voice"
    static var description = IntentDescription("Open Eliza in voice mode.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        await ElizaShortcutRoute.open(ElizaShortcutRoute.url(path: "/voice", queryItems: [
            URLQueryItem(name: "source", value: "ios-app-shortcuts"),
            URLQueryItem(name: "action", value: "startVoice"),
        ]))
        return .result()
    }
}

@available(iOS 16.0, *)
struct CreateLifeOpsTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Create LifeOps Task"
    static var description = IntentDescription("Send a LifeOps task draft to Eliza.")
    static var openAppWhenRun: Bool = true

    @Parameter(title: "Task", requestValueDialog: "What should Eliza schedule or track?")
    var task: String

    @MainActor
    func perform() async throws -> some IntentResult {
        // LifeOps persistence is owned by the JS ScheduledTask runner; native only hands off structured input.
        await ElizaShortcutRoute.open(ElizaShortcutRoute.url(path: "/lifeops/create", queryItems: [
            URLQueryItem(name: "source", value: "ios-app-shortcuts"),
            URLQueryItem(name: "action", value: "createScheduledTask"),
            URLQueryItem(name: "kind", value: "scheduledTaskDraft"),
            URLQueryItem(name: "text", value: task),
        ]))
        return .result()
    }
}

@available(iOS 16.0, *)
struct OpenDailyBriefIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Daily Brief"
    static var description = IntentDescription("Open the LifeOps daily brief.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        await ElizaShortcutRoute.open(ElizaShortcutRoute.url(path: "/daily-brief", queryItems: [
            URLQueryItem(name: "source", value: "ios-app-shortcuts"),
            URLQueryItem(name: "action", value: "openDailyBrief"),
            URLQueryItem(name: "view", value: "dailyBrief"),
        ]))
        return .result()
    }
}

@available(iOS 16.0, *)
struct ElizaAppShortcutsProvider: AppShortcutsProvider {
    static var shortcutTileColor: ShortcutTileColor = .navy

    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskElizaIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) \(\.$question)",
            ],
            shortTitle: "Ask Eliza",
            systemImageName: "bubble.left.and.text.bubble.right"
        )
        AppShortcut(
            intent: StartElizaVoiceIntent(),
            phrases: [
                "Start \(.applicationName) voice",
                "Talk to \(.applicationName)",
            ],
            shortTitle: "Start Voice",
            systemImageName: "mic"
        )
        AppShortcut(
            intent: CreateLifeOpsTaskIntent(),
            phrases: [
                "Create a LifeOps task in \(.applicationName)",
                "Tell \(.applicationName) to track \(\.$task)",
            ],
            shortTitle: "LifeOps Task",
            systemImageName: "checklist"
        )
        AppShortcut(
            intent: OpenDailyBriefIntent(),
            phrases: [
                "Open my daily brief in \(.applicationName)",
                "Show my \(.applicationName) daily brief",
            ],
            shortTitle: "Daily Brief",
            systemImageName: "sun.max"
        )
    }
}
