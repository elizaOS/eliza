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
        CapabilitySummary(id: "accessibility", title: "Accessibility", detail: "Computer-use control of mouse, keyboard, and app UI", systemImage: "cursorarrow.motionlines", state: .needsSetup),
        CapabilitySummary(id: "screen-recording", title: "Screen Capture", detail: "Required for computer-use workflows", systemImage: "rectangle.dashed", state: .needsSetup),
        CapabilitySummary(id: "microphone", title: "Microphone", detail: "Voice input and talk-mode capture", systemImage: "mic", state: .needsSetup),
        CapabilitySummary(id: "camera", title: "Camera", detail: "Video input for vision workflows", systemImage: "camera", state: .needsSetup),
        CapabilitySummary(id: "shell", title: "Shell Access", detail: "Execute local runtime and workspace commands", systemImage: "terminal", state: .ready),
        CapabilitySummary(id: "website-blocking", title: "Website Blocking", detail: "Hosts-file controls for focus workflows", systemImage: "shield.slash", state: .needsSetup),
        CapabilitySummary(id: "location", title: "Location", detail: "Place-aware planning and travel-time context", systemImage: "location", state: .needsSetup),
        CapabilitySummary(id: "reminders", title: "Apple Reminders", detail: "Create and update LifeOps reminders", systemImage: "list.bullet.clipboard", state: .needsSetup),
        CapabilitySummary(id: "calendar", title: "Apple Calendar", detail: "Native planning and event scheduling", systemImage: "calendar", state: .needsSetup),
        CapabilitySummary(id: "health", title: "Apple Health", detail: "Wellness and sleep signals from paired devices", systemImage: "heart.text.square", state: .needsSetup),
        CapabilitySummary(id: "screentime", title: "Screen Time", detail: "App-usage and focus signals", systemImage: "hourglass", state: .needsSetup),
        CapabilitySummary(id: "contacts", title: "Contacts", detail: "Name resolution for messaging workflows", systemImage: "person.crop.circle.badge", state: .needsSetup),
        CapabilitySummary(id: "notes", title: "Apple Notes", detail: "Create and read notes through approved automation", systemImage: "note.text", state: .needsSetup),
        CapabilitySummary(id: "keychain", title: "Keychain", detail: "Credential storage", systemImage: "key", state: .ready),
        CapabilitySummary(id: "notifications", title: "Notifications", detail: "Agent alerts and approvals", systemImage: "bell", state: .needsSetup),
        CapabilitySummary(id: "full-disk", title: "Full Disk Access", detail: "Protected local app data when explicitly enabled", systemImage: "externaldrive.badge.checkmark", state: .needsSetup),
        CapabilitySummary(id: "automation", title: "Automation", detail: "Apple Events control for Finder, Terminal, Notes, and Messages", systemImage: "point.3.connected.trianglepath.dotted", state: .needsSetup)
    ]
}
