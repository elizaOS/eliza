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
                liveTelemetry
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Runtime")
        .toolbar {
            ToolbarItemGroup {
                Button {
                    model.refreshRuntimeSnapshot()
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(model.isRefreshingRuntime)

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

    @ViewBuilder
    private var liveTelemetry: some View {
        if let snapshot = model.runtimeSnapshot {
            GlassCard {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Live Telemetry")
                        .font(.headline)

                    DetailGrid(rows: [
                        ("Ready", snapshot.health.ready ? "Yes" : "No"),
                        ("Agent state", snapshot.health.agentState),
                        ("Runtime", snapshot.health.runtime),
                        ("Database", snapshot.health.database),
                        ("Plugins", "\(snapshot.health.plugins.loaded) loaded, \(snapshot.health.plugins.failed) failed"),
                        ("Coordinator", snapshot.health.coordinator),
                        ("Uptime", formattedUptime(snapshot.health.uptime)),
                        ("Logs", "\(snapshot.logs.entries.count) entries")
                    ])
                    .textSelection(.enabled)
                }
            }
        } else if let error = model.lastRuntimeProbeError {
            GlassCard {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Probe Failed")
                        .font(.headline)
                    Text(error)
                        .foregroundStyle(theme.destructiveTint)
                        .textSelection(.enabled)
                }
            }
        }
    }

    private func formattedUptime(_ seconds: Int) -> String {
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        let remainingSeconds = seconds % 60

        if hours > 0 {
            return "\(hours)h \(minutes)m \(remainingSeconds)s"
        }

        if minutes > 0 {
            return "\(minutes)m \(remainingSeconds)s"
        }

        return "\(remainingSeconds)s"
    }
}
