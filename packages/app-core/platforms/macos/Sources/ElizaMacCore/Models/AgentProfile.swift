public enum AgentState: String, CaseIterable, Codable, Equatable, Sendable {
    case active
    case paused
    case draft

    public var title: String {
        switch self {
        case .active:
            "Active"
        case .paused:
            "Paused"
        case .draft:
            "Draft"
        }
    }
}

public struct AgentProfile: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let role: String
    public let model: String
    public let systemImage: String
    public var state: AgentState

    public init(id: String, name: String, role: String, model: String, systemImage: String, state: AgentState) {
        self.id = id
        self.name = name
        self.role = role
        self.model = model
        self.systemImage = systemImage
        self.state = state
    }

    public static let defaults: [AgentProfile] = [
        AgentProfile(id: "operator", name: "Operator", role: "Runs local workflows and approvals", model: "Local or cloud route", systemImage: "person.crop.circle.badge.checkmark", state: .active),
        AgentProfile(id: "research", name: "Research", role: "Reads docs, repos, and context", model: "Long-context route", systemImage: "book.pages", state: .draft),
        AgentProfile(id: "computer-use", name: "Computer Use", role: "Controls apps with permission", model: "Vision-capable route", systemImage: "cursorarrow.rays", state: .paused),
        AgentProfile(id: "lifeops", name: "LifeOps", role: "Schedules tasks and reminders", model: "Planning route", systemImage: "calendar.badge.clock", state: .draft)
    ]
}
