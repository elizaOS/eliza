public enum CapabilityState: String, CaseIterable, Codable, Equatable, Sendable {
    case ready
    case needsSetup
    case unavailable

    public var title: String {
        switch self {
        case .ready:
            "Ready"
        case .needsSetup:
            "Setup"
        case .unavailable:
            "Unavailable"
        }
    }
}

public struct CapabilitySummary: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let detail: String
    public let systemImage: String
    public var state: CapabilityState

    public init(id: String, title: String, detail: String, systemImage: String, state: CapabilityState) {
        self.id = id
        self.title = title
        self.detail = detail
        self.systemImage = systemImage
        self.state = state
    }

    public static let defaults: [CapabilitySummary] = [
        CapabilitySummary(id: "local-runtime", title: "Local Runtime", detail: "Bun-backed elizaOS process", systemImage: "terminal", state: .ready),
        CapabilitySummary(id: "apple-silicon", title: "Apple Silicon", detail: "Optimized for modern Macs", systemImage: "cpu", state: .ready),
        CapabilitySummary(id: "screen-recording", title: "Screen Capture", detail: "Required for computer-use workflows", systemImage: "rectangle.dashed", state: .needsSetup),
        CapabilitySummary(id: "calendar", title: "Calendar", detail: "Native planning and reminders", systemImage: "calendar", state: .needsSetup),
        CapabilitySummary(id: "keychain", title: "Keychain", detail: "Credential storage", systemImage: "key", state: .ready),
        CapabilitySummary(id: "notifications", title: "Notifications", detail: "Agent alerts and approvals", systemImage: "bell", state: .needsSetup)
    ]
}
