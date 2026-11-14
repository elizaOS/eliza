# Response-field fence ownership

This migrates `quint/ResponseFieldFences.qnt`. `runtime/response-handler-fields.ts` owns actual Markdown line recognition. Recognition must retain fence character, opening length, closing-line syntax and info-string behavior. Fields inside a fence remain quoted content.

## Story: Parse outer response fields without promoting quoted instructions

As a model-output consumer, I want fenced examples retained as content while genuine outer response fields remain readable.

### Only a matching fence of sufficient length closes quoted content

Backtick and tilde fences close only with their own delimiter and at least the opening length. Inline markers, shorter closers, other fence kinds and content lines preserve the active fence. Only fields encountered outside a fence belong to the response envelope.

```quint
type FenceKind = NoFence | Backtick | Tilde
type FenceLine = { marker: FenceKind, length: int, opens: bool, closes: bool, name: str, text: str }
type FenceParser = { loaded: bool, kind: FenceKind, width: int, lines: List[FenceLine], cursor: int, outerFields: List[FenceLine], quotedFields: List[FenceLine] }
pure val initial: FenceParser = { loaded: false, kind: NoFence, width: 0, lines: List(), cursor: 0, outerFields: List(), quotedFields: List() }
pure val noLine: FenceLine = { marker: NoFence, length: 0, opens: false, closes: false, name: "", text: "" }
pure def canLoad(p: FenceParser): bool = not(p.loaded)
pure def load(p: FenceParser, lines: List[FenceLine]): FenceParser = { ...initial, loaded: true, lines: lines }
pure def canConsume(p: FenceParser): bool = p.loaded and p.cursor < p.lines.length()
pure def consume(p: FenceParser): FenceParser = {
  val line = p.lines.nthOr(p.cursor, noLine)
  val opening = p.kind == NoFence and line.opens and line.marker != NoFence and line.length >= 3
  val closing = p.kind != NoFence and line.closes and line.marker == p.kind and line.length >= p.width
  { ...p, cursor: p.cursor + 1, kind: if (opening) line.marker else if (closing) NoFence else p.kind, width: if (opening) line.length else if (closing) 0 else p.width, outerFields: if (line.name != "" and p.kind == NoFence and not(opening)) p.outerFields.append(line) else p.outerFields, quotedFields: if (line.name != "" and p.kind != NoFence and not(closing)) p.quotedFields.append(line) else p.quotedFields }
}
pure def alwaysFenceWidthMatchesKind(p: FenceParser): bool = (p.kind == NoFence and p.width == 0) or (p.kind != NoFence and p.width >= 3)
pure def alwaysCursorBounded(p: FenceParser): bool = p.cursor >= 0 and p.cursor <= p.lines.length()
pure def stepQuotedFieldNeverBecomesOuter(before: FenceParser, via: str, after: FenceParser): bool = via == "consume" and before.kind != NoFence implies after.outerFields == before.outerFields
pure def sometimesOuterField(p: FenceParser): bool = p.outerFields.length() > 0
pure def sometimesQuotedField(p: FenceParser): bool = p.quotedFields.length() > 0
pure val backFour: FenceLine = { ...noLine, marker: Backtick, length: 4, opens: true, closes: true }
pure val backThree: FenceLine = { ...backFour, length: 3 }
pure val tildeThree: FenceLine = { ...backThree, marker: Tilde }
pure val infoThree: FenceLine = { ...backThree, closes: false, text: "lang" }
pure val outerLine: FenceLine = { ...noLine, name: "reply", text: "outside" }
pure val quotedLine: FenceLine = { ...noLine, name: "reply", text: "quoted" }
pure val linesValues: Set[List[FenceLine]] = Set(List(noLine, outerLine), List(backFour, backThree, quotedLine, backFour, outerLine), List(backThree, infoThree, quotedLine, backThree, outerLine), List(backThree, tildeThree, quotedLine, backThree, outerLine), List(tildeThree, quotedLine, tildeThree, outerLine))
pure val fair_consume = "weak"
pure def leadsToLoadedLinesConsumed(p: FenceParser, later: FenceParser): bool = p.loaded implies later.cursor == p.lines.length()
```
