# Secret placeholder session

The source is `packages/core/src/security/secret-swap.ts` at the pinned baseline. One session owns a fresh nonce and a bijection from exact secret values to placeholders. Compiled replacement and containment patterns are caches derived from those values. `SecretText.characters` is the complete Unicode code-point sequence of `value`; the input boundary supplies exact Unicode letter/number/underscore and whitespace classifications and UTF-16 widths. Literal matching, short-value boundaries and the symmetric containment rule are executable below. The string/code-point correspondence remains a decoder obligation. The placeholder is distinct from a pseudonym and is restored only at authorized local boundaries.

## Story: Restore known placeholders while keeping credentials out of replies

As an agent, I replace known credential and contact values with stable session placeholders. Restoring handler arguments resolves known placeholders exactly and optionally rejects unresolved placeholders from this session. User-visible replies may restore personal contacts, while credential values and overlapping protected values remain redacted.

### Every new secret has one stable placeholder in its session

```quint
type SecretValue = str
type SecretDecision = bool
type SecretOffset = int
type SecretChar = { symbol: SecretValue, word: bool, space: bool, units: int }
type SecretCharacters = List[SecretChar]
type SecretText = { value: SecretValue, characters: SecretCharacters }
type SecretEntry = { value: SecretValue, characters: SecretCharacters, placeholder: str, nonce: str, userReadable: SecretDecision, replyProtected: SecretDecision }
type SecretEntries = List[SecretEntry]
type SecretValues = Set[SecretValue]
type SecretTexts = List[SecretText]
pure val outsideChar: SecretChar = { symbol: "", word: false, space: true, units: 0 }
type PrefixCheck = { index: SecretOffset, matched: SecretDecision }
pure def literalAt(text: List[SecretChar], pattern: List[SecretChar], startIndex: int): SecretDecision = pattern.foldl({ index: startIndex, matched: true }, (checked, character) => { index: checked.index + 1, matched: checked.matched and text.nthOr(checked.index, outsideChar).symbol == character.symbol }).matched
pure def patternAt(text: List[SecretChar], pattern: List[SecretChar], startIndex: int): SecretDecision = {
  val before = text.nthOr(startIndex - 1, outsideChar)
  val after = text.nthOr(startIndex + pattern.length(), outsideChar)
  val longPattern = pattern.foldl(0, (unitTotal, character) => unitTotal + character.units) >= 8
  val wordPattern = pattern.some(character => character.word)
  pattern.length() > 0 and startIndex >= 0 and startIndex + pattern.length() <= text.length() and literalAt(text, pattern, startIndex) and (longPattern or (if (wordPattern) not(before.word) and not(after.word) else before.space and after.space))
}
pure def containsPattern(text: List[SecretChar], pattern: List[SecretChar]): SecretDecision = text.foldl({ index: 0, matched: false }, (checked, character) => { index: checked.index + 1, matched: checked.matched or patternAt(text, pattern, checked.index) }).matched
pure def overlaps(left: List[SecretChar], right: List[SecretChar]): SecretDecision = containsPattern(left, right) or containsPattern(right, left)
type Secrets = { nonce: str, entries: SecretEntries, protectedValues: SecretValues, protectedTexts: SecretTexts, replacementCached: SecretValues, containmentCached: SecretValues }
pure val initial: Secrets = { nonce: "", entries: List(), protectedValues: Set(), protectedTexts: List(), replacementCached: Set(), containmentCached: Set() }
pure val nonceValues = Set("sessionA", "sessionB")
pure val sourceValues = Set(
  { value: "alex", characters: List({ symbol: "a", word: true, space: false, units: 1 }, { symbol: "l", word: true, space: false, units: 1 }, { symbol: "e", word: true, space: false, units: 1 }, { symbol: "x", word: true, space: false, units: 1 }) },
  { value: "alex-key", characters: List({ symbol: "a", word: true, space: false, units: 1 }, { symbol: "l", word: true, space: false, units: 1 }, { symbol: "e", word: true, space: false, units: 1 }, { symbol: "x", word: true, space: false, units: 1 }, { symbol: "-", word: false, space: false, units: 1 }, { symbol: "k", word: true, space: false, units: 1 }, { symbol: "e", word: true, space: false, units: 1 }, { symbol: "y", word: true, space: false, units: 1 }) }
)
pure val valueValues = Set("alex", "alex-key")
pure val placeholderValues = Set("placeholderA", "placeholderB")
pure def canStart(s: Secrets, nonce: str): bool = s.nonce == "" and nonce != ""
pure def start(s: Secrets, nonce: str): Secrets = { ...s, nonce: nonce }
pure def declassifyLearnable(s: Secrets, source: SecretText, placeholder: str, userReadable: bool, replyProtected: bool): bool = s.nonce != "" and source.value != "" and source.characters.length() > 0 and source.characters.every(character => character.symbol != "" and (character.units == 1 or character.units == 2)) and placeholder != "" and not(s.entries.some(entry => entry.value == source.value or entry.placeholder == placeholder))
pure def canLearn(s: Secrets, source: SecretText, placeholder: str, userReadable: bool, replyProtected: bool): bool = declassifyLearnable(s, source, placeholder, userReadable, replyProtected)
pure def learn(s: Secrets, source: SecretText, placeholder: str, userReadable: bool, replyProtected: bool): Secrets = { ...s, entries: s.entries.append({ value: source.value, characters: source.characters, placeholder: placeholder, nonce: s.nonce, userReadable: userReadable, replyProtected: replyProtected }), protectedValues: if (replyProtected) s.protectedValues.union(Set(source.value)) else s.protectedValues, protectedTexts: if (replyProtected) appendProtectedSource(source, s.protectedTexts) else s.protectedTexts }
pure def declassifyKnownValue(s: Secrets, value: str): bool = s.entries.some(entry => entry.value == value)
pure def canCacheReplacement(s: Secrets, value: str): bool = declassifyKnownValue(s, value)
pure def cacheReplacement(s: Secrets, value: str): Secrets = { ...s, replacementCached: s.replacementCached.union(Set(value)) }
pure def cacheContainment(s: Secrets, value: str): Secrets = { ...s, containmentCached: s.containmentCached.union(Set(value)) }
pure def declassifyProtectable(s: Secrets, source: SecretText): bool = source.value != "" and source.characters.length() > 0 and source.characters.every(character => character.symbol != "" and (character.units == 1 or character.units == 2))
pure def appendProtectedSource(source: SecretText, entries: SecretTexts): SecretTexts = entries.append(source)
pure def canProtectValue(s: Secrets, source: SecretText): bool = declassifyProtectable(s, source)
pure def protectValue(s: Secrets, source: SecretText): Secrets = { ...s, protectedValues: s.protectedValues.union(Set(source.value)), protectedTexts: if (s.protectedValues.contains(source.value)) s.protectedTexts else appendProtectedSource(source, s.protectedTexts) }
pure def alwaysSecretMapsAreBijective(s: Secrets): bool = s.entries.every(entry => entry.nonce == s.nonce and s.entries.select(other => other.value == entry.value).length() == 1 and s.entries.select(other => other.placeholder == entry.placeholder).length() == 1)
pure def alwaysReplacementCacheComesFromValues(s: Secrets): bool = s.replacementCached.forall(value => s.entries.some(entry => entry.value == value))
```

### Restoration distinguishes unknown foreign text from unresolved current-session placeholders

The explicit restoration declassifiers release known values only to the local handler restoration boundary or the permitted user-reply path. `declassifyLearnable`, `declassifyKnownValue` and `declassifyProtectable` release only the source API's admission/membership booleans; internal matching and stored text remain secret-typed. The parser supplies `currentSessionPlaceholder` only when the placeholder's nonce matches the session. An unresolved current-session placeholder may remain text in permissive mode and fails explicit strict restoration. User reply restoration emits the fixed redaction marker for credentials or protected contacts.

```quint
type Restored = { text: str, rejected: bool }
pure val emptyEntry: SecretEntry = { value: "", characters: List(), placeholder: "", nonce: "", userReadable: false, replyProtected: true }
pure def declassifyRestoreText(s: Secrets, placeholder: str): str = {
  val found = s.entries.select(entry => entry.placeholder == placeholder)
  if (found.length() == 1) found.nthOr(0, emptyEntry).value else placeholder
}
pure def declassifyUnknownPlaceholder(s: Secrets, placeholder: str, currentSessionPlaceholder: bool, strict: bool): bool = s.entries.select(entry => entry.placeholder == placeholder).length() == 0 and currentSessionPlaceholder and strict
pure def restore(s: Secrets, placeholder: str, currentSessionPlaceholder: bool, strict: bool): Restored = { text: declassifyRestoreText(s, placeholder), rejected: declassifyUnknownPlaceholder(s, placeholder, currentSessionPlaceholder, strict) }
pure def declassifyReplyToken(s: Secrets, placeholder: str): str = {
  val found = s.entries.select(entry => entry.placeholder == placeholder).nthOr(0, emptyEntry)
  if (found.value != "" and found.userReadable and not(found.replyProtected) and not(s.protectedTexts.some(protectedText => overlaps(found.characters, protectedText.characters)))) found.value else "[redacted credential]"
}
pure def lawProtectedReplyIsRedacted(s: Secrets, placeholder: str): bool = (alwaysSecretMapsAreBijective(s) and s.entries.some(entry => entry.placeholder == placeholder and entry.replyProtected)) implies declassifyReplyToken(s, placeholder) == "[redacted credential]"
pure def lawOverlappingProtectedReplyIsRedacted(s: Secrets, placeholder: str): bool = alwaysSecretMapsAreBijective(s) and s.entries.some(entry => entry.placeholder == placeholder and s.protectedTexts.some(protectedText => overlaps(entry.characters, protectedText.characters))) implies declassifyReplyToken(s, placeholder) == "[redacted credential]"
pure def sometimesSecretLearned(s: Secrets): bool = s.entries.length() > 0 and s.protectedValues.size() > 0
```
