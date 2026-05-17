import ElizaMacCore
import SwiftUI

struct FirstRunNameView: View {
    @ObservedObject var model: AppModel
    @Environment(\.elizaTheme) private var theme
    @FocusState private var nameFieldFocused: Bool
    @State private var animateOrbs = false

    var body: some View {
        ZStack {
            Color.clear

            GlowingOrb(color: theme.primaryTint, size: 360, blur: 34, intensity: orbIntensity)
                .offset(x: animateOrbs ? -320 : -250, y: animateOrbs ? -230 : -170)
                .opacity(animateOrbs ? 1 : 0)
                .animation(.easeInOut(duration: 5.5).repeatForever(autoreverses: true), value: animateOrbs)

            GlowingOrb(color: theme.secondaryTint, size: 430, blur: 42, intensity: orbIntensity)
                .offset(x: animateOrbs ? 330 : 260, y: animateOrbs ? -120 : -190)
                .opacity(animateOrbs ? 1 : 0)
                .animation(.easeInOut(duration: 6.2).repeatForever(autoreverses: true), value: animateOrbs)

            GlowingOrb(color: theme.tertiaryTint, size: 300, blur: 28, intensity: orbIntensity)
                .offset(x: animateOrbs ? 190 : 120, y: animateOrbs ? 230 : 180)
                .opacity(animateOrbs ? 1 : 0)
                .animation(.easeInOut(duration: 5.8).repeatForever(autoreverses: true), value: animateOrbs)

            GlowingOrb(color: theme.primaryTint, size: 260, blur: 26, intensity: orbIntensity * 0.78)
                .offset(x: animateOrbs ? -210 : -280, y: animateOrbs ? 190 : 250)
                .opacity(animateOrbs ? 1 : 0)
                .animation(.easeInOut(duration: 6.6).repeatForever(autoreverses: true), value: animateOrbs)

            VStack(spacing: 30) {
                VStack(spacing: 10) {
                    Text("Hi, I'm Eliza.")
                        .font(.system(size: 34, weight: .semibold, design: .rounded))
                        .foregroundStyle(promptTextColor.opacity(0.86))
                        .shadow(color: textShadowColor, radius: 14, y: 4)

                    Text("What should I call you?")
                        .font(.system(size: 64, weight: .bold, design: .rounded))
                        .foregroundStyle(promptTextColor)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .minimumScaleFactor(0.7)
                        .shadow(color: textShadowColor, radius: 18, y: 6)
                }

                TextField(
                    "",
                    text: $model.nameDraft,
                    prompt: Text("your name").foregroundStyle(promptTextColor.opacity(0.34))
                )
                .textFieldStyle(.plain)
                .font(.system(size: 84, weight: .bold, design: .rounded))
                .foregroundStyle(promptTextColor)
                .multilineTextAlignment(.center)
                .shadow(color: textShadowColor, radius: 16, y: 5)
                .focused($nameFieldFocused)
                .onSubmit {
                    model.completeNameOnboarding()
                }
                .frame(maxWidth: 900)

                Button {
                    model.completeNameOnboarding()
                } label: {
                    Label("Continue", systemImage: "arrow.right.circle.fill")
                        .font(.title3.weight(.semibold))
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(theme.primaryTint)
                .disabled(UserProfile.normalizedName(model.nameDraft).isEmpty)
            }
            .padding(.horizontal, 64)
        }
        .frame(minWidth: 980, minHeight: 640)
        .containerBackground(.clear, for: .window)
        .background(WindowTransparencyBridge(isTransparent: true))
        .onAppear {
            animateOrbs = true
            nameFieldFocused = true
        }
    }

    private var orbIntensity: Double {
        0.48 + theme.backgroundVibrance * 0.34 + theme.colorIntensity * 0.18
    }

    private var promptTextColor: Color {
        .white
    }

    private var textShadowColor: Color {
        .black.opacity(0.24 + theme.frost * 0.18)
    }
}

private struct GlowingOrb: View {
    let color: Color
    let size: CGFloat
    let blur: CGFloat
    let intensity: Double
    @State private var breathing = false

    var body: some View {
        let boundedIntensity = min(max(intensity, 0), 1)

        Circle()
            .fill(
                RadialGradient(
                    colors: [
                        color.opacity(0.52 + boundedIntensity * 0.36),
                        color.opacity(0.18 + boundedIntensity * 0.22),
                        color.opacity(0.04 + boundedIntensity * 0.08),
                        .clear
                    ],
                    center: .center,
                    startRadius: 0,
                    endRadius: size * 0.5
                )
            )
            .frame(width: size, height: size)
            .blur(radius: blur)
            .scaleEffect(breathing ? 1.18 : 0.88)
            .opacity(breathing ? 0.58 + boundedIntensity * 0.28 : 0.36 + boundedIntensity * 0.22)
            .animation(.easeInOut(duration: 4.2).repeatForever(autoreverses: true), value: breathing)
            .onAppear {
                breathing = true
            }
            .allowsHitTesting(false)
    }
}
