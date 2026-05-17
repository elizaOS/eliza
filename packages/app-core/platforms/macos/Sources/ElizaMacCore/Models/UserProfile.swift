import Foundation

public struct UserProfile: Codable, Equatable, Sendable {
    public var displayName: String

    public init(displayName: String = "") {
        self.displayName = Self.normalizedName(displayName)
    }

    public static let anonymous = UserProfile()

    public var hasDisplayName: Bool {
        !displayName.isEmpty
    }

    public static func normalizedName(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let collapsed = trimmed
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        return String(collapsed.prefix(64))
    }
}
