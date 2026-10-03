import Foundation
import MobileCoreServices

final class ActionRequestHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        do {
            let rulesURL = try WebsiteBlockerContentBlockerStore.writeRulesFile()
            let attachment = NSItemProvider(contentsOf: rulesURL)
            let item = NSExtensionItem()
            item.attachments = attachment.map { [$0] } ?? []
            context.completeRequest(returningItems: [item], completionHandler: nil)
        } catch {
            context.cancelRequest(withError: error)
        }
    }
}

private enum WebsiteBlockerContentBlockerStore {
    static var appGroupIdentifier: String {
        guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
            return "group.ai.elizaos.app"
        }
        let extensionSuffix = ".WebsiteBlockerContentExtension"
        let appBundleIdentifier = bundleIdentifier.hasSuffix(extensionSuffix)
            ? String(bundleIdentifier.dropLast(extensionSuffix.count))
            : bundleIdentifier
        return "group.\(appBundleIdentifier)"
    }

    static let stateKey = "website_blocker_state_v1"

    private struct StoredState: Codable {
        let websites: [String]
        let endsAtEpochMs: Double?
        let requestedWebsites: [String]?
        let blockedWebsites: [String]?
        let allowedWebsites: [String]?
        let matchMode: String?
    }

    static func writeRulesFile() throws -> URL {
        let rules = buildRules(for: loadActiveState())
        let data = try JSONSerialization.data(withJSONObject: rules, options: [])
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("elizaos-website-blocker-rules", isDirectory: true)
            .appendingPathComponent("blockerList.json")
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: nil
        )
        try data.write(to: url, options: .atomic)
        return url
    }

    private static func loadActiveState() -> StoredState? {
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier),
              let data = defaults.data(forKey: stateKey),
              let decoded = try? JSONDecoder().decode(StoredState.self, from: data) else {
            return nil
        }

        if let endsAtEpochMs = decoded.endsAtEpochMs,
           endsAtEpochMs <= Date().timeIntervalSince1970 * 1000 {
            defaults.removeObject(forKey: stateKey)
            return nil
        }

        let websites = normalizedHosts(decoded.websites)
        guard !websites.isEmpty else {
            defaults.removeObject(forKey: stateKey)
            return nil
        }

        return StoredState(
            websites: websites,
            endsAtEpochMs: decoded.endsAtEpochMs,
            requestedWebsites: normalizedHosts(decoded.requestedWebsites),
            blockedWebsites: normalizedHosts(decoded.blockedWebsites),
            allowedWebsites: normalizedHosts(decoded.allowedWebsites),
            matchMode: decoded.matchMode
        )
    }

    private static func buildRules(for state: StoredState?) -> [[String: Any]] {
        guard let state else {
            return []
        }
        let blockedWebsites: [String]
        if let blocked = state.blockedWebsites, !blocked.isEmpty {
            blockedWebsites = blocked
        } else {
            blockedWebsites = state.websites
        }
        let allowedWebsites = state.allowedWebsites ?? []
        let blockedRules = blockedWebsites.map { website in
            [
                "trigger": [
                    "url-filter": "^https?://([A-Za-z0-9-]+\\\\.)*\(NSRegularExpression.escapedPattern(for: website))([/:?#]|$)",
                ],
                "action": [
                    "type": "block",
                ],
            ]
        }
        let allowRules = allowedWebsites.map { website in
            [
                "trigger": [
                    "url-filter": "^https?://([A-Za-z0-9-]+\\\\.)*\(NSRegularExpression.escapedPattern(for: website))([/:?#]|$)",
                ],
                "action": [
                    "type": "ignore-previous-rules",
                ],
            ]
        }
        return blockedRules + allowRules
    }

    private static func normalizedHosts(_ values: [String]?) -> [String] {
        Array(Set((values ?? []).compactMap(normalizeHostname))).sorted()
    }

    private static func normalizeHostname(_ value: String) -> String? {
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
}
