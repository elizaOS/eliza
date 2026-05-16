import ElizaMacCore
import SwiftUI

struct RuntimeOverviewView: View {
    @ObservedObject var model: AppModel
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(
                    title: "Runtime",
                    subtitle: "Start, stop, and inspect \(model.userDisplayName)'s local elizaOS process.",
                    systemImage: "cpu"
                )
                statusHeader
                runtimeDetails
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Runtime")
        .toolbar {
            ToolbarItemGroup {
                Button {
                    model.startRuntime()
                } label: {
                    Label("Start", systemImage: "play.fill")
                }
                .disabled(model.status.isRunning)

                Button {
                    model.stopRuntime()
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                }
                .disabled(!model.status.isRunning)
            }
        }
    }

    private var statusHeader: some View {
        GlassCard {
            HStack(alignment: .center, spacing: 14) {
                Image(systemName: model.status.systemImage)
                    .font(.system(size: 32))
                    .foregroundStyle(model.status.isRunning ? theme.primaryTint : .secondary)
                    .frame(width: 42)

                VStack(alignment: .leading, spacing: 4) {
                    Text(model.status.title)
                        .font(.title2.weight(.semibold))
                    Text(model.status.detail)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }

                Spacer()
            }
        }
    }

    private var runtimeDetails: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Configuration")
                    .font(.headline)
                DetailGrid(rows: [
                    ("Mode", model.configuration.launchMode.title),
                    ("User", model.configuration.userName),
                    ("Repository", model.configuration.repositoryRoot),
                    ("API", model.configuration.apiBaseURL.absoluteString),
                    ("Renderer", model.configuration.rendererURL.absoluteString)
                ])
                .textSelection(.enabled)
            }
        }
    }
}
