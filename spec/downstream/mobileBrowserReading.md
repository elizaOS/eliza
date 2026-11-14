# Android isolated browser reading and one-use speech approval

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` uses Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`'s
`BrowserTabHostPlugin`, `BrowserReadingWorld` and `BrowserReviewedReading`
from `plugins/plugin-native-browser-surface/android`. Alpha's
`native-reading-voice.ts` sends only the token and its binding to
`AlphaVoiceCloudPlugin`. [Renderer reading source](./alpha/browserReadingSource.md)
owns capability caching, pasted text and the public browser preview.
The installed reading flow selects on-device speech. The paired
route is reachable through Alpha's test-mocks build and the shared
native boundary still validates that route.

## Story: Extract only from the current isolated document

### Readiness and extraction require the same HTTPS main-frame document

World setup requires the WebView isolated-world capability. A
prepared load adopts only its own nonce after the exact prepared
address has started. A redirect, link or page-initiated reload
creates a new generation and expects the standard readiness
announcement. Both routes require a string main-frame message
from this WebView with a document ID 1 to 64 UTF-16 units long.
The engine's sender origin must equal the expected HTTPS origin
and the current WebView origin. The adopted proxy receives a
document identity and URL probe before extraction. The result is
accepted only while the same proxy, generation, URL and ready
world remain current. There is no page-world execution fallback.

The bridge's outer gate also requires the exact active session,
presented WebView object and navigation, a shown and committed HTTPS
page, no active load or error, and an unpaused host. The captured
request URL must equal both the tab URL and the current WebView URL.
The model receives the origin normalization, native-proxy comparison,
and renderer identity checks as observed port facts.

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
  not(worldStillCurrent(readback)) implies not(allowsPageExtraction(readback,identityWellFormed,exactDocument,exactProbeUrl))
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

### Ask opens an editor and speech consumes one bound token

A native review that reaches the reading owner retires its previous
request, including one in playback. Admission distinguishes unavailable
world support, rejected speech binding, sensitive URL and unready
document in that order. An admitted request holds a two-minute lease.
An extraction can fail because its isolated execution failed, because
the current page changed, or because the reply is malformed, blank,
too long or blocked by the sensitive classifier. Native checks the
captured generation and the current-page predicate before handling a
successful extraction. The native sensitive-page code and isolated
execution failure code preserve distinct renderer responses.

Question and paired-speech flows show the captured excerpt. Question
approval returns the excerpt to the editor. On-device speech issues a
token without another dialog after the person's Read aloud action and
current lease check. Paired release requires approval. Speech approval
requires the live page, lease, token and exact route, owner, session
and binding expiration values. The local binding has no origin and
its expiration is at most 120 seconds ahead when checked. The paired
binding uses an HTTPS origin with no path, query, fragment or userinfo.
Development can allow the two pinned HTTP loopback hosts. The bridge
owns these normalized binding checks. The shared implementation uses a
UUID token and an immutable excerpt. The model projects token equality
and keeps the issue generation. Only a nonblank request ID up to 256
UTF-16 units can consume it. A busy paired speaker can refuse before
consumption. Playback retires that approval, uses only its text, and
gets a separate twenty-minute timeout. Stop, host pause and replacement
of the owning tab end playback sooner. An unrelated tab event leaves it
alone. Audio delivery and callback scheduling are shell obligations.

```quint
type NativePurpose = PageQuestion | DeviceReadAloud | PairedReadAloud
type BeginReading = BeginExtract | ReadingUnsupported | InvalidSpeechBinding | SensitiveAddress | WorldNotReady
pure def admitReading(purpose: NativePurpose, worldAvailable: bool, bindingValid: bool, sensitiveAddress: bool, worldReady: bool): BeginReading =
  if (not(worldAvailable)) ReadingUnsupported
  else if (purpose != PageQuestion and not(bindingValid)) InvalidSpeechBinding
  else if (sensitiveAddress) SensitiveAddress
  else if (not(worldReady)) WorldNotReady
  else BeginExtract
type ReadingPhase = ReadingIdle | ExtractingPage | ReviewExcerpt | SpeechApproved | DraftReleased | SpeechActive | ReadingRefused
type ReadingLease = { phase: ReadingPhase, purpose: NativePurpose, generation: int, units: int, tokenLive: bool }
type ExtractionReply = { sameGeneration: bool, stillCurrent: bool, leaseLive: bool, validPayload: bool, blocked: bool, textUnits: int }
type SpeechUse = { stillCurrent: bool, leaseLive: bool, exactToken: bool, exactBinding: bool, validRequestId: bool, busyRefusal: bool }
pure val initial: ReadingLease = { phase: ReadingIdle, purpose: PageQuestion, generation: 0, units: 0, tokenLive: false }
pure val reviewTimeoutMs = 120000
pure val speechTimeoutMs = 1200000
pure def startReading(s: ReadingLease, purpose: NativePurpose, admission: BeginReading): ReadingLease =
  { ...initial, generation: s.generation + 1, purpose: purpose, phase: if (admission == BeginExtract) ExtractingPage else ReadingRefused }
pure def canReceiveExcerpt(s: ReadingLease, extraction: ExtractionReply): bool =
  s.phase == ExtractingPage and extraction.sameGeneration
pure def receiveExcerpt(s: ReadingLease, extraction: ExtractionReply): ReadingLease =
  if (not(extraction.stillCurrent and extraction.validPayload) or extraction.blocked or extraction.textUnits <= 0 or extraction.textUnits > 5000)
    { ...s, phase: ReadingRefused }
  else if (s.purpose == DeviceReadAloud and not(extraction.leaseLive)) { ...s, phase: ReadingRefused }
  else if (s.purpose == DeviceReadAloud) { ...s, phase: SpeechApproved, units: extraction.textUnits, tokenLive: true }
  else { ...s, phase: ReviewExcerpt, units: extraction.textUnits }
pure def canApproveExcerpt(s: ReadingLease, samePage: bool, liveLease: bool): bool =
  s.phase == ReviewExcerpt and samePage and liveLease
pure def approveExcerpt(s: ReadingLease, samePage: bool, liveLease: bool): ReadingLease =
  { ...s, phase: if (s.purpose == PageQuestion) DraftReleased else SpeechApproved, tokenLive: s.purpose != PageQuestion }
pure def canConsumeReading(s: ReadingLease, use: SpeechUse): bool =
  s.phase == SpeechApproved and s.tokenLive and use.stillCurrent and use.leaseLive and use.exactToken and use.exactBinding and
  use.validRequestId and (s.purpose != PairedReadAloud or not(use.busyRefusal))
pure def consumeReading(s: ReadingLease, use: SpeechUse): ReadingLease =
  { ...s, phase: SpeechActive, generation: s.generation + 1, tokenLive: false }
pure def canRetireReading(s: ReadingLease, relevantOwner: bool): bool = s.phase != ReadingIdle and relevantOwner
pure def retireReading(s: ReadingLease, relevantOwner: bool): ReadingLease = { ...initial, generation: s.generation + 1 }
pure def alwaysReadingContentIsBounded(s: ReadingLease): bool =
  (s.phase == ReviewExcerpt or s.phase == SpeechApproved or s.phase == DraftReleased or s.phase == SpeechActive)
    implies s.units >= 1 and s.units <= 5000
pure def alwaysReviewKeepsPurpose(s: ReadingLease): bool =
  (s.phase == ReviewExcerpt implies s.purpose != DeviceReadAloud) and
  (s.phase == SpeechApproved or s.phase == SpeechActive implies s.purpose != PageQuestion)
pure def alwaysOnlyApprovalHasToken(s: ReadingLease): bool = s.tokenLive == (s.phase == SpeechApproved)
pure def stepReadingTokenCanBeSpentOnce(before: ReadingLease, via: str, after: ReadingLease): bool =
  via == "consumeReading" implies before.tokenLive and not(after.tokenLive) and before.units == after.units
pure def sometimesAskDraft(s: ReadingLease): bool = s.phase == DraftReleased
pure def sometimesDeviceSpeaking(s: ReadingLease): bool = s.phase == SpeechActive and s.purpose == DeviceReadAloud
pure def sometimesPairedApproval(s: ReadingLease): bool = s.phase == SpeechApproved and s.purpose == PairedReadAloud
pure val validExtraction: ExtractionReply = { sameGeneration: true, stillCurrent: true, leaseLive: true, validPayload: true, blocked: false, textUnits: 120 }
pure val extractionValues = Set(validExtraction, { ...validExtraction, sameGeneration: false }, { ...validExtraction, stillCurrent: false },
  { ...validExtraction, blocked: true }, { ...validExtraction, textUnits: 5001 }, { ...validExtraction, leaseLive: false })
pure val exactSpeechUse: SpeechUse = { stillCurrent: true, leaseLive: true, exactToken: true, exactBinding: true, validRequestId: true, busyRefusal: false }
pure val useValues = Set(exactSpeechUse, { ...exactSpeechUse, exactToken: false }, { ...exactSpeechUse, exactBinding: false },
  { ...exactSpeechUse, leaseLive: false }, { ...exactSpeechUse, busyRefusal: true })
pure val weight_receiveExcerpt = 5
pure val weight_approveExcerpt = 5
pure val weight_consumeReading = 5
```

Alpha's named `BrowserReadingState.qnt` scenarios and
`test/native-reading-voice-profile.test.mjs` cover the established
flow. The installed WebView, local speech engine and token consumption
have dedicated `BrowserIsolatedReadingInstrumentedTest`,
`BrowserPageQuestionInstrumentedTest`,
`BrowserReadingNavigationInstrumentedTest` and
`BrowserReadingInstrumentedTest` source fixtures.
