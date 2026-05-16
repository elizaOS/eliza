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
    @Published var runtimeLogEntries: [RuntimeLogEntry]
    @Published var runtimeSnapshot: RuntimeSnapshot?
    @Published var walletSnapshot: WalletRuntimeSnapshot?
    @Published var isRefreshingRuntime: Bool
    @Published var isRefreshingWallet: Bool
    @Published var lastRuntimeProbeError: String?
    @Published var lastWalletProbeError: String?
    @Published var lastNativeActionResult: String?
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
    private let notificationService = MacNotificationService()
    private let automationService = MacAutomationService()

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
        runtimeLogEntries: [RuntimeLogEntry] = [],
        runtimeSnapshot: RuntimeSnapshot? = nil,
        walletSnapshot: WalletRuntimeSnapshot? = nil,
        isRefreshingRuntime: Bool = false,
        isRefreshingWallet: Bool = false,
        lastRuntimeProbeError: String? = nil,
        lastWalletProbeError: String? = nil,
        lastNativeActionResult: String? = nil,
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
        self.runtimeLogEntries = runtimeLogEntries
        self.runtimeSnapshot = runtimeSnapshot
        self.walletSnapshot = walletSnapshot
        self.isRefreshingRuntime = isRefreshingRuntime
        self.isRefreshingWallet = isRefreshingWallet
        self.lastRuntimeProbeError = lastRuntimeProbeError
        self.lastWalletProbeError = lastWalletProbeError
        self.lastNativeActionResult = lastNativeActionResult
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
        var items = [
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
            ShellMetric(id: "wallets", title: "Wallets", value: walletMetricValue, detail: walletMetricDetail, systemImage: "wallet.pass"),
            ShellMetric(id: "vault", title: "Vault", value: "\(vaultItems.count)", detail: "secure stores", systemImage: "lock.rectangle.stack")
        ]

        if let runtimeSnapshot {
            items.append(
                ShellMetric(
                    id: "runtime-plugins",
                    title: "Loaded Plugins",
                    value: "\(runtimeSnapshot.health.plugins.loaded)",
                    detail: "\(runtimeSnapshot.health.plugins.failed) failed",
                    systemImage: "puzzlepiece.extension"
                )
            )
            items.append(
                ShellMetric(
                    id: "runtime-logs",
                    title: "Runtime Logs",
                    value: "\(runtimeSnapshot.logs.entries.count)",
                    detail: "\(runtimeSnapshot.logs.sources.count) sources",
                    systemImage: "text.page"
                )
            )
        }

        return items
    }

    private var walletMetricValue: String {
        guard let walletSnapshot else {
            return "-"
        }

        let evmReady = walletSnapshot.addresses.evmAddress?.isEmpty == false
        let solanaReady = walletSnapshot.addresses.solanaAddress?.isEmpty == false
        return "\([evmReady, solanaReady].filter { $0 }.count)"
    }

    private var walletMetricDetail: String {
        guard let walletSnapshot else {
            return "runtime"
        }

        if walletSnapshot.config.executionReady == true {
            return "execution ready"
        }

        if let source = walletSnapshot.config.walletSource {
            return source
        }

        return "connected"
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
            refreshRuntimeSnapshot(after: 1_500_000_000)
            refreshWalletSnapshot(after: 1_800_000_000)
        } catch {
            status = .failed(message: error.localizedDescription)
            appendRuntimeEvent("Runtime failed: \(error.localizedDescription)")
        }
    }

    func stopRuntime() {
        runtimeController.stop()
        status = runtimeController.status
        runtimeSnapshot = nil
        runtimeLogEntries = []
        walletSnapshot = nil
        lastRuntimeProbeError = nil
        lastWalletProbeError = nil
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

    func refreshRuntimeSnapshot() {
        guard !isRefreshingRuntime else {
            return
        }

        isRefreshingRuntime = true
        let apiBase = configuration.apiBaseURL

        Task {
            defer {
                isRefreshingRuntime = false
            }

            do {
                let snapshot = try await RuntimeAPIClient(baseURL: apiBase).fetchSnapshot()
                applyRuntimeSnapshot(snapshot, apiBase: apiBase)
            } catch {
                let message = error.localizedDescription
                lastRuntimeProbeError = message
                diagnostics = diagnosticsAfterProbeFailure(message)
                appendRuntimeEvent("Runtime probe failed: \(message)")
            }
        }
    }

    func refreshWalletSnapshot() {
        guard !isRefreshingWallet else {
            return
        }

        isRefreshingWallet = true
        let apiBase = configuration.apiBaseURL

        Task {
            defer {
                isRefreshingWallet = false
            }

            do {
                let snapshot = try await RuntimeAPIClient(baseURL: apiBase).fetchWalletSnapshot()
                applyWalletSnapshot(snapshot)
            } catch {
                let message = error.localizedDescription
                lastWalletProbeError = message
                walletSnapshot = nil
                diagnostics = diagnosticsAfterWalletProbeFailure(message)
                appendRuntimeEvent("Wallet probe failed: \(message)")
            }
        }
    }

    private func refreshRuntimeSnapshot(after delay: UInt64) {
        Task {
            do {
                try await Task.sleep(nanoseconds: delay)
            } catch {
                return
            }
            refreshRuntimeSnapshot()
        }
    }

    private func refreshWalletSnapshot(after delay: UInt64) {
        Task {
            do {
                try await Task.sleep(nanoseconds: delay)
            } catch {
                return
            }
            refreshWalletSnapshot()
        }
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
        case "wallet", "wallets", "steward":
            openSurface(.wallets)
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
        case "wallets", "steward":
            openSurface(.wallets)
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

    func openWallets() {
        openSurface(.wallets)
        if walletSnapshot == nil {
            refreshWalletSnapshot()
        }
    }

    func openWalletRenderer() {
        openRendererTab("inventory", title: "Wallets")
    }

    func openStewardApp() {
        openRendererAppRoute("/apps/inventory", title: "Steward")
    }

    func revealRepositoryInFinder() {
        automationService.revealInFinder(path: configuration.repositoryRoot)
        lastNativeActionResult = "Repository revealed in Finder."
        appendRuntimeEvent("Repository revealed in Finder.")
    }

    func openRepositoryInTerminal() {
        do {
            try automationService.openTerminal(at: configuration.repositoryRoot)
            lastNativeActionResult = "Repository opened in Terminal."
            appendRuntimeEvent("Repository opened in Terminal.")
        } catch {
            lastNativeActionResult = error.localizedDescription
            appendRuntimeEvent("Terminal AppleScript failed: \(error.localizedDescription)")
        }
    }

    func runFinderAutomationProbe() {
        do {
            try automationService.activateFinder()
            lastNativeActionResult = "Finder automation succeeded."
            appendRuntimeEvent("Finder automation succeeded.")
        } catch {
            lastNativeActionResult = error.localizedDescription
            appendRuntimeEvent("Finder automation failed: \(error.localizedDescription)")
        }
    }

    func requestNotificationAuthorization() {
        Task {
            do {
                let granted = try await notificationService.requestAuthorization()
                let message = granted ? "Notification permission granted." : "Notification permission denied."
                lastNativeActionResult = message
                updateCapability("notifications", state: granted ? .ready : .needsSetup)
                appendRuntimeEvent(message)
            } catch {
                lastNativeActionResult = error.localizedDescription
                appendRuntimeEvent("Notification permission failed: \(error.localizedDescription)")
            }
        }
    }

    func sendTestNotification() {
        Task {
            do {
                try await notificationService.deliver(
                    title: "Eliza",
                    body: "Native macOS notifications are connected for \(userDisplayName)."
                )
                lastNativeActionResult = "Test notification delivered."
                updateCapability("notifications", state: .ready)
                appendRuntimeEvent("Test notification delivered.")
            } catch {
                lastNativeActionResult = error.localizedDescription
                appendRuntimeEvent("Test notification failed: \(error.localizedDescription)")
            }
        }
    }

    func updateCapability(_ id: String, state: CapabilityState) {
        capabilities = capabilities.map { capability in
            var next = capability
            if capability.id == id {
                next.state = state
            }
            return next
        }
    }

    private func applyRuntimeSnapshot(_ snapshot: RuntimeSnapshot, apiBase: URL) {
        runtimeSnapshot = snapshot
        runtimeLogEntries = Array(snapshot.logs.entries.suffix(80).reversed())
        lastRuntimeProbeError = nil
        status = snapshot.health.ready ? .running(apiBase: apiBase) : .starting

        if !snapshot.agents.isEmpty {
            agents = snapshot.agents.map { agent in
                AgentProfile(
                    id: agent.id,
                    name: agent.name,
                    role: "Runtime agent: \(snapshot.health.agentState)",
                    model: snapshot.health.runtime,
                    systemImage: "person.crop.circle.badge.checkmark",
                    state: agentState(from: agent.status)
                )
            }
        }

        connectors = connectorProfiles(from: snapshot.health.connectors)
        diagnostics = diagnostics(from: snapshot, apiBase: apiBase)
        appendRuntimeEvent("Runtime probe refreshed: \(snapshot.health.plugins.loaded) plugins, \(snapshot.logs.entries.count) logs.")

        if snapshot.health.ready && walletSnapshot == nil && !isRefreshingWallet {
            refreshWalletSnapshot()
        }
    }

    private func applyWalletSnapshot(_ snapshot: WalletRuntimeSnapshot) {
        walletSnapshot = snapshot
        lastWalletProbeError = nil
        diagnostics = diagnosticsAfterWalletProbe(snapshot)
        appendRuntimeEvent("Wallet probe refreshed: \(walletSummary(from: snapshot)).")
    }

    private func diagnostics(from snapshot: RuntimeSnapshot, apiBase: URL) -> [DiagnosticItem] {
        var items = [
            repositoryDiagnostic(),
            DiagnosticItem(
                id: "runtime-api",
                title: "Runtime API",
                detail: snapshot.health.ready ? "Ready at \(apiBase.absoluteString)" : "Responding but not ready",
                systemImage: snapshot.health.ready ? "checkmark.seal" : "clock",
                severity: snapshot.health.ready ? .info : .warning
            ),
            DiagnosticItem(
                id: "database",
                title: "Database",
                detail: snapshot.health.database,
                systemImage: "externaldrive.connected.to.line.below",
                severity: snapshot.health.database == "ok" ? .info : .warning
            ),
            DiagnosticItem(
                id: "runtime-plugins",
                title: "Runtime Plugins",
                detail: "\(snapshot.health.plugins.loaded) loaded, \(snapshot.health.plugins.failed) failed",
                systemImage: "puzzlepiece.extension",
                severity: snapshot.health.plugins.failed == 0 ? .info : .critical
            ),
            DiagnosticItem(
                id: "coordinator",
                title: "Coordinator",
                detail: snapshot.health.coordinator,
                systemImage: "point.3.connected.trianglepath.dotted",
                severity: snapshot.health.coordinator == "ok" ? .info : .warning
            ),
            DiagnosticItem(
                id: "runtime-logs",
                title: "Runtime Logs",
                detail: "\(snapshot.logs.entries.count) entries from \(snapshot.logs.sources.count) sources",
                systemImage: "text.page",
                severity: .info
            )
        ]

        if snapshot.health.connectors.isEmpty {
            items.append(
                DiagnosticItem(
                    id: "connectors",
                    title: "Connectors",
                    detail: "No runtime connector status was reported.",
                    systemImage: "point.3.connected.trianglepath.dotted",
                    severity: .warning
                )
            )
        }

        items.append(
            DiagnosticItem(
                id: "permissions",
                title: "Permissions",
                detail: "Screen Recording, Calendar, Notifications, Automation, and Files remain user-controlled native grants.",
                systemImage: "hand.raised",
                severity: .warning
            )
        )

        return items
    }

    private func diagnosticsAfterWalletProbe(_ snapshot: WalletRuntimeSnapshot) -> [DiagnosticItem] {
        var items = diagnostics

        items.removeAll { item in
            item.id == "wallets" || item.id == "steward"
        }

        items.append(
            DiagnosticItem(
                id: "wallets",
                title: "Wallets",
                detail: walletSummary(from: snapshot),
                systemImage: "wallet.pass",
                severity: snapshot.config.executionReady == false ? .warning : .info
            )
        )

        items.append(
            DiagnosticItem(
                id: "steward",
                title: "Steward",
                detail: snapshot.steward.connected ? "Connected to Steward vault" : snapshot.steward.error ?? "Steward is not connected.",
                systemImage: "lock.shield",
                severity: snapshot.steward.connected ? .info : .warning
            )
        )

        return items
    }

    private func diagnosticsAfterWalletProbeFailure(_ message: String) -> [DiagnosticItem] {
        var items = diagnostics

        items.removeAll { item in
            item.id == "wallets"
        }

        items.append(
            DiagnosticItem(
                id: "wallets",
                title: "Wallets",
                detail: message,
                systemImage: "wallet.pass",
                severity: .critical
            )
        )

        return items
    }

    private func diagnosticsAfterProbeFailure(_ message: String) -> [DiagnosticItem] {
        [
            repositoryDiagnostic(),
            DiagnosticItem(
                id: "runtime-api",
                title: "Runtime API",
                detail: message,
                systemImage: "exclamationmark.triangle",
                severity: .critical
            ),
            DiagnosticItem(
                id: "permissions",
                title: "Permissions",
                detail: "Screen Recording, Calendar, Notifications, Automation, and Files remain user-controlled native grants.",
                systemImage: "hand.raised",
                severity: .warning
            )
        ]
    }

    private func walletSummary(from snapshot: WalletRuntimeSnapshot) -> String {
        if snapshot.config.executionReady == true {
            return "Execution ready with \(snapshot.config.walletSource ?? "runtime") wallet source."
        }

        if let blocked = snapshot.config.executionBlockedReason, !blocked.isEmpty {
            return blocked
        }

        let chains = [
            snapshot.addresses.evmAddress?.isEmpty == false ? "EVM" : nil,
            snapshot.addresses.solanaAddress?.isEmpty == false ? "Solana" : nil
        ].compactMap { $0 }

        if !chains.isEmpty {
            return "\(chains.joined(separator: " + ")) addresses available."
        }

        return "Runtime wallet routes responded without active addresses."
    }

    private func repositoryDiagnostic() -> DiagnosticItem {
        let rootURL = URL(fileURLWithPath: configuration.repositoryRoot, isDirectory: true)
        let resolved = ElizaRepositoryResolver.resolve(startingAt: rootURL)

        return DiagnosticItem(
            id: "repo",
            title: "Repository",
            detail: resolved == nil ? "No elizaOS workspace found at \(configuration.repositoryRoot)" : "elizaOS workspace detected at \(resolved?.path ?? configuration.repositoryRoot)",
            systemImage: resolved == nil ? "folder.badge.questionmark" : "checkmark.seal",
            severity: resolved == nil ? .critical : .info
        )
    }

    private func connectorProfiles(from statuses: [String: String]) -> [ConnectorProfile] {
        let dynamicProfiles = statuses.keys.sorted().map { id in
            let status = statuses[id] ?? "unknown"
            return ConnectorProfile(
                id: id,
                name: connectorName(for: id),
                detail: "Runtime status: \(status)",
                systemImage: connectorSystemImage(for: id),
                state: connectorState(from: status)
            )
        }

        let dynamicIDs = Set(dynamicProfiles.map(\.id))
        let remainingDefaults = ConnectorProfile.defaults.filter { !dynamicIDs.contains($0.id) }
        return dynamicProfiles + remainingDefaults
    }

    private func connectorName(for id: String) -> String {
        if let existing = ConnectorProfile.defaults.first(where: { $0.id == id }) {
            return existing.name
        }

        return id
            .split { character in
                character == "-" || character == "_" || character == "."
            }
            .map { $0.capitalized }
            .joined(separator: " ")
    }

    private func connectorSystemImage(for id: String) -> String {
        switch id {
        case "discord", "telegram", "slack", "matrix", "mattermost", "signal", "whatsapp":
            "message"
        case "browser":
            "safari"
        case "calendar":
            "calendar"
        case "filesystem", "files":
            "folder"
        case "notifications":
            "bell.badge"
        case "wallet", "steward":
            "wallet.pass"
        default:
            "point.3.connected.trianglepath.dotted"
        }
    }

    private func connectorState(from status: String) -> ConnectorState {
        switch status.lowercased() {
        case "ok", "ready", "running", "active", "connected", "configured", "healthy":
            .connected
        case "blocked", "failed", "error", "invalid", "needs-reauth":
            .blocked
        default:
            .available
        }
    }

    private func agentState(from status: String) -> AgentState {
        switch status.lowercased() {
        case "running", "ready", "active":
            .active
        case "stopped", "paused":
            .paused
        default:
            .draft
        }
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
