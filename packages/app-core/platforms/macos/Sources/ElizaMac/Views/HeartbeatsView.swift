import SwiftUI

struct HeartbeatsView: View {
    @ObservedObject var model: AppModel
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Heartbeats", subtitle: "Triggers, watchers, cadence, outputs, and runtime health loops.", systemImage: "bolt.badge.clock")

                FeatureGrid(features: model.heartbeatFeatures, actionTitle: "Configure") { feature in
                    model.openFeature(feature, fallback: .heartbeats)
                }

                GlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Cadence Board")
                            .font(.headline)

                        HeartbeatRow(title: "Every minute", detail: "Runtime health, connector setup status, approval wakeups.", tint: theme.primaryTint)
                        HeartbeatRow(title: "Every 15 minutes", detail: "Workspace watchers, recaps, notifications, cloud sync.", tint: theme.secondaryTint)
                        HeartbeatRow(title: "Manual", detail: "Run selected task, refresh registry, replay failed output.", tint: theme.tertiaryTint)
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Heartbeats")
    }
}

private struct HeartbeatRow: View {
    let title: String
    let detail: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "clock.badge.checkmark")
                .foregroundStyle(tint)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                Text(detail)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
