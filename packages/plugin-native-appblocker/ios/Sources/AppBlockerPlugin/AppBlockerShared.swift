import FamilyControls
import Foundation
import ManagedSettings

struct AppBlockerStoredState: Codable {
    let tokenDataArray: [String]
    let endsAtEpochMs: Double?
}

enum AppBlockerShared {
    static let stateKey = "app_blocker_state_v1"
    static let store = ManagedSettingsStore()
    static let iso8601Formatter = ISO8601DateFormatter()

    static func serializeToken(_ token: ApplicationToken) -> String? {
        guard let data = try? JSONEncoder().encode(token) else {
            return nil
        }
        return data.base64EncodedString()
    }

    static func serializeSelection(_ tokens: Set<ApplicationToken>) -> [String] {
        tokens.compactMap(serializeToken).sorted()
    }

    static func deserializeTokens(_ tokenDataArray: [String]) -> Set<ApplicationToken> {
        var tokens = Set<ApplicationToken>()
        for tokenData in tokenDataArray {
            guard let data = Data(base64Encoded: tokenData),
                  let token = try? JSONDecoder().decode(ApplicationToken.self, from: data) else {
                continue
            }
            tokens.insert(token)
        }
        return tokens
    }

    static func loadState() -> AppBlockerStoredState? {
        guard let data = UserDefaults.standard.data(forKey: stateKey) else {
            return nil
        }

        guard let state = try? JSONDecoder().decode(AppBlockerStoredState.self, from: data) else {
            UserDefaults.standard.removeObject(forKey: stateKey)
            return nil
        }

        if let endsAtEpochMs = state.endsAtEpochMs,
           endsAtEpochMs <= Date().timeIntervalSince1970 * 1000 {
            UserDefaults.standard.removeObject(forKey: stateKey)
            return nil
        }

        if state.tokenDataArray.isEmpty {
            UserDefaults.standard.removeObject(forKey: stateKey)
            return nil
        }

        return state
    }

    static func saveState(tokenDataArray: [String], endsAtEpochMs: Double?) {
        let state = AppBlockerStoredState(
            tokenDataArray: tokenDataArray,
            endsAtEpochMs: endsAtEpochMs
        )
        guard let data = try? JSONEncoder().encode(state) else {
            return
        }
        UserDefaults.standard.set(data, forKey: stateKey)
    }

    static func clearState() {
        UserDefaults.standard.removeObject(forKey: stateKey)
    }

    static func endsAtString(for state: AppBlockerStoredState?) -> String? {
        guard let endsAtEpochMs = state?.endsAtEpochMs else {
            return nil
        }
        return iso8601Formatter.string(from: Date(timeIntervalSince1970: endsAtEpochMs / 1000))
    }

    static func applyShield(tokens: Set<ApplicationToken>) {
        store.shield.applications = tokens
    }

    static func clearShield() {
        store.shield.applications = nil
    }

    static func startBlock(tokens: Set<ApplicationToken>, endsAtEpochMs: Double? = nil) {
        let tokenDataArray = serializeSelection(tokens)
        saveState(tokenDataArray: tokenDataArray, endsAtEpochMs: endsAtEpochMs)
        applyShield(tokens: tokens)
    }

    static func stopBlock() {
        clearState()
        clearShield()
    }
}
