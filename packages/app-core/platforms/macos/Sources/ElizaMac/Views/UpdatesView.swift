import SwiftUI

struct UpdatesView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Updates", subtitle: "Version, release channel, and shell update readiness.", systemImage: "arrow.triangle.2.circlepath")

                GlassCard {
                    DetailGrid(rows: [
                        ("Shell", "ElizaMac SwiftUI"),
                        ("Platform", "macOS 26"),
                        ("Channel", "Local development"),
                        ("Bundle", "SwiftPM app bundle")
                    ])
                }

                FeatureGrid(features: model.releaseFeatures, actionTitle: "Review") { feature in
                    model.openFeature(feature, fallback: .updates)
                }
            }
            .padding(24)
        }
        .navigationTitle("Updates")
    }
}
