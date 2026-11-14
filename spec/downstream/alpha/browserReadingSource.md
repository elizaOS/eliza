# AlphaPhone browser reading source and capability

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` directly imports
Eliza `c518127a025ab173874af9c7d304f26b25213b0d`'s
`plugins/plugin-native-browser-surface/src/{page-reading,page-source}.ts`.
`apps/app/src/prototype/browser-adapter.ts` uses these contracts for
Read aloud and Ask about page. `apps/app/src/browser/reading-review.ts`
owns the web reader dialog. [Browser document custody](./browser.md)
owns the current tab and document identity. [Source references](./sourceReferences.md)
own retained source metadata. This model follows a bounded preview, a
shared native capability probe, and the review that accepts their results.

## Story: Find out whether this browser can supply a private page excerpt

### One native query is shared and only a definite answer is remembered

The bridge probe starts unknown. Parallel checks share the same pending
promise, and failure or a nonboolean answer leaves the probe retryable.
Literal true or false answers are remembered for this probe instance
and call its change callback once. Unknown support permits the request
to reach the native review, which has its own authority checks.
Previously confirmed unavailability closes the menu and refuses both
actions before a native read or speech readiness request.

A native Ask review that has already started can still receive
`isolated-world-unavailable` from the bridge. That code, or the pinned
legacy message prefix on an older bridge, permits an empty review for
the user to paste text. A sensitive-page code takes precedence over the
legacy prefix and refuses the review. Other failures propagate. A
successful bridge reply with a sensitive nonempty string also refuses.
Missing, blank, or over-5,000-unit text on an otherwise successful reply
yields an empty review. Only a literal true truncation flag is preserved
by `pageQuestionReading`. The pinned product's `pageQuestionExcerpt`
projection passes just the text to its Ask dialog.

```quint
type ProbeState = NotAsked | ProbePending | ReadingAvailable | ReadingUnavailable
type ProbeReply = LiteralYes | LiteralNo | ProbeOther
type ReadingCapability = { phase: ProbeState }
pure val initial: ReadingCapability = { phase: NotAsked }
pure def canQueryReadingSupport(s: ReadingCapability): bool = s.phase == NotAsked
pure def queryReadingSupport(s: ReadingCapability): ReadingCapability = { phase: ProbePending }
pure def canResolveReadingSupport(s: ReadingCapability): bool = s.phase == ProbePending
pure def resolveReadingSupport(s: ReadingCapability, answer: ProbeReply): ReadingCapability =
  { phase: if (answer == LiteralYes) ReadingAvailable else if (answer == LiteralNo) ReadingUnavailable else NotAsked }
pure def nativeReadingAllowed(s: ReadingCapability): bool = s.phase != ReadingUnavailable
pure def stepDefiniteReadingSupportIsStable(before: ReadingCapability, after: ReadingCapability): bool =
  (before.phase == ReadingAvailable or before.phase == ReadingUnavailable) implies after.phase == before.phase
pure def sometimesReadingAvailable(s: ReadingCapability): bool = s.phase == ReadingAvailable
pure def sometimesReadingUnavailable(s: ReadingCapability): bool = s.phase == ReadingUnavailable

type AskReadStatus = AskReadSuccess | AskSensitive | AskIsolatedUnavailable | AskOtherFailure
type Appearance = SourceContainsSecrets | SourceNoExcerpt | SourceExcerpt | SourceFailure
type NativeAskRead = { status: AskReadStatus, legacyUnavailable: bool, stringText: bool, nonblank: bool, textUnits: int, sensitiveText: bool, explicitlyTruncated: bool }
type AskProjection = { appearance: Appearance, truncated: bool }
pure def projectNativeAsk(reading: NativeAskRead): AskProjection =
  if (reading.status == AskSensitive or (reading.status == AskReadSuccess and reading.stringText and reading.textUnits > 0 and reading.sensitiveText))
    { appearance: SourceContainsSecrets, truncated: false }
  else if (reading.status == AskIsolatedUnavailable or (reading.status == AskOtherFailure and reading.legacyUnavailable))
    { appearance: SourceNoExcerpt, truncated: false }
  else if (reading.status == AskOtherFailure)
    { appearance: SourceFailure, truncated: false }
  else if (reading.stringText and reading.nonblank and reading.textUnits > 0 and reading.textUnits <= 5000)
    { appearance: SourceExcerpt, truncated: reading.explicitlyTruncated }
  else { appearance: SourceNoExcerpt, truncated: false }
pure def lawNativeSensitiveFailureRefusesAsk(reading: NativeAskRead): bool =
  reading.status == AskSensitive implies projectNativeAsk(reading).appearance == SourceContainsSecrets
pure def lawKnownUnsupportedSkipsNativeReview(s: ReadingCapability): bool =
  s.phase == ReadingUnavailable implies not(nativeReadingAllowed(s))
pure val goodReading: NativeAskRead = { status: AskReadSuccess, legacyUnavailable: false, stringText: true, nonblank: true, textUnits: 5000, sensitiveText: false, explicitlyTruncated: true }
pure val readingValues = Set(goodReading, { ...goodReading, textUnits: 5001 }, { ...goodReading, nonblank: false },
  { ...goodReading, stringText: false }, { ...goodReading, sensitiveText: true },
  { ...goodReading, status: AskSensitive, legacyUnavailable: true }, { ...goodReading, status: AskIsolatedUnavailable },
  { ...goodReading, status: AskOtherFailure }, { ...goodReading, status: AskOtherFailure, legacyUnavailable: true })
```

## Story: Keep public page reading under the person's review

### An unauthenticated public source fetch has a bounded inert preview

The browser reads only a valid HTTP or HTTPS URL without userinfo after
classifying sensitive URLs. Upstream uses browser CORS with credentials
omitted, redirects refused, no referrer and no store. Only successful
`text/html` or `text/plain` responses with a readable body can return
an excerpt. A stated or streamed size greater than 262,144 raw bytes
blocks. The reader decodes UTF-8 fatally and releases the stream lock.
Plain text longer than 20,000 UTF-16 units or identified as sensitive
blocks. HTML passes through an inert document. Sensitive forms,
headings and content are checked before removing navigation, forms,
script, interactive and hidden content. The extractor prefers the
first matching article, main, or main role.

The fetch uses a five-second default timeout. A caller cancellation
observed during transport or final publication rejects the promise.
A timeout or transport, CORS, redirect, parsing, or decoding error
normally leaves no excerpt. URL and size or content results decided
before transport completion can return their own early ruling. The
review separately drops any reply after its signal is aborted.
Normalize whitespace and take at most 5,000 UTF-16 units from a nonempty
result, with an explicit truncation marker. This is the review preview.
It does not restore or replace the complete selected source. HTTP and
DOM facts are supplied by the browser ports.

```quint
type ResponseKind = PlainSource | HtmlSource | OtherSource
type SourceOutcome = BlockedSource | MissingSource | PreviewSource | CancelledSource
type SourceReply = { responseOk: bool, responseKind: ResponseKind, hasBody: bool, completed: bool, utf8Valid: bool,
  parseSucceeded: bool, declaredBytes: int, receivedBytes: int, plainUnits: int, extractedUnits: int, sensitiveDoc: bool, callerCancelled: bool }
type SourcePreview = { sourceStatus: SourceOutcome, previewUnits: int, truncated: bool }
type SourceUrl = { sensitiveUrl: bool, validHttpUrl: bool, hasUserInfo: bool }
pure def sourceFetchAllowed(address: SourceUrl): bool =
  not(address.sensitiveUrl) and address.validHttpUrl and not(address.hasUserInfo)
pure def emptyPreview(sourceStatus: SourceOutcome): SourcePreview = { sourceStatus: sourceStatus, previewUnits: 0, truncated: false }
pure def cleanSourcePreview(extractedUnits: int): SourcePreview =
  if (extractedUnits <= 0) emptyPreview(MissingSource)
  else { sourceStatus: PreviewSource, previewUnits: if (extractedUnits > 5000) 5000 else extractedUnits, truncated: extractedUnits > 5000 }
pure def pageSourceResult(address: SourceUrl, response: SourceReply): SourcePreview =
  if (address.sensitiveUrl) emptyPreview(BlockedSource)
  else if (not(sourceFetchAllowed(address))) emptyPreview(MissingSource)
  else if (not(response.completed)) emptyPreview(if (response.callerCancelled) CancelledSource else MissingSource)
  else if (not(response.responseOk) or response.responseKind == OtherSource) emptyPreview(MissingSource)
  else if (response.declaredBytes > 262144) emptyPreview(BlockedSource)
  else if (not(response.hasBody)) emptyPreview(MissingSource)
  else if (response.receivedBytes > 262144) emptyPreview(BlockedSource)
  else if (not(response.utf8Valid) or (response.responseKind == HtmlSource and not(response.parseSucceeded)))
    emptyPreview(if (response.callerCancelled) CancelledSource else MissingSource)
  else if (response.sensitiveDoc or (response.responseKind == PlainSource and response.plainUnits > 20000)) emptyPreview(BlockedSource)
  else if (response.callerCancelled) emptyPreview(CancelledSource)
  else cleanSourcePreview(response.extractedUnits)
pure def lawPublicPreviewIsBounded(address: SourceUrl, response: SourceReply): bool = {
  val result = pageSourceResult(address,response)
  result.sourceStatus == PreviewSource implies sourceFetchAllowed(address) and
    result.previewUnits > 0 and result.previewUnits <= 5000 and (result.truncated == (response.extractedUnits > 5000))
}
pure def lawCallerCancellationCannotPublishPreview(address: SourceUrl, response: SourceReply): bool =
  response.callerCancelled implies pageSourceResult(address,response).sourceStatus != PreviewSource
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
pure val extractedUnitsValues = Set(0,1,5000,5001,20000)
```

### A late excerpt preserves user edits and only current reviewed text can be used

The local reading dialog can accept edits while the browser fetch is
pending. Its Read action waits for completion. A usable preview prefills
only an unedited field in the current review. Missing source leaves the
field available for paste. A blocked source clears and disables the
field, including any intervening edits. Close, Back, page hide, caller
abort, and loss of current browser identity retire the review or fence
its publication. A reply may set the current status only after the
caller revalidates the live review. Local speech accepts trimmed
nonempty text within 5,000 units after its sensitive-text classifier.
An Ask review separately checks edited content and rechecks the original
source identity during composition. It prepares a draft for the person.

The rules use an already validated review identity and DOM facts. Native
isolated-world handshake, token consumption and TTS transport remain
separate from the preview and renderer capability gate. The original
`BrowserReadingState.qnt` models the native handshake and review. The
Alpha browser reading source, sensitive, capability and review fixtures
exercise the web producer and its actual dialog.

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
  review.active and review.sameVisit and not(review.aborted or review.pending or review.blocked) and units > 0 and units <= 5000 and not(sensitive)
pure def lawUserEditedFieldCannotBePrefilled(review: ReviewFacts, result: SourceOutcome): bool =
  review.edited implies previewDecision(review,result) != SetPreview
pure def lawRetiredReviewCannotPublishPreview(review: ReviewFacts, result: SourceOutcome): bool =
  not(review.active and review.sameVisit and not(review.aborted)) implies previewDecision(review,result) == IgnorePreview
pure def lawBlockedReviewCannotStartSpeech(review: ReviewFacts, units: int, sensitive: bool): bool =
  review.blocked implies not(localSpeechMayStart(review,units,sensitive))
pure val runningReview: ReviewFacts = { active: true, sameVisit: true, aborted: false, pending: false, edited: false, blocked: false }
pure val reviewValues = Set(runningReview, { ...runningReview, edited: true }, { ...runningReview, pending: true },
  { ...runningReview, blocked: true }, { ...runningReview, aborted: true }, { ...runningReview, sameVisit: false }, { ...runningReview, active: false })
pure val unitsValues = extractedUnitsValues
```
