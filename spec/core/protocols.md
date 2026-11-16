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
