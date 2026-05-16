public enum ShellFeatureState: String, CaseIterable, Codable, Equatable, Sendable {
    case live
    case ready
    case needsSetup
    case planned
    case warning
    case blocked

    public var title: String {
        switch self {
        case .live:
            "Live"
        case .ready:
            "Ready"
        case .needsSetup:
            "Setup"
        case .planned:
            "Planned"
        case .warning:
            "Check"
        case .blocked:
            "Blocked"
        }
    }
}

public struct ShellFeature: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let detail: String
    public let systemImage: String
    public let state: ShellFeatureState
    public let destination: ShellDestination?

    public init(
        id: String,
        title: String,
        detail: String,
        systemImage: String,
        state: ShellFeatureState,
        destination: ShellDestination? = nil
    ) {
        self.id = id
        self.title = title
        self.detail = detail
        self.systemImage = systemImage
        self.state = state
        self.destination = destination
    }

    public static let chatDefaults: [ShellFeature] = [
        ShellFeature(id: "local-chat", title: "Local Chat", detail: "Talk to the active Eliza agent through the native shell.", systemImage: "bubble.left.and.bubble.right", state: .ready, destination: .rendererTab("chat")),
        ShellFeature(id: "rooms", title: "Rooms", detail: "Route conversations by workspace, channel, and agent persona.", systemImage: "rectangle.3.group.bubble", state: .planned, destination: .rendererTab("chat")),
        ShellFeature(id: "attachments", title: "Attachments", detail: "Drop files, images, logs, and repo context into a turn.", systemImage: "paperclip", state: .planned, destination: .section(.memory)),
        ShellFeature(id: "voice", title: "Voice", detail: "Prepare transcription, playback, and push-to-talk controls.", systemImage: "waveform", state: .planned, destination: .section(.models))
    ]

    public static let pluginDefaults: [ShellFeature] = [
        ShellFeature(id: "plugin-viewer", title: "Plugin Viewer", detail: "Inspect installed plugins, connectors, and runtime feature flags.", systemImage: "puzzlepiece.extension", state: .ready, destination: .rendererAppRoute("/apps/plugins")),
        ShellFeature(id: "documents", title: "Knowledge", detail: "Character documents, fragments, and search routes.", systemImage: "doc.text.magnifyingglass", state: .ready, destination: .section(.memory)),
        ShellFeature(id: "model-tester", title: "Model Tester", detail: "Probe text, voice, transcription, VAD, and vision routes.", systemImage: "testtube.2", state: .ready, destination: .rendererAppRoute("/apps/model-tester")),
        ShellFeature(id: "training", title: "Training", detail: "Datasets, jobs, blueprints, and trajectory routes.", systemImage: "graduationcap", state: .planned, destination: .rendererAppRoute("/apps/fine-tuning")),
        ShellFeature(id: "steward", title: "Steward", detail: "Wallet management, browser bridge, and trade approvals.", systemImage: "wallet.pass", state: .needsSetup, destination: .rendererAppRoute("/apps/inventory")),
        ShellFeature(id: "runtime-debugger", title: "Runtime Debugger", detail: "Inspect actions, providers, services, and runtime health.", systemImage: "stethoscope", state: .ready, destination: .rendererAppRoute("/apps/runtime"))
    ]

    public static let appDefaults: [ShellFeature] = [
        ShellFeature(id: "lifeops", title: "LifeOps", detail: "Tasks, reminders, calendar, inbox, and connected operational workflows.", systemImage: "heart.text.square", state: .ready, destination: .rendererAppRoute("/apps/lifeops")),
        ShellFeature(id: "plugin-viewer", title: "Plugin Viewer", detail: "Installed plugins, connectors, and runtime feature flags.", systemImage: "puzzlepiece.extension", state: .ready, destination: .rendererAppRoute("/apps/plugins")),
        ShellFeature(id: "skills-viewer", title: "Skills Viewer", detail: "Create, enable, review, and install custom agent skills.", systemImage: "wand.and.stars", state: .ready, destination: .rendererAppRoute("/apps/skills")),
        ShellFeature(id: "fine-tuning", title: "Fine Tuning", detail: "Datasets, trajectories, training jobs, and tuned model activation.", systemImage: "graduationcap", state: .ready, destination: .rendererAppRoute("/apps/fine-tuning")),
        ShellFeature(id: "trajectory-viewer", title: "Trajectory Viewer", detail: "Inspect LLM call history, prompts, and execution traces.", systemImage: "waveform.path.ecg", state: .ready, destination: .rendererAppRoute("/apps/trajectories")),
        ShellFeature(id: "relationship-viewer", title: "Relationship Viewer", detail: "Explore people, identities, and relationship graphs.", systemImage: "point.3.connected.trianglepath.dotted", state: .ready, destination: .rendererAppRoute("/apps/relationships")),
        ShellFeature(id: "memory-viewer", title: "Memory Viewer", detail: "Browse memory, facts, and extraction activity.", systemImage: "square.stack.3d.up", state: .ready, destination: .rendererAppRoute("/apps/memories")),
        ShellFeature(id: "wallets", title: "Wallets", detail: "Native status for EVM, Solana, RPC providers, balances, and signing readiness.", systemImage: "wallet.pass", state: .ready, destination: .section(.wallets)),
        ShellFeature(id: "steward", title: "Steward", detail: "Wallet approvals, transaction history, and signing execution status.", systemImage: "wallet.pass", state: .needsSetup, destination: .rendererAppRoute("/apps/inventory")),
        ShellFeature(id: "runtime-debugger", title: "Runtime Debugger", detail: "Runtime objects, plugin order, providers, and services.", systemImage: "stethoscope", state: .ready, destination: .rendererAppRoute("/apps/runtime")),
        ShellFeature(id: "database-viewer", title: "Database Viewer", detail: "Tables, media, vectors, and ad-hoc SQL.", systemImage: "cylinder.split.1x2", state: .ready, destination: .rendererAppRoute("/apps/database")),
        ShellFeature(id: "model-tester", title: "Model Tester", detail: "Text, voice, transcription, VAD, and vision probes.", systemImage: "testtube.2", state: .ready, destination: .rendererAppRoute("/apps/model-tester")),
        ShellFeature(id: "documents", title: "Knowledge", detail: "Character knowledge documents, fragments, and search routes.", systemImage: "doc.text.magnifyingglass", state: .ready, destination: .rendererAppRoute("/apps/documents")),
        ShellFeature(id: "log-viewer", title: "Log Viewer", detail: "Search runtime and service logs.", systemImage: "text.page", state: .ready, destination: .rendererAppRoute("/apps/logs")),
        ShellFeature(id: "automations", title: "Automations", detail: "Create, inspect, and manage scheduled tasks and workflows.", systemImage: "checklist", state: .ready, destination: .rendererAppRoute("/apps/tasks")),
        ShellFeature(id: "companion", title: "Companion", detail: "Overlay companion app surface when the plugin is available.", systemImage: "sparkles", state: .planned, destination: .rendererAppRoute("/apps/companion")),
        ShellFeature(id: "elizamaker", title: "ElizaMaker", detail: "Drop, mint, whitelist, and verification workflows.", systemImage: "hammer", state: .planned, destination: .rendererAppRoute("/apps/elizamaker")),
        ShellFeature(id: "2004scape", title: "2004scape", detail: "Classic-era RuneScape-inspired multiplayer world.", systemImage: "gamecontroller", state: .planned, destination: .rendererAppRoute("/apps/2004scape")),
        ShellFeature(id: "defense-of-the-agents", title: "Defense of the Agents", detail: "MOBA-style arena for agent strategy and combat.", systemImage: "shield.lefthalf.filled", state: .planned, destination: .rendererAppRoute("/apps/defense-of-the-agents")),
        ShellFeature(id: "hyperscape", title: "Hyperscape", detail: "Multiplayer 3D world for embodied agent interactions.", systemImage: "cube.transparent", state: .planned, destination: .rendererAppRoute("/apps/hyperscape")),
        ShellFeature(id: "scape", title: "'scape", detail: "Agent integration for xRSPS, Scape Journal, and directed-prompt operator control.", systemImage: "map", state: .planned, destination: .rendererAppRoute("/apps/scape")),
        ShellFeature(id: "vincent", title: "Vincent", detail: "Trade on Hyperliquid and Polymarket through Vincent's agent.", systemImage: "arrow.triangle.2.circlepath", state: .planned, destination: .rendererAppRoute("/apps/vincent")),
        ShellFeature(id: "clawville", title: "ClawVille", detail: "Agent world with skill-learning buildings, NPC chat, and Solana wallet identity.", systemImage: "building.2", state: .planned, destination: .rendererAppRoute("/apps/clawville")),
        ShellFeature(id: "babylon", title: "Babylon", detail: "Babylon.js scene host for embodied agents.", systemImage: "cube", state: .planned, destination: .rendererAppRoute("/apps/babylon")),
        ShellFeature(id: "shopify", title: "Shopify", detail: "Storefront and admin tools for agent-driven commerce.", systemImage: "cart", state: .planned, destination: .rendererAppRoute("/apps/shopify")),
        ShellFeature(id: "hyperliquid", title: "Hyperliquid", detail: "Catalog trading app surface provided by the registry.", systemImage: "chart.line.uptrend.xyaxis", state: .planned, destination: .rendererAppRoute("/apps/hyperliquid")),
        ShellFeature(id: "polymarket", title: "Polymarket", detail: "Prediction-market app surface provided by the registry.", systemImage: "chart.pie", state: .planned, destination: .rendererAppRoute("/apps/app-polymarket"))
    ]

    public static let heartbeatDefaults: [ShellFeature] = [
        ShellFeature(id: "scheduled", title: "Scheduled Tasks", detail: "Run reminders, recaps, follow-ups, approvals, and outputs.", systemImage: "calendar.badge.clock", state: .ready, destination: .section(.lifeOps)),
        ShellFeature(id: "watchers", title: "Watchers", detail: "Observe repositories, files, messages, health signals, and external events.", systemImage: "eye", state: .ready, destination: .section(.health)),
        ShellFeature(id: "triggers", title: "Triggers", detail: "Route time, event, and manual triggers through one queue.", systemImage: "bolt.badge.clock", state: .ready, destination: .rendererTab("triggers")),
        ShellFeature(id: "global-pause", title: "Global Pause", detail: "Pause automation surfaces without disabling chat or manual actions.", systemImage: "pause.circle", state: .planned, destination: .section(.automations))
    ]

    public static let lifeOpsDefaults: [ShellFeature] = [
        ShellFeature(id: "scheduled-task", title: "ScheduledTask Runner", detail: "The single task primitive for reminders, check-ins, watchers, recaps, approvals, and outputs.", systemImage: "list.bullet.clipboard", state: .ready, destination: .rendererAppRoute("/apps/lifeops")),
        ShellFeature(id: "default-packs", title: "Default Packs", detail: "Enable LifeOps and health-domain packs from one native setup flow.", systemImage: "square.stack.3d.up", state: .ready, destination: .settings(.shell)),
        ShellFeature(id: "connectors", title: "Health Connectors", detail: "Calendar, notifications, bus families, anchors, and health registries.", systemImage: "heart.text.square", state: .needsSetup, destination: .section(.health)),
        ShellFeature(id: "audit", title: "Auditable Changes", detail: "Surface manual merges, approvals, and identity observations.", systemImage: "checkmark.shield", state: .planned, destination: .section(.approvals))
    ]

    public static let healthDefaults: [ShellFeature] = [
        ShellFeature(id: "connectors", title: "Connectors", detail: "Health plugin connectors register separately from LifeOps internals.", systemImage: "point.3.connected.trianglepath.dotted", state: .needsSetup, destination: .section(.connectors)),
        ShellFeature(id: "anchors", title: "Anchors", detail: "Stable health anchors for events, check-ins, bus families, and packs.", systemImage: "anchor", state: .ready, destination: .section(.diagnostics)),
        ShellFeature(id: "default-packs", title: "Health Packs", detail: "Default packs are offered independently and can be enabled without changing the task primitive.", systemImage: "heart.text.square", state: .ready, destination: .settings(.shell)),
        ShellFeature(id: "bus-families", title: "Bus Families", detail: "Native overview for contributed health data families and their readiness.", systemImage: "waveform.path.ecg.rectangle", state: .planned, destination: .section(.diagnostics))
    ]

    public static let browserDefaults: [ShellFeature] = [
        ShellFeature(id: "web-context", title: "Web Context", detail: "Open pages, collect readable context, and hand summaries back to chat.", systemImage: "safari", state: .ready, destination: .rendererTab("browser")),
        ShellFeature(id: "safe-actions", title: "Safe Actions", detail: "Keep navigation, form-fill, and downloads behind user-visible controls.", systemImage: "hand.tap", state: .planned, destination: .section(.approvals)),
        ShellFeature(id: "snapshots", title: "Snapshots", detail: "Preserve inspected pages, screenshots, and source attribution.", systemImage: "camera.viewfinder", state: .planned, destination: .section(.memory))
    ]

    public static let cloudDefaults: [ShellFeature] = [
        ShellFeature(id: "auth", title: "Eliza Cloud Auth", detail: "Connect hosted account auth when the local runtime needs cloud services.", systemImage: "person.badge.key", state: .needsSetup, destination: .settings(.account)),
        ShellFeature(id: "sync", title: "Sync", detail: "Coordinate remote settings, provider keys, and cloud-routed connectors.", systemImage: "arrow.triangle.2.circlepath", state: .planned, destination: .section(.updates)),
        ShellFeature(id: "remote-runtime", title: "Remote Runtime", detail: "Inspect external API bases without leaving the native Mac shell.", systemImage: "cloud", state: .ready, destination: .section(.runtime))
    ]

    public static let releaseDefaults: [ShellFeature] = [
        ShellFeature(id: "channel", title: "Release Channel", detail: "Track local development, canary, beta, and stable app channels.", systemImage: "point.3.filled.connected.trianglepath.dotted", state: .ready, destination: .section(.updates)),
        ShellFeature(id: "bundle", title: "Bundle Health", detail: "Confirm SwiftPM app bundle metadata, launch path, and foreground behavior.", systemImage: "shippingbox", state: .ready, destination: .section(.diagnostics)),
        ShellFeature(id: "notarization", title: "Signing", detail: "Prepare signing, entitlements, notarization, and distribution gates.", systemImage: "signature", state: .planned, destination: .section(.permissions))
    ]
}

public enum ShellDestination: Equatable, Sendable {
    case section(AppSection)
    case settings(SettingsPane)
    case rendererTab(String)
    case rendererAppRoute(String)
}
