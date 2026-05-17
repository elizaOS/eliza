public enum SettingsPane: String, CaseIterable, Identifiable, Sendable {
    case account
    case appearance
    case runtime
    case shell
    case privacy

    public var id: String {
        rawValue
    }

    public var title: String {
        switch self {
        case .account:
            "Account"
        case .appearance:
            "Appearance"
        case .runtime:
            "Runtime"
        case .shell:
            "Shell"
        case .privacy:
            "Privacy"
        }
    }

    public var systemImage: String {
        switch self {
        case .account:
            "person.crop.circle"
        case .appearance:
            "paintpalette"
        case .runtime:
            "terminal"
        case .shell:
            "macwindow"
        case .privacy:
            "hand.raised"
        }
    }
}
