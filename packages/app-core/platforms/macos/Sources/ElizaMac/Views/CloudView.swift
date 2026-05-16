import SwiftUI

struct CloudView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Cloud", subtitle: "Eliza Cloud account, hosted connectors, remote runtime, and sync readiness.", systemImage: "cloud")

                FeatureGrid(features: model.cloudFeatures, actionTitle: "Configure") { feature in
                    model.openFeature(feature, fallback: .cloud)
                }

                GlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Runtime Target")
                            .font(.headline)
                        DetailGrid(rows: [
                            ("Launch Mode", model.configuration.launchMode.title),
                            ("API Base", model.configuration.apiBaseURL.absoluteString),
                            ("External Base", model.configuration.externalAPIBaseURL?.absoluteString ?? "Not configured"),
                            ("User", model.userDisplayName)
                        ])
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Cloud")
    }
}
