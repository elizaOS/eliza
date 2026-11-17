# Hosted speech

The cloud runs a live speech session for a device: it checks the caller's
credential, prepares a consent that a session may be started from exactly
once, and keeps the session's transport funded one billing window at a time.
Stopping the session asks the provider to close, and the session is
confirmed only when every window it reserved has a settlement receipt. One
session is the state machine. The organization's daily speech quota and the
first-sentence cache key are stated as laws. The device's half of the
session is [cloud speech on the device](../os/voice/cloudSpeech.md).

## Story: Start a speech session only from a prepared consent

> As a device owner, I want a speech session started only by me, once, from
> a consent the cloud prepared for my organization while my credential was
> valid.

### A consent is prepared only under an allowed credential and minted once

The cloud checks the caller's credential; a timeout is retried once and any
other failure refuses. A consent is prepared only after the credential is
allowed, and its record and expiry alarm are written together. A session is
minted from it only while it is prepared and unexpired, and only by the same
owner, organization and nonce; it can be minted at most once, and a refused
attempt changes nothing. Until a consent is minted, no session has been
admitted from it.

```quint
type CredentialCheck = CredentialChecking | CredentialRetrying | CredentialAllowed | CredentialRefused
type CredentialResult = ResultAllowed | ResultDenied | ResultTimedOut | ResultCanceled
type ConsentPhase = ConsentAbsent | ConsentPrepared | ConsentMinted | ConsentRetired
type OpeningPhase = OpeningIdle | OpeningClaimed | OpeningOutside | OpeningSettled
type SpeechSession = {
  credential: CredentialCheck, consent: ConsentPhase, consentLive: bool, alarmArmed: bool, admissions: int,
  transportStarted: bool, transportOpen: bool, providerCloseRequested: bool, pendingWindow: int,
  recorded: Set[int], funded: Set[int], granted: Set[int], settled: Set[int], confirmed: bool, opening: OpeningPhase
}
pure val initial: SpeechSession = {
  credential: CredentialChecking, consent: ConsentAbsent, consentLive: true, alarmArmed: false, admissions: 0,
  transportStarted: false, transportOpen: false, providerCloseRequested: false, pendingWindow: -1,
  recorded: Set(), funded: Set(), granted: Set(), settled: Set(), confirmed: false, opening: OpeningIdle
}
pure def canCheckCredential(s: SpeechSession, credentialResult: CredentialResult): bool = s.credential == CredentialChecking or s.credential == CredentialRetrying
pure def checkCredential(s: SpeechSession, credentialResult: CredentialResult): SpeechSession =
  { ...s, credential: if (credentialResult == ResultAllowed) CredentialAllowed else if (credentialResult == ResultTimedOut and s.credential == CredentialChecking) CredentialRetrying else CredentialRefused }
pure def canPrepareConsent(s: SpeechSession): bool = s.consent == ConsentAbsent and s.consentLive and s.credential == CredentialAllowed
pure def prepareConsent(s: SpeechSession): SpeechSession = { ...s, consent: ConsentPrepared, alarmArmed: true }
pure def canExpireConsent(s: SpeechSession): bool = s.consentLive
pure def expireConsent(s: SpeechSession): SpeechSession = { ...s, consentLive: false, alarmArmed: false }
pure def canRetireConsent(s: SpeechSession): bool = s.consent != ConsentRetired
pure def retireConsent(s: SpeechSession): SpeechSession = { ...s, consent: ConsentRetired, alarmArmed: false }
pure def canMintSession(s: SpeechSession, ownerMatches: bool, organizationMatches: bool, nonceMatches: bool): bool =
  s.consent == ConsentPrepared and s.consentLive and ownerMatches and organizationMatches and nonceMatches
pure def mintSession(s: SpeechSession, ownerMatches: bool, organizationMatches: bool, nonceMatches: bool): SpeechSession = { ...s, consent: ConsentMinted, admissions: s.admissions + 1 }
pure def alwaysConsentMintedAtMostOnce(s: SpeechSession): bool = s.admissions >= 0 and s.admissions <= 1
pure def alwaysPreparedOnlyUnderAllowedCredential(s: SpeechSession): bool = (s.consent == ConsentPrepared or s.consent == ConsentMinted) implies s.credential == CredentialAllowed
pure def alwaysLiveConsentIsArmed(s: SpeechSession): bool = (s.consent == ConsentPrepared and s.consentLive) implies s.alarmArmed
pure def alwaysAdmissionCameFromAConsent(s: SpeechSession): bool = s.admissions > 0 implies s.credential == CredentialAllowed
pure def alwaysUnmintedConsentHasNoAdmission(s: SpeechSession): bool = (s.consent == ConsentAbsent or s.consent == ConsentPrepared) implies s.admissions == 0
pure def sometimesSessionMintedAfterRetry(s: SpeechSession): bool = s.consent == ConsentMinted and s.credential == CredentialAllowed
pure def sometimesConsentExpiresUnused(s: SpeechSession): bool = s.consent == ConsentPrepared and not(s.consentLive)
```

## Story: Keep a live session funded and close it with receipts

> As an organization paying for speech, I want each billing window funded
> before the session runs in it, and the session confirmed closed only when
> every window has been settled.

### A window is granted only after it is funded

A minted session opens its transport with its first window reserved, funded
and granted. Each further window is reserved before it is admitted, and the
session is extended into it only once it is funded; a window the funding
refuses is settled at zero and never granted. Every recorded window's
number is at least zero and below the count of recorded windows, so the
recorded windows are exactly those numbered from zero up, without gaps.
Before the transport starts it is not open, no window is pending or
settled, and nothing is confirmed.

```quint
pure def canOpenTransport(s: SpeechSession): bool = s.consent == ConsentMinted and not(s.transportStarted)
pure def openTransport(s: SpeechSession): SpeechSession = { ...s, transportStarted: true, transportOpen: true, recorded: Set(0), funded: Set(0), granted: Set(0) }
pure def canReserveWindow(s: SpeechSession): bool = s.transportOpen and s.pendingWindow == -1
pure def reserveWindow(s: SpeechSession): SpeechSession = { ...s, pendingWindow: s.recorded.size(), recorded: s.recorded.union(Set(s.recorded.size())) }
pure def canFundWindow(s: SpeechSession): bool = s.pendingWindow >= 0 and not(s.funded.contains(s.pendingWindow))
pure def fundWindow(s: SpeechSession): SpeechSession = { ...s, funded: s.funded.union(Set(s.pendingWindow)) }
pure def canExtendWindow(s: SpeechSession): bool = s.transportOpen and s.pendingWindow >= 0 and s.funded.contains(s.pendingWindow)
pure def extendWindow(s: SpeechSession): SpeechSession = { ...s, granted: s.granted.union(Set(s.pendingWindow)), pendingWindow: -1 }
pure def canRefuseWindow(s: SpeechSession): bool = s.pendingWindow >= 0 and not(s.funded.contains(s.pendingWindow))
pure def refuseWindow(s: SpeechSession): SpeechSession = { ...s, settled: s.settled.union(Set(s.pendingWindow)), pendingWindow: -1 }
pure def alwaysGrantedWindowsWereFunded(s: SpeechSession): bool = s.granted.subseteq(s.funded) and s.funded.subseteq(s.recorded)
pure def alwaysPendingWindowIsRecorded(s: SpeechSession): bool = s.pendingWindow == -1 or (s.recorded.contains(s.pendingWindow) and not(s.granted.contains(s.pendingWindow)) and not(s.settled.contains(s.pendingWindow)))
pure def alwaysRefusedWindowIsNeverGranted(s: SpeechSession): bool = s.transportOpen implies s.settled.forall(w => not(s.granted.contains(w)) and not(s.funded.contains(w)))
pure def alwaysNothingBillsBeforeTheTransport(s: SpeechSession): bool =
  not(s.transportStarted) implies (not(s.transportOpen) and s.pendingWindow == -1 and s.settled.size() == 0 and not(s.confirmed))
pure def alwaysRecordedWindowsHaveNoGaps(s: SpeechSession): bool = s.recorded.forall(w => w >= 0 and w < s.recorded.size())
pure def sometimesSessionExtended(s: SpeechSession): bool = s.granted.size() == 2
pure def sometimesWindowRefusedAtZero(s: SpeechSession): bool = s.transportOpen and s.settled.size() == 1
```

### Stopping closes the provider and confirmation needs every receipt

Stopping the session requests the provider's close at once. A renewal that
returns after the stop keeps its funded window for a zero settlement. Each
funded window settles once the transport is closed and no window is pending,
and the session is confirmed only when every recorded window has a
settlement receipt.

```quint
pure def canStopTransport(s: SpeechSession): bool = s.transportOpen
pure def stopTransport(s: SpeechSession): SpeechSession = { ...s, transportOpen: false, providerCloseRequested: true }
pure def canStoppedRenewalReturns(s: SpeechSession): bool = s.transportStarted and not(s.transportOpen) and s.pendingWindow >= 0 and s.funded.contains(s.pendingWindow)
pure def stoppedRenewalReturns(s: SpeechSession): SpeechSession = { ...s, pendingWindow: -1 }
pure def canSettleWindow(s: SpeechSession, billingWindow: int): bool = s.transportStarted and not(s.transportOpen) and s.pendingWindow == -1 and s.funded.contains(billingWindow) and not(s.settled.contains(billingWindow))
pure def settleWindow(s: SpeechSession, billingWindow: int): SpeechSession = { ...s, settled: s.settled.union(Set(billingWindow)) }
pure def canConfirmSession(s: SpeechSession): bool = s.transportStarted and not(s.transportOpen) and s.pendingWindow == -1 and s.recorded.subseteq(s.settled) and s.opening != OpeningClaimed and not(s.confirmed)
pure def confirmSession(s: SpeechSession): SpeechSession = { ...s, confirmed: true }
pure val billingWindowValues = Set(0, 1, 2)
pure def alwaysStopRequestsProviderClose(s: SpeechSession): bool = (s.transportStarted and not(s.transportOpen)) implies s.providerCloseRequested
pure def alwaysConfirmedOnlyWithEveryReceipt(s: SpeechSession): bool = s.confirmed implies (not(s.transportOpen) and s.pendingWindow == -1 and s.recorded.subseteq(s.settled))
pure def alwaysSettledWindowsWereRecorded(s: SpeechSession): bool = s.settled.subseteq(s.recorded)
pure def sometimesSessionConfirmed(s: SpeechSession): bool = s.confirmed and s.granted.size() == 2
pure val weight_reserveWindow = 3
pure val weight_fundWindow = 3
pure val weight_extendWindow = 3
pure val weight_settleWindow = 4
pure val weight_checkCredential = 5
pure val weight_prepareConsent = 5
pure val weight_mintSession = 5
pure val weight_openTransport = 5
pure val weight_stopTransport = 2
```

### No opening reaches the provider after the session stops

A session claims its opening while its transport is open. The claim is
admitted to the provider only while the transport is still open; once the
session has stopped, the claim settles without reaching the provider, and
confirmation waits for that.

```quint
pure def canClaimOpening(s: SpeechSession): bool = s.transportOpen and s.opening == OpeningIdle
pure def claimOpening(s: SpeechSession): SpeechSession = { ...s, opening: OpeningClaimed }
pure def canAdmitOpening(s: SpeechSession): bool = s.opening == OpeningClaimed and s.transportOpen
pure def admitOpening(s: SpeechSession): SpeechSession = { ...s, opening: OpeningOutside }
pure def canSettleOpening(s: SpeechSession): bool = s.opening == OpeningClaimed and not(s.transportOpen)
pure def settleOpening(s: SpeechSession): SpeechSession = { ...s, opening: OpeningSettled }
pure def stepNoAdmissionAfterStop(before: SpeechSession, after: SpeechSession): bool =
  (before.transportStarted and not(before.transportOpen) and before.opening != OpeningOutside) implies after.opening != OpeningOutside
pure def sometimesOpeningSettledByStop(s: SpeechSession): bool = s.opening == OpeningSettled and s.confirmed
```

## Story: Speak the relay protocol on a single-use socket

> As a device connecting to a minted speech session, I want one socket, one
> greeting that proves the session token, and replies I can rely on: the
> audio format once, each utterance prepared once, a flush acknowledged after
> its audio, and every refusal named and closed, so that I can tell an
> exhausted account from a bad token or an outage.

### A session is minted only from a live consent and lives at most a minute

A consent is good for five minutes after it is prepared. Asking for a
session without a prepared, unexpired, unused consent of the caller is
refused as `speech_consent_required` (403). A minted session ends sixty
seconds after minting, or when the caller's credential expires if that is
sooner.

```quint
pure val consentLifetimeSeconds = 300
pure val sessionLifetimeSeconds = 60
type MintAnswer = SessionMinted | SpeechConsentRequired
pure def mintAnswer(consentPrepared: bool, consentUnexpired: bool, consentUnused: bool): MintAnswer =
  if (consentPrepared and consentUnexpired and consentUnused) SessionMinted else SpeechConsentRequired
pure def mintStatus(answer: MintAnswer): int = if (answer == SessionMinted) 200 else 403
pure def sessionEnds(mintedAt: int, credentialExpires: bool, credentialEnds: int): int =
  if (credentialExpires and credentialEnds < mintedAt + sessionLifetimeSeconds) credentialEnds else mintedAt + sessionLifetimeSeconds
pure def lawNoSessionWithoutALiveConsent(consentPrepared: bool, consentUnexpired: bool, consentUnused: bool): bool =
  mintAnswer(consentPrepared, consentUnexpired, consentUnused) == SessionMinted iff (consentPrepared and consentUnexpired and consentUnused)
pure def lawMissingConsentIsForbidden(consentUnused: bool): bool = mintStatus(mintAnswer(false, true, consentUnused)) == 403
pure def lawSessionNeverOutlivesAMinuteOrTheCredential(mintedAt: int, credentialExpires: bool, credentialEnds: int): bool =
  sessionEnds(mintedAt, credentialExpires, credentialEnds) <= mintedAt + sessionLifetimeSeconds and
  (credentialExpires implies sessionEnds(mintedAt, credentialExpires, credentialEnds) <= credentialEnds)
pure val mintedAtValues = Set(0, 100)
pure val credentialEndsValues = Set(30, 60, 200)
```

### A session's socket opens once, and never after it ended or was revoked

The socket is asked for by session id. An unknown session is `not_found`
(404). A session whose socket was already opened, whose end has passed, or
that its owner revoked is `session_closed` (410). Only a live session never
opened before is upgraded, so a token can never serve a second socket.

```quint
type RelayConnect = { sessionKnown: bool, sessionLive: bool, alreadyOpened: bool, revoked: bool }
type RelayConnectAnswer = RelayUpgraded | RelayNotFound | RelaySessionClosed
pure def relayConnect(c: RelayConnect): RelayConnectAnswer =
  if (not(c.sessionKnown)) RelayNotFound else if (c.alreadyOpened or c.revoked or not(c.sessionLive)) RelaySessionClosed else RelayUpgraded
pure def relayConnectStatus(answer: RelayConnectAnswer): int = if (answer == RelayUpgraded) 101 else if (answer == RelayNotFound) 404 else 410
pure def lawSocketOpensOnce(c: RelayConnect): bool = (c.sessionKnown and c.alreadyOpened) implies relayConnectStatus(relayConnect(c)) == 410
pure def lawRevokedSessionNeverOpens(c: RelayConnect): bool = c.revoked implies relayConnect(c) != RelayUpgraded
pure def lawOnlyALiveFreshSessionUpgrades(c: RelayConnect): bool =
  relayConnect(c) == RelayUpgraded iff (c.sessionKnown and c.sessionLive and not(c.alreadyOpened) and not(c.revoked))
pure val cValues = Set(
  { sessionKnown: true, sessionLive: true, alreadyOpened: false, revoked: false },
  { sessionKnown: true, sessionLive: true, alreadyOpened: true, revoked: false },
  { sessionKnown: true, sessionLive: true, alreadyOpened: false, revoked: true },
  { sessionKnown: true, sessionLive: false, alreadyOpened: false, revoked: false },
  { sessionKnown: false, sessionLive: false, alreadyOpened: false, revoked: false })
```

### The first frame must be a hello with the session token, answered once with the audio format

The relay starts awaiting a hello. A hello that carries the session's
token makes it ready and is answered with exactly one `ready`, which
announces protocol version 1 and 16 kHz mono audio; the hello may ask for
refusal reasons. Anything else first is refused: audio as `unavailable`,
any other text as `unauthorized`. Every refusal sends one `error` and then
closes the socket with the policy code 1008. Once ready, a second hello or
a malformed frame is refused as `unavailable`. A closed relay answers
nothing.

```quint
pure val relayVersion = 1
pure val relaySampleRate = 16000
pure val relayChannels = 1
pure val policyCloseCode = 1008
type RelayPhase = AwaitingHello | RelayReady | RelayClosed
type RelayFrame = HelloFrame | HelloWithReasonsFrame | WrongTokenHelloFrame | MalformedFrame | AudioFrame | PrepareFrame | SpeakFrame | SpeakFlushFrame | FinishFrame | CancelFrame | StopFrame | ProviderStartOfTurn | ProviderEndOfTurn | FundingRefused
type RelayReply = ReadyReply | PreparedReply | SpeechAudioReply | FlushCompleteReply | CompleteReply | StartOfTurnEvent | EndOfTurnEvent | UnauthorizedError | UnavailableError | FundingRefusedError | PolicyClose
type RelayState = { phase: RelayPhase, prepared: List[int], reasons: bool }
type RelayAnswer = { relay: RelayState, replies: List[RelayReply] }
pure val awaitingRelay: RelayState = { phase: AwaitingHello, prepared: List(), reasons: false }
pure def refused(r: RelayState, error: RelayReply): RelayAnswer = { relay: { ...r, phase: RelayClosed }, replies: List(error, PolicyClose) }
pure def isRelayError(reply: RelayReply): bool = reply == UnauthorizedError or reply == UnavailableError or reply == FundingRefusedError
pure def preparing(r: RelayState, utterance: int): List[RelayReply] = if (r.prepared.includes(utterance)) List() else List(PreparedReply)
pure def withPrepared(r: RelayState, utterance: int): RelayState = if (r.prepared.includes(utterance)) r else { ...r, prepared: r.prepared.append(utterance) }
pure def relayStep(r: RelayState, frame: RelayFrame, utterance: int): RelayAnswer =
  if (r.phase == RelayClosed) { relay: r, replies: List() }
  else if (r.phase == AwaitingHello)
    (if (frame == HelloFrame or frame == HelloWithReasonsFrame) { relay: { ...r, phase: RelayReady, reasons: frame == HelloWithReasonsFrame }, replies: List(ReadyReply) }
     else if (frame == AudioFrame) refused(r, UnavailableError)
     else refused(r, UnauthorizedError))
  else if (frame == HelloFrame or frame == HelloWithReasonsFrame or frame == WrongTokenHelloFrame or frame == MalformedFrame) refused(r, UnavailableError)
  else if (frame == FundingRefused) refused(r, if (r.reasons) FundingRefusedError else UnavailableError)
  else if (frame == StopFrame) { relay: { ...r, phase: RelayClosed }, replies: List() }
  else if (frame == ProviderStartOfTurn) { relay: r, replies: List(StartOfTurnEvent) }
  else if (frame == ProviderEndOfTurn) { relay: r, replies: List(EndOfTurnEvent) }
  else if (frame == PrepareFrame) { relay: withPrepared(r, utterance), replies: preparing(r, utterance) }
  else if (frame == SpeakFrame) { relay: withPrepared(r, utterance), replies: preparing(r, utterance).concat(List(SpeechAudioReply)) }
  else if (frame == SpeakFlushFrame) { relay: withPrepared(r, utterance), replies: preparing(r, utterance).concat(List(SpeechAudioReply, FlushCompleteReply)) }
  else if (frame == FinishFrame or frame == CancelFrame) { relay: r, replies: List(CompleteReply) }
  else { relay: r, replies: List() }
pure val rValues = Set(awaitingRelay, { phase: RelayReady, prepared: List(), reasons: false }, { phase: RelayReady, prepared: List(1), reasons: true }, { phase: RelayClosed, prepared: List(1), reasons: false })
pure val utteranceValues = Set(1, 2)
pure def lawOnlyAHelloWithTheTokenOpensTheRelay(r: RelayState, frame: RelayFrame, utterance: int): bool =
  (r.phase == AwaitingHello and relayStep(r, frame, utterance).relay.phase == RelayReady) implies
    ((frame == HelloFrame or frame == HelloWithReasonsFrame) and relayStep(r, frame, utterance).replies == List(ReadyReply))
pure def lawNothingIsSpokenBeforeTheHello(r: RelayState, frame: RelayFrame, utterance: int): bool =
  r.phase == AwaitingHello implies relayStep(r, frame, utterance).replies.every(x => x == ReadyReply or x == UnauthorizedError or x == UnavailableError or x == PolicyClose)
pure def lawEveryRefusalIsOneErrorThenAPolicyClose(r: RelayState, frame: RelayFrame, utterance: int): bool =
  relayStep(r, frame, utterance).replies.some(x => isRelayError(x)) implies
    (relayStep(r, frame, utterance).relay.phase == RelayClosed and relayStep(r, frame, utterance).replies.length() == 2 and relayStep(r, frame, utterance).replies.nthOr(1, ReadyReply) == PolicyClose)
pure def lawAClosedRelayAnswersNothing(r: RelayState, frame: RelayFrame, utterance: int): bool =
  r.phase == RelayClosed implies relayStep(r, frame, utterance) == { relay: r, replies: List() }
```

### Each utterance is prepared once, a flush is acknowledged after its audio, and finishing is acknowledged

While ready, `prepare` or the first `tts` of an utterance is answered with
one `tts_prepared` for it, and never again for the same utterance. Each
`tts` frame is answered with its audio; one asking to flush is then
answered with `flush_complete`, after that audio. `finish` and `cancel` are
answered with `complete`. The provider's start-of-turn and end-of-turn
edges are passed on as `stt` events, only while ready. `stop` closes the
socket without an error.

```quint
pure def lawAnUtteranceIsPreparedOnce(r: RelayState, frame: RelayFrame, utterance: int): bool =
  r.prepared.includes(utterance) implies not(relayStep(r, frame, utterance).replies.includes(PreparedReply))
pure def lawFlushIsAcknowledgedAfterItsAudio(r: RelayState, utterance: int): bool = {
  val replies = relayStep(r, SpeakFlushFrame, utterance).replies
  r.phase == RelayReady implies (replies.length() >= 2 and replies.nthOr(replies.length() - 2, ReadyReply) == SpeechAudioReply and replies.nthOr(replies.length() - 1, ReadyReply) == FlushCompleteReply)
}
pure def lawFinishAndCancelAreAcknowledged(r: RelayState, utterance: int): bool =
  r.phase == RelayReady implies (relayStep(r, FinishFrame, utterance).replies == List(CompleteReply) and relayStep(r, CancelFrame, utterance).replies == List(CompleteReply))
pure def lawTurnEdgesOnlyWhileReady(r: RelayState, frame: RelayFrame, utterance: int): bool =
  (relayStep(r, frame, utterance).replies.includes(StartOfTurnEvent) or relayStep(r, frame, utterance).replies.includes(EndOfTurnEvent)) implies r.phase == RelayReady
pure def lawStopClosesWithoutAnError(r: RelayState, utterance: int): bool =
  r.phase == RelayReady implies relayStep(r, StopFrame, utterance) == { relay: { ...r, phase: RelayClosed }, replies: List() }
```

### Exhausted funding is reported as its own reason, never as a bad token

When the organization's credit or speech allowance refuses the next
billing window, the relay closes. A device whose hello asked for reasons is
told the funding was refused (`insufficient_credits`); otherwise it is told
`unavailable`. Exhausted funding is never reported as `unauthorized`.

```quint
pure def lawFundingRefusalIsNeverUnauthorized(r: RelayState, utterance: int): bool =
  r.phase == RelayReady implies not(relayStep(r, FundingRefused, utterance).replies.includes(UnauthorizedError))
pure def lawAskedReasonsNameTheFunding(r: RelayState, utterance: int): bool =
  (r.phase == RelayReady and r.reasons) implies relayStep(r, FundingRefused, utterance).replies == List(FundingRefusedError, PolicyClose)
```

## Story: Hold an organization to its daily speech quota

> As an organization, I want speech held within the organization's and each
> user's daily allowance, and released time to come back, but never below
> zero.

### A reservation fits both the organization's and the user's allowance

The day's usage is kept per organization and per user, each with its own
allowance. A reservation is granted only if both the organization's total
and the user's stay within their allowances; otherwise it is refused as over
the organization's or the user's limit, the organization's checked first,
and nothing changes. A release returns units without going below zero.

```quint
type QuotaDecision = QuotaReserved | OrganizationLimit | UserLimit
type QuotaUsage = { organizationUnits: int, organizationAllowance: int, userUnits: int, userAllowance: int }
pure def quotaDecision(usage: QuotaUsage, amount: int): QuotaDecision =
  if (usage.organizationUnits + amount > usage.organizationAllowance) OrganizationLimit else if (usage.userUnits + amount > usage.userAllowance) UserLimit else QuotaReserved
pure def releaseUnits(units: int, amount: int): int = if (units < amount) 0 else units - amount
pure def lawReservationFitsBothAllowances(usage: QuotaUsage, amount: int): bool =
  quotaDecision(usage, amount) == QuotaReserved implies (usage.organizationUnits + amount <= usage.organizationAllowance and usage.userUnits + amount <= usage.userAllowance)
pure def lawOverTheOrganizationIsReportedFirst(usage: QuotaUsage, amount: int): bool =
  usage.organizationUnits + amount > usage.organizationAllowance implies quotaDecision(usage, amount) == OrganizationLimit
pure def lawReleaseNeverGoesNegative(units: int, amount: int): bool = (units >= 0 and amount >= 0) implies releaseUnits(units, amount) >= 0
pure val usageValues = Set(
  { organizationUnits: 0, organizationAllowance: 3, userUnits: 0, userAllowance: 2 },
  { organizationUnits: 2, organizationAllowance: 3, userUnits: 0, userAllowance: 2 },
  { organizationUnits: 1, organizationAllowance: 3, userUnits: 2, userAllowance: 2 },
  { organizationUnits: 3, organizationAllowance: 3, userUnits: 2, userAllowance: 2 })
pure val amountValues = Set(1, 2)
```

## Story: Share cached first sentences between device and cloud

> As a user, I want a common first sentence spoken at once from a cache the
> device and the cloud agree on.

### Only a short terminated first sentence is cached, under a versioned key

The first sentence is cacheable only when it ends in a terminator or a line
break and has at most ten words. Its cache key carries the snip version, so
changing the snip rules starts a new cache rather than reusing old entries.

```quint
pure val snipVersion = 1
pure val maxSnipWords = 10
type SnipKey = { version: int, sentence: str }
pure def snipCacheable(terminated: bool, words: int): bool = terminated and words >= 1 and words <= maxSnipWords
pure def snipKey(version: int, sentence: str): SnipKey = { version: version, sentence: sentence }
pure def lawUnterminatedTextIsNotCached(words: int): bool = not(snipCacheable(false, words))
pure def lawLongSentenceIsNotCached(terminated: bool, words: int): bool = words > maxSnipWords implies not(snipCacheable(terminated, words))
pure def lawVersionSeparatesKeys(version: int, sentence: str): bool = snipKey(version, sentence) != snipKey(version + 1, sentence)
pure val wordsValues = Set(0, 1, 10, 11)
```
