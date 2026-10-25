import Foundation

/// Japanese text-to-phoneme conversion for Kokoro TTS.
///
/// Pipeline: Japanese text → CFStringTokenizer (word segmentation + readings)
///           → katakana → IPA via M2P table → P2R romanization
///
/// Uses Apple's built-in Japanese morphological analysis — no MeCab dependency.
/// M2P katakana-to-IPA table covers standard and extended katakana (193 entries).
final class JapanesePhonemizer {

    // MARK: - Katakana → IPA (M2P)

    /// Digraph mappings (two-character katakana → IPA). Checked before single chars.
    private static let digraphs: [String: String] = [
        "イェ": "je",
        "ウィ": "wi", "ウゥ": "wu", "ウェ": "we", "ウォ": "wo",
        "キィ": "kyi", "キェ": "kye", "キャ": "kya", "キュ": "kyu", "キョ": "kyo",
        "ギィ": "gyi", "ギェ": "gye", "ギャ": "gya", "ギュ": "gyu", "ギョ": "gyo",
        "クァ": "kwa", "クィ": "kwi", "クゥ": "kwu", "クェ": "kwe", "クォ": "kwo", "クヮ": "kwa",
        "グァ": "gwa", "グィ": "gwi", "グゥ": "gwu", "グェ": "gwe", "グォ": "gwo", "グヮ": "gwa",
        "シェ": "she", "シャ": "sha", "シュ": "shu", "ショ": "sho",
        "ジェ": "je", "ジャ": "ja", "ジュ": "ju", "ジョ": "jo",
        "スィ": "si", "ズィ": "zi",
        "チェ": "che", "チャ": "cha", "チュ": "chu", "チョ": "cho",
        "ヂェ": "je", "ヂャ": "ja", "ヂュ": "ju", "ヂョ": "jo",
        "ツァ": "tsa", "ツィ": "tsi", "ツェ": "tse", "ツォ": "tso",
        "ティ": "ti", "テェ": "tye", "テャ": "tya", "テュ": "tyu", "テョ": "tyo",
        "ディ": "di", "デェ": "dye", "デャ": "dya", "デュ": "dyu", "デョ": "dyo",
        "トゥ": "tu", "ドゥ": "du",
        "ニィ": "nyi", "ニェ": "nye", "ニャ": "nya", "ニュ": "nyu", "ニョ": "nyo",
        "ヒィ": "hyi", "ヒェ": "hye", "ヒャ": "hya", "ヒュ": "hyu", "ヒョ": "hyo",
        "ビィ": "byi", "ビェ": "bye", "ビャ": "bya", "ビュ": "byu", "ビョ": "byo",
        "ピィ": "pyi", "ピェ": "pye", "ピャ": "pya", "ピュ": "pyu", "ピョ": "pyo",
        "ファ": "fa", "フィ": "fi", "フェ": "fe", "フォ": "fo",
        "ミィ": "myi", "ミェ": "mye", "ミャ": "mya", "ミュ": "myu", "ミョ": "myo",
        "リィ": "ryi", "リェ": "rye", "リャ": "rya", "リュ": "ryu", "リョ": "ryo",
        "ヴァ": "va", "ヴィ": "vi", "ヴェ": "ve", "ヴォ": "vo",
        "ヴャ": "bya", "ヴュ": "byu", "ヴョ": "byo",
    ]

    /// Single katakana → IPA mappings.
    private static let singles: [Character: String] = [
        "ァ": "a", "ア": "a", "ィ": "i", "イ": "i",
        "ゥ": "u", "ウ": "u", "ェ": "e", "エ": "e",
        "ォ": "o", "オ": "o",
        "カ": "ka", "ガ": "ga", "キ": "ki", "ギ": "gi",
        "ク": "ku", "グ": "gu", "ケ": "ke", "ゲ": "ge",
        "コ": "ko", "ゴ": "go",
        "サ": "sa", "ザ": "za", "シ": "shi", "ジ": "ji",
        "ス": "su", "ズ": "zu", "セ": "se", "ゼ": "ze",
        "ソ": "so", "ゾ": "zo",
        "タ": "ta", "ダ": "da", "チ": "chi", "ヂ": "ji",
        "ツ": "tsu", "ヅ": "zu", "テ": "te", "デ": "de",
        "ト": "to", "ド": "do",
        "ナ": "na", "ニ": "ni", "ヌ": "nu", "ネ": "ne", "ノ": "no",
        "ハ": "ha", "バ": "ba", "パ": "pa",
        "ヒ": "hi", "ビ": "bi", "ピ": "pi",
        "フ": "fu", "ブ": "bu", "プ": "pu",
        "ヘ": "he", "ベ": "be", "ペ": "pe",
        "ホ": "ho", "ボ": "bo", "ポ": "po",
        "マ": "ma", "ミ": "mi", "ム": "mu", "メ": "me", "モ": "mo",
        "ャ": "ya", "ヤ": "ya", "ュ": "yu", "ユ": "yu",
        "ョ": "yo", "ヨ": "yo",
        "ラ": "ra", "リ": "ri", "ル": "ru", "レ": "re", "ロ": "ro",
        "ヮ": "wa", "ワ": "wa", "ヰ": "i", "ヱ": "e", "ヲ": "o",
        "ヴ": "vu", "ヵ": "ka", "ヶ": "ke",
        "ヷ": "va", "ヸ": "vi", "ヹ": "ve", "ヺ": "vo",
        "ッ": "ʔ", "ン": "ɴ", "ー": "ː",
    ]

    // MARK: - Japanese Punctuation

    private static let punctuationMap: [Character: String] = [
        "「": "\"", "」": "\"", "『": "\"", "』": "\"",
        "【": "\"", "】": "\"", "〈": "\"", "〉": "\"",
        "《": "\"", "》": "\"", "«": "\"", "»": "\"",
        "、": ",", "。": ".", "！": "!", "？": "?",
        "（": "(", "）": ")", "：": ":", "；": ";",
    ]

    // MARK: - Public API

    /// Convert Japanese text to phoneme string for Kokoro TTS.
    func phonemize(_ text: String) -> String {
        let locale = Locale(identifier: "ja_JP") as CFLocale
        let cfText = text as CFString
        let length = CFStringGetLength(cfText)
        guard length > 0 else { return "" }

        let tokenizer = CFStringTokenizerCreate(nil, cfText, CFRangeMake(0, length),
                                                 kCFStringTokenizerUnitWord, locale)

        // Collect tokens with their positions
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

        var result = ""
        var lastWasWord = false
        var cursor = 0

        for token in tokens {
            // Handle gaps (punctuation, whitespace) between tokens
            if token.range.location > cursor {
                let gapStart = text.index(text.startIndex, offsetBy: cursor)
                let gapEnd = text.index(text.startIndex, offsetBy: token.range.location)
                for ch in text[gapStart..<gapEnd] {
                    if let punct = Self.punctuationMap[ch] {
                        result += punct
                        lastWasWord = false
                    } else if ch.isPunctuation || ch.isSymbol {
                        if let ascii = Self.asciiPunct(ch) { result += ascii }
                        lastWasWord = false
                    } else if ch.isWhitespace {
                        lastWasWord = false
                    }
                }
            }

            if let reading = token.reading {
                if lastWasWord { result += " " }
                // Convert romaji reading to katakana, then to IPA
                let katakana = Self.romajiToKatakana(reading)
                result += Self.katakanaToPhonemes(katakana)
                lastWasWord = true
            }

            cursor = token.range.location + token.range.length
        }

        // Trailing punctuation
        if cursor < (text as NSString).length {
            let remaining = (text as NSString).substring(from: cursor)
            for ch in remaining {
                if let punct = Self.punctuationMap[ch] {
                    result += punct
                } else if ch.isPunctuation || ch.isSymbol {
                    if let ascii = Self.asciiPunct(ch) { result += ascii }
                }
            }
        }

        return result
    }

    // MARK: - Katakana → Phonemes

    /// Convert katakana string to phoneme string using M2P table.
    static func katakanaToPhonemes(_ katakana: String) -> String {
        var result = ""
        let chars = Array(katakana)
        var i = 0

        while i < chars.count {
            // Try digraph first (two characters)
            if i + 1 < chars.count {
                let pair = String(chars[i]) + String(chars[i + 1])
                if let phoneme = digraphs[pair] {
                    result += phoneme
                    i += 2
                    continue
                }
            }

            // Single character
            if let phoneme = singles[chars[i]] {
                result += phoneme
            }
            // Skip unknown characters silently
            i += 1
        }

        return result
    }

    // MARK: - Romaji → Katakana

    /// Convert romaji to katakana for M2P lookup.
    /// Uses CFStringTransform (Apple's built-in Latin→Katakana).
    static func romajiToKatakana(_ romaji: String) -> String {
        let mutable = NSMutableString(string: romaji)
        CFStringTransform(mutable, nil, kCFStringTransformLatinKatakana, false)
        return mutable as String
    }

    // MARK: - Helpers

    private static func asciiPunct(_ ch: Character) -> String? {
        switch ch {
        case ",": return ","
        case ".": return "."
        case "!": return "!"
        case "?": return "?"
        case ";": return ";"
        case ":": return ":"
        case "-": return "-"
        default: return nil
        }
    }
}
