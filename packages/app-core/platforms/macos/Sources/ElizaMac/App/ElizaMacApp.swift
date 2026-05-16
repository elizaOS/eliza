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

                Divider()

                Button("Refresh Runtime Telemetry") {
                    model.refreshRuntimeSnapshot()
                }
                .keyboardShortcut("r", modifiers: [.command, .shift])

                Button("Refresh Wallet Telemetry") {
                    model.refreshWalletSnapshot()
                }
                .keyboardShortcut("w", modifiers: [.command, .shift])
            }

            CommandMenu("Display") {
                Button(model.inspectorVisible ? "Hide Inspector" : "Show Inspector") {
                    model.toggleInspector()
                }
                .keyboardShortcut("i", modifiers: [.command, .option])
            }

            CommandMenu("Mac") {
                Button("Reveal Repository in Finder") {
                    model.revealRepositoryInFinder()
                }
                .keyboardShortcut("f", modifiers: [.command, .option])

                Button("Open Repository in Terminal") {
                    model.openRepositoryInTerminal()
                }
                .keyboardShortcut("t", modifiers: [.command, .option])

                Divider()

                Button("Request Notifications") {
                    model.requestNotificationAuthorization()
                }

                Button("Send Test Notification") {
                    model.sendTestNotification()
                }

                Button("Test Finder Automation") {
                    model.runFinderAutomationProbe()
                }

                Divider()

                Button("Open Wallets") {
                    model.openWallets()
                }
                .keyboardShortcut("w", modifiers: [.command, .option])
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
