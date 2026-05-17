import SwiftUI

struct VaultView: View {
    @ObservedObject var model: AppModel
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Vault", subtitle: "Local credentials and protected runtime material.", systemImage: "lock.rectangle.stack")

                ForEach(model.vaultItems) { item in
                    GlassCard {
                        HStack(spacing: 14) {
                            Image(systemName: item.systemImage)
                                .font(.title2)
                                .foregroundStyle(.secondary)
                                .frame(width: 30)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.title)
                                    .font(.headline)
                                Text(item.detail)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 10) {
                                StatusPill(title: "Local", systemImage: "lock.fill", tint: theme.primaryTint)
                                Button {
                                    model.openVaultItem(item)
                                } label: {
                                    Label("Open", systemImage: "arrow.right.circle")
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Vault")
    }
}
