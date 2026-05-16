import SwiftUI

struct BrowserSurfaceView: View {
    @ObservedObject var model: AppModel
    @State private var urlText = "https://docs.elizaos.ai"

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Browser", subtitle: "Web context, safe browsing controls, page snapshots, and handoff into chat.", systemImage: "safari")

                GlassCard(spacing: 18) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Open Web Context")
                            .font(.headline)

                        HStack {
                            TextField("URL", text: $urlText)
                                .textFieldStyle(.roundedBorder)
                            Button {
                                model.prepareBrowserURL(urlText)
                            } label: {
                                Label("Prepare", systemImage: "arrow.right.circle")
                            }
                        }

                        DetailGrid(rows: [
                            ("Mode", "User-visible browsing and page context"),
                            ("Output", "Summaries, screenshots, source links, and chat handoff"),
                            ("Safety", "Navigation and form actions stay explicit")
                        ])
                    }
                }

                FeatureGrid(features: model.browserFeatures, actionTitle: "Use") { feature in
                    model.openFeature(feature, fallback: .browser)
                }
            }
            .padding(24)
        }
        .navigationTitle("Browser")
    }
}
