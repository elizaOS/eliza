import ElizaMacCore
import SwiftUI

struct LogsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Logs", subtitle: "Runtime events captured by the native shell.", systemImage: "text.page")

                if model.runtimeEvents.isEmpty {
                    EmptyStateView(title: "No events", detail: "Start the runtime or change configuration to populate this stream.", systemImage: "text.page")
                } else {
                    GlassCard {
                        VStack(alignment: .leading, spacing: 10) {
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
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Logs")
    }
}
