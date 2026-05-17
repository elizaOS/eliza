import SwiftUI

struct PluginsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(
                    title: "Plugins",
                    subtitle: "Installed apps, plugin tools, debug surfaces, model probes, knowledge surfaces, and agent capabilities.",
                    systemImage: "puzzlepiece.extension"
                )

                GlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("App Catalog")
                            .font(.headline)
                        Text("These are the app windows and plugin-provided app surfaces the native shell can hand off to the elizaOS renderer.")
                            .foregroundStyle(.secondary)
                    }
                }

                FeatureGrid(features: model.appFeatures, actionTitle: "Launch") { feature in
                    model.openFeature(feature, fallback: .plugins)
                }

                GlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Plugin Controls")
                            .font(.headline)
                        Text("Operational plugin surfaces that should remain visible even before the full renderer is running.")
                            .foregroundStyle(.secondary)
                    }
                }

                FeatureGrid(features: model.pluginFeatures, actionTitle: "Inspect") { feature in
                    model.openFeature(feature, fallback: .plugins)
                }

                GlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Registry Coverage")
                            .font(.headline)
                        DetailGrid(rows: [
                            ("Apps", "LifeOps, Knowledge, Memory Viewer, Plugin Viewer, Runtime Debugger, Model Tester"),
                            ("Connectors", "Discord, Telegram, Slack, iMessage, X, WhatsApp, Matrix, Signal, and more"),
                            ("Providers", "OpenAI, Anthropic, OpenRouter, local inference, MLX, Ollama, xAI"),
                            ("Native Path", "Keep setup, inspection, and launch controls discoverable in Swift")
                        ])
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Plugins")
    }
}
