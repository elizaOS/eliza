import CoreML
import Foundation
import NaturalLanguage

/// Multilingual phonemizer for Kokoro TTS.
///
/// English: dictionary lookup → suffix stemming → CoreML BART G2P fallback.
/// Chinese/Japanese/Italian: dedicated language-specific phonemizers.
/// French/Spanish/Portuguese/Hindi: pronunciation dictionary + rule-based G2P.
public final class KokoroPhonemizer {

    /// IPA symbol → token ID mapping (from vocab_index.json).
    private let vocab: [String: Int]

    /// Reverse mapping for debugging.
    private let idToToken: [Int: String]

    /// Gold dictionary (high-confidence entries).
    private var goldDict: [String: DictEntry] = [:]

    /// Silver dictionary (lower-confidence entries).
    private var silverDict: [String: DictEntry] = [:]

    /// CoreML G2P encoder model.
    private var g2pEncoder: MLModel?

    /// CoreML G2P decoder model.
    private var g2pDecoder: MLModel?

    /// G2P vocabulary mappings.
    private var graphemeToId: [String: Int] = [:]
    private var idToPhoneme: [Int: String] = [:]
    private var g2pBosId: Int = 1
    private var g2pEosId: Int = 2
    private var g2pPadId: Int = 0

    /// NL tagger for POS tagging (heteronym resolution).
    private let tagger = NLTagger(tagSchemes: [.lexicalClass])

    /// Pad token ID (0).
    public let padId: Int = 0

    /// Start-of-sequence token ID.
    public let bosId: Int = 1

    /// End-of-sequence token ID.
    public let eosId: Int = 2

    /// Dictionary entry: either a simple phoneme string or POS-tagged heteronym.
    enum DictEntry {
        case simple(String)
        case heteronym([String: String])
    }

    /// Initialize with a vocabulary mapping.
    public init(vocab: [String: Int]) {
        self.vocab = vocab
        self.idToToken = Dictionary(uniqueKeysWithValues: vocab.map { ($1, $0) })
    }

    /// Load vocabulary from vocab_index.json.
    ///
    /// Format: `{"vocab": {"symbol": id, ...}, "metadata": {...}}`
    public static func loadVocab(from url: URL) throws -> KokoroPhonemizer {
        let data = try Data(contentsOf: url)
        let json = try JSONSerialization.jsonObject(with: data)

        // Support both flat {sym: id} and nested {vocab: {sym: id}} formats
        let vocab: [String: Int]
        if let nested = json as? [String: Any], let v = nested["vocab"] as? [String: Int] {
            vocab = v
        } else if let flat = json as? [String: Int] {
            vocab = flat
        } else {
            throw NSError(domain: "KokoroTTS", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Invalid vocab_index.json format"])
        }
        return KokoroPhonemizer(vocab: vocab)
    }

    /// Load pronunciation dictionaries from directory.
    public func loadDictionaries(from directory: URL, british: Bool = false) throws {
        let prefix = british ? "gb" : "us"
        let goldURL = directory.appendingPathComponent("\(prefix)_gold.json")
        let silverURL = directory.appendingPathComponent("\(prefix)_silver.json")

        if FileManager.default.fileExists(atPath: goldURL.path) {
            goldDict = try parseDictionary(from: goldURL)
            growDictionary(&goldDict)
        }
        if FileManager.default.fileExists(atPath: silverURL.path) {
            silverDict = try parseDictionary(from: silverURL)
            growDictionary(&silverDict)
        }
    }

    /// Load separate G2P encoder + decoder CoreML models.
    public func loadG2PModels(encoderURL: URL, decoderURL: URL, vocabURL: URL) throws {
        let config = MLModelConfiguration()
        config.computeUnits = .cpuOnly
        g2pEncoder = try MLModel(contentsOf: encoderURL, configuration: config)
        g2pDecoder = try MLModel(contentsOf: decoderURL, configuration: config)

        // Load G2P vocabulary
        if FileManager.default.fileExists(atPath: vocabURL.path) {
            let data = try Data(contentsOf: vocabURL)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let g2id = json["grapheme_to_id"] as? [String: Int] {
                    graphemeToId = g2id
                }
                if let id2p = json["id_to_phoneme"] as? [String: String] {
                    idToPhoneme = Dictionary(uniqueKeysWithValues: id2p.compactMap { k, v in
                        Int(k).map { ($0, v) }
                    })
                }
                g2pBosId = (json["bos_token_id"] as? Int) ?? 1
                g2pEosId = (json["eos_token_id"] as? Int) ?? 2
                g2pPadId = (json["pad_token_id"] as? Int) ?? 0
            }
        }
    }

    /// Legacy single-model G2P loading (backward compat).
    public func loadG2PModel(from url: URL) throws {
        let config = MLModelConfiguration()
        config.computeUnits = .cpuOnly
        g2pEncoder = try MLModel(contentsOf: url, configuration: config)
    }

    // MARK: - Multilingual Phonemizers

    private lazy var chinesePhonemizer = ChinesePhonemizer()
    private lazy var japanesePhonemizer = JapanesePhonemizer()
    private lazy var hindiPhonemizer = HindiPhonemizer()
    private lazy var frenchPhonemizer = LatinPhonemizer(language: .french)
    private lazy var spanishPhonemizer = LatinPhonemizer(language: .spanish)
    private lazy var portuguesePhonemizer = LatinPhonemizer(language: .portuguese)
    private lazy var italianPhonemizer = LatinPhonemizer(language: .italian)

    // MARK: - Tokenization

    /// Convert text to phoneme token IDs using language-appropriate phonemizer.
    public func tokenize(_ text: String, maxLength: Int = 510, language: String = "en") -> [Int] {
        let phonemes: String
        switch language {
        case "zh", "cmn", "chinese", "mandarin":
            phonemes = chinesePhonemizer.phonemize(text)
        case "ja", "japanese":
            phonemes = japanesePhonemizer.phonemize(text)
        case "it", "italian":
            phonemes = phonemizeWithDict(text, dict: PronunciationDicts.it, fallback: italianPhonemizer)
        case "fr", "french":
            phonemes = phonemizeWithDict(text, dict: PronunciationDicts.fr, fallback: frenchPhonemizer)
        case "es", "spanish":
            phonemes = phonemizeWithDict(text, dict: PronunciationDicts.es, fallback: spanishPhonemizer)
        case "pt", "portuguese":
            phonemes = phonemizeWithDict(text, dict: PronunciationDicts.pt, fallback: portuguesePhonemizer)
        case "hi", "hindi":
            phonemes = phonemizeWithDict(text, dict: PronunciationDicts.hi, fallback: hindiPhonemizer)
        default:
            phonemes = textToPhonemes(text)
        }

        var ids = [bosId]

        // Tokenize IPA string character by character
        for char in phonemes {
            let s = String(char)
            if let id = vocab[s] {
                ids.append(id)
            }
            // Unknown chars silently dropped
        }

        ids.append(eosId)

        if ids.count > maxLength {
            ids = Array(ids.prefix(maxLength - 1)) + [eosId]
        }

        return ids
    }

    /// Pad token IDs to a fixed length.
    public func pad(_ ids: [Int], to length: Int) -> [Int] {
        if ids.count >= length { return Array(ids.prefix(length)) }
        return ids + [Int](repeating: padId, count: length - ids.count)
    }

    // MARK: - Dictionary-Based Phonemization

    /// Phonemize text using dictionary lookup with rule-based fallback.
    /// Words found in the dictionary use pre-computed IPA with correct stress placement.
    /// Unknown words fall back to the language-specific rule-based G2P.
    private func phonemizeWithDict(_ text: String, dict: [String: String], fallback: LatinPhonemizer) -> String {
        var result = ""
        var lastWasWord = false

        for ch in text {
            if ch.isWhitespace {
                if lastWasWord { result += " " }
                lastWasWord = false
            } else if ch.isPunctuation || ch.isSymbol {
                if let mapped = punctuationToPhoneme(String(ch)) {
                    result += mapped
                }
                lastWasWord = false
            } else if ch.isLetter || ch == "'" || ch == "'" {
                // Accumulate word characters — handled below
                continue
            }
        }

        // Split into words and look up each one
        let words = text.components(separatedBy: .whitespaces).filter { !$0.isEmpty }
        result = ""
        lastWasWord = false

        for word in words {
            // Strip trailing punctuation
            var clean = word.lowercased()
            var trailing = ""
            while let last = clean.last, last.isPunctuation || last.isSymbol {
                trailing = String(last) + trailing
                clean = String(clean.dropLast())
            }
            var leading = ""
            while let first = clean.first, first.isPunctuation || first.isSymbol {
                leading += String(first)
                clean = String(clean.dropFirst())
            }

            // Leading punctuation
            for ch in leading {
                if let mapped = mapPunctuation(ch) { result += mapped }
            }

            if !clean.isEmpty {
                if lastWasWord { result += " " }
                // Dictionary lookup, then fallback
                if let ipa = dict[clean] {
                    result += ipa
                } else {
                    result += fallback.phonemizeWord(clean)
                }
                lastWasWord = true
            }

            // Trailing punctuation
            for ch in trailing {
                if let mapped = mapPunctuation(ch) { result += mapped }
                lastWasWord = false
            }
        }

        return result
    }

    /// Dictionary-based phonemization for Hindi (uses HindiPhonemizer as fallback).
    private func phonemizeWithDict(_ text: String, dict: [String: String], fallback: HindiPhonemizer) -> String {
        let words = text.components(separatedBy: .whitespaces).filter { !$0.isEmpty }
        var result = ""
        var lastWasWord = false

        for word in words {
            var clean = word
            var trailing = ""
            while let last = clean.last, last.isPunctuation || last.isSymbol {
                trailing = String(last) + trailing
                clean = String(clean.dropLast())
            }

            if !clean.isEmpty {
                if lastWasWord { result += " " }
                if let ipa = dict[clean] {
                    result += ipa
                } else {
                    result += fallback.phonemizeWord(clean)
                }
                lastWasWord = true
            }

            for ch in trailing {
                if let mapped = mapPunctuation(ch) { result += mapped }
                lastWasWord = false
            }
        }

        return result
    }

    private func mapPunctuation(_ ch: Character) -> String? {
        switch ch {
        case ",", "，": return ","
        case ".", "。": return "."
        case "!", "！": return "!"
        case "?", "？": return "?"
        case ";", "；": return ";"
        case ":": return ":"
        case "।": return "."
        default: return nil
        }
    }

    // MARK: - Text-to-Phoneme Pipeline

    func textToPhonemes(_ text: String) -> String {
        let normalized = normalizeText(text)
        let words = splitWords(normalized)
        let posTagged = tagPOS(normalized)

        var result = ""
        for word in words {
            if word.allSatisfy({ $0.isWhitespace }) {
                result += " "
                continue
            }
            if word.allSatisfy({ $0.isPunctuation || $0.isSymbol }) {
                if let mapped = punctuationToPhoneme(word) {
                    result += mapped
                }
                continue
            }
            let pos = posTagged[word.lowercased()]
            if let phonemes = resolveWord(word, pos: pos) {
                result += phonemes
            }
        }
        return result
    }

    // MARK: - Word Resolution

    private func resolveWord(_ word: String, pos: String?) -> String? {
        let lower = word.lowercased()
        if let special = specialCase(lower, pos: pos) { return special }
        if let entry = lookupDict(lower, pos: pos) { return entry }
        if let stemmed = stemAndLookup(lower) { return stemmed }
        if let g2p = bartG2P(lower) { return g2p }
        return lower
    }

    private func lookupDict(_ word: String, pos: String?) -> String? {
        if let entry = goldDict[word] { return resolveEntry(entry, pos: pos) }
        if let entry = silverDict[word] { return resolveEntry(entry, pos: pos) }
        return nil
    }

    private func resolveEntry(_ entry: DictEntry, pos: String?) -> String {
        switch entry {
        case .simple(let phonemes):
            return phonemes
        case .heteronym(let posMap):
            if let pos, let phonemes = posMap[pos] { return phonemes }
            return posMap["DEFAULT"] ?? posMap.values.first ?? ""
        }
    }

    // MARK: - Special Cases

    private func specialCase(_ word: String, pos: String?) -> String? {
        switch word {
        case "eliza": return "ɪlˈaɪzə"
        case "elizaos": return "ɪlˈaɪzə oʊ ɛs"
        case "the": return "ðə"
        case "a":
            if pos == "Determiner" { return "ɐ" }
            return "eɪ"
        case "an": return "ən"
        case "to": return "tʊ"
        case "of": return "ʌv"
        case "i": return "aɪ"
        default: return nil
        }
    }

    // MARK: - Suffix Stemming

    private func stemAndLookup(_ word: String) -> String? {
        if let result = stemS(word) { return result }
        if let result = stemEd(word) { return result }
        if let result = stemIng(word) { return result }
        return nil
    }

    private func stemS(_ word: String) -> String? {
        guard word.hasSuffix("s") && word.count > 2 else { return nil }
        if word.hasSuffix("ies") {
            let stem = String(word.dropLast(3)) + "y"
            if let phonemes = lookupDict(stem, pos: nil) { return phonemes + "z" }
        }
        if word.hasSuffix("es") && word.count > 3 {
            let stem = String(word.dropLast(2))
            if let phonemes = lookupDict(stem, pos: nil) {
                let last = phonemes.last
                if last == "s" || last == "z" || last == "ʃ" || last == "ʒ" { return phonemes + "ɪz" }
                return phonemes + "z"
            }
        }
        let stem = String(word.dropLast(1))
        if let phonemes = lookupDict(stem, pos: nil) {
            let voiceless: Set<Character> = ["p", "t", "k", "f", "θ"]
            if let last = phonemes.last, voiceless.contains(last) { return phonemes + "s" }
            return phonemes + "z"
        }
        return nil
    }

    private func stemEd(_ word: String) -> String? {
        guard word.hasSuffix("ed") && word.count > 3 else { return nil }
        if word.hasSuffix("ied") {
            let stem = String(word.dropLast(3)) + "y"
            if let phonemes = lookupDict(stem, pos: nil) { return phonemes + "d" }
        }
        let stemEd = String(word.dropLast(2))
        if stemEd.count >= 2 {
            let chars = Array(stemEd)
            if chars[chars.count - 1] == chars[chars.count - 2] {
                let dedoubled = String(stemEd.dropLast(1))
                if let phonemes = lookupDict(dedoubled, pos: nil) {
                    return phonemes + edSuffix(phonemes)
                }
            }
        }
        if let phonemes = lookupDict(stemEd, pos: nil) {
            return phonemes + edSuffix(phonemes)
        }
        return nil
    }

    private func edSuffix(_ phonemes: String) -> String {
        let last = phonemes.last
        if last == "t" || last == "d" { return "ɪd" }
        let voiceless: Set<Character> = ["p", "k", "f", "θ", "s", "ʃ"]
        if let l = last, voiceless.contains(l) { return "t" }
        return "d"
    }

    private func stemIng(_ word: String) -> String? {
        guard word.hasSuffix("ing") && word.count > 4 else { return nil }
        let stem = String(word.dropLast(3))
        if stem.count >= 2 {
            let chars = Array(stem)
            if chars[chars.count - 1] == chars[chars.count - 2] {
                let dedoubled = String(stem.dropLast(1))
                if let phonemes = lookupDict(dedoubled, pos: nil) { return phonemes + "ɪŋ" }
            }
        }
        if let phonemes = lookupDict(stem, pos: nil) { return phonemes + "ɪŋ" }
        let stemE = stem + "e"
        if let phonemes = lookupDict(stemE, pos: nil) { return phonemes + "ɪŋ" }
        return nil
    }

    // MARK: - BART G2P Neural Fallback

    /// Use the CoreML BART encoder-decoder to phonemize an OOV word.
    private func bartG2P(_ word: String) -> String? {
        guard let encoder = g2pEncoder, let decoder = g2pDecoder else { return nil }
        guard !graphemeToId.isEmpty else { return nil }

        // Encode graphemes
        var inputIds: [Int32] = [Int32(g2pBosId)]
        for char in word {
            let s = String(char)
            if let id = graphemeToId[s] {
                inputIds.append(Int32(id))
            } else if let id = graphemeToId[s.lowercased()] {
                inputIds.append(Int32(id))
            } else {
                inputIds.append(Int32(graphemeToId["<unk>"] ?? 3))
            }
        }
        inputIds.append(Int32(g2pEosId))

        let seqLen = inputIds.count
        guard seqLen <= 64 else { return nil }

        do {
            // Run encoder
            let encInput = try MLMultiArray(shape: [1, seqLen as NSNumber], dataType: .int32)
            let encPtr = encInput.dataPointer.assumingMemoryBound(to: Int32.self)
            for i in 0..<seqLen { encPtr[i] = inputIds[i] }

            let encFeatures = try MLDictionaryFeatureProvider(dictionary: [
                "input_ids": MLFeatureValue(multiArray: encInput),
            ])
            let encOutput = try encoder.prediction(from: encFeatures)
            guard let hiddenStates = encOutput.featureValue(for: "encoder_hidden_states")?.multiArrayValue else {
                return nil
            }

            // Autoregressive decoding
            var decoderIds: [Int32] = [Int32(g2pBosId)]
            let maxDecLen = 64

            for step in 0..<maxDecLen {
                let decLen = decoderIds.count

                let decInput = try MLMultiArray(shape: [1, decLen as NSNumber], dataType: .int32)
                let decPtr = decInput.dataPointer.assumingMemoryBound(to: Int32.self)
                for i in 0..<decLen { decPtr[i] = decoderIds[i] }

                let posIds = try MLMultiArray(shape: [1, decLen as NSNumber], dataType: .int32)
                let posPtr = posIds.dataPointer.assumingMemoryBound(to: Int32.self)
                for i in 0..<decLen { posPtr[i] = Int32(i) }

                let mask = try MLMultiArray(shape: [1, decLen as NSNumber, decLen as NSNumber], dataType: .float32)
                let maskPtr = mask.dataPointer.assumingMemoryBound(to: Float.self)
                for i in 0..<decLen {
                    for j in 0..<decLen {
                        maskPtr[i * decLen + j] = (j <= i) ? 0.0 : -Float.greatestFiniteMagnitude
                    }
                }

                let decFeatures = try MLDictionaryFeatureProvider(dictionary: [
                    "decoder_input_ids": MLFeatureValue(multiArray: decInput),
                    "encoder_hidden_states": MLFeatureValue(multiArray: hiddenStates),
                    "position_ids": MLFeatureValue(multiArray: posIds),
                    "causal_mask": MLFeatureValue(multiArray: mask),
                ])

                let decOutput = try decoder.prediction(from: decFeatures)
                guard let logits = decOutput.featureValue(for: "logits")?.multiArrayValue else {
                    break
                }

                // Greedy: take argmax of last position
                let vocabSize = logits.shape.last!.intValue
                let lastOffset = step * vocabSize
                var maxId = 0
                var maxVal: Float = -.infinity
                if logits.dataType == .float16 {
                    let lPtr = logits.dataPointer.assumingMemoryBound(to: Float16.self)
                    for v in 0..<vocabSize {
                        let val = Float(lPtr[lastOffset + v])
                        if val > maxVal { maxVal = val; maxId = v }
                    }
                } else {
                    let lPtr = logits.dataPointer.assumingMemoryBound(to: Float.self)
                    for v in 0..<vocabSize {
                        let val = lPtr[lastOffset + v]
                        if val > maxVal { maxVal = val; maxId = v }
                    }
                }

                if maxId == g2pEosId { break }
                decoderIds.append(Int32(maxId))
            }

            // Convert IDs to phonemes
            var result = ""
            for id in decoderIds.dropFirst() { // skip BOS
                let intId = Int(id)
                if intId != g2pPadId && intId != g2pBosId && intId != g2pEosId,
                   let phoneme = idToPhoneme[intId] {
                    result += phoneme
                }
            }
            return result.isEmpty ? nil : result
        } catch {
            return nil
        }
    }

    // MARK: - Text Normalization

    private func normalizeText(_ text: String) -> String {
        var result = text
            .replacingOccurrences(of: "’", with: "'")
            .replacingOccurrences(of: "‘", with: "'")
            .replacingOccurrences(of: "—", with: ",")
            .replacingOccurrences(of: "–", with: ",")
        let contractions: [(String, String)] = [
            ("can't", "can not"), ("won't", "will not"), ("don't", "do not"),
            ("doesn't", "does not"), ("didn't", "did not"), ("isn't", "is not"),
            ("aren't", "are not"), ("wasn't", "was not"), ("weren't", "were not"),
            ("couldn't", "could not"), ("wouldn't", "would not"), ("shouldn't", "should not"),
            ("haven't", "have not"), ("hasn't", "has not"), ("hadn't", "had not"),
            ("i'm", "i am"), ("i've", "i have"), ("i'll", "i will"), ("i'd", "i would"),
            ("you're", "you are"), ("you've", "you have"), ("you'll", "you will"),
            ("he's", "he is"), ("she's", "she is"), ("it's", "it is"),
            ("we're", "we are"), ("we've", "we have"), ("we'll", "we will"),
            ("they're", "they are"), ("they've", "they have"), ("they'll", "they will"),
            ("that's", "that is"), ("there's", "there is"), ("let's", "let us"),
        ]
        let lower = result.lowercased()
        for (contraction, expansion) in contractions {
            if lower.contains(contraction) {
                result = result.replacingOccurrences(of: contraction, with: expansion, options: .caseInsensitive)
            }
        }
        while result.contains("  ") {
            result = result.replacingOccurrences(of: "  ", with: " ")
        }
        return result.trimmingCharacters(in: .whitespaces)
    }

    private func splitWords(_ text: String) -> [String] {
        var words: [String] = []
        var current = ""
        for char in text {
            if char.isWhitespace {
                if !current.isEmpty { words.append(current); current = "" }
                words.append(" ")
            } else if char.isPunctuation || char.isSymbol {
                if !current.isEmpty { words.append(current); current = "" }
                words.append(String(char))
            } else {
                current.append(char)
            }
        }
        if !current.isEmpty { words.append(current) }
        return words
    }

    private func punctuationToPhoneme(_ text: String) -> String? {
        switch text {
        case ",": return ","
        case ".": return "."
        case "!": return "!"
        case "?": return "?"
        case ";": return ";"
        case ":": return ":"
        case "-": return "-"
        case "'": return "'"
        default: return nil
        }
    }

    // MARK: - POS Tagging

    private func tagPOS(_ text: String) -> [String: String] {
        var result = [String: String]()
        tagger.string = text
        let range = text.startIndex..<text.endIndex
        tagger.enumerateTags(in: range, unit: .word, scheme: .lexicalClass) { tag, tokenRange in
            let word = String(text[tokenRange]).lowercased()
            if let tag { result[word] = tag.rawValue }
            return true
        }
        return result
    }

    // MARK: - Dictionary Parsing

    private func parseDictionary(from url: URL) throws -> [String: DictEntry] {
        let data = try Data(contentsOf: url)
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        var dict = [String: DictEntry]()
        for (key, value) in json {
            if let phonemes = value as? String {
                dict[key] = .simple(phonemes)
            } else if let posMap = value as? [String: String?] {
                var resolved = [String: String]()
                for (pos, pron) in posMap {
                    if let p = pron { resolved[pos] = p }
                }
                if !resolved.isEmpty { dict[key] = .heteronym(resolved) }
            }
        }
        return dict
    }

    private func growDictionary(_ dict: inout [String: DictEntry]) {
        var additions = [String: DictEntry]()
        for (key, entry) in dict {
            if key == key.lowercased() && !key.isEmpty {
                let capitalized = key.prefix(1).uppercased() + key.dropFirst()
                if dict[capitalized] == nil { additions[capitalized] = entry }
            }
            if key.first?.isUppercase == true {
                let lower = key.lowercased()
                if dict[lower] == nil { additions[lower] = entry }
            }
        }
        for (key, entry) in additions { dict[key] = entry }
    }
}
