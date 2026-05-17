import SwiftUI

struct WebConsoleView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 16) {
            GlassCard(spacing: 16) {
                HStack(alignment: .center, spacing: 16) {
                    Image(systemName: "macwindow")
                        .font(.title2)
                        .foregroundStyle(model.theme.primaryTint)
                        .frame(width: 34, height: 34)

                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.consoleTitle)
                            .font(.title3.weight(.semibold))
                        Text(model.consoleDetail)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        Text(model.consoleURL.absoluteString)
                            .font(.caption.monospaced())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }

                    Spacer(minLength: 12)

                    Button {
                        model.resetConsoleHome()
                    } label: {
                        Label("Home", systemImage: "house")
                    }

                    Link(destination: model.consoleURL) {
                        Label("Open", systemImage: "safari")
                    }
                }
            }

            Group {
                if model.status.isRunning {
                    EmbeddedWebView(url: model.consoleURL)
                } else {
                    VStack(spacing: 16) {
                        EmptyStateView(
                            title: "Renderer is not running",
                            detail: "Start the runtime to load this renderer target. Native sections remain available while the local process is stopped.",
                            systemImage: "play.slash"
                        )
                        Button {
                            model.startRuntime()
                        } label: {
                            Label("Start Runtime", systemImage: "play.fill")
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.regularMaterial.opacity(0.24))
            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(model.theme.primaryTint.opacity(0.16), lineWidth: 1)
            }
        }
        .padding(24)
        .navigationTitle("Console")
        .toolbar {
            Button {
                model.resetConsoleHome()
            } label: {
                Label("Home", systemImage: "house")
            }

            Link(destination: model.consoleURL) {
                Label("Open", systemImage: "safari")
            }
        }
    }
}
