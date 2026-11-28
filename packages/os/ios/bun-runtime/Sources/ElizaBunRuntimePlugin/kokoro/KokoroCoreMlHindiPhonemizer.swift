import Foundation

/// Hindi text-to-phoneme conversion for Kokoro TTS.
///
/// Pipeline: Hindi text → CFStringTransform (Devanagari → IAST romanization) → IPA
/// Uses Apple's built-in transliteration — no external dependencies.
final class HindiPhonemizer {

    // MARK: - IAST Romanization → IPA

    /// Map IAST-style romanization (from CFStringTransform) to IPA.
    private static let consonantMap: [String: String] = [
        "kh": "kʰ", "gh": "ɡʱ", "ch": "tʃ", "jh": "dʒʱ",
        "th": "tʰ", "dh": "dʱ", "ph": "pʰ", "bh": "bʱ",
        "sh": "ʃ", "ṣ": "ʂ",
        "k": "k", "g": "ɡ", "ṅ": "ŋ",
        "c": "tʃ", "j": "dʒ", "ñ": "ɲ",
        "ṭ": "ʈ", "ḍ": "ɖ", "ṇ": "ɳ",
        "t": "t", "d": "d", "n": "n",
        "p": "p", "b": "b", "m": "m",
        "y": "j", "r": "ɾ", "l": "l", "v": "ʋ",
        "s": "s", "h": "ɦ",
        "ṛ": "ɾ", "ṁ": "̃",
    ]

    private static let vowelMap: [String: String] = [
        "ā": "aː", "ī": "iː", "ū": "uː", "ē": "eː", "ō": "oː",
        "ai": "ɛː", "au": "ɔː",
        "a": "ə", "i": "ɪ", "u": "ʊ", "e": "e", "o": "o",
    ]

    // MARK: - Hindi Punctuation

    private static let punctuationMap: [Character: String] = [
        "।": ".", "॥": ".", "，": ",",
    ]

    // MARK: - Public API

    /// Phonemize a single word (for dictionary fallback).
    func phonemizeWord(_ word: String) -> String {
        let m = NSMutableString(string: word)
        CFStringTransform(m, nil, kCFStringTransformToLatin, false)
        let latin = (m as String).lowercased()
        let ipa = Self.romanToIPA(latin)
        return ipa.count >= 4 ? "ˈ" + ipa : ipa
    }

    func phonemize(_ text: String) -> String {
        var result = ""
        var lastWasWord = false

        let locale = Locale(identifier: "hi") as CFLocale
        let cfText = text as CFString
        let length = CFStringGetLength(cfText)
        guard length > 0 else { return "" }

        let tokenizer = CFStringTokenizerCreate(nil, cfText, CFRangeMake(0, length),
                                                 kCFStringTokenizerUnitWord, locale)

        var tokens: [(range: NSRange, word: String, reading: String?)] = []
        var tokenResult = CFStringTokenizerAdvanceToNextToken(tokenizer)
        while tokenResult != [] {
            let range = CFStringTokenizerGetCurrentTokenRange(tokenizer)
            let latin = CFStringTokenizerCopyCurrentTokenAttribute(
                tokenizer, kCFStringTokenizerAttributeLatinTranscription) as? String
            let nsRange = NSRange(location: range.location, length: range.length)
            let word = (text as NSString).substring(with: nsRange)
            tokens.append((range: nsRange, word: word, reading: latin))
            tokenResult = CFStringTokenizerAdvanceToNextToken(tokenizer)
        }

        var cursor = 0
        for token in tokens {
            if token.range.location > cursor {
                let gapStart = text.index(text.startIndex, offsetBy: cursor)
                let gapEnd = text.index(text.startIndex, offsetBy: token.range.location)
                for ch in text[gapStart..<gapEnd] {
                    if let punct = Self.punctuationMap[ch] {
                        result += punct
                        lastWasWord = false
                    } else if ch.isPunctuation {
                        result += String(ch)
                        lastWasWord = false
                    } else if ch.isWhitespace {
                        lastWasWord = false
                    }
                }
            }

            if let reading = token.reading {
                if lastWasWord { result += " " }
                result += Self.romanToIPA(reading.lowercased())
                lastWasWord = true
            }

            cursor = token.range.location + token.range.length
        }

        if cursor < (text as NSString).length {
            let remaining = (text as NSString).substring(from: cursor)
            for ch in remaining {
                if let punct = Self.punctuationMap[ch] { result += punct }
                else if ch.isPunctuation { result += String(ch) }
            }
        }

        return result
    }

    // MARK: - Romanization → IPA

    static func romanToIPA(_ roman: String) -> String {
        var result = ""
        let chars = Array(roman)
        var i = 0

        while i < chars.count {
            // Try 2-char sequences (aspirated consonants, diphthongs)
            if i + 1 < chars.count {
                let pair = String(chars[i...i+1])
                if let ipa = consonantMap[pair] {
                    result += ipa
                    i += 2
                    continue
                }
                if let ipa = vowelMap[pair] {
                    result += ipa
                    i += 2
                    continue
                }
            }

            // Single character
            let single = String(chars[i])
            if let ipa = consonantMap[single] {
                result += ipa
            } else if let ipa = vowelMap[single] {
                result += ipa
            } else if chars[i] == "ṣ" {
                result += "ʂ"
            } else {
                result += single
            }
            i += 1
        }

        return result
    }
}
