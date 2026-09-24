import Foundation

/// Cross-process handoff record for keyboard dictation (issue #12185, sub 3).
/// Compiled into BOTH the App target (where `ElizaKeyboardBridge` writes the
/// record as the app-side recording/ASR session progresses) and the
/// ElizaKeyboard extension (which polls the record and inserts the transcript
/// via `textDocumentProxy`). The App Group `UserDefaults` suite is the only
/// channel between the two processes: no iOS app extension may access the
/// microphone, so the keyboard's mic button opens the containing app to record
/// and this record carries the result back (the Wispr pattern).
///
/// The status is explicit at every stage (`recording` → `transcribing` →
/// `ready` | `error`) so the keyboard always renders a real user-facing state —
/// an engine-not-running or ASR failure surfaces as `error` with a message,
/// never as a silently empty keyboard.
enum ElizaKeyboardDictationState {
    enum Status: String, Codable {
        case recording
        case transcribing
        case ready
        case error
    }

    struct Record: Codable {
        var status: Status
        var transcript: String?
        var errorMessage: String?
        var sessionId: String?
        var updatedAtEpochMs: Double
    }

    enum StoreError: Error, LocalizedError {
        case appGroupUnavailable(String)

        var errorDescription: String? {
            switch self {
            case .appGroupUnavailable(let group):
                return "App Group \(group) is unavailable"
            }
        }
    }

    static let storeKey = "keyboard_dictation_state_v1"

    // Records older than this are an abandoned session; the keyboard discards
    // them on read instead of inserting stale text.
    static let freshnessWindowMs: Double = 10 * 60 * 1000

    /// `group.<app-bundle-id>`, derived at runtime by stripping this process's
    /// own `.ElizaKeyboard` suffix when present — the same convention
    /// `WebsiteBlockerContentExtension` uses, so the per-brand app-group
    /// rewrite (`replaceIosAppGroupPlaceholders`) needs no code changes.
    static var appGroupIdentifier: String {
        guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
            return "group.ai.elizaos.app"
        }
        let extensionSuffix = ".ElizaKeyboard"
        let appBundleIdentifier = bundleIdentifier.hasSuffix(extensionSuffix)
            ? String(bundleIdentifier.dropLast(extensionSuffix.count))
            : bundleIdentifier
        return "group.\(appBundleIdentifier)"
    }

    static func sharedDefaults() -> UserDefaults? {
        UserDefaults(suiteName: appGroupIdentifier)
    }

    static func save(_ record: Record) throws {
        guard let defaults = sharedDefaults() else {
            throw StoreError.appGroupUnavailable(appGroupIdentifier)
        }
        let data = try JSONEncoder().encode(record)
        defaults.set(data, forKey: storeKey)
    }

    static func load() -> Record? {
        guard let defaults = sharedDefaults(),
              let data = defaults.data(forKey: storeKey),
              let record = try? JSONDecoder().decode(Record.self, from: data)
        else {
            return nil
        }
        return record
    }

    static func clear() {
        sharedDefaults()?.removeObject(forKey: storeKey)
    }

    static func isFresh(_ record: Record, now: Date = Date()) -> Bool {
        now.timeIntervalSince1970 * 1000 - record.updatedAtEpochMs
            < freshnessWindowMs
    }
}
