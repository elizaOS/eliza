public enum ConnectorState: String, CaseIterable, Codable, Equatable, Sendable {
    case connected
    case available
    case blocked

    public var title: String {
        switch self {
        case .connected:
            "Connected"
        case .available:
            "Available"
        case .blocked:
            "Blocked"
        }
    }
}

public struct ConnectorProfile: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let detail: String
    public let systemImage: String
    public var state: ConnectorState

    public init(id: String, name: String, detail: String, systemImage: String, state: ConnectorState) {
        self.id = id
        self.name = name
        self.detail = detail
        self.systemImage = systemImage
        self.state = state
    }

    public static let defaults: [ConnectorProfile] = [
        ConnectorProfile(id: "chat", name: "Chat", detail: "Local UI and API conversations", systemImage: "bubble.left.and.bubble.right", state: .connected),
        ConnectorProfile(id: "browser", name: "Browser", detail: "Web browsing and page context", systemImage: "safari", state: .available),
        ConnectorProfile(id: "calendar", name: "Calendar", detail: "Events, reminders, and schedules", systemImage: "calendar", state: .available),
        ConnectorProfile(id: "filesystem", name: "Files", detail: "Workspace documents and projects", systemImage: "folder", state: .available),
        ConnectorProfile(id: "screen", name: "Screen", detail: "Computer-use screenshots", systemImage: "display", state: .blocked),
        ConnectorProfile(id: "notifications", name: "Notifications", detail: "Native alerts and confirmations", systemImage: "bell.badge", state: .available)
    ]
}
