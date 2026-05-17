import Foundation

public enum RuntimeAPIError: Error, Equatable, LocalizedError {
    case invalidBaseURL(String)
    case invalidResponse(String)
    case httpStatus(Int, String)

    public var errorDescription: String? {
        switch self {
        case let .invalidBaseURL(value):
            "Invalid runtime API base URL: \(value)"
        case let .invalidResponse(path):
            "Runtime API returned a non-HTTP response for \(path)."
        case let .httpStatus(status, path):
            "Runtime API returned HTTP \(status) for \(path)."
        }
    }
}

public final class RuntimeAPIClient {
    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        decoder: JSONDecoder = JSONDecoder(),
        encoder: JSONEncoder = JSONEncoder()
    ) {
        self.baseURL = baseURL
        self.session = session
        self.decoder = decoder
        self.encoder = encoder
    }

    public func fetchSnapshot() async throws -> RuntimeSnapshot {
        async let health = fetchHealth()
        async let agents = fetchAgents()
        async let logs = fetchLogs()

        return try await RuntimeSnapshot(
            health: health,
            agents: agents,
            logs: logs,
            fetchedAt: Date()
        )
    }

    public func fetchWalletSnapshot() async throws -> WalletRuntimeSnapshot {
        async let config = fetchWalletConfig()
        async let addresses = fetchWalletAddresses()
        async let balances = fetchWalletBalances()
        async let steward = fetchStewardStatus()

        return try await WalletRuntimeSnapshot(
            config: config,
            addresses: addresses,
            balances: balances,
            steward: steward,
            fetchedAt: Date()
        )
    }

    public func fetchRuntimeSetupSnapshot() async throws -> RuntimeSetupSnapshot {
        async let permissions = fetchPermissions()
        async let automationMode = fetchAutomationMode()
        async let tradeMode = fetchTradeMode()

        return try await RuntimeSetupSnapshot(
            permissions: permissions,
            automationMode: automationMode,
            tradeMode: tradeMode,
            fetchedAt: Date()
        )
    }

    public func fetchHealth() async throws -> RuntimeHealthSnapshot {
        try await rpc(RuntimeHealthSnapshot.self, method: "runtime.health")
    }

    public func fetchAgents() async throws -> [RuntimeAgentSnapshot] {
        let response = try await rpc(RuntimeAgentsResponse.self, method: "runtime.agents")
        return response.agents
    }

    public func fetchLogs() async throws -> RuntimeLogsResponse {
        try await rpc(RuntimeLogsResponse.self, method: "runtime.logs")
    }

    public func fetchWalletConfig() async throws -> WalletConfigSnapshot {
        try await rpc(WalletConfigSnapshot.self, method: "wallet.config")
    }

    public func fetchWalletAddresses() async throws -> WalletAddressesSnapshot {
        try await rpc(WalletAddressesSnapshot.self, method: "wallet.addresses")
    }

    public func fetchWalletBalances() async throws -> WalletBalancesSnapshot {
        try await rpc(WalletBalancesSnapshot.self, method: "wallet.balances")
    }

    public func fetchStewardStatus() async throws -> StewardStatusSnapshot {
        try await rpc(StewardStatusSnapshot.self, method: "wallet.stewardStatus")
    }

    public func fetchPermissions() async throws -> RuntimePermissionsSnapshot {
        try await rpc(RuntimePermissionsSnapshot.self, method: "permissions.list")
    }

    public func fetchAutomationMode() async throws -> RuntimeAutomationModeSnapshot {
        try await rpc(RuntimeAutomationModeSnapshot.self, method: "permissions.automationMode")
    }

    public func fetchTradeMode() async throws -> RuntimeTradeModeSnapshot {
        try await rpc(RuntimeTradeModeSnapshot.self, method: "permissions.tradeMode")
    }

    public func createConversation(
        title: String,
        includeGreeting: Bool = false,
        metadata: RuntimeConversationMetadata = RuntimeConversationMetadata(scope: "general", pageId: "macos-chat")
    ) async throws -> RuntimeConversationResponse {
        try await rpc(
            RuntimeConversationResponse.self,
            method: "conversation.create",
            params: CreateConversationRequest(title: title, includeGreeting: includeGreeting, lang: "en", metadata: metadata)
        )
    }

    public func fetchConversationMessages(conversationID: String) async throws -> RuntimeConversationMessagesResponse {
        try await rpc(
            RuntimeConversationMessagesResponse.self,
            method: "conversation.messages",
            params: ConversationMessagesRequest(conversationID: conversationID)
        )
    }

    public func sendConversationMessage(
        conversationID: String,
        text: String,
        userName: String
    ) async throws -> RuntimeChatResponse {
        try await rpc(
            RuntimeChatResponse.self,
            method: "conversation.send",
            params: SendConversationMessageRequest(
                conversationID: conversationID,
                text: text,
                channelType: "DM",
                source: "swift-macos",
                metadata: RuntimeChatMessageMetadata(userName: userName.isEmpty ? nil : userName)
            )
        )
    }

    private func rpc<Response: Decodable>(_ responseType: Response.Type, method: String) async throws -> Response {
        try await rpc(responseType, method: method, params: EmptyRPCParams())
    }

    private func rpc<Response: Decodable, Params: Encodable>(
        _ responseType: Response.Type,
        method: String,
        params: Params
    ) async throws -> Response {
        let endpoint = try endpoint(path: "/api/swift/rpc")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.addValue("application/json", forHTTPHeaderField: "Accept")
        request.addValue("ElizaMac", forHTTPHeaderField: "X-Eliza-Swift-App")
        request.httpBody = try encoder.encode(RuntimeRPCRequest(method: method, params: params))

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw RuntimeAPIError.invalidResponse("/api/swift/rpc")
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            throw RuntimeAPIError.httpStatus(httpResponse.statusCode, "/api/swift/rpc")
        }

        let envelope = try decoder.decode(RuntimeRPCResponse<Response>.self, from: data)
        guard envelope.ok, let result = envelope.result else {
            throw RuntimeAPIError.httpStatus(envelope.status, method)
        }
        return result
    }

    private func endpoint(path: String) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw RuntimeAPIError.invalidBaseURL(baseURL.absoluteString)
        }

        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = basePath.isEmpty ? normalizedPath : "/\(basePath)\(normalizedPath)"
        components.queryItems = nil
        components.fragment = nil

        guard let url = components.url else {
            throw RuntimeAPIError.invalidBaseURL(baseURL.absoluteString)
        }

        return url
    }
}

private struct EmptyRPCParams: Encodable {}

private struct RuntimeRPCRequest<Params: Encodable>: Encodable {
    let id: String
    let method: String
    let params: Params

    init(method: String, params: Params) {
        self.id = UUID().uuidString
        self.method = method
        self.params = params
    }
}

private struct RuntimeRPCResponse<Result: Decodable>: Decodable {
    let ok: Bool
    let status: Int
    let result: Result?
    let error: String?
}

private struct CreateConversationRequest: Encodable {
    let title: String
    let includeGreeting: Bool
    let lang: String
    let metadata: RuntimeConversationMetadata
}

private struct ConversationMessagesRequest: Encodable {
    let conversationID: String
}

private struct SendConversationMessageRequest: Encodable {
    let conversationID: String
    let text: String
    let channelType: String
    let source: String
    let metadata: RuntimeChatMessageMetadata
}
