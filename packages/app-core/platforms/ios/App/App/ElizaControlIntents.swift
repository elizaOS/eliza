/**
 Shared control intents let WidgetKit discover Eliza controls while keeping the
 extension and containing app on the same deep-link contract.
 */
import AppIntents
import Foundation

@available(iOS 18.0, *)
private enum ElizaControlIntentRouter {
    private static let scheme = "elizaos"
    private static let source = "ios-control"

    static func ask() -> URL {
        makeURL(path: "assistant", action: "ask")
    }

    static func voice() -> URL {
        makeURL(
            path: "voice",
            action: "voice",
            extraItems: [URLQueryItem(name: "voice", value: "1")]
        )
    }

    private static func makeURL(
        path: String,
        action: String,
        extraItems: [URLQueryItem] = []
    ) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = path
        components.queryItems = [
            URLQueryItem(name: "source", value: source),
            URLQueryItem(name: "action", value: action),
        ] + extraItems

        guard let url = components.url else {
            preconditionFailure("ElizaControlIntentRouter: invalid control URL")
        }
        return url
    }
}

@available(iOS 18.0, *)
struct AskElizaControlIntent: AppIntent {
    static var title: LocalizedStringResource = "Message Eliza"
    static var description = IntentDescription("Open Eliza chat to ask a question.")
    static var isDiscoverable = false
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(ElizaControlIntentRouter.ask()))
    }
}

@available(iOS 18.0, *)
struct StartElizaVoiceControlIntent: AppIntent {
    static var title: LocalizedStringResource = "Talk to Eliza"
    static var description = IntentDescription("Open Eliza directly into voice chat.")
    static var isDiscoverable = false
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(ElizaControlIntentRouter.voice()))
    }
}
