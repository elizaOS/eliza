import ElizaMacCore
import SwiftUI

struct FeatureCard: View {
    let feature: ShellFeature
    var actionTitle: String?
    var action: (() -> Void)?
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: feature.systemImage)
                        .font(.title2)
                        .foregroundStyle(tint)
                        .frame(width: 28)

                    VStack(alignment: .leading, spacing: 5) {
                        Text(feature.title)
                            .font(.headline)
                        Text(feature.detail)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer()

                    StatusPill(title: feature.state.title, systemImage: "circle.fill", tint: tint)
                }

                if let actionTitle, let action {
                    Button(action: action) {
                        Label(actionTitle, systemImage: "arrow.right.circle")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.bordered)
                    .tint(tint)
                }
            }
        }
    }

    private var tint: Color {
        switch feature.state {
        case .live:
            theme.primaryTint
        case .ready:
            theme.secondaryTint
        case .needsSetup:
            theme.warningTint
        case .planned:
            theme.tertiaryTint
        case .warning:
            theme.warningTint
        case .blocked:
            theme.destructiveTint
        }
    }
}
