import SwiftUI

struct ReleaseView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Release", subtitle: "Build, signing, notarization, release channel, and app-bundle readiness.", systemImage: "shippingbox.and.arrow.backward")

                FeatureGrid(features: model.releaseFeatures, actionTitle: "Review") { feature in
                    model.openFeature(feature, fallback: .release)
                }

                GlassCard {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Current Build")
                            .font(.headline)
                        DetailGrid(rows: [
                            ("Package", "ElizaMac SwiftPM"),
                            ("Platform", "macOS 26 target"),
                            ("Bundle", "dist/ElizaMac.app"),
                            ("Run Script", "script/build_and_run.sh --verify")
                        ])
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Release")
    }
}
