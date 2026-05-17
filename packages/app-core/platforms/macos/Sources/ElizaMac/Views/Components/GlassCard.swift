import ElizaMacCore
import SwiftUI

struct GlassCard<Content: View>: View {
    let spacing: CGFloat
    let content: Content
    @Environment(\.elizaTheme) private var theme

    init(spacing: CGFloat = 14, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.content = content()
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        let accent = theme.accent.color
        let glass = theme.glassVariant.glass
            .tint(accent.opacity(theme.colorIntensity))
            .interactive(theme.interactiveGlass)
        let frostOpacity = (0.08 + theme.frost * 0.42) * (1 - theme.transparency * 0.55)

        content
            .padding(spacing)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                shape
                    .fill(.regularMaterial)
                    .opacity(frostOpacity)
            }
            .overlay {
                shape
                    .stroke(accent.opacity(0.08 + theme.colorIntensity * 0.18), lineWidth: 1)
            }
            .glassEffect(glass, in: shape)
    }
}
