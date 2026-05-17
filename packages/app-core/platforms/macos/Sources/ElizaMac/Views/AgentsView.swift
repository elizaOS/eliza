import ElizaMacCore
import SwiftUI

struct AgentsView: View {
    @ObservedObject var model: AppModel

    private let columns = [
        GridItem(.adaptive(minimum: 260), spacing: 14)
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Agents", subtitle: "Profiles the native shell can launch, pause, and inspect.", systemImage: "person.2")

                LazyVGrid(columns: columns, spacing: 14) {
                    ForEach(model.agents) { agent in
                        AgentCard(agent: agent) {
                            model.activateAgent(agent.id)
                        }
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Agents")
    }
}

private struct AgentCard: View {
    let agent: AgentProfile
    let activate: () -> Void
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Image(systemName: agent.systemImage)
                        .font(.title2)
                        .foregroundStyle(.secondary)
                    Spacer()
                    StatusPill(title: agent.state.title, systemImage: "circle.fill", tint: tint)
                }

                Text(agent.name)
                    .font(.headline)
                Text(agent.role)
                    .foregroundStyle(.secondary)
                Text(agent.model)
                    .font(.caption)
                    .foregroundStyle(.tertiary)

                Button(action: activate) {
                    Label(agent.state == .active ? "Active" : "Activate", systemImage: agent.state == .active ? "checkmark.circle" : "play.circle")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .disabled(agent.state == .active)
            }
        }
    }

    private var tint: Color {
        switch agent.state {
        case .active:
            theme.primaryTint
        case .paused:
            theme.warningTint
        case .draft:
            theme.secondaryTint
        }
    }
}
