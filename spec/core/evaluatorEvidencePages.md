# Complete evaluator evidence pages

[The assistant evidence page implementation](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/plugins/plugin-assistant/src/services/evaluator-evidence-page.ts)
charges each complete model evidence record by its UTF-8 representation.
The adapter supplies authoritative room order and byte counts after removing
recovery transport fields from the model-facing projection. The original
stored records and the complete model evidence identity are preserved.

## Story: Request an earlier complete page without applying the current response

As an evaluator, I can request additional historical context by a visible
source ID. The model response carrying that request defers reducer effects
while the runtime restores whole records and resubmits inference. A missing,
repeated, or exhausted cursor is an explicit error.

### The preceding page includes only whole records before its cursor

The cursor names one exact row in the ordered snapshot. Read backward from
that row and stop at the first record that would exceed the byte budget.
Return the retained suffix in original order. Reject an oversized first
record and report when unseen earlier records remain.

```quint
type EvidenceRow = { identity: str, body: str, bytes: int }
type EvidencePageStatus = PageAccepted | InvalidBudget | InvalidCursor | SourceTooLarge | CursorExhausted | ReferenceBudgetExceeded
type PageScan = { before: List[EvidenceRow], reached: bool }
type PageBuild = { rows: List[EvidenceRow], remaining: int, overflowed: bool, cannotFitFirst: bool }
type EvidencePage = { status: EvidencePageStatus, rows: List[EvidenceRow], hasEarlier: bool }
pure val emptyScan: PageScan = { before: List(), reached: false }
pure val pageA: EvidenceRow = { identity: "a", body: "complete first", bytes: 4 }
pure val pageB: EvidenceRow = { identity: "b", body: "complete second", bytes: 5 }
pure val pageC: EvidenceRow = { identity: "c", body: "complete trigger", bytes: 6 }
pure val orderedValues = Set(List(), List(pageA), List(pageA, pageB, pageC))
pure val cursorValues = Set("a", "b", "c", "missing")
pure val maxBytesValues = Set(0, 4, 5, 9, 20)
pure def rejectedPage(status: EvidencePageStatus): EvidencePage = { status: status, rows: List(), hasEarlier: false }
pure def prependBefore(cursor: str, ordered: List[EvidenceRow]): PageScan =
  ordered.foldl(emptyScan, (scan, row) =>
    if (scan.reached) scan
    else if (row.identity == cursor) { ...scan, reached: true }
    else { ...scan, before: List(row).concat(scan.before) })
pure def previousPage(ordered: List[EvidenceRow], cursor: str, maxBytes: int): EvidencePage = {
  val prior = prependBefore(cursor, ordered)
  val start: PageBuild = { rows: List(), remaining: maxBytes, overflowed: false, cannotFitFirst: false }
  val result = prior.before.foldl(start, (build, row) =>
    if (build.overflowed) build
    else if (row.bytes > build.remaining) { ...build, overflowed: true, cannotFitFirst: build.rows.length() == 0 }
    else { ...build, remaining: build.remaining - row.bytes, rows: List(row).concat(build.rows) })
  if (maxBytes <= 0) rejectedPage(InvalidBudget)
  else if (not(prior.reached)) rejectedPage(InvalidCursor)
  else if (result.cannotFitFirst) rejectedPage(SourceTooLarge)
  else { status: PageAccepted, rows: result.rows, hasEarlier: result.overflowed }
}
pure def lawInvalidEvidenceBudgetHasNoPage(ordered: List[EvidenceRow], cursor: str, maxBytes: int): bool =
  maxBytes <= 0 implies previousPage(ordered, cursor, maxBytes) == rejectedPage(InvalidBudget)
pure def lawMissingCursorHasNoPage(ordered: List[EvidenceRow], cursor: str, maxBytes: int): bool =
  maxBytes > 0 and not(ordered.some(row => row.identity == cursor)) implies previousPage(ordered, cursor, maxBytes) == rejectedPage(InvalidCursor)
```

### Restoration checks visibility and repeats before reading another page

The accepted cursor must occur in selected or previously restored evidence.
The same cursor cannot be used twice. The complete preceding page must exist.
Restoration charges the actual serialized reference collection against four
times the page budget, including the literal JSON framing. Its accepted
records retain their original revisions and belong to reference context.

```quint
pure def restorationDecision(cursor: str, visible: List[str], requested: List[str], page: EvidencePage, totalReferenceBytes: int, maxBytes: int): EvidencePageStatus =
  if (maxBytes <= 0) InvalidBudget
  else if (not(visible.includes(cursor)) or requested.includes(cursor)) InvalidCursor
  else if (page.status != PageAccepted) page.status
  else if (page.rows.length() == 0) CursorExhausted
  else if (totalReferenceBytes < 0 or totalReferenceBytes > 4 * maxBytes) ReferenceBudgetExceeded
  else PageAccepted
pure def lawRepeatedCursorCannotRestore(cursor: str, visible: List[str], requested: List[str], page: EvidencePage, totalReferenceBytes: int, maxBytes: int): bool =
  requested.includes(cursor) implies restorationDecision(cursor, visible, requested, page, totalReferenceBytes, maxBytes) != PageAccepted
pure def lawAcceptedReferenceWithinBudget(cursor: str, visible: List[str], requested: List[str], page: EvidencePage, totalReferenceBytes: int, maxBytes: int): bool =
  restorationDecision(cursor, visible, requested, page, totalReferenceBytes, maxBytes) == PageAccepted implies
    0 <= totalReferenceBytes and totalReferenceBytes <= 4 * maxBytes
pure val acceptedPage: EvidencePage = { status: PageAccepted, rows: List(pageB), hasEarlier: true }
pure val pageValues = Set(acceptedPage, { ...acceptedPage, rows: List() }, rejectedPage(SourceTooLarge))
pure val visibleValues = Set(List(), List("b", "c"))
pure val requestedValues = Set(List(), List("c"))
pure val totalReferenceBytesValues = Set(0, 5, 9, 25)
```
