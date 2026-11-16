# PDF interpretation

A document task interprets one PDF attachment through a document runtime: a reviewed, separately built artifact that renders each
page of a PDF and sends the image, with its native text evidence, to the
cloud's image description model. The task loads only the exact artifact its
bundle pins, reads the whole document under the authority that admitted
it, and hands the interpreter the complete checked document or nothing. The
artifact loader receives decoded facts from the shell;
the model takes them as inputs and does not judge vision accuracy or store
page data. Native canvas rendering, live inference and live mail are
outside the model.

## Story: Load only the reviewed document runtime

> As a consumer running a document task, I want only the exact document
> runtime my task bundle pins, with every staged file accounted for, to touch
> my documents.

### The private artifact must match the task bundle pin, Canvas version, and bytes

The loader reads the expected source commit from the main task bundle's provenance and supplies it to the reviewed document runtime loader. The consumer supplies the expected Canvas package version from an explicit option or resolves the installed `@napi-rs/canvas` version at the native artifact or development host. The loader requires an absolute path, a lowercase 40-hex expected commit and a nonblank expected Canvas version. It then reads the JSON sidecar and artifact bytes. Schema must be 1, the commit and Canvas version must exactly match, and SHA-256 must match the sidecar. Only then does it import the file URL and check the five callable exports. Read, decode, import and shape failures propagate. The artifact loader assumes the host owns the staged path and is not a substitute for atomic file custody.

The PDF model is explicit and bound to the admitted actor. The Cloud document port requires its credential gate, ready state, generation and same actor before and after credential lookup and inference. It rejects a conflicting resolved authority tuple and ambient application attribution. The mail read port separately receives the admitted grant when present. The document adapter dispatches only `IMAGE_DESCRIPTION`, with the exact image model the task names. Usage reporting carries model name and finite nonnegative prompt, completion and total counts. Every step re-checks the same scope: the owner is current, the run is not aborted, the credential gate allows outbound calls, the resolved authority is exact and no ambient application attribution is present.

```quint
import numbers as Num from "../core/numbers"
type ArtifactInput = { absolutePath: bool, expectedCommitFormat: bool, expectedCanvasNonblank: bool, readableDecoded: bool, schema: int, taskCommitMatches: bool, canvasMatches: bool, bundleHashMatches: bool, importSucceeded: bool, pdfService: bool, imageDescription: bool, resolveAuthority: bool, nativeSlot: bool, callerAttribution: bool }
pure def artifactImportAllowed(artifact: ArtifactInput): bool =
  artifact.absolutePath and artifact.expectedCommitFormat and artifact.expectedCanvasNonblank and artifact.readableDecoded and
  artifact.schema == 1 and artifact.taskCommitMatches and artifact.canvasMatches and artifact.bundleHashMatches
pure def artifactUsable(artifact: ArtifactInput): bool =
  artifactImportAllowed(artifact) and artifact.importSucceeded and artifact.pdfService and artifact.imageDescription and artifact.resolveAuthority and artifact.nativeSlot and artifact.callerAttribution
pure def lawBadProvenanceCannotImport(artifact: ArtifactInput): bool =
  not(artifact.taskCommitMatches and artifact.canvasMatches and artifact.bundleHashMatches) implies not(artifactImportAllowed(artifact))
pure def lawMissingCallableCannotSupplyPdf(artifact: ArtifactInput): bool =
  not(artifact.pdfService and artifact.imageDescription and artifact.resolveAuthority and artifact.nativeSlot and artifact.callerAttribution) implies not(artifactUsable(artifact))
pure val reviewedArtifact: ArtifactInput = { absolutePath: true, expectedCommitFormat: true, expectedCanvasNonblank: true, readableDecoded: true, schema: 1, taskCommitMatches: true, canvasMatches: true, bundleHashMatches: true, importSucceeded: true, pdfService: true, imageDescription: true, resolveAuthority: true, nativeSlot: true, callerAttribution: true }
pure val artifactValues = Set(reviewedArtifact, { ...reviewedArtifact, absolutePath: false }, { ...reviewedArtifact, schema: 2 }, { ...reviewedArtifact, taskCommitMatches: false }, { ...reviewedArtifact, canvasMatches: false }, { ...reviewedArtifact, bundleHashMatches: false }, { ...reviewedArtifact, importSucceeded: false }, { ...reviewedArtifact, imageDescription: false })
```

## Story: Interpret the complete attachment only while it is still authorized

> As a user whose attachment a task reads, I want the whole document read
> and checked before anything is interpreted from it, and nothing returned
> once my authorization is gone or I cancel.

### The PDF service reads a copied byte array and checks every rendered page

The document attachment policy reads exact MIME `application/pdf` and reports other formats unsupported. The parser requires the lifecycle callback and a Uint8Array. The PDF service rejects empty input and a missing `%PDF-` header within the first 1,024 bytes. It copies accepted bytes before unpdf can transfer the backing buffer. It requires a positive safe integer parser-declared page count. This complete-extraction API uses all declared pages and has no max-page or preview-input option. The document task's parser passes the signal and lifecycle check only, so render scale defaults to 2 and OCR is absent.

For each page, sequentially in 1-based order, the service collects flattened native text, positioned native text and operator-list evidence, renders a data-image URL with Canvas, decodes its bytes and sends the image with the full evidence to a nonstreaming `IMAGE_DESCRIPTION` call. The optional service OCR port runs before inference when installed. A blank report means an exact trimmed `[BLANK PAGE]`. It is accepted only if native and OCR text are both empty and either the parser sees no operators or OCR ran. Nonblank vision gets `native+vision` with native text or `vision` without. Empty vision or conflicting blank rejects the page. The returned page has dimensions, native text, positioned text, OCR text or null, vision text, combined text and visual-operator evidence. Even accepted blank pages have nonempty vision text. The model uses decoded evidence booleans and an opaque page reference so it doesn't predict vision accuracy or store page data.

```quint
type PdfInput = { exactMime: bool, bytes: bool, nonempty: bool, headerInFirst1024: bool, lifecyclePort: bool }
pure def pdfInputAccepted(pdfInput: PdfInput): bool =
  pdfInput.exactMime and pdfInput.bytes and pdfInput.nonempty and pdfInput.headerInFirst1024 and pdfInput.lifecyclePort
pure def validDeclaredPages(pageCount: int): bool = pageCount > 0 and pageCount <= Num::maxSafeInteger
type PageText = { nativeNonempty: bool, noOperators: bool, ocrRan: bool, ocrNonempty: bool, visionNonempty: bool, visionBlank: bool }
type PageMethod = BlankPage | NativeVisionPage | VisionPage | InvalidPage
pure def pageMethod(pageText: PageText): PageMethod =
  if (not(pageText.visionNonempty)) InvalidPage
  else if (pageText.visionBlank)
    if (not(pageText.nativeNonempty or pageText.ocrNonempty) and (pageText.noOperators or pageText.ocrRan)) BlankPage else InvalidPage
  else if (pageText.nativeNonempty) NativeVisionPage else VisionPage
pure def lawBlankCannotOverrideTextEvidence(pageText: PageText): bool =
  pageMethod(pageText) == BlankPage implies pageText.visionNonempty and pageText.visionBlank and not(pageText.nativeNonempty or pageText.ocrNonempty) and (pageText.noOperators or pageText.ocrRan)
pure def lawEmptyVisionFailsThePage(pageText: PageText): bool =
  not(pageText.visionNonempty) implies pageMethod(pageText) == InvalidPage
pure val nativeVision: PageText = { nativeNonempty: true, noOperators: false, ocrRan: false, ocrNonempty: false, visionNonempty: true, visionBlank: false }
pure val rasterVision: PageText = { ...nativeVision, nativeNonempty: false }
pure val pageTextValues = Set(nativeVision, rasterVision, { ...rasterVision, visionNonempty: false }, { ...nativeVision, visionBlank: true }, { ...rasterVision, visionBlank: true }, { ...rasterVision, visionBlank: true, noOperators: true }, { ...rasterVision, visionBlank: true, ocrRan: true }, { ...rasterVision, visionBlank: true, ocrRan: true, ocrNonempty: true })
```

### The interpreter receives the same full checked document

The service returns `complete: true` only after every declared page, with full numbered text and the ordered page array. The task's parser rechecks the envelope and the array length. Each page needs its exact 1-based number, a recognized method, string native text and nonblank string vision text. A malformed envelope or any malformed page fails before interpretation. The mapper receives the identical document, original task context and a frozen lifecycle control with the original signal and callback. Authorization is rechecked after mapping before the return. Parsing or interpreting under that control does not select or publish a durable result.

During extraction, abort and a rejection thrown by the local lifecycle callback take precedence over page failure formatting. A rejected inference is mapped to `PDF_PAGE_TRANSCRIPTION_UNAVAILABLE` unless aborted. This includes a rejection from the Cloud vision dependency’s own owner guard. The failure input records the observed callback rejection separately from a rejected vision promise. Other required per-page errors keep the failing page and declared count in the error. The process stops on the first failed page. A pending render or provider response can finish after cancellation. It cannot move the attachment to interpretation or return an interpreted value. On a stopped run, the model forgets its unpublished page references. It prescribes no cancellation of a request already accepted by an external provider.

```quint
type ScopeCheck = { ownerCurrent: bool, notAborted: bool, outboundAllowed: bool, exactAuthority: bool, ambientAttribution: bool }
pure def scopeCurrent(scope: ScopeCheck): bool = scope.ownerCurrent and scope.notAborted and scope.outboundAllowed and scope.exactAuthority and not(scope.ambientAttribution)
type WirePage = { number: int, method: PageMethod, nativeString: bool, visionNonblankString: bool }
type DocumentEnvelope = { completeFlag: bool, pageCount: int, pagesArray: bool, pages: List[WirePage] }
pure def wirePageAccepted(page: WirePage, number: int): bool =
  page.number == number and page.nativeString and page.visionNonblankString and
  page.method != InvalidPage
type WirePageCount = { count: int, valid: bool }
pure val emptyWirePageCount: WirePageCount = { count: 0, valid: true }
pure def documentAccepted(envelope: DocumentEnvelope): bool = {
  val checked = envelope.pages.foldl(emptyWirePageCount, (previous, page) =>
    { count: previous.count + 1, valid: previous.valid and wirePageAccepted(page, previous.count + 1) })
  envelope.completeFlag and validDeclaredPages(envelope.pageCount) and envelope.pagesArray and envelope.pages.length() == envelope.pageCount and checked.valid
}
type PdfFailure = { aborted: bool, lifecycleRejected: bool, visionRejected: bool }
type PdfFailureKind = NoFailure | FailureAborted | FailureOwnerLost | FailureTranscriptionUnavailable | FailurePageFailed
pure def pageFailure(failureInput: PdfFailure): PdfFailureKind =
  if (failureInput.aborted) FailureAborted
  else if (failureInput.lifecycleRejected) FailureOwnerLost
  else if (failureInput.visionRejected) FailureTranscriptionUnavailable
  else FailurePageFailed
pure def lawNoShortOrOversizedPageArray(envelope: DocumentEnvelope): bool =
  documentAccepted(envelope) implies envelope.completeFlag and envelope.pagesArray and envelope.pages.length() == envelope.pageCount
pure def lawAbortPrecedesPageFailure(failureInput: PdfFailure): bool =
  failureInput.aborted implies pageFailure(failureInput) == FailureAborted
pure val pageFault: PdfFailure = { aborted: false, lifecycleRejected: false, visionRejected: false }
pure val failureInputValues = Set(pageFault, { ...pageFault, aborted: true }, { ...pageFault, lifecycleRejected: true }, { ...pageFault, visionRejected: true }, { ...pageFault, aborted: true, visionRejected: true })
pure val held: ScopeCheck = { ownerCurrent: true, notAborted: true, outboundAllowed: true, exactAuthority: true, ambientAttribution: false }
pure val scopeValues = Set(held, { ...held, ownerCurrent: false }, { ...held, notAborted: false }, { ...held, outboundAllowed: false }, { ...held, exactAuthority: false }, { ...held, ambientAttribution: true })
pure val firstWirePage: WirePage = { number: 1, method: NativeVisionPage, nativeString: true, visionNonblankString: true }
pure val secondWirePage: WirePage = { ...firstWirePage, number: 2, method: VisionPage }
pure val onePage: DocumentEnvelope = { completeFlag: true, pageCount: 1, pagesArray: true, pages: List(firstWirePage) }
pure val twoPages: DocumentEnvelope = { completeFlag: true, pageCount: 2, pagesArray: true, pages: List(firstWirePage, secondWirePage) }
pure val envelopeValues = Set(onePage, twoPages, { ...onePage, completeFlag: false }, { ...twoPages, pages: List(firstWirePage) }, { ...twoPages, pages: List(secondWirePage, firstWirePage) }, { ...onePage, pages: List({ ...firstWirePage, method: BlankPage }) }, { ...onePage, pages: List({ ...firstWirePage, visionNonblankString: false }) })
```

### Partial or stale page work cannot produce a mapped value

The machine models one admitted attachment. A start supplies a validated PDF input, declared page count, document identity and current control. Each page's required render finishes before image inference can start. A readback with the same exact ordinal and valid method contributes one page. The per-page index and number of completed pages move together. A response with a mismatched ordinal or a wrong work phase is ineligible. The assembled document enters mapping only once all pages have finished and the parser has validated its envelope. The identity supplied for the exact complete envelope must match the started document; the mapper gets the unchanged identity and complete page list. A positive mapped identity can stand for any returned interpreter value including an empty result. Cancellation, lost ownership and parser, vision or mapper failures terminate in-flight work without a mapped value. Invalid evidence at an active source stage follows the explicit failure event. The source can neither prepare the next page nor map again after an explicit terminal event.

```quint
type PdfPhase = PdfNew | PdfPage | PdfRendered | PdfVision | PdfMapping | PdfReturned | PdfFailed
type PdfRun = { phase: PdfPhase, pageCount: int, completed: int, documentRef: int, mappedRef: int, failure: PdfFailureKind }
pure val initial: PdfRun = { phase: PdfNew, pageCount: 0, completed: 0, documentRef: 0, mappedRef: 0, failure: NoFailure }
pure def canOpenPdf(pdfRun: PdfRun, pdfInput: PdfInput, pageCount: int, documentRef: int, scope: ScopeCheck): bool =
  pdfRun.phase == PdfNew and pdfInputAccepted(pdfInput) and validDeclaredPages(pageCount) and documentRef > 0 and scopeCurrent(scope)
pure def openPdf(pdfRun: PdfRun, pdfInput: PdfInput, pageCount: int, documentRef: int, scope: ScopeCheck): PdfRun =
  { ...pdfRun, phase: PdfPage, pageCount: pageCount, documentRef: documentRef }
pure def canRenderPdfPage(pdfRun: PdfRun, pageNumber: int, imageDecoded: bool, scope: ScopeCheck): bool =
  pdfRun.phase == PdfPage and pdfRun.completed < pdfRun.pageCount and pageNumber == pdfRun.completed + 1 and imageDecoded and scopeCurrent(scope)
pure def renderPdfPage(pdfRun: PdfRun, pageNumber: int, imageDecoded: bool, scope: ScopeCheck): PdfRun = { ...pdfRun, phase: PdfRendered }
pure def canRequestVision(pdfRun: PdfRun, scope: ScopeCheck): bool = pdfRun.phase == PdfRendered and scopeCurrent(scope)
pure def requestVision(pdfRun: PdfRun, scope: ScopeCheck): PdfRun = { ...pdfRun, phase: PdfVision }
pure def canKeepPdfPage(pdfRun: PdfRun, pageNumber: int, pageText: PageText, scope: ScopeCheck): bool =
  pdfRun.phase == PdfVision and pdfRun.completed < pdfRun.pageCount and pageNumber == pdfRun.completed + 1 and pageMethod(pageText) != InvalidPage and scopeCurrent(scope)
pure def keepPdfPage(pdfRun: PdfRun, pageNumber: int, pageText: PageText, scope: ScopeCheck): PdfRun =
  { ...pdfRun, phase: PdfPage, completed: pdfRun.completed + 1 }
pure def canStartInterpretation(pdfRun: PdfRun, envelope: DocumentEnvelope, checkedDocumentRef: int, scope: ScopeCheck): bool =
  pdfRun.phase == PdfPage and pdfRun.completed == pdfRun.pageCount and checkedDocumentRef == pdfRun.documentRef and
  envelope.pageCount == pdfRun.pageCount and documentAccepted(envelope) and scopeCurrent(scope)
pure def startInterpretation(pdfRun: PdfRun, envelope: DocumentEnvelope, checkedDocumentRef: int, scope: ScopeCheck): PdfRun = { ...pdfRun, phase: PdfMapping }
pure def canReturnInterpretation(pdfRun: PdfRun, mappedRef: int, scope: ScopeCheck): bool =
  pdfRun.phase == PdfMapping and mappedRef > 0 and scopeCurrent(scope)
pure def returnInterpretation(pdfRun: PdfRun, mappedRef: int, scope: ScopeCheck): PdfRun =
  { ...pdfRun, phase: PdfReturned, mappedRef: mappedRef }
pure def canFailPdf(pdfRun: PdfRun): bool = pdfRun.phase != PdfReturned and pdfRun.phase != PdfFailed
pure def failPdf(pdfRun: PdfRun, failureInput: PdfFailure): PdfRun =
  { ...initial, phase: PdfFailed, failure: pageFailure({ ...failureInput, visionRejected: failureInput.visionRejected and pdfRun.phase == PdfVision }) }
pure def alwaysAcceptedCountWithinDeclaration(pdfRun: PdfRun): bool =
  pdfRun.completed >= 0 and pdfRun.completed <= pdfRun.pageCount
pure def alwaysNoPartialInterpretation(pdfRun: PdfRun): bool =
  (pdfRun.phase == PdfMapping or pdfRun.phase == PdfReturned) implies pdfRun.pageCount > 0 and pdfRun.completed == pdfRun.pageCount and pdfRun.documentRef > 0
pure def alwaysOnlyACompletedInterpretationReturns(pdfRun: PdfRun): bool =
  if (pdfRun.phase == PdfReturned) pdfRun.mappedRef > 0 else pdfRun.mappedRef == 0
pure def alwaysFailureKeepsNoUnpublishedPage(pdfRun: PdfRun): bool =
  pdfRun.phase == PdfFailed implies pdfRun.completed == 0 and pdfRun.documentRef == 0 and pdfRun.failure != NoFailure
pure def stepOnlyAcceptedPageAdvances(before: PdfRun, via: str, after: PdfRun): bool =
  after.completed > before.completed implies via == "keepPdfPage" and after.completed == before.completed + 1 and after.documentRef == before.documentRef
pure def sometimesTwoPagesReachInterpretation(pdfRun: PdfRun): bool =
  pdfRun.phase == PdfReturned and pdfRun.pageCount == 2 and pdfRun.completed == 2
pure def sometimesRevokedPdfFails(pdfRun: PdfRun): bool = pdfRun.phase == PdfFailed and pdfRun.failure == FailureOwnerLost
pure def sometimesVisionFailureIsTyped(pdfRun: PdfRun): bool = pdfRun.phase == PdfFailed and pdfRun.failure == FailureTranscriptionUnavailable
pure val pdfInputValues = Set({ exactMime: true, bytes: true, nonempty: true, headerInFirst1024: true, lifecyclePort: true }, { exactMime: false, bytes: true, nonempty: true, headerInFirst1024: true, lifecyclePort: true })
pure val pageCountValues = Set(0, 1, 2)
pure val pageNumberValues = Set(0, 1, 2, 3)
pure val documentRefValues = Set(0, 1)
pure val checkedDocumentRefValues = Set(0, 1, 2)
pure val mappedRefValues = Set(0, 1, 2)
pure val weight_openPdf = 10
pure val weight_renderPdfPage = 10
pure val weight_requestVision = 8
pure val weight_keepPdfPage = 10
pure val weight_startInterpretation = 10
pure val weight_returnInterpretation = 8
```

### A run holds a document only from start until it fails

A fresh run has no declared or completed pages and no document identity. A
run that has started keeps the admitted positive page declaration and
document identity until failure discards them, so no mapping phase runs
without its source document.

Discovered by the proof: without these facts a mapping phase with no source
document, or a new run that already holds pages, could not be ruled out.

```quint
pure def alwaysFreshPdfHasNoDocument(pdfRun: PdfRun): bool =
  pdfRun.phase == PdfNew implies pdfRun.pageCount == 0 and pdfRun.completed == 0 and pdfRun.documentRef == 0
pure def alwaysStartedPdfKeepsDeclaration(pdfRun: PdfRun): bool =
  (pdfRun.phase != PdfNew and pdfRun.phase != PdfFailed) implies validDeclaredPages(pdfRun.pageCount) and pdfRun.documentRef > 0
```
