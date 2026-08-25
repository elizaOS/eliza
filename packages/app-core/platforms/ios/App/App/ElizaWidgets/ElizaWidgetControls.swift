/**
 iOS controls expose Eliza chat and voice entry points from Control Center,
 the Lock Screen, and the Action button without duplicating app behavior.
 */
import AppIntents
import SwiftUI
import WidgetKit

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
