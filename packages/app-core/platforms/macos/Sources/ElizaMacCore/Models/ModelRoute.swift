public enum ModelRouteState: String, CaseIterable, Codable, Equatable, Sendable {
    case preferred
    case available
    case needsKey

    public var title: String {
        switch self {
        case .preferred:
            "Preferred"
        case .available:
            "Available"
        case .needsKey:
            "Needs key"
        }
    }
}

public struct ModelRoute: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let provider: String
    public let detail: String
    public let systemImage: String
    public var state: ModelRouteState

    public init(id: String, name: String, provider: String, detail: String, systemImage: String, state: ModelRouteState) {
        self.id = id
        self.name = name
        self.provider = provider
        self.detail = detail
        self.systemImage = systemImage
        self.state = state
    }

    public static let defaults: [ModelRoute] = [
        ModelRoute(id: "local", name: "Local Inference", provider: "elizaOS", detail: "On-device models for privacy-first work", systemImage: "macbook", state: .preferred),
        ModelRoute(id: "cloud-large", name: "Large Reasoning", provider: "Cloud", detail: "Hard planning, code, and research", systemImage: "cloud", state: .available),
        ModelRoute(id: "vision", name: "Vision", provider: "Cloud or local", detail: "Screen and image understanding", systemImage: "eye", state: .available),
        ModelRoute(id: "embedding", name: "Embeddings", provider: "Local", detail: "Memory and retrieval indexing", systemImage: "square.stack.3d.up", state: .preferred)
    ]
}
