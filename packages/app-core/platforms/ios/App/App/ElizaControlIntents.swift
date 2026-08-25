/**
 Shared control intents let WidgetKit discover Eliza controls while keeping the
 extension and containing app on the same deep-link contract.
 */
import AppIntents
import Foundation

#if !APP_EXTENSION
  import UIKit
#endif

@available(iOS 18.0, *)
enum MessageElizaControlTarget: String, AppEnum {
  case message

  static var typeDisplayRepresentation = TypeDisplayRepresentation("Message Eliza destination")
  static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
    .message: "Message Eliza"
  ]
}

@available(iOS 18.0, *)
enum TalkToElizaControlTarget: String, AppEnum {
  case voice

  static var typeDisplayRepresentation = TypeDisplayRepresentation("Talk to Eliza destination")
  static var caseDisplayRepresentations: [Self: DisplayRepresentation] = [
    .voice: "Talk to Eliza"
  ]
}

#if !APP_EXTENSION
  @available(iOS 18.0, *)
  @MainActor
  private enum ElizaControlIntentRouter {
    private static let scheme = "elizaos"
    private static let source = "ios-control"

    static func openMessage() {
      open(makeURL(path: "assistant", action: "ask"))
    }

    static func openVoice() {
      open(
        makeURL(
          path: "voice",
          action: "voice",
          extraItems: [URLQueryItem(name: "voice", value: "1")]
        )
      )
    }

    private static func open(_ url: URL) {
      UIApplication.shared.open(url, options: [:], completionHandler: nil)
    }

    private static func makeURL(
      path: String,
      action: String,
      extraItems: [URLQueryItem] = []
    ) -> URL {
      var components = URLComponents()
      components.scheme = scheme
      components.host = path
      components.queryItems =
        [
          URLQueryItem(name: "source", value: source),
          URLQueryItem(name: "action", value: action),
        ] + extraItems

      guard let url = components.url else {
        preconditionFailure("ElizaControlIntentRouter: invalid control URL")
      }
      return url
    }
  }
#endif

@available(iOS 18.0, *)
struct AskElizaControlIntent: OpenIntent {
  static var title: LocalizedStringResource = "Message Eliza"
  static var description = IntentDescription("Open Eliza chat to ask a question.")
  static var isDiscoverable = false

  @Parameter(title: "Destination")
  var target: MessageElizaControlTarget

  init() {
    target = .message
  }

  #if !APP_EXTENSION
    @MainActor
    func perform() async throws -> some IntentResult {
      ElizaControlIntentRouter.openMessage()
      return .result()
    }
  #endif
}

@available(iOS 18.0, *)
struct StartElizaVoiceControlIntent: OpenIntent {
  static var title: LocalizedStringResource = "Talk to Eliza"
  static var description = IntentDescription("Open Eliza directly into voice chat.")
  static var isDiscoverable = false

  @Parameter(title: "Destination")
  var target: TalkToElizaControlTarget

  init() {
    target = .voice
  }

  #if !APP_EXTENSION
    @MainActor
    func perform() async throws -> some IntentResult {
      ElizaControlIntentRouter.openVoice()
      return .result()
    }
  #endif
}
