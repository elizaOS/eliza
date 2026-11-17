# Isolated PDF rendering

A PDF is untrusted input. It is parsed only in a permissionless isolated
process that receives a read-only descriptor and returns one page of raw
pixels. The viewer and the selected-document registry each map those pixels
only after they check the reply. The source is
`plugins/plugin-native-media` (`PdfPageLimits`, `IsolatedPdfRenderService`,
`IsolatedPdfViewerActivity`, `ReviewedFileHandoff` and the PDF path of
`SelectedDocuments`). The host declares the concrete activity and isolated
service. The platform owns process isolation, descriptor transport,
parsing, shared memory and the watchdog. This spec owns the decisions on
the facts those components report.

## Story: Open a reviewed PDF when Android has no viewer

> As the person, I want a reviewed PDF to open even when Android has no PDF
> viewer, without handing the file to anything else.

### The isolated viewer opens only when Android has no handler for a current reviewed PDF

The handoff keeps at most one temporary copy. Writing a new copy revokes
and deletes the earlier one. The copy goes out as a read-only content URI.
An external viewer is tried first. Only Android's "no handler" answer for
a PDF falls back to the host's non-exported isolated viewer. Any other
launch failure, or a copy that is no longer current, refuses the handoff.

```quint
type ViewerLaunch = HandlerOpened | HandlerAbsent | HandlerFailed
type HandoffResult = ExternalViewerOpened | IsolatedViewerOpened | HandoffRefused
pure def dispatchReviewedPdf(copyCurrent: bool, pdfMime: bool, handler: ViewerLaunch): HandoffResult =
  if (not(copyCurrent)) HandoffRefused
  else if (handler == HandlerOpened) ExternalViewerOpened
  else if (handler == HandlerAbsent and pdfMime) IsolatedViewerOpened
  else HandoffRefused
```

### The viewer starts only for the exact handoff URI

The viewer admits only a `content` URI with the handoff's authority and
exactly two path segments: the handoff's path name, then a non-empty file
name. Any other source shows a refusal and never binds the renderer. Each
start binds with a fresh generation, so callbacks from an earlier binding
are ignored.

```quint
type HandoffUri = { contentScheme: bool, handoffAuthority: bool, segmentCount: int, handoffSegment: bool, fileSegmentPresent: bool }
type ViewerStage = ViewerStopped | ViewerBinding | ViewerPending | ViewerShowing | ViewerFailed
type PreviewOutcome = PreviewIdle | PreviewWaiting | PreviewRendered | PreviewFailed
type PdfViewer = { stage: ViewerStage, generation: int, lastTicket: int, pendingTicket: int, pageIndex: int, pageCount: int, shownTicket: int,
  preview: PreviewOutcome, previewTicket: int, previewPage: int, previewCount: int }
pure val initial: PdfViewer = { stage: ViewerStopped, generation: 0, lastTicket: 0, pendingTicket: 0, pageIndex: 0, pageCount: 0, shownTicket: 0,
  preview: PreviewIdle, previewTicket: 0, previewPage: 0, previewCount: 0 }
pure def handoffUriAdmitted(uri: HandoffUri): bool =
  uri.contentScheme and uri.handoffAuthority and uri.segmentCount == 2 and uri.handoffSegment and uri.fileSegmentPresent
pure def canStartPdfView(s: PdfViewer, uri: HandoffUri): bool = s.stage == ViewerStopped and handoffUriAdmitted(uri)
pure def startPdfView(s: PdfViewer, uri: HandoffUri): PdfViewer = { ...s, stage: ViewerBinding, generation: s.generation + 1 }
pure def sometimesViewerOpening(s: PdfViewer): bool = s.stage == ViewerBinding
pure val handoffUri: HandoffUri = { contentScheme: true, handoffAuthority: true, segmentCount: 2, handoffSegment: true, fileSegmentPresent: true }
pure val uriValues = Set(handoffUri, { ...handoffUri, contentScheme: false }, { ...handoffUri, handoffAuthority: false },
  { ...handoffUri, segmentCount: 3 }, { ...handoffUri, fileSegmentPresent: false })
```

## Story: Parse a PDF only in an isolated worker

> As the person, I want a hostile PDF parsed only by a worker that cannot
> reach my data or the network, and only within fixed limits.

### A worker admits one bounded request at a time and ends itself past its limits

The worker answers only message 1 with a reply port, and only inside an
isolated process. A request needs a descriptor, a 36-character request
identity and a page index from 0 to 499, and the worker's one slot must be
free. Otherwise the worker closes the descriptor and replies with an error.
Before it parses, the worker needs a positive source size: at most 5 MiB
for a reviewed handoff, or 20 MiB for a document the person selected. It
opens 1 to 500 pages, and page edges of 1 to 20,000 PDF points. While a
page is busy, the worker ends its own process after 10 seconds or above
128 MiB of proportional memory. Unbinding also ends it.

```quint
type WorkerRequest = { isolated: bool, replyPort: bool, descriptorPresent: bool, requestLength: int, pageIndex: int }
pure val workerDeadlineMs = 10000
pure val workerPssLimitKiB = 131072
pure def workerAdmits(request: WorkerRequest, busy: bool): bool =
  request.isolated and request.replyPort and request.descriptorPresent and request.requestLength == 36 and
  request.pageIndex >= 0 and request.pageIndex < 500 and not(busy)
pure def sourceWithinPdfLimit(sourceBytes: int, selectedDocument: bool): bool =
  sourceBytes > 0 and sourceBytes <= (if (selectedDocument) 20971520 else 5242880)
pure def pageWithinPdfLimit(pageCount: int, pageIndex: int): bool =
  pageCount >= 1 and pageCount <= 500 and pageIndex >= 0 and pageIndex < pageCount
pure def pagePointsFit(pointWidth: int, pointHeight: int): bool =
  pointWidth >= 1 and pointWidth <= 20000 and pointHeight >= 1 and pointHeight <= 20000
pure def workerMustExit(busy: bool, elapsedMs: int, pssKiB: int, unbound: bool): bool =
  unbound or (busy and (elapsedMs >= workerDeadlineMs or pssKiB > workerPssLimitKiB))
pure def lawReviewedSourceFitsSelectedBound(sourceBytes: int): bool =
  sourceWithinPdfLimit(sourceBytes, false) implies sourceWithinPdfLimit(sourceBytes, true)
pure val sourceBytesValues = Set(0, 1, 5242880, 5242881, 20971520, 20971521)
```

### Every page the worker renders is a page the viewer accepts

The worker fits each page to at most 1024 by 1536 pixels and 1,500,000
pixels in area, keeps the aspect ratio, and copies ARGB pixels into shared
memory that it makes read-only before it sends. A receiver accepts edges up
to 1536 in either direction within the same area. So a correct worker is
never refused for size.

```quint
pure def renderedSizeFits(pixelWidth: int, pixelHeight: int): bool =
  pixelWidth >= 1 and pixelWidth <= 1024 and pixelHeight >= 1 and pixelHeight <= 1536 and pixelWidth * pixelHeight <= 1500000
pure def receivedSizeFits(pixelWidth: int, pixelHeight: int): bool =
  pixelWidth >= 1 and pixelWidth <= 1536 and pixelHeight >= 1 and pixelHeight <= 1536 and pixelWidth * pixelHeight <= 1500000
pure def lawRenderedPageFitsReceiver(pixelWidth: int, pixelHeight: int): bool =
  renderedSizeFits(pixelWidth, pixelHeight) implies receivedSizeFits(pixelWidth, pixelHeight)
pure val pixelWidthValues = Set(0, 1, 1024, 1025, 1536, 1537)
pure val pixelHeightValues = Set(0, 1, 976, 1464, 1536, 1537)
```

## Story: Read one page at a time

> As the person, I want the isolated viewer to show one page at a time, so
> that only the page I asked for is ever on screen.

### Only the reply to the current page ticket can replace the displayed pixels

A bind from the current generation sends the first request. Previous and
next move one page within the returned count, and only while a page is
shown. The old page stays on screen while the next one renders. Each
request carries a fresh ticket, its own descriptor and a 12-second viewer
timeout. The viewer checks the ticket before anything else, so any other
reply only releases its memory. For the current ticket it needs pixels, not
an error, from an isolated, network-denied worker with a different UID, for
the requested page within the page count, within the receiver's size, with
exactly four bytes per pixel, mapped and copied. Anything else, a lost
renderer, an expired source or the timeout clears the image and unbinds.
Stopping retires every outstanding ticket. A reply carries pixels only,
never text.

```quint
type ReplyBody = RenderError | RenderedPixels
type PdfReply = { ticket: int, body: ReplyBody, pageIndex: int, pageCount: int, pixelWidth: int, pixelHeight: int, pixelBytes: int,
  isolated: bool, internetDenied: bool, separateUid: bool, copied: bool }
type PdfFailure = RendererLost | SourceExpired | ViewerTimedOut
pure val viewerTimeoutMs = 12000
pure def replyPixelsAdmitted(ticket: int, page: int, reply: PdfReply): bool =
  reply.ticket == ticket and reply.body == RenderedPixels and reply.isolated and reply.internetDenied and reply.separateUid and
  reply.pageIndex == page and pageWithinPdfLimit(reply.pageCount, reply.pageIndex) and
  receivedSizeFits(reply.pixelWidth, reply.pixelHeight) and reply.pixelBytes == 4 * reply.pixelWidth * reply.pixelHeight and reply.copied
pure def canBindPdfWorker(s: PdfViewer, generation: int): bool = s.stage == ViewerBinding and generation == s.generation
pure def bindPdfWorker(s: PdfViewer, generation: int): PdfViewer =
  { ...s, stage: ViewerPending, lastTicket: s.lastTicket + 1, pendingTicket: s.lastTicket + 1 }
pure def canTurnPdfPage(s: PdfViewer, requestedPage: int): bool =
  s.stage == ViewerShowing and pageWithinPdfLimit(s.pageCount, requestedPage) and
  (requestedPage == s.pageIndex - 1 or requestedPage == s.pageIndex + 1)
pure def turnPdfPage(s: PdfViewer, requestedPage: int): PdfViewer =
  { ...s, stage: ViewerPending, pageIndex: requestedPage, lastTicket: s.lastTicket + 1, pendingTicket: s.lastTicket + 1 }
pure def canReceivePdfReply(s: PdfViewer, reply: PdfReply): bool = s.stage == ViewerPending and reply.ticket == s.pendingTicket
pure def receivePdfReply(s: PdfViewer, reply: PdfReply): PdfViewer =
  if (replyPixelsAdmitted(s.pendingTicket, s.pageIndex, reply))
    { ...s, stage: ViewerShowing, pendingTicket: 0, pageCount: reply.pageCount, shownTicket: reply.ticket }
  else { ...s, stage: ViewerFailed, pendingTicket: 0, shownTicket: 0 }
pure def canFailPdfView(s: PdfViewer, generation: int, reason: PdfFailure): bool =
  generation == s.generation and
  (s.stage == ViewerPending or (reason == RendererLost and (s.stage == ViewerBinding or s.stage == ViewerShowing)))
pure def failPdfView(s: PdfViewer, generation: int, reason: PdfFailure): PdfViewer =
  { ...s, stage: ViewerFailed, pendingTicket: 0, shownTicket: 0 }
pure def canStopPdfView(s: PdfViewer): bool = s.stage != ViewerStopped
pure def stopPdfView(s: PdfViewer): PdfViewer =
  { ...s, stage: ViewerStopped, generation: s.generation + 1, pendingTicket: 0, shownTicket: 0 }
pure def alwaysViewerTicketsAreCurrent(s: PdfViewer): bool =
  s.lastTicket >= 0 and s.shownTicket >= 0 and s.shownTicket <= s.lastTicket and
  (s.stage == ViewerPending implies s.pendingTicket > 0 and s.pendingTicket <= s.lastTicket) and
  (s.stage != ViewerPending implies s.pendingTicket == 0)
pure def alwaysShownPageIsBounded(s: PdfViewer): bool =
  (s.stage == ViewerShowing implies s.shownTicket > 0 and pageWithinPdfLimit(s.pageCount, s.pageIndex)) and
  ((s.stage == ViewerStopped or s.stage == ViewerBinding or s.stage == ViewerFailed) implies s.shownTicket == 0)
pure def stepNewPixelsAnswerThePendingTicket(before: PdfViewer, after: PdfViewer): bool =
  (after.shownTicket > 0 and after.shownTicket != before.shownTicket) implies
  (before.stage == ViewerPending and after.shownTicket == before.pendingTicket)
pure def sometimesLaterPageShown(s: PdfViewer): bool = s.stage == ViewerShowing and s.pageIndex > 0
pure def sometimesOldPageStaysWhileTurning(s: PdfViewer): bool = s.stage == ViewerPending and s.shownTicket > 0
pure def sometimesViewerFailed(s: PdfViewer): bool = s.stage == ViewerFailed
pure val firstPage: PdfReply = { ticket: 1, body: RenderedPixels, pageIndex: 0, pageCount: 2, pixelWidth: 40, pixelHeight: 60, pixelBytes: 9600,
  isolated: true, internetDenied: true, separateUid: true, copied: true }
pure val replyValues = Set(firstPage, { ...firstPage, ticket: 2, pageIndex: 1 }, { ...firstPage, ticket: 3, pageIndex: 1 },
  { ...firstPage, ticket: 2 }, { ...firstPage, body: RenderError }, { ...firstPage, separateUid: false },
  { ...firstPage, internetDenied: false }, { ...firstPage, pixelBytes: 100 }, { ...firstPage, copied: false })
pure val generationValues = Set(0, 1, 2, 3)
pure val requestedPageValues = Set(-1, 0, 1, 2)
```

## Story: Preview a selected PDF page on this device

> As the person, I want one page of a PDF I selected rendered on this
> device, so that only the file I picked is parsed and nothing is uploaded.

### A selected-document render accepts only the reply to its own request

The registry resolves the selection to its granted URI, refuses a type
other than `application/pdf`, and copies the bytes under one render lock.
A copy outside 20 MiB fails before the worker sees it. The request is
flagged as a selected document and carries a fresh ticket. Its wait and the
binding share one 12-second budget. The waiter takes one reply with its
ticket; a wrong, duplicate or late reply only releases its pixels. A missing
binding, a broken one or the timeout fails the preview. The accepted reply
passes the same check as the viewer's, and its pixels become a private PNG.
A rendered preview names its page and page count, never document text. The
shell owns binding reuse, the 30-second idle unbind and file cleanup.

```quint
pure def canAskSelectedPage(s: PdfViewer): bool = s.preview != PreviewWaiting
pure def askSelectedPage(s: PdfViewer, requestedPage: int, sourceBytes: int): PdfViewer =
  if (sourceWithinPdfLimit(sourceBytes, true))
    { ...s, preview: PreviewWaiting, lastTicket: s.lastTicket + 1, previewTicket: s.lastTicket + 1, previewPage: requestedPage, previewCount: 0 }
  else { ...s, preview: PreviewFailed, previewCount: 0 }
pure def canAnswerSelectedPage(s: PdfViewer, reply: PdfReply): bool = s.preview == PreviewWaiting and reply.ticket == s.previewTicket
pure def answerSelectedPage(s: PdfViewer, reply: PdfReply): PdfViewer =
  if (replyPixelsAdmitted(s.previewTicket, s.previewPage, reply)) { ...s, preview: PreviewRendered, previewCount: reply.pageCount }
  else { ...s, preview: PreviewFailed }
pure def canAbandonSelectedPage(s: PdfViewer): bool = s.preview == PreviewWaiting
pure def abandonSelectedPage(s: PdfViewer): PdfViewer = { ...s, preview: PreviewFailed }
pure def alwaysPreviewOwnsADistinctTicket(s: PdfViewer): bool =
  s.previewTicket >= 0 and s.previewTicket <= s.lastTicket and
  (s.preview == PreviewWaiting implies s.previewTicket > 0 and s.previewTicket != s.pendingTicket and s.previewTicket != s.shownTicket)
pure def alwaysRenderedPreviewIsBounded(s: PdfViewer): bool =
  s.preview == PreviewRendered implies s.previewTicket > 0 and pageWithinPdfLimit(s.previewCount, s.previewPage)
pure def stepPreviewRendersFromItsOwnWait(before: PdfViewer, after: PdfViewer): bool =
  (after.preview == PreviewRendered and before.preview != PreviewRendered) implies
  (before.preview == PreviewWaiting and after.previewTicket == before.previewTicket)
pure def sometimesPreviewRendered(s: PdfViewer): bool = s.preview == PreviewRendered
pure def sometimesPreviewBesideViewer(s: PdfViewer): bool = s.preview == PreviewWaiting and s.stage == ViewerPending
pure def sometimesPreviewFailed(s: PdfViewer): bool = s.preview == PreviewFailed
```
