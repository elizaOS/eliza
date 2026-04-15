import Foundation
import FamilyControls
import ManagedSettings

public final class AppBlockerShared {
    static let stateKey = "app_blocker_state_v1"

    // MARK: - Stored State

    struct StoredState: Codable {
        var tokenDataArray: [String]   // base64-encoded ApplicationToken data
        var endsAtEpochMs: Double?
    }

    // MARK: - ManagedSettingsStore

    static var store: ManagedSettingsStore {
        if #available(iOS 16.0, *) {
            return ManagedSettingsStore(named: .init("elizaAppBlocker"))
        }
        return ManagedSettingsStore()
    }

    // MARK: - Token Serialization

    static func serializeSelection(_ selection: FamilyActivitySelection) -> [String] {
        var result: [String] = []
        for token in selection.applicationTokens {
            if let data = try? JSONEncoder().encode(token) {
                result.append(data.base64EncodedString())
            }
        }
        return result
    }

    static func deserializeTokens(_ base64Array: [String]) -> Set<ApplicationToken> {
        var tokens = Set<ApplicationToken>()
        for base64 in base64Array {
            guard let data = Data(base64Encoded: base64),
                  let token = try? JSONDecoder().decode(ApplicationToken.self, from: data) else {
                continue
            }
            tokens.insert(token)
        }
        return tokens
    }

    // MARK: - State Persistence

    static func loadState() -> StoredState? {
        guard let data = UserDefaults.standard.data(forKey: stateKey),
              var state = try? JSONDecoder().decode(StoredState.self, from: data) else {
            return nil
        }
        // Auto-expire
        if let endsAt = state.endsAtEpochMs, endsAt <= Double(Date().timeIntervalSince1970 * 1000) {
            clearState()
            return nil
        }
        return state
    }

    static func saveState(_ state: StoredState) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        UserDefaults.standard.set(data, forKey: stateKey)
    }

    static func clearState() {
        UserDefaults.standard.removeObject(forKey: stateKey)
    }

    // MARK: - Shield Management

    static func applyShield(tokens: Set<ApplicationToken>) {
        store.shield.applications = tokens
    }

    static func clearShield() {
        store.shield.applications = nil
    }

    // MARK: - High-Level Operations

    static func startBlock(tokenDataArray: [String], durationMinutes: Double?) -> (success: Bool, endsAt: String?) {
        let tokens = deserializeTokens(tokenDataArray)
        guard !tokens.isEmpty else {
            return (false, nil)
        }

        var endsAtEpochMs: Double? = nil
        var endsAtISO: String? = nil
        if let minutes = durationMinutes, minutes > 0 {
            let endsAtDate = Date().addingTimeInterval(minutes * 60)
            endsAtEpochMs = endsAtDate.timeIntervalSince1970 * 1000
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            endsAtISO = formatter.string(from: endsAtDate)
        }

        let state = StoredState(tokenDataArray: tokenDataArray, endsAtEpochMs: endsAtEpochMs)
        saveState(state)
        applyShield(tokens: tokens)

        return (true, endsAtISO)
    }

    static func stopBlock() {
        clearShield()
        clearState()
    }
}
