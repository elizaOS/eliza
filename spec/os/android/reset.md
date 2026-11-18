# App data reset

The reviewed reset of the app's own data on an Android device. The renderer
only asks for the native review; the native disclosure and a fresh Android
device-credential confirmation decide. A confirmed reset records a durable
marker, runs the reset duties of the [device credential](../signIn/credential.md)
for every saved device key, then asks the trusted listener to acknowledge and
calls Android's `clearApplicationUserData`, which clears this package for this
Android user only and stops its processes. Nothing here deletes files one by
one, another app's data or cloud data. The shell is `DataReset`,
`DataResetPlugin`, `ResetAuthorization` and the recovery activity of the
system plugin; the host supplies the revocation as the reset's
`BeforeDispatch` work. One `ticket` numbers every review and every attempt,
so a callback of an older one never applies.

## Story: Erase the app's data only after I confirm

> As an owner, I want the app's data on this device erased only after I
> reviewed it and proved it is me, so that a reset is never accidental and
> never half done, and I want my saved cloud keys revoked on the way out
> without a slow network keeping my data on the phone.

### Only an accepted fresh device credential of the open review confirms a reset

One review is open at a time and takes a new ticket. Its disclosure must be
accepted, then a device-credential result must arrive for the same ticket. A
cancelled dialog, a destroyed activity, a missing screen lock or a refused
credential ends the review and records nothing.

```quint
import credential as C from "../signIn/credential"
type ResetPhase = Resting | Disclosure | Credential | Confirmed | PendingReset | AttemptOpen | Recover | Dispatched | Fresh
type RevokeState = RevokeOwed | RevokeAsked | RevokeAnswered
type AttemptReport = ListenerUnacknowledged | AndroidRefused | AndroidAccepted
type Reset = { phase: ResetPhase, ticket: int, attempts: int, revoke: RevokeState }
pure val initial: Reset = { phase: Resting, ticket: 0, attempts: 0, revoke: RevokeOwed }
pure def canReviewReset(s: Reset): bool = s.phase == Resting or s.phase == Fresh
pure def reviewReset(s: Reset): Reset = { ...s, phase: Disclosure, ticket: s.ticket + 1 }
pure def canConfirmDisclosure(s: Reset, reviewId: int): bool = s.phase == Disclosure and reviewId == s.ticket
pure def confirmDisclosure(s: Reset, reviewId: int): Reset = { ...s, phase: Credential }
pure def canCredentialResult(s: Reset, reviewId: int, accepted: bool): bool = s.phase == Credential and reviewId == s.ticket
pure def credentialResult(s: Reset, reviewId: int, accepted: bool): Reset = { ...s, phase: if (accepted) Confirmed else Resting }
pure def canRetireReview(s: Reset): bool = s.phase == Disclosure or s.phase == Credential
pure def retireReview(s: Reset): Reset = { ...s, phase: Resting }
pure val reviewIdValues = Set(1, 2, 3)
pure def stepConfirmedOnlyByAnAcceptedCredential(before: Reset, via: str, after: Reset): bool =
  (after.phase == Confirmed and before.phase != Confirmed) implies (via == "credentialResult" and before.phase == Credential)
pure def sometimesReviewRetired(s: Reset): bool = s.phase == Resting and s.ticket >= 1
```

### The marker is recorded only after a confirmed review and lifts only when Android cleared the app

The marker lives in device-protected storage that is not backed up, beside
a fresh attempt budget. When a trusted listener is installed but cannot
acknowledge, or the marker write is not committed, the reset is refused
before anything is recorded. While the marker stands, every start of the
app stops before its providers, initializers or background workers run; a
start the owner is looking at opens the recovery screen in its own
provider-free process, a background start only stops.

```quint
pure def markerStands(s: Reset): bool =
  s.phase == PendingReset or s.phase == AttemptOpen or s.phase == Recover or s.phase == Dispatched
pure def mayStartRuntime(s: Reset): bool = not(markerStands(s))
pure def canRecordMarker(s: Reset, listenerReachable: bool, markerCommitted: bool): bool = s.phase == Confirmed
pure def recordMarker(s: Reset, listenerReachable: bool, markerCommitted: bool): Reset =
  { ...s, phase: if (listenerReachable and markerCommitted) PendingReset else Resting }
pure def stepMarkerRisesAfterConfirmationAndLiftsOnlyWhenCleared(before: Reset, via: str, after: Reset): bool =
  ((markerStands(after) and not(markerStands(before))) implies (via == "recordMarker" and before.phase == Confirmed))
    and ((markerStands(before) and not(markerStands(after))) implies via == "observeFresh")
pure def alwaysNoBudgetSpentWithoutMarker(s: Reset): bool = not(markerStands(s)) implies s.attempts == 0
```

### Saved cloud keys are asked to be revoked before each attempt, and a failed revoke never blocks the wipe

The shell runs the credential's `reset` duties once (`C::resetAttempts`),
bounded by eight seconds after a confirmation or a retry from the recovery
screen and four at a start the owner is looking at; a background start gives
it no time. A settled answer (`2xx` or `401`) is remembered for this reset;
no answer in time lets the attempt go ahead, and a later attempt asks again.

```quint
pure val interactiveRevokeMs = 8000
pure val startupRevokeMs = 4000
pure def canRevokeDuties(s: Reset, reply: C::RevokeReply): bool =
  (s.phase == PendingReset or s.phase == Recover) and s.revoke == RevokeOwed
pure def revokeDuties(s: Reset, reply: C::RevokeReply): Reset =
  { ...s, revoke: if (reply == C::RevokeSettled) RevokeAnswered else RevokeAsked }
pure def alwaysRevocationOnlyUnderMarker(s: Reset): bool = not(markerStands(s)) implies s.revoke == RevokeOwed
pure def alwaysAttemptFollowsRevocation(s: Reset): bool =
  (s.phase == AttemptOpen or s.phase == Dispatched) implies s.revoke != RevokeOwed
pure def sometimesWipedAfterAnUnansweredRevoke(s: Reset): bool = s.phase == Dispatched and s.revoke == RevokeAsked
```

### An attempt is reserved before Android is asked, and only its own report or a later start closes it

Each attempt takes a ticket and is counted durably before the listener or
Android is called. Automatic attempts are at most three in a 60-second
window; the confirmation and the recovery screen's retry are always
explicit. The listener must acknowledge immediately before Android's clear;
a listener that does not, or an Android refusal, keeps the marker and every
byte of data for recovery. Android's acceptance is only a dispatch receipt.
A later start that still finds the marker after an open or dispatched
attempt defers to recovery instead of replaying it.

```quint
pure val automaticAttempts = 3
pure val automaticWindowMs = 60000
pure def canReserveAttempt(s: Reset, explicitRetry: bool, nextWindow: bool): bool =
  (s.phase == PendingReset or s.phase == Recover) and s.revoke != RevokeOwed and
    (explicitRetry or nextWindow or s.attempts < automaticAttempts)
pure def reserveAttempt(s: Reset, explicitRetry: bool, nextWindow: bool): Reset =
  { ...s, phase: AttemptOpen, attempts: if (nextWindow) 1 else s.attempts + 1, ticket: s.ticket + 1 }
pure def owedAgain(r: RevokeState): RevokeState = if (r == RevokeAnswered) RevokeAnswered else RevokeOwed
pure def canCloseAttempt(s: Reset, attemptId: int, report: AttemptReport): bool = s.phase == AttemptOpen and attemptId == s.ticket
pure def closeAttempt(s: Reset, attemptId: int, report: AttemptReport): Reset =
  if (report == AndroidAccepted) { ...s, phase: Dispatched } else { ...s, phase: Recover, revoke: owedAgain(s.revoke) }
pure def canRecoverInterrupted(s: Reset): bool = s.phase == AttemptOpen or s.phase == Dispatched
pure def recoverInterrupted(s: Reset): Reset = { ...s, phase: Recover, revoke: owedAgain(s.revoke) }
pure val attemptIdValues = Set(2, 3, 4, 5, 6)
pure def alwaysCountsAreNatural(s: Reset): bool =
  s.ticket >= 0 and s.attempts >= 0 and ((s.phase == AttemptOpen or s.phase == Dispatched) implies s.attempts >= 1)
pure def stepDispatchNeedsAReservation(before: Reset, via: str, after: Reset): bool =
  (after.phase == Dispatched and before.phase != Dispatched) implies (via == "closeAttempt" and before.phase == AttemptOpen)
pure def sometimesResetRecovery(s: Reset): bool = s.phase == Recover
pure def sometimesAutomaticBudgetSpent(s: Reset): bool = s.phase == Recover and s.attempts >= automaticAttempts
```

### Only a start that finds the marker gone after a dispatch proves the data fresh

Android's clear removes the marker with everything else, so the first start
after it runs without one and with an empty budget.

```quint
pure def canObserveFresh(s: Reset): bool = s.phase == Dispatched
pure def observeFresh(s: Reset): Reset = { ...s, phase: Fresh, attempts: 0, revoke: RevokeOwed }
pure def sometimesFreshAfterDispatch(s: Reset): bool = s.phase == Fresh
```

### The renderer hears only that nothing was reset

A confirmed reset never answers the renderer: Android stops the process, or
the recovery screen takes over. Every answer the renderer reads therefore
means nothing was reset. It shows the native sentence only for a
`cancelled` or `unavailable` answer whose sentence is not blank and has at
most 500 characters; a rejected call or any other answer reads as
unavailable with the shell's own sentence.

```quint
type ReviewNotice = NativeCancelled | NativeUnavailable | ShellUnavailable
pure val maxReviewMessageChars = 500
pure def reviewNotice(status: str, messageChars: int, messageBlank: bool): ReviewNotice =
  if (messageBlank or messageChars < 1 or messageChars > maxReviewMessageChars) ShellUnavailable
  else if (status == "cancelled") NativeCancelled
  else if (status == "unavailable") NativeUnavailable
  else ShellUnavailable
```
