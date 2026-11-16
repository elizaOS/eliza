# Cloud speech lease

The client half of a paid [cloud speech](./cloudSpeech.md) session, at the
boundary between the renderer, the native host and the speech relay. The
person consents, the host mints one paid window, and once the bridge is
ready further windows are reserved and granted one at a time. The host and
the client each acknowledge windows in order. The client never assumes an
acknowledgement arrives: the host keeps its own deadline. Settlement of
what was paid is the server's ([cloud speech](../../cloud/speech.md)).

## Story: Pay for cloud speech only with consent, and only for windows used

> As a person using paid cloud speech, I want it to start only after I
> agree, to stop at once when I stop it, and every window I was charged for
> to be settled.

### Consent is asked at most twice and expires after 30 seconds

The consent request may be reset once; a second reset closes the session.
Consent must arrive within 30 seconds of the request, and a request still
unanswered at 30 seconds closes. Nothing is paid or allocated before
consent, nor between consent and minting.

```quint
type LeasePhase = AwaitingConsent | ConsentAdmitted | AwaitingMint | LeaseMinted | LeaseLive | LeaseClosed
type CloudLease = { phase: LeasePhase, elapsed: int, ownerCurrent: bool, requests: int, negotiated: bool,
  paid: int, host: int, client: int, pending: int, allocated: Set[int], sttSettled: Set[int], ttsSettled: Set[int],
  capture: bool, retired: bool }
pure val initial: CloudLease = { phase: AwaitingConsent, elapsed: 0, ownerCurrent: true, requests: 1, negotiated: false,
  paid: 0, host: 0, client: 0, pending: 0, allocated: Set(), sttSettled: Set(), ttsSettled: Set(),
  capture: false, retired: false }
pure val consentDeadlineSeconds = 30
pure def canObserveConsentClock(l: CloudLease, seconds: int): bool = seconds >= l.elapsed
pure def observeConsentClock(l: CloudLease, seconds: int): CloudLease = { ...l, elapsed: seconds }
pure val secondsValues = Set(0, 29, 30)
pure def canResetConsent(l: CloudLease): bool = l.phase == AwaitingConsent and l.elapsed < consentDeadlineSeconds
pure def resetConsent(l: CloudLease): CloudLease =
  if (l.requests == 1) { ...l, requests: 2 } else { ...l, phase: LeaseClosed }
pure def canGiveConsent(l: CloudLease): bool =
  l.phase == AwaitingConsent and l.ownerCurrent and l.elapsed < consentDeadlineSeconds
pure def giveConsent(l: CloudLease): CloudLease = { ...l, phase: ConsentAdmitted }
pure def canExpireConsent(l: CloudLease): bool = l.phase == AwaitingConsent and l.elapsed >= consentDeadlineSeconds
pure def expireConsent(l: CloudLease): CloudLease = { ...l, phase: LeaseClosed }
pure def alwaysConsentResetBounded(l: CloudLease): bool =
  l.requests >= 1 and l.requests <= 2 and
    ((l.phase == AwaitingConsent or l.phase == ConsentAdmitted) implies l.paid == 0 and l.pending == 0 and l.allocated.size() == 0)
pure def stepNoLateConsent(before: CloudLease, via: str, after: CloudLease): bool =
  via == "giveConsent" implies before.elapsed < consentDeadlineSeconds
pure def sometimesSecondConsentAdmitted(l: CloudLease): bool = l.requests == 2 and l.phase == ConsentAdmitted
pure def sometimesConsentExpired(l: CloudLease): bool = l.phase == LeaseClosed and l.paid == 0 and l.elapsed >= 30
```

### Every paid window was allocated, and acknowledgements never pass what was paid

Minting pays the first window. While the bridge is live, a negotiated
client may reserve the next window, which is allocated at once and paid
when granted. The host acknowledges a window only after it was paid and
only one past its last acknowledgement; the client acknowledges only one
past its own and never past the host. From minting until close at least
one window is paid. An acknowledgement for another session, a duplicate,
a reordered one, or one after stop changes nothing.
A client that does not support the negotiation stays on its first window.

```quint
pure def canMintLease(l: CloudLease): bool = l.phase == ConsentAdmitted and l.ownerCurrent
pure def mintLease(l: CloudLease): CloudLease = { ...l, phase: AwaitingMint, paid: 1, allocated: Set(1) }
pure def canAcknowledgeMint(l: CloudLease): bool = l.phase == AwaitingMint and l.ownerCurrent
pure def acknowledgeMint(l: CloudLease): CloudLease = { ...l, phase: LeaseMinted }
pure def canBridgeReady(l: CloudLease, supportsWindows: bool): bool = l.phase == LeaseMinted and l.ownerCurrent
pure def bridgeReady(l: CloudLease, supportsWindows: bool): CloudLease =
  { ...l, phase: LeaseLive, host: 1, client: 1, negotiated: supportsWindows, capture: true }
pure def canReserveWindow(l: CloudLease): bool =
  l.phase == LeaseLive and l.negotiated and l.ownerCurrent and l.pending == 0
pure def reserveWindow(l: CloudLease): CloudLease =
  { ...l, pending: l.paid + 1, allocated: l.allocated.union(Set(l.paid + 1)) }
pure def canGrantWindow(l: CloudLease): bool = l.phase == LeaseLive and l.ownerCurrent and l.pending > 0
pure def grantWindow(l: CloudLease): CloudLease = { ...l, paid: l.pending, pending: 0 }
pure def acceptsAck(l: CloudLease, currentSession: bool): bool =
  l.phase == LeaseLive and l.ownerCurrent and l.negotiated and currentSession
pure def hostAck(l: CloudLease, currentSession: bool, window: int): CloudLease =
  if (acceptsAck(l, currentSession) and window > l.host and window <= l.host + 1 and window <= l.paid)
    { ...l, host: window } else l
pure def clientAck(l: CloudLease, currentSession: bool, window: int): CloudLease =
  if (acceptsAck(l, currentSession) and window > l.client and window <= l.client + 1 and window <= l.host)
    { ...l, client: window } else l
pure val windowValues = Set(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
pure def alwaysWindowAuthority(l: CloudLease): bool =
  l.client >= 0 and l.client <= l.host and l.host <= l.paid and
    ((l.phase == AwaitingMint or l.phase == LeaseMinted or l.phase == LeaseLive) implies l.paid >= 1)
pure def alwaysNoUnfundedWindow(l: CloudLease): bool = {
  val highest = if (l.pending > 0) l.pending else l.paid
  l.allocated.size() == highest and (l.pending == 0 or l.pending == l.paid + 1) and
    l.allocated.forall(allocatedWindow => allocatedWindow >= 1 and allocatedWindow <= highest)
}
pure def sometimesLiveCaptureFunded(l: CloudLease): bool = l.capture and l.paid >= 2 and l.client >= 2
pure def sometimesUnsupportedClientOneWindow(l: CloudLease): bool = l.phase == LeaseLive and not(l.negotiated)
pure val weight_giveConsent = 10
pure val weight_mintLease = 10
pure val weight_acknowledgeMint = 10
pure val weight_bridgeReady = 10
pure val weight_reserveWindow = 10
pure val weight_grantWindow = 10
pure val weight_hostAck = 40
pure val weight_clientAck = 40
```

### Capture runs only in the live session of the current owner

Stop, an owner change, or the host's deadline after a lost
acknowledgement closes the session and ends capture at once.

```quint
pure def canStopLease(l: CloudLease): bool = l.phase != LeaseClosed
pure def stopLease(l: CloudLease): CloudLease = { ...l, phase: LeaseClosed, capture: false }
pure def canChangeLeaseOwner(l: CloudLease): bool = l.ownerCurrent
pure def changeLeaseOwner(l: CloudLease): CloudLease = { ...l, ownerCurrent: false, phase: LeaseClosed, capture: false }
pure def canExpireLease(l: CloudLease): bool =
  l.phase == AwaitingMint or l.phase == LeaseMinted or l.phase == LeaseLive
pure def expireLease(l: CloudLease): CloudLease = { ...l, phase: LeaseClosed, capture: false }
pure def alwaysNoForeignCapture(l: CloudLease): bool = l.capture implies l.phase == LeaseLive and l.ownerCurrent
pure def sometimesLostAckExpired(l: CloudLease): bool = l.phase == LeaseClosed and l.paid >= 2 and not(l.retired)
```

### A closed session retires only after every allocated window is settled for both directions

After close, each allocated window, reserved or paid, needs both its
speech-to-text and its text-to-speech settlement before the session
retires. When those settlements keep arriving, a closed session retires.

```quint
pure def canSettleSpeechToText(l: CloudLease, window: int): bool =
  l.phase == LeaseClosed and l.allocated.contains(window) and not(l.sttSettled.contains(window))
pure def settleSpeechToText(l: CloudLease, window: int): CloudLease = { ...l, sttSettled: l.sttSettled.union(Set(window)) }
pure def canSettleTextToSpeech(l: CloudLease, window: int): bool =
  l.phase == LeaseClosed and l.allocated.contains(window) and not(l.ttsSettled.contains(window))
pure def settleTextToSpeech(l: CloudLease, window: int): CloudLease = { ...l, ttsSettled: l.ttsSettled.union(Set(window)) }
pure def canConfirmRetired(l: CloudLease): bool =
  l.phase == LeaseClosed and not(l.retired) and l.allocated.subseteq(l.sttSettled) and l.allocated.subseteq(l.ttsSettled)
pure def confirmRetired(l: CloudLease): CloudLease = { ...l, retired: true }
pure def alwaysRetiredAfterSettlement(l: CloudLease): bool =
  l.retired implies l.phase == LeaseClosed and l.allocated.subseteq(l.sttSettled) and l.allocated.subseteq(l.ttsSettled)
pure def sometimesRetiredAfterStop(l: CloudLease): bool = l.retired and l.allocated.size() >= 2
pure val fair_settleSpeechToText = "weak"
pure val fair_settleTextToSpeech = "weak"
pure val fair_confirmRetired = "weak"
pure def leadsToClosedRetires(l: CloudLease, later: CloudLease): bool = l.phase == LeaseClosed implies later.retired
```
