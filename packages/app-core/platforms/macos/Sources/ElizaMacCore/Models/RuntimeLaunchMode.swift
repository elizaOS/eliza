public enum RuntimeLaunchMode: String, CaseIterable, Codable, Hashable, Identifiable, Sendable {
    case local
    case external
    case disabled

    public var id: String {
        rawValue
    }

    public var title: String {
        switch self {
        case .local:
            "Local"
        case .external:
            "External"
        case .disabled:
            "Disabled"
        }
    }
}
