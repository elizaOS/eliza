public enum AppSection: String, CaseIterable, Hashable, Identifiable, Sendable {
    case welcome
    case dashboard
    case chat
    case workspaces
    case runtime
    case agents
    case plugins
    case connectors
    case models
    case memory
    case heartbeats
    case lifeOps
    case health
    case automations
    case approvals
    case wallets
    case vault
    case browser
    case cloud
    case release
    case console
    case permissions
    case diagnostics
    case logs
    case updates
    case settings

    public var id: String {
        rawValue
    }

    public var title: String {
        switch self {
        case .welcome:
            "Welcome"
        case .dashboard:
            "Dashboard"
        case .chat:
            "Chat"
        case .workspaces:
            "Workspaces"
        case .runtime:
            "Runtime"
        case .agents:
            "Agents"
        case .plugins:
            "Plugins"
        case .connectors:
            "Connectors"
        case .models:
            "Models"
        case .memory:
            "Memory"
        case .heartbeats:
            "Heartbeats"
        case .lifeOps:
            "LifeOps"
        case .health:
            "Health"
        case .automations:
            "Automations"
        case .approvals:
            "Approvals"
        case .wallets:
            "Wallets"
        case .vault:
            "Vault"
        case .browser:
            "Browser"
        case .cloud:
            "Cloud"
        case .release:
            "Release"
        case .console:
            "Console"
        case .permissions:
            "Permissions"
        case .diagnostics:
            "Diagnostics"
        case .logs:
            "Logs"
        case .updates:
            "Updates"
        case .settings:
            "Settings"
        }
    }

    public var detail: String {
        switch self {
        case .welcome:
            "Setup"
        case .dashboard:
            "Overview"
        case .chat:
            "Conversation"
        case .workspaces:
            "Projects"
        case .runtime:
            "Local process"
        case .agents:
            "Profiles"
        case .plugins:
            "Apps"
        case .connectors:
            "Channels"
        case .models:
            "Routing"
        case .memory:
            "Knowledge"
        case .heartbeats:
            "Triggers"
        case .lifeOps:
            "ScheduledTask"
        case .health:
            "Registries"
        case .automations:
            "Tasks"
        case .approvals:
            "Queue"
        case .wallets:
            "Signing"
        case .vault:
            "Secrets"
        case .browser:
            "Web context"
        case .cloud:
            "Remote"
        case .release:
            "Distribution"
        case .console:
            "Renderer"
        case .permissions:
            "macOS access"
        case .diagnostics:
            "Health"
        case .logs:
            "Output"
        case .updates:
            "Versioning"
        case .settings:
            "Configuration"
        }
    }

    public var systemImage: String {
        switch self {
        case .welcome:
            "sparkles"
        case .dashboard:
            "rectangle.grid.2x2"
        case .chat:
            "bubble.left.and.bubble.right"
        case .workspaces:
            "folder.badge.gearshape"
        case .runtime:
            "cpu"
        case .agents:
            "person.2"
        case .plugins:
            "puzzlepiece.extension"
        case .connectors:
            "point.3.connected.trianglepath.dotted"
        case .models:
            "brain"
        case .memory:
            "shippingbox"
        case .heartbeats:
            "bolt.badge.clock"
        case .lifeOps:
            "heart.text.square"
        case .health:
            "heart.text.square.fill"
        case .automations:
            "calendar.badge.clock"
        case .approvals:
            "checklist.checked"
        case .wallets:
            "wallet.pass"
        case .vault:
            "lock.rectangle.stack"
        case .browser:
            "safari"
        case .cloud:
            "cloud"
        case .release:
            "shippingbox.and.arrow.backward"
        case .console:
            "macwindow"
        case .permissions:
            "hand.raised"
        case .diagnostics:
            "waveform.path.ecg"
        case .logs:
            "text.page"
        case .updates:
            "arrow.triangle.2.circlepath"
        case .settings:
            "gearshape"
        }
    }
}
