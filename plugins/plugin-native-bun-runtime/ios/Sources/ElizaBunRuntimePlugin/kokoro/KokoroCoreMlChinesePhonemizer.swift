import Foundation

/// Chinese text-to-phoneme conversion for Kokoro TTS.
///
/// Pipeline: Chinese text → CFStringTokenizer (word segmentation + pinyin) → IPA
/// Uses Apple's built-in Mandarin Latin transcription — no external dependencies.
///
/// Pinyin-to-IPA mapping adapted from stefantaubert/pinyin-to-ipa (MIT license).
/// Tone marks simplified to arrow notation to match Kokoro's vocab.
final class ChinesePhonemizer {

    // MARK: - Pinyin Initial → IPA

    /// Mandarin initials mapped to IPA. Longest-match order matters (zh before z).
    private static let initials: [(pinyin: String, ipa: String)] = [
        ("zh", "ʈʂ"), ("ch", "ʈʂʰ"), ("sh", "ʂ"),
        ("b", "p"), ("p", "pʰ"), ("m", "m"), ("f", "f"),
        ("d", "t"), ("t", "tʰ"), ("n", "n"), ("l", "l"),
        ("g", "k"), ("k", "kʰ"), ("h", "x"),
        ("j", "tɕ"), ("q", "tɕʰ"), ("x", "ɕ"),
        ("z", "ts"), ("c", "tsʰ"), ("s", "s"),
        ("r", "ɻ"),
    ]

    // MARK: - Pinyin Final → IPA

    /// Mandarin finals mapped to IPA (tone placeholder "0" replaced later).
    /// Ordered longest-first to ensure correct greedy matching.
    ///
    /// Note: combining diacritics (◌̯ non-syllabic, ◌̩ syllabic) are omitted because
    /// Kokoro's vocab_index.json doesn't contain them — they'd be silently dropped
    /// during tokenization, corrupting the phoneme sequence.
    private static let finals: [(pinyin: String, ipa: String)] = [
        ("iang", "ja0ŋ"), ("iong", "jʊ0ŋ"), ("uang", "wa0ŋ"), ("ueng", "wə0ŋ"),
        ("iao", "jau0"), ("ian", "jɛ0n"), ("iou", "jou0"),
        ("uai", "wai0"), ("uan", "wa0n"), ("uei", "wei0"), ("uen", "wə0n"),
        ("üan", "ɥɛ0n"), ("üe", "ɥe0"),
        ("ang", "a0ŋ"), ("eng", "ə0ŋ"), ("ing", "i0ŋ"), ("ong", "ʊ0ŋ"),
        ("ai", "ai0"), ("ei", "ei0"), ("ao", "au0"), ("ou", "ou0"),
        ("an", "a0n"), ("en", "ə0n"), ("in", "i0n"), ("ün", "y0n"),
        ("ia", "ja0"), ("ie", "je0"), ("uo", "wo0"), ("ua", "wa0"),
        ("a", "a0"), ("e", "ɤ0"), ("i", "i0"), ("o", "wo0"), ("u", "u0"), ("ü", "y0"),
    ]

    /// Context-dependent final for "i" after zh/ch/sh/r.
    /// Uses ɨ (close central unrounded) which is in Kokoro's vocab,
    /// instead of ɻ̩ (combining syllabic mark not in vocab).
    private static let retroflexI = "ɨ0"
    /// Context-dependent final for "i" after z/c/s.
    private static let alveolarI = "ɨ0"

    // MARK: - Interjections & Syllabic Consonants

    private static let interjections: [String: String] = [
        "er": "ɚ0", "io": "jɔ0", "ê": "ɛ0",
    ]

    private static let syllabicConsonants: [String: String] = [
        "hng": "hŋ0", "hm": "hm0", "ng": "ŋ0", "m": "m0", "n": "n0",
    ]

    // MARK: - Tone Contours

    private static let toneContours: [Character: String] = [
        "1": "˥",     // high level
        "2": "˧˥",    // rising
        "3": "˧˩˧",   // dipping
        "4": "˥˩",    // falling
        "5": "",       // neutral
        "0": "",       // no tone
    ]

    /// Simplified tone marks (arrow notation matching Kokoro vocab).
    private static let retoneMap: [(from: String, to: String)] = [
        ("˧˩˧", "↓"),  // 3rd tone
        ("˧˥", "↗"),   // 2nd tone
        ("˥˩", "↘"),   // 4th tone
        ("˥", "→"),    // 1st tone
    ]

    // MARK: - Chinese Punctuation

    private static let punctuationMap: [Character: String] = [
        "，": ",", "。": ".", "！": "!", "？": "?", "；": ";", "：": ":",
        "、": ",", "—": "-",
        "「": "\"", "」": "\"", "『": "\"", "』": "\"",
        "《": "\"", "》": "\"", "【": "\"", "】": "\"",
        "（": "(", "）": ")",
    ]

    // MARK: - Public API

    /// Convert Chinese text to IPA phoneme string.
    func phonemize(_ text: String) -> String {
        var result = ""
        var lastWasWord = false

        // Process character by character to get individual pinyin syllables.
        // CFStringTokenizer per-word concatenates multi-char pinyin (e.g. "nǐhǎo"),
        // so we tokenize each Chinese character individually for correct syllable boundaries.
        for ch in text {
            if let punct = Self.punctuationMap[ch] {
                result += punct
                lastWasWord = false
            } else if ch.isPunctuation || ch.isSymbol {
                lastWasWord = false
            } else if ch.isWhitespace {
                if lastWasWord { result += " " }
                lastWasWord = false
            } else if ch.isASCII && ch.isLetter {
                // English letter passthrough
                if !lastWasWord { result += " " }
                result += String(ch).lowercased()
                lastWasWord = true
            } else {
                // Chinese character — get pinyin via CFStringTransform
                let mutable = NSMutableString(string: String(ch))
                CFStringTransform(mutable, nil, kCFStringTransformMandarinLatin, false)
                let pinyin = mutable as String

                // Skip if transform returned the same character (not Chinese)
                if pinyin != String(ch) {
                    if lastWasWord { result += " " }
                    result += Self.pinyinToIPA(pinyin)
                    lastWasWord = true
                }
            }
        }

        return result
    }

    // MARK: - Pinyin → IPA Conversion

    /// Convert a tone-marked pinyin string (e.g. "nǐ hǎo") to IPA.
    static func pinyinToIPA(_ pinyin: String) -> String {
        // Split on whitespace/hyphens to get individual syllables
        let syllables = pinyin.components(separatedBy: CharacterSet.whitespaces)
            .flatMap { $0.components(separatedBy: "-") }
            .filter { !$0.isEmpty }

        return syllables.map { syllableToIPA($0) }.joined()
    }

    /// Convert a single pinyin syllable to IPA.
    static func syllableToIPA(_ syllable: String) -> String {
        // Normalize: extract tone from diacritics
        let (base, tone) = extractTone(syllable)
        var normalized = normalizeFinalsNotation(base)

        // Check interjections
        if let ipa = interjections[normalized] {
            return applyTone(ipa, tone: tone)
        }

        // Check syllabic consonants
        if let ipa = syllabicConsonants[normalized] {
            return applyTone(ipa, tone: tone)
        }

        // Handle zero-initial syllables: y→i/ü, w→u mappings
        // "yi" → final "i", "wu" → final "u", "yu" → final "ü"
        // "ya" → final "ia", "ye" → final "ie", "yao" → final "iao", etc.
        // "wa" → final "ua", "wo" → final "uo", "wai" → final "uai", etc.
        if normalized.hasPrefix("y") {
            let afterY = String(normalized.dropFirst())
            if afterY == "i" || afterY.isEmpty {
                normalized = "i"
            } else if afterY == "u" || afterY == "ü" {
                normalized = "ü"
            } else if afterY == "uan" || afterY == "ue" || afterY == "un" {
                // yuan→üan, yue→üe, yun→ün
                normalized = "ü" + afterY.dropFirst()
            } else {
                // ya→ia, ye→ie, yao→iao, you→iou, etc.
                normalized = "i" + afterY
            }
        } else if normalized.hasPrefix("w") {
            let afterW = String(normalized.dropFirst())
            if afterW == "u" || afterW.isEmpty {
                normalized = "u"
            } else {
                // wa→ua, wo→uo, wai→uai, wei→uei, wen→uen, wang→uang
                normalized = "u" + afterW
            }
        }

        // Split into initial + final
        var initial = ""
        var initialIPA = ""
        var remainder = normalized

        for (py, ipa) in initials {
            if normalized.hasPrefix(py) {
                initial = py
                initialIPA = ipa
                remainder = String(normalized.dropFirst(py.count))
                break
            }
        }

        // Handle empty remainder (standalone initial — shouldn't happen for valid pinyin)
        guard !remainder.isEmpty else {
            return initialIPA
        }

        // Context-dependent "i" after retroflex/alveolar initials
        if remainder == "i" {
            if ["zh", "ch", "sh", "r"].contains(initial) {
                return initialIPA + applyTone(retroflexI, tone: tone)
            }
            if ["z", "c", "s"].contains(initial) {
                return initialIPA + applyTone(alveolarI, tone: tone)
            }
        }

        // Match final
        for (py, ipa) in finals {
            if remainder == py {
                return initialIPA + applyTone(ipa, tone: tone)
            }
        }

        // Fallback: return raw
        return initialIPA + remainder
    }

    /// Replace tone placeholder "0" with actual tone contour.
    private static func applyTone(_ ipa: String, tone: Character) -> String {
        let contour = toneContours[tone] ?? ""
        // Simplify tone contours to arrow notation
        var toned = ipa.replacingOccurrences(of: "0", with: contour)
        for (from, to) in retoneMap {
            toned = toned.replacingOccurrences(of: from, with: to)
        }
        return toned
    }

    /// Extract tone number from diacritic-marked pinyin.
    /// Returns (base pinyin without diacritics, tone character '1'-'5').
    static func extractTone(_ syllable: String) -> (String, Character) {
        var base = ""
        var tone: Character = "5" // default neutral

        for scalar in syllable.unicodeScalars {
            switch scalar.value {
            // Tone 1: macron (ā, ē, ī, ō, ū, ǖ)
            case 0x0101: base += "a"; tone = "1"
            case 0x0113: base += "e"; tone = "1"
            case 0x012B: base += "i"; tone = "1"
            case 0x014D: base += "o"; tone = "1"
            case 0x016B: base += "u"; tone = "1"
            case 0x01D6: base += "ü"; tone = "1"
            // Tone 2: acute (á, é, í, ó, ú, ǘ)
            case 0x00E1: base += "a"; tone = "2"
            case 0x00E9: base += "e"; tone = "2"
            case 0x00ED: base += "i"; tone = "2"
            case 0x00F3: base += "o"; tone = "2"
            case 0x00FA: base += "u"; tone = "2"
            case 0x01D8: base += "ü"; tone = "2"
            // Tone 3: caron (ǎ, ě, ǐ, ǒ, ǔ, ǚ)
            case 0x01CE: base += "a"; tone = "3"
            case 0x011B: base += "e"; tone = "3"
            case 0x01D0: base += "i"; tone = "3"
            case 0x01D2: base += "o"; tone = "3"
            case 0x01D4: base += "u"; tone = "3"
            case 0x01DA: base += "ü"; tone = "3"
            // Tone 4: grave (à, è, ì, ò, ù, ǜ)
            case 0x00E0: base += "a"; tone = "4"
            case 0x00E8: base += "e"; tone = "4"
            case 0x00EC: base += "i"; tone = "4"
            case 0x00F2: base += "o"; tone = "4"
            case 0x00F9: base += "u"; tone = "4"
            case 0x01DC: base += "ü"; tone = "4"
            default:
                base += String(scalar)
            }
        }

        return (base.lowercased(), tone)
    }

    /// Normalize pinyin final notation to match our lookup tables.
    /// Handles: iu→iou, ui→uei, un→uen, v/ü normalization.
    static func normalizeFinalsNotation(_ pinyin: String) -> String {
        var s = pinyin.replacingOccurrences(of: "v", with: "ü")
            .replacingOccurrences(of: "yu", with: "ü")

        // Common abbreviations in standard pinyin
        // iu → iou (e.g., liu → liou)
        if s.hasSuffix("iu") && s.count > 2 {
            s = String(s.dropLast(2)) + "iou"
        }
        // ui → uei (e.g., gui → guei)
        if s.hasSuffix("ui") && s.count > 2 {
            s = String(s.dropLast(2)) + "uei"
        }
        // un → uen (e.g., gun → guen), but not ün
        if s.hasSuffix("un") && !s.hasSuffix("ün") && s.count > 2 {
            s = String(s.dropLast(2)) + "uen"
        }

        // After j/q/x, u → ü
        if s.count >= 2 {
            let first = String(s.prefix(1))
            if ["j", "q", "x"].contains(first) {
                s = first + String(s.dropFirst()).replacingOccurrences(of: "u", with: "ü")
            }
        }

        return s
    }
}
