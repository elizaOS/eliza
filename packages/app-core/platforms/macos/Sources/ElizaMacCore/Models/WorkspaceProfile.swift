public enum WorkspaceState: String, CaseIterable, Codable, Equatable, Sendable {
    case active
    case indexed
    case missing

    public var title: String {
        switch self {
        case .active:
            "Active"
        case .indexed:
            "Indexed"
        case .missing:
            "Missing"
        }
    }
}

public struct WorkspaceProfile: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let path: String
    public let detail: String
    public let state: WorkspaceState

    public init(id: String, name: String, path: String, detail: String, state: WorkspaceState) {
        self.id = id
        self.name = name
        self.path = path
        self.detail = detail
        self.state = state
    }
}

public struct ApprovalItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let detail: String
    public let source: String

    public init(id: String, title: String, detail: String, source: String) {
        self.id = id
        self.title = title
        self.detail = detail
        self.source = source
    }
}

public struct VaultItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let detail: String
    public let systemImage: String

    public init(id: String, title: String, detail: String, systemImage: String) {
        self.id = id
        self.title = title
        self.detail = detail
        self.systemImage = systemImage
    }

    public static let defaults: [VaultItem] = [
        VaultItem(id: "keychain", title: "Keychain", detail: "Native macOS credential storage", systemImage: "key"),
        VaultItem(id: "providers", title: "Provider Keys", detail: "Model and connector credentials", systemImage: "lock.rectangle.stack"),
        VaultItem(id: "tokens", title: "Session Tokens", detail: "Local runtime auth material", systemImage: "person.badge.key")
    ]
}
