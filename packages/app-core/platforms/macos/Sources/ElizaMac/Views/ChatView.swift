import ElizaMacCore
import SwiftUI

struct ChatView: View {
    @ObservedObject var model: AppModel
    @Environment(\.elizaTheme) private var theme
    @State private var draft = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(
                    title: "Chat",
                    subtitle: "A native conversation surface for \(model.userDisplayName), agents, rooms, context, and approvals.",
                    systemImage: "bubble.left.and.bubble.right"
                )

                heroComposer

                FeatureGrid(features: model.chatFeatures, actionTitle: "Open") { feature in
                    model.openFeature(feature, fallback: .chat)
                }

                GlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Conversation Context")
                            .font(.headline)

                        DetailGrid(rows: [
                            ("Agent", model.agents.first(where: { $0.state == .active })?.name ?? "Operator"),
                            ("Runtime", model.status.title),
                            ("Workspace", model.configuration.repositoryRoot),
                            ("Approvals", model.approvals.isEmpty ? "None pending" : "\(model.approvals.count) pending")
                        ])
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Chat")
    }

    private var heroComposer: some View {
        GlassCard(spacing: 18) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Label("Ask Eliza", systemImage: "sparkles")
                        .font(.title3.weight(.semibold))
                    Spacer()
                    StatusPill(title: model.status.title, systemImage: model.status.systemImage, tint: model.status.isRunning ? theme.primaryTint : .secondary)
                }

                TextField("Ask about the repo, runtime, plugins, connectors, or LifeOps...", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.title3)
                    .lineLimit(3...6)
                    .padding(14)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                HStack {
                    Button {
                        model.openSurface(.console)
                    } label: {
                        Label("Open Renderer Console", systemImage: "macwindow")
                    }

                    Button {
                        model.openSurface(.approvals)
                    } label: {
                        Label("Review Approvals", systemImage: "checklist.checked")
                    }

                    Spacer()

                    Button {
                        if model.submitChatPrompt(draft) {
                            draft = ""
                        }
                    } label: {
                        Label(model.status.isRunning ? "Send" : "Start Runtime", systemImage: model.status.isRunning ? "paperplane.fill" : "play.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(theme.primaryTint)
                }
            }
        }
    }
}
