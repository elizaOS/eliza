import ElizaMacCore
import SwiftUI

struct InspectorView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                SectionHeader(title: "Inspector", subtitle: selectedSection.title, systemImage: "sidebar.trailing")

                GlassCard {
                    DetailGrid(rows: [
                        ("Surface", selectedSection.title),
                        ("Purpose", selectedSection.detail),
                        ("Status", model.status.title),
                        ("Mode", model.configuration.launchMode.title),
                        ("API", model.configuration.apiBaseURL.absoluteString),
                        ("Renderer", model.configuration.rendererURL.absoluteString)
                    ])
                }

                if !selectedFeatures.isEmpty {
                    GlassCard {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Surface Readiness")
                                .font(.headline)

                            ForEach(selectedFeatures.prefix(5)) { feature in
                                HStack {
                                    Label(feature.title, systemImage: feature.systemImage)
                                    Spacer()
                                    StatusPill(title: feature.state.title, systemImage: "circle.fill", tint: tint(for: feature.state))
                                }
                                .font(.caption)
                            }
                        }
                    }
                }

                GlassCard {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Recent Events")
                            .font(.headline)

                        ForEach(model.runtimeEvents.prefix(6), id: \.self) { event in
                            Text(event)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            .padding(16)
        }
    }

    private var selectedSection: AppSection {
        model.selection ?? .dashboard
    }

    private var selectedFeatures: [ShellFeature] {
        switch selectedSection {
        case .chat:
            model.chatFeatures
        case .plugins:
            model.appFeatures + model.pluginFeatures
        case .heartbeats, .automations:
            model.heartbeatFeatures
        case .lifeOps:
            model.lifeOpsFeatures
        case .health:
            model.healthFeatures
        case .browser:
            model.browserFeatures
        case .cloud:
            model.cloudFeatures
        case .release, .updates:
            model.releaseFeatures
        default:
            []
        }
    }

    private func tint(for state: ShellFeatureState) -> Color {
        switch state {
        case .live:
            model.theme.primaryTint
        case .ready:
            model.theme.secondaryTint
        case .needsSetup:
            model.theme.warningTint
        case .planned:
            model.theme.tertiaryTint
        case .warning:
            model.theme.warningTint
        case .blocked:
            model.theme.destructiveTint
        }
    }
}
