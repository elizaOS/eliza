# Browser page reading

Read aloud and Ask about page take one bounded excerpt of the page the
person is looking at in the tab host. On Android the excerpt comes only
from an isolated script world of the shown HTTPS main-frame document; the
page's own world is never used, so a WebView without isolated worlds
offers no page reading at all. Each reading is one lease: Ask releases the
excerpt to the person's question editor once they approve it, and speech
spends one token bound to the speech route the request named.

The shell keeps the reading world, the extraction script, the credential
classifier (password services, sign-in routes, credential prose and short
codes), the dialogs and the timers; it reports what they saw as the facts
below. The two-minute review lease and the twenty-minute playback lease
are timers the shell fires as `endReading`.

## Story: Read only the page I am looking at

> As the person, I want a page read to me or asked about only from the
> document I am looking at, so that a redirected, reloaded or replaced page
> never answers for it.

### Only an announcement from the shown HTTPS main-frame document makes the page readable

Each page start begins a new document. A history navigation whose target
stays on the ready document's HTTPS origin keeps that document's reading
ready until a new page actually starts, so a same-document Back or Forward
stays readable while a cross-document load still clears it on page start
and adopts only its prepared nonce. A start at a non-secure web
address is never readable. The one load the host prepared answers only
with its own nonce; any other start (a link, a redirect, a reload the page
began) answers only with the shared readiness message. Either needs a
main-frame message whose sender origin is the started HTTPS origin and the
one the tab shows, carrying a document id of 1 to 64 units. Once the
isolated world is unavailable it never comes back.

```quint
import address.* from "../address"
type ReadingWorld = NoIsolatedWorld | NoSecureDocument | AwaitingPreparedLoad | AwaitingDocument | DocumentReady
type Announcement = PreparedNonce | SharedReady | UnknownAnnouncement
type SenderOrigin = ShownHttpsOrigin | ForeignOrigin
type ReadyMessage = { mainFrame: bool, announcement: Announcement, sender: SenderOrigin, documentIdUnits: int }
pure val documentIdUnitsLimit = 64
pure def admitsReadiness(world: ReadingWorld, message: ReadyMessage): bool =
  message.mainFrame and message.sender == ShownHttpsOrigin and
    message.documentIdUnits >= 1 and message.documentIdUnits <= documentIdUnitsLimit and
    ((world == AwaitingPreparedLoad and message.announcement == PreparedNonce) or
     (world == AwaitingDocument and message.announcement == SharedReady))
pure def startedWorld(world: ReadingWorld, address: WebAddress, preparedLoad: bool): ReadingWorld =
  if (world == NoIsolatedWorld) NoIsolatedWorld
  else if (not(isSecureWebAddress(address))) NoSecureDocument
  else if (preparedLoad) AwaitingPreparedLoad
  else AwaitingDocument
pure val readyMessage: ReadyMessage = { mainFrame: true, announcement: SharedReady, sender: ShownHttpsOrigin, documentIdUnits: 36 }
pure val messageValues = Set(readyMessage, { ...readyMessage, announcement: PreparedNonce },
  { ...readyMessage, announcement: UnknownAnnouncement }, { ...readyMessage, mainFrame: false },
  { ...readyMessage, sender: ForeignOrigin }, { ...readyMessage, documentIdUnits: 65 })
```

### A reading is in progress only while its document stays ready in the isolated world

A page start, or the isolated world becoming unavailable, ends any reading
in progress, so an extraction, a review, a token or playback never
outlives the document it read.

```quint
type NativePurpose = AskAboutPage | ReadOnDevice | ReadThroughRoute
type ReadingRefusal = ReadingUnsupported | InvalidSpeechBinding | SensitivePage | ReadingNotReady | IsolatedWorldUnavailable | UnreadablePage
type ReadingPhase = ReadingIdle | Extracting | Reviewing | TokenIssued | Speaking | ExcerptReleased | ReadingRefused({ reason: ReadingRefusal })
type SupportProbe = SupportUnknown | SupportAsking | SupportAvailable | SupportUnavailable
type ReadingLease = { world: ReadingWorld, phase: ReadingPhase, purpose: NativePurpose, lease: int, units: int, probe: SupportProbe }
pure val initial: ReadingLease = { world: NoSecureDocument, phase: ReadingIdle, purpose: AskAboutPage, lease: 0, units: 0, probe: SupportUnknown }
pure def inProgress(phase: ReadingPhase): bool = phase == Extracting or phase == Reviewing or phase == TokenIssued or phase == Speaking
pure def endedPhase(phase: ReadingPhase): ReadingPhase = if (inProgress(phase)) ReadingIdle else phase
pure def pageStarted(s: ReadingLease, address: WebAddress, preparedLoad: bool): ReadingLease =
  { ...s, world: startedWorld(s.world, address, preparedLoad), phase: endedPhase(s.phase) }
pure def canAnnounceReady(s: ReadingLease, message: ReadyMessage): bool = admitsReadiness(s.world, message)
pure def announceReady(s: ReadingLease, message: ReadyMessage): ReadingLease = { ...s, world: DocumentReady }
pure def canIsolatedWorldLost(s: ReadingLease): bool = s.world != NoIsolatedWorld
pure def isolatedWorldLost(s: ReadingLease): ReadingLease = { ...s, world: NoIsolatedWorld, phase: endedPhase(s.phase) }
pure def stepOnlyAnnouncementMakesReady(before: ReadingLease, via: str, after: ReadingLease): bool =
  (after.world == DocumentReady and before.world != DocumentReady) implies
    (via == "announceReady" and (before.world == AwaitingPreparedLoad or before.world == AwaitingDocument))
pure def stepIsolatedWorldNeverReturns(before: ReadingLease, after: ReadingLease): bool =
  before.world == NoIsolatedWorld implies after.world == NoIsolatedWorld
pure def lawPreparedLoadNeedsItsNonce(message: ReadyMessage): bool =
  (admitsReadiness(AwaitingPreparedLoad, message) implies message.announcement == PreparedNonce) and
    (admitsReadiness(AwaitingDocument, message) implies message.announcement == SharedReady)
pure def alwaysReadingStaysOnReadyDocument(s: ReadingLease): bool = inProgress(s.phase) implies s.world == DocumentReady
pure def sometimesDocumentReady(s: ReadingLease): bool = s.world == DocumentReady
```

## Story: Let the agent read a page only once I approve

> As the person, I want the excerpt I ask about returned to my editor only
> after I approve it, and the one I ask to hear spoken once by the route I
> chose, so that nothing from the page goes anywhere I did not choose.

### A reading is admitted only for a ready, non-sensitive page and a valid speech binding

A new reading replaces the previous one, playback included. Admission
refuses, in this order: no isolated world; for speech, a binding that is
not valid; a sensitive page (not a secure web address, a password service
or a credential route); a document not yet ready. On-device speech is
bound to an owner and session of 1 to 256 units, no origin, expiring
within two minutes; speech through a route also names a bare secure
origin. Once support is confirmed unavailable, the renderer starts
nothing.

```quint
type BindingOrigin = NoOrigin | BareSecureOrigin | UnusableOrigin
type SpeechBinding = { origin: BindingOrigin, ownerUnits: int, sessionUnits: int, expiresInMs: int }
pure val bindingUnitsLimit = 256
pure val deviceBindingMs = 120000
pure def boundedUnits(units: int): bool = units >= 1 and units <= bindingUnitsLimit
pure def validBinding(purpose: NativePurpose, binding: SpeechBinding): bool =
  boundedUnits(binding.ownerUnits) and boundedUnits(binding.sessionUnits) and binding.expiresInMs > 0 and
    (if (purpose == ReadOnDevice) binding.origin == NoOrigin and binding.expiresInMs <= deviceBindingMs
     else binding.origin == BareSecureOrigin)
pure def admitReading(world: ReadingWorld, purpose: NativePurpose, binding: SpeechBinding, sensitiveRoute: bool): ReadingPhase =
  if (world == NoIsolatedWorld) ReadingRefused({ reason: ReadingUnsupported })
  else if (purpose != AskAboutPage and not(validBinding(purpose, binding))) ReadingRefused({ reason: InvalidSpeechBinding })
  else if (sensitiveRoute or world == NoSecureDocument) ReadingRefused({ reason: SensitivePage })
  else if (world != DocumentReady) ReadingRefused({ reason: ReadingNotReady })
  else Extracting
pure def canStartReading(s: ReadingLease): bool = s.probe != SupportUnavailable
pure def startReading(s: ReadingLease, purpose: NativePurpose, binding: SpeechBinding, sensitiveRoute: bool): ReadingLease =
  { ...s, phase: admitReading(s.world, purpose, binding, sensitiveRoute), purpose: purpose, lease: s.lease + 1, units: 0 }
pure def lawAdmittedReadingIsOnReadySafePage(world: ReadingWorld, purpose: NativePurpose, binding: SpeechBinding, sensitiveRoute: bool): bool =
  admitReading(world, purpose, binding, sensitiveRoute) == Extracting implies
    (world == DocumentReady and not(sensitiveRoute) and (purpose == AskAboutPage or validBinding(purpose, binding)))
pure val deviceBinding: SpeechBinding = { origin: NoOrigin, ownerUnits: 12, sessionUnits: 36, expiresInMs: 90000 }
pure val bindingValues = Set(deviceBinding, { ...deviceBinding, origin: BareSecureOrigin, expiresInMs: 600000 },
  { ...deviceBinding, expiresInMs: 120001 }, { ...deviceBinding, origin: UnusableOrigin }, { ...deviceBinding, sessionUnits: 257 })
pure def refusedWith(phase: ReadingPhase, reason: ReadingRefusal): bool = match phase { | ReadingRefused(r) => r.reason == reason | _ => false }
pure def sometimesSensitivePageRefused(s: ReadingLease): bool = refusedWith(s.phase, SensitivePage)
pure def sometimesNotReadyRefused(s: ReadingLease): bool = refusedWith(s.phase, ReadingNotReady)
pure def sometimesUnsupportedRefused(s: ReadingLease): bool = refusedWith(s.phase, ReadingUnsupported)
```

### Only a nonblank excerpt of at most 5,000 units from the current lease reaches the person

The extraction reply counts only for the lease that asked for it. A reply
the isolated world could not run refuses as an unavailable world; a page
the classifier blocks refuses as sensitive; a malformed, missing or blank
reply, or text over the limit, is unreadable. Speech on the device needs
no review, since nothing leaves the phone, and gets its token at once.

```quint
type ExtractionOutcome = ExtractedText | BlockedAsSensitive | UnreadableReply | IsolatedRunFailed
type ExtractionReply = { lease: int, outcome: ExtractionOutcome, units: int }
pure val excerptLimit = 5000
pure def excerptPhase(purpose: NativePurpose, reply: ExtractionReply): ReadingPhase =
  if (reply.outcome == IsolatedRunFailed) ReadingRefused({ reason: IsolatedWorldUnavailable })
  else if (reply.outcome == BlockedAsSensitive) ReadingRefused({ reason: SensitivePage })
  else if (reply.outcome != ExtractedText or reply.units < 1 or reply.units > excerptLimit) ReadingRefused({ reason: UnreadablePage })
  else if (purpose == ReadOnDevice) TokenIssued
  else Reviewing
pure def canReceiveExcerpt(s: ReadingLease, reply: ExtractionReply): bool = s.phase == Extracting and reply.lease == s.lease
pure def receiveExcerpt(s: ReadingLease, reply: ExtractionReply): ReadingLease =
  { ...s, phase: excerptPhase(s.purpose, reply), units: reply.units }
pure def holdsExcerpt(phase: ReadingPhase): bool = phase == Reviewing or phase == TokenIssued or phase == Speaking or phase == ExcerptReleased
pure def alwaysExcerptIsBounded(s: ReadingLease): bool = holdsExcerpt(s.phase) implies (s.units >= 1 and s.units <= excerptLimit)
pure val goodReply: ExtractionReply = { lease: 1, outcome: ExtractedText, units: 120 }
pure val replyValues = Set(goodReply, { ...goodReply, lease: 2 }, { ...goodReply, units: 5001 }, { ...goodReply, units: 0 },
  { ...goodReply, outcome: BlockedAsSensitive }, { ...goodReply, outcome: UnreadableReply }, { ...goodReply, outcome: IsolatedRunFailed })
pure val weight_receiveExcerpt = 5
pure def sometimesIsolatedRunRefused(s: ReadingLease): bool = refusedWith(s.phase, IsolatedWorldUnavailable)
```

### Ask releases its excerpt to the editor and speech spends one bound token once

Approving an Ask review releases the excerpt to the question editor; the
lease then ends. Approving a route-speech review issues the token. The
token is spent once, by the exact token and binding the reading holds,
with a nonblank request id of at most 256 units; playback uses only the
excerpt.

```quint
type SpeechUse = { exactToken: bool, exactBinding: bool, requestIdUnits: int }
pure def canApproveExcerpt(s: ReadingLease): bool = s.phase == Reviewing
pure def approveExcerpt(s: ReadingLease): ReadingLease =
  { ...s, phase: if (s.purpose == AskAboutPage) ExcerptReleased else TokenIssued }
pure def canConsumeToken(s: ReadingLease, use: SpeechUse): bool =
  s.phase == TokenIssued and use.exactToken and use.exactBinding and boundedUnits(use.requestIdUnits)
pure def consumeToken(s: ReadingLease, use: SpeechUse): ReadingLease = { ...s, phase: Speaking }
pure def alwaysPhaseKeepsPurpose(s: ReadingLease): bool =
  (s.phase == ExcerptReleased implies s.purpose == AskAboutPage) and
    (s.phase == Reviewing implies s.purpose != ReadOnDevice) and
    ((s.phase == TokenIssued or s.phase == Speaking) implies s.purpose != AskAboutPage)
pure def stepTokenIsIssuedFreshAndSpentOnce(before: ReadingLease, via: str, after: ReadingLease): bool =
  ((after.phase == TokenIssued and before.phase != TokenIssued) implies
    (via == "approveExcerpt" or (via == "receiveExcerpt" and after.purpose == ReadOnDevice))) and
  ((after.phase == Speaking and before.phase != Speaking) implies (via == "consumeToken" and before.phase == TokenIssued))
pure val exactUse: SpeechUse = { exactToken: true, exactBinding: true, requestIdUnits: 36 }
pure val useValues = Set(exactUse, { ...exactUse, exactToken: false }, { ...exactUse, exactBinding: false },
  { ...exactUse, requestIdUnits: 0 }, { ...exactUse, requestIdUnits: 257 })
pure val weight_approveExcerpt = 5
pure val weight_consumeToken = 5
pure def sometimesAskExcerptReleased(s: ReadingLease): bool = s.phase == ExcerptReleased
pure def sometimesSpeakingOnDevice(s: ReadingLease): bool = s.phase == Speaking and s.purpose == ReadOnDevice
pure def sometimesSpeakingThroughRoute(s: ReadingLease): bool = s.phase == Speaking and s.purpose == ReadThroughRoute
```

### Stop, the lease deadline or a page no longer current ends the reading

Stop reading, the review lease (two minutes from admission), the playback
lease (twenty minutes from the spent token), the host pausing or hiding
the page, and the reading tab closing or crashing each end the reading.
The shell forwards only the reading tab's events as `endReading`.

```quint
pure val reviewLeaseMs = 120000
pure val playbackLeaseMs = 1200000
pure def leaseMsFor(phase: ReadingPhase): int = if (phase == Speaking) playbackLeaseMs else reviewLeaseMs
pure def canEndReading(s: ReadingLease): bool = inProgress(s.phase)
pure def endReading(s: ReadingLease): ReadingLease = { ...s, phase: ReadingIdle }
pure def sometimesEndedAfterExcerpt(s: ReadingLease): bool = s.phase == ReadingIdle and s.lease >= 1 and s.units >= 1
```

## Story: Know before I ask whether this device can read a page privately

> As the person, I want to know whether this browser can give the agent a
> private page excerpt before I ask for one, so that I paste text myself
> when it cannot.

### One native support query is shared and only a definite answer is remembered

Parallel checks share one pending query. Only a literal true or false is
believed and then kept; a failure or any other answer leaves support
unknown, to be asked again. Unknown support still lets a request reach
admission, which has its own checks.

```quint
type SupportAnswer = LiteralTrue | LiteralFalse | NoDefiniteAnswer
pure def canAskSupport(s: ReadingLease): bool = s.probe == SupportUnknown
pure def askSupport(s: ReadingLease): ReadingLease = { ...s, probe: SupportAsking }
pure def canAnswerSupport(s: ReadingLease, supportAnswer: SupportAnswer): bool = s.probe == SupportAsking
pure def answerSupport(s: ReadingLease, supportAnswer: SupportAnswer): ReadingLease =
  { ...s, probe: if (supportAnswer == LiteralTrue) SupportAvailable else if (supportAnswer == LiteralFalse) SupportUnavailable else SupportUnknown }
pure def stepDefiniteSupportIsKept(before: ReadingLease, after: ReadingLease): bool =
  (before.probe == SupportAvailable or before.probe == SupportUnavailable) implies after.probe == before.probe
pure def sometimesSupportAvailable(s: ReadingLease): bool = s.probe == SupportAvailable
pure def sometimesSupportUnavailable(s: ReadingLease): bool = s.probe == SupportUnavailable
```

## Story: Ask about a page even when it cannot be read privately

> As the person, I want Ask about page to open an empty review I can paste
> into when the page cannot be read privately, and never to open one for a
> page holding credentials, so that I can still ask without exposing them.

### A sensitive page refuses Ask and an unavailable isolated world opens an empty review

The renderer turns the native Ask result into its review. A sensitive
page, or a released excerpt the classifier finds sensitive, is refused
and opens no review. An unavailable isolated world opens an empty review
for pasted text. A released excerpt that is blank or over the limit opens
an empty review; otherwise the excerpt opens, marked cut only on a
literal true truncation flag. Any other outcome is passed on as a failure.

```quint
type AskText = { blank: bool, sensitiveText: bool, literalTruncated: bool }
type AskReview = RefuseSensitivePage | PassOnFailure | OpenEmptyReview | OpenExcerptReview({ truncated: bool })
pure def askReviewFor(phase: ReadingPhase, units: int, askText: AskText): AskReview =
  if (refusedWith(phase, SensitivePage) or (phase == ExcerptReleased and units > 0 and askText.sensitiveText)) RefuseSensitivePage
  else if (refusedWith(phase, IsolatedWorldUnavailable)) OpenEmptyReview
  else if (phase != ExcerptReleased) PassOnFailure
  else if (askText.blank or units < 1 or units > excerptLimit) OpenEmptyReview
  else OpenExcerptReview({ truncated: askText.literalTruncated })
pure def opensExcerpt(review: AskReview): bool = match review { | OpenExcerptReview(r) => true | _ => false }
pure def opensReview(review: AskReview): bool = review == OpenEmptyReview or opensExcerpt(review)
pure def lawSensitiveAskOpensNoReview(phase: ReadingPhase, units: int, askText: AskText): bool =
  (refusedWith(phase, SensitivePage) or (phase == ExcerptReleased and units > 0 and askText.sensitiveText))
    implies not(opensReview(askReviewFor(phase, units, askText)))
pure def lawUnavailableWorldOpensEmptyReview(phase: ReadingPhase, units: int, askText: AskText): bool =
  refusedWith(phase, IsolatedWorldUnavailable) implies askReviewFor(phase, units, askText) == OpenEmptyReview
pure def lawOpenedExcerptIsUsable(phase: ReadingPhase, units: int, askText: AskText): bool =
  opensExcerpt(askReviewFor(phase, units, askText)) implies
    (phase == ExcerptReleased and units >= 1 and units <= excerptLimit and not(askText.blank) and not(askText.sensitiveText))
pure val phaseValues = Set(ExcerptReleased, ReadingIdle, ReadingRefused({ reason: SensitivePage }),
  ReadingRefused({ reason: IsolatedWorldUnavailable }), ReadingRefused({ reason: ReadingNotReady }))
pure val unitsValues = Set(0, 1, 120, 5000, 5001)
pure val plainText: AskText = { blank: false, sensitiveText: false, literalTruncated: true }
pure val askTextValues = Set(plainText, { ...plainText, literalTruncated: false }, { ...plainText, blank: true },
  { ...plainText, sensitiveText: true })
```
