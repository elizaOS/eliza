import Combine
import ElizaMacCore
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var selection: AppSection?
    @Published var configuration: RuntimeConfiguration
    @Published private(set) var status: RuntimeStatus
    @Published var searchText: String
    @Published var inspectorVisible: Bool
    @Published var agents: [AgentProfile]
    @Published var connectors: [ConnectorProfile]
    @Published var modelRoutes: [ModelRoute]
    @Published var capabilities: [CapabilitySummary]
    @Published var diagnostics: [DiagnosticItem]
    @Published var workspaces: [WorkspaceProfile]
    @Published var approvals: [ApprovalItem]
    @Published var vaultItems: [VaultItem]
    @Published var chatFeatures: [ShellFeature]
    @Published var appFeatures: [ShellFeature]
    @Published var pluginFeatures: [ShellFeature]
    @Published var heartbeatFeatures: [ShellFeature]
    @Published var lifeOpsFeatures: [ShellFeature]
    @Published var healthFeatures: [ShellFeature]
    @Published var browserFeatures: [ShellFeature]
    @Published var cloudFeatures: [ShellFeature]
    @Published var releaseFeatures: [ShellFeature]
    @Published var runtimeEvents: [String]
    @Published var consoleURL: URL
    @Published var consoleTitle: String
    @Published var consoleDetail: String
    @Published var settingsSelection: SettingsPane
    @Published var profile: UserProfile {
        didSet {
            configuration.userName = profile.displayName
            ProfilePreferences.save(profile)
        }
    }
    @Published var nameDraft: String
    @Published var theme: ThemeSettings {
        didSet {
            ThemePreferences.save(theme)
        }
    }

    private let runtimeController: RuntimeController

    init(
        selection: AppSection? = .dashboard,
        configuration: RuntimeConfiguration = .defaultConfiguration(),
        status: RuntimeStatus = .stopped,
        runtimeController: RuntimeController? = nil,
        searchText: String = "",
        inspectorVisible: Bool = true,
        agents: [AgentProfile] = AgentProfile.defaults,
        connectors: [ConnectorProfile] = ConnectorProfile.defaults,
        modelRoutes: [ModelRoute] = ModelRoute.defaults,
        capabilities: [CapabilitySummary] = CapabilitySummary.defaults,
        diagnostics: [DiagnosticItem] = DiagnosticItem.defaults,
        workspaces: [WorkspaceProfile]? = nil,
        approvals: [ApprovalItem] = [],
        vaultItems: [VaultItem] = VaultItem.defaults,
        chatFeatures: [ShellFeature] = ShellFeature.chatDefaults,
        appFeatures: [ShellFeature] = ShellFeature.appDefaults,
        pluginFeatures: [ShellFeature] = ShellFeature.pluginDefaults,
        heartbeatFeatures: [ShellFeature] = ShellFeature.heartbeatDefaults,
        lifeOpsFeatures: [ShellFeature] = ShellFeature.lifeOpsDefaults,
        healthFeatures: [ShellFeature] = ShellFeature.healthDefaults,
        browserFeatures: [ShellFeature] = ShellFeature.browserDefaults,
        cloudFeatures: [ShellFeature] = ShellFeature.cloudDefaults,
        releaseFeatures: [ShellFeature] = ShellFeature.releaseDefaults,
        runtimeEvents: [String] = [],
        consoleTitle: String = "Renderer Home",
        consoleDetail: String = "Base renderer target for the current elizaOS runtime.",
        settingsSelection: SettingsPane = .account,
        profile: UserProfile = ProfilePreferences.load(),
        theme: ThemeSettings = ThemePreferences.load()
    ) {
        var resolvedConfiguration = configuration
        resolvedConfiguration.userName = profile.displayName
        self.selection = selection
        self.configuration = resolvedConfiguration
        self.status = status
        self.searchText = searchText
        self.inspectorVisible = inspectorVisible
        self.agents = agents
        self.connectors = connectors
        self.modelRoutes = modelRoutes
        self.capabilities = capabilities
        self.diagnostics = diagnostics
        self.workspaces = workspaces ?? [
            WorkspaceProfile(
                id: "current",
                name: "elizaOS",
                path: configuration.repositoryRoot,
                detail: "Current runtime workspace",
                state: .active
            )
        ]
        self.approvals = approvals
        self.vaultItems = vaultItems
        self.chatFeatures = chatFeatures
        self.appFeatures = appFeatures
        self.pluginFeatures = pluginFeatures
        self.heartbeatFeatures = heartbeatFeatures
        self.lifeOpsFeatures = lifeOpsFeatures
        self.healthFeatures = healthFeatures
        self.browserFeatures = browserFeatures
        self.cloudFeatures = cloudFeatures
        self.releaseFeatures = releaseFeatures
        self.runtimeEvents = runtimeEvents.isEmpty ? ["Swift shell initialized."] : runtimeEvents
        self.consoleURL = resolvedConfiguration.rendererURL
        self.consoleTitle = consoleTitle
        self.consoleDetail = consoleDetail
        self.settingsSelection = settingsSelection
        self.profile = profile
        self.nameDraft = profile.displayName
        self.theme = theme.normalized()
        self.runtimeController = runtimeController ?? RuntimeController()
    }

    var requiresNameOnboarding: Bool {
        !profile.hasDisplayName
    }

    var userDisplayName: String {
        profile.hasDisplayName ? profile.displayName : "there"
    }

    var metrics: [ShellMetric] {
        [
            ShellMetric(id: "runtime", title: "Runtime", value: status.title, detail: configuration.launchMode.title, systemImage: status.systemImage),
            ShellMetric(id: "chat", title: "Chat", value: "\(chatFeatures.count)", detail: "native lanes", systemImage: "bubble.left.and.bubble.right"),
            ShellMetric(id: "apps", title: "Apps", value: "\(appFeatures.count)", detail: "\(appFeatures.filter { $0.state == .ready }.count) ready", systemImage: "square.grid.3x3"),
            ShellMetric(id: "agents", title: "Agents", value: "\(agents.count)", detail: "\(agents.filter { $0.state == .active }.count) active", systemImage: "person.2"),
            ShellMetric(id: "plugins", title: "Plugins", value: "\(pluginFeatures.count)", detail: "\(pluginFeatures.filter { $0.state == .ready }.count) ready", systemImage: "puzzlepiece.extension"),
            ShellMetric(id: "connectors", title: "Connectors", value: "\(connectors.count)", detail: "\(connectors.filter { $0.state == .connected }.count) connected", systemImage: "point.3.connected.trianglepath.dotted"),
            ShellMetric(id: "models", title: "Model Routes", value: "\(modelRoutes.count)", detail: "\(modelRoutes.filter { $0.state == .preferred }.count) preferred", systemImage: "brain"),
            ShellMetric(id: "lifeops", title: "LifeOps", value: "\(lifeOpsFeatures.count)", detail: "ScheduledTask", systemImage: "heart.text.square"),
            ShellMetric(id: "health", title: "Health", value: "\(healthFeatures.count)", detail: "registries", systemImage: "heart.text.square.fill"),
            ShellMetric(id: "approvals", title: "Approvals", value: "\(approvals.count)", detail: approvals.isEmpty ? "queue empty" : "pending", systemImage: "checklist.checked"),
            ShellMetric(id: "vault", title: "Vault", value: "\(vaultItems.count)", detail: "secure stores", systemImage: "lock.rectangle.stack")
        ]
    }

    var filteredSections: [AppSection] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            return AppSection.allCases
        }
        return AppSection.allCases.filter {
            $0.title.localizedCaseInsensitiveContains(query)
                || $0.detail.localizedCaseInsensitiveContains(query)
        }
    }

    func startRuntime() {
        do {
            try runtimeController.start(configuration: configuration)
            status = runtimeController.status
            appendRuntimeEvent("Runtime started at \(configuration.apiBaseURL.absoluteString).")
        } catch {
            status = .failed(message: error.localizedDescription)
            appendRuntimeEvent("Runtime failed: \(error.localizedDescription)")
        }
    }

    func stopRuntime() {
        runtimeController.stop()
        status = runtimeController.status
        appendRuntimeEvent("Runtime stopped.")
    }

    func useDetectedRepositoryRoot() {
        if let root = ElizaRepositoryResolver.resolve() {
            configuration.repositoryRoot = root.path
            workspaces = [
                WorkspaceProfile(
                    id: "current",
                    name: "elizaOS",
                    path: root.path,
                    detail: "Current runtime workspace",
                    state: .active
                )
            ]
            appendRuntimeEvent("Repository set to \(root.path).")
        }
    }

    func select(_ section: AppSection) {
        selection = section
    }

    func toggleInspector() {
        inspectorVisible.toggle()
    }

    func applyThemePreset(_ preset: ThemePreset) {
        theme = ThemeSettings.preset(preset)
        appendRuntimeEvent("Theme changed to \(preset.title).")
    }

    func openSurface(_ section: AppSection) {
        selection = section
        appendRuntimeEvent("Opened \(section.title).")
    }

    func openFeature(_ feature: ShellFeature, fallback section: AppSection) {
        switch feature.destination {
        case .section(let section):
            openSurface(section)
            appendRuntimeEvent("Opened \(feature.title).")
        case .settings(let pane):
            openSettings(pane)
            appendRuntimeEvent("Opened \(feature.title).")
        case .rendererTab(let tab):
            openRendererTab(tab, title: feature.title)
        case .rendererAppRoute(let route):
            openRendererAppRoute(route, title: feature.title)
        case nil:
            openSurface(section)
            appendRuntimeEvent("Opened \(feature.title) from \(section.title).")
        }
    }

    func openRendererTab(_ tab: String, title: String) {
        openRendererTab(tab, title: title, additionalQueryItems: [])
    }

    func openRendererTab(_ tab: String, title: String, additionalQueryItems: [URLQueryItem]) {
        consoleURL = rendererURL(queryItems: [
            URLQueryItem(name: "shell", value: "surface"),
            URLQueryItem(name: "tab", value: tab)
        ] + additionalQueryItems)
        consoleTitle = title
        consoleDetail = "Renderer shell tab: \(tab)"
        selection = .console
        appendRuntimeEvent("Opened \(title) in renderer tab \(tab).")
    }

    func openRendererAppRoute(_ route: String, title: String) {
        consoleURL = rendererURL(
            queryItems: [
                URLQueryItem(name: "appWindow", value: "1")
            ],
            fragment: route
        )
        consoleTitle = title
        consoleDetail = "Renderer app route: \(route)"
        selection = .console
        appendRuntimeEvent("Opened \(title) at renderer route \(route).")
    }

    func openSettings(_ pane: SettingsPane) {
        settingsSelection = pane
        selection = .settings
        appendRuntimeEvent("Opened \(pane.title) settings.")
    }

    func resetConsoleHome() {
        consoleURL = configuration.rendererURL
        consoleTitle = "Renderer Home"
        consoleDetail = "Base renderer target for the current elizaOS runtime."
        selection = .console
        appendRuntimeEvent("Opened renderer home.")
    }

    @discardableResult
    func submitChatPrompt(_ prompt: String) -> Bool {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            appendRuntimeEvent("Chat prompt was empty.")
            return false
        }

        openRendererTab(
            "chat",
            title: "Chat",
            additionalQueryItems: [
                URLQueryItem(name: "prompt", value: trimmed)
            ]
        )

        if !status.isRunning {
            startRuntime()
            appendRuntimeEvent("Queued chat prompt for renderer.")
        } else {
            appendRuntimeEvent("Prepared chat prompt for renderer.")
        }

        return true
    }

    @discardableResult
    func prepareBrowserURL(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            appendRuntimeEvent("Browser URL was empty.")
            return false
        }

        let normalized = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard
            let url = URL(string: normalized),
            let scheme = url.scheme?.lowercased(),
            ["http", "https"].contains(scheme)
        else {
            appendRuntimeEvent("Browser URL was invalid: \(trimmed).")
            return false
        }

        openRendererTab(
            "browser",
            title: "Browser",
            additionalQueryItems: [
                URLQueryItem(name: "browse", value: url.absoluteString)
            ]
        )
        appendRuntimeEvent("Prepared browser context for \(url.host ?? url.absoluteString).")
        return true
    }

    func activateAgent(_ id: String) {
        guard agents.contains(where: { $0.id == id }) else {
            preconditionFailure("Unknown agent id: \(id)")
        }

        agents = agents.map { agent in
            var next = agent
            if agent.id == id {
                next.state = .active
            } else if agent.state == .active {
                next.state = .paused
            }
            return next
        }

        let activeName = agents.first { $0.id == id }?.name ?? id
        appendRuntimeEvent("Activated \(activeName) agent.")
    }

    func useModelRoute(_ id: String) {
        guard let route = modelRoutes.first(where: { $0.id == id }) else {
            preconditionFailure("Unknown model route id: \(id)")
        }

        guard route.state != .needsKey else {
            openSurface(.vault)
            appendRuntimeEvent("\(route.name) needs a provider key.")
            return
        }

        modelRoutes = modelRoutes.map { item in
            var next = item
            if item.state != .needsKey {
                next.state = item.id == id ? .preferred : .available
            }
            return next
        }
        appendRuntimeEvent("Preferred model route changed to \(route.name).")
    }

    func openConnector(_ connector: ConnectorProfile) {
        switch connector.id {
        case "chat":
            openSurface(.chat)
        case "browser":
            openSurface(.browser)
        case "filesystem":
            openSurface(.workspaces)
        case "screen", "calendar", "notifications":
            openSurface(.permissions)
        default:
            openSurface(.connectors)
        }
        appendRuntimeEvent("Opened \(connector.name) connector setup.")
    }

    func openVaultItem(_ item: VaultItem) {
        switch item.id {
        case "keychain":
            openSurface(.permissions)
        case "providers":
            openSurface(.models)
        case "tokens":
            openSurface(.runtime)
        default:
            openSurface(.vault)
        }
        appendRuntimeEvent("Opened \(item.title) vault path.")
    }

    func completeNameOnboarding() {
        let nextProfile = UserProfile(displayName: nameDraft)
        guard nextProfile.hasDisplayName else {
            return
        }
        profile = nextProfile
        nameDraft = nextProfile.displayName
        appendRuntimeEvent("Eliza learned your name: \(nextProfile.displayName).")
    }

    func updateDisplayName(_ value: String) {
        let nextProfile = UserProfile(displayName: value)
        profile = nextProfile
        nameDraft = nextProfile.displayName
        appendRuntimeEvent("Display name updated to \(nextProfile.displayName).")
    }

    func resetNameOnboarding() {
        profile = .anonymous
        nameDraft = ""
        appendRuntimeEvent("Display name reset.")
    }

    private func appendRuntimeEvent(_ event: String) {
        runtimeEvents.insert(event, at: 0)
        if runtimeEvents.count > 80 {
            runtimeEvents.removeLast(runtimeEvents.count - 80)
        }
    }

    private func rendererURL(queryItems: [URLQueryItem], fragment: String? = nil) -> URL {
        guard var components = URLComponents(url: configuration.rendererURL, resolvingAgainstBaseURL: false) else {
            preconditionFailure("Invalid renderer URL: \(configuration.rendererURL.absoluteString)")
        }
        components.queryItems = queryItems
        components.fragment = fragment
        guard let url = components.url else {
            preconditionFailure("Invalid renderer URL components for \(configuration.rendererURL.absoluteString)")
        }
        return url
    }
}
