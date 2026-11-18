# App data reset

The reviewed reset of the app's own data on an Android device. The renderer
only asks for the native review; the native disclosure and a fresh Android
device-credential confirmation decide. A confirmed reset records a durable
marker, asks the cloud to revoke each saved device key through the
[device credential](../signIn/credential.md)'s reset duties, then calls
Android's `clearApplicationUserData`, which stops the process. The shell is
`DataReset`, `DataResetPlugin` and `ResetAuthorization` of the system
plugin; the host subclasses the plugin under its own name and supplies the
revocation as the reset's `BeforeDispatch` hook.

## Story: Erase the app's data only after I confirm

> As an owner, I want the app's data on this device erased only after I
> reviewed it and proved it is me, so that a reset is never accidental and
> never half done, and I want my saved cloud keys revoked on the way out
> without a slow network keeping my data on the phone.

### Only one review is open, and only its own disclosure and a fresh device credential confirm it

A review takes a new ticket. Its disclosure must be accepted, and then a
fresh device-credential result must arrive for the same ticket; a cancelled
dialog, a destroyed activity, a second review or a stale callback retires
the review and records nothing. An accepted credential confirms the reset;
a refused one ends the review.

```quint
type ResetPhase = Resting | Disclosure | Credential | Confirmed | PendingReset | AttemptOpen | Recover | Dispatched | Fresh
type RevokeState = RevokeOwed | RevokeAsked | RevokeAnswered
type AttemptReport = ListenerUnacknowledged | AndroidRefused | AndroidAccepted
type Reset = { phase: ResetPhase, ticket: int, marker: bool, attempts: int, revoke: RevokeState }
pure val initial: Reset = { phase: Resting, ticket: 0, marker: false, attempts: 0, revoke: RevokeOwed }
pure def canReviewReset(s: Reset): bool = s.phase == Resting or s.phase == Fresh
pure def reviewReset(s: Reset): Reset = { ...s, phase: Disclosure, ticket: s.ticket + 1 }
pure def canConfirmDisclosure(s: Reset, reviewId: int): bool = s.phase == Disclosure and reviewId == s.ticket
pure def confirmDisclosure(s: Reset, reviewId: int): Reset = { ...s, phase: Credential }
pure def canCredentialResult(s: Reset, reviewId: int, accepted: bool): bool = s.phase == Credential and reviewId == s.ticket
pure def credentialResult(s: Reset, reviewId: int, accepted: bool): Reset = { ...s, phase: if (accepted) Confirmed else Resting }
pure def canRetireReview(s: Reset): bool = s.phase == Disclosure or s.phase == Credential
pure def retireReview(s: Reset): Reset = { ...s, phase: Resting }
pure def lawStaleReviewNeverConfirms(s: Reset, reviewId: int, accepted: bool): bool =
  reviewId != s.ticket implies not(canConfirmDisclosure(s, reviewId)) and not(canCredentialResult(s, reviewId, accepted))
pure def stepConfirmedOnlyByAnAcceptedCredential(before: Reset, via: str, after: Reset): bool =
  (after.phase == Confirmed and before.phase != Confirmed) implies (via == "credentialResult" and before.phase == Credential)
pure def sometimesReviewRetired(s: Reset): bool = s.phase == Resting and s.ticket >= 1
pure val reviewIdValues = Set(1, 2, 3, 4)
```

### The marker is recorded only after a confirmed review, and while it stands old startup stays fenced

The marker lives in device-protected storage that is not backed up. When a
trusted listener is installed but cannot acknowledge, the reset is refused
before the marker is written. Once the marker is durable, no other startup
of the app reaches its providers or background workers until Android has
cleared the app.

```quint
pure def canRecordMarker(s: Reset, listenerReachable: bool, markerCommitted: bool): bool = s.phase == Confirmed
pure def recordMarker(s: Reset, listenerReachable: bool, markerCommitted: bool): Reset =
  { ...s, marker: listenerReachable and markerCommitted, phase: if (listenerReachable and markerCommitted) PendingReset else Resting }
pure def mayStartRuntime(s: Reset): bool = not(s.marker)
pure def alwaysMarkerFencesStartup(s: Reset): bool =
  s.marker == (s.phase == PendingReset or s.phase == AttemptOpen or s.phase == Recover or s.phase == Dispatched)
pure def stepMarkerOnlyFollowsConfirmation(before: Reset, via: str, after: Reset): bool =
  (after.marker and not(before.marker)) implies (via == "recordMarker" and before.phase == Confirmed)
pure def lawNoOldStartupWithMarker(s: Reset): bool = s.marker implies not(mayStartRuntime(s))
```

### Saved cloud keys are asked to be revoked before the wipe, and a failed revoke never blocks it

Before an attempt the shell runs the reset duties of every saved device key
once, bounded by eight seconds after a confirmation and four at a later
start. An answer, or no answer in time, lets the attempt go ahead; only an
answer is remembered, so a later start asks again for a reset whose revoke
went unanswered.

```quint
pure def canRevokeDuties(s: Reset, answered: bool): bool =
  s.marker and (s.phase == PendingReset or s.phase == Recover) and s.revoke == RevokeOwed
pure def revokeDuties(s: Reset, answered: bool): Reset = { ...s, revoke: if (answered) RevokeAnswered else RevokeAsked }
pure def alwaysAttemptFollowsRevocation(s: Reset): bool =
  (s.phase == AttemptOpen or s.phase == Dispatched) implies s.revoke != RevokeOwed
pure def alwaysRevocationOnlyUnderMarker(s: Reset): bool = not(s.marker) implies s.revoke == RevokeOwed
pure def lawFailedRevokeNeverBlocksWipe(s: Reset): bool =
  (s.marker and (s.phase == PendingReset or s.phase == Recover) and s.revoke == RevokeOwed) implies
    canReserveAttempt(revokeDuties(s, false), true, false)
pure def sometimesWipedAfterAnUnansweredRevoke(s: Reset): bool = s.phase == Dispatched and s.revoke == RevokeAsked
```

### An attempt is reserved before Android is asked, and only Android's clear proves fresh data

Each attempt reserves a numbered slot first, so a lost process never
replays an open attempt without a new start. Automatic attempts are at most
three in a 60-second window; the owner can always retry from the recovery
screen. A listener that does not acknowledge, or an Android refusal, leaves
the marker for recovery. Android's acceptance is only a dispatch receipt: a
replacement process confirms fresh data only when the marker is gone and the
storage scope is new.

```quint
pure val automaticAttempts = 3
pure def canReserveAttempt(s: Reset, explicitRetry: bool, nextWindow: bool): bool =
  s.marker and (s.phase == PendingReset or s.phase == Recover) and s.revoke != RevokeOwed and
  (explicitRetry or nextWindow or s.attempts < automaticAttempts)
pure def reserveAttempt(s: Reset, explicitRetry: bool, nextWindow: bool): Reset =
  { ...s, phase: AttemptOpen, attempts: if (nextWindow) 1 else s.attempts + 1, ticket: s.ticket + 1 }
pure def canCloseAttempt(s: Reset, attemptId: int, report: AttemptReport): bool =
  s.phase == AttemptOpen and s.marker and attemptId == s.ticket
pure def closeAttempt(s: Reset, attemptId: int, report: AttemptReport): Reset =
  if (report == AndroidAccepted) { ...s, phase: Dispatched }
  else { ...s, phase: Recover, revoke: if (s.revoke == RevokeAnswered) RevokeAnswered else RevokeOwed }
pure def canRecoverInterrupted(s: Reset, markerPresent: bool): bool =
  s.marker and markerPresent and (s.phase == AttemptOpen or s.phase == Dispatched)
pure def recoverInterrupted(s: Reset, markerPresent: bool): Reset =
  { ...s, phase: Recover, revoke: if (s.revoke == RevokeAnswered) RevokeAnswered else RevokeOwed }
pure def canObserveFresh(s: Reset, markerAbsent: bool, freshScope: bool): bool = s.phase == Dispatched and markerAbsent and freshScope
pure def observeFresh(s: Reset, markerAbsent: bool, freshScope: bool): Reset =
  { ...s, phase: Fresh, marker: false, attempts: 0, revoke: RevokeOwed }
pure def alwaysCountsNeverNegative(s: Reset): bool = s.attempts >= 0 and s.ticket >= 0
pure def stepDispatchNeedsAReservation(before: Reset, via: str, after: Reset): bool =
  (after.phase == Dispatched and before.phase != Dispatched) implies (via == "closeAttempt" and before.marker and before.phase == AttemptOpen)
pure def lawNoUnpromptedReplayOfAnOpenAttempt(s: Reset, nextWindow: bool): bool =
  s.phase == AttemptOpen implies not(canReserveAttempt(s, false, nextWindow))
pure def lawStaleAttemptResultNeverApplies(s: Reset, attemptId: int, report: AttemptReport): bool =
  attemptId != s.ticket implies not(canCloseAttempt(s, attemptId, report))
pure def sometimesResetRecovery(s: Reset): bool = s.phase == Recover and s.marker
pure def sometimesFreshAfterDispatch(s: Reset): bool = s.phase == Fresh and not(s.marker)
pure val attemptIdValues = Set(2, 3, 4, 5, 6)
```

### The renderer hears only that nothing was reset

A confirmed reset never answers the renderer: Android stops the process.
Every answer the renderer reads therefore means nothing was reset. It shows
the native sentence only for a cancelled or unavailable answer whose
sentence is not blank and has at most 500 characters; a rejected call or any
other answer reads as unavailable with the shell's own sentence.

```quint
type ReviewOutcome = ReviewCancelled | ReviewUnavailable
pure val maxReviewMessageChars = 500
pure def reviewMessageShown(status: str, messageChars: int, messageBlank: bool): bool =
  (status == "cancelled" or status == "unavailable") and not(messageBlank) and messageChars >= 1 and messageChars <= maxReviewMessageChars
pure def reviewOutcome(status: str, messageChars: int, messageBlank: bool): ReviewOutcome =
  if (status == "cancelled" and reviewMessageShown(status, messageChars, messageBlank)) ReviewCancelled else ReviewUnavailable
pure def lawUnreadableAnswerIsUnavailable(status: str, messageChars: int, messageBlank: bool): bool =
  not(reviewMessageShown(status, messageChars, messageBlank)) implies reviewOutcome(status, messageChars, messageBlank) == ReviewUnavailable
pure val statusValues = Set("cancelled", "unavailable", "completed", "")
pure val messageCharsValues = Set(0, 1, 500, 501)
```
