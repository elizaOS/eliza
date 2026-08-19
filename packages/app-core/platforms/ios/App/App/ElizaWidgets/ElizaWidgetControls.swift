/**
 iOS controls expose Eliza chat and voice entry points from Control Center,
 the Lock Screen, and the Action button without duplicating app behavior.
 */
import AppIntents
import SwiftUI
import WidgetKit

// iOS 18 controls for Control Center, the Lock Screen, and the Action button.
// Controls must live in the widget extension, so these intents are thin
// open-the-app shims: `openAppWhenRun` foregrounds the app (the microphone
// needs a foreground app) and the returned `OpenURLIntent` routes through the
// same `elizaos://` deep-link spine as every other native entry point, tagged
// `source=ios-control`.

@available(iOS 18.0, *)
struct AskElizaControlIntent: AppIntent {
    static var title: LocalizedStringResource = "Message Eliza"
    static var description = IntentDescription("Open Eliza chat to ask a question.")
    static var isDiscoverable = false
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(ElizaWidgetDeepLink.ask(source: .control)))
    }
}

@available(iOS 18.0, *)
struct StartElizaVoiceControlIntent: AppIntent {
    static var title: LocalizedStringResource = "Talk to Eliza"
    static var description = IntentDescription("Open Eliza directly into voice chat.")
    static var isDiscoverable = false
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(ElizaWidgetDeepLink.voice(source: .control)))
    }
}

@available(iOS 18.0, *)
struct ElizaAskControl: ControlWidget {
    static let kind = "ElizaAskControl"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: AskElizaControlIntent()) {
                Label("Message Eliza", systemImage: "sparkles")
            }
        }
        .displayName("Message Eliza")
        .description("Open Eliza chat from Control Center, the Lock Screen, or the Action button.")
    }
}

@available(iOS 18.0, *)
struct ElizaVoiceControl: ControlWidget {
    static let kind = "ElizaVoiceControl"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: StartElizaVoiceControlIntent()) {
                Label("Talk to Eliza", systemImage: "waveform")
            }
        }
        .displayName("Talk to Eliza")
        .description("Start a voice chat with Eliza from Control Center, the Lock Screen, or the Action button.")
    }
}
