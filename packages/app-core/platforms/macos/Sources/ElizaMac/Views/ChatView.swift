import AppKit
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
                conversationTimeline

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
                        model.openSurface(.approvals)
                    } label: {
                        Label("Review Approvals", systemImage: "checklist.checked")
                    }

                    Button {
                        model.refreshActiveConversationMessages()
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .disabled(model.activeConversation == nil)

                    Spacer()

                    Button {
                        if model.submitChatPrompt(draft) {
                            draft = ""
                        }
                    } label: {
                        Label(sendTitle, systemImage: sendImage)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(theme.primaryTint)
                    .disabled(model.isSendingChat || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }

                if let error = model.lastChatError {
                    Label(error, systemImage: model.status.isActive ? "clock" : "exclamationmark.triangle")
                        .font(.callout)
                        .foregroundStyle(model.status.isActive ? .secondary : theme.destructiveTint)
                        .textSelection(.enabled)
                }
            }
        }
    }

    private var conversationTimeline: some View {
        GlassCard(spacing: 14) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label(model.activeConversation?.title ?? "Native Agent Conversation", systemImage: "person.wave.2")
                        .font(.headline)

                    Spacer()

                    if model.isSendingChat {
                        ProgressView()
                            .controlSize(.small)
                    }
                }

                if model.chatMessages.isEmpty {
                    EmptyStateView(
                        title: "No native turns yet",
                        detail: model.status.isRunning ? "Send a message to the agent runtime." : "The app will start the background agent runtime before sending.",
                        systemImage: "bubble.left.and.bubble.right"
                    )
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(model.chatMessages) { message in
                            ChatMessageBubble(message: message)
                        }
                    }
                }
            }
        }
    }

    private var sendTitle: String {
        if model.status.isRunning {
            return "Send"
        }
        if model.status.isActive {
            return "Queue"
        }
        return "Start Runtime"
    }

    private var sendImage: String {
        if model.status.isRunning {
            return "paperplane.fill"
        }
        if model.status.isActive {
            return "clock"
        }
        return "play.fill"
    }
}

private struct ChatMessageBubble: View {
    let message: RuntimeConversationMessage
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        HStack(alignment: .top) {
            if isUser {
                Spacer(minLength: 80)
            }

            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(sender)
                        .font(.caption.weight(.semibold))
                    Text(timestamp)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }

                Text(message.text)
                    .font(.callout)
                    .textSelection(.enabled)
            }
            .padding(12)
            .background(background, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(border, lineWidth: 1)
            }
            .frame(maxWidth: 620, alignment: .leading)

            if !isUser {
                Spacer(minLength: 80)
            }
        }
    }

    private var isUser: Bool {
        message.role == "user"
    }

    private var sender: String {
        if let from = message.from, !from.isEmpty {
            return from
        }
        return isUser ? "You" : "Eliza"
    }

    private var timestamp: String {
        let date = Date(timeIntervalSince1970: TimeInterval(message.timestamp) / 1_000)
        return date.formatted(date: .omitted, time: .shortened)
    }

    private var background: Color {
        isUser ? theme.primaryTint.opacity(0.22) : Color(nsColor: .controlBackgroundColor).opacity(0.48)
    }

    private var border: Color {
        isUser ? theme.primaryTint.opacity(0.28) : theme.secondaryTint.opacity(0.18)
    }
}
