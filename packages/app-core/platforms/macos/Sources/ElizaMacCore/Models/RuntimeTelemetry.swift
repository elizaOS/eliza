import Foundation

public struct RuntimePluginSnapshot: Codable, Equatable, Sendable {
    public let loaded: Int
    public let failed: Int

    public init(loaded: Int, failed: Int) {
        self.loaded = loaded
        self.failed = failed
    }
}

public struct RuntimeHealthSnapshot: Codable, Equatable, Sendable {
    public let ready: Bool
    public let runtime: String
    public let database: String
    public let plugins: RuntimePluginSnapshot
    public let coordinator: String
    public let connectors: [String: String]
    public let uptime: Int
    public let agentState: String

    public init(
        ready: Bool,
        runtime: String,
        database: String,
        plugins: RuntimePluginSnapshot,
        coordinator: String,
        connectors: [String: String],
        uptime: Int,
        agentState: String
    ) {
        self.ready = ready
        self.runtime = runtime
        self.database = database
        self.plugins = plugins
        self.coordinator = coordinator
        self.connectors = connectors
        self.uptime = uptime
        self.agentState = agentState
    }
}

public struct RuntimeAgentSnapshot: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let status: String

    public init(id: String, name: String, status: String) {
        self.id = id
        self.name = name
        self.status = status
    }
}

public struct RuntimeAgentsResponse: Codable, Equatable, Sendable {
    public let agents: [RuntimeAgentSnapshot]

    public init(agents: [RuntimeAgentSnapshot]) {
        self.agents = agents
    }
}

public struct RuntimeLogEntry: Codable, Equatable, Sendable, Identifiable {
    public let timestamp: Int
    public let level: String
    public let message: String?
    public let source: String
    public let tags: [String]

    public init(timestamp: Int, level: String, message: String?, source: String, tags: [String]) {
        self.timestamp = timestamp
        self.level = level
        self.message = message
        self.source = source
        self.tags = tags
    }

    public var id: String {
        "\(timestamp)-\(source)-\(level)-\(message ?? "")"
    }
}

public struct RuntimeLogsResponse: Codable, Equatable, Sendable {
    public let entries: [RuntimeLogEntry]
    public let sources: [String]
    public let tags: [String]

    public init(entries: [RuntimeLogEntry], sources: [String], tags: [String]) {
        self.entries = entries
        self.sources = sources
        self.tags = tags
    }
}

public struct RuntimeSnapshot: Equatable, Sendable {
    public let health: RuntimeHealthSnapshot
    public let agents: [RuntimeAgentSnapshot]
    public let logs: RuntimeLogsResponse
    public let fetchedAt: Date

    public init(
        health: RuntimeHealthSnapshot,
        agents: [RuntimeAgentSnapshot],
        logs: RuntimeLogsResponse,
        fetchedAt: Date
    ) {
        self.health = health
        self.agents = agents
        self.logs = logs
        self.fetchedAt = fetchedAt
    }
}

public struct WalletRPCSelections: Codable, Equatable, Sendable {
    public let evm: String
    public let bsc: String
    public let solana: String

    public init(evm: String, bsc: String, solana: String) {
        self.evm = evm
        self.bsc = bsc
        self.solana = solana
    }
}

public struct WalletEntrySnapshot: Codable, Equatable, Sendable, Identifiable {
    public let source: String
    public let chain: String
    public let address: String
    public let provider: String
    public let primary: Bool

    public init(source: String, chain: String, address: String, provider: String, primary: Bool) {
        self.source = source
        self.chain = chain
        self.address = address
        self.provider = provider
        self.primary = primary
    }

    public var id: String {
        "\(source)-\(chain)-\(address)"
    }
}

public struct WalletPrimarySnapshot: Codable, Equatable, Sendable {
    public let evm: String
    public let solana: String

    public init(evm: String, solana: String) {
        self.evm = evm
        self.solana = solana
    }
}

public struct WalletAddressesSnapshot: Codable, Equatable, Sendable {
    public let evmAddress: String?
    public let solanaAddress: String?

    public init(evmAddress: String?, solanaAddress: String?) {
        self.evmAddress = evmAddress
        self.solanaAddress = solanaAddress
    }
}

public struct WalletConfigSnapshot: Codable, Equatable, Sendable {
    public let evmAddress: String?
    public let solanaAddress: String?
    public let selectedRpcProviders: WalletRPCSelections?
    public let walletNetwork: String?
    public let legacyCustomChains: [String]?
    public let alchemyKeySet: Bool?
    public let infuraKeySet: Bool?
    public let ankrKeySet: Bool?
    public let nodeRealBscRpcSet: Bool?
    public let quickNodeBscRpcSet: Bool?
    public let managedBscRpcReady: Bool?
    public let cloudManagedAccess: Bool?
    public let evmBalanceReady: Bool?
    public let ethereumBalanceReady: Bool?
    public let baseBalanceReady: Bool?
    public let bscBalanceReady: Bool?
    public let avalancheBalanceReady: Bool?
    public let solanaBalanceReady: Bool?
    public let tradePermissionMode: String?
    public let tradeUserCanLocalExecute: Bool?
    public let tradeAgentCanLocalExecute: Bool?
    public let heliusKeySet: Bool?
    public let birdeyeKeySet: Bool?
    public let evmChains: [String]?
    public let walletSource: String?
    public let automationMode: String?
    public let pluginEvmLoaded: Bool?
    public let pluginEvmRequired: Bool?
    public let executionReady: Bool?
    public let executionBlockedReason: String?
    public let evmSigningCapability: String?
    public let evmSigningReason: String?
    public let solanaSigningAvailable: Bool?
    public let wallets: [WalletEntrySnapshot]?
    public let primary: WalletPrimarySnapshot?

    public init(
        evmAddress: String?,
        solanaAddress: String?,
        selectedRpcProviders: WalletRPCSelections?,
        walletNetwork: String?,
        legacyCustomChains: [String]?,
        alchemyKeySet: Bool?,
        infuraKeySet: Bool?,
        ankrKeySet: Bool?,
        nodeRealBscRpcSet: Bool?,
        quickNodeBscRpcSet: Bool?,
        managedBscRpcReady: Bool?,
        cloudManagedAccess: Bool?,
        evmBalanceReady: Bool?,
        ethereumBalanceReady: Bool?,
        baseBalanceReady: Bool?,
        bscBalanceReady: Bool?,
        avalancheBalanceReady: Bool?,
        solanaBalanceReady: Bool?,
        tradePermissionMode: String?,
        tradeUserCanLocalExecute: Bool?,
        tradeAgentCanLocalExecute: Bool?,
        heliusKeySet: Bool?,
        birdeyeKeySet: Bool?,
        evmChains: [String]?,
        walletSource: String?,
        automationMode: String?,
        pluginEvmLoaded: Bool?,
        pluginEvmRequired: Bool?,
        executionReady: Bool?,
        executionBlockedReason: String?,
        evmSigningCapability: String?,
        evmSigningReason: String?,
        solanaSigningAvailable: Bool?,
        wallets: [WalletEntrySnapshot]?,
        primary: WalletPrimarySnapshot?
    ) {
        self.evmAddress = evmAddress
        self.solanaAddress = solanaAddress
        self.selectedRpcProviders = selectedRpcProviders
        self.walletNetwork = walletNetwork
        self.legacyCustomChains = legacyCustomChains
        self.alchemyKeySet = alchemyKeySet
        self.infuraKeySet = infuraKeySet
        self.ankrKeySet = ankrKeySet
        self.nodeRealBscRpcSet = nodeRealBscRpcSet
        self.quickNodeBscRpcSet = quickNodeBscRpcSet
        self.managedBscRpcReady = managedBscRpcReady
        self.cloudManagedAccess = cloudManagedAccess
        self.evmBalanceReady = evmBalanceReady
        self.ethereumBalanceReady = ethereumBalanceReady
        self.baseBalanceReady = baseBalanceReady
        self.bscBalanceReady = bscBalanceReady
        self.avalancheBalanceReady = avalancheBalanceReady
        self.solanaBalanceReady = solanaBalanceReady
        self.tradePermissionMode = tradePermissionMode
        self.tradeUserCanLocalExecute = tradeUserCanLocalExecute
        self.tradeAgentCanLocalExecute = tradeAgentCanLocalExecute
        self.heliusKeySet = heliusKeySet
        self.birdeyeKeySet = birdeyeKeySet
        self.evmChains = evmChains
        self.walletSource = walletSource
        self.automationMode = automationMode
        self.pluginEvmLoaded = pluginEvmLoaded
        self.pluginEvmRequired = pluginEvmRequired
        self.executionReady = executionReady
        self.executionBlockedReason = executionBlockedReason
        self.evmSigningCapability = evmSigningCapability
        self.evmSigningReason = evmSigningReason
        self.solanaSigningAvailable = solanaSigningAvailable
        self.wallets = wallets
        self.primary = primary
    }
}

public struct WalletTokenBalanceSnapshot: Codable, Equatable, Sendable, Identifiable {
    public let symbol: String
    public let name: String
    public let balance: String
    public let decimals: Int
    public let valueUsd: String?
    public let logoUrl: String?

    public init(symbol: String, name: String, balance: String, decimals: Int, valueUsd: String?, logoUrl: String?) {
        self.symbol = symbol
        self.name = name
        self.balance = balance
        self.decimals = decimals
        self.valueUsd = valueUsd
        self.logoUrl = logoUrl
    }

    public var id: String {
        "\(symbol)-\(name)-\(balance)"
    }
}

public struct WalletEVMTokenBalanceSnapshot: Codable, Equatable, Sendable, Identifiable {
    public let contractAddress: String
    public let symbol: String
    public let name: String
    public let balance: String
    public let decimals: Int
    public let valueUsd: String?
    public let logoUrl: String?

    public init(
        contractAddress: String,
        symbol: String,
        name: String,
        balance: String,
        decimals: Int,
        valueUsd: String?,
        logoUrl: String?
    ) {
        self.contractAddress = contractAddress
        self.symbol = symbol
        self.name = name
        self.balance = balance
        self.decimals = decimals
        self.valueUsd = valueUsd
        self.logoUrl = logoUrl
    }

    public var id: String {
        contractAddress
    }
}

public struct WalletEVMChainBalanceSnapshot: Codable, Equatable, Sendable, Identifiable {
    public let chain: String
    public let chainId: Int
    public let nativeBalance: String
    public let nativeSymbol: String
    public let nativeValueUsd: String
    public let tokens: [WalletEVMTokenBalanceSnapshot]
    public let error: String?

    public init(
        chain: String,
        chainId: Int,
        nativeBalance: String,
        nativeSymbol: String,
        nativeValueUsd: String,
        tokens: [WalletEVMTokenBalanceSnapshot],
        error: String?
    ) {
        self.chain = chain
        self.chainId = chainId
        self.nativeBalance = nativeBalance
        self.nativeSymbol = nativeSymbol
        self.nativeValueUsd = nativeValueUsd
        self.tokens = tokens
        self.error = error
    }

    public var id: Int {
        chainId
    }
}

public struct WalletEVMBalancesSnapshot: Codable, Equatable, Sendable {
    public let address: String
    public let chains: [WalletEVMChainBalanceSnapshot]

    public init(address: String, chains: [WalletEVMChainBalanceSnapshot]) {
        self.address = address
        self.chains = chains
    }
}

public struct WalletSolanaBalancesSnapshot: Codable, Equatable, Sendable {
    public let address: String
    public let solBalance: String
    public let solValueUsd: String
    public let tokens: [WalletTokenBalanceSnapshot]

    public init(address: String, solBalance: String, solValueUsd: String, tokens: [WalletTokenBalanceSnapshot]) {
        self.address = address
        self.solBalance = solBalance
        self.solValueUsd = solValueUsd
        self.tokens = tokens
    }
}

public struct WalletBalancesSnapshot: Codable, Equatable, Sendable {
    public let evm: WalletEVMBalancesSnapshot?
    public let solana: WalletSolanaBalancesSnapshot?

    public init(evm: WalletEVMBalancesSnapshot?, solana: WalletSolanaBalancesSnapshot?) {
        self.evm = evm
        self.solana = solana
    }
}

public struct StewardWalletAddressesSnapshot: Codable, Equatable, Sendable {
    public let evm: String?
    public let solana: String?

    public init(evm: String?, solana: String?) {
        self.evm = evm
        self.solana = solana
    }
}

public struct StewardStatusSnapshot: Codable, Equatable, Sendable {
    public let configured: Bool
    public let available: Bool
    public let connected: Bool
    public let baseUrl: String?
    public let agentId: String?
    public let evmAddress: String?
    public let error: String?
    public let walletAddresses: StewardWalletAddressesSnapshot?
    public let agentName: String?
    public let vaultHealth: String?

    public init(
        configured: Bool,
        available: Bool,
        connected: Bool,
        baseUrl: String?,
        agentId: String?,
        evmAddress: String?,
        error: String?,
        walletAddresses: StewardWalletAddressesSnapshot?,
        agentName: String?,
        vaultHealth: String?
    ) {
        self.configured = configured
        self.available = available
        self.connected = connected
        self.baseUrl = baseUrl
        self.agentId = agentId
        self.evmAddress = evmAddress
        self.error = error
        self.walletAddresses = walletAddresses
        self.agentName = agentName
        self.vaultHealth = vaultHealth
    }
}

public struct WalletRuntimeSnapshot: Equatable, Sendable {
    public let config: WalletConfigSnapshot
    public let addresses: WalletAddressesSnapshot
    public let balances: WalletBalancesSnapshot
    public let steward: StewardStatusSnapshot
    public let fetchedAt: Date

    public init(
        config: WalletConfigSnapshot,
        addresses: WalletAddressesSnapshot,
        balances: WalletBalancesSnapshot,
        steward: StewardStatusSnapshot,
        fetchedAt: Date
    ) {
        self.config = config
        self.addresses = addresses
        self.balances = balances
        self.steward = steward
        self.fetchedAt = fetchedAt
    }
}

public struct RuntimePermissionFeatureSnapshot: Codable, Equatable, Sendable {
    public let app: String
    public let action: String
    public let at: Int?

    public init(app: String, action: String, at: Int?) {
        self.app = app
        self.action = action
        self.at = at
    }
}

public struct RuntimePermissionState: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let status: String
    public let restrictedReason: String?
    public let lastChecked: Int?
    public let lastRequested: Int?
    public let lastBlockedFeature: RuntimePermissionFeatureSnapshot?
    public let canRequest: Bool
    public let platform: String
    public let reason: String?

    public init(
        id: String,
        status: String,
        restrictedReason: String?,
        lastChecked: Int?,
        lastRequested: Int?,
        lastBlockedFeature: RuntimePermissionFeatureSnapshot?,
        canRequest: Bool,
        platform: String,
        reason: String?
    ) {
        self.id = id
        self.status = status
        self.restrictedReason = restrictedReason
        self.lastChecked = lastChecked
        self.lastRequested = lastRequested
        self.lastBlockedFeature = lastBlockedFeature
        self.canRequest = canRequest
        self.platform = platform
        self.reason = reason
    }
}

public struct RuntimePermissionsSnapshot: Decodable, Equatable, Sendable {
    public let permissions: [String: RuntimePermissionState]
    public let platform: String
    public let shellEnabled: Bool
    public let fetchedAt: Date

    public init(
        permissions: [String: RuntimePermissionState],
        platform: String,
        shellEnabled: Bool,
        fetchedAt: Date
    ) {
        self.permissions = permissions
        self.platform = platform
        self.shellEnabled = shellEnabled
        self.fetchedAt = fetchedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: DynamicCodingKey.self)
        var permissions: [String: RuntimePermissionState] = [:]
        var platform = "unknown"
        var shellEnabled = false

        for key in container.allKeys {
            switch key.stringValue {
            case "_platform":
                platform = try container.decode(String.self, forKey: key)
            case "_shellEnabled":
                shellEnabled = try container.decode(Bool.self, forKey: key)
            default:
                permissions[key.stringValue] = try container.decode(RuntimePermissionState.self, forKey: key)
            }
        }

        self.permissions = permissions
        self.platform = platform
        self.shellEnabled = shellEnabled
        self.fetchedAt = Date()
    }
}

public struct RuntimeAutomationModeSnapshot: Codable, Equatable, Sendable {
    public let mode: String
    public let options: [String]

    public init(mode: String, options: [String]) {
        self.mode = mode
        self.options = options
    }
}

public struct RuntimeTradeModeSnapshot: Codable, Equatable, Sendable {
    public let tradePermissionMode: String
    public let canUserLocalExecute: Bool
    public let canAgentAutoTrade: Bool

    public init(tradePermissionMode: String, canUserLocalExecute: Bool, canAgentAutoTrade: Bool) {
        self.tradePermissionMode = tradePermissionMode
        self.canUserLocalExecute = canUserLocalExecute
        self.canAgentAutoTrade = canAgentAutoTrade
    }
}

public struct RuntimeSetupSnapshot: Equatable, Sendable {
    public let permissions: RuntimePermissionsSnapshot
    public let automationMode: RuntimeAutomationModeSnapshot
    public let tradeMode: RuntimeTradeModeSnapshot
    public let fetchedAt: Date

    public init(
        permissions: RuntimePermissionsSnapshot,
        automationMode: RuntimeAutomationModeSnapshot,
        tradeMode: RuntimeTradeModeSnapshot,
        fetchedAt: Date
    ) {
        self.permissions = permissions
        self.automationMode = automationMode
        self.tradeMode = tradeMode
        self.fetchedAt = fetchedAt
    }
}

public struct RuntimeConversationMetadata: Codable, Equatable, Sendable {
    public let scope: String
    public let pageId: String?

    public init(scope: String = "general", pageId: String? = nil) {
        self.scope = scope
        self.pageId = pageId
    }
}

public struct RuntimeConversation: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let roomId: String
    public let metadata: RuntimeConversationMetadata?
    public let createdAt: String
    public let updatedAt: String

    public init(
        id: String,
        title: String,
        roomId: String,
        metadata: RuntimeConversationMetadata?,
        createdAt: String,
        updatedAt: String
    ) {
        self.id = id
        self.title = title
        self.roomId = roomId
        self.metadata = metadata
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct RuntimeConversationGreeting: Codable, Equatable, Sendable {
    public let text: String
    public let agentName: String
    public let generated: Bool
    public let persisted: Bool

    public init(text: String, agentName: String, generated: Bool, persisted: Bool) {
        self.text = text
        self.agentName = agentName
        self.generated = generated
        self.persisted = persisted
    }
}

public struct RuntimeConversationResponse: Codable, Equatable, Sendable {
    public let conversation: RuntimeConversation
    public let greeting: RuntimeConversationGreeting?

    public init(conversation: RuntimeConversation, greeting: RuntimeConversationGreeting?) {
        self.conversation = conversation
        self.greeting = greeting
    }
}

public struct RuntimeConversationMessage: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let role: String
    public let text: String
    public let timestamp: Int
    public let source: String?
    public let actionName: String?
    public let from: String?
    public let fromUserName: String?

    public init(
        id: String,
        role: String,
        text: String,
        timestamp: Int,
        source: String? = nil,
        actionName: String? = nil,
        from: String? = nil,
        fromUserName: String? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.timestamp = timestamp
        self.source = source
        self.actionName = actionName
        self.from = from
        self.fromUserName = fromUserName
    }
}

public struct RuntimeConversationMessagesResponse: Codable, Equatable, Sendable {
    public let messages: [RuntimeConversationMessage]

    public init(messages: [RuntimeConversationMessage]) {
        self.messages = messages
    }
}

public struct RuntimeChatMessageMetadata: Codable, Equatable, Sendable {
    public let client: String
    public let surface: String
    public let userName: String?

    public init(client: String = "swift-macos", surface: String = "native-chat", userName: String?) {
        self.client = client
        self.surface = surface
        self.userName = userName
    }
}

public struct RuntimeChatResponse: Codable, Equatable, Sendable {
    public let text: String
    public let agentName: String?
    public let failureKind: String?
    public let noResponseReason: String?

    public init(text: String, agentName: String?, failureKind: String?, noResponseReason: String?) {
        self.text = text
        self.agentName = agentName
        self.failureKind = failureKind
        self.noResponseReason = noResponseReason
    }
}

private struct DynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}
