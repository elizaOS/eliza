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
