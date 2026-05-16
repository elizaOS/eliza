@testable import ElizaMacCore
import XCTest

final class ThemeSettingsTests: XCTestCase {
    func testThemeValuesAreClamped() {
        let theme = ThemeSettings(
            appearance: .system,
            accent: .blue,
            glassVariant: .regular,
            transparency: 2,
            frost: -1,
            colorIntensity: 1.4,
            backgroundVibrance: -0.4,
            interactiveGlass: true
        )

        XCTAssertEqual(theme.transparency, 1)
        XCTAssertEqual(theme.frost, 0)
        XCTAssertEqual(theme.colorIntensity, 1)
        XCTAssertEqual(theme.backgroundVibrance, 0)
    }

    func testPresetsCoverAllThemePresets() {
        for preset in ThemePreset.allCases {
            let theme = ThemeSettings.preset(preset)

            XCTAssertGreaterThanOrEqual(theme.transparency, 0)
            XCTAssertLessThanOrEqual(theme.transparency, 1)
            XCTAssertGreaterThanOrEqual(theme.frost, 0)
            XCTAssertLessThanOrEqual(theme.frost, 1)
        }
    }
}
