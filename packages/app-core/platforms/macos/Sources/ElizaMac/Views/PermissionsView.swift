import ElizaMacCore
import SwiftUI

struct PermissionsView: View {
    @ObservedObject var model: AppModel
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                SectionHeader(title: "Permissions", subtitle: "macOS capabilities the native shell should request deliberately.", systemImage: "hand.raised")

                if let result = model.lastNativeActionResult {
                    GlassCard {
                        Label(result, systemImage: "info.circle")
                            .foregroundStyle(.secondary)
                    }
                }

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
        switch capability.id {
        case "notifications":
            HStack(spacing: 8) {
                Button {
                    model.requestNotificationAuthorization()
                } label: {
                    Label("Request", systemImage: "bell.badge")
                }
                .buttonStyle(.bordered)

                Button {
                    model.sendTestNotification()
                } label: {
                    Label("Test", systemImage: "paperplane")
                }
                .buttonStyle(.bordered)

                if let url = systemSettingsURL(for: capability.id) {
                    Link(destination: url) {
                        Label("Settings", systemImage: "gearshape")
                    }
                    .buttonStyle(.bordered)
                }
            }
        case "automation":
            HStack(spacing: 8) {
                Button {
                    model.runFinderAutomationProbe()
                } label: {
                    Label("Test", systemImage: "play.circle")
                }
                .buttonStyle(.bordered)

                if let url = systemSettingsURL(for: capability.id) {
                    Link(destination: url) {
                        Label("Review", systemImage: "gearshape")
                    }
                    .buttonStyle(.bordered)
                }
            }
        case "local-runtime", "apple-silicon", "shell":
            Button {
                model.openSurface(.runtime)
            } label: {
                Label("Runtime", systemImage: "arrow.right.circle")
            }
            .buttonStyle(.bordered)
        case "keychain":
            Button {
                model.openSurface(.vault)
            } label: {
                Label("Vault", systemImage: "arrow.right.circle")
            }
            .buttonStyle(.bordered)
        case "health":
            Button {
                model.openSurface(.health)
            } label: {
                Label("Health", systemImage: "heart.text.square")
            }
            .buttonStyle(.bordered)
        default:
            if let url = systemSettingsURL(for: capability.id) {
                Link(destination: url) {
                    Label(capability.state == .ready ? "Open" : "Review", systemImage: "gearshape")
                }
                .buttonStyle(.bordered)
            } else {
                Button {
                    model.openSurface(.permissions)
                } label: {
                    Label("Review", systemImage: "arrow.right.circle")
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private func systemSettingsURL(for id: String) -> URL? {
        switch id {
        case "accessibility":
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        case "screen-recording":
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        case "microphone":
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        case "camera":
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
        case "location":
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices")
        case "reminders":
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders")
        case "calendar":
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")
        case "screentime":
            URL(string: "x-apple.systempreferences:com.apple.Screen-Time-Settings.extension")
        case "contacts":
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts")
        case "notes":
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
        case "notifications":
            URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")
        case "full-disk":
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        case "automation":
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
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
