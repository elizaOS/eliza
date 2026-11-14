# Grace configured Cloud bill PDF execution

Grace pin `48b43b9ca6ade7b72c6488f92bee6d4a3ddcf154` consumes the Eliza host and PDF service at `7743504b7c936a764b3938a44cad918808b621df`. Native release sets the controlled-helper switch to zero. Native debug and explicitly configured host development can load this path. The Android staged runtime and the local development bundle serve the exact pinned loader with no renderer-supplied file path. This contract covers one configured bill attachment from helper composition through the whole-document interpreter return. Cloud credential and grant ownership, attachment discovery and selection, and rendered Gmail preview have independent contracts. The original fixtures exercise local PDF parsing and rendering with controlled Google and inference responses.

Grace `apps/app/scripts/test-bill-pdf-extraction.ts` builds and loads the reviewed document artifact, renders both pages of native and scanned fixture bills, checks exact PNG-bearing Cloud requests, preserves the attachment digest through durable selection, and checks cancellation during page-one inference. Eliza `packages/cloud/sdk/native-host/document-runtime.test.mjs` and `plugins/plugin-personal-assistant/native-host/load-configured-bill-helper.test.mjs` exercise exact artifact and configuration admission. Eliza `plugins/plugin-pdf/__tests__/pdf-service.integration.test.ts` exercises actual unpdf text and Canvas blank-page reconciliation. Eliza `packages/host/native-host/android-documents.test.mjs` exercises local optional manifest, bytes, ABI and task-source rejection. Android instrumented native Canvas, live Cloud inference and live Gmail are external to these proofs.

## Story: Load only the configured and reviewed document runtime

### The host chooses the helper before the document runtime can be considered

Native composition reads the private root's `helper.json` only if `GRACE_ALLOW_CONTROLLED_HELPER` is exactly `1`. Development requires an explicit nonempty `GRACE_HELPER_CONFIG`. With no path, or a native path that returns `ENOENT`, the gateway composes the website guide. Other configuration read failures propagate, including a missing explicit development configuration. A successfully read helper without a configured PDF model loads without PDF support. For a configured PDF model, a missing document path fails the helper load. The native document path is the staged `gateway/document-services.mjs`; the development path is `GRACE_DOCUMENT_RUNTIME`. Decoded configuration facts are supplied by the shell.

Grace `apps/app/native/java/technology/graceful/grace/LocalRuntimeService.java:484`, `apps/app/host/local-agent-gateway.ts:56–73,529–538`. Eliza `plugins/plugin-personal-assistant/native-host/load-configured-bill-helper.mjs:18–40`.

```quint
type HelperInput = { nativeHost: bool, nativeSwitch: str, explicitDevelopmentPath: bool, configRead: str, pdfModelConfigured: bool, documentPath: bool }
pure def controlledPath(input: HelperInput): bool =
  if (input.nativeHost) input.nativeSwitch == "1" else input.explicitDevelopmentPath
pure def helperSelection(input: HelperInput): str =
  if (not(controlledPath(input)) or (input.nativeHost and input.configRead == "missing")) "website-guide"
  else if (input.configRead != "read") "configuration-error"
  else if (not(input.pdfModelConfigured)) "configured-without-pdf"
  else if (not(input.documentPath)) "document-path-required"
  else "check-document-artifact"
pure def lawNativeSwitchBlocksRetainedHelper(input: HelperInput): bool =
  input.nativeHost and input.nativeSwitch != "1" implies helperSelection(input) == "website-guide"
pure def lawDevelopmentMissingExplicitPathIsAnError(input: HelperInput): bool =
  not(input.nativeHost) and input.explicitDevelopmentPath and input.configRead == "missing" implies helperSelection(input) == "configuration-error"
pure def lawPdfSelectionRequiresModelAndPath(input: HelperInput): bool =
  helperSelection(input) == "check-document-artifact" implies controlledPath(input) and input.configRead == "read" and input.pdfModelConfigured and input.documentPath
pure val debugHelper: HelperInput = { nativeHost: true, nativeSwitch: "1", explicitDevelopmentPath: false, configRead: "read", pdfModelConfigured: true, documentPath: true }
pure val inputValues = Set(debugHelper, { ...debugHelper, nativeSwitch: "0" }, { ...debugHelper, configRead: "missing" }, { ...debugHelper, configRead: "invalid" }, { ...debugHelper, pdfModelConfigured: false }, { ...debugHelper, documentPath: false }, { ...debugHelper, nativeHost: false }, { ...debugHelper, nativeHost: false, explicitDevelopmentPath: true, configRead: "missing" })
```

### The private artifact must match the task bundle pin, Canvas version, and bytes

The configured loader reads the expected source commit from the main task bundle's provenance and supplies it to the reviewed document runtime loader. Grace supplies the expected Canvas package version from an explicit option or resolves the installed `@napi-rs/canvas` version at the native artifact or development host. The loader requires an absolute path, a lowercase 40-hex expected commit and a nonblank expected Canvas version. It then reads the JSON sidecar and artifact bytes. Schema must be 1, the commit and Canvas version must exactly match, and SHA-256 must match the sidecar. Only then does it import the file URL and check the five callable exports. Read, decode, import and shape failures propagate. The artifact loader assumes the host owns the staged path and is not a substitute for atomic file custody.

The PDF model is explicit and bound to the configured actor. The Cloud document port requires its credential gate, ready state, generation and same actor before and after credential lookup and inference. It rejects a conflicting resolved authority tuple and ambient application attribution. The Google read port separately receives the configured grant when present. The document adapter dispatches only `IMAGE_DESCRIPTION`, with the exact configured image model. Usage reporting carries model name and finite nonnegative prompt, completion and total counts. The existing Cloud host spec owns authority checks. In this model, `ownerCurrent` and `notAborted` are observations supplied by those guards.

Grace `apps/app/host/document-runtime.ts:1–5`. Eliza `packages/cloud/sdk/native-host/document-runtime.mjs:5–38`, `cloud-services.mjs:2850–2880`, `document-image-describer.mjs:4–78`, `plugins/plugin-personal-assistant/native-host/load-configured-bill-helper.mjs:26–54` and `configured-bill-helper.mjs:190–211`.

```quint
type ArtifactInput = { absolutePath: bool, expectedCommitFormat: bool, expectedCanvasNonblank: bool, readableDecoded: bool, schema: int, taskCommitMatches: bool, canvasMatches: bool, bundleHashMatches: bool, importSucceeded: bool, pdfService: bool, imageDescription: bool, resolveAuthority: bool, nativeSlot: bool, appId: bool }
pure def artifactImportAllowed(artifact: ArtifactInput): bool =
  artifact.absolutePath and artifact.expectedCommitFormat and artifact.expectedCanvasNonblank and artifact.readableDecoded and
  artifact.schema == 1 and artifact.taskCommitMatches and artifact.canvasMatches and artifact.bundleHashMatches
pure def artifactUsable(artifact: ArtifactInput): bool =
  artifactImportAllowed(artifact) and artifact.importSucceeded and artifact.pdfService and artifact.imageDescription and artifact.resolveAuthority and artifact.nativeSlot and artifact.appId
pure def lawBadProvenanceCannotImport(artifact: ArtifactInput): bool =
  not(artifact.taskCommitMatches and artifact.canvasMatches and artifact.bundleHashMatches) implies not(artifactImportAllowed(artifact))
pure def lawMissingCallableCannotSupplyPdf(artifact: ArtifactInput): bool =
  not(artifact.pdfService and artifact.imageDescription and artifact.resolveAuthority and artifact.nativeSlot and artifact.appId) implies not(artifactUsable(artifact))
pure val reviewedArtifact: ArtifactInput = { absolutePath: true, expectedCommitFormat: true, expectedCanvasNonblank: true, readableDecoded: true, schema: 1, taskCommitMatches: true, canvasMatches: true, bundleHashMatches: true, importSucceeded: true, pdfService: true, imageDescription: true, resolveAuthority: true, nativeSlot: true, appId: true }
pure val artifactValues = Set(reviewedArtifact, { ...reviewedArtifact, absolutePath: false }, { ...reviewedArtifact, schema: 2 }, { ...reviewedArtifact, taskCommitMatches: false }, { ...reviewedArtifact, canvasMatches: false }, { ...reviewedArtifact, bundleHashMatches: false }, { ...reviewedArtifact, importSucceeded: false }, { ...reviewedArtifact, imageDescription: false })
```

### A package must account for every staged document file and the selected Canvas ABI

The document builder requires the actual Git checkout root, a clean exact reviewed commit, and a Canvas dependency matching the requested version. It bundles the five runtime exports, leaves Canvas external, and writes a schema-1 provenance sidecar for the resulting bytes. Optional Android packing can omit the document manifest only when there is neither a staged runtime bundle nor a staged document library. A present manifest must name the exact target and a valid commit. Its nonempty unique files must be regular and digest-matching. Listed paths must be under the gateway directory or be the exact native library path for the selected ABI, with no empty, dot or parent segment. The required files are the bundle, sidecar, Canvas package manifest and selected library. All Canvas package files must be listed with no symlinks. Foreign-ABI Canvas libraries fail, as do native bytes without the expected ELF64, little-endian, shared-object and machine markers. The task and document provenance both name the manifest's commit. The predicate receives inspection results from the packaging boundary. It does not infer file trust from a name or treat a missing optional package as ready.

Eliza `packages/host/native-host/build-document-runtime.mjs:12–43,49–84` and `android-documents.mjs:39–55,96–188`.

```quint
type DocumentPackage = { manifest: bool, stagedBundle: bool, stagedLibrary: bool, schemaTargetCommit: bool, uniqueIndexedFiles: bool, allowedExactFiles: bool, fourRequiredFiles: bool, exclusiveCanvasTree: bool, onlySelectedAbi: bool, expectedElf: bool, taskAndDocumentCommit: bool }
pure def packageStatus(packaging: DocumentPackage): str =
  if (not(packaging.manifest))
    if (packaging.stagedBundle or packaging.stagedLibrary) "invalid" else "absent"
  else if (packaging.schemaTargetCommit and packaging.uniqueIndexedFiles and packaging.allowedExactFiles and packaging.fourRequiredFiles and packaging.exclusiveCanvasTree and packaging.onlySelectedAbi and packaging.expectedElf and packaging.taskAndDocumentCommit) "verified"
  else "invalid"
pure def lawAnOptionalManifestCannotHideStagedBytes(packaging: DocumentPackage): bool =
  not(packaging.manifest) and (packaging.stagedBundle or packaging.stagedLibrary) implies packageStatus(packaging) == "invalid"
pure def lawVerifiedPackageUsesOneReviewedAbi(packaging: DocumentPackage): bool =
  packageStatus(packaging) == "verified" implies packaging.manifest and packaging.exclusiveCanvasTree and packaging.onlySelectedAbi and packaging.expectedElf and packaging.taskAndDocumentCommit
pure val packedDocuments: DocumentPackage = { manifest: true, stagedBundle: true, stagedLibrary: true, schemaTargetCommit: true, uniqueIndexedFiles: true, allowedExactFiles: true, fourRequiredFiles: true, exclusiveCanvasTree: true, onlySelectedAbi: true, expectedElf: true, taskAndDocumentCommit: true }
pure val packagingValues = Set(packedDocuments, { ...packedDocuments, manifest: false }, { ...packedDocuments, manifest: false, stagedBundle: false, stagedLibrary: false }, { ...packedDocuments, onlySelectedAbi: false }, { ...packedDocuments, expectedElf: false }, { ...packedDocuments, allowedExactFiles: false }, { ...packedDocuments, taskAndDocumentCommit: false })
```

## Story: Interpret the complete attachment only while it is still authorized

### The PDF service reads a copied byte array and checks every rendered page

The bill attachment policy reads exact MIME `application/pdf` and reports other formats unsupported. The parser requires the lifecycle callback and a Uint8Array. The PDF service rejects empty input and a missing `%PDF-` header within the first 1,024 bytes. It copies accepted bytes before unpdf can transfer the backing buffer. It requires a positive safe integer parser-declared page count. This complete-extraction API uses all declared pages and has no max-page or preview-input option. The configured bill parser passes the signal and lifecycle check only, so render scale defaults to 2 and OCR is absent.

For each page, sequentially in 1-based order, the service collects flattened native text, positioned native text and operator-list evidence, renders a data-image URL with Canvas, decodes its bytes and sends the image with the full evidence to a nonstreaming `IMAGE_DESCRIPTION` call. The optional service OCR port runs before inference when installed. A blank report means an exact trimmed `[BLANK PAGE]`. It is accepted only if native and OCR text are both empty and either the parser sees no operators or OCR ran. Nonblank vision gets `native+vision` with native text or `vision` without. Empty vision or conflicting blank rejects the page. The returned page has dimensions, native text, positioned text, OCR text or null, vision text, combined text and visual-operator evidence. Even accepted blank pages have nonempty vision text. The model uses decoded evidence booleans and an opaque page reference so it doesn't predict vision accuracy or store page data.

Eliza `plugins/plugin-pdf/services/pdf.ts:26–39,94–132,228–395`, `plugins/plugin-personal-assistant/native-host/bill-pdf-parser.mjs:5–30`.

```quint
type PdfInput = { exactMime: bool, bytes: bool, nonempty: bool, headerInFirst1024: bool, lifecyclePort: bool }
pure def pdfInputAccepted(pdfInput: PdfInput): bool =
  pdfInput.exactMime and pdfInput.bytes and pdfInput.nonempty and pdfInput.headerInFirst1024 and pdfInput.lifecyclePort
pure def validDeclaredPages(pageCount: int): bool = pageCount > 0 and pageCount <= 9007199254740991
type PageText = { nativeNonempty: bool, noOperators: bool, ocrRan: bool, ocrNonempty: bool, visionNonempty: bool, visionBlank: bool }
pure def pageMethod(pageText: PageText): str =
  if (not(pageText.visionNonempty)) "invalid"
  else if (pageText.visionBlank)
    if (not(pageText.nativeNonempty or pageText.ocrNonempty) and (pageText.noOperators or pageText.ocrRan)) "blank" else "invalid"
  else if (pageText.nativeNonempty) "native+vision" else "vision"
pure def lawBlankCannotOverrideTextEvidence(pageText: PageText): bool =
  pageMethod(pageText) == "blank" implies pageText.visionNonempty and pageText.visionBlank and not(pageText.nativeNonempty or pageText.ocrNonempty) and (pageText.noOperators or pageText.ocrRan)
pure def lawEmptyVisionFailsThePage(pageText: PageText): bool =
  not(pageText.visionNonempty) implies pageMethod(pageText) == "invalid"
pure val nativeVision: PageText = { nativeNonempty: true, noOperators: false, ocrRan: false, ocrNonempty: false, visionNonempty: true, visionBlank: false }
pure val rasterVision: PageText = { ...nativeVision, nativeNonempty: false }
pure val pageTextValues = Set(nativeVision, rasterVision, { ...rasterVision, visionNonempty: false }, { ...nativeVision, visionBlank: true }, { ...rasterVision, visionBlank: true }, { ...rasterVision, visionBlank: true, noOperators: true }, { ...rasterVision, visionBlank: true, ocrRan: true }, { ...rasterVision, visionBlank: true, ocrRan: true, ocrNonempty: true })
```

### The interpreter receives the same full checked document

The service returns `complete: true` only after every declared page, with full numbered text and the ordered page array. The bill parser rechecks the envelope and the array length. Each page needs its exact 1-based number, a recognized method, string native text and nonblank string vision text. A malformed envelope or any malformed page fails before interpretation. The mapper receives the identical document, original task context and a frozen lifecycle control with the original signal and callback. Authorization is rechecked after mapping before the return. Parsing or interpreting under that control does not select or publish a durable bill.

During extraction, abort and a rejection thrown by the local lifecycle callback take precedence over page failure formatting. A rejected inference is mapped to `PDF_PAGE_TRANSCRIPTION_UNAVAILABLE` unless aborted. This includes a rejection from the Cloud vision dependency’s own owner guard. The failure input records the observed callback rejection separately from a rejected vision promise. Other required per-page errors keep the failing page and declared count in the error. The process stops on the first failed page. A pending render or provider response can finish after cancellation. It cannot move the attachment to interpretation or return an interpreted value. On a stopped run, the model forgets its unpublished page references. It prescribes no cancellation of a request already accepted by an external provider.

Eliza `plugins/plugin-pdf/services/pdf.ts:234–250,265–395` and `plugins/plugin-personal-assistant/native-host/bill-pdf-parser.mjs:22–60`.

```quint
type ScopeCheck = { ownerCurrent: bool, notAborted: bool }
pure def scopeCurrent(scope: ScopeCheck): bool = scope.ownerCurrent and scope.notAborted
type WirePage = { number: int, method: str, nativeString: bool, visionNonblankString: bool }
type DocumentEnvelope = { completeFlag: bool, pageCount: int, pagesArray: bool, pages: List[WirePage] }
pure def wirePageAccepted(page: WirePage, number: int): bool =
  page.number == number and page.nativeString and page.visionNonblankString and
  (page.method == "blank" or page.method == "native+vision" or page.method == "vision")
type WirePageCount = { count: int, valid: bool }
pure val emptyWirePageCount: WirePageCount = { count: 0, valid: true }
pure def documentAccepted(envelope: DocumentEnvelope): bool = {
  val checked = envelope.pages.foldl(emptyWirePageCount, (previous, page) =>
    { count: previous.count + 1, valid: previous.valid and wirePageAccepted(page, previous.count + 1) })
  envelope.completeFlag and validDeclaredPages(envelope.pageCount) and envelope.pagesArray and envelope.pages.length() == envelope.pageCount and checked.valid
}
type PdfFailure = { aborted: bool, lifecycleRejected: bool, visionRejected: bool }
pure def pageFailure(failureInput: PdfFailure): str =
  if (failureInput.aborted) "aborted"
  else if (failureInput.lifecycleRejected) "owner-lost"
  else if (failureInput.visionRejected) "PDF_PAGE_TRANSCRIPTION_UNAVAILABLE"
  else "page-failed"
pure def lawNoShortOrOversizedPageArray(envelope: DocumentEnvelope): bool =
  documentAccepted(envelope) implies envelope.completeFlag and envelope.pagesArray and envelope.pages.length() == envelope.pageCount
pure def lawAbortPrecedesPageFailure(failureInput: PdfFailure): bool =
  failureInput.aborted implies pageFailure(failureInput) == "aborted"
pure val pageFault: PdfFailure = { aborted: false, lifecycleRejected: false, visionRejected: false }
pure val failureInputValues = Set(pageFault, { ...pageFault, aborted: true }, { ...pageFault, lifecycleRejected: true }, { ...pageFault, visionRejected: true }, { ...pageFault, aborted: true, visionRejected: true })
pure val held: ScopeCheck = { ownerCurrent: true, notAborted: true }
pure val scopeValues = Set(held, { ...held, ownerCurrent: false }, { ...held, notAborted: false })
pure val firstWirePage: WirePage = { number: 1, method: "native+vision", nativeString: true, visionNonblankString: true }
pure val secondWirePage: WirePage = { ...firstWirePage, number: 2, method: "vision" }
pure val onePage: DocumentEnvelope = { completeFlag: true, pageCount: 1, pagesArray: true, pages: List(firstWirePage) }
pure val twoPages: DocumentEnvelope = { completeFlag: true, pageCount: 2, pagesArray: true, pages: List(firstWirePage, secondWirePage) }
pure val envelopeValues = Set(onePage, twoPages, { ...onePage, completeFlag: false }, { ...twoPages, pages: List(firstWirePage) }, { ...twoPages, pages: List(secondWirePage, firstWirePage) }, { ...onePage, pages: List({ ...firstWirePage, method: "blank" }) }, { ...onePage, pages: List({ ...firstWirePage, visionNonblankString: false }) })
```

### Partial or stale page work cannot produce a mapped value

The machine models one already-configured attachment. A start supplies a validated PDF input, declared page count, document identity and current control. Each page's required render finishes before image inference can start. A readback with the same exact ordinal and valid method contributes one page. The per-page index and number of completed pages move together. A response with a mismatched ordinal or a wrong work phase is ineligible. The assembled document enters mapping only once all pages have finished and the parser has validated its envelope. The identity supplied for the exact complete envelope must match the started document; the mapper gets the unchanged identity and complete page list. A positive mapped identity can stand for any returned interpreter value including an empty result. Cancellation, lost ownership and parser, vision or mapper failures terminate in-flight work without a mapped value. Invalid evidence at an active source stage follows the explicit failure event. The source can neither prepare the next page nor map again after an explicit terminal event.

Discovered by the proof: a fresh run has no declared or completed pages and no document identity. A run that has started retains the admitted positive page declaration and document identity until failure discards them. Those facts rule out an arbitrary mapping phase with no source document or an arbitrary new run that already holds pages.

```quint
type PdfRun = { phase: str, pageCount: int, completed: int, documentRef: int, mappedRef: int, failure: str }
pure val initial: PdfRun = { phase: "new", pageCount: 0, completed: 0, documentRef: 0, mappedRef: 0, failure: "" }
pure def canOpenPdf(pdfRun: PdfRun, pdfInput: PdfInput, pageCount: int, documentRef: int, scope: ScopeCheck): bool =
  pdfRun.phase == "new" and pdfInputAccepted(pdfInput) and validDeclaredPages(pageCount) and documentRef > 0 and scopeCurrent(scope)
pure def openPdf(pdfRun: PdfRun, pdfInput: PdfInput, pageCount: int, documentRef: int, scope: ScopeCheck): PdfRun =
  { ...pdfRun, phase: "page", pageCount: pageCount, documentRef: documentRef }
pure def canRenderPdfPage(pdfRun: PdfRun, pageNumber: int, imageDecoded: bool, scope: ScopeCheck): bool =
  pdfRun.phase == "page" and pdfRun.completed < pdfRun.pageCount and pageNumber == pdfRun.completed + 1 and imageDecoded and scopeCurrent(scope)
pure def renderPdfPage(pdfRun: PdfRun, pageNumber: int, imageDecoded: bool, scope: ScopeCheck): PdfRun = { ...pdfRun, phase: "rendered" }
pure def canRequestVision(pdfRun: PdfRun, scope: ScopeCheck): bool = pdfRun.phase == "rendered" and scopeCurrent(scope)
pure def requestVision(pdfRun: PdfRun, scope: ScopeCheck): PdfRun = { ...pdfRun, phase: "vision" }
pure def canKeepPdfPage(pdfRun: PdfRun, pageNumber: int, pageText: PageText, scope: ScopeCheck): bool =
  pdfRun.phase == "vision" and pdfRun.completed < pdfRun.pageCount and pageNumber == pdfRun.completed + 1 and pageMethod(pageText) != "invalid" and scopeCurrent(scope)
pure def keepPdfPage(pdfRun: PdfRun, pageNumber: int, pageText: PageText, scope: ScopeCheck): PdfRun =
  { ...pdfRun, phase: "page", completed: pdfRun.completed + 1 }
pure def canStartInterpretation(pdfRun: PdfRun, envelope: DocumentEnvelope, checkedDocumentRef: int, scope: ScopeCheck): bool =
  pdfRun.phase == "page" and pdfRun.completed == pdfRun.pageCount and checkedDocumentRef == pdfRun.documentRef and
  envelope.pageCount == pdfRun.pageCount and documentAccepted(envelope) and scopeCurrent(scope)
pure def startInterpretation(pdfRun: PdfRun, envelope: DocumentEnvelope, checkedDocumentRef: int, scope: ScopeCheck): PdfRun = { ...pdfRun, phase: "mapping" }
pure def canReturnInterpretation(pdfRun: PdfRun, mappedRef: int, scope: ScopeCheck): bool =
  pdfRun.phase == "mapping" and mappedRef > 0 and scopeCurrent(scope)
pure def returnInterpretation(pdfRun: PdfRun, mappedRef: int, scope: ScopeCheck): PdfRun =
  { ...pdfRun, phase: "returned", mappedRef: mappedRef }
pure def canFailPdf(pdfRun: PdfRun): bool = pdfRun.phase != "returned" and pdfRun.phase != "failed"
pure def failPdf(pdfRun: PdfRun, failureInput: PdfFailure): PdfRun =
  { ...initial, phase: "failed", failure: pageFailure({ ...failureInput, visionRejected: failureInput.visionRejected and pdfRun.phase == "vision" }) }
pure def alwaysFreshPdfHasNoDocument(pdfRun: PdfRun): bool =
  pdfRun.phase == "new" implies pdfRun.pageCount == 0 and pdfRun.completed == 0 and pdfRun.documentRef == 0
pure def alwaysStartedPdfKeepsDeclaration(pdfRun: PdfRun): bool =
  (pdfRun.phase != "new" and pdfRun.phase != "failed") implies validDeclaredPages(pdfRun.pageCount) and pdfRun.documentRef > 0
pure def alwaysAcceptedCountWithinDeclaration(pdfRun: PdfRun): bool =
  pdfRun.completed >= 0 and pdfRun.completed <= pdfRun.pageCount
pure def alwaysNoPartialInterpretation(pdfRun: PdfRun): bool =
  (pdfRun.phase == "mapping" or pdfRun.phase == "returned") implies pdfRun.pageCount > 0 and pdfRun.completed == pdfRun.pageCount and pdfRun.documentRef > 0
pure def alwaysOnlyACompletedInterpretationReturns(pdfRun: PdfRun): bool =
  if (pdfRun.phase == "returned") pdfRun.mappedRef > 0 else pdfRun.mappedRef == 0
pure def alwaysFailureKeepsNoUnpublishedPage(pdfRun: PdfRun): bool =
  pdfRun.phase == "failed" implies pdfRun.completed == 0 and pdfRun.documentRef == 0 and pdfRun.failure != ""
pure def stepOnlyAcceptedPageAdvances(before: PdfRun, via: str, after: PdfRun): bool =
  after.completed > before.completed implies via == "keepPdfPage" and after.completed == before.completed + 1 and after.documentRef == before.documentRef
pure def sometimesTwoPagesReachInterpretation(pdfRun: PdfRun): bool =
  pdfRun.phase == "returned" and pdfRun.pageCount == 2 and pdfRun.completed == 2
pure def sometimesRevokedPdfFails(pdfRun: PdfRun): bool = pdfRun.phase == "failed" and pdfRun.failure == "owner-lost"
pure def sometimesVisionFailureIsTyped(pdfRun: PdfRun): bool = pdfRun.phase == "failed" and pdfRun.failure == "PDF_PAGE_TRANSCRIPTION_UNAVAILABLE"
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
