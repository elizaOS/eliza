# Alpha Files selected PDF page preview

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` calls
`DailyApps.pdfSelected` from `apps/app/src/prototype/selection-adapter.ts`.
`SelectedDocumentAccess` supplies the installed `IsolatedPdfService` to
Eliza `c518127a025ab173874af9c7d304f26b25213b0d`'s `SelectedDocuments`
and `SelectedDocumentCalls` in `plugins/plugin-native-media`.
[Selected document grants](./mobileSelectedDocumentGrants.md) own URI
authority. [Isolated PDF rendering](./mobileIsolatedPdf.md) owns the
shared renderer's page, byte and isolation bounds. Files requests a
private PNG from the selected-document registry for its own renderer.

## Story: Render a selected file one page at a time on this device

### The worker renders a bounded private copy and accepts only its own reply

The bridge takes the selection ID and defaults the page index to zero.
The plugin dispatches work off the main thread and rejects if the
worker has closed. The persisted or ephemeral selection resolves to
its registered URI. Missing access returns unavailable. Missing
renderer or a MIME other than exactly `application/pdf` returns
unsupported. The worker copies the selected bytes under a per-registry
render lock. It requires a positive size up to 20 MiB before parsing.
It sends a read-only descriptor with the selected-document flag and one
fresh request UUID. Source access is resolved before waiting for the
render lock. Native may finish after the person leaves Files or retires
that grant. The renderer still checks its own selection before display.

The connection and response share one 12-second uptime budget.
A waiter accepts one matching reply. Wrong, duplicate, or post-abandon
replies release their pixels. A response already delivered to the
waiter has precedence over the timeout check when the wait exits.
Missing bind, remote, or matching reply yields failure. A completed
response still passes the existing isolated-process and pixel
validation. The validated pixels are copied into a local PNG. A
security exception reports unavailable. Parse, conversion and write
failures report failed. A successful result names the exact page,
count and file URI, and supplies no document text. Temporary PDF
cleanup is attempted in the worker's finally branch. The PNG path is
reused for the selection rather than minted per page. Forget also
attempts to delete its cache paths. File I/O, OS binder state and
actual cleanup are port facts.

A matching reply from a connection that stayed healthy allows reuse.
A failed or broken connection is discarded when it is still the
registered connection. The last healthy request schedules a 30-second
idle unbind. Starting a request removes that idle callback. The
binding disposition records the reply and binding state before PNG
validation, so a rejected PNG can still leave a reusable binding.

```quint
import mobileIsolatedPdf as Isolated from "./mobileIsolatedPdf"

type SelectedPdfAdmission = PreviewWork | PreviewBridgeClosed | PreviewMissingGrant | PreviewUnsupported
type SelectedPdfStatus = SelectedPdfRendered | SelectedPdfUnavailable | SelectedPdfFailed
type SelectedPdfSource = { workerOpen: bool, grantResolved: bool, rendererPresent: bool, exactMime: bool }
type SelectedPdfWork = { bytesCopied: bool, sourceBytes: int, securityFailure: bool, matchingReply: bool, pngWritten: bool }
type SelectedWait = { waiting: bool, alreadyDelivered: bool, matchingRequest: bool }
type RendererConnection = { sameBinding: bool, matchingReply: bool, broken: bool, othersRunning: bool }
type BindingDisposition = UnbindRenderer | SetIdleUnbind | KeepRenderer
pure val idleUnbindMs = 30000
pure def admitSelectedPdf(source: SelectedPdfSource): SelectedPdfAdmission =
  if (not(source.workerOpen)) PreviewBridgeClosed
  else if (not(source.grantResolved)) PreviewMissingGrant
  else if (not(source.rendererPresent and source.exactMime)) PreviewUnsupported
  else PreviewWork
pure def acceptsSelectedReply(waiter: SelectedWait): bool = waiter.waiting and not(waiter.alreadyDelivered) and waiter.matchingRequest
pure def selectedPdfResult(work: SelectedPdfWork, request: Isolated::PdfRequest, reply: Isolated::PdfReply): SelectedPdfStatus =
  if (work.securityFailure) SelectedPdfUnavailable
  else if (work.bytesCopied and Isolated::sourceWithinPdfLimit(work.sourceBytes,true) and work.matchingReply and
    Isolated::replyPixelsAdmitted(request,reply) and work.pngWritten) SelectedPdfRendered
  else SelectedPdfFailed
pure def afterRenderBinding(connection: RendererConnection): BindingDisposition =
  if (connection.sameBinding and (not(connection.matchingReply) or connection.broken)) UnbindRenderer
  else if (not(connection.othersRunning)) SetIdleUnbind else KeepRenderer
pure def lawAbandonedWaitCannotTakePixels(waiter: SelectedWait): bool =
  (not(waiter.waiting) or waiter.alreadyDelivered) implies not(acceptsSelectedReply(waiter))
pure def lawRenderedSelectedPdfHasValidatedPixels(work: SelectedPdfWork, request: Isolated::PdfRequest, reply: Isolated::PdfReply): bool =
  selectedPdfResult(work,request,reply) == SelectedPdfRendered implies work.pngWritten and
    Isolated::sourceWithinPdfLimit(work.sourceBytes,true) and Isolated::replyPixelsAdmitted(request,reply)
pure val availableSource: SelectedPdfSource = { workerOpen: true, grantResolved: true, rendererPresent: true, exactMime: true }
pure val sourceValues = Set(availableSource, { ...availableSource, workerOpen: false }, { ...availableSource, grantResolved: false },
  { ...availableSource, rendererPresent: false }, { ...availableSource, exactMime: false })
pure val copiedPdf: SelectedPdfWork = { bytesCopied: true, sourceBytes: 100, securityFailure: false, matchingReply: true, pngWritten: true }
pure val workValues = Set(copiedPdf, { ...copiedPdf, sourceBytes: 20971520 }, { ...copiedPdf, sourceBytes: 20971521 },
  { ...copiedPdf, securityFailure: true }, { ...copiedPdf, matchingReply: false }, { ...copiedPdf, pngWritten: false })
pure val requestValues = Set({ ticket: 1, requestedPage: 0 }, { ticket: 2, requestedPage: 1 })
pure val replyValues = Set(Isolated::goodReply, { ...Isolated::goodReply, ticket: 2, pageIndex: 1 },
  { ...Isolated::goodReply, rendererUid: 1 }, { ...Isolated::goodReply, errorReply: true })
pure val readyWait: SelectedWait = { waiting: true, alreadyDelivered: false, matchingRequest: true }
pure val waiterValues = Set(readyWait, { ...readyWait, waiting: false }, { ...readyWait, alreadyDelivered: true }, { ...readyWait, matchingRequest: false })
pure val connectedRenderer: RendererConnection = { sameBinding: true, matchingReply: true, broken: false, othersRunning: false }
pure val connectionValues = Set(connectedRenderer, { ...connectedRenderer, broken: true },
  { ...connectedRenderer, sameBinding: false, matchingReply: false }, { ...connectedRenderer, othersRunning: true })
```

### Only the same Files selection object may publish a page result

Files refuses another request while busy for the same selection ID.
A different grant can start while the earlier request is unresolved.
It then owns the busy slot. A result publishes only if the exact
selection object captured at request start still owns the screen.
New selection, rename and close replace or retire that object, even
if a retained grant has the same ID. Finally, only the newest request
may clear its busy slot. Leaving the view does not itself abort the
native job. The machine tracks the last request that owns the busy
slot. Older completions can arrive and are checked independently.
An applied response also replaces the selection object. The shell
supplies the one-shot callback's captured request and object revision.

The pinned renderer accepts a rendered result with a file URI on
Android, or additionally a blob URI on web, and integer page and
count. It relies on native validation for actual page identity and
bounds. Its local asset URL gains the requested page and a fresh
cache-busting value. Malformed or refused results clear the preview
for that exact selection. Hidden video playback and persisted grants
belong to separate owners.

```quint
type PreviewUriKind = FilePreviewUri | BlobPreviewUri | OtherPreviewUri
type ViewerReply = { rendered: bool, uriKind: PreviewUriKind, nativePlatform: bool, integerPage: bool, integerCount: bool }
type PreviewSelection = { ownerObject: int, grantId: int }
type PreviewAttempt = { id: int, selection: PreviewSelection, objectRevision: int, requestedPage: int, issuedCallback: bool }
type SelectedPreview = { selection: PreviewSelection, objectRevision: int, issued: int, busyGrant: int, shownRequest: int }
pure val noSelection: PreviewSelection = { ownerObject: 0, grantId: 0 }
pure val initial: SelectedPreview = { selection: noSelection, objectRevision: 0, issued: 0, busyGrant: 0, shownRequest: 0 }
pure def acceptsPreviewReply(receipt: ViewerReply): bool =
  receipt.rendered and receipt.integerPage and receipt.integerCount and
  (receipt.uriKind == FilePreviewUri or (not(receipt.nativePlatform) and receipt.uriKind == BlobPreviewUri))
pure def canShowPdfSelection(s: SelectedPreview, selection: PreviewSelection): bool =
  selection.ownerObject > 0 and selection.grantId > 0 and selection.ownerObject != s.selection.ownerObject
pure def showPdfSelection(s: SelectedPreview, selection: PreviewSelection): SelectedPreview =
  { ...s, selection: selection, objectRevision: s.objectRevision + 1, shownRequest: 0 }
pure def canLeavePdfSelection(s: SelectedPreview): bool = s.selection.ownerObject > 0
pure def leavePdfSelection(s: SelectedPreview): SelectedPreview =
  { ...s, selection: noSelection, objectRevision: s.objectRevision + 1, shownRequest: 0 }
pure def canAskSelectedPage(s: SelectedPreview): bool = s.selection.ownerObject > 0 and s.selection.grantId != s.busyGrant
pure def askSelectedPage(s: SelectedPreview, requestedPage: int): SelectedPreview =
  { ...s, issued: s.issued + 1, busyGrant: s.selection.grantId }
pure def canApplySelectedPage(s: SelectedPreview, attempt: PreviewAttempt): bool =
  attempt.issuedCallback and attempt.id > 0 and attempt.id <= s.issued
pure def applySelectedPage(s: SelectedPreview, attempt: PreviewAttempt, receipt: ViewerReply): SelectedPreview = {
  val sameObject = attempt.selection.ownerObject > 0 and attempt.selection == s.selection and attempt.objectRevision == s.objectRevision
  { ...s, busyGrant: if (attempt.id == s.issued) 0 else s.busyGrant,
    objectRevision: if (sameObject) s.objectRevision + 1 else s.objectRevision,
    shownRequest: if (sameObject) (if (acceptsPreviewReply(receipt)) attempt.id else 0) else s.shownRequest }
}
pure def alwaysSelectedPreviewHasOwner(s: SelectedPreview): bool =
  s.issued >= 0 and s.shownRequest >= 0 and s.shownRequest <= s.issued and
  (s.shownRequest > 0 implies s.selection.ownerObject > 0)
pure def stepRetiredSelectionCannotDisplay(before: SelectedPreview, via: str, after: SelectedPreview): bool =
  (via == "leavePdfSelection" or via == "showPdfSelection") implies after.shownRequest == 0
pure def sometimesPageShown(s: SelectedPreview): bool = s.shownRequest > 0
pure def sometimesOtherGrantReplacesBusyOwner(s: SelectedPreview): bool =
  s.busyGrant > 0 and s.selection.ownerObject > 0 and s.selection.grantId != s.busyGrant
pure val firstSelection: PreviewSelection = { ownerObject: 1, grantId: 1 }
pure val otherSelection: PreviewSelection = { ownerObject: 2, grantId: 2 }
pure val selectionValues = Set(noSelection, firstSelection, otherSelection, { ownerObject: 3, grantId: 1 })
pure val firstAttempt: PreviewAttempt = { id: 1, selection: firstSelection, objectRevision: 1, requestedPage: 0, issuedCallback: true }
pure val attemptValues = Set(firstAttempt, { ...firstAttempt, objectRevision: 2 },
  { ...firstAttempt, objectRevision: 3 }, { ...firstAttempt, issuedCallback: false },
  { ...firstAttempt, id: 2, selection: otherSelection, objectRevision: 2, requestedPage: 1 })
pure val completePng: ViewerReply = { rendered: true, uriKind: FilePreviewUri, nativePlatform: true, integerPage: true, integerCount: true }
pure val receiptValues = Set(completePng, { ...completePng, uriKind: BlobPreviewUri },
  { ...completePng, nativePlatform: false, uriKind: BlobPreviewUri }, { ...completePng, rendered: false },
  { ...completePng, integerCount: false })
pure val requestedPageValues = Set(-1,0,1,499,500)
```

The pinned `SelectedDocumentViewer.qnt` and renderer refinement check
selection changes with held replies. The installed
`SelectedDocumentInstrumentedTest.realSelectedPdfRendersActualPagesAndRejectsMalformedBytes`
drives real Android provider files and verifies both page navigation and
typed refusal for malformed bytes.
