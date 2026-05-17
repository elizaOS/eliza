import ElizaMacCore
import Foundation
import SwiftUI

struct LogsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Logs", subtitle: "Runtime events captured by the native shell.", systemImage: "text.page")

                if model.runtimeEvents.isEmpty && model.runtimeLogEntries.isEmpty {
                    EmptyStateView(title: "No events", detail: "Start the runtime or change configuration to populate this stream.", systemImage: "text.page")
                } else {
                    if !model.runtimeLogEntries.isEmpty {
                        GlassCard {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Runtime API")
                                    .font(.headline)

                                ForEach(model.runtimeLogEntries) { entry in
                                    RuntimeLogRow(entry: entry)
                                }
                            }
                        }
                    }

                    if !model.runtimeEvents.isEmpty {
                        GlassCard {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("Native Shell")
                                    .font(.headline)

                                ForEach(model.runtimeEvents, id: \.self) { event in
                                    Text(event)
                                        .font(.system(.callout, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                        .textSelection(.enabled)
                                }
                            }
                        }
                    }
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Logs")
        .toolbar {
            ToolbarItem {
                Button {
                    model.refreshRuntimeSnapshot()
                } label: {
                    Label("Refresh Logs", systemImage: "arrow.clockwise")
                }
                .disabled(model.isRefreshingRuntime)
            }
        }
    }
}

private struct RuntimeLogRow: View {
    let entry: RuntimeLogEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(timestamp)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)

                Text(entry.level.uppercased())
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(levelTint)

                Text(entry.source)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()
            }

            if let message = entry.message, !message.isEmpty {
                Text(message)
                    .font(.system(.callout, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            if !entry.tags.isEmpty {
                Text(entry.tags.joined(separator: " / "))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
    }

    private var timestamp: String {
        let date = Date(timeIntervalSince1970: TimeInterval(entry.timestamp) / 1_000)
        return date.formatted(date: .omitted, time: .standard)
    }

    private var levelTint: Color {
        switch entry.level.lowercased() {
        case "error", "fatal":
            .red
        case "warn", "warning":
            .orange
        case "debug", "trace":
            .secondary
        default:
            .primary
        }
    }
}
