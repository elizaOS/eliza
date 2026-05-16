public struct ShellMetric: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let value: String
    public let detail: String
    public let systemImage: String

    public init(id: String, title: String, value: String, detail: String, systemImage: String) {
        self.id = id
        self.title = title
        self.value = value
        self.detail = detail
        self.systemImage = systemImage
    }
}
