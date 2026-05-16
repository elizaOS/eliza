import ElizaMacCore
import SwiftUI

struct WorkspacesView: View {
    @ObservedObject var model: AppModel
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Workspaces", subtitle: "Projects and repositories the native shell can index and run.", systemImage: "folder.badge.gearshape")

                ForEach(model.workspaces) { workspace in
                    GlassCard {
                        HStack(alignment: .top, spacing: 14) {
                            Image(systemName: "folder")
                                .font(.title2)
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(workspace.name)
                                    .font(.headline)
                                Text(workspace.detail)
                                    .foregroundStyle(.secondary)
                                Text(workspace.path)
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            Spacer()
                            StatusPill(title: workspace.state.title, systemImage: "circle.fill", tint: workspace.state == .active ? theme.primaryTint : theme.secondaryTint)
                        }
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Workspaces")
    }
}
