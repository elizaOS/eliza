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
    static let appGroupIdentifier = "group.ai.elizaos.app"
    static let stateKey = "website_blocker_state_v1"

    private struct StoredState: Codable {
        let websites: [String]
        let endsAtEpochMs: Double?
    }

    static func writeRulesFile() throws -> URL {
        let rules = buildRules(for: loadActiveWebsites())
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

    private static func loadActiveWebsites() -> [String] {
        guard let defaults = UserDefaults(suiteName: appGroupIdentifier),
              let data = defaults.data(forKey: stateKey),
              let decoded = try? JSONDecoder().decode(StoredState.self, from: data) else {
            return []
        }

        if let endsAtEpochMs = decoded.endsAtEpochMs,
           endsAtEpochMs <= Date().timeIntervalSince1970 * 1000 {
            defaults.removeObject(forKey: stateKey)
            return []
        }

        return decoded.websites.compactMap(normalizeHostname)
    }

    private static func buildRules(for websites: [String]) -> [[String: Any]] {
        websites.map { website in
            [
                "trigger": [
                    "url-filter": "^https?://([A-Za-z0-9-]+\\\\.)*\(NSRegularExpression.escapedPattern(for: website))([/:?#]|$)",
                ],
                "action": [
                    "type": "block",
                ],
            ]
        }
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
