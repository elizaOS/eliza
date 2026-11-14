# Exact retained state of skeleton streams

`ResponseSkeletonStreamExtractor` in `utils/streaming.ts` owns complete UTF-16 buffers, ordered span position, selected field and parts-array position, pending JSON escape, gate prefix, format decision and per-field reasoning-filter carries. This model uses [exact unit operations](./streamUnits.md) and specifies all those retained values. The higher-level gate contract is [streamSkeleton](./streamSkeleton.md).

JSON value classification and strict JSON decoding of property names/part-kind strings are pure decoder boundaries: they must consume the exact supplied prefix and return its actual decoded value. This model does not claim that an arbitrary claimed decoded value proves that lexical contract. Exact [input/output/refusal contracts](./baseline/stream-decoder-contracts.json) and executed [source fixtures](./baseline/stream-decoder-fixtures.json) define future adapter conformance, including malformed/partial JSON, denied envelope prefixes and ordered part shapes. Quoted-string end scanning, escape decoding, reasoning-tag matching, retained suffixes and emitted Unicode below are executable pure rules.

## Story: Stream exact visible text without losing partial parser state

### Buffer and gate ownership survive chunk boundaries

The explicit source chunk limit is 1,048,576 code units. A gate holds the entire undecided prefix until it decides; more than 65,536 prefix units holds the attempt. Hold clears only the source's buffer, gate prefix, active field and parts field; it does not silently reset escape/filter state. Reset clears every parser carry and allocates a new revision.

```quint
import streamUnits as U from "./streamUnits"
type SkeletonLife = SkeletonStreaming | SkeletonComplete | SkeletonFailed
type PartPosition = PartElement | PartKey
type StreamKey = { name: str, encoded: List[int], parts: bool, kinds: List[List[int]] }
type SkeletonField = { name: str, content: List[int], emitted: List[int], hasContent: bool, hasEmitted: bool, hasFilter: bool, insideReasoning: bool, filterPending: List[int], closeTag: List[int] }
type SkeletonChunk = { name: str, units: List[int], accumulated: List[int], revision: int }
type SpanKind = LiteralSpan | FreeStringSpan | EnumSpan | ValueSpan
type SkeletonSpan = { kind: SpanKind, name: str, literal: List[int] }
type SkeletonState = { configured: bool, life: SkeletonLife, revision: int, unordered: bool, gated: bool, selected: List[StreamKey], spans: List[SkeletonSpan], buffer: List[int], spanIndex: int, activeField: str, pendingEscape: List[int], fieldRows: List[SkeletonField], formatDecided: bool, passthrough: bool, passthroughEmitted: List[int], gateHead: List[int], gateDecided: bool, held: bool, partsField: str, partsPosition: PartPosition, hasPartKind: bool, partKind: List[int], finalResidue: bool, chunks: List[SkeletonChunk] }
pure val noField: SkeletonField = { name: "", content: List(), emitted: List(), hasContent: false, hasEmitted: false, hasFilter: false, insideReasoning: false, filterPending: List(), closeTag: List() }
pure val noKey: StreamKey = { name: "", encoded: List(), parts: false, kinds: List() }
pure val initial: SkeletonState = { configured: false, life: SkeletonStreaming, revision: 0, unordered: false, gated: false, selected: List(), spans: List(), buffer: List(), spanIndex: 0, activeField: "", pendingEscape: List(), fieldRows: List(), formatDecided: false, passthrough: false, passthroughEmitted: List(), gateHead: List(), gateDecided: false, held: false, partsField: "", partsPosition: PartElement, hasPartKind: false, partKind: List(), finalResidue: false, chunks: List() }
pure def matchingRows(rows: List[SkeletonField], name: str): List[SkeletonField] = rows.select(row => row.name == name)
pure def rowAt(rows: List[SkeletonField], name: str): SkeletonField = matchingRows(rows, name).nthOr(0, { ...noField, name: name })
pure def writeRow(rows: List[SkeletonField], row: SkeletonField): List[SkeletonField] = if (rows.some(previous => previous.name == row.name)) rows.listMap(previous => if (previous.name == row.name) row else previous) else rows.append(row)
pure def canConfigure(s: SkeletonState, selected: List[StreamKey], unordered: bool, gated: bool, revision: int): bool = not(s.configured) and (not(gated) or unordered) and revision > 0 and selected.every(key => selected.select(other => other.name == key.name).length() == 1)
pure def configure(s: SkeletonState, selected: List[StreamKey], spans: List[SkeletonSpan], unordered: bool, gated: bool, revision: int): SkeletonState = { ...s, configured: true, selected: selected, spans: spans, unordered: unordered, gated: gated, revision: revision }
pure def heldState(s: SkeletonState): SkeletonState = { ...s, held: true, buffer: List(), gateHead: List(), activeField: "", partsField: "" }
pure def canPush(s: SkeletonState, units: List[int]): bool = s.configured and s.life == SkeletonStreaming and units.length() <= 1048576 and units.every(code => code >= 0 and code <= 65535)
pure def push(s: SkeletonState, units: List[int]): SkeletonState = if (s.held) s else if (s.gated and not(s.gateDecided) and s.gateHead.length() + units.length() > 65536) heldState(s) else { ...s, buffer: s.buffer.concat(units), gateHead: if (s.gated and not(s.gateDecided)) s.gateHead.concat(units) else s.gateHead }
pure def canDecideFormat(s: SkeletonState): bool = s.life == SkeletonStreaming and not(s.held) and not(s.formatDecided) and U::dropLeadingWhitespace(s.buffer).length() > 0
pure def decideFormat(s: SkeletonState): SkeletonState = { ...s, formatDecided: true, passthrough: not(List(123, 91, 60).includes(U::dropLeadingWhitespace(s.buffer).nthOr(0, 0))) }
pure def canDecideGate(s: SkeletonState): bool = s.gated and not(s.gateDecided) and not(s.held)
pure def decideGate(s: SkeletonState, prefixDecodable: bool, resultTrue: bool): SkeletonState = if (prefixDecodable and resultTrue) { ...s, gateDecided: true, gateHead: List() } else heldState({ ...s, gateDecided: true })
pure def canDrainProse(s: SkeletonState): bool = s.passthrough and not(s.held) and (not(s.gated) or s.gateDecided) and s.buffer.length() > 0
pure def drainProse(s: SkeletonState, finalChunk: bool): SkeletonState = {
  val retain = not(finalChunk) and U::high(s.buffer.nthOr(s.buffer.length() - 1, -1))
  val end = s.buffer.length() - (if (retain) 1 else 0)
  val chunk = U::wellFormed(U::sliceUnits(s.buffer, 0, end))
  val accumulated = s.passthroughEmitted.concat(chunk)
  { ...s, buffer: U::sliceUnits(s.buffer, end, s.buffer.length()), passthroughEmitted: accumulated, chunks: if (chunk.length() == 0) s.chunks else s.chunks.append({ name: "", units: chunk, accumulated: accumulated, revision: s.revision }) }
}
```

### Reasoning filter carries and visible prefixes retain exact units

Opening and closing tags match case-insensitively using the source's ASCII fold and Kelvin-sign lowercase equivalence. Partial tag prefixes remain buffered. Unmatched text outside a tag is visible; inside a tag it is withheld. A final partial opening tag outside reasoning is visible, while an unterminated reasoning region remains hidden. Emission retains one trailing high surrogate and replaces only interior unpaired surrogates.

```quint
type ReasoningTag = { opening: List[int], closing: List[int] }
type Filter = { inside: bool, pending: List[int], closing: List[int], visible: List[int] }
pure val reasoningTags: List[ReasoningTag] = List({ opening: List(60,116,104,105,110,107,62), closing: List(60,47,116,104,105,110,107,62) }, { opening: List(60,116,104,105,110,107,105,110,103,62), closing: List(60,47,116,104,105,110,107,105,110,103,62) }, { opening: List(60,97,110,97,108,121,115,105,115,62), closing: List(60,47,97,110,97,108,121,115,105,115,62) }, { opening: List(60,114,101,97,115,111,110,105,110,103,62), closing: List(60,47,114,101,97,115,111,110,105,110,103,62) }, { opening: List(60,114,101,102,108,101,99,116,105,111,110,62), closing: List(60,47,114,101,102,108,101,99,116,105,111,110,62) }, { opening: List(60,116,104,111,117,103,104,116,62), closing: List(60,47,116,104,111,117,103,104,116,62) }, { opening: List(60,97,110,116,116,104,105,110,107,105,110,103,62), closing: List(60,47,97,110,116,116,104,105,110,107,105,110,103,62) })
pure val noTag: ReasoningTag = { opening: List(), closing: List() }
pure def foldTagUnit(code: int): int = if (code >= 65 and code <= 90) code + 32 else if (code == 8490) 107 else code
pure def foldedPrefix(units: List[int], pattern: List[int]): bool = units.length() <= pattern.length() and units.listMap(code => foldTagUnit(code)) == U::sliceUnits(pattern, 0, units.length())
pure def filterUnit(tagFilter: Filter, code: int): Filter = {
  val pending = tagFilter.pending.append(code)
  val full = reasoningTags.select(tag => pending.length() == tag.opening.length() and foldedPrefix(pending, tag.opening)).nthOr(0, noTag)
  val openingPrefix = reasoningTags.some(tag => foldedPrefix(pending, tag.opening))
  val closePrefix = foldedPrefix(pending, tagFilter.closing)
  if (tagFilter.inside and closePrefix and pending.length() == tagFilter.closing.length()) { ...tagFilter, inside: false, pending: List(), closing: List() }
  else if (tagFilter.inside and closePrefix) { ...tagFilter, pending: pending }
  else if (tagFilter.inside) { ...tagFilter, pending: if (code == 60) List(60) else List() }
  else if (full.opening.length() > 0) { ...tagFilter, inside: true, pending: List(), closing: full.closing }
  else if (openingPrefix) { ...tagFilter, pending: pending }
  else { ...tagFilter, visible: tagFilter.visible.concat(if (code == 60) U::sliceUnits(pending, 0, pending.length() - 1) else pending), pending: if (code == 60) List(60) else List() }
}
pure def filtered(row: SkeletonField, units: List[int], finalChunk: bool): Filter = {
  val result = units.foldl({ inside: row.insideReasoning, pending: row.filterPending, closing: row.closeTag, visible: List() }, (tagFilter, code) => filterUnit(tagFilter, code))
  if (finalChunk and not(result.inside)) { ...result, visible: result.visible.concat(result.pending), pending: List() } else result
}
pure def visibleRow(row: SkeletonField, units: List[int]): SkeletonField = {
  val combined = row.content.concat(units)
  val chunk = U::sliceUnits(combined, row.emitted.length(), combined.length())
  val retain = U::high(chunk.nthOr(chunk.length() - 1, -1))
  val ready = U::wellFormed(U::sliceUnits(chunk, 0, chunk.length() - (if (retain) 1 else 0)))
  val emittedUnits = row.emitted.concat(ready)
  { ...row, hasContent: true, hasEmitted: row.hasEmitted or ready.length() > 0, content: emittedUnits.concat(if (retain) List(chunk.nthOr(chunk.length() - 1, -1)) else List()), emitted: emittedUnits }
}
pure def canAppendFiltered(s: SkeletonState, name: str): bool = s.life != SkeletonFailed and not(s.held) and s.selected.some(key => key.name == name) and (not(s.gated) or s.gateDecided)
pure def appendFiltered(s: SkeletonState, name: str, units: List[int], finalChunk: bool): SkeletonState = {
  val prior = rowAt(s.fieldRows, name)
  val tagFilter = filtered(prior, units, finalChunk)
  val row = if (tagFilter.visible.length() > 0) visibleRow({ ...prior, hasFilter: true, insideReasoning: tagFilter.inside, filterPending: tagFilter.pending, closeTag: tagFilter.closing }, tagFilter.visible) else { ...prior, hasFilter: true, insideReasoning: tagFilter.inside, filterPending: tagFilter.pending, closeTag: tagFilter.closing }
  val chunk = U::sliceUnits(row.emitted, prior.emitted.length(), row.emitted.length())
  if (units.length() == 0 and not(finalChunk)) s else { ...s, fieldRows: writeRow(s.fieldRows, row), chunks: if (chunk.length() == 0) s.chunks else s.chunks.append({ name: name, units: chunk, accumulated: row.emitted, revision: s.revision }) }
}
```

### Active JSON strings retain escape prefixes until sufficient input arrives

Plain runs, a trailing backslash and a partial four-digit Unicode escape remain distinct. Closing a string flushes its reasoning filter, advances an ordered span only in ordered mode, and leaves parts parsing at its key position. Malformed escapes preserve the source's raw fallback. The final unterminated string closes without looping on the same span.

```quint
pure def canOpenString(s: SkeletonState, name: str): bool = s.life == SkeletonStreaming and not(s.held) and s.activeField == "" and s.selected.some(key => key.name == name) and (not(s.gated) or s.gateDecided)
pure def openString(s: SkeletonState, name: str): SkeletonState = { ...s, activeField: name }
pure def canStringStep(s: SkeletonState): bool = s.activeField != "" and s.life == SkeletonStreaming and not(s.held) and s.buffer.length() > 0
pure def stringStep(s: SkeletonState): SkeletonState = {
  val code = s.buffer.nthOr(0, -1)
  val needed = if (s.pendingEscape == List(92,117)) 4 else 1
  val quote = U::findUnits(s.buffer, List(34))
  val slash = U::findUnits(s.buffer, List(92))
  val runEnd = if (quote < 0) (if (slash < 0) s.buffer.length() else slash) else if (slash < 0 or quote < slash) quote else slash
  if (s.pendingEscape == List(92) and code == 117) { ...s, pendingEscape: List(92,117), buffer: U::sliceUnits(s.buffer, 1, s.buffer.length()) }
  else if (s.pendingEscape.length() > 0 and s.buffer.length() < needed) s
  else if (s.pendingEscape.length() > 0) appendFiltered({ ...s, pendingEscape: List(), buffer: U::sliceUnits(s.buffer, needed, s.buffer.length()) }, s.activeField, U::decodeEscape(s.pendingEscape.concat(U::sliceUnits(s.buffer, 0, needed))), false)
  else if (runEnd > 0) appendFiltered({ ...s, buffer: U::sliceUnits(s.buffer, runEnd, s.buffer.length()) }, s.activeField, U::sliceUnits(s.buffer, 0, runEnd), false)
  else if (code == 34) appendFiltered({ ...s, activeField: "", buffer: U::sliceUnits(s.buffer, 1, s.buffer.length()), spanIndex: s.spanIndex + (if (s.unordered) 0 else 1) }, s.activeField, List(), true)
  else { ...s, pendingEscape: List(92), buffer: U::sliceUnits(s.buffer, 1, s.buffer.length()) }
}
pure def canEndTruncatedString(s: SkeletonState): bool = s.activeField != "" and (s.buffer.length() == 0 or (s.pendingEscape.length() > 0 and s.buffer.length() < (if (s.pendingEscape == List(92,117)) 4 else 1)))
pure def endTruncatedString(s: SkeletonState): SkeletonState = { ...s, activeField: "", finalResidue: true, spanIndex: s.spanIndex + (if (s.unordered) 0 else 1) }
pure def canFlushSurrogate(s: SkeletonState, name: str): bool = s.life != SkeletonFailed and not(s.held) and rowAt(s.fieldRows, name).content.length() > rowAt(s.fieldRows, name).emitted.length()
pure def flushSurrogate(s: SkeletonState, name: str): SkeletonState = {
  val prior = rowAt(s.fieldRows, name)
  val chunk = U::wellFormed(U::sliceUnits(prior.content, prior.emitted.length(), prior.content.length()))
  val accumulated = prior.emitted.concat(chunk)
  { ...s, fieldRows: writeRow(s.fieldRows, { ...prior, content: accumulated, emitted: accumulated, hasContent: true, hasEmitted: true }), chunks: s.chunks.append({ name: name, units: chunk, accumulated: accumulated, revision: s.revision }) }
}
pure def signalError(s: SkeletonState): SkeletonState = { ...s, life: SkeletonFailed }
pure def canReset(s: SkeletonState, revision: int): bool = s.configured and revision > 0
pure def reset(s: SkeletonState, revision: int): SkeletonState = { ...initial, configured: true, selected: s.selected, spans: s.spans, unordered: s.unordered, gated: s.gated, revision: revision }
pure def alwaysEmittedPrefixIsRetained(s: SkeletonState): bool = s.fieldRows.every(row => U::unitPrefix(row.content, row.emitted) and row.content.length() - row.emitted.length() <= 1)
pure def alwaysEscapePrefixIsRecognized(s: SkeletonState): bool = s.pendingEscape.length() == 0 or s.pendingEscape == List(92) or s.pendingEscape == List(92,117)
pure def alwaysHeldBuffersAreEmpty(s: SkeletonState): bool = not(s.held) or s.buffer.length() == 0 and s.gateHead.length() == 0 and s.activeField == "" and s.partsField == ""
pure val nameValues = Set("reply", "message")
pure val revisionValues = Set(1, 2)
pure val unitsValues = Set(List(123,34,114,101,112,108,121,34,58,34,65,34,125), List(123,34,114,101,112,108,121,34,58,91,123,34,107,105,110,100,34,58,34,116,101,120,116,34,44,34,118,97,108,117,101,34,58,34,65,34,125,93,125), List(65), List(34), List(92), List(117, 48, 48, 52, 49), List(55296), List(56320))
pure val selectedValues: Set[List[StreamKey]] = Set(List({ name: "reply", encoded: List(34,114,101,112,108,121,34), parts: false, kinds: List() }), List({ name: "reply", encoded: List(34,114,101,112,108,121,34), parts: true, kinds: List(List(116,101,120,116)) }))
pure val spansValues: Set[List[SkeletonSpan]] = Set(List(), List({ kind: FreeStringSpan, name: "reply", literal: List() }))
```

### Unordered key search preserves the exact possible key suffix

Search picks the earliest encoded selected key, retaining declaration order for ties. Incomplete key/value separators retain the key prefix. Wrong separators or unsupported value forms advance only the source's documented prefix. A gated stream holds after its first selected top-level value closes.

```quint
type KeyMatch = { found: bool, name: str, start: int, end: int, parts: bool }
pure val noMatch: KeyMatch = { found: false, name: "", start: 0, end: 0, parts: false }
pure def earlierKey(buffer: List[int], chosen: KeyMatch, key: StreamKey): KeyMatch = {
  val offset = U::findUnits(buffer, key.encoded)
  if (offset >= 0 and (not(chosen.found) or offset < chosen.start)) { found: true, name: key.name, start: offset, end: offset + key.encoded.length(), parts: key.parts } else chosen
}
pure def firstKey(s: SkeletonState): KeyMatch = s.selected.foldl(noMatch, (chosen, key) => earlierKey(s.buffer, chosen, key))
pure def maxKeyLength(s: SkeletonState): int = s.selected.foldl(0, (maximum, key) => if (key.encoded.length() > maximum) key.encoded.length() else maximum)
pure def canSearchUnordered(s: SkeletonState): bool = s.unordered and s.life == SkeletonStreaming and not(s.held) and not(s.passthrough) and s.activeField == "" and s.partsField == ""
pure def searchUnordered(s: SkeletonState, finalChunk: bool, prefixDecodable: bool, resultTrue: bool): SkeletonState = {
  val matched = firstKey(s)
  val afterKey = U::dropLeadingWhitespace(U::sliceUnits(s.buffer, matched.end, s.buffer.length()))
  val colonAt = s.buffer.length() - afterKey.length()
  val afterColon = U::dropLeadingWhitespace(U::sliceUnits(s.buffer, colonAt + 1, s.buffer.length()))
  val valueAt = s.buffer.length() - afterColon.length()
  val keep = if (maxKeyLength(s) > 0) maxKeyLength(s) - 1 else 0
  val opening = afterColon.nthOr(0, -1)
  val accepted = (matched.parts and opening == 91) or (not(matched.parts) and opening == 34)
  if (s.gated and s.gateDecided) heldState(s)
  else if (not(matched.found)) { ...s, buffer: if (finalChunk) List() else U::sliceUnits(s.buffer, s.buffer.length() - keep, s.buffer.length()), life: if (finalChunk) SkeletonComplete else s.life }
  else if (afterKey.length() == 0 or (afterKey.nthOr(0, -1) == 58 and afterColon.length() == 0)) { ...s, buffer: if (finalChunk) List() else U::sliceUnits(s.buffer, matched.start, s.buffer.length()) }
  else if (afterKey.nthOr(0, -1) != 58) { ...s, buffer: U::sliceUnits(s.buffer, matched.end, s.buffer.length()) }
  else if (not(accepted)) { ...s, buffer: U::sliceUnits(s.buffer, valueAt, s.buffer.length()) }
  else if (s.gated and not(prefixDecodable and resultTrue)) heldState({ ...s, gateDecided: true })
  else { ...s, gateDecided: s.gateDecided or s.gated, gateHead: if (s.gated) List() else s.gateHead, buffer: U::sliceUnits(s.buffer, valueAt + 1, s.buffer.length()), activeField: if (matched.parts) "" else matched.name, partsField: if (matched.parts) matched.name else "", partsPosition: PartElement }
}
```

### Parts arrays require kind before an allowed string value

Commas and braces advance the exact element/key cursor. A kind value must be a complete quoted JSON string. Its decoded units are stored independently of the selected string field. Value starts only after a present allowed kind; any unknown property or nonstring shape holds the attempt. The strict decoder inputs are the complete raw key/kind slices selected by the boundary scanner.

```quint
pure def canPartsStep(s: SkeletonState, keyIsKind: bool, keyIsValue: bool): bool = s.partsField != "" and s.activeField == "" and not(s.held) and not(keyIsKind and keyIsValue)
pure def partsStep(s: SkeletonState, finalChunk: bool, keyIsKind: bool, keyIsValue: bool, decodedKind: List[int], validKindString: bool): SkeletonState = {
  val buffer = U::dropLeadingWhitespace(s.buffer)
  val code = buffer.nthOr(0, -1)
  val keyEnd = U::jsonStringEnd(buffer)
  val afterKey = U::dropLeadingWhitespace(U::sliceUnits(buffer, if (keyEnd < 0) buffer.length() else keyEnd, buffer.length()))
  val colonAt = buffer.length() - afterKey.length()
  val value = U::dropLeadingWhitespace(U::sliceUnits(buffer, colonAt + 1, buffer.length()))
  val valueAt = buffer.length() - value.length()
  val kindEnd = U::jsonStringEnd(value)
  val definition = s.selected.select(key => key.name == s.partsField).nthOr(0, noKey)
  if (buffer.length() == 0) { ...s, buffer: buffer, partsField: if (finalChunk) "" else s.partsField, finalResidue: finalChunk }
  else if (s.partsPosition == PartElement and code == 93) { ...s, buffer: U::sliceUnits(buffer, 1, buffer.length()), partsField: "" }
  else if (code == 44) { ...s, buffer: U::sliceUnits(buffer, 1, buffer.length()) }
  else if (s.partsPosition == PartElement and code == 123) { ...s, buffer: U::sliceUnits(buffer, 1, buffer.length()), partsPosition: PartKey, hasPartKind: false, partKind: List() }
  else if (s.partsPosition == PartElement) heldState(s)
  else if (code == 125) { ...s, buffer: U::sliceUnits(buffer, 1, buffer.length()), partsPosition: PartElement }
  else if (code != 34) heldState(s)
  else if (afterKey.length() > 0 and afterKey.nthOr(0, -1) != 58) heldState(s)
  else if (keyEnd < 0 or value.length() == 0) { ...s, buffer: buffer, partsField: if (finalChunk) "" else s.partsField, finalResidue: finalChunk }
  else if (keyIsKind and value.nthOr(0, -1) == 34 and kindEnd < 0) { ...s, buffer: buffer, partsField: if (finalChunk) "" else s.partsField, finalResidue: finalChunk }
  else if (keyIsKind and value.nthOr(0, -1) == 34) { ...s, buffer: U::sliceUnits(buffer, valueAt + kindEnd, buffer.length()), hasPartKind: validKindString, partKind: if (validKindString) decodedKind else List() }
  else if (keyIsValue and value.nthOr(0, -1) == 34 and s.hasPartKind and definition.kinds.includes(s.partKind)) { ...s, buffer: U::sliceUnits(buffer, valueAt + 1, buffer.length()), activeField: s.partsField }
  else heldState(s)
}
pure val decodedKindValues = Set(List(116,101,120,116))
```

### Ordered spans retain partial literal and value positions

Literal resynchronization consumes through the first complete matching literal, or retains at most its possible suffix when more input is needed. A free selected string starts at its opening quote. Enum/unselected strings are skipped using exact quoted boundaries. Other JSON values use the named pure value-end decoder; its index is constrained to the complete retained buffer.

```quint
pure val noSpan: SkeletonSpan = { kind: LiteralSpan, name: "", literal: List() }
pure def canOrderedStep(s: SkeletonState, decodedValueEnd: int): bool = not(s.unordered) and s.life == SkeletonStreaming and not(s.held) and not(s.passthrough) and s.activeField == "" and (decodedValueEnd == -1 or decodedValueEnd > 0) and decodedValueEnd <= s.buffer.length()
pure def orderedStep(s: SkeletonState, finalChunk: bool, decodedValueEnd: int): SkeletonState = {
  val span = s.spans.nthOr(s.spanIndex, noSpan)
  val literalAt = U::findUnits(s.buffer, span.literal)
  val quoteAt = U::findUnits(s.buffer, List(34))
  val stringEnd = U::jsonStringEnd(s.buffer)
  val keep = if (span.literal.length() > 0) span.literal.length() - 1 else 0
  val selected = s.selected.some(key => key.name == span.name)
  if (s.spanIndex >= s.spans.length()) { ...s, life: if (finalChunk or s.buffer.length() == 0) SkeletonComplete else s.life }
  else if (span.kind == LiteralSpan and literalAt >= 0) { ...s, buffer: U::sliceUnits(s.buffer, literalAt + span.literal.length(), s.buffer.length()), spanIndex: s.spanIndex + 1 }
  else if (span.kind == LiteralSpan and finalChunk) { ...s, buffer: List(), spanIndex: s.spanIndex + 1 }
  else if (span.kind == LiteralSpan) { ...s, buffer: if (U::unitPrefix(span.literal, s.buffer)) s.buffer else U::sliceUnits(s.buffer, s.buffer.length() - keep, s.buffer.length()) }
  else if (span.kind == FreeStringSpan and selected and quoteAt >= 0) { ...s, buffer: U::sliceUnits(s.buffer, quoteAt + 1, s.buffer.length()), activeField: span.name }
  else if (span.kind == FreeStringSpan and selected and finalChunk) { ...s, buffer: List(), activeField: span.name }
  else if (span.kind == FreeStringSpan and selected) s
  else if ((span.kind == FreeStringSpan or span.kind == EnumSpan) and stringEnd >= 0) { ...s, buffer: U::sliceUnits(s.buffer, stringEnd, s.buffer.length()), spanIndex: s.spanIndex + 1 }
  else if (span.kind == ValueSpan and decodedValueEnd >= 0) { ...s, buffer: U::sliceUnits(s.buffer, decodedValueEnd, s.buffer.length()), spanIndex: s.spanIndex + 1 }
  else if (finalChunk) { ...s, buffer: List(), spanIndex: s.spanIndex + 1 }
  else s
}
pure def canFlushFilter(s: SkeletonState, name: str): bool = s.life != SkeletonFailed and not(s.held) and s.selected.some(key => key.name == name)
pure def flushFilter(s: SkeletonState, name: str): SkeletonState = appendFiltered(s, name, List(), true)
pure def canDiscardFinalResidue(s: SkeletonState): bool = s.finalResidue and s.activeField == "" and s.partsField == ""
pure def discardFinalResidue(s: SkeletonState): SkeletonState = { ...s, buffer: List(), finalResidue: false }
pure def canFinish(s: SkeletonState): bool = s.configured and s.life != SkeletonFailed and s.buffer.length() == 0 and s.activeField == "" and s.partsField == "" and (s.held or s.fieldRows.every(row => (row.insideReasoning or row.filterPending.length() == 0) and row.content.length() == row.emitted.length()))
pure def finish(s: SkeletonState): SkeletonState = { ...s, life: SkeletonComplete, pendingEscape: List(), gateHead: List() }
pure val decodedValueEndValues = Set(-1, 0, 1, 2)
```
