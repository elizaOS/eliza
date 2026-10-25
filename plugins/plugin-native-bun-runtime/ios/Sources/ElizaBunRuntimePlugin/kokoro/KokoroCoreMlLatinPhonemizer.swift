import Foundation

/// Grapheme-to-phoneme conversion for Latin-script languages (French, Spanish, Portuguese, Italian, German).
///
/// Rule-based orthography→IPA conversion. Each language has specific rules for
/// digraphs, accent handling, and context-dependent pronunciation.
final class LatinPhonemizer {

    enum Language {
        case french, spanish, portuguese, italian
    }

    private let language: Language

    init(language: Language) {
        self.language = language
    }

    // MARK: - Public API

    func phonemize(_ text: String) -> String {
        let words = tokenize(text)
        var result = ""
        var lastWasWord = false

        for token in words {
            switch token {
            case .word(let w):
                if lastWasWord { result += " " }
                result += convertWord(w.lowercased())
                lastWasWord = true
            case .punctuation(let p):
                result += p
                lastWasWord = false
            case .space:
                lastWasWord = false
            }
        }

        return result
    }

    // MARK: - Tokenization

    private enum Token {
        case word(String)
        case punctuation(String)
        case space
    }

    private func tokenize(_ text: String) -> [Token] {
        var tokens: [Token] = []
        var current = ""

        for ch in text {
            if ch.isWhitespace {
                if !current.isEmpty { tokens.append(.word(current)); current = "" }
                tokens.append(.space)
            } else if ch.isLetter || ch == "'" || ch == "'" || ch == "-" {
                current.append(ch)
            } else if ch.isPunctuation || ch.isSymbol {
                if !current.isEmpty { tokens.append(.word(current)); current = "" }
                tokens.append(.punctuation(String(ch)))
            } else {
                current.append(ch)
            }
        }
        if !current.isEmpty { tokens.append(.word(current)) }

        return tokens
    }

    // MARK: - Word Conversion

    /// Public word-level phonemization for dictionary fallback.
    func phonemizeWord(_ word: String) -> String {
        return convertWord(word.lowercased())
    }

    private func convertWord(_ word: String) -> String {
        var ipa: String
        switch language {
        case .french: ipa = frenchToIPA(word)
        case .spanish: ipa = spanishToIPA(word)
        case .portuguese: ipa = portugueseToIPA(word)
        case .italian: ipa = italianToIPA(word)
        }

        // Apply E2M mappings to match Kokoro's training format.
        // Kokoro was trained with espeak-ng output post-processed by misaki.
        // These replace multi-char IPA sequences with single-char equivalents.
        for (from, to) in Self.e2mMappings {
            ipa = ipa.replacingOccurrences(of: from, with: to)
        }

        // Add primary stress mark for multi-syllable words.
        if ipa.count >= 4 {
            return "ˈ" + ipa
        }
        return ipa
    }

    // MARK: - E2M Post-Processing (Kokoro Training Format)

    /// Mappings from standard IPA to Kokoro's internal format.
    /// Sorted longest-first for correct greedy replacement.
    private static let e2mMappings: [(from: String, to: String)] = [
        // Affricates → ligatures (multi-char to single)
        ("dʒ", "ʤ"), ("tʃ", "ʧ"), ("dz", "ʣ"),
        // Consonant normalizations
        ("ʁ", "ɹ"),     // French/German uvular → alveolar approximant
        ("ɐ", "ə"),     // Near-open central → schwa
    ]

    // MARK: - French G2P

    /// French grapheme-to-phoneme rules.
    /// Nasals only before consonants (not before vowels or n/m).
    private static let frenchRules: [(pattern: String, ipa: String)] = [
        // Trigraphs / special combos
        ("eau", "oː"), ("aux", "oː"), ("eux", "øː"), ("oeu", "œː"),
        ("ain", "ɛ̃"), ("ein", "ɛ̃"), ("oin", "wɛ̃"),
        ("ien", "jɛ̃"), ("ion", "jɔ̃"),
        // Digraphs
        ("ou", "uː"), ("oi", "waː"), ("ai", "ɛː"), ("ei", "ɛː"),
        ("au", "oː"), ("eu", "øː"), ("ch", "ʃ"), ("ph", "f"),
        ("th", "t"), ("gn", "ɲ"), ("qu", "k"), ("gu", "ɡ"),
        ("ll", "l"), ("ss", "s"), ("tt", "t"), ("nn", "n"),
        ("mm", "m"), ("pp", "p"), ("rr", "ʁ"), ("ff", "f"),
        // Accented vowels
        ("é", "eː"), ("è", "ɛː"), ("ê", "ɛː"), ("ë", "ɛ"),
        ("à", "aː"), ("â", "ɑː"), ("ù", "yː"), ("û", "yː"),
        ("î", "iː"), ("ï", "i"), ("ô", "oː"), ("ü", "yː"),
        ("ç", "s"), ("œ", "œ"),
        // Basic
        ("a", "a"), ("b", "b"), ("c", "k"), ("d", "d"), ("e", "ə"),
        ("f", "f"), ("g", "ɡ"), ("h", ""), ("i", "i"), ("j", "ʒ"),
        ("k", "k"), ("l", "l"), ("m", "m"), ("n", "n"), ("o", "o"),
        ("p", "p"), ("r", "ʁ"), ("s", "s"), ("t", "t"), ("u", "y"),
        ("v", "v"), ("w", "w"), ("x", "ks"), ("y", "i"), ("z", "z"),
    ]

    private func frenchToIPA(_ word: String) -> String {
        var result = ""
        let chars = Array(word)
        var i = 0

        while i < chars.count {
            var matched = false

            // Context-dependent: c before e/i/y = s, g before e/i = ʒ
            if i + 1 < chars.count {
                let next = chars[i + 1]
                if chars[i] == "c" && "eiéèêëîïy".contains(next) {
                    result += "s"
                    i += 1
                    continue
                }
                if chars[i] == "g" && "eiéèêëîïy".contains(next) {
                    result += "ʒ"
                    i += 1
                    continue
                }
            }

            // Nasal vowels: on/an/en/in/un before consonant (not before vowel or n/m)
            if i + 1 < chars.count {
                let pair = String(chars[i...i+1])
                let afterNasal: Character? = (i + 2 < chars.count) ? chars[i + 2] : nil
                let nasalFollowedByVowelOrNM = afterNasal != nil && "aeiouyéèêëàâùûîïôüœ".contains(afterNasal!) || afterNasal == "n" || afterNasal == "m"
                if !nasalFollowedByVowelOrNM {
                    switch pair {
                    case "on", "om": result += "ɔ̃"; i += 2; continue
                    case "an", "am": result += "ɑ̃"; i += 2; continue
                    case "en", "em": result += "ɑ̃"; i += 2; continue
                    case "in", "im": result += "ɛ̃"; i += 2; continue
                    case "un", "um": result += "œ̃"; i += 2; continue
                    default: break
                    }
                }
            }

            // Try longest match first (3, 2, 1 chars)
            for len in stride(from: min(3, chars.count - i), through: 1, by: -1) {
                let substr = String(chars[i..<i+len])
                if let rule = Self.frenchRules.first(where: { $0.pattern == substr }) {
                    result += rule.ipa
                    i += len
                    matched = true
                    break
                }
            }
            if !matched {
                result += String(chars[i])
                i += 1
            }
        }

        // Drop silent final consonants (French rule: d, t, s, x, z, p are silent at end)
        if result.count > 1 {
            let last = result.last!
            if "dtsxzp".contains(last) {
                result = String(result.dropLast())
            }
        }

        return result
    }

    // MARK: - Spanish G2P

    /// Spanish is very regular — nearly 1:1 grapheme-to-phoneme.
    private static let spanishRules: [(pattern: String, ipa: String)] = [
        // Digraphs
        ("ch", "tʃ"), ("ll", "ʝ"), ("rr", "rː"), ("qu", "k"),
        ("gu", "ɡ"), ("gü", "ɡw"),
        ("ñ", "ɲ"),
        // Accented vowels (stressed — add length)
        ("á", "aː"), ("é", "eː"), ("í", "iː"), ("ó", "oː"), ("ú", "uː"), ("ü", "w"),
        // Basic
        ("a", "a"), ("b", "b"), ("c", "k"), ("d", "d"), ("e", "e"),
        ("f", "f"), ("g", "ɡ"), ("h", ""), ("i", "i"), ("j", "x"),
        ("k", "k"), ("l", "l"), ("m", "m"), ("n", "n"), ("o", "o"),
        ("p", "p"), ("r", "ɾ"), ("s", "s"), ("t", "t"), ("u", "u"),
        ("v", "b"), ("w", "w"), ("x", "ks"), ("y", "ʝ"), ("z", "θ"),
    ]

    private func spanishToIPA(_ word: String) -> String {
        var result = ""
        let chars = Array(word)
        var i = 0

        while i < chars.count {
            // Context: c before e/i = θ, g before e/i = x
            if i + 1 < chars.count {
                if chars[i] == "c" && "eiéí".contains(chars[i+1]) {
                    result += "θ"
                    i += 1
                    continue
                }
                if chars[i] == "g" && "eiéí".contains(chars[i+1]) {
                    result += "x"
                    i += 1
                    continue
                }
            }

            var matched = false
            for len in stride(from: min(2, chars.count - i), through: 1, by: -1) {
                let substr = String(chars[i..<i+len])
                if let rule = Self.spanishRules.first(where: { $0.pattern == substr }) {
                    result += rule.ipa
                    i += len
                    matched = true
                    break
                }
            }
            if !matched {
                result += String(chars[i])
                i += 1
            }
        }

        return result
    }

    // MARK: - Portuguese G2P

    private static let portugueseRules: [(pattern: String, ipa: String)] = [
        // Digraphs / trigraphs
        ("ção", "saːw̃"), ("ções", "sõːjs"), ("nh", "ɲ"), ("lh", "ʎ"),
        ("ch", "ʃ"), ("qu", "k"), ("gu", "ɡ"), ("rr", "ʁː"),
        ("ss", "s"), ("sc", "s"),
        // Explicit nasal diphthongs
        ("ão", "aːw̃"), ("ãe", "aːj̃"), ("õe", "oːj̃"),
        // Accented
        ("á", "aː"), ("â", "ɐː"), ("ã", "ɐ̃ː"), ("é", "ɛː"), ("ê", "eː"),
        ("í", "iː"), ("ó", "ɔː"), ("ô", "oː"), ("õ", "õː"), ("ú", "uː"),
        ("ç", "s"),
        // Diphthongs
        ("ou", "oː"), ("ei", "eːj"), ("ai", "aːj"), ("oi", "oːj"),
        // Basic
        ("a", "a"), ("b", "b"), ("c", "k"), ("d", "d"), ("e", "e"),
        ("f", "f"), ("g", "ɡ"), ("h", ""), ("i", "i"), ("j", "ʒ"),
        ("k", "k"), ("l", "l"), ("m", "m"), ("n", "n"), ("o", "o"),
        ("p", "p"), ("r", "ɾ"), ("s", "s"), ("t", "t"), ("u", "u"),
        ("v", "v"), ("w", "w"), ("x", "ʃ"), ("y", "i"), ("z", "z"),
    ]

    private func portugueseToIPA(_ word: String) -> String {
        var result = ""
        let chars = Array(word)
        var i = 0

        while i < chars.count {
            // Context: c before e/i = s
            if i + 1 < chars.count && chars[i] == "c" && "eiéí".contains(chars[i+1]) {
                result += "s"
                i += 1
                continue
            }

            var matched = false
            for len in stride(from: min(4, chars.count - i), through: 1, by: -1) {
                let substr = String(chars[i..<i+len])
                if let rule = Self.portugueseRules.first(where: { $0.pattern == substr }) {
                    result += rule.ipa
                    i += len
                    matched = true
                    break
                }
            }
            if !matched {
                result += String(chars[i])
                i += 1
            }
        }

        return result
    }

    // MARK: - Italian G2P

    /// Italian is highly regular — nearly 1:1 grapheme-to-phoneme.
    /// Main exceptions: c/g before e/i, gl, gn, sc digraphs.
    private static let italianRules: [(pattern: String, ipa: String)] = [
        // Trigraphs
        ("gli", "ʎi"), ("sce", "ʃe"), ("sci", "ʃi"),
        ("ghi", "ɡi"), ("ghe", "ɡe"), ("chi", "ki"), ("che", "ke"),
        // Digraphs
        ("gn", "ɲ"), ("gl", "ʎ"), ("sc", "sk"),
        ("gh", "ɡ"), ("ch", "k"), ("qu", "kw"),
        ("ci", "tʃi"), ("ce", "tʃe"),
        ("gi", "dʒi"), ("ge", "dʒe"),
        ("zz", "tːs"), ("ss", "sː"), ("rr", "rː"), ("ll", "lː"),
        ("nn", "nː"), ("mm", "mː"), ("pp", "pː"), ("tt", "tː"),
        ("cc", "kː"), ("ff", "fː"), ("bb", "bː"), ("dd", "dː"),
        ("gg", "ɡː"),
        // Accented vowels
        ("à", "a"), ("è", "ɛ"), ("é", "e"), ("ì", "i"), ("ò", "ɔ"), ("ó", "o"), ("ù", "u"),
        // Basic — Italian vowels are pure, consonants are straightforward
        ("a", "a"), ("b", "b"), ("c", "k"), ("d", "d"), ("e", "e"),
        ("f", "f"), ("g", "ɡ"), ("h", ""), ("i", "i"), ("j", "j"),
        ("k", "k"), ("l", "l"), ("m", "m"), ("n", "n"), ("o", "o"),
        ("p", "p"), ("r", "r"), ("s", "s"), ("t", "t"), ("u", "u"),
        ("v", "v"), ("w", "w"), ("x", "ks"), ("y", "i"), ("z", "ts"),
    ]

    private func italianToIPA(_ word: String) -> String {
        var result = ""
        let chars = Array(word)
        var i = 0

        while i < chars.count {
            var matched = false
            for len in stride(from: min(3, chars.count - i), through: 1, by: -1) {
                let substr = String(chars[i..<i+len])
                if let rule = Self.italianRules.first(where: { $0.pattern == substr }) {
                    result += rule.ipa
                    i += len
                    matched = true
                    break
                }
            }
            if !matched {
                result += String(chars[i])
                i += 1
            }
        }

        return result
    }

}
