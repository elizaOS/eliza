# Speech session

One consented realtime speech session, from the consent a person gives to
the last receipt of its last window. The wire on its one socket is
[the relay protocol](./speechRelay.md); each window's money is two holds of
[metering](../shared/metering.md); the daily realtime allowance is
[the plan catalog's](../billing/plans.md). The device side is
`spec/os/voice/cloudSpeech.md`.

The routes are `POST /api/v1/voice/speech/consent`, `POST
/api/v1/voice/speech/session`, `GET /api/v1/voice/speech/ws?sessionId=`
and `POST /api/v1/voice/speech/session/:id/revoke`. JSON, the token, its
digest, the socket, the provider calls and the database stay in
`packages/cloud-worker/src/services/speech-session.vibe`. One session is one row of
`speech_sessions`; the shell loads it, steps it with the generated adapter
and writes it back by compare-and-set, in the same transaction as the
window's holds and the day's usage.

The consent and mint routes time their phases, by name and duration only,
never by account or content: `speech_identity_rate` (request
authentication and the plan's rate limit, until the route begins),
`speech_consent_write` (a consent's insert) and, for a mint,
`speech_consent_consume` (the one transaction that consumes the consent and
records the session). In production each phase is logged as it ends,
`cloud_speech_phase_v1` with the route, the request id, the duration and
whether the phase returned or threw; in staging an answer carries its
phases in `Server-Timing` instead.

## Story: Start speech only from a consent I gave

> As a person, I want a speech session to start only from a fresh consent I
> gave with my own credential, once, so that nobody can start listening for
> me by sending a session request alone.

### Consent, mint and revoke admit a live device key or session of an active account

The socket itself authenticates only by the token in its hello.

```quint
import types.* from "../shared/types"
import plans.* from "../billing/plans"
import metering as M from "../shared/metering"
import requestAuth as Ra from "../identity/requestAuth"
import speechRelay as Rl from "./speechRelay"
pure val speechRouteClass: Ra::RouteClass = Ra::KeyOrSessionRoute
```

### A consent lasts five minutes and belongs to the account and credential that asked for it

The answer is `{consentNonce, expiresAt}`: a fresh UUID and an ISO time.
The nonce names this session's row; only the credential that asked can
spend it.

```quint
pure val consentLifetime: Millis = 5 * millisPerMinute
pure val sessionLifetime: Millis = millisPerMinute
type RetireCause = DeviceStopped | OwnerRevoked | CredentialWithdrawn | AccountDeleting | RelayFailed | DeadlinePassed | FundingEnded({ funding: Rl::Shortfall })
type SessionPhase = AwaitingConsent | Consented | Minted | Starting | Active | Retiring({ cause: RetireCause }) | Closed({ cause: RetireCause })
type Renewal = RenewalOpen | RenewalRefused({ funding: Rl::Shortfall })
type Session = { phase: SessionPhase, account: str, credential: str, consentExpiresAt: Millis, tokenDigest: str, credentialExpiresAt: Millis,
  expiresAt: Millis, extend: bool, renewal: Renewal, windows: int, sttSettled: Set[int], ttsSettled: Set[int] }
pure val initial: Session = { phase: AwaitingConsent, account: "", credential: "", consentExpiresAt: 0, tokenDigest: "", credentialExpiresAt: 0,
  expiresAt: 0, extend: false, renewal: RenewalOpen, windows: 0, sttSettled: Set(), ttsSettled: Set() }
pure def canConsent(s: Session, account: str, credential: str, now: Millis): bool = s.phase == AwaitingConsent and account != "" and credential != "" and now >= 0
pure def consent(s: Session, account: str, credential: str, now: Millis): Session =
  { ...s, phase: Consented, account: account, credential: credential, consentExpiresAt: now + consentLifetime }
pure def sometimesConsented(s: Session): bool = s.phase == Consented
pure val accountValues = Set("a1", "a2")
pure val credentialValues = Set("k1", "k2")
pure val nowValues = Set(0, 50000, 55000, 60000, 110000, 170000, 400000)
```

### A session is minted once, only by the credential that consented, before the consent expires, and only while the day's speech is left

Minting spends the consent and answers `{version: 1, sessionId, token,
expiresAt, wsUrl}` with the header `X-Eliza-Speech-Extend: 1`. The token is
32 random bytes as 43 unpadded base64url characters with no prefix, which
devices check before they open the socket, and only its digest is kept;
`wsUrl` is `wss://<api host>/api/v1/voice/speech/ws?sessionId=<id>`. The
deadline is one minute away, or the credential's expiry (the `expiresAt` of
`requestAuth`'s `Caller`) if that is sooner. A missing, foreign, spent or
expired consent is `403 speech_consent_required`; a day with too little
realtime speech left for the first window is `402 allowance_exhausted`
with `resetsAt`, and the consent stays unspent.

```quint
type Verdict = Granted | Declined({ refusal: Refusal })
pure def firstDeadline(now: Millis, credentialExpiresAt: Millis): Millis = M::minOf(now + sessionLifetime, credentialExpiresAt)
pure def consentHolds(s: Session, account: str, credential: str, now: Millis): bool =
  s.phase == Consented and account == s.account and credential == s.credential and now < s.consentExpiresAt
pure def mintDecision(consentValid: bool, now: Millis, credentialExpiresAt: Millis, speechUsed: Millis): Verdict =
  if (not(consentValid)) Declined({ refusal: refuse(SpeechConsentRequired) })
  else if (not(realtimeSpeechAdmits(speechUsed, firstDeadline(now, credentialExpiresAt) - now))) Declined({ refusal: refuseAllowance(realtimeSpeechResetsAt(now)) })
  else Granted
pure def mintVerdict(s: Session, account: str, credential: str, now: Millis, credentialExpiresAt: Millis, speechUsed: Millis): Verdict =
  mintDecision(consentHolds(s, account, credential, now), now, credentialExpiresAt, speechUsed)
pure def canMint(s: Session, account: str, credential: str, tokenDigest: str, now: Millis, credentialExpiresAt: Millis, speechUsed: Millis): bool =
  tokenDigest != "" and credentialExpiresAt > now and mintVerdict(s, account, credential, now, credentialExpiresAt, speechUsed) == Granted
pure def mint(s: Session, account: str, credential: str, tokenDigest: str, now: Millis, credentialExpiresAt: Millis, speechUsed: Millis): Session =
  { ...s, phase: Minted, tokenDigest: tokenDigest, credentialExpiresAt: credentialExpiresAt, expiresAt: firstDeadline(now, credentialExpiresAt) }
pure def lawEveryMintRefusalIsConsentOrAllowance(consentValid: bool, now: Millis, credentialExpiresAt: Millis, speechUsed: Millis): bool = {
  val v = mintDecision(consentValid, now, credentialExpiresAt, speechUsed)
  match v {
    | Declined(d) => wellFormed(d.refusal) and (if (consentValid) d.refusal.code == AllowanceExhausted else d.refusal.code == SpeechConsentRequired)
    | Granted => consentValid
  }
}
pure def stepTheConsentIsSpentOnlyByMinting(before: Session, via: str, after: Session): bool =
  (before.phase == Consented and after.phase != Consented) implies via == "mint"
pure def sometimesMinted(s: Session): bool = s.phase == Minted
pure val tokenDigestValues = Set("d1")
pure val credentialExpiresAtValues = Set(100000, 86400000)
pure val weight_mint = 3
```

### A minted session accepts one socket before its deadline, and every other upgrade is session_closed

Accepting the socket moves the session to `Starting` durably before the
relay reads its hello; a second upgrade, or one past the deadline, is
`410 session_closed`. The relay must still see the token's hello within
`Rl::helloDeadline` before any window is admitted.

```quint
pure def canOpenSocket(s: Session, now: Millis): bool = s.phase == Minted and now < s.expiresAt
pure def openSocket(s: Session, now: Millis): Session = { ...s, phase: Starting }
pure def socketVerdict(s: Session, now: Millis): Verdict = if (canOpenSocket(s, now)) Granted else Declined({ refusal: refuse(SessionClosed) })
pure def stepOnlyOneSocketIsAccepted(before: Session, via: str, after: Session): bool =
  (after.phase == Starting and before.phase != Starting) implies (via == "openSocket" and before.phase == Minted)
pure def sometimesSocketAccepted(s: Session): bool = s.phase == Starting
```

### Only a consent becomes a session, and a session keeps its owner, its token and its credential's expiry

```quint
pure def isRetiring(p: SessionPhase): bool = match p { | Retiring(r) => true | _ => false }
pure def isClosed(p: SessionPhase): bool = match p { | Closed(r) => true | _ => false }
pure def isOver(p: SessionPhase): bool = isRetiring(p) or isClosed(p)
pure def causeOf(p: SessionPhase): RetireCause = match p { | Retiring(r) => r.cause | Closed(r) => r.cause | _ => RelayFailed }
pure def alwaysASessionComesFromItsConsent(s: Session): bool =
  (s.phase == AwaitingConsent implies (s.account == "" and s.credential == "" and not(s.extend)))
  and (s.phase != AwaitingConsent implies (s.account != "" and s.credential != ""))
  and ((s.phase == AwaitingConsent or s.phase == Consented) iff s.tokenDigest == "")
  and (s.tokenDigest != "" implies s.expiresAt <= s.credentialExpiresAt)
pure def stepIdentityNeverChanges(before: Session, after: Session): bool =
  (before.account != "" implies (after.account == before.account and after.credential == before.credential))
  and (before.tokenDigest != "" implies (after.tokenDigest == before.tokenDigest and after.credentialExpiresAt == before.credentialExpiresAt))
```

## Story: Keep a live session funded and close it with receipts

> As a person paying for speech, I want each minute of a live session paid
> for before it runs and counted once against my day, and the session
> closed only when every minute has its receipt, so that a retry never
> charges twice and nothing runs after I stop it.

### A window lasts a minute and carries at most 60 s of audio in, 4096 characters and 8 MiB of audio out

A window holds `{speech, organization, sessionId, stt:n}` and `{…, tts:n}`,
numbered from 1; each quote is the window's maximum at the provider's price.
A window over its budget is a protocol end of the relay. Its day usage is
written once per window key, so a retried admission counts nothing again.

```quint
pure val windowLength: Millis = millisPerMinute
pure val windowSttBytes = 60 * 32000
pure val windowTtsChars: CharCount = 4096
pure val windowOutputBytes = 8 * 1024 * 1024
pure val maxWindows = 10
pure def sttMillis(pcmBytes: int): Millis = pcmBytes / 32
pure def withinWindowBudget(pcmBytes: int, ttsChars: CharCount, outputBytes: int): bool =
  pcmBytes >= 0 and pcmBytes <= windowSttBytes and ttsChars >= 0 and ttsChars <= windowTtsChars and outputBytes >= 0 and outputBytes <= windowOutputBytes
pure def holdKeyOf(organization: str, sessionId: str, window: int, direction: SpeechDirection): HoldKey =
  { service: MeteredSpeech, caller: organization, requestId: sessionId, part: SpeechWindow({ direction: direction, window: window }) }
pure def lawEachWindowAndDirectionHasItsOwnHold(organization: str, sessionId: str, window: int, other: int, direction: SpeechDirection, otherDirection: SpeechDirection): bool =
  holdKeyOf(organization, sessionId, window, direction) == holdKeyOf(organization, sessionId, other, otherDirection) implies (window == other and direction == otherDirection)
pure def lawAudioWithinBudgetFitsTheWindow(pcmBytes: int): bool = withinWindowBudget(pcmBytes, 0, 0) implies sttMillis(pcmBytes) <= windowLength
pure val otherValues = Set(1, 2)
pure val pcmBytesValues = Set(0, 1920000, 1920032)
```

### A window is admitted only when the day has room for it and both its holds are funded

The day is checked first: no room is `allowance_exhausted`, an unfunded
hold is `insufficient_credits`. Window 1 is admitted after the hello; its
refusal ends the session before audio. Later windows renew 10 s or less
before the deadline, only for a hello with `extend` and at most 10 in all;
the relay then sends `extended`. A refused renewal keeps the session to
its old deadline.

```quint
type Funding = Funded | ShortOf({ funding: Rl::Shortfall })
pure val renewalLead: Millis = 10 * millisPerSecond
pure def fundingOf(speechUsed: Millis, span: Millis, holdsFunded: bool): Funding =
  if (not(realtimeSpeechAdmits(speechUsed, span))) ShortOf({ funding: Rl::AllowanceShort })
  else if (not(holdsFunded)) ShortOf({ funding: Rl::CreditsShort }) else Funded
pure def shortfallOf(f: Funding): Rl::Shortfall = match f { | ShortOf(x) => x.funding | _ => Rl::CreditsShort }
pure def canAdmitFirstWindow(s: Session, now: Millis, extend: bool, speechUsed: Millis, holdsFunded: bool): bool =
  s.phase == Starting and now < s.expiresAt and fundingOf(speechUsed, s.expiresAt - now, holdsFunded) == Funded
pure def admitFirstWindow(s: Session, now: Millis, extend: bool, speechUsed: Millis, holdsFunded: bool): Session = { ...s, phase: Active, extend: extend, windows: 1 }
pure def canRefuseFirstWindow(s: Session, now: Millis, speechUsed: Millis, holdsFunded: bool): bool =
  s.phase == Starting and now < s.expiresAt and fundingOf(speechUsed, s.expiresAt - now, holdsFunded) != Funded
pure def refuseFirstWindow(s: Session, now: Millis, speechUsed: Millis, holdsFunded: bool): Session =
  { ...s, phase: Retiring({ cause: FundingEnded({ funding: shortfallOf(fundingOf(speechUsed, s.expiresAt - now, holdsFunded)) }) }) }
pure def nextDeadline(s: Session): Millis = M::minOf(s.expiresAt + windowLength, s.credentialExpiresAt)
pure def renewalDue(s: Session, now: Millis): bool =
  s.phase == Active and s.extend and s.renewal == RenewalOpen and s.windows < maxWindows
  and now >= s.expiresAt - renewalLead and now < s.expiresAt and nextDeadline(s) > s.expiresAt
pure def canRenew(s: Session, now: Millis, speechUsed: Millis, holdsFunded: bool): bool =
  renewalDue(s, now) and fundingOf(speechUsed, nextDeadline(s) - s.expiresAt, holdsFunded) == Funded
pure def renew(s: Session, now: Millis, speechUsed: Millis, holdsFunded: bool): Session = { ...s, expiresAt: nextDeadline(s), windows: s.windows + 1 }
pure def canRefuseRenewal(s: Session, now: Millis, speechUsed: Millis, holdsFunded: bool): bool =
  renewalDue(s, now) and fundingOf(speechUsed, nextDeadline(s) - s.expiresAt, holdsFunded) != Funded
pure def refuseRenewal(s: Session, now: Millis, speechUsed: Millis, holdsFunded: bool): Session =
  { ...s, renewal: RenewalRefused({ funding: shortfallOf(fundingOf(speechUsed, nextDeadline(s) - s.expiresAt, holdsFunded)) }) }
pure def lawAShortWindowIsNeverFunded(speechUsed: Millis, span: Millis): bool =
  fundingOf(speechUsed, span, false) != Funded and fundingOf(realtimeSpeechPerDay, span, true) == ShortOf({ funding: Rl::AllowanceShort })
pure def alwaysWindowsFollowThePhase(s: Session): bool =
  s.windows >= 0 and s.windows <= maxWindows
  and ((s.phase == AwaitingConsent or s.phase == Consented or s.phase == Minted or s.phase == Starting) implies s.windows == 0)
  and (s.phase == Active implies s.windows >= 1)
  and (s.windows >= 2 implies s.extend)
pure def stepWindowsAreAdmittedOneAtATime(before: Session, via: str, after: Session): bool =
  after.windows != before.windows implies (after.windows == before.windows + 1 and (via == "admitFirstWindow" or via == "renew"))
pure def sometimesActive(s: Session): bool = s.phase == Active
pure def sometimesExtended(s: Session): bool = s.windows >= 2
pure def sometimesRenewalRefused(s: Session): bool = s.phase == Active and s.renewal != RenewalOpen
pure def fundingEnded(c: RetireCause): bool = match c { | FundingEnded(f) => true | _ => false }
pure def sometimesFirstWindowRefused(s: Session): bool = isRetiring(s.phase) and s.windows == 0 and fundingEnded(causeOf(s.phase))
pure val spanValues = Set(1, 60000)
pure val weight_admitFirstWindow = 4
pure val weight_renew = 4
```

### A stop, a revocation, a withdrawn credential, a deleting account, a failed relay or a passed deadline retires the session, and the relay hears each as its own end

The device's `stop` ends a live session. The owner's revoke route, a
revoked credential or an account entering `Deleting` ends any minted
session. A relay that ended on its own (no hello in time, a wrong token, a
protocol break, a provider outage) retires an opened one. At the deadline
a session retires as `FundingEnded` if its renewal was refused, else as
`DeadlinePassed`. Retiring refuses new windows; the relay is told the end
through `relayInputsOf`, so funding is never `unauthorized`.

```quint
pure def isLive(p: SessionPhase): bool = p == Minted or p == Starting or p == Active
pure def canRetire(s: Session, cause: RetireCause): bool =
  if (cause == DeviceStopped) s.phase == Active
  else if (cause == RelayFailed) (s.phase == Starting or s.phase == Active)
  else if (cause == CredentialWithdrawn or cause == AccountDeleting) isLive(s.phase)
  else false
pure def retire(s: Session, cause: RetireCause): Session = { ...s, phase: Retiring({ cause: cause }) }
pure def canRevoke(s: Session, account: str): bool = isLive(s.phase) and account == s.account
pure def revoke(s: Session, account: str): Session = { ...s, phase: Retiring({ cause: OwnerRevoked }) }
pure def expiryCause(r: Renewal): RetireCause = match r { | RenewalRefused(x) => FundingEnded({ funding: x.funding }) | _ => DeadlinePassed }
pure def canExpire(s: Session, now: Millis): bool = isLive(s.phase) and now >= s.expiresAt
pure def expire(s: Session, now: Millis): Session = { ...s, phase: Retiring({ cause: expiryCause(s.renewal) }) }
pure def relayInputsOf(cause: RetireCause): List[Rl::RelayInput] = match cause {
  | FundingEnded(f) => List(Rl::FundingRefused({ funding: f.funding }))
  | CredentialWithdrawn => List(Rl::CredentialRefused)
  | DeviceStopped => List()
  | RelayFailed => List()
  | _ => List(Rl::SessionOver)
}
pure def lawOnlyARevokedCredentialEndsTheRelayAsUnauthorized(cause: RetireCause): bool =
  relayInputsOf(cause).includes(Rl::CredentialRefused) iff cause == CredentialWithdrawn
pure def stepRetirementIsFinal(before: Session, after: Session): bool =
  isOver(before.phase) implies (isOver(after.phase) and after.windows == before.windows and after.renewal == before.renewal)
pure val causeValues = Set(DeviceStopped, OwnerRevoked, CredentialWithdrawn, AccountDeleting, RelayFailed, DeadlinePassed, FundingEnded({ funding: Rl::CreditsShort }), FundingEnded({ funding: Rl::AllowanceShort }))
pure def sometimesRevokedByOwner(s: Session): bool = s.phase == Retiring({ cause: OwnerRevoked })
pure def sometimesEndedAtTheOldDeadlineAfterARefusal(s: Session): bool = isRetiring(s.phase) and s.windows >= 1 and fundingEnded(causeOf(s.phase))
```

### Each window settles each direction once, an earlier window while the next one serves and the live one while retiring, and a session closes only with every receipt

Each hold is settled by metering: never dispatched, `M::release` (0);
transcription dispatched without a graceful drain, `M::settleUnknown` (the
quote); otherwise `M::settleKnown` with PCM bytes / 32000 seconds or the
TTS `CharCount` submitted. Recording a receipt here follows that settle in
the same transaction.

A window that a renewal replaced settles while the session is active, once
its own end passes and the next window serves: its audio and text are final
then, so it is charged as measured, and a renewal needs credit for the live
window and the next one, not for every window so far. The live window
settles only while retiring, and it alone carries the quote for a
transcription that did not drain.

```quint
type Settlement = ReleaseHold | ChargeQuote | ChargeMeasured
pure def settlementOf(direction: SpeechDirection, dispatched: bool, drained: bool): Settlement =
  if (not(dispatched)) ReleaseHold else if (direction == Transcribe and not(drained)) ChargeQuote else ChargeMeasured
pure def endedWindowSettlement(dispatched: bool): Settlement = if (dispatched) ChargeMeasured else ReleaseHold
pure def lawAnEndedWindowIsNeverChargedItsQuote(dispatched: bool): bool = endedWindowSettlement(dispatched) != ChargeQuote
pure def settledIn(s: Session, direction: SpeechDirection): Set[int] = if (direction == Transcribe) s.sttSettled else s.ttsSettled
pure def canRecordReceipt(s: Session, window: int, direction: SpeechDirection): bool =
  (isRetiring(s.phase) or (s.phase == Active and window < s.windows))
  and window >= 1 and window <= s.windows and not(settledIn(s, direction).contains(window))
pure def recordReceipt(s: Session, window: int, direction: SpeechDirection): Session =
  if (direction == Transcribe) { ...s, sttSettled: s.sttSettled.union(Set(window)) } else { ...s, ttsSettled: s.ttsSettled.union(Set(window)) }
pure def allSettled(s: Session): bool = s.sttSettled.size() == s.windows and s.ttsSettled.size() == s.windows
pure def canClose(s: Session): bool = isRetiring(s.phase) and allSettled(s)
pure def close(s: Session): Session = { ...s, phase: Closed({ cause: causeOf(s.phase) }) }
pure def alwaysReceiptsComeOnlyFromEndedWindows(s: Session): bool =
  s.sttSettled.forall(w => w >= 1 and w <= s.windows) and s.ttsSettled.forall(w => w >= 1 and w <= s.windows)
  and (not(isOver(s.phase)) implies (s.sttSettled.forall(w => w < s.windows) and s.ttsSettled.forall(w => w < s.windows)))
  and (isClosed(s.phase) implies allSettled(s))
pure def stepReceiptsAndCauseNeverChange(before: Session, after: Session): bool =
  before.sttSettled.subseteq(after.sttSettled) and before.ttsSettled.subseteq(after.ttsSettled)
  and (isOver(before.phase) implies causeOf(after.phase) == causeOf(before.phase))
pure def sometimesEarlierWindowSettledWhileActive(s: Session): bool = s.phase == Active and s.sttSettled.size() >= 1
pure def sometimesRetiringWithAnOpenReceipt(s: Session): bool = isRetiring(s.phase) and s.windows >= 1 and not(allSettled(s))
pure def sometimesClosedAfterTwoWindows(s: Session): bool = isClosed(s.phase) and s.windows >= 2
pure def sometimesClosedByTheDevice(s: Session): bool = s.phase == Closed({ cause: DeviceStopped })
pure val windowValues = Set(1, 2, 3)
pure val weight_recordReceipt = 6
pure val weight_close = 3
```
