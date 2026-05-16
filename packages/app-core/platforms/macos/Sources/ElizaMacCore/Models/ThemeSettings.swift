public enum ThemeAppearance: String, CaseIterable, Codable, Hashable, Identifiable, Sendable {
    case system
    case light
    case dark

    public var id: String {
        rawValue
    }

    public var title: String {
        switch self {
        case .system:
            "System"
        case .light:
            "Light"
        case .dark:
            "Dark"
        }
    }
}

public enum ThemeAccent: String, CaseIterable, Codable, Hashable, Identifiable, Sendable {
    case blue
    case cyan
    case mint
    case green
    case orange
    case pink
    case purple
    case graphite

    public var id: String {
        rawValue
    }

    public var title: String {
        switch self {
        case .blue:
            "Blue"
        case .cyan:
            "Cyan"
        case .mint:
            "Mint"
        case .green:
            "Green"
        case .orange:
            "Orange"
        case .pink:
            "Pink"
        case .purple:
            "Purple"
        case .graphite:
            "Graphite"
        }
    }
}

public enum GlassVariant: String, CaseIterable, Codable, Hashable, Identifiable, Sendable {
    case regular
    case clear

    public var id: String {
        rawValue
    }

    public var title: String {
        switch self {
        case .regular:
            "Regular"
        case .clear:
            "Clear"
        }
    }
}

public enum ThemePreset: String, CaseIterable, Hashable, Identifiable, Sendable {
    case appleDefault
    case aurora
    case graphite
    case studio
    case nightOps

    public var id: String {
        rawValue
    }

    public var title: String {
        switch self {
        case .appleDefault:
            "Apple Default"
        case .aurora:
            "Aurora"
        case .graphite:
            "Graphite"
        case .studio:
            "Studio"
        case .nightOps:
            "Night Ops"
        }
    }
}

public struct ThemeSettings: Codable, Equatable, Sendable {
    public var appearance: ThemeAppearance
    public var accent: ThemeAccent
    public var glassVariant: GlassVariant
    public var transparency: Double
    public var frost: Double
    public var colorIntensity: Double
    public var backgroundVibrance: Double
    public var interactiveGlass: Bool

    public init(
        appearance: ThemeAppearance,
        accent: ThemeAccent,
        glassVariant: GlassVariant,
        transparency: Double,
        frost: Double,
        colorIntensity: Double,
        backgroundVibrance: Double,
        interactiveGlass: Bool
    ) {
        self.appearance = appearance
        self.accent = accent
        self.glassVariant = glassVariant
        self.transparency = Self.clamp(transparency)
        self.frost = Self.clamp(frost)
        self.colorIntensity = Self.clamp(colorIntensity)
        self.backgroundVibrance = Self.clamp(backgroundVibrance)
        self.interactiveGlass = interactiveGlass
    }

    public static let `default` = ThemeSettings(
        appearance: .system,
        accent: .blue,
        glassVariant: .regular,
        transparency: 0.42,
        frost: 0.58,
        colorIntensity: 0.18,
        backgroundVibrance: 0.38,
        interactiveGlass: true
    )

    public static func preset(_ preset: ThemePreset) -> ThemeSettings {
        switch preset {
        case .appleDefault:
            .default
        case .aurora:
            ThemeSettings(appearance: .system, accent: .cyan, glassVariant: .regular, transparency: 0.48, frost: 0.52, colorIntensity: 0.28, backgroundVibrance: 0.68, interactiveGlass: true)
        case .graphite:
            ThemeSettings(appearance: .system, accent: .graphite, glassVariant: .regular, transparency: 0.34, frost: 0.7, colorIntensity: 0.08, backgroundVibrance: 0.18, interactiveGlass: true)
        case .studio:
            ThemeSettings(appearance: .light, accent: .purple, glassVariant: .clear, transparency: 0.56, frost: 0.44, colorIntensity: 0.2, backgroundVibrance: 0.5, interactiveGlass: true)
        case .nightOps:
            ThemeSettings(appearance: .dark, accent: .mint, glassVariant: .regular, transparency: 0.4, frost: 0.64, colorIntensity: 0.22, backgroundVibrance: 0.42, interactiveGlass: true)
        }
    }

    public func normalized() -> ThemeSettings {
        ThemeSettings(
            appearance: appearance,
            accent: accent,
            glassVariant: glassVariant,
            transparency: transparency,
            frost: frost,
            colorIntensity: colorIntensity,
            backgroundVibrance: backgroundVibrance,
            interactiveGlass: interactiveGlass
        )
    }

    private static func clamp(_ value: Double) -> Double {
        min(max(value, 0), 1)
    }
}
