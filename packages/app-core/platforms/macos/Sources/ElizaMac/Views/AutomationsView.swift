import SwiftUI

struct AutomationsView: View {
    @ObservedObject var model: AppModel
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Automations", subtitle: "Scheduled tasks, approvals, watchers, and recaps.", systemImage: "calendar.badge.clock")

                FeatureGrid(features: model.heartbeatFeatures, actionTitle: "Open") { feature in
                    model.openFeature(feature, fallback: .automations)
                }

                GlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        AutomationRow(title: "Scheduled Tasks", detail: "Run reminders, recaps, and follow-ups.", tint: theme.primaryTint)
                        AutomationRow(title: "Approvals", detail: "Queue operations that need human confirmation.", tint: theme.warningTint)
                        AutomationRow(title: "Watchers", detail: "Observe repos, files, and external signals.", tint: theme.secondaryTint)
                        AutomationRow(title: "Outputs", detail: "Route messages to native notifications or channels.", tint: theme.tertiaryTint)
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Automations")
    }
}

private struct AutomationRow: View {
    let title: String
    let detail: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "checkmark.circle")
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
