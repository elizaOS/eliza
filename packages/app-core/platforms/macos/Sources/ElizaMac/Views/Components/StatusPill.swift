import SwiftUI

struct StatusPill: View {
    let title: String
    let systemImage: String
    let tint: Color
    @Environment(\.elizaTheme) private var theme

    var body: some View {
        Label(title, systemImage: systemImage)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .glassEffect(
                theme.glassVariant.glass
                    .tint(tint.opacity(0.18 + theme.colorIntensity * 0.32))
                    .interactive(theme.interactiveGlass),
                in: Capsule()
            )
    }
}
