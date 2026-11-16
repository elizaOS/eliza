# Browser page reading

Read aloud and Ask about page take a bounded excerpt of the page the
person chose. On Android the excerpt comes from an isolated world of the
current document, and speech spends a one-use token bound to the reading
voice; in the renderer, a capability probe decides whether the native
path is offered, and a public preview fetched without credentials fills
the review when it cannot be. [Browser document custody](./documentCustody.md)
owns the current tab and document identity.

## Story: Extract only from the current isolated document

> As the person, I want a page read to me or asked about only from the
> document I am looking at, so that a redirected, reloaded or hidden page
> never answers for it.

### Readiness and extraction require the same HTTPS main-frame document

World setup requires the WebView isolated-world capability. A prepared
load adopts only its own nonce after the exact prepared address has
started; a redirect, link or page-initiated reload creates a new
generation and expects the standard readiness announcement. Both need a
string main-frame message from this WebView with a document ID of 1 to 64
units, from a sender whose origin equals the expected HTTPS origin and the
WebView's current origin. An extraction is accepted only while the same
proxy, generation, URL and ready world remain current; there is no
page-world fallback. The page itself must be the presented, shown,
committed HTTPS page of the active session, not loading and without
error, at the exact URL and navigation the request captured.

```quint
type ReadyMessage = { worldAvailable: bool, matchingWebView: bool, mainFrame: bool, stringMessage: bool,
  documentUnits: int, prepared: bool, loadStarted: bool, nonceMatches: bool, normalReady: bool,
  expectedHttps: bool, senderMatchesExpected: bool, senderMatchesVisible: bool }
type WorldReadback = { worldReady: bool, sameGeneration: bool, sameProxy: bool, sameUrl: bool }
type ShownPage = { activeHost: bool, exactSession: bool, actualTabObject: bool, presented: bool, shown: bool,
  committed: bool, loading: bool, error: bool, exactUrl: bool, exactNavigation: bool, https: bool }
pure def admitsReadiness(message: ReadyMessage): bool =
  message.worldAvailable and message.matchingWebView and message.mainFrame and message.stringMessage and
  message.documentUnits >= 1 and message.documentUnits <= 64 and message.expectedHttps and
  message.senderMatchesExpected and message.senderMatchesVisible and
  (if (message.prepared) message.loadStarted and message.nonceMatches else message.normalReady)
pure def worldStillCurrent(readback: WorldReadback): bool =
  readback.worldReady and readback.sameGeneration and readback.sameProxy and readback.sameUrl
pure def allowsPageExtraction(readback: WorldReadback, identityWellFormed: bool, exactDocument: bool, exactProbeUrl: bool): bool =
  worldStillCurrent(readback) and identityWellFormed and exactDocument and exactProbeUrl
pure def admitsShownPage(page: ShownPage): bool =
  page.activeHost and page.exactSession and page.actualTabObject and page.presented and page.shown and
  page.committed and not(page.loading or page.error) and page.exactUrl and page.exactNavigation and page.https
pure def lawPreparedWorldNeedsItsNonce(message: ReadyMessage): bool =
  message.prepared and not(message.nonceMatches) implies not(admitsReadiness(message))
pure def lawUnrelatedWorldCannotBeRead(readback: WorldReadback, identityWellFormed: bool, exactDocument: bool, exactProbeUrl: bool): bool =
  not(worldStillCurrent(readback)) implies not(allowsPageExtraction(readback, identityWellFormed, exactDocument, exactProbeUrl))
pure val authenticReady: ReadyMessage = { worldAvailable: true, matchingWebView: true, mainFrame: true, stringMessage: true,
  documentUnits: 36, prepared: true, loadStarted: true, nonceMatches: true, normalReady: false,
  expectedHttps: true, senderMatchesExpected: true, senderMatchesVisible: true }
pure val messageValues = Set(authenticReady, { ...authenticReady, prepared: false, normalReady: true },
  { ...authenticReady, nonceMatches: false }, { ...authenticReady, mainFrame: false }, { ...authenticReady, documentUnits: 65 },
  { ...authenticReady, senderMatchesVisible: false }, { ...authenticReady, loadStarted: false })
pure val readyWorld: WorldReadback = { worldReady: true, sameGeneration: true, sameProxy: true, sameUrl: true }
pure val readbackValues = Set(readyWorld, { ...readyWorld, sameGeneration: false }, { ...readyWorld, sameProxy: false }, { ...readyWorld, sameUrl: false })
pure val visiblePage: ShownPage = { activeHost: true, exactSession: true, actualTabObject: true, presented: true, shown: true,
  committed: true, loading: false, error: false, exactUrl: true, exactNavigation: true, https: true }
pure val pageValues = Set(visiblePage, { ...visiblePage, loading: true }, { ...visiblePage, exactNavigation: false }, { ...visiblePage, https: false })
```

## Story: Release a reviewed page excerpt to its exact destination

> As the person, I want the excerpt I asked about returned to my draft,
> and the one I asked to hear spoken once by my device, so that nothing
> from the page goes anywhere I did not choose.

### Ask opens an editor and speech consumes one bound token

A new native review retires the previous request, including one in
playback. Admission distinguishes unavailable world support, a rejected
speech binding, a sensitive URL and an unready document, in that order,
and an admitted request holds a two-minute review lease. An extraction
fails if its isolated execution failed, the page changed, or the reply is
malformed, blank, longer than the excerpt limit or blocked by the
sensitive classifier. Ask shows the captured excerpt and, once approved
on the same page within its lease, returns it to the editor. Read aloud
issues a token without another dialog, still within the lease; the token
is spent once, by the exact token and binding of the live page with a
nonblank request ID of at most 256 units. Playback uses only the excerpt
and has its own twenty-minute timeout; stop, host pause and replacement
of the owning tab end it sooner.

```quint
type NativePurpose = PageQuestion | DeviceReadAloud
type BeginReading = BeginExtract | ReadingUnsupported | InvalidSpeechBinding | SensitiveAddress | WorldNotReady
type ProbeState = NotAsked | ProbePending | ReadingAvailable | ReadingUnavailable
pure val excerptLimit = 5000
pure val reviewLeaseMs = 120000
pure val playbackTimeoutMs = 1200000
pure val requestIdLimit = 256
pure def admitReading(purpose: NativePurpose, worldAvailable: bool, bindingValid: bool, sensitiveAddress: bool, worldReady: bool): BeginReading =
  if (not(worldAvailable)) ReadingUnsupported
  else if (purpose == DeviceReadAloud and not(bindingValid)) InvalidSpeechBinding
  else if (sensitiveAddress) SensitiveAddress
  else if (not(worldReady)) WorldNotReady
  else BeginExtract
type ReadingPhase = ReadingIdle | ExtractingPage | ReviewExcerpt | SpeechApproved | DraftReleased | SpeechActive | ReadingRefused
type ReadingLease = { phase: ReadingPhase, purpose: NativePurpose, generation: int, units: int, tokenLive: bool, supportProbe: ProbeState }
type ExtractionReply = { sameGeneration: bool, stillCurrent: bool, leaseLive: bool, validPayload: bool, blocked: bool, textUnits: int }
type SpeechUse = { stillCurrent: bool, leaseLive: bool, exactToken: bool, exactBinding: bool, requestIdUnits: int }
pure val initial: ReadingLease = { phase: ReadingIdle, purpose: PageQuestion, generation: 0, units: 0, tokenLive: false, supportProbe: NotAsked }
pure def canStartReading(s: ReadingLease, purpose: NativePurpose, admission: BeginReading): bool = s.supportProbe != ReadingUnavailable
pure def startReading(s: ReadingLease, purpose: NativePurpose, admission: BeginReading): ReadingLease =
  { ...initial, supportProbe: s.supportProbe, generation: s.generation + 1, purpose: purpose, phase: if (admission == BeginExtract) ExtractingPage else ReadingRefused }
pure def canReceiveExcerpt(s: ReadingLease, extraction: ExtractionReply): bool =
  s.phase == ExtractingPage and extraction.sameGeneration
pure def receiveExcerpt(s: ReadingLease, extraction: ExtractionReply): ReadingLease =
  if (not(extraction.stillCurrent and extraction.validPayload) or extraction.blocked or
    extraction.textUnits <= 0 or extraction.textUnits > excerptLimit)
    { ...s, phase: ReadingRefused }
  else if (s.purpose == DeviceReadAloud and not(extraction.leaseLive)) { ...s, phase: ReadingRefused }
  else if (s.purpose == DeviceReadAloud) { ...s, phase: SpeechApproved, units: extraction.textUnits, tokenLive: true }
  else { ...s, phase: ReviewExcerpt, units: extraction.textUnits }
pure def canApproveExcerpt(s: ReadingLease, samePage: bool, liveLease: bool): bool =
  s.phase == ReviewExcerpt and samePage and liveLease
pure def approveExcerpt(s: ReadingLease, samePage: bool, liveLease: bool): ReadingLease = { ...s, phase: DraftReleased }
pure def canConsumeReading(s: ReadingLease, use: SpeechUse): bool =
  s.phase == SpeechApproved and s.tokenLive and use.stillCurrent and use.leaseLive and use.exactToken and use.exactBinding and
  use.requestIdUnits >= 1 and use.requestIdUnits <= requestIdLimit
pure def consumeReading(s: ReadingLease, use: SpeechUse): ReadingLease =
  { ...s, phase: SpeechActive, generation: s.generation + 1, tokenLive: false }
pure def canRetireReading(s: ReadingLease, relevantOwner: bool): bool = s.phase != ReadingIdle and relevantOwner
pure def retireReading(s: ReadingLease, relevantOwner: bool): ReadingLease = { ...initial, supportProbe: s.supportProbe, generation: s.generation + 1 }
pure def alwaysReadingContentIsBounded(s: ReadingLease): bool =
  (s.phase == ReviewExcerpt or s.phase == SpeechApproved or s.phase == DraftReleased or s.phase == SpeechActive)
    implies s.units >= 1 and s.units <= excerptLimit
pure def alwaysReviewKeepsPurpose(s: ReadingLease): bool =
  ((s.phase == ReviewExcerpt or s.phase == DraftReleased) implies s.purpose == PageQuestion) and
  ((s.phase == SpeechApproved or s.phase == SpeechActive) implies s.purpose == DeviceReadAloud)
pure def alwaysOnlyApprovalHasToken(s: ReadingLease): bool = s.tokenLive == (s.phase == SpeechApproved)
pure def stepReadingTokenCanBeSpentOnce(before: ReadingLease, via: str, after: ReadingLease): bool =
  via == "consumeReading" implies before.tokenLive and not(after.tokenLive) and before.units == after.units
pure def sometimesAskDraft(s: ReadingLease): bool = s.phase == DraftReleased
pure def sometimesDeviceSpeaking(s: ReadingLease): bool = s.phase == SpeechActive
pure val validExtraction: ExtractionReply = { sameGeneration: true, stillCurrent: true, leaseLive: true, validPayload: true, blocked: false, textUnits: 120 }
pure val extractionValues = Set(validExtraction, { ...validExtraction, sameGeneration: false }, { ...validExtraction, stillCurrent: false },
  { ...validExtraction, blocked: true }, { ...validExtraction, textUnits: 5001 }, { ...validExtraction, leaseLive: false })
pure val exactSpeechUse: SpeechUse = { stillCurrent: true, leaseLive: true, exactToken: true, exactBinding: true, requestIdUnits: 36 }
pure val useValues = Set(exactSpeechUse, { ...exactSpeechUse, exactToken: false }, { ...exactSpeechUse, exactBinding: false },
  { ...exactSpeechUse, leaseLive: false }, { ...exactSpeechUse, requestIdUnits: 0 }, { ...exactSpeechUse, requestIdUnits: 257 })
pure val weight_receiveExcerpt = 5
pure val weight_approveExcerpt = 5
pure val weight_consumeReading = 5
```

## Story: Find out whether this browser can supply a private page excerpt

> As the person, I want to know whether this browser can give the agent a
> private page excerpt before I ask for one, so that I paste text myself
> when it cannot.

### One native query is shared and only a definite answer is remembered

The probe starts unknown. Parallel checks share one pending query; a
failure or a non-boolean answer leaves it retryable. A literal true or
false is remembered for this probe and reported once. Unknown support
lets a request reach the native review, which has its own checks; a
confirmed unavailability refuses both actions before any native read.

```quint
type ProbeReply = LiteralYes | LiteralNo | ProbeOther
pure def canQueryReadingSupport(s: ReadingLease): bool = s.supportProbe == NotAsked
pure def queryReadingSupport(s: ReadingLease): ReadingLease = { ...s, supportProbe: ProbePending }
pure def canResolveReadingSupport(s: ReadingLease): bool = s.supportProbe == ProbePending
pure def resolveReadingSupport(s: ReadingLease, answer: ProbeReply): ReadingLease =
  { ...s, supportProbe: if (answer == LiteralYes) ReadingAvailable else if (answer == LiteralNo) ReadingUnavailable else NotAsked }
pure def stepDefiniteReadingSupportIsStable(before: ReadingLease, after: ReadingLease): bool =
  (before.supportProbe == ReadingAvailable or before.supportProbe == ReadingUnavailable) implies after.supportProbe == before.supportProbe
pure def stepUnavailableReadingStartsNothing(before: ReadingLease, via: str, after: ReadingLease): bool =
  via == "startReading" implies before.supportProbe != ReadingUnavailable
pure def sometimesReadingAvailable(s: ReadingLease): bool = s.supportProbe == ReadingAvailable
pure def sometimesReadingUnavailable(s: ReadingLease): bool = s.supportProbe == ReadingUnavailable
```

### A sensitive page refuses Ask, and an unavailable isolated world opens an empty review

A native Ask review that has started can still be told the isolated world
is unavailable; it then opens an empty review for the person to paste
text. A sensitive-page answer, or a successful reply whose text the
classifier finds sensitive, refuses the review. Other failures propagate.
Missing, blank or over-limit text on a successful reply yields an empty
review, and only a literal true truncation flag is kept.

```quint
type AskReadStatus = AskReadSuccess | AskSensitive | AskIsolatedUnavailable | AskOtherFailure
type Appearance = SourceContainsSecrets | SourceNoExcerpt | SourceExcerpt | SourceFailure
type NativeAskRead = { status: AskReadStatus, stringText: bool, nonblank: bool, textUnits: int, sensitiveText: bool, explicitlyTruncated: bool }
type AskProjection = { appearance: Appearance, truncated: bool }
pure def projectNativeAsk(reading: NativeAskRead): AskProjection =
  if (reading.status == AskSensitive or (reading.status == AskReadSuccess and reading.stringText and reading.textUnits > 0 and reading.sensitiveText))
    { appearance: SourceContainsSecrets, truncated: false }
  else if (reading.status == AskIsolatedUnavailable) { appearance: SourceNoExcerpt, truncated: false }
  else if (reading.status == AskOtherFailure) { appearance: SourceFailure, truncated: false }
  else if (reading.stringText and reading.nonblank and reading.textUnits > 0 and reading.textUnits <= excerptLimit)
    { appearance: SourceExcerpt, truncated: reading.explicitlyTruncated }
  else { appearance: SourceNoExcerpt, truncated: false }
pure def lawSensitiveAskIsRefused(reading: NativeAskRead): bool =
  reading.status == AskSensitive implies projectNativeAsk(reading).appearance == SourceContainsSecrets
pure val goodReading: NativeAskRead = { status: AskReadSuccess, stringText: true, nonblank: true, textUnits: 5000, sensitiveText: false, explicitlyTruncated: true }
pure val readingValues = Set(goodReading, { ...goodReading, textUnits: 5001 }, { ...goodReading, nonblank: false },
  { ...goodReading, stringText: false }, { ...goodReading, sensitiveText: true },
  { ...goodReading, status: AskSensitive }, { ...goodReading, status: AskIsolatedUnavailable },
  { ...goodReading, status: AskOtherFailure })
```

## Story: Keep public page reading under the person's review

> As the person, I want a page read from its public source to stay a
> bounded preview under my review, so that nothing private is fetched and
> my own edits are never overwritten.

### An unauthenticated public source fetch has a bounded inert preview

The browser fetches only a valid HTTP or HTTPS URL without user info that
is not classified sensitive, without credentials, redirects or referrer.
Only a successful plain-text or HTML response with a readable body can
give an excerpt. A stated or received body over 262,144 bytes, plain text
over 20,000 units, or a sensitive document blocks. HTML is read as an
inert document with navigation, forms, scripts and hidden content
removed. A caller cancellation or a failed transfer, decoding or parse
leaves no excerpt. A nonempty result is whitespace-normalized and cut to
the excerpt limit with an explicit truncation marker; it is a review
preview, never the complete source.

```quint
type ResponseKind = PlainSource | HtmlSource | OtherSource
type SourceOutcome = BlockedSource | MissingSource | PreviewSource | CancelledSource
type SourceReply = { responseOk: bool, responseKind: ResponseKind, hasBody: bool, completed: bool, utf8Valid: bool,
  parseSucceeded: bool, declaredBytes: int, receivedBytes: int, plainUnits: int, extractedUnits: int, sensitiveDoc: bool, callerCancelled: bool }
type SourcePreview = { sourceStatus: SourceOutcome, previewUnits: int, truncated: bool }
type SourceUrl = { sensitiveUrl: bool, validHttpUrl: bool, hasUserInfo: bool }
pure val sourceBytesLimit = 262144
pure val plainUnitsLimit = 20000
pure def sourceFetchAllowed(address: SourceUrl): bool =
  not(address.sensitiveUrl) and address.validHttpUrl and not(address.hasUserInfo)
pure def emptyPreview(sourceStatus: SourceOutcome): SourcePreview = { sourceStatus: sourceStatus, previewUnits: 0, truncated: false }
pure def cleanSourcePreview(extractedUnits: int): SourcePreview =
  if (extractedUnits <= 0) emptyPreview(MissingSource)
  else { sourceStatus: PreviewSource, previewUnits: if (extractedUnits > excerptLimit) excerptLimit else extractedUnits, truncated: extractedUnits > excerptLimit }
pure def pageSourceResult(address: SourceUrl, response: SourceReply): SourcePreview =
  if (address.sensitiveUrl) emptyPreview(BlockedSource)
  else if (not(sourceFetchAllowed(address))) emptyPreview(MissingSource)
  else if (not(response.completed)) emptyPreview(if (response.callerCancelled) CancelledSource else MissingSource)
  else if (not(response.responseOk) or response.responseKind == OtherSource) emptyPreview(MissingSource)
  else if (response.declaredBytes > sourceBytesLimit) emptyPreview(BlockedSource)
  else if (not(response.hasBody)) emptyPreview(MissingSource)
  else if (response.receivedBytes > sourceBytesLimit) emptyPreview(BlockedSource)
  else if (not(response.utf8Valid) or (response.responseKind == HtmlSource and not(response.parseSucceeded)))
    emptyPreview(if (response.callerCancelled) CancelledSource else MissingSource)
  else if (response.sensitiveDoc or (response.responseKind == PlainSource and response.plainUnits > plainUnitsLimit)) emptyPreview(BlockedSource)
  else if (response.callerCancelled) emptyPreview(CancelledSource)
  else cleanSourcePreview(response.extractedUnits)
pure def lawPublicPreviewIsBounded(address: SourceUrl, response: SourceReply): bool = {
  val result = pageSourceResult(address, response)
  result.sourceStatus == PreviewSource implies sourceFetchAllowed(address) and
    result.previewUnits > 0 and result.previewUnits <= excerptLimit and (result.truncated == (response.extractedUnits > excerptLimit))
}
pure def lawCallerCancellationCannotPublishPreview(address: SourceUrl, response: SourceReply): bool =
  response.callerCancelled implies pageSourceResult(address, response).sourceStatus != PreviewSource
pure val clearAddress: SourceUrl = { sensitiveUrl: false, validHttpUrl: true, hasUserInfo: false }
pure val addressValues = Set(clearAddress, { ...clearAddress, sensitiveUrl: true }, { ...clearAddress, hasUserInfo: true },
  { ...clearAddress, validHttpUrl: false })
pure val simpleResponse: SourceReply = { responseOk: true, responseKind: PlainSource, hasBody: true, completed: true,
  utf8Valid: true, parseSucceeded: true, declaredBytes: 6000, receivedBytes: 6000, plainUnits: 6000, extractedUnits: 6000,
  sensitiveDoc: false, callerCancelled: false }
pure val responseValues = Set(simpleResponse, { ...simpleResponse, responseKind: HtmlSource, extractedUnits: 25 },
  { ...simpleResponse, responseKind: OtherSource }, { ...simpleResponse, declaredBytes: 262145 },
  { ...simpleResponse, receivedBytes: 262145 }, { ...simpleResponse, hasBody: false }, { ...simpleResponse, completed: false },
  { ...simpleResponse, utf8Valid: false }, { ...simpleResponse, sensitiveDoc: true },
  { ...simpleResponse, callerCancelled: true }, { ...simpleResponse, plainUnits: 20001 })
```

### A late excerpt preserves user edits and only current reviewed text can be used

The reading dialog accepts edits while the fetch is pending, and its Read
action waits for completion. A usable preview fills only an unedited field
of the current review; a missing source leaves the field open for paste;
a blocked source clears and disables it, edits included. Close, Back,
page hide, caller abort and loss of the current browser identity retire
the review. Local speech starts only from trimmed nonempty text within
the excerpt limit that the sensitive classifier passes.

```quint
type ReviewFacts = { active: bool, sameVisit: bool, aborted: bool, pending: bool, edited: bool, blocked: bool }
type PreviewDecision = IgnorePreview | PreserveEdits | RequirePaste | SetPreview | BlockField
pure def previewDecision(review: ReviewFacts, result: SourceOutcome): PreviewDecision =
  if (not(review.active and review.sameVisit and not(review.aborted)) or result == CancelledSource) IgnorePreview
  else if (result == BlockedSource) BlockField
  else if (review.blocked) IgnorePreview
  else if (review.edited) PreserveEdits
  else if (result == PreviewSource) SetPreview
  else RequirePaste
pure def localSpeechMayStart(review: ReviewFacts, units: int, sensitive: bool): bool =
  review.active and review.sameVisit and not(review.aborted or review.pending or review.blocked) and units > 0 and units <= excerptLimit and not(sensitive)
pure def lawUserEditedFieldCannotBePrefilled(review: ReviewFacts, result: SourceOutcome): bool =
  review.edited implies previewDecision(review, result) != SetPreview
pure def lawRetiredReviewCannotPublishPreview(review: ReviewFacts, result: SourceOutcome): bool =
  not(review.active and review.sameVisit and not(review.aborted)) implies previewDecision(review, result) == IgnorePreview
pure def lawBlockedReviewCannotStartSpeech(review: ReviewFacts, units: int, sensitive: bool): bool =
  review.blocked implies not(localSpeechMayStart(review, units, sensitive))
pure val runningReview: ReviewFacts = { active: true, sameVisit: true, aborted: false, pending: false, edited: false, blocked: false }
pure val reviewValues = Set(runningReview, { ...runningReview, edited: true }, { ...runningReview, pending: true },
  { ...runningReview, blocked: true }, { ...runningReview, aborted: true }, { ...runningReview, sameVisit: false }, { ...runningReview, active: false })
pure val unitsValues = Set(0, 1, 5000, 5001, 20000)
```
