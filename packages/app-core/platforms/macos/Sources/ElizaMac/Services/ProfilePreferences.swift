import ElizaMacCore
import Foundation

enum ProfilePreferences {
    private static let key = "ai.eliza.mac.profile"

    static func load(defaults: UserDefaults = .standard) -> UserProfile {
        guard let data = defaults.data(forKey: key) else {
            return .anonymous
        }

        do {
            return try JSONDecoder().decode(UserProfile.self, from: data)
        } catch {
            defaults.removeObject(forKey: key)
            return .anonymous
        }
    }

    static func save(_ profile: UserProfile, defaults: UserDefaults = .standard) {
        do {
            let data = try JSONEncoder().encode(profile)
            defaults.set(data, forKey: key)
        } catch {
            defaults.removeObject(forKey: key)
        }
    }
}
