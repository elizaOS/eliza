import AppKit
import Charts
import ElizaMacCore
import SwiftUI

struct MenuBarStatusView: View {
    @ObservedObject var model: AppModel
    @Environment(\.elizaTheme) private var theme

    private let columns = [
        GridItem(.adaptive(minimum: 116), spacing: 10)
    ]

    var body: some View {
        ZStack {
            ThemedBackdrop(theme: theme)

            VStack(alignment: .leading, spacing: 14) {
                header
                metricGrid
                charts
                quickActions
            }
            .padding(18)
        }
        .frame(width: 540, height: 720)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "sparkles")
                .font(.title2)
                .foregroundStyle(theme.accent.color)

            VStack(alignment: .leading, spacing: 2) {
                Text("Eliza")
                    .font(.title2.weight(.semibold))
                Text("\(model.userDisplayName) - \(model.status.detail)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer()

            StatusPill(
                title: model.status.title,
                systemImage: model.status.isRunning ? "checkmark.circle.fill" : "stop.circle",
                tint: model.status.isRunning ? theme.primaryTint : .secondary
            )
        }
    }

    private var metricGrid: some View {
        LazyVGrid(columns: columns, spacing: 10) {
            CompactMetric(title: "Chat", value: "\(model.chatFeatures.count)", detail: "lanes")
            CompactMetric(title: "Apps", value: "\(model.appFeatures.count)", detail: "\(model.appFeatures.filter { $0.state == .ready }.count) ready")
            CompactMetric(title: "Agents", value: "\(model.agents.count)", detail: "\(model.agents.filter { $0.state == .active }.count) active")
            CompactMetric(title: "Plugins", value: "\(model.pluginFeatures.count)", detail: "\(model.pluginFeatures.filter { $0.state == .ready }.count) ready")
            CompactMetric(title: "Models", value: "\(model.modelRoutes.count)", detail: "\(model.modelRoutes.filter { $0.state == .preferred }.count) preferred")
            CompactMetric(title: "LifeOps", value: "\(model.lifeOpsFeatures.count)", detail: "tasks")
            CompactMetric(title: "Health", value: "\(model.healthFeatures.count)", detail: "registries")
        }
    }

    private var charts: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Text("Activity")
                    .font(.headline)

                Chart(activitySamples) { sample in
                    BarMark(
                        x: .value("Sample", sample.index),
                        y: .value("Events", sample.value)
                    )
                    .foregroundStyle(theme.accent.color.gradient)
                }
                .chartXAxis(.hidden)
                .chartYAxis(.hidden)
                .frame(height: 92)

                Chart(routeSamples) { sample in
                    LineMark(
                        x: .value("Sample", sample.index),
                        y: .value("Capacity", sample.value)
                    )
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(theme.secondaryTint)

                    AreaMark(
                        x: .value("Sample", sample.index),
                        y: .value("Capacity", sample.value)
                    )
                    .interpolationMethod(.catmullRom)
                    .foregroundStyle(theme.secondaryTint.opacity(0.18 + theme.colorIntensity * 0.12))
                }
                .chartXAxis(.hidden)
                .chartYAxis(.hidden)
                .frame(height: 88)

                HStack(spacing: 12) {
                    LegendDot(title: "Runtime", color: theme.accent.color)
                    LegendDot(title: "Models", color: theme.secondaryTint)
                    LegendDot(title: "Connectors", color: theme.tertiaryTint)
                }
            }
        }
    }

    private var quickActions: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 10) {
                Button {
                    model.status.isRunning ? model.stopRuntime() : model.startRuntime()
                } label: {
                    Label(model.status.isRunning ? "Stop Runtime" : "Start Runtime", systemImage: model.status.isRunning ? "stop.fill" : "play.fill")
                }
                .keyboardShortcut("r", modifiers: [.command])

                Divider()

                QuickActionRow(title: "Dashboard", systemImage: "rectangle.grid.2x2") {
                    model.openSurface(.dashboard)
                }
                QuickActionRow(title: "Chat", systemImage: "bubble.left.and.bubble.right") {
                    model.openSurface(.chat)
                }
                QuickActionRow(title: "Plugins", systemImage: "puzzlepiece.extension") {
                    model.openSurface(.plugins)
                }
                QuickActionRow(title: "Agents", systemImage: "person.2") {
                    model.openSurface(.agents)
                }
                QuickActionRow(title: "LifeOps", systemImage: "heart.text.square") {
                    model.openSurface(.lifeOps)
                }
                QuickActionRow(title: "Health", systemImage: "heart.text.square.fill") {
                    model.openSurface(.health)
                }
                QuickActionRow(title: "Approvals", systemImage: "checklist.checked") {
                    model.openSurface(.approvals)
                }
                QuickActionRow(title: "Diagnostics", systemImage: "waveform.path.ecg") {
                    model.openSurface(.diagnostics)
                }

                Divider()

                HStack {
                    SettingsLink {
                        Label("Settings", systemImage: "gearshape")
                    }

                    Spacer()

                    Button("Quit") {
                        NSApplication.shared.terminate(nil)
                    }
                }
            }
        }
    }

    private var activitySamples: [ChartSample] {
        let seed = max(1, model.runtimeEvents.count)
        return (0..<28).map { index in
            let wave = Double((index * 7 + seed * 3) % 18)
            let bump = index > 10 && index < 17 ? Double(index - 9) * 2.4 : 0
            return ChartSample(index: index, value: max(1, wave + bump))
        }
    }

    private var routeSamples: [ChartSample] {
        (0..<28).map { index in
            let base = Double((index * 5 + model.modelRoutes.count * 4) % 16)
            let active = Double(model.connectors.filter { $0.state == .connected }.count * 5)
            return ChartSample(index: index, value: 8 + base + active)
        }
    }
}

private struct ChartSample: Identifiable {
    let index: Int
    let value: Double

    var id: Int {
        index
    }
}

private struct CompactMetric: View {
    let title: String
    let value: String
    let detail: String

    var body: some View {
        GlassCard(spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.title3.weight(.semibold))
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct LegendDot: View {
    let title: String
    let color: Color

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct QuickActionRow: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack {
                Label(title, systemImage: systemImage)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
        .buttonStyle(.plain)
    }
}
