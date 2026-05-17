import ElizaMacCore
import SwiftUI

struct ConnectorsView: View {
    @ObservedObject var model: AppModel

    private let columns = [
        GridItem(.adaptive(minimum: 240), spacing: 14)
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Connectors", subtitle: "Native and elizaOS channels planned for the Swift shell.", systemImage: "point.3.connected.trianglepath.dotted")

                LazyVGrid(columns: columns, spacing: 14) {
                    ForEach(model.connectors) { connector in
                        ConnectorCard(connector: connector) {
                            model.openConnector(connector)
                        }
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Connectors")
    }
}

private struct ConnectorCard: View {
    let connector: ConnectorProfile
    let action: () -> Void
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label(connector.name, systemImage: connector.systemImage)
                        .font(.headline)
                    Spacer()
                    StatusPill(title: connector.state.title, systemImage: "circle.fill", tint: tint)
                }

                Text(connector.detail)
                    .foregroundStyle(.secondary)

                Button(action: action) {
                    Label(actionTitle, systemImage: "arrow.right.circle")
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .tint(tint)
            }
        }
    }

    private var actionTitle: String {
        switch connector.state {
        case .connected:
            "Open"
        case .available:
            "Configure"
        case .blocked:
            "Review"
        }
    }

    private var tint: Color {
        switch connector.state {
        case .connected:
            theme.primaryTint
        case .available:
            theme.secondaryTint
        case .blocked:
            theme.destructiveTint
        }
    }
}
