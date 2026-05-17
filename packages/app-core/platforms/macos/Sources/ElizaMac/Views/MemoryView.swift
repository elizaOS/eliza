import SwiftUI

struct MemoryView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Memory", subtitle: "Local knowledge, vector indexes, and context packs.", systemImage: "shippingbox")

                GlassCard {
                    DetailGrid(rows: [
                        ("Workspace", "Repository files and project docs"),
                        ("Private", "Local-only user context and preferences"),
                        ("Indexes", "Embeddings and retrieval stores"),
                        ("Exports", "Auditable bundles for backup or migration")
                    ])
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 14)], spacing: 14) {
                    MemoryActionCard(title: "Knowledge Documents", detail: "Character documents, fragments, search routes, and context packs.", systemImage: "doc.text.magnifyingglass") {
                        model.openRendererAppRoute("/apps/documents", title: "Knowledge")
                    }
                    MemoryActionCard(title: "Memory Viewer", detail: "Inspect local memories, embeddings, and retrieval quality.", systemImage: "square.stack.3d.up") {
                        model.openRendererAppRoute("/apps/memories", title: "Memory Viewer")
                    }
                    MemoryActionCard(title: "Relationships", detail: "Audit entity and relationship edges without creating a second graph store.", systemImage: "point.3.connected.trianglepath.dotted") {
                        model.openRendererAppRoute("/apps/relationships", title: "Relationship Viewer")
                    }
                    MemoryActionCard(title: "Trajectories", detail: "Review agent runs, traces, and replayable context bundles.", systemImage: "waveform.path.ecg") {
                        model.openRendererAppRoute("/apps/trajectories", title: "Trajectory Viewer")
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Memory")
    }
}

private struct MemoryActionCard: View {
    let title: String
    let detail: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                Image(systemName: systemImage)
                    .font(.title2)
                    .foregroundStyle(.secondary)

                Text(title)
                    .font(.headline)
                Text(detail)
                    .foregroundStyle(.secondary)

                Button(action: action) {
                    Label("Open", systemImage: "arrow.right.circle")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
            }
        }
    }
}
