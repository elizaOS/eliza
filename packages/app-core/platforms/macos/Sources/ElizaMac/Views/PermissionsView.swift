import ElizaMacCore
import SwiftUI

struct PermissionsView: View {
    @ObservedObject var model: AppModel
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Permissions", subtitle: "macOS capabilities the native shell should request deliberately.", systemImage: "hand.raised")

                ForEach(model.capabilities) { capability in
                    GlassCard {
                        HStack(spacing: 14) {
                            Image(systemName: capability.systemImage)
                                .font(.title2)
                                .foregroundStyle(.secondary)
                                .frame(width: 30)

                            VStack(alignment: .leading, spacing: 3) {
                                Text(capability.title)
                                    .font(.headline)
                                Text(capability.detail)
                                    .foregroundStyle(.secondary)
                            }

                            Spacer()
                            VStack(alignment: .trailing, spacing: 10) {
                                StatusPill(title: capability.state.title, systemImage: "circle.fill", tint: tint(for: capability.state))
                                permissionAction(for: capability)
                            }
                        }
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Permissions")
    }

    @ViewBuilder
    private func permissionAction(for capability: CapabilitySummary) -> some View {
        if let url = systemSettingsURL(for: capability.id) {
            Link(destination: url) {
                Label(capability.state == .ready ? "Open" : "Review", systemImage: "gearshape")
            }
            .buttonStyle(.bordered)
        } else {
            Button {
                if capability.id == "local-runtime" {
                    model.openSurface(.runtime)
                } else {
                    model.openSurface(.vault)
                }
            } label: {
                Label("Open", systemImage: "arrow.right.circle")
            }
            .buttonStyle(.bordered)
        }
    }

    private func systemSettingsURL(for id: String) -> URL? {
        switch id {
        case "screen-recording":
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        case "calendar":
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")
        case "notifications":
            URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")
        default:
            nil
        }
    }

    private func tint(for state: CapabilityState) -> Color {
        switch state {
        case .ready:
            theme.primaryTint
        case .needsSetup:
            theme.warningTint
        case .unavailable:
            theme.destructiveTint
        }
    }
}
