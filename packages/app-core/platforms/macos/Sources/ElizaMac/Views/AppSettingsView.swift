import ElizaMacCore
import SwiftUI

struct AppSettingsView: View {
    @ObservedObject var model: AppModel
    @AppStorage("elizaMacLaunchAtLogin") private var launchAtLogin = false
    @AppStorage("elizaMacShowMenuBarExtra") private var showMenuBarExtra = true
    @AppStorage("elizaMacUseLiquidGlass") private var useLiquidGlass = true

    var body: some View {
        TabView(selection: $model.settingsSelection) {
            accountSettings
                .tabItem {
                    Label(SettingsPane.account.title, systemImage: SettingsPane.account.systemImage)
                }
                .tag(SettingsPane.account)

            ThemeCustomizationView(model: model)
                .tabItem {
                    Label(SettingsPane.appearance.title, systemImage: SettingsPane.appearance.systemImage)
                }
                .tag(SettingsPane.appearance)

            runtimeSettings
                .tabItem {
                    Label(SettingsPane.runtime.title, systemImage: SettingsPane.runtime.systemImage)
                }
                .tag(SettingsPane.runtime)

            shellSettings
                .tabItem {
                    Label(SettingsPane.shell.title, systemImage: SettingsPane.shell.systemImage)
                }
                .tag(SettingsPane.shell)

            privacySettings
                .tabItem {
                    Label(SettingsPane.privacy.title, systemImage: SettingsPane.privacy.systemImage)
                }
                .tag(SettingsPane.privacy)
        }
        .padding(20)
        .navigationTitle("Settings")
    }

    private var accountSettings: some View {
        Form {
            TextField("Name", text: $model.nameDraft)
                .textFieldStyle(.roundedBorder)

            HStack {
                Button {
                    model.updateDisplayName(model.nameDraft)
                } label: {
                    Label("Save Name", systemImage: "checkmark.circle")
                }
                .buttonStyle(.borderedProminent)
                .disabled(UserProfile.normalizedName(model.nameDraft).isEmpty)

                Button {
                    model.resetNameOnboarding()
                } label: {
                    Label("Ask Again", systemImage: "arrow.counterclockwise")
                }
            }

            LabeledContent("Runtime environment") {
                Text(model.configuration.userName.isEmpty ? "Not set" : "ELIZA_USER_NAME=\(model.configuration.userName)")
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .formStyle(.grouped)
    }

    private var runtimeSettings: some View {
        Form {
            Picker("Runtime mode", selection: $model.configuration.launchMode) {
                ForEach(RuntimeLaunchMode.allCases) { mode in
                    Text(mode.title)
                        .tag(mode)
                }
            }
            .pickerStyle(.segmented)

            TextField("Repository root", text: $model.configuration.repositoryRoot)
                .textFieldStyle(.roundedBorder)

            Button {
                model.useDetectedRepositoryRoot()
            } label: {
                Label("Detect Repository", systemImage: "scope")
            }

            TextField("API port", value: $model.configuration.apiPort, format: .number)
                .textFieldStyle(.roundedBorder)

            TextField("Renderer port", value: $model.configuration.uiPort, format: .number)
                .textFieldStyle(.roundedBorder)

            TextField("External API base", text: externalAPIBaseBinding)
                .textFieldStyle(.roundedBorder)
        }
        .formStyle(.grouped)
    }

    private var shellSettings: some View {
        Form {
            Toggle("Launch at login", isOn: $launchAtLogin)
            Toggle("Show menu bar extra", isOn: $showMenuBarExtra)
            Toggle("Use Liquid Glass surfaces", isOn: $useLiquidGlass)
        }
        .formStyle(.grouped)
    }

    private var privacySettings: some View {
        Form {
            ForEach(model.capabilities) { capability in
                LabeledContent(capability.title) {
                    Text(capability.state.title)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
    }

    private var externalAPIBaseBinding: Binding<String> {
        Binding(
            get: {
                model.configuration.externalAPIBaseURL?.absoluteString ?? ""
            },
            set: { value in
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                model.configuration.externalAPIBaseURL = trimmed.isEmpty ? nil : URL(string: trimmed)
            }
        )
    }
}
