import ElizaMacCore
import SwiftUI

struct ThemeCustomizationView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Form {
            Section("Presets") {
                HStack(spacing: 8) {
                    ForEach(ThemePreset.allCases) { preset in
                        Button(preset.title) {
                            model.applyThemePreset(preset)
                        }
                        .controlSize(.small)
                    }
                }
            }

            Section("Appearance") {
                Picker("Mode", selection: $model.theme.appearance) {
                    ForEach(ThemeAppearance.allCases) { appearance in
                        Text(appearance.title)
                            .tag(appearance)
                    }
                }
                .pickerStyle(.segmented)

                Picker("Glass", selection: $model.theme.glassVariant) {
                    ForEach(GlassVariant.allCases) { variant in
                        Text(variant.title)
                            .tag(variant)
                    }
                }
                .pickerStyle(.segmented)

                Toggle("Interactive glass", isOn: $model.theme.interactiveGlass)
            }

            Section("Color") {
                AccentPicker(accent: $model.theme.accent)
                ThemeSlider(title: "Color", value: $model.theme.colorIntensity)
                ThemeSlider(title: "Backdrop", value: $model.theme.backgroundVibrance)
            }

            Section("Material") {
                ThemeSlider(title: "Transparency", value: $model.theme.transparency)
                ThemeSlider(title: "Frost", value: $model.theme.frost)
            }

            Section("Preview") {
                ThemePreview(theme: model.theme)
                    .frame(height: 150)
            }
        }
        .formStyle(.grouped)
    }
}

private struct AccentPicker: View {
    @Binding var accent: ThemeAccent

    var body: some View {
        HStack(spacing: 10) {
            Text("Accent")
                .frame(width: 88, alignment: .leading)

            ForEach(ThemeAccent.allCases) { option in
                Button {
                    accent = option
                } label: {
                    Circle()
                        .fill(option.color)
                        .frame(width: 18, height: 18)
                        .overlay {
                            Circle()
                                .stroke(.primary.opacity(accent == option ? 0.8 : 0.18), lineWidth: accent == option ? 2 : 1)
                        }
                }
                .buttonStyle(.plain)
                .help(option.title)
            }
        }
    }
}

private struct ThemeSlider: View {
    let title: String
    @Binding var value: Double

    var body: some View {
        HStack {
            Text(title)
                .frame(width: 88, alignment: .leading)
            Slider(value: $value, in: 0...1, step: 0.05)
            Text(value, format: .percent.precision(.fractionLength(0)))
                .foregroundStyle(.secondary)
                .frame(width: 44, alignment: .trailing)
        }
    }
}

private struct ThemePreview: View {
    let theme: ThemeSettings

    var body: some View {
        ZStack {
            ThemedBackdrop(theme: theme)

            GlassEffectContainer {
                HStack(spacing: 14) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Liquid Glass")
                            .font(.headline)
                        Text("\(theme.accent.title), \(theme.glassVariant.title)")
                            .foregroundStyle(.secondary)
                    }

                    Spacer()

                    StatusPill(title: "Live", systemImage: "sparkles", tint: theme.accent.color)
                }
                .padding()
                .environment(\.elizaTheme, theme)
                .glassEffect(
                    theme.glassVariant.glass
                        .tint(theme.accent.color.opacity(theme.colorIntensity))
                        .interactive(theme.interactiveGlass),
                    in: RoundedRectangle(cornerRadius: 24, style: .continuous)
                )
            }
            .padding(18)
        }
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}
