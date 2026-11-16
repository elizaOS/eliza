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
attempt changes nothing.

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
refuses is settled at zero and never granted.

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
