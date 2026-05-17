import ElizaMacCore
import SwiftUI

struct ModelRoutesView: View {
    @ObservedObject var model: AppModel
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Model Routing", subtitle: "Local-first routes with room for cloud escalation.", systemImage: "brain")

                ForEach(model.modelRoutes) { route in
                    GlassCard {
                        HStack(alignment: .top, spacing: 14) {
                            Image(systemName: route.systemImage)
                                .font(.title2)
                                .foregroundStyle(.secondary)
                                .frame(width: 30)

                            VStack(alignment: .leading, spacing: 5) {
                                Text(route.name)
                                    .font(.headline)
                                Text(route.provider)
                                    .foregroundStyle(.secondary)
                                Text(route.detail)
                                    .foregroundStyle(.secondary)
                            }

                            Spacer()
                            VStack(alignment: .trailing, spacing: 10) {
                                StatusPill(title: route.state.title, systemImage: "circle.fill", tint: route.state == .preferred ? theme.primaryTint : theme.secondaryTint)
                                Button {
                                    model.useModelRoute(route.id)
                                } label: {
                                    Label(route.state == .preferred ? "Using" : "Use", systemImage: route.state == .preferred ? "checkmark.circle" : "arrow.right.circle")
                                }
                                .buttonStyle(.bordered)
                                .disabled(route.state == .preferred)
                            }
                        }
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Models")
    }
}
