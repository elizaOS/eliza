public enum DiagnosticSeverity: String, CaseIterable, Codable, Equatable, Sendable {
    case info
    case warning
    case critical

    public var title: String {
        switch self {
        case .info:
            "Info"
        case .warning:
            "Warning"
        case .critical:
            "Critical"
        }
    }
}

public struct DiagnosticItem: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let detail: String
    public let systemImage: String
    public let severity: DiagnosticSeverity

    public init(id: String, title: String, detail: String, systemImage: String, severity: DiagnosticSeverity) {
        self.id = id
        self.title = title
        self.detail = detail
        self.systemImage = systemImage
        self.severity = severity
    }

    public static let defaults: [DiagnosticItem] = [
        DiagnosticItem(id: "repo", title: "Repository", detail: "elizaOS workspace detected", systemImage: "checkmark.seal", severity: .info),
        DiagnosticItem(id: "permissions", title: "Permissions", detail: "Screen Recording and Calendar should be reviewed before computer-use workflows", systemImage: "hand.raised", severity: .warning),
        DiagnosticItem(id: "runtime", title: "Runtime", detail: "Local runtime command is configured", systemImage: "terminal", severity: .info)
    ]
}
