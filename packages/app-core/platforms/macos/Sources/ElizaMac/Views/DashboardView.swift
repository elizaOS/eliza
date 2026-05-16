import ElizaMacCore
import SwiftUI

struct DashboardView: View {
    @ObservedObject var model: AppModel

    private let columns = [
        GridItem(.adaptive(minimum: 220), spacing: 14)
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(
                    title: "Eliza Native Mac",
                    subtitle: "Good to see you, \(model.userDisplayName). SwiftUI shell for local elizaOS workflows on modern Macs.",
                    systemImage: "sparkles"
                )

                GlassEffectContainer {
                    LazyVGrid(columns: columns, spacing: 14) {
                        ForEach(model.metrics) { metric in
                            MetricTile(metric: metric)
                        }
                    }
                }

                GlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Core Surfaces")
                            .font(.headline)

                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 10)], spacing: 10) {
                            ForEach([AppSection.chat, .plugins, .heartbeats, .lifeOps, .health, .browser, .cloud]) { section in
                                Button {
                                    model.openSurface(section)
                                } label: {
                                    Label(section.title, systemImage: section.systemImage)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                }

                GlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Operations")
                            .font(.headline)

                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 10)], spacing: 10) {
                            ForEach([AppSection.runtime, .agents, .connectors, .models, .approvals, .vault, .diagnostics, .release]) { section in
                                Button {
                                    model.openSurface(section)
                                } label: {
                                    Label(section.title, systemImage: section.systemImage)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                }
            }
            .padding(24)
        }
        .scrollEdgeEffectStyle(.soft, for: .top)
        .navigationTitle("Dashboard")
    }
}
