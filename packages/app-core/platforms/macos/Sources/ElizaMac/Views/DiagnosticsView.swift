import ElizaMacCore
import SwiftUI

struct DiagnosticsView: View {
    @ObservedObject var model: AppModel
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Diagnostics", subtitle: "Runtime, repository, and system readiness.", systemImage: "waveform.path.ecg")

                ForEach(model.diagnostics) { item in
                    GlassCard {
                        HStack(alignment: .top, spacing: 14) {
                            Image(systemName: item.systemImage)
                                .font(.title2)
                                .foregroundStyle(tint(for: item.severity))
                                .frame(width: 30)

                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.title)
                                    .font(.headline)
                                Text(item.detail)
                                    .foregroundStyle(.secondary)
                            }

                            Spacer()
                            StatusPill(title: item.severity.title, systemImage: "circle.fill", tint: tint(for: item.severity))
                        }
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Diagnostics")
    }

    private func tint(for severity: DiagnosticSeverity) -> Color {
        switch severity {
        case .info:
            theme.secondaryTint
        case .warning:
            theme.warningTint
        case .critical:
            theme.destructiveTint
        }
    }
}
