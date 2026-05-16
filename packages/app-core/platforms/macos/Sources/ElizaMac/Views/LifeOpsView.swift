import SwiftUI

struct LifeOpsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(
                    title: "LifeOps",
                    subtitle: "Native setup and control for ScheduledTask, health packs, connectors, recaps, and approvals.",
                    systemImage: "heart.text.square"
                )

                GlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("ScheduledTask Contract")
                            .font(.headline)
                        DetailGrid(rows: [
                            ("Primitive", "ScheduledTask"),
                            ("Routes", "Reminders, check-ins, follow-ups, watchers, recaps, approvals, outputs"),
                            ("Behavior", "kind, trigger, shouldFire, completionCheck, pipeline, output, subject, priority"),
                            ("Health", "Separate plugin through registries, connectors, anchors, bus families, and default packs")
                        ])
                    }
                }

                FeatureGrid(features: model.lifeOpsFeatures, actionTitle: "Open") { feature in
                    model.openFeature(feature, fallback: .lifeOps)
                }
            }
            .padding(24)
        }
        .navigationTitle("LifeOps")
    }
}
