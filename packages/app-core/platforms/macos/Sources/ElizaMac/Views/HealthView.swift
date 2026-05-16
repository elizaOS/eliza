import SwiftUI

struct HealthView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(
                    title: "Health",
                    subtitle: "A separate plugin surface for connectors, anchors, bus families, and default packs.",
                    systemImage: "heart.text.square.fill"
                )

                GlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Plugin Boundary")
                            .font(.headline)
                        DetailGrid(rows: [
                            ("Package", "@elizaos/plugin-health"),
                            ("Ownership", "Contributes through registries, not LifeOps internals"),
                            ("LifeOps Link", "LifeOps consumes registry contributions without importing health internals"),
                            ("Native Role", "Show readiness, setup, packs, anchors, and audit state")
                        ])
                    }
                }

                FeatureGrid(features: model.healthFeatures, actionTitle: "Review") { feature in
                    model.openFeature(feature, fallback: .health)
                }
            }
            .padding(24)
        }
        .navigationTitle("Health")
    }
}
