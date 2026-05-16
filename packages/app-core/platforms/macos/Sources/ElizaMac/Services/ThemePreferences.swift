import ElizaMacCore
import Foundation

enum ThemePreferences {
    private static let key = "ai.eliza.mac.theme"

    static func load(defaults: UserDefaults = .standard) -> ThemeSettings {
        guard let data = defaults.data(forKey: key) else {
            return .default
        }

        do {
            return try JSONDecoder().decode(ThemeSettings.self, from: data).normalized()
        } catch {
            defaults.removeObject(forKey: key)
            return .default
        }
    }

    static func save(_ theme: ThemeSettings, defaults: UserDefaults = .standard) {
        do {
            let data = try JSONEncoder().encode(theme.normalized())
            defaults.set(data, forKey: key)
        } catch {
            defaults.removeObject(forKey: key)
        }
    }
}
