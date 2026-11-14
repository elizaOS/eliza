# Exact retained state of line-field streams

`StructuredFieldStreamExtractor` in `utils/streaming.ts` retains the complete line buffer, independent streamed/tracked field pointers, per-field raw content and emitted content, validation status, start/done identities and stream revision. This model supplies those states to the higher-level [stream contract](./streamStructured.md), using [UTF-16 operations](./streamUnits.md).

The line decoder is a named pure boundary: its input is exactly the extracted line; a header follows `STRUCTURED_TOP_LEVEL_FIELD_RE`, strips its bracket/brace suffix, and decodes the trimmed inline scalar with the source JSON/single-quote fallback. A continuation strips exactly two leading spaces or one tab. Header recognition/JSON parsing require future decoder refinement; no external decoder may change or omit the extracted input units. Its exact [input/output/refusal contracts](./baseline/stream-decoder-contracts.json) link executed [source fixtures](./baseline/stream-decoder-fixtures.json), including malformed headers, incomplete input and raw escape fallbacks. All subsequent retained-state transitions are defined here.

## Story: Preserve complete field contents across arbitrary chunk boundaries

### Newline extraction preserves every unit and separates CRLF correctly

Push accepts at most 1,048,576 code units per chunk, the source's explicit `CHUNK_TOO_LARGE` boundary. It appends without truncation. Only a complete LF/CRLF line is removed until flush; the remaining suffix survives the next push. A final nonempty suffix is processed once. A bare CR remains content.

```quint
import streamUnits as U from "./streamUnits"
type StreamLife = Streaming | Retrying | Complete | Failed
type FieldStatus = PendingField | PartialField | CompleteField | InvalidField
type FieldRecord = { name: str, content: List[int], emitted: List[int], hasContent: bool, hasEmitted: bool, status: FieldStatus }
type FieldChunk = { name: str, units: List[int], accumulated: List[int], revision: int }
type FieldDone = { name: str, units: List[int] }
type Emission = { fieldRows: List[FieldRecord], chunks: List[FieldChunk] }
type StructuredState = { configured: bool, schema: List[str], selected: List[str], level: int, life: StreamLife, revision: int, buffer: List[int], hasLine: bool, line: List[int], currentField: str, currentTracked: str, fieldRows: List[FieldRecord], validated: Set[str], started: Set[str], done: Set[str], doneValues: List[FieldDone], chunks: List[FieldChunk], flushing: bool }
pure val initial: StructuredState = { configured: false, schema: List(), selected: List(), level: 0, life: Streaming, revision: 0, buffer: List(), hasLine: false, line: List(), currentField: "", currentTracked: "", fieldRows: List(), validated: Set(), started: Set(), done: Set(), doneValues: List(), chunks: List(), flushing: false }
pure val noField: FieldRecord = { name: "", content: List(), emitted: List(), hasContent: false, hasEmitted: false, status: PendingField }
pure def fieldAt(fieldRows: List[FieldRecord], name: str): FieldRecord = fieldRows.select(entry => entry.name == name).nthOr(0, { ...noField, name: name })
pure def putField(fieldRows: List[FieldRecord], value: FieldRecord): List[FieldRecord] = if (fieldRows.some(entry => entry.name == value.name)) fieldRows.listMap(entry => if (entry.name == value.name) value else entry) else fieldRows.append(value)
pure def canConfigure(s: StructuredState, level: int, revision: int): bool = not(s.configured) and level >= 0 and level <= 3 and revision > 0
pure def configure(s: StructuredState, schema: List[str], selected: List[str], level: int, revision: int): StructuredState = { ...s, configured: true, schema: schema, selected: selected, level: level, revision: revision, fieldRows: schema.foldl(List(), (fieldRows, name) => putField(fieldRows, { ...noField, name: name })) }
pure def canPush(s: StructuredState, units: List[int]): bool = s.configured and s.life == Streaming and not(s.flushing) and units.length() <= 1048576 and units.every(code => code >= 0 and code <= 65535)
pure def push(s: StructuredState, units: List[int]): StructuredState = { ...s, buffer: s.buffer.concat(units) }
pure def canExtractLine(s: StructuredState): bool = not(s.hasLine) and (U::findUnits(s.buffer, List(10)) >= 0 or (s.flushing and s.buffer.length() > 0))
pure def extractLine(s: StructuredState): StructuredState = {
  val newline = U::findUnits(s.buffer, List(10))
  val end = if (newline < 0) s.buffer.length() else if (newline > 0 and s.buffer.nthOr(newline - 1, -1) == 13) newline - 1 else newline
  { ...s, hasLine: true, line: U::sliceUnits(s.buffer, 0, end), buffer: if (newline < 0) List() else U::sliceUnits(s.buffer, newline + 1, s.buffer.length()) }
}
```

### Field pointers, emitted prefixes and first done values remain independent

Every header closes the previous streamed field and tracked field. A selected inline field validates immediately; unselected inline content completes its status without entering the validated set. An unselected multiline field remains partial in source diagnostic state even when its done callback fires. Repeated headers append with a newline, while start/done callbacks remain once per field per revision. Levels zero/one emit on field completion; levels two/three wait for flush.
Discovered by the proof: the active streamed field must be selected. Before
configuration, all input buffers, field records and callback identities remain
empty, so a constructor cannot inherit a field from another configuration.

```quint
pure def completedFields(fieldRows: List[FieldRecord], name: str, level: int): List[FieldRecord] = if (name == "") fieldRows else putField(fieldRows, { ...fieldAt(fieldRows, name), status: CompleteField, hasEmitted: fieldAt(fieldRows, name).hasEmitted or (level <= 1 and fieldAt(fieldRows, name).content.length() > 0), emitted: if (level <= 1 and fieldAt(fieldRows, name).content.length() > 0) fieldAt(fieldRows, name).content else fieldAt(fieldRows, name).emitted })
pure def emitChunks(fieldRows: List[FieldRecord], name: str, revision: int): List[FieldChunk] = {
  val entry = fieldAt(fieldRows, name)
  val freshUnits = if (entry.content.length() < entry.emitted.length()) entry.content else U::sliceUnits(entry.content, entry.emitted.length(), entry.content.length())
  if (name == "" or freshUnits.length() == 0) List() else List({ name: name, units: freshUnits, accumulated: entry.content, revision: revision })
}
pure def appendedFields(fieldRows: List[FieldRecord], name: str, value: List[int]): List[FieldRecord] = {
  val entry = fieldAt(fieldRows, name)
  putField(fieldRows, { ...entry, hasContent: true, content: if (entry.content.length() == 0) value else entry.content.concat(List(10)).concat(value) })
}
pure def normalizeContinuation(line: List[int]): List[int] = if (U::unitPrefix(line, List(32, 32))) U::sliceUnits(line, 2, line.length()) else if (U::unitPrefix(line, List(9))) U::sliceUnits(line, 1, line.length()) else line
pure def canApplyContinuation(s: StructuredState): bool = s.hasLine
pure def applyContinuation(s: StructuredState): StructuredState = { ...s, fieldRows: if (s.currentTracked != "") appendedFields(s.fieldRows, s.currentTracked, normalizeContinuation(s.line)) else s.fieldRows, hasLine: false, line: List() }
pure def canApplyHeader(s: StructuredState, name: str): bool = s.hasLine and name != ""
pure def applyHeader(s: StructuredState, name: str, decodedValue: List[int], inline: bool): StructuredState = {
  val closed = completedFields(s.fieldRows, s.currentField, s.level)
  val opened = putField(closed, { ...fieldAt(closed, name), status: PartialField })
  val appended = if (inline) appendedFields(opened, name, decodedValue) else opened
  val selected = s.selected.includes(name)
  val finished = if (inline and selected) completedFields(appended, name, s.level) else if (inline) putField(appended, { ...fieldAt(appended, name), status: CompleteField }) else appended
  val priorDone = if (s.currentTracked != "" and not(s.done.contains(s.currentTracked))) s.doneValues.append({ name: s.currentTracked, units: fieldAt(closed, s.currentTracked).content }) else s.doneValues
  val doneSet = if (s.currentTracked != "") s.done.union(Set(s.currentTracked)) else s.done
  { ...s, fieldRows: finished, currentField: if (selected and not(inline)) name else "", currentTracked: if (inline) "" else name, validated: (if (s.currentField != "") s.validated.union(Set(s.currentField)) else s.validated).union(if (inline and selected) Set(name) else Set()), started: s.started.union(Set(name)), done: if (inline) doneSet.union(Set(name)) else doneSet, doneValues: if (inline and not(doneSet.contains(name))) priorDone.append({ name: name, units: fieldAt(finished, name).content }) else priorDone, chunks: s.chunks.concat(if (s.level <= 1) emitChunks(s.fieldRows, s.currentField, s.revision) else List()).concat(if (inline and selected and s.level <= 1) emitChunks(appended, name, s.revision) else List()), hasLine: false, line: List() }
}
pure def canBeginFlush(s: StructuredState): bool = s.configured and s.life != Failed and not(s.flushing)
pure def beginFlush(s: StructuredState): StructuredState = { ...s, flushing: true }
pure def emittedFields(fieldRows: List[FieldRecord], name: str): List[FieldRecord] = if (fieldAt(fieldRows, name).content.length() == 0) fieldRows else putField(fieldRows, { ...fieldAt(fieldRows, name), emitted: fieldAt(fieldRows, name).content, hasEmitted: true })
pure def flushSelected(emission: Emission, name: str, revision: int): Emission = { fieldRows: emittedFields(emission.fieldRows, name), chunks: emission.chunks.concat(emitChunks(emission.fieldRows, name, revision)) }
pure def canFinishFlush(s: StructuredState): bool = s.flushing and not(s.hasLine) and s.buffer.length() == 0
pure def finishFlush(s: StructuredState): StructuredState = {
  val closed = completedFields(s.fieldRows, s.currentField, s.level)
  val earlier = s.chunks.concat(if (s.level <= 1) emitChunks(s.fieldRows, s.currentField, s.revision) else List())
  val output = if (s.level >= 2) s.selected.foldl({ fieldRows: closed, chunks: earlier }, (emission, name) => flushSelected(emission, name, s.revision)) else { fieldRows: closed, chunks: earlier }
  { ...s, life: Complete, fieldRows: output.fieldRows, chunks: output.chunks, validated: if (s.currentField != "") s.validated.union(Set(s.currentField)) else s.validated, currentField: "", currentTracked: "", done: if (s.currentTracked != "") s.done.union(Set(s.currentTracked)) else s.done, doneValues: if (s.currentTracked != "" and not(s.done.contains(s.currentTracked))) s.doneValues.append({ name: s.currentTracked, units: fieldAt(closed, s.currentTracked).content }) else s.doneValues, flushing: false }
}
pure def signalRetry(s: StructuredState): StructuredState = { ...s, life: Retrying }
pure def signalError(s: StructuredState): StructuredState = { ...s, life: Failed }
pure def canReset(s: StructuredState, revision: int): bool = s.configured and revision > 0
pure def reset(s: StructuredState, revision: int): StructuredState = { ...initial, configured: true, schema: s.schema, selected: s.selected, level: s.level, revision: revision, fieldRows: s.fieldRows.listMap(entry => { ...entry, content: List(), emitted: List(), hasContent: false, hasEmitted: false, status: if (s.schema.includes(entry.name)) PendingField else entry.status }) }
pure def alwaysFieldKeysUnique(s: StructuredState): bool = s.fieldRows.every(entry => s.fieldRows.select(other => other.name == entry.name).length() == 1)
pure def alwaysDoneValuesUnique(s: StructuredState): bool = s.doneValues.every(entry => s.done.contains(entry.name) and s.doneValues.select(other => other.name == entry.name).length() == 1)
pure def alwaysEmissionNamesSelected(s: StructuredState): bool = s.chunks.every(chunk => s.selected.includes(chunk.name))
pure def alwaysActiveFieldSelected(s: StructuredState): bool = s.currentField == "" or s.selected.includes(s.currentField)
pure def alwaysUnconfiguredEmpty(s: StructuredState): bool = s.configured or (s.schema.length() == 0 and s.selected.length() == 0 and s.revision == 0 and s.buffer.length() == 0 and not(s.hasLine) and s.line.length() == 0 and s.currentField == "" and s.currentTracked == "" and s.fieldRows.length() == 0 and s.validated.size() == 0 and s.started.size() == 0 and s.done.size() == 0 and s.doneValues.length() == 0 and s.chunks.length() == 0 and not(s.flushing))
pure def sometimesExactContinuationRetained(s: StructuredState): bool = s.fieldRows.some(entry => entry.content.length() > 0 and entry.emitted.length() == 0)
pure val nameValues = Set("reply", "thought")
pure val schemaValues = Set(List("reply", "thought"))
pure val selectedValues = Set(List("reply"))
pure val levelValues = Set(0, 2)
pure val revisionValues = Set(1, 2)
pure val unitsValues = Set(List(65), List(13, 10), List(65, 10, 66))
pure val decodedValueValues = Set(List(), List(65), List(66))
```
