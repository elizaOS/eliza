# AlphaPhone reviewed PDF fallback

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` stages Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`.
`inbox-cloud-adapter.ts` requests the selected attachment for the current
account, message, part and history. Notes can open the same bridge after
[matching an original source](./alpha/sourceReferences.md).
`AlphaMailAttachmentsPlugin.openReviewedAt` first tries Android's
external viewer. `AlphaMailPdfActivity` and `IsolatedPdfService` bind
the pinned Eliza `IsolatedPdfViewerActivity`, `IsolatedPdfRenderService`
and `PdfPageLimits` in `plugins/plugin-native-media`.

## Story: Open the reviewed PDF when Android has no viewer

### Dispatch grants temporary read access to the exact reviewed attachment

The bridge requires explicit review, a base64 string of at most 7 MiB
of UTF-16 units, valid decoded bytes and name, a matching SHA-256, a
current request generation, a retained private copy and a focused
activity. A successful external launch hands off a read-only
FileProvider URI. The PDF-only fallback runs after Android reports no
external handler. Other launch failures refuse the handoff. The
`opened` receipt confirms dispatch. Display has its own evidence.

The fallback is non-exported and accepts a `content` URI with the
configured attachment authority and exactly the handoff path and valid
file segment. Only the descriptor opened from that grant reaches the
isolated process. The platform boundary checks URI access on each
descriptor open. Expired or removed copies can fail a later page request.
The bridge schedules copy revocation after 15 minutes and also clears
its own copies on explicit cancellation and destruction.

```quint
type ViewerLaunch = HandlerOpened | HandlerAbsent | HandlerFailed
type HandoffReply = HandoffRefused | ExternalOpened | FallbackOpened
type ReviewedHandoff = { reviewed: bool, encodedUnits: int, bytesValid: bool, digestMatches: bool, generationMatches: bool, copyExists: bool, focused: bool }
pure val copyGrantMs = 900000
pure def mayHandoff(review: ReviewedHandoff): bool =
  review.reviewed and review.encodedUnits >= 0 and review.encodedUnits <= 7340032 and review.bytesValid and
  review.digestMatches and review.generationMatches and review.copyExists and review.focused
pure def dispatchReviewedPdf(review: ReviewedHandoff, pdfMime: bool, handler: ViewerLaunch, fallbackOpened: bool): HandoffReply =
  if (not(mayHandoff(review))) HandoffRefused
  else if (handler == HandlerOpened) ExternalOpened
  else if (handler == HandlerAbsent and pdfMime and fallbackOpened) FallbackOpened
  else HandoffRefused
pure def lawFallbackFollowsMissingHandler(review: ReviewedHandoff, pdfMime: bool, handler: ViewerLaunch, fallbackOpened: bool): bool =
  dispatchReviewedPdf(review,pdfMime,handler,fallbackOpened) == FallbackOpened implies
  mayHandoff(review) and handler == HandlerAbsent and pdfMime and fallbackOpened
pure def viewerUriAdmitted(contentScheme: bool, exactAuthority: bool, exactHandoffPath: bool): bool =
  contentScheme and exactAuthority and exactHandoffPath
pure def lawViewerNeedsHandoffAuthority(contentScheme: bool, exactHandoffPath: bool): bool =
  not(viewerUriAdmitted(contentScheme,false,exactHandoffPath))
pure val readyHandoff: ReviewedHandoff = { reviewed: true, encodedUnits: 20, bytesValid: true, digestMatches: true, generationMatches: true, copyExists: true, focused: true }
pure val reviewValues = Set(readyHandoff, { ...readyHandoff, reviewed: false }, { ...readyHandoff, bytesValid: false },
  { ...readyHandoff, digestMatches: false }, { ...readyHandoff, generationMatches: false },
  { ...readyHandoff, copyExists: false }, { ...readyHandoff, focused: false },
  { ...readyHandoff, encodedUnits: 7340032 }, { ...readyHandoff, encodedUnits: 7340033 })
```

## Story: Read one bounded page at a time in the isolated viewer

### A worker accepts one read-only descriptor within its rendering limits

Messenger operation 1 requires a reply messenger. Admission requires an
isolated process, a descriptor, a 36-character request identity and a
zero-based index below 500, with one worker slot. The viewer uses fresh
UUIDs. The service checks identity length at the wire. Alpha's reviewed
copy request omits the selected-document flag, so its source bound is
5 MiB. The shared service accepts up to 20 MiB for a host-selected
document. Both cases require a positive known descriptor size.

Parsing and rendering run in the service. Admit 1 to 500 pages, a
requested index within the document, and original edges 1 to 20,000
PDF points. The fitted ARGB page has positive edges and at most
1,500,000 pixels, with width at most 1024 and height at most 1536 when
produced by the renderer. The service makes shared memory read-only
before send. The process watchdog is armed at 10 seconds and samples
PSS every 250 ms, killing above 131,072 KiB. Unbind destroys the
isolated process. Android owns the actual watchdog delivery, UID and
network permission, descriptor transport, parsing, fitting, and pixel
allocation. The model checks limits and the decision on those facts.

```quint
pure val workerDeadlineMs = 10000
pure val workerMemorySampleMs = 250
pure def workerAdmits(what: int, replyPort: bool, isolated: bool, descriptor: bool, requestLength: int, pageIndex: int, busy: bool): bool =
  what == 1 and replyPort and isolated and descriptor and requestLength == 36 and pageIndex >= 0 and pageIndex < 500 and not(busy)
pure def sourceWithinPdfLimit(sourceBytes: int, selectedDocument: bool): bool =
  sourceBytes > 0 and sourceBytes <= (if (selectedDocument) 20971520 else 5242880)
pure def pageWithinPdfLimit(pageCount: int, pageIndex: int): bool =
  pageCount >= 1 and pageCount <= 500 and pageIndex >= 0 and pageIndex < pageCount
pure def pdfPointSizeFits(pointWidth: int, pointHeight: int): bool =
  pointWidth >= 1 and pointWidth <= 20000 and pointHeight >= 1 and pointHeight <= 20000
pure def pdfPixelSizeFits(pixelWidth: int, pixelHeight: int): bool =
  pixelWidth >= 1 and pixelHeight >= 1 and pixelWidth <= 1536 and pixelHeight <= 1536 and pixelWidth * pixelHeight <= 1500000
pure def rendererPixelSizeFits(pixelWidth: int, pixelHeight: int): bool =
  pixelWidth <= 1024 and pdfPixelSizeFits(pixelWidth,pixelHeight)
pure def workerShouldExit(isolated: bool, watchdogDelivered: bool, busy: bool, pssKiB: int, unbound: bool): bool =
  isolated and (watchdogDelivered or unbound or (busy and pssKiB > 131072))
pure def lawBusyWorkerRefuses(what: int, replyPort: bool, isolated: bool, descriptor: bool, requestLength: int, pageIndex: int): bool =
  not(workerAdmits(what,replyPort,isolated,descriptor,requestLength,pageIndex,true))
pure def lawReviewedCopyHasFiveMiBLimit(sourceBytes: int): bool =
  sourceWithinPdfLimit(sourceBytes,false) implies sourceBytes <= 5242880
pure def lawExcessWorkerMemoryEndsIsolatedProcess(pssKiB: int): bool =
  pssKiB > 131072 implies workerShouldExit(true,false,true,pssKiB,false)
```

### Only the current page ticket can replace displayed pixels

Each start binds with a fresh lifecycle generation. A matching bind
starts one page request. Page controls require a completed page, and
move one index within the returned count. While requesting another
page the old bitmap can remain displayed. A validated matching response
with a complete bitmap replaces it. A selected index can survive
activity recreation. The modeled initial index is the first page.
Android supplies a fresh descriptor and a request identity for each
send, with a 12-second viewer timeout.

Before mapping pixels, the viewer requires the reply UUID, isolated and
network-denied process, different UID, the requested index within the
page count, positive bounded pixel dimensions and exactly four bytes
per pixel. The viewer accepts width up to 1536, while its producer caps
width at 1024. Mapping or copying failure, a renderer error, current
service failure, descriptor/send failure or timeout clears the image
and releases the binding. Stopping also retires outstanding tickets.
The native receive path decodes the pixel parcel type before checking
the ticket, so a malformed parcel type can clear a current view even
when it would have been an unmatched reply. An ordinary stale reply
can only release its received memory. Status changes while stopped
have no visible page and are outside the active view projection.
The model abstracts cleanup and
the platform's process and SharedMemory implementation.

```quint
type PdfStage = ViewerStopped | ViewerBinding | ViewerPending | ViewerDisplaying | ViewerFailed
type PdfFailure = ServiceFailure | RequestSendFailure | ViewerTimeout
type PdfRequest = { ticket: int, requestedPage: int }
type PdfReply = { ticket: int, pageIndex: int, pageCount: int, pixelWidth: int, pixelHeight: int, pixelBytes: int,
  pixelParcelTyped: bool, hasPixels: bool, isolated: bool, internetDenied: bool, rendererUid: int, viewerUid: int, mappingSucceeded: bool, errorReply: bool }
type PdfViewer = { stage: PdfStage, generation: int, lastTicket: int, pendingTicket: int, pageIndex: int, pageCount: int, displayedTicket: int }
pure val initial: PdfViewer = { stage: ViewerStopped, generation: 0, lastTicket: 0, pendingTicket: 0, pageIndex: 0, pageCount: 0, displayedTicket: 0 }
pure val viewerTimeoutMs = 12000
pure def replyPixelsAdmitted(request: PdfRequest, reply: PdfReply): bool =
  reply.ticket == request.ticket and not(reply.errorReply) and reply.pixelParcelTyped and reply.hasPixels and
  reply.isolated and reply.internetDenied and reply.rendererUid != reply.viewerUid and
  reply.pageIndex == request.requestedPage and pageWithinPdfLimit(reply.pageCount,reply.pageIndex) and
  pdfPixelSizeFits(reply.pixelWidth,reply.pixelHeight) and reply.pixelBytes == 4 * reply.pixelWidth * reply.pixelHeight
pure def failPdfView(view: PdfViewer, generation: int, reason: PdfFailure): PdfViewer =
  { ...view, stage: ViewerFailed, pendingTicket: 0, displayedTicket: 0 }
pure def canFailPdfView(view: PdfViewer, generation: int, reason: PdfFailure): bool =
  generation == view.generation and
  (view.stage == ViewerPending or (reason == ServiceFailure and (view.stage == ViewerBinding or view.stage == ViewerDisplaying)))
pure def canStartPdfView(view: PdfViewer, sourceAdmitted: bool): bool = view.stage == ViewerStopped and sourceAdmitted
pure def startPdfView(view: PdfViewer, sourceAdmitted: bool): PdfViewer =
  { ...view, stage: ViewerBinding, generation: view.generation + 1 }
pure def canBindPdfWorker(view: PdfViewer, generation: int): bool = view.stage == ViewerBinding and view.generation == generation
pure def bindPdfWorker(view: PdfViewer, generation: int): PdfViewer =
  { ...view, stage: ViewerPending, lastTicket: view.lastTicket + 1, pendingTicket: view.lastTicket + 1 }
pure def canTurnPdfPage(view: PdfViewer, requestedPage: int): bool =
  view.stage == ViewerDisplaying and pageWithinPdfLimit(view.pageCount,requestedPage) and
  (requestedPage == view.pageIndex - 1 or requestedPage == view.pageIndex + 1)
pure def turnPdfPage(view: PdfViewer, requestedPage: int): PdfViewer =
  { ...view, stage: ViewerPending, pageIndex: requestedPage, lastTicket: view.lastTicket + 1, pendingTicket: view.lastTicket + 1 }
pure def canReceivePdfReply(view: PdfViewer, reply: PdfReply): bool =
  (view.stage == ViewerPending and view.pendingTicket == reply.ticket) or
  (view.stage != ViewerStopped and not(reply.pixelParcelTyped))
pure def receivePdfReply(view: PdfViewer, reply: PdfReply): PdfViewer =
  if (view.stage == ViewerPending and replyPixelsAdmitted({ ticket: view.pendingTicket, requestedPage: view.pageIndex },reply) and reply.mappingSucceeded)
    { ...view, stage: ViewerDisplaying, pendingTicket: 0, pageCount: reply.pageCount, displayedTicket: reply.ticket }
  else { ...view, stage: ViewerFailed, pendingTicket: 0, displayedTicket: 0 }
pure def canStopPdfView(view: PdfViewer): bool = view.stage != ViewerStopped
pure def stopPdfView(view: PdfViewer): PdfViewer =
  { ...view, stage: ViewerStopped, generation: view.generation + 1, pendingTicket: 0, displayedTicket: 0 }
pure def alwaysPdfTicketWithinIssueHistory(view: PdfViewer): bool =
  view.lastTicket >= 0 and view.displayedTicket >= 0 and view.displayedTicket <= view.lastTicket and
  (view.stage == ViewerPending implies view.pendingTicket > 0 and view.pendingTicket == view.lastTicket) and
  (view.stage != ViewerPending implies view.pendingTicket == 0)
pure def alwaysPdfBitmapHasBoundedPage(view: PdfViewer): bool =
  (view.stage == ViewerDisplaying implies view.displayedTicket > 0 and pageWithinPdfLimit(view.pageCount,view.pageIndex)) and
  ((view.stage == ViewerStopped or view.stage == ViewerFailed or view.stage == ViewerBinding) implies view.displayedTicket == 0)
pure def stepFreshPdfBitmapWasPending(before: PdfViewer, after: PdfViewer): bool =
  (after.displayedTicket > 0 and after.displayedTicket != before.displayedTicket) implies
  before.stage == ViewerPending and after.displayedTicket == before.pendingTicket
pure def lawPdfReplyKeepsPage(request: PdfRequest, reply: PdfReply): bool =
  replyPixelsAdmitted(request,reply) implies reply.ticket == request.ticket and reply.pageIndex == request.requestedPage
pure def lawWellFormedStalePdfReplyDoesNotSettle(view: PdfViewer, reply: PdfReply): bool =
  reply.pixelParcelTyped and reply.ticket != view.pendingTicket implies not(canReceivePdfReply(view,reply))
pure def sometimesPdfPageShown(view: PdfViewer): bool = view.stage == ViewerDisplaying
pure def sometimesPdfTurnPending(view: PdfViewer): bool = view.stage == ViewerPending and view.displayedTicket > 0
pure def sometimesPdfFailure(view: PdfViewer): bool = view.stage == ViewerFailed
pure val goodReply: PdfReply = { ticket: 1, pageIndex: 0, pageCount: 2, pixelWidth: 40, pixelHeight: 60, pixelBytes: 9600,
  pixelParcelTyped: true, hasPixels: true, isolated: true, internetDenied: true, rendererUid: 2, viewerUid: 1, mappingSucceeded: true, errorReply: false }
pure val requestValues = Set({ ticket: 1, requestedPage: 0 }, { ticket: 2, requestedPage: 1 }, { ticket: 3, requestedPage: 500 })
pure val replyValues = Set(goodReply, { ...goodReply, ticket: 2, pageIndex: 1 }, { ...goodReply, ticket: 3 },
  { ...goodReply, rendererUid: 1 }, { ...goodReply, pixelParcelTyped: false }, { ...goodReply, pixelBytes: 100 },
  { ...goodReply, errorReply: true }, { ...goodReply, mappingSucceeded: false }, { ...goodReply, internetDenied: false })
pure val generationValues = Set(0,1,2,3,4,5,6,7)
pure val requestedPageValues = Set(-1,0,1,2,499,500)
pure val pageIndexValues = requestedPageValues
pure val whatValues = Set(0,1)
pure val requestLengthValues = Set(0,35,36,37)
pure val sourceBytesValues = Set(0,1,5242880,5242881,20971520,20971521)
pure val pssKiBValues = Set(0,131071,131072,131073)
pure val weight_startPdfView = 4
pure val weight_bindPdfWorker = 5
pure val weight_receivePdfReply = 7
pure val weight_turnPdfPage = 5
```

The original `IsolatedPdfInstrumentedTest` exercises real Android
descriptor transport, page rendering, read-only shared memory, renderer
termination after unbind, watchdog termination, and a fresh connection.
The `PdfPageLimits` class is also executable without Android for
boundary comparison. The fallback's output contract is one page of
pixels plus dimensions and ticket, with no extracted text.
