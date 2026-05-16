import ElizaMacCore
import SwiftUI

@main
struct ElizaMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup("Eliza", id: "main") {
            ContentView(model: model)
                .frame(minWidth: 1120, minHeight: 740)
                .environment(\.elizaTheme, model.theme)
                .preferredColorScheme(model.theme.appearance.preferredColorScheme)
                .tint(model.theme.accent.color)
        }
        .commands {
            CommandMenu("Navigate") {
                ForEach(AppSection.allCases) { section in
                    Button(section.title) {
                        model.openSurface(section)
                    }
                }
            }

            CommandMenu("Runtime") {
                Button("Start Runtime") {
                    model.startRuntime()
                }
                .keyboardShortcut("r", modifiers: [.command])
                .disabled(model.status.isRunning)

                Button("Stop Runtime") {
                    model.stopRuntime()
                }
                .keyboardShortcut(".", modifiers: [.command])
                .disabled(!model.status.isRunning)
            }

            CommandMenu("Display") {
                Button(model.inspectorVisible ? "Hide Inspector" : "Show Inspector") {
                    model.toggleInspector()
                }
                .keyboardShortcut("i", modifiers: [.command, .option])
            }
        }

        Window("Diagnostics", id: "diagnostics") {
            DiagnosticsView(model: model)
                .frame(minWidth: 720, minHeight: 520)
                .environment(\.elizaTheme, model.theme)
                .preferredColorScheme(model.theme.appearance.preferredColorScheme)
                .tint(model.theme.accent.color)
        }

        Settings {
            AppSettingsView(model: model)
                .frame(width: 480)
                .environment(\.elizaTheme, model.theme)
                .preferredColorScheme(model.theme.appearance.preferredColorScheme)
                .tint(model.theme.accent.color)
        }

        MenuBarExtra("Eliza", systemImage: "sparkles") {
            MenuBarStatusView(model: model)
                .environment(\.elizaTheme, model.theme)
                .tint(model.theme.accent.color)
        }
        .menuBarExtraStyle(.window)
    }
}
