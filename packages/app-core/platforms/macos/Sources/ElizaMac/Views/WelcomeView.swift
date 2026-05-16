import SwiftUI

struct WelcomeView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(
                    title: "Welcome",
                    subtitle: "Set up the native elizaOS shell for \(model.userDisplayName) on this Mac.",
                    systemImage: "sparkles"
                )

                GlassCard {
                    VStack(alignment: .leading, spacing: 14) {
                        SetupStep(title: "1. Confirm workspace", detail: model.configuration.repositoryRoot, systemImage: "folder")
                        SetupStep(title: "2. Review permissions", detail: "Screen Recording, Calendar, Notifications, and Keychain.", systemImage: "hand.raised")
                        SetupStep(title: "3. Choose runtime", detail: model.configuration.launchMode.title, systemImage: "terminal")
                        SetupStep(title: "4. Open core surfaces", detail: "Chat, Plugins, Heartbeats, LifeOps, Health, Browser, Cloud, and Release.", systemImage: "square.grid.3x3")
                        SetupStep(title: "5. Customize glass", detail: "\(model.theme.accent.title), \(model.theme.glassVariant.title)", systemImage: "paintpalette")
                    }
                }

                HStack {
                    Button {
                        model.openSurface(.chat)
                    } label: {
                        Label("Open Chat", systemImage: "bubble.left.and.bubble.right")
                    }

                    Button {
                        model.openSurface(.permissions)
                    } label: {
                        Label("Review Permissions", systemImage: "hand.raised")
                    }

                    Button {
                        model.openSurface(.settings)
                    } label: {
                        Label("Open Settings", systemImage: "gearshape")
                    }

                    Button {
                        model.openSurface(.dashboard)
                    } label: {
                        Label("Go to Dashboard", systemImage: "rectangle.grid.2x2")
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .padding(24)
        }
        .navigationTitle("Welcome")
    }
}

private struct SetupStep: View {
    let title: String
    let detail: String
    let systemImage: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(.secondary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                Text(detail)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
        }
    }
}
