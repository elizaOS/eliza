# Protocol value contracts

The `protocol`, `schema-types`, `permissions`, `task-events`, `task-widgets`, `speech` and `view-interaction` leaves expose renderer-safe DTOs and pure functions. Their complete declarations are pinned in [the public surface](./baseline/core-public-surface.json). Core owns message, content, entity, relationship, effect, model, plugin, trigger, notification, payment, view and connector contracts. Hosts own HTTP server registration and platform-specific configuration. Effect failures retain typed tags and causes at the public Promise boundary.

## Story: Share canonical values across hosts and plugins

As a consumer, I want serialized values and callback payloads to preserve their identity and validation rules across runtime boundaries.

### A public value retains identity and explicitly declared version

Event ids, run ids, agent ids, room ids, entity ids, parent ids and discriminants remain opaque exact values. Versioned backup and protocol schemas accept the declared version and reject another version before mutation. The source's optional fields remain optional.

```quint
type VersionedValue = { id: str, version: int, payload: str }
pure def versionAccepted(value: VersionedValue, expected: int): bool = value.version == expected
pure def preserveValue(value: VersionedValue): VersionedValue = value
pure val valueValues = Set({ id: "request-a", version: 1, payload: "body" })
pure def lawProtocolIdentity(value: VersionedValue): bool = preserveValue(value) == value
pure def lawVersionMismatchRejected(value: VersionedValue, expected: int): bool = value.version != expected implies not(versionAccepted(value, expected))
```

### Binary helpers preserve byte contents and the input slice ownership contract

`utils/buffer.ts` accepts Buffer and Uint8Array values. Buffer slicing retains Buffer's shared storage behavior, while Uint8Array slicing returns its standard copied representation. Hex conversion strips non-hex separators before decoding. UTF-8 and base64 conversions, zero-filled allocation and cryptographic random bytes retain the source behavior. Byte lists below describe content independently of representation ownership.

```quint
pure def sameBytes(left: List[int], right: List[int]): bool = left == right
pure def lawByteEqualityReflexive(bytes: List[int]): bool = sameBytes(bytes, bytes)
pure def lawByteEqualitySymmetric(left: List[int], right: List[int]): bool = sameBytes(left, right) == sameBytes(right, left)
```

## Story: Select localized examples from the owner's locale and recent message

As a caller I keep the owner's chosen locale when present. Otherwise I use
the recent message's locale hint, then my configured default, then English.

### Script priority and counted word hints determine the detected locale

The lexical adapter trims optional text. It reports kana in U+3040–U+30FF,
Han in U+4E00–U+9FFF, the exact tokens from
`trimmed.toLowerCase().match(/[\p{L}'-]+/gu)`, and whether either source
diacritic expression matched the trimmed text. Missing or empty text has no
tokens or marks. Tokenization, casing, trimming, and character classification
require host conformance against the [pinned helper](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/locale-detection.ts#L23-L169).

Kana wins before Han. Without either script, every matching word occurrence
adds one point to that language and its diacritic flag adds one point.
Repeated words count repeatedly. Spanish and French marks may both match.
A strictly higher score selects its language. Equal scores abstain.

```quint
type LocaleTextEvidence = { kana: bool, han: bool, tokens: List[str], spanishDiacritic: bool, frenchDiacritic: bool }
type LocaleDetection = LocaleUnknown | LocaleSpanish | LocaleFrench | LocaleJapanese | LocaleSimplifiedChinese
pure val spanishLocaleHints = Set("hola", "gracias", "por", "favor", "que", "qué", "cómo", "como", "dónde", "donde", "cuándo", "cuando", "buenos", "buenas", "días", "tardes", "noches", "está", "estoy", "estás", "recordar", "recordame", "recuérdame", "agrega", "agregar", "añade", "añadir", "para", "mañana", "hoy", "ayer", "semana")
pure val frenchLocaleHints = Set("bonjour", "merci", "oui", "non", "très", "avec", "pour", "dans", "mais", "ajoute", "ajouter", "rappelle", "rappelle-moi", "matin", "soir", "semaine", "aujourd", "aujourd'hui", "demain", "hier", "être", "avoir")
pure val emptyLocaleText: LocaleTextEvidence = {kana: false, han: false, tokens: List(), spanishDiacritic: false, frenchDiacritic: false}
pure def localeHintScore(tokens: List[str], hints: Set[str], marked: bool): int =
  tokens.select(word => hints.contains(word)).length() + (if (marked) 1 else 0)
pure def detectLocaleEvidence(evidence: LocaleTextEvidence): LocaleDetection = {
  val spanish = localeHintScore(evidence.tokens, spanishLocaleHints, evidence.spanishDiacritic)
  val french = localeHintScore(evidence.tokens, frenchLocaleHints, evidence.frenchDiacritic)
  if (evidence.kana) LocaleJapanese
  else if (evidence.han) LocaleSimplifiedChinese
  else if (spanish > french) LocaleSpanish
  else if (french > spanish) LocaleFrench
  else LocaleUnknown
}
pure val evidenceValues = Set(emptyLocaleText,
  { ...emptyLocaleText, kana: true, han: true },
  { ...emptyLocaleText, han: true },
  { ...emptyLocaleText, tokens: List("hola", "hola", "bonjour") },
  { ...emptyLocaleText, tokens: List("hola", "bonjour") },
  { ...emptyLocaleText, spanishDiacritic: true, frenchDiacritic: true })
pure val tokensValues = Set(List(), List("hola"), List("hola", "hola"), List("bonjour", "hola"))
pure val hintsValues = Set(spanishLocaleHints, frenchLocaleHints, Set(), Set("hola"))
pure val wordValues = Set("hola", "bonjour", "unknown")
pure def lawEmptyLocaleTextAbstains(evidence: LocaleTextEvidence): bool =
  evidence == emptyLocaleText implies detectLocaleEvidence(evidence) == LocaleUnknown
pure def lawKanaDeterminesLocale(evidence: LocaleTextEvidence): bool =
  evidence.kana implies detectLocaleEvidence(evidence) == LocaleJapanese
pure def lawHanDeterminesLocaleWithoutKana(evidence: LocaleTextEvidence): bool =
  not(evidence.kana) and evidence.han implies detectLocaleEvidence(evidence) == LocaleSimplifiedChinese
pure def lawHigherLocaleScoreWins(evidence: LocaleTextEvidence): bool = {
  val spanish = localeHintScore(evidence.tokens, spanishLocaleHints, evidence.spanishDiacritic)
  val french = localeHintScore(evidence.tokens, frenchLocaleHints, evidence.frenchDiacritic)
  not(evidence.kana) and not(evidence.han) implies
    (if (spanish > french) detectLocaleEvidence(evidence) == LocaleSpanish
     else if (french > spanish) detectLocaleEvidence(evidence) == LocaleFrench
     else detectLocaleEvidence(evidence) == LocaleUnknown)
}
pure def lawLocaleHintOccurrencesAreCounted(tokens: List[str], hints: Set[str], marked: bool, word: str): bool =
  localeHintScore(tokens.append(word), hints, marked) == localeHintScore(tokens, hints, marked) + (if (hints.contains(word)) 1 else 0)
```

### The owner locale wins before detection and configured defaults

The adapter supplies the exact trimmed owner and default strings, with the
empty string for a missing value. Arbitrary nonempty locale tags pass through
without pack validation or case conversion. A detected locale wins when the
owner is absent. A nonempty default wins after an abstention. Otherwise the
result is `en`.

```quint
type LocaleResolution = { trimmedOwner: str, recent: LocaleTextEvidence, trimmedDefault: str }
pure val inputValues = Set(
  { trimmedOwner: "pt-BR", recent: { ...emptyLocaleText, kana: true }, trimmedDefault: "fr" },
  { trimmedOwner: "pt-BR", recent: emptyLocaleText, trimmedDefault: "fr" },
  { trimmedOwner: "", recent: { ...emptyLocaleText, kana: true }, trimmedDefault: "fr" },
  { trimmedOwner: "", recent: { ...emptyLocaleText, kana: true, han: true }, trimmedDefault: "fr" },
  { trimmedOwner: "", recent: { ...emptyLocaleText, tokens: List("hola", "hola", "bonjour") }, trimmedDefault: "fr" },
  { trimmedOwner: "", recent: emptyLocaleText, trimmedDefault: "fr-CA" },
  { trimmedOwner: "", recent: emptyLocaleText, trimmedDefault: "custom-TAG" },
  { trimmedOwner: "", recent: emptyLocaleText, trimmedDefault: "" })
pure def detectedLocaleTag(detected: LocaleDetection): str =
  match detected {
    | LocaleUnknown => ""
    | LocaleSpanish => "es"
    | LocaleFrench => "fr"
    | LocaleJapanese => "ja"
    | LocaleSimplifiedChinese => "zh-Hans"
  }
pure def resolveLocaleEvidence(input: LocaleResolution): str = {
  val detected = detectedLocaleTag(detectLocaleEvidence(input.recent))
  if (input.trimmedOwner != "") input.trimmedOwner
  else if (detected != "") detected
  else if (input.trimmedDefault != "") input.trimmedDefault
  else "en"
}
pure def lawOwnerLocaleWins(input: LocaleResolution): bool =
  input.trimmedOwner != "" implies resolveLocaleEvidence(input) == input.trimmedOwner
pure def lawDetectedLocaleWinsWithoutOwner(input: LocaleResolution): bool = {
  val detected = detectedLocaleTag(detectLocaleEvidence(input.recent))
  input.trimmedOwner == "" and detected != "" implies resolveLocaleEvidence(input) == detected
}
pure def lawDefaultLocaleFollowsAbstention(input: LocaleResolution): bool =
  input.trimmedOwner == "" and detectLocaleEvidence(input.recent) == LocaleUnknown and input.trimmedDefault != "" implies
    resolveLocaleEvidence(input) == input.trimmedDefault
pure def lawEnglishFillsMissingLocale(input: LocaleResolution): bool =
  input.trimmedOwner == "" and detectLocaleEvidence(input.recent) == LocaleUnknown and input.trimmedDefault == "" implies
    resolveLocaleEvidence(input) == "en"
pure def lawResolvedLocaleIsNonempty(input: LocaleResolution): bool = resolveLocaleEvidence(input) != ""
```

## Story: Match catalog keywords without changing their authored identity or order

As a caller I match normalized text against catalog vocabulary, retain each
authored spelling in match results, and select the longest original spelling
when I request one match.

The host applies `normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()`
and supplies the resulting UTF-16 code units, including lone surrogates.
Original terms also retain their exact UTF-16 units. Document entries arrive
in `/\n+/` split order with their original spelling trimmed. Normalization,
splitting, trimming, and UTF-16 conversion require conformance against the
[pinned helper](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/i18n/keyword-matching.ts#L34-L261).
The rules below cover built-in prepared entries. Caller-authored public
`PreparedKeywordTerm.matches` callbacks retain their own invocation, result,
and failure contract. Catalog lookup and locale selection remain host
boundaries: the catalog helper alone selects base terms, the public wrapper
normalizes an absent or unknown locale to English, and all-locales lookup
uses base followed by locale-value insertion order before document deduplication.

### Literal keyword spans use both ASCII boundaries only for eligible terms

An empty normalized term never matches. The complete normalized term uses
boundary matching exactly when it satisfies `/^[a-z0-9][a-z0-9' -]*$/i`.
Both ends of a literal occurrence must then change ASCII word membership;
ASCII letters, digits, and underscore are word characters. Bounded matching
ignores ASCII letter case. Other terms use exact literal substring matching.
Metacharacters remain literal. A trailing hyphen or apostrophe still needs
an ending boundary: `pay-` matches `pay-x` but does not match `pay-`.

```quint
type KeywordSourceTerm = { raw: List[int], normalized: List[int] }
type KeywordPattern = EmptyKeyword | BoundedKeyword({ units: List[int] }) | SubstringKeyword({ units: List[int] })
type PreparedKeyword = { raw: List[int], pattern: KeywordPattern }
type KeywordScan = { position: int, matched: bool }
pure def keywordAsciiLower(unit: int): int = if (unit >= 65 and unit <= 90) unit + 32 else unit
pure def keywordAsciiAlphanumeric(unit: int): bool = {
  val lowered = keywordAsciiLower(unit)
  (lowered >= 97 and lowered <= 122) or (unit >= 48 and unit <= 57)
}
pure def keywordUsesAsciiBoundaries(units: List[int]): bool =
  units.length() > 0 and keywordAsciiAlphanumeric(units.nthOr(0, -1)) and
    units.every(unit => keywordAsciiAlphanumeric(unit) or unit == 39 or unit == 32 or unit == 45)
pure def compileKeywordPattern(units: List[int]): KeywordPattern =
  if (units.length() == 0) EmptyKeyword
  else if (keywordUsesAsciiBoundaries(units)) BoundedKeyword({ units: units })
  else SubstringKeyword({ units: units })
pure def keywordWordAt(text: List[int], position: int): bool = {
  val unit = text.nthOr(position, -1)
  keywordAsciiAlphanumeric(unit) or unit == 95
}
pure def keywordBoundaryAt(text: List[int], position: int): bool =
  keywordWordAt(text, position - 1) != keywordWordAt(text, position)
pure def keywordLiteralAt(text: List[int], units: List[int], position: int, bounded: bool): bool =
  units.length() > 0 and position >= 0 and position + units.length() <= text.length() and
    units.foldl({ position: position, matched: true }, (scan, unit) => {
      position: scan.position + 1,
      matched: scan.matched and
        (if (bounded) keywordAsciiLower(text.nthOr(scan.position, -1)) == keywordAsciiLower(unit)
         else text.nthOr(scan.position, -1) == unit)
    }).matched
pure def keywordOccurrenceAt(text: List[int], units: List[int], position: int, bounded: bool): bool =
  keywordLiteralAt(text, units, position, bounded) and
    (not(bounded) or (keywordBoundaryAt(text, position) and keywordBoundaryAt(text, position + units.length())))
pure def keywordHasOccurrence(text: List[int], units: List[int], bounded: bool): bool =
  text.foldl({ position: 0, matched: false }, (scan, unit) => {
    position: scan.position + 1,
    matched: scan.matched or keywordOccurrenceAt(text, units, scan.position, bounded)
  }).matched
pure def matchesKeywordPattern(text: List[int], pattern: KeywordPattern): bool =
  match pattern {
    | EmptyKeyword => false
    | BoundedKeyword(term) => keywordHasOccurrence(text, term.units, true)
    | SubstringKeyword(term) => keywordHasOccurrence(text, term.units, false)
  }
pure val patternValues = Set(EmptyKeyword, BoundedKeyword({ units: List(112, 97, 121) }), BoundedKeyword({ units: List(112, 97, 121, 45) }), SubstringKeyword({ units: List(97, 95, 98) }), SubstringKeyword({ units: List(55357) }))
pure val unitsValues = Set(List(), List(112, 97, 121), List(112, 97, 121, 45), List(112, 97, 121, 39), List(97, 95, 98), List(97, 46, 98), List(55357))
pure val textValues = Set(List(), List(112, 97, 121), List(112, 97, 121, 45), List(112, 97, 121, 45, 120), List(95, 112, 97, 121), List(233, 112, 97, 121, 233), List(120, 97, 95, 98, 121), List(55357, 56832))
pure def lawEmptyKeywordNeverMatches(text: List[int]): bool = not(matchesKeywordPattern(text, compileKeywordPattern(List())))
pure def lawKeywordCompilationFollowsWholeTerm(units: List[int]): bool = {
  val compiled = compileKeywordPattern(units)
  match compiled {
    | EmptyKeyword => units.length() == 0
    | BoundedKeyword(term) => units.length() > 0 and keywordUsesAsciiBoundaries(units) and term.units == units
    | SubstringKeyword(term) => units.length() > 0 and not(keywordUsesAsciiBoundaries(units)) and term.units == units
  }
}
pure def lawKeywordBoundaryIsWordChange(text: List[int], position: int): bool =
  keywordBoundaryAt(text, position) == (keywordWordAt(text, position - 1) != keywordWordAt(text, position))
pure def lawKeywordMatchingUsesLiteralEndpoints(text: List[int], units: List[int]): bool =
  matchesKeywordPattern(text, compileKeywordPattern(units)) ==
    keywordHasOccurrence(text, units, keywordUsesAsciiBoundaries(units))
```

### Preparation deduplicates raw spellings while documents deduplicate normalized spellings

Preparation retains the first entry for each exact raw term, including the
empty term. Its empty normalized pattern never matches. Document splitting
skips empty trimmed entries and retains the first trimmed spelling for each
normalized key. Distinct authored spellings that normalize alike therefore
remain distinct prepared terms but collapse in a keyword document.

```quint
type KeywordDocument = { keys: List[List[int]], spellings: List[List[int]] }
pure def appendPreparedKeyword(prepared: List[PreparedKeyword], term: KeywordSourceTerm): List[PreparedKeyword] =
  if (prepared.some(entry => entry.raw == term.raw)) prepared
  else prepared.append({ raw: term.raw, pattern: compileKeywordPattern(term.normalized) })
pure def prepareKeywordEntries(terms: List[KeywordSourceTerm]): List[PreparedKeyword] =
  terms.foldl(List(), (prepared, term) => appendPreparedKeyword(prepared, term))
pure def appendKeywordDocument(document: KeywordDocument, term: KeywordSourceTerm): KeywordDocument =
  if (term.raw.length() == 0 or document.keys.includes(term.normalized)) document
  else { keys: document.keys.append(term.normalized), spellings: document.spellings.append(term.raw) }
pure def keywordDocumentEntries(terms: List[KeywordSourceTerm]): KeywordDocument =
  terms.foldl({ keys: List(), spellings: List() }, (document, term) => appendKeywordDocument(document, term))
pure def splitKeywordEntries(terms: List[KeywordSourceTerm]): List[List[int]] = keywordDocumentEntries(terms).spellings
pure val termValues = Set(
  { raw: List(), normalized: List() },
  { raw: List(112, 97, 121), normalized: List(112, 97, 121) },
  { raw: List(80, 65, 89), normalized: List(112, 97, 121) },
  { raw: List(32, 112, 97, 121, 32), normalized: List(112, 97, 121) },
  { raw: List(112, 97, 121, 45), normalized: List(112, 97, 121, 45) })
pure val termsValues = Set(List(),
  List({ raw: List(112, 97, 121), normalized: List(112, 97, 121) }),
  List({ raw: List(80, 65, 89), normalized: List(112, 97, 121) }, { raw: List(112, 97, 121), normalized: List(112, 97, 121) }),
  List({ raw: List(112, 97, 121), normalized: List(112, 97, 121) }, { raw: List(112, 97, 121), normalized: List(112, 97, 121) }),
  List({ raw: List(), normalized: List() }, { raw: List(80, 65, 89), normalized: List(112, 97, 121) }))
pure val preparedValues = termsValues.map(terms => prepareKeywordEntries(terms))
pure val documentValues = Set({ keys: List(), spellings: List() }, { keys: List(List(112, 97, 121)), spellings: List(List(80, 65, 89)) })
pure def lawPreparedKeywordAppend(terms: List[KeywordSourceTerm], term: KeywordSourceTerm): bool =
  prepareKeywordEntries(terms.append(term)) == appendPreparedKeyword(prepareKeywordEntries(terms), term)
pure def lawRepeatedPreparedRawIsUnchanged(prepared: List[PreparedKeyword], term: KeywordSourceTerm): bool =
  prepared.some(entry => entry.raw == term.raw) implies appendPreparedKeyword(prepared, term) == prepared
pure def lawNewPreparedRawAppendsOnce(prepared: List[PreparedKeyword], term: KeywordSourceTerm): bool =
  not(prepared.some(entry => entry.raw == term.raw)) implies
    appendPreparedKeyword(prepared, term) == prepared.append({ raw: term.raw, pattern: compileKeywordPattern(term.normalized) })
pure def lawKeywordDocumentAppend(terms: List[KeywordSourceTerm], term: KeywordSourceTerm): bool =
  keywordDocumentEntries(terms.append(term)) == appendKeywordDocument(keywordDocumentEntries(terms), term)
pure def lawDuplicateOrEmptyDocumentEntryIsSkipped(document: KeywordDocument, term: KeywordSourceTerm): bool =
  term.raw.length() == 0 or document.keys.includes(term.normalized) implies appendKeywordDocument(document, term) == document
pure def lawNewDocumentKeyRetainsSpelling(document: KeywordDocument, term: KeywordSourceTerm): bool =
  term.raw.length() > 0 and not(document.keys.includes(term.normalized)) implies
    appendKeywordDocument(document, term) == { keys: document.keys.append(term.normalized), spellings: document.spellings.append(term.raw) }
```

### Collected matches keep text-first order and longest selection keeps the first length tie

Each nonempty normalized text visits prepared entries in order. A match adds
its exact raw spelling once, after earlier matches. Later texts preserve that
prefix. Existence asks whether any built-in pattern matches a nonempty text.
Single-match selection visits original terms in order and replaces a match
only when a later matching raw term has a strictly greater UTF-16 length.
Equal lengths keep the first term. Raw padding or decomposition can therefore
make a spelling win over a shorter normalized-equivalent spelling.

```quint
type KeywordChoice = NoKeyword | ChosenKeyword({ raw: List[int] })
pure def appendKeywordMatch(found: List[List[int]], text: List[int], entry: PreparedKeyword): List[List[int]] =
  if (text.length() > 0 and matchesKeywordPattern(text, entry.pattern) and not(found.includes(entry.raw))) found.append(entry.raw)
  else found
pure def collectKeywordText(found: List[List[int]], text: List[int], prepared: List[PreparedKeyword]): List[List[int]] =
  prepared.foldl(found, (matches, entry) => appendKeywordMatch(matches, text, entry))
pure def collectKeywordMatches(texts: List[List[int]], prepared: List[PreparedKeyword]): List[List[int]] =
  texts.foldl(List(), (matches, text) => collectKeywordText(matches, text, prepared))
pure def hasKeywordMatch(texts: List[List[int]], prepared: List[PreparedKeyword]): bool =
  texts.some(text => text.length() > 0 and prepared.some(entry => matchesKeywordPattern(text, entry.pattern)))
pure def chooseKeywordMatch(choice: KeywordChoice, text: List[int], term: KeywordSourceTerm): KeywordChoice =
  if (not(matchesKeywordPattern(text, compileKeywordPattern(term.normalized)))) choice
  else match choice {
    | NoKeyword => ChosenKeyword({ raw: term.raw })
    | ChosenKeyword(previous) => if (term.raw.length() > previous.raw.length()) ChosenKeyword({ raw: term.raw }) else choice
  }
pure def longestKeywordMatch(text: List[int], terms: List[KeywordSourceTerm]): KeywordChoice =
  terms.foldl(NoKeyword, (choice, term) => chooseKeywordMatch(choice, text, term))
pure val entryValues = Set({ raw: List(112, 97, 121), pattern: BoundedKeyword({ units: List(112, 97, 121) }) }, { raw: List(), pattern: EmptyKeyword })
pure val foundValues = Set(List(), List(List(112, 97, 121)))
pure val choiceValues = Set(NoKeyword, ChosenKeyword({ raw: List(112, 97, 121) }))
pure val previousValues = Set(List(), List(112, 97, 121), List(32, 112, 97, 121, 32))
pure val textsValues = Set(List(), List(List()), List(List(112, 97, 121)), List(List(112, 97, 121, 45), List(112, 97, 121, 45, 120)))
pure def lawKeywordExistenceMatchesCollection(texts: List[List[int]], prepared: List[PreparedKeyword]): bool =
  hasKeywordMatch(texts, prepared) == (collectKeywordMatches(texts, prepared).length() > 0)
pure def lawFirstMatchingKeywordIsSelected(text: List[int], term: KeywordSourceTerm): bool = {
  val chosen = chooseKeywordMatch(NoKeyword, text, term)
  matchesKeywordPattern(text, compileKeywordPattern(term.normalized)) implies match chosen {
    | NoKeyword => false
    | ChosenKeyword(selected) => selected.raw == term.raw
  }
}
pure def lawLongestKeywordIsAMaximalMatch(text: List[int], terms: List[KeywordSourceTerm]): bool = {
  val chosen = longestKeywordMatch(text, terms)
  match chosen {
    | NoKeyword => not(terms.some(term => matchesKeywordPattern(text, compileKeywordPattern(term.normalized))))
    | ChosenKeyword(selected) =>
      terms.some(term => term.raw == selected.raw and matchesKeywordPattern(text, compileKeywordPattern(term.normalized))) and
      terms.every(term => matchesKeywordPattern(text, compileKeywordPattern(term.normalized)) implies term.raw.length() <= selected.raw.length())
  }
}
pure def lawCollectedKeywordTextAppend(texts: List[List[int]], text: List[int], prepared: List[PreparedKeyword]): bool =
  collectKeywordMatches(texts.append(text), prepared) == collectKeywordText(collectKeywordMatches(texts, prepared), text, prepared)
pure def lawKeywordMatchAddsOnlyNewRaw(found: List[List[int]], text: List[int], entry: PreparedKeyword): bool =
  appendKeywordMatch(found, text, entry) ==
    (if (text.length() > 0 and matchesKeywordPattern(text, entry.pattern) and not(found.includes(entry.raw))) found.append(entry.raw) else found)
pure def lawLongestKeywordAppend(text: List[int], terms: List[KeywordSourceTerm], term: KeywordSourceTerm): bool =
  longestKeywordMatch(text, terms.append(term)) == chooseKeywordMatch(longestKeywordMatch(text, terms), text, term)
pure def lawNonmatchingKeywordKeepsChoice(choice: KeywordChoice, text: List[int], term: KeywordSourceTerm): bool =
  not(matchesKeywordPattern(text, compileKeywordPattern(term.normalized))) implies chooseKeywordMatch(choice, text, term) == choice
pure def lawKeywordLengthTiesKeepEarlierChoice(text: List[int], term: KeywordSourceTerm, previous: List[int]): bool = {
  val chosen = chooseKeywordMatch(ChosenKeyword({ raw: previous }), text, term)
  term.raw.length() <= previous.length() implies match chosen {
    | NoKeyword => false
    | ChosenKeyword(selected) => selected.raw == previous
  }
}
pure def lawLongerMatchingKeywordWins(text: List[int], term: KeywordSourceTerm, previous: List[int]): bool = {
  val chosen = chooseKeywordMatch(ChosenKeyword({ raw: previous }), text, term)
  matchesKeywordPattern(text, compileKeywordPattern(term.normalized)) and term.raw.length() > previous.length() implies match chosen {
    | NoKeyword => false
    | ChosenKeyword(selected) => selected.raw == term.raw
  }
}
```
