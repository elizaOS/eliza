# Android key activation

A native sign-in stores the device key and an enrollment receipt before the
cloud confirms the key. The Android sign-in plugin then finishes the
activation in two places: in process, by background rounds after the
sign-in step answered activation-pending, and at the next start, by
settling a receipt it finds stored ([activation at startup](./activationRecovery.md)).
Both settle a key the same way: a
confirmed key stays and is announced; a key the cloud refused, or did not
confirm by its deadline, is removed with its receipt, revoked in case a
confirmation was lost, and reported. Key `11` is this sign-in's key and
`12` the key of a newer sign-in.

## Story: Finish a sign-in whose key the cloud has not yet confirmed

> As a person who just signed in, I want the app to finish the sign-in once
> the cloud confirms it, even after a restart, and never to keep a key that can
> never work or to undo a newer sign-in.

### An unconfirmed key is asked about until its deadline, plus one request just after

The sign-in step ends as activation-pending with the key and its receipt
stored. Background rounds ask the cloud again until the deadline; after the
deadline exactly one more request tells a lost confirmation from a dead
key. A closed plugin or a sign-in superseded by a newer credential action
sends nothing and leaves the slot and receipt to their owner.

```quint
type RoundAnswer = RoundAcknowledged | RoundAlreadyComplete | RoundRetry | RoundLost | RoundRefused
type Announcement = NotAnnounced | AnnouncedCompleted | AnnouncedExpired
type ActivationRounds = { saved: int, receipt: int, intentCurrent: bool, live: bool, supersededSaved: int,
  serverActive: bool, retrying: bool, rounds: int, deadlinePassed: bool, roundsAfterDeadline: int,
  announced: Announcement, revokeSent: bool }
pure val myKey = 11
pure val newerKey = 12
pure val initial: ActivationRounds = { saved: myKey, receipt: myKey, intentCurrent: true, live: true, supersededSaved: -1, serverActive: false,
  retrying: true, rounds: 0, deadlinePassed: false, roundsAfterDeadline: 0, announced: NotAnnounced, revokeSent: false }
pure def roundsOwn(r: ActivationRounds): bool = r.live and r.intentCurrent
pure def keySettled(confirmed: bool, r: ActivationRounds): ActivationRounds =
  if (confirmed) { ...r, retrying: false, serverActive: true, receipt: if (r.receipt == myKey) 0 else r.receipt,
    announced: if (r.saved == myKey) AnnouncedCompleted else r.announced }
  else { ...r, retrying: false, saved: if (r.saved == myKey) 0 else r.saved, receipt: if (r.receipt == myKey) 0 else r.receipt,
    revokeSent: true, announced: AnnouncedExpired }
pure def unansweredRound(answer: RoundAnswer, sent: ActivationRounds): ActivationRounds = {
  val reached = { ...sent, serverActive: sent.serverActive or answer == RoundLost }
  if (sent.deadlinePassed) keySettled(false, reached) else reached
}
pure def answeredRound(answer: RoundAnswer, r: ActivationRounds): ActivationRounds = {
  val sent = { ...r, rounds: r.rounds + 1, roundsAfterDeadline: r.roundsAfterDeadline + (if (r.deadlinePassed) 1 else 0) }
  if (answer == RoundAcknowledged or answer == RoundAlreadyComplete) keySettled(true, sent)
  else if (answer == RoundRefused) keySettled(false, sent)
  else unansweredRound(answer, sent)
}
pure def canRound(a: ActivationRounds): bool = a.retrying
pure def round(a: ActivationRounds, answer: RoundAnswer): ActivationRounds = if (not(roundsOwn(a))) { ...a, retrying: false } else answeredRound(answer, a)
pure def canDeadline(a: ActivationRounds): bool = not(a.deadlinePassed)
pure def deadline(a: ActivationRounds): ActivationRounds = { ...a, deadlinePassed: true }
pure def alwaysOneRequestAfterDeadline(a: ActivationRounds): bool = a.roundsAfterDeadline == 0 or a.roundsAfterDeadline == 1
pure def alwaysUndecidedKeyStays(a: ActivationRounds): bool =
  (a.retrying and a.supersededSaved == -1) implies (a.saved == myKey and a.receipt == myKey)
pure def sometimesLateConfirmationAnnounced(a: ActivationRounds): bool =
  a.announced == AnnouncedCompleted and a.roundsAfterDeadline == 1
```

### A confirmed key is announced once, and a dead key is removed only while it is still the exact saved key

A confirmation removes the receipt and announces the sign-in while the same
key is still saved; it is announced only for a key the cloud confirmed. A
refusal, or no confirmation by the deadline, removes this sign-in's key and
receipt, sends a revocation and reports activation-expired. A newer
credential action's key and receipt are never removed or announced as this
sign-in's.

```quint
pure def canCredentialAction(a: ActivationRounds): bool = a.intentCurrent
pure def credentialAction(a: ActivationRounds, replacement: int): ActivationRounds =
  { ...a, intentCurrent: false, saved: replacement, supersededSaved: replacement, receipt: if (replacement == newerKey) newerKey else a.receipt }
pure def canCloseRounds(a: ActivationRounds): bool = a.live
pure def closeRounds(a: ActivationRounds): ActivationRounds = { ...a, live: false }
pure val replacementValues = Set(0, 12)
pure def alwaysCompletedOnlyWhenConfirmed(a: ActivationRounds): bool = a.announced == AnnouncedCompleted implies a.serverActive
pure def alwaysNewerActionWins(a: ActivationRounds): bool =
  a.supersededSaved != -1 implies (a.saved == a.supersededSaved and
    (a.supersededSaved == newerKey implies a.receipt == newerKey))
pure def alwaysRemovedKeyRevoked(a: ActivationRounds): bool = a.announced == AnnouncedExpired implies a.revokeSent
pure def sometimesRefusedKeyRemoved(a: ActivationRounds): bool = a.announced == AnnouncedExpired and a.saved == 0
pure def sometimesNewerSignInKeptItsSlot(a: ActivationRounds): bool =
  a.saved == newerKey and a.receipt == newerKey and not(a.retrying)
```
