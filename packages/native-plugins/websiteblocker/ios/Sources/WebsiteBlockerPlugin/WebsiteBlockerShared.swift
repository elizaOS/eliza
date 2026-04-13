import Foundation
import SafariServices

struct WebsiteBlockerStoredState: Codable {
    let websites: [String]
    let endsAtEpochMs: Double?
}

enum WebsiteBlockerShared {
    static let appGroupIdentifier = "group.com.elizaos.eliza"
    static let contentBlockerIdentifier = "com.elizaos.eliza.WebsiteBlockerContentExtension"
    static let stateKey = "website_blocker_state_v1"
    static let iso8601Formatter = ISO8601DateFormatter()

    static func normalizeHostname(_ value: String) -> String? {
        let trimmed = value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
            .lowercased()
        guard !trimmed.isEmpty else {
            return nil
        }
        guard trimmed.contains(".") else {
            return nil
        }
        guard trimmed.range(of: "^[a-z0-9.-]+$", options: .regularExpression) != nil else {
            return nil
        }
        guard !trimmed.hasPrefix("."), !trimmed.hasSuffix(".") else {
            return nil
        }
        return trimmed
    }

    static func parseWebsites(explicit: [Any], text: String?) -> [String] {
        var websites: [String] = []
        for value in explicit {
            if let hostname = value as? String,
               let normalized = normalizeHostname(hostname) {
                websites.append(normalized)
            }
        }

        if let text, !text.isEmpty {
            let parts = text.components(separatedBy: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ",")))
            for part in parts {
                if let normalized = normalizeHostname(part) {
                    websites.append(normalized)
                }
            }
        }

        return Array(Set(websites)).sorted()
    }

    static func parseDurationMinutes(_ rawDuration: Any?) -> Int? {
        switch rawDuration {
        case let value as NSNumber:
            let minutes = value.intValue
            return minutes > 0 ? minutes : nil
        case let value as String:
            guard let minutes = Int(value), minutes > 0 else {
                return nil
            }
            return minutes
        default:
            return nil
        }
    }

    static func sharedDefaults() -> UserDefaults? {
        UserDefaults(suiteName: appGroupIdentifier)
    }

    static func loadState() -> WebsiteBlockerStoredState? {
        guard let defaults = sharedDefaults(),
              let data = defaults.data(forKey: stateKey) else {
            return nil
        }

        guard let decoded = try? JSONDecoder().decode(WebsiteBlockerStoredState.self, from: data) else {
            defaults.removeObject(forKey: stateKey)
            return nil
        }

        if let endsAtEpochMs = decoded.endsAtEpochMs,
           endsAtEpochMs <= Date().timeIntervalSince1970 * 1000 {
            defaults.removeObject(forKey: stateKey)
            return nil
        }

        if decoded.websites.isEmpty {
            defaults.removeObject(forKey: stateKey)
            return nil
        }

        return decoded
    }

    static func saveState(websites: [String], durationMinutes: Int?) throws -> WebsiteBlockerStoredState {
        let normalized = Array(Set(websites.compactMap(normalizeHostname))).sorted()
        let endsAtEpochMs = durationMinutes.map { Date().timeIntervalSince1970 * 1000 + Double($0 * 60_000) }
        let state = WebsiteBlockerStoredState(
            websites: normalized,
            endsAtEpochMs: endsAtEpochMs
        )

        guard let defaults = sharedDefaults() else {
            throw NSError(
                domain: "ElizaWebsiteBlocker",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "The iPhone website blocker app group is not available in this build."]
            )
        }

        let encoded = try JSONEncoder().encode(state)
        defaults.set(encoded, forKey: stateKey)
        return state
    }

    static func clearState() {
        sharedDefaults()?.removeObject(forKey: stateKey)
    }

    static func endsAtString(for state: WebsiteBlockerStoredState?) -> String? {
        guard let endsAtEpochMs = state?.endsAtEpochMs else {
            return nil
        }
        return iso8601Formatter.string(from: Date(timeIntervalSince1970: endsAtEpochMs / 1000))
    }

    static func buildContentBlockerRules(for websites: [String]) -> [[String: Any]] {
        websites.compactMap { website in
            guard let normalized = normalizeHostname(website) else {
                return nil
            }

            return [
                "trigger": [
                    "url-filter": "^https?://([A-Za-z0-9-]+\\\\.)*\(NSRegularExpression.escapedPattern(for: normalized))([/:?#]|$)",
                ],
                "action": [
                    "type": "block",
                ],
            ]
        }
    }

    static func writeRulesFile() throws -> URL {
        let websites = loadState()?.websites ?? []
        let rules = buildContentBlockerRules(for: websites)
        let data = try JSONSerialization.data(withJSONObject: rules, options: [])
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("eliza-website-blocker-rules", isDirectory: true)
            .appendingPathComponent("blockerList.json")
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: nil
        )
        try data.write(to: url, options: .atomic)
        return url
    }

    static func contentBlockerState() async throws -> SFContentBlockerState {
        try await withCheckedThrowingContinuation { continuation in
            SFContentBlockerManager.getStateOfContentBlocker(withIdentifier: contentBlockerIdentifier) { state, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard let state else {
                    continuation.resume(
                        throwing: NSError(
                            domain: "ElizaWebsiteBlocker",
                            code: 2,
                            userInfo: [NSLocalizedDescriptionKey: "Safari did not return the Website Blocker extension state."]
                        )
                    )
                    return
                }
                continuation.resume(returning: state)
            }
        }
    }

    static func reloadContentBlocker() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            SFContentBlockerManager.reloadContentBlocker(withIdentifier: contentBlockerIdentifier) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }
}
