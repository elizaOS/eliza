import ElizaMacCore
import SwiftUI

struct ContentView: View {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            if model.requiresNameOnboarding {
                FirstRunNameView(model: model)
            } else {
                shell
                    .background(WindowTransparencyBridge(isTransparent: false))
            }
        }
    }

    private var shell: some View {
        NavigationSplitView {
            SidebarView(sections: model.filteredSections, selection: $model.selection)
        } detail: {
            detailView
                .background {
                    ThemedBackdrop(theme: model.theme)
                        .backgroundExtensionEffect()
                }
        }
        .searchable(text: $model.searchText, placement: .toolbar, prompt: "Search Eliza")
        .searchToolbarBehavior(.automatic)
        .inspector(isPresented: $model.inspectorVisible) {
            InspectorView(model: model)
                .inspectorColumnWidth(min: 260, ideal: 300, max: 360)
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    model.startRuntime()
                } label: {
                    Label("Start Runtime", systemImage: "play.fill")
                }
                .disabled(model.status.isRunning)

                Button {
                    model.stopRuntime()
                } label: {
                    Label("Stop Runtime", systemImage: "stop.fill")
                }
                .disabled(!model.status.isRunning)
            }

            ToolbarSpacer(.fixed)

            ToolbarItemGroup(placement: .primaryAction) {
                Button {
                    openWindow(id: "diagnostics")
                } label: {
                    Label("Diagnostics", systemImage: "waveform.path.ecg")
                }

                Button {
                    model.toggleInspector()
                } label: {
                    Label("Inspector", systemImage: "sidebar.trailing")
                }
                .badge(model.diagnostics.filter { $0.severity != .info }.count)
            }
        }
    }

    @ViewBuilder
    private var detailView: some View {
        switch model.selection ?? .dashboard {
        case .welcome:
            WelcomeView(model: model)
        case .dashboard:
            DashboardView(model: model)
        case .chat:
            ChatView(model: model)
        case .workspaces:
            WorkspacesView(model: model)
        case .runtime:
            RuntimeOverviewView(model: model)
        case .agents:
            AgentsView(model: model)
        case .plugins:
            PluginsView(model: model)
        case .connectors:
            ConnectorsView(model: model)
        case .models:
            ModelRoutesView(model: model)
        case .memory:
            MemoryView(model: model)
        case .heartbeats:
            HeartbeatsView(model: model)
        case .lifeOps:
            LifeOpsView(model: model)
        case .health:
            HealthView(model: model)
        case .automations:
            AutomationsView(model: model)
        case .approvals:
            ApprovalsView(model: model)
        case .wallets:
            WalletsView(model: model)
        case .vault:
            VaultView(model: model)
        case .browser:
            BrowserSurfaceView(model: model)
        case .cloud:
            CloudView(model: model)
        case .release:
            ReleaseView(model: model)
        case .console:
            WebConsoleView(model: model)
        case .permissions:
            PermissionsView(model: model)
        case .diagnostics:
            DiagnosticsView(model: model)
        case .logs:
            LogsView(model: model)
        case .updates:
            UpdatesView(model: model)
        case .settings:
            AppSettingsView(model: model)
        }
    }
}
