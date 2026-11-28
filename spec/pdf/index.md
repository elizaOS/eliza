# PDF extraction

The PDF service extracts native text and metadata locally. Complete
extraction additionally renders every page through the
runtime's image description capability. The calling host owns file
admission and revocable operation authority.

## Story: Read text and metadata from a PDF

> As a caller, I want native text for the pages I ask for, with existing
> breaks and adjoining text runs preserved.

### A text query selects a range and preserves native run order

Pages are numbered from one. A range is inclusive and begins on an existing
page. A requested end beyond the document means through the last page.
Local native extraction emits each run as supplied by the PDF decoder
and emits breaks only where the decoder indicates them. Text-only reads do
not claim visual extraction. When normalizing PDF `D:` date timestamps to
UTC, a positive UTC offset (`+HH'mm'`) subtracts from the wall time and a
negative UTC offset (`-HH'mm'`) adds to the wall time, while `Z` and local
dates apply a zero offset.

```quint
type PdfReadMode = NativeText | CompleteDocument
type PageWindow = { first: int, lastPage: int }
pure def validPdfWindow(window: PageWindow, pageCount: int): bool =
  window.first > 0 and window.first <= window.lastPage and window.lastPage <= pageCount
pure def normalizedPdfLast(lastPage: int, pageCount: int): int = if (lastPage > pageCount) pageCount else lastPage
pure def pageInWindow(window: PageWindow, pageNumber: int): bool =
  window.first <= pageNumber and pageNumber <= window.lastPage
pure val windowValues: Set[PageWindow] = Set({ first: 1, lastPage: 3 }, { first: 2, lastPage: 2 }, { first: 3, lastPage: 1 })
pure def lawOutsideWindowIsExcluded(window: PageWindow, pageNumber: int): bool =
  (pageNumber < window.first or pageNumber > window.lastPage) implies not(pageInWindow(window, pageNumber))
type TextRun = { letters: str, hardBreak: bool }
type PdfUtcRelation = UtcZulu | UtcPlus | UtcMinus | UtcLocal
pure def pdfUtcOffsetMs(relation: PdfUtcRelation, offsetMinutes: int): int =
  if (relation == UtcPlus) -(offsetMinutes * 60000)
  else if (relation == UtcMinus) offsetMinutes * 60000
  else 0
pure def lawPositiveOffsetSubtractsFromWall(offsetMinutes: int): bool =
  offsetMinutes > 0 implies pdfUtcOffsetMs(UtcPlus, offsetMinutes) < 0
pure def lawNegativeOffsetAddsToWall(offsetMinutes: int): bool =
  offsetMinutes > 0 implies pdfUtcOffsetMs(UtcMinus, offsetMinutes) > 0
pure val offsetMinutesValues = Set(0, 30, 300)
```

### A blank visual claim is accepted only when no contradicting text or unchecked drawing exists

In complete extraction, a `[BLANK PAGE]` claim from the vision model is
accepted as a blank page only when native text is absent, OCR text is absent,
and either the page contains no drawing operators or OCR ran and confirmed no
text. Otherwise the claim conflicts with evidence and the page fails.

```quint
type CompletePageMethod = MethodNative | MethodNativeVision | MethodVision | MethodBlank | MethodConflict
pure def classifyCompletePage(hasNativeText: bool, visionBlank: bool, visionHasText: bool, hasOcrText: bool, ocrRan: bool, hasOperators: bool): CompletePageMethod =
  if (not(visionBlank) and not(visionHasText)) MethodConflict
  else if (visionBlank)
    if (hasNativeText or hasOcrText or (hasOperators and not(ocrRan))) MethodConflict else MethodBlank
  else if (hasNativeText) MethodNativeVision
  else MethodVision
pure def lawBlankClaimWithNativeOrOcrConflicts(hasNativeText: bool, hasOcrText: bool, ocrRan: bool, hasOperators: bool): bool =
  (hasNativeText or hasOcrText) implies classifyCompletePage(hasNativeText, true, false, hasOcrText, ocrRan, hasOperators) == MethodConflict
pure def lawBlankClaimOnDrawnPageWithoutOcrConflicts(hasNativeText: bool, hasOcrText: bool): bool =
  classifyCompletePage(hasNativeText, true, false, hasOcrText, false, true) == MethodConflict
```

## Story: Extract a complete document while my request is active

> As a caller, I want every requested page, including text from page images,
> and I want cancellation to discard incomplete results.

### Complete extraction visits every selected page in order

An extraction is scoped to one immutable request and its bound document.
Render and inspect every declared page in order. The shell rechecks the caller at
entry and before each OCR or model dispatch, forwards cancellation,
and decodes the correctly correlated page's observation before recording
it. A missing required visual result fails the request.

```quint
type PdfPhase = IdlePdf | ReadingPdf | PdfReady | PdfRefused | PdfCancelled
type PdfRead = { phase: PdfPhase, kind: PdfReadMode, document: str, first: int, lastPage: int, nextPage: int }
pure val initial: PdfRead = { phase: IdlePdf, kind: NativeText, document: "", first: 0, lastPage: 0, nextPage: 0 }
pure def canBeginPdfRead(s: PdfRead, kind: PdfReadMode, document: str, first: int, lastPage: int, pageCount: int, authorized: bool): bool = {
  val finalPage = normalizedPdfLast(lastPage, pageCount)
  s.phase == IdlePdf and document != "" and validPdfWindow({ first: first, lastPage: finalPage }, pageCount) and
    (kind == CompleteDocument implies first == 1 and finalPage == pageCount) and finalPage < 9007199254740991 and authorized
}
pure def beginPdfRead(s: PdfRead, kind: PdfReadMode, document: str, first: int, lastPage: int, pageCount: int, authorized: bool): PdfRead =
  { phase: ReadingPdf, kind: kind, document: document, first: first, lastPage: normalizedPdfLast(lastPage, pageCount), nextPage: first }
pure def pdfPageRequiresVisual(kind: PdfReadMode): bool = kind == CompleteDocument
pure def canRecordPdfPage(s: PdfRead, document: str, pageNumber: int, visualSucceeded: bool, authorized: bool): bool =
  s.phase == ReadingPdf and s.document == document and s.nextPage == pageNumber and s.nextPage <= s.lastPage and
    s.nextPage < 9007199254740991 and authorized and
    (pdfPageRequiresVisual(s.kind) implies visualSucceeded)
pure def recordPdfPage(s: PdfRead, document: str, pageNumber: int, visualSucceeded: bool, authorized: bool): PdfRead =
  { ...s, nextPage: s.nextPage + 1 }
pure def canFailPdfRead(s: PdfRead): bool = s.phase == ReadingPdf
pure def failPdfRead(s: PdfRead): PdfRead = { ...s, phase: PdfRefused }
pure def canCancelPdfRead(s: PdfRead): bool = s.phase == ReadingPdf
pure def cancelPdfRead(s: PdfRead): PdfRead = { ...s, phase: PdfCancelled }
pure def alwaysPdfVisitRangeHolds(s: PdfRead): bool =
  s.phase != IdlePdf implies s.first > 0 and s.first <= s.lastPage and s.lastPage < 9007199254740991 and s.nextPage >= s.first and s.nextPage <= s.lastPage + 1
```

### Publication needs every page and current authority

An incomplete, failed, or cancelled extraction cannot publish as complete.
A correct but late answer remains discarded after authorization was lost.

```quint
pure def canPublishPdfRead(s: PdfRead, authorized: bool): bool =
  s.phase == ReadingPdf and s.nextPage > s.lastPage and authorized
pure def publishPdfRead(s: PdfRead, authorized: bool): PdfRead = { ...s, phase: PdfReady }
pure def alwaysPublishedPdfHasEveryPage(s: PdfRead): bool =
  s.phase == PdfReady implies s.nextPage == s.lastPage + 1
pure def stepPdfTerminalOutcomeRemains(before: PdfRead, after: PdfRead): bool =
  (before.phase == PdfReady or before.phase == PdfCancelled or before.phase == PdfRefused) implies after == before
pure val documentValues = Set("", "pdf-a", "pdf-b")
pure def sometimesCompletePdfPublishes(s: PdfRead): bool = s.phase == PdfReady and s.kind == CompleteDocument
pure val eval_witness_sometimesCompletePdfPublishes = (("beginPdfRead", CompleteDocument, "pdf-a", 1, 1, 1, true), ("recordPdfPage", "pdf-a", 1, true, true), ("publishPdfRead", true))
```
