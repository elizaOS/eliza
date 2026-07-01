import Foundation

struct SwabbleBridgeMatch {
    let triggerWord: String
    let triggerEndTime: TimeInterval
    let postGap: TimeInterval
    let command: String
}

enum SwabbleWakeBridgeContract {
    static func wakeWordPayload(
        match: SwabbleBridgeMatch,
        transcript: String,
        confidence: Double
    ) -> [String: Any] {
        [
            "wakeWord": match.triggerWord,
            "command": match.command,
            "transcript": transcript,
            "postGap": match.postGap,
            "confidence": confidence,
        ]
    }

    static func triggerOnlyPayload(trigger: String, transcript: String) -> [String: Any] {
        [
            "wakeWord": trigger,
            "command": "",
            "transcript": transcript,
            "postGap": 0.0,
            "confidence": 0.0,
        ]
    }

    static func textOnlyCommand(
        transcript: String,
        triggers: [String],
        minCommandLength: Int
    ) -> String? {
        guard matchesTextOnly(text: transcript, triggers: triggers),
              startsWithTrigger(transcript: transcript, triggers: triggers) else { return nil }
        let after = textAfterTrigger(transcript, triggers: triggers)
        return after.count >= minCommandLength ? after : nil
    }

    static func isTriggerOnly(transcript: String, triggers: [String]) -> Bool {
        guard matchesTextOnly(text: transcript, triggers: triggers),
              startsWithTrigger(transcript: transcript, triggers: triggers) else {
            return false
        }
        return textAfterTrigger(transcript, triggers: triggers).isEmpty
    }

    static func matchesTextOnly(text: String, triggers: [String]) -> Bool {
        guard !text.isEmpty else { return false }
        let lower = text.lowercased()
        for trigger in triggers {
            let token = trigger.trimmingCharacters(in: wsPunct).lowercased()
            if token.isEmpty { continue }
            if lower.contains(token) { return true }
            let words = lower.split(whereSeparator: \.isWhitespace).map(String.init)
            if words.contains(where: { fuzzyTokenMatch($0, token) }) { return true }
        }
        return false
    }

    static func startsWithTrigger(transcript: String, triggers: [String]) -> Bool {
        let words = transcript.split(whereSeparator: \.isWhitespace)
            .map { normalizeToken(String($0)) }.filter { !$0.isEmpty }
        guard !words.isEmpty else { return false }
        for trigger in triggers {
            let triggerWords = trigger.split(whereSeparator: \.isWhitespace)
                .map { normalizeToken(String($0)) }.filter { !$0.isEmpty }
            guard !triggerWords.isEmpty, words.count >= triggerWords.count else { continue }
            if zip(triggerWords, words.prefix(triggerWords.count))
                .allSatisfy({ $0 == $1 || fuzzyTokenMatch($0, $1) }) {
                return true
            }
        }
        return false
    }

    static func textAfterTrigger(_ text: String, triggers: [String]) -> String {
        let words = text.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return "" }
        for trigger in triggers {
            let triggerWords = trigger.split(whereSeparator: \.isWhitespace)
                .map { normalizeToken(String($0)) }.filter { !$0.isEmpty }
            guard !triggerWords.isEmpty, words.count >= triggerWords.count else { continue }
            for i in 0...(words.count - triggerWords.count) {
                let matched = (0..<triggerWords.count).allSatisfy { j in
                    let word = normalizeToken(words[i + j])
                    return word == triggerWords[j] || fuzzyTokenMatch(word, triggerWords[j])
                }
                if matched {
                    let afterIdx = i + triggerWords.count
                    return afterIdx < words.count
                        ? words[afterIdx...].joined(separator: " ").trimmingCharacters(in: wsPunct)
                        : ""
                }
            }
        }
        return text
    }

    static func fuzzyTokenMatch(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        let maxLen = max(a.count, b.count)
        guard maxLen > 2 else { return false }
        let threshold = max(1, (maxLen + 1) / 3)
        return editDistance(a, b) <= threshold
    }

    private static let wsPunct = CharacterSet.whitespacesAndNewlines.union(.punctuationCharacters)

    private static func normalizeToken(_ value: String) -> String {
        value.trimmingCharacters(in: wsPunct).lowercased()
    }

    private static func editDistance(_ a: String, _ b: String) -> Int {
        let ac = Array(a), bc = Array(b)
        let m = ac.count, n = bc.count
        if m == 0 { return n }
        if n == 0 { return m }
        var prev = Array(0...n), curr = Array(repeating: 0, count: n + 1)
        for i in 1...m {
            curr[0] = i
            for j in 1...n {
                curr[j] = ac[i - 1] == bc[j - 1]
                    ? prev[j - 1]
                    : min(prev[j - 1], prev[j], curr[j - 1]) + 1
            }
            swap(&prev, &curr)
        }
        return prev[n]
    }
}
