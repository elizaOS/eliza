import SwiftUI

struct ApprovalsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Approvals", subtitle: "Human confirmation queue for tool use and automations.", systemImage: "checklist.checked")

                if model.approvals.isEmpty {
                    EmptyStateView(title: "Approval queue is clear", detail: "Runtime actions that need confirmation will appear here before they execute.", systemImage: "checkmark.seal")
                        .frame(minHeight: 360)
                } else {
                    ForEach(model.approvals) { item in
                        GlassCard {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(item.title)
                                    .font(.headline)
                                Text(item.detail)
                                    .foregroundStyle(.secondary)
                                Text(item.source)
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Approvals")
    }
}
