import ElizaMacCore
import SwiftUI

extension ThemeAppearance {
    var preferredColorScheme: ColorScheme? {
        switch self {
        case .system:
            nil
        case .light:
            .light
        case .dark:
            .dark
        }
    }
}

extension ThemeAccent {
    var color: Color {
        switch self {
        case .blue:
            .blue
        case .cyan:
            .cyan
        case .mint:
            .mint
        case .green:
            .green
        case .orange:
            .orange
        case .pink:
            .pink
        case .purple:
            .purple
        case .graphite:
            .gray
        }
    }

    var secondaryColor: Color {
        switch self {
        case .blue:
            .cyan
        case .cyan:
            .mint
        case .mint:
            .green
        case .green:
            .mint
        case .orange:
            .pink
        case .pink:
            .purple
        case .purple:
            .pink
        case .graphite:
            .secondary
        }
    }

    var tertiaryColor: Color {
        switch self {
        case .blue:
            .mint
        case .cyan:
            .blue
        case .mint:
            .cyan
        case .green:
            .blue
        case .orange:
            .purple
        case .pink:
            .orange
        case .purple:
            .cyan
        case .graphite:
            .gray.opacity(0.62)
        }
    }
}

extension GlassVariant {
    var glass: Glass {
        switch self {
        case .regular:
            .regular
        case .clear:
            .clear
        }
    }
}

private struct ElizaThemeKey: EnvironmentKey {
    static let defaultValue = ThemeSettings.default
}

extension EnvironmentValues {
    var elizaTheme: ThemeSettings {
        get { self[ElizaThemeKey.self] }
        set { self[ElizaThemeKey.self] = newValue }
    }
}

extension ThemeSettings {
    var primaryTint: Color {
        accent.color
    }

    var secondaryTint: Color {
        accent.secondaryColor
    }

    var tertiaryTint: Color {
        accent.tertiaryColor
    }

    var destructiveTint: Color {
        .red
    }

    var warningTint: Color {
        .orange
    }
}

struct ThemedBackdrop: View {
    let theme: ThemeSettings

    var body: some View {
        ZStack {
            Rectangle()
                .fill(.background)

            LinearGradient(
                colors: [
                    theme.accent.color.opacity(0.08 + theme.backgroundVibrance * 0.18),
                    Color.secondary.opacity(0.04 + theme.backgroundVibrance * 0.08),
                    Color.clear
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        }
    }
}
