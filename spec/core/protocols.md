# Protocol value contracts

The renderer-safe `protocol`, `schema-types`, `permissions`, `task-events`, `task-widgets`, `speech` and `view-interaction` leaves expose DTOs and pure functions whose declarations are pinned in [the public surface](./baseline/core-public-surface.json). Connector accounts are [account lifecycle and storage](./connectorStorage.md), the capability catalog is [capability routing](./capabilityRouting.md) and the device bridge is [device bridge](./deviceBridge.md). Hosts own HTTP server registration and platform configuration. Effect failures keep their typed tags and causes at the public Promise boundary. The binary helpers in `utils/buffer.ts` accept Buffer and Uint8Array values and keep the platform's storage contract: a Buffer slice shares the source's storage, a Uint8Array slice is a copy, hex decoding strips non-hex separators, and UTF-8, base64, zero-filled allocation and cryptographic random bytes keep the source behavior.

## Story: Share canonical values across hosts and plugins

> As a consumer, I want serialized values and callback payloads to keep
> their identity and validation rules across runtime boundaries, so that a
> host and a plugin read the same value.

### A store holds only values of the version it declares

Versioned backup and protocol schemas accept the declared version and reject
any other before mutation, so a rejected value leaves the store unchanged and
a store never holds a value of another version. Event, run, agent, room,
entity and parent ids and discriminants pass through as opaque exact values,
and optional fields stay optional.

```quint
type VersionedValue = { id: str, version: int, payload: str }
pure def versionAccepted(value: VersionedValue, expected: int): bool = value.version == expected
pure def admitVersioned(stored: List[VersionedValue], value: VersionedValue, expected: int): List[VersionedValue] =
  if (versionAccepted(value, expected)) stored.append(value) else stored
pure val valueValues = Set({ id: "request-a", version: 1, payload: "body" }, { id: "request-a", version: 2, payload: "body" })
pure val storedValues = Set(List(), List({ id: "request-b", version: 1, payload: "kept" }))
pure val expectedValues = Set(1, 2)
pure def lawStoreHoldsOnlyTheDeclaredVersion(stored: List[VersionedValue], value: VersionedValue, expected: int): bool =
  stored.every(v => v.version == expected) implies admitVersioned(stored, value, expected).every(v => v.version == expected)
pure def lawAdmittedValueIsStoredExactly(stored: List[VersionedValue], value: VersionedValue, expected: int): bool =
  versionAccepted(value, expected) implies admitVersioned(stored, value, expected) == stored.append(value)
pure def lawRejectedValueLeavesStoreUnchanged(stored: List[VersionedValue], value: VersionedValue, expected: int): bool =
  not(versionAccepted(value, expected)) implies admitVersioned(stored, value, expected) == stored
```

### Hex decoding ignores separators and returns the bytes that hex encoding wrote

`fromHex` removes every character outside `[0-9a-fA-F]` before decoding, so
separators such as `:`, `-` and spaces change nothing. Each pair of remaining
digits is one byte, high digit first, in either case. A final unpaired digit
is dropped, as Node's hex decoder drops it. `toHex` writes each byte as two
lowercase digits, and decoding that text returns the same bytes. Text is
given as character codes and bytes as integers from 0 to 255.

```quint
type HexDecoding = { decoded: List[int], high: int }
pure def isHexCode(code: int): bool = (code >= 48 and code <= 57) or (code >= 65 and code <= 70) or (code >= 97 and code <= 102)
pure def hexCodeValue(code: int): int = if (code <= 57) code - 48 else if (code <= 70) code - 55 else code - 87
pure def hexDigitCode(digit: int): int = if (digit < 10) 48 + digit else 87 + digit
pure def stripHexSeparators(hexText: List[int]): List[int] = hexText.select(code => isHexCode(code))
pure def decodeHexDigit(decoding: HexDecoding, code: int): HexDecoding =
  if (decoding.high < 0) { decoded: decoding.decoded, high: hexCodeValue(code) }
  else { decoded: decoding.decoded.append(decoding.high * 16 + hexCodeValue(code)), high: -1 }
pure def decodeHex(hexText: List[int]): List[int] =
  stripHexSeparators(hexText).foldl({ decoded: List(), high: -1 }, (decoding, code) => decodeHexDigit(decoding, code)).decoded
pure def encodeHex(byteList: List[int]): List[int] =
  byteList.foldl(List(), (codes, value) => codes.append(hexDigitCode(value / 16)).append(hexDigitCode(value % 16)))
pure def allBytes(byteList: List[int]): bool = byteList.every(value => value >= 0 and value <= 255)
pure val hexTextValues = Set(List(), List(48, 48, 58, 49, 65, 45, 102, 102), List(97, 98, 99), List(70, 32, 48))
pure val beforeValues = hexTextValues
pure val afterValues = hexTextValues
pure val separatorValues = Set(58, 45, 32, 103, 97, 70)
pure val byteListValues = Set(List(), List(0), List(255, 16, 1), List(171, 205), List(256))
pure def lawHexSeparatorIsIgnored(before: List[int], after: List[int], separator: int): bool =
  not(isHexCode(separator)) implies decodeHex(before.append(separator).concat(after)) == decodeHex(before.concat(after))
pure def lawHexRoundTripReturnsTheBytes(byteList: List[int]): bool =
  allBytes(byteList) implies decodeHex(encodeHex(byteList)) == byteList
```

### A UUID input is returned unchanged and any other input derives a version-0 UUID

`validateUuid` accepts exactly 36 characters: hex digits in either case,
with hyphens at positions 8, 13, 18 and 23, and any version digit.
`uuidFromString` returns such an input unchanged and does not hash it; a
number is first converted with `toString`. Any other input derives its UUID
from the first 16 bytes of the SHA-1 digest of `encodeURIComponent(input)`:
byte 6 keeps only its low four bits, so the version digit is `0` (the
elizaOS form, not version 5), and byte 8 keeps its low six bits under the
RFC 4122 variant bits `10`. The bytes are written as lowercase hex in the
8-4-4-4-12 form. `stringToUuid` supplies the Node SHA-1 digest, so the same
input always gives the same UUID, and a derived UUID passed in again is
returned unchanged. SHA-1 and URI encoding are host boundaries; text is
given as character codes and the digest as its bytes.

```quint
pure val uuidPositions = List(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35)
pure def uuidHyphenAt(index: int): bool = index == 8 or index == 13 or index == 18 or index == 23
pure def isUuidText(uuidText: List[int]): bool =
  uuidText.length() == 36 and
    uuidPositions.every(index => if (uuidHyphenAt(index)) uuidText.nthOr(index, -1) == 45 else isHexCode(uuidText.nthOr(index, -1)))
pure def uuidBytesFromDigest(digest: List[int]): List[int] =
  List(digest.nthOr(0, 0), digest.nthOr(1, 0), digest.nthOr(2, 0), digest.nthOr(3, 0), digest.nthOr(4, 0), digest.nthOr(5, 0), digest.nthOr(6, 0) % 16, digest.nthOr(7, 0), digest.nthOr(8, 0) % 64 + 128, digest.nthOr(9, 0), digest.nthOr(10, 0), digest.nthOr(11, 0), digest.nthOr(12, 0), digest.nthOr(13, 0), digest.nthOr(14, 0), digest.nthOr(15, 0))
pure def formatUuidBytes(uuidBytes: List[int]): List[int] =
  List(hexDigitCode(uuidBytes.nthOr(0, 0) / 16), hexDigitCode(uuidBytes.nthOr(0, 0) % 16), hexDigitCode(uuidBytes.nthOr(1, 0) / 16), hexDigitCode(uuidBytes.nthOr(1, 0) % 16), hexDigitCode(uuidBytes.nthOr(2, 0) / 16), hexDigitCode(uuidBytes.nthOr(2, 0) % 16), hexDigitCode(uuidBytes.nthOr(3, 0) / 16), hexDigitCode(uuidBytes.nthOr(3, 0) % 16), 45,
    hexDigitCode(uuidBytes.nthOr(4, 0) / 16), hexDigitCode(uuidBytes.nthOr(4, 0) % 16), hexDigitCode(uuidBytes.nthOr(5, 0) / 16), hexDigitCode(uuidBytes.nthOr(5, 0) % 16), 45,
    hexDigitCode(uuidBytes.nthOr(6, 0) / 16), hexDigitCode(uuidBytes.nthOr(6, 0) % 16), hexDigitCode(uuidBytes.nthOr(7, 0) / 16), hexDigitCode(uuidBytes.nthOr(7, 0) % 16), 45,
    hexDigitCode(uuidBytes.nthOr(8, 0) / 16), hexDigitCode(uuidBytes.nthOr(8, 0) % 16), hexDigitCode(uuidBytes.nthOr(9, 0) / 16), hexDigitCode(uuidBytes.nthOr(9, 0) % 16), 45,
    hexDigitCode(uuidBytes.nthOr(10, 0) / 16), hexDigitCode(uuidBytes.nthOr(10, 0) % 16), hexDigitCode(uuidBytes.nthOr(11, 0) / 16), hexDigitCode(uuidBytes.nthOr(11, 0) % 16), hexDigitCode(uuidBytes.nthOr(12, 0) / 16), hexDigitCode(uuidBytes.nthOr(12, 0) % 16), hexDigitCode(uuidBytes.nthOr(13, 0) / 16), hexDigitCode(uuidBytes.nthOr(13, 0) % 16), hexDigitCode(uuidBytes.nthOr(14, 0) / 16), hexDigitCode(uuidBytes.nthOr(14, 0) % 16), hexDigitCode(uuidBytes.nthOr(15, 0) / 16), hexDigitCode(uuidBytes.nthOr(15, 0) % 16))
pure def uuidFromDigest(uuidText: List[int], digest: List[int]): List[int] =
  if (isUuidText(uuidText)) uuidText else formatUuidBytes(uuidBytesFromDigest(digest))
pure val uuidTextValues = Set(List(), List(97, 45, 98),
  List(53, 53, 48, 69, 56, 52, 48, 48, 45, 101, 50, 57, 98, 45, 52, 49, 100, 52, 45, 65, 55, 49, 54, 45, 52, 52, 54, 54, 53, 53, 52, 52, 48, 48, 48, 48),
  List(53, 53, 48, 69, 56, 52, 48, 48, 45, 101, 50, 57, 98, 45, 52, 49, 100, 52, 45, 65, 55, 49, 54, 45, 52, 52, 54, 54, 53, 53, 52, 52, 48, 48, 48, 103))
pure val digestValues = Set(List(), List(255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255),
  List(0, 1, 2, 3, 4, 5, 102, 7, 63, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19), List(-1, 300))
pure val againValues = Set(List(), List(1, 2, 3))
pure val digestIndexValues = Set(0, 5, 6, 7, 8, 15, 16)
pure def lawUuidInputIsReturnedUnchanged(uuidText: List[int], digest: List[int]): bool =
  isUuidText(uuidText) implies uuidFromDigest(uuidText, digest) == uuidText
pure def lawDerivedUuidHasVersionZeroAndVariantBits(digest: List[int]): bool = {
  val derived = uuidBytesFromDigest(digest)
  allBytes(digest) implies
    derived.length() == 16 and derived.nthOr(6, -1) >= 0 and derived.nthOr(6, -1) < 16 and
      derived.nthOr(8, -1) >= 128 and derived.nthOr(8, -1) < 192
}
pure def lawDerivedUuidKeepsTheOtherDigestBytes(digest: List[int], digestIndex: int): bool =
  digestIndex >= 0 and digestIndex < 16 and digestIndex != 6 and digestIndex != 8 implies
    uuidBytesFromDigest(digest).nthOr(digestIndex, -1) == digest.nthOr(digestIndex, 0)
pure def lawDerivedUuidIsAValidUuid(digest: List[int]): bool =
  allBytes(digest) implies isUuidText(formatUuidBytes(uuidBytesFromDigest(digest)))
pure def lawUuidDerivationIsIdempotent(uuidText: List[int], digest: List[int], again: List[int]): bool =
  allBytes(digest) implies uuidFromDigest(uuidFromDigest(uuidText, digest), again) == uuidFromDigest(uuidText, digest)
```

### A seeded shuffle keeps every item and samples and picks take only shuffled items

`deterministicShuffle` copies the items and, for each slot from the last
down to 1, swaps that slot with a pick drawn from `createDeterministicRandom`
at or below it. The same seed draws the same picks, so it gives the same
order; the swaps only move items, so every item keeps its count. A swap whose
slot or pick lies outside the list changes nothing. `deterministicSample`
returns nothing for a count of 0 or less or for no items, and otherwise the
first `min(count, length)` shuffled items. `deterministicPick` is the first
shuffled item, or nothing for no items. `getDeterministicNames` returns
nothing for a count of 0 or less, and otherwise `count` names cycling
through the example names shuffled with the seed
`buildDeterministicSeed(seed, "names")`, with `user<i+1>` for an empty
name at position i, counting positions from 0. `buildDeterministicSeed`
trims each part, reads a missing part as empty, drops empty parts and joins
the rest with `::`, or returns `default` when none is left. The Quint takes
the parts already trimmed, with a missing part as empty; trimming and the
`::` join are host string operations. The random generator, the
FNV-1a `hashStringToUint32` and `stableStringify` (object keys sorted by
UTF-16 code units at every depth, arrays in order, dates through their
`toJSON`) require host conformance against the
[pinned helper](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/utils/deterministic.ts#L5-L128).

```quint
type ShuffleScan = { slotIndex: int, swapped: List[str] }
type ShuffleSwap = { slot: int, pick: int }
type DeterministicPick = NoPick | Picked({ member: str })
pure def swapItems(items: List[str], slot: int, pick: int): List[str] =
  items.foldl({ slotIndex: 0, swapped: List() }, (scan, member) => {
    slotIndex: scan.slotIndex + 1,
    swapped: scan.swapped.append(if (scan.slotIndex == slot) items.nthOr(pick, member) else if (scan.slotIndex == pick) items.nthOr(slot, member) else member)
  }).swapped
pure def shuffleItems(items: List[str], swaps: List[ShuffleSwap]): List[str] =
  swaps.foldl(items, (arranged, swap) => swapItems(arranged, swap.slot, swap.pick))
pure def itemCount(items: List[str], member: str): int = items.select(entry => entry == member).length()
pure def sampleItems(shuffled: List[str], count: int): List[str] =
  if (count <= 0) List() else shuffled.foldl(List(), (taken, member) => if (taken.length() < count) taken.append(member) else taken)
pure def pickItem(shuffled: List[str]): DeterministicPick =
  if (shuffled.length() == 0) NoPick else Picked({ member: shuffled.nthOr(0, "") })
pure def seedParts(parts: List[str]): List[str] = {
  val kept = parts.select(part => part != "")
  if (kept.length() == 0) List("default") else kept
}
pure val itemsValues = Set(List(), List("a"), List("a", "b", "a"), List("b", "c"))
pure val shuffledValues = Set(List(), List("a"), List("a", "b", "a"))
pure val swapsValues = Set(List(), List({ slot: 2, pick: 0 }), List({ slot: 2, pick: 1 }, { slot: 1, pick: 0 }), List({ slot: 5, pick: 0 }, { slot: 1, pick: 1 }))
pure val memberValues = Set("a", "b", "c")
pure val partsValues = Set(List(), List(""), List("a", "", "b"))
pure def lawSwapKeepsLength(items: List[str], slot: int, pick: int): bool = swapItems(items, slot, pick).length() == items.length()
pure def lawShuffleKeepsEveryItemCount(items: List[str], swaps: List[ShuffleSwap], member: str): bool =
  itemCount(shuffleItems(items, swaps), member) == itemCount(items, member)
pure def lawSampleLengthIsBounded(shuffled: List[str], count: int): bool =
  sampleItems(shuffled, count).length() == (if (count <= 0) 0 else if (count < shuffled.length()) count else shuffled.length())
pure def lawSampledItemsComeFromTheInput(items: List[str], swaps: List[ShuffleSwap], count: int, member: str): bool =
  sampleItems(shuffleItems(items, swaps), count).includes(member) implies items.includes(member)
pure def lawPickedItemComesFromTheInput(items: List[str], swaps: List[ShuffleSwap]): bool = {
  val picked = pickItem(shuffleItems(items, swaps))
  match picked {
    | NoPick => items.length() == 0
    | Picked(chosen) => items.includes(chosen.member)
  }
}
pure def lawSeedHasAPart(parts: List[str]): bool = seedParts(parts).length() > 0 and not(seedParts(parts).includes(""))
```

### The artwork seed hash wraps each step to 32 bits and is never negative

`hashArtworkSeed` starts at 0 and, for each UTF-16 code unit, multiplies by
31, adds the unit and wraps the result to a signed 32-bit integer (`| 0`).
It returns the absolute value, so the result is from 0 to 2^31.

```quint
pure def wrapInt32(wide: int): int = {
  val unsigned = ((wide % 4294967296) + 4294967296) % 4294967296
  if (unsigned >= 2147483648) unsigned - 4294967296 else unsigned
}
pure def artworkSeedHash(codes: List[int]): int = {
  val hash = codes.foldl(0, (running, code) => wrapInt32(running * 31 + code))
  if (hash < 0) 0 - hash else hash
}
pure val codesValues = Set(List(), List(97), List(65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535))
pure def lawWrappedValueIsSigned32Bit(wide: int): bool = wrapInt32(wide) >= -2147483648 and wrapInt32(wide) < 2147483648
pure def lawArtworkSeedIsNonNegative(codes: List[int]): bool = artworkSeedHash(codes) >= 0 and artworkSeedHash(codes) <= 2147483648
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

As a caller I match normalized text against vocabulary I supply, retain each
authored spelling in match results, and select the longest original spelling
when I request one match. Core ships no vocabulary of its own: deciding what
a person asked for is the model's, so no core catalog of request keywords
exists to look up.

The host applies `normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()`
and supplies the resulting UTF-16 code units, including lone surrogates.
Original terms also retain their exact UTF-16 units. Document entries arrive
in `/\n+/` split order with their original spelling trimmed. Normalization,
splitting, trimming, and UTF-16 conversion require conformance against the
[pinned helper](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/i18n/keyword-matching.ts#L34-L261).
The rules below cover built-in prepared entries. Caller-authored public
`PreparedKeywordTerm.matches` callbacks retain their own invocation, result,
and failure contract.

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
