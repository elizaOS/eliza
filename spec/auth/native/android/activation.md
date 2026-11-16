# Android key activation

A native sign-in stores the device key and an enrollment receipt before
Cloud confirms the key. The Android sign-in plugin then finishes the
activation in two places: in process, by background rounds after the
sign-in step answered activation-pending (`CloudSignInPlugin.complete`,
`retryAcknowledgement`, `activated` and `expireActivation`), and at the next
start, by settling a receipt it finds stored (`resumeAcknowledgements`).
Both settle a key the same way: a confirmed key stays and is announced; a
key Cloud refused, or did not confirm by its deadline, is removed with its
receipt, revoked in case a confirmation was lost, and reported. The model
holds the two independently. Key `11` is this sign-in's key and `12` the key
of a newer sign-in.

## Story: Finish a sign-in whose key Cloud has not yet confirmed

> As a person who just signed in, I want the app to finish the sign-in once
> Cloud confirms it, even after a restart, and never to keep a key that can
> never work or to undo a newer sign-in.

### An unconfirmed key is asked about until its deadline, plus one request just after

The sign-in step ends as activation-pending with the key and its receipt
stored. Background rounds ask Cloud again until the deadline; after the
deadline exactly one more request tells a lost confirmation from a dead
key. A closed plugin or a sign-in superseded by a newer credential action
sends nothing and leaves the slot and receipt to their owner.

```quint
type RoundAnswer = RoundAcknowledged | RoundAlreadyComplete | RoundRetry | RoundLost | RoundRefused
type Announcement = NotAnnounced | AnnouncedCompleted | AnnouncedExpired
type ActivationRounds = { saved: int, receipt: int, intentCurrent: bool, live: bool, supersededSaved: int,
  serverActive: bool, retrying: bool, rounds: int, deadlinePassed: bool, roundsAfterDeadline: int,
  announced: Announcement, revokeSent: bool }
type AckReceipt = { present: bool, parsed: bool, environment: int, credential: int, expired: bool }
type AckPost = { environment: int, credential: int, saved: int, late: bool }
type RecoveryPhase = RecoveryIdle | Reading | RemovingStale | Sending | Waiting | SendingLate | WaitingLate | Confirming | ExpiringRefused | ExpiringUnconfirmed | RecoveryFinished
type RecoveryOutcome = NoRecoveryOutcome | ReceiptKept | ReceiptAbsent | StaleRemoved | HandedOver | KeyConfirmed | RunSuperseded | KeyExpired
type ReceiptRemoval = NoRemoval | RemovalStale | RemovalAcknowledged | RemovalExpired
type KeyRemoval = NoKeyRemoval | RemovedRefused | RemovedUnconfirmed
type AckRecovery = { saved: int, initialSaved: int, receipt: AckReceipt, initialReceipt: AckReceipt, runReceipt: AckReceipt,
  runSaved: int, replaced: bool, live: bool, runs: int, pending: bool, phase: RecoveryPhase, calls: int, latePosts: int,
  post: AckPost, removal: ReceiptRemoval, verdict: RecoveryOutcome, keyRemoval: KeyRemoval, removedKey: int,
  removedLate: bool, revoked: bool, completed: int, expiredReports: int, removedReceipt: AckReceipt }
type Activation = { background: ActivationRounds, recovery: AckRecovery }
pure val myKey = 11
pure val newerKey = 12
pure val production = 1
pure val staging = 2
pure val noReceipt: AckReceipt = { present: false, parsed: false, environment: 0, credential: 0, expired: false }
pure val matchingReceipt: AckReceipt = { present: true, parsed: true, environment: production, credential: myKey, expired: false }
pure val newerReceipt: AckReceipt = { present: true, parsed: true, environment: production, credential: newerKey, expired: false }
pure val noPost: AckPost = { environment: 0, credential: 0, saved: 0, late: false }
pure def recoveryFrom(receipt: AckReceipt, saved: int): AckRecovery = { saved: saved, initialSaved: saved, receipt: receipt,
  initialReceipt: receipt, runReceipt: noReceipt, runSaved: 0, replaced: false, live: true, runs: 0, pending: false,
  phase: RecoveryIdle, calls: 0, latePosts: 0, post: noPost, removal: NoRemoval, verdict: NoRecoveryOutcome,
  keyRemoval: NoKeyRemoval, removedKey: 0, removedLate: false, revoked: false, completed: 0, expiredReports: 0, removedReceipt: noReceipt }
pure val initial: Activation = {
  background: { saved: myKey, receipt: myKey, intentCurrent: true, live: true, supersededSaved: -1, serverActive: false,
    retrying: true, rounds: 0, deadlinePassed: false, roundsAfterDeadline: 0, announced: NotAnnounced, revokeSent: false },
  recovery: recoveryFrom(matchingReceipt, myKey) }
pure def roundsOwn(r: ActivationRounds): bool = r.live and r.intentCurrent
pure def roundActivated(r: ActivationRounds): ActivationRounds =
  { ...r, retrying: false, serverActive: true, receipt: if (r.receipt == myKey) 0 else r.receipt,
    announced: if (r.saved == myKey) AnnouncedCompleted else r.announced }
pure def roundExpired(r: ActivationRounds): ActivationRounds =
  { ...r, retrying: false, saved: if (r.saved == myKey) 0 else r.saved, receipt: if (r.receipt == myKey) 0 else r.receipt,
    revokeSent: true, announced: AnnouncedExpired }
pure def unansweredRound(sent: ActivationRounds, answer: RoundAnswer): ActivationRounds = {
  val reached = { ...sent, serverActive: sent.serverActive or answer == RoundLost }
  if (sent.deadlinePassed) roundExpired(reached) else reached
}
pure def answerRound(r: ActivationRounds, answer: RoundAnswer): ActivationRounds = {
  val sent = { ...r, rounds: r.rounds + 1, roundsAfterDeadline: r.roundsAfterDeadline + (if (r.deadlinePassed) 1 else 0) }
  if (answer == RoundAcknowledged or answer == RoundAlreadyComplete) roundActivated(sent)
  else if (answer == RoundRefused) roundExpired(sent)
  else unansweredRound(sent, answer)
}
pure def nextRound(r: ActivationRounds, answer: RoundAnswer): ActivationRounds =
  if (not(roundsOwn(r))) { ...r, retrying: false }
  else answerRound(r, answer)
pure def canRound(a: Activation): bool = a.background.retrying
pure def round(a: Activation, answer: RoundAnswer): Activation = { ...a, background: nextRound(a.background, answer) }
pure def canDeadline(a: Activation): bool = not(a.background.deadlinePassed)
pure def deadline(a: Activation): Activation = { ...a, background: { ...a.background, deadlinePassed: true } }
pure def alwaysOneRequestAfterDeadline(a: Activation): bool = a.background.roundsAfterDeadline == 0 or a.background.roundsAfterDeadline == 1
pure def alwaysUndecidedKeyStays(a: Activation): bool =
  (a.background.retrying and a.background.supersededSaved == -1) implies (a.background.saved == myKey and a.background.receipt == myKey)
pure def sometimesLateConfirmationAnnounced(a: Activation): bool =
  a.background.announced == AnnouncedCompleted and a.background.roundsAfterDeadline == 1
```

### A confirmed key is announced once, and a dead key is removed only while it is still the exact saved key

A confirmation removes the receipt and announces the sign-in while the same
key is still saved; it is announced only for a key Cloud confirmed. A
refusal, or no confirmation by the deadline, removes this sign-in's key and
receipt, sends a revocation and reports activation-expired. A newer
credential action's key and receipt are never removed or announced as this
sign-in's.

```quint
pure def canCredentialAction(a: Activation): bool = a.background.intentCurrent
pure def credentialAction(a: Activation, replacement: int): Activation =
  { ...a, background: { ...a.background, intentCurrent: false, saved: replacement, supersededSaved: replacement,
    receipt: if (replacement == newerKey) newerKey else a.background.receipt } }
pure def canCloseRounds(a: Activation): bool = a.background.live
pure def closeRounds(a: Activation): Activation = { ...a, background: { ...a.background, live: false } }
pure val replacementValues = Set(0, 12)
pure def alwaysCompletedOnlyWhenConfirmed(a: Activation): bool = a.background.announced == AnnouncedCompleted implies a.background.serverActive
pure def alwaysNewerActionWins(a: Activation): bool =
  a.background.supersededSaved != -1 implies (a.background.saved == a.background.supersededSaved and
    (a.background.supersededSaved == newerKey implies a.background.receipt == newerKey))
pure def alwaysRemovedKeyRevoked(a: Activation): bool = a.background.announced == AnnouncedExpired implies a.background.revokeSent
pure def sometimesRefusedKeyRemoved(a: Activation): bool = a.background.announced == AnnouncedExpired and a.background.saved == 0
pure def sometimesNewerSignInKeptItsSlot(a: Activation): bool =
  a.background.saved == newerKey and a.background.receipt == newerKey and not(a.background.retrying)
```

### A stored receipt is settled at startup with the same outcomes, by the run that read it

At start the plugin reads the stored receipt on its sign-in worker. An
unreadable or unparsable receipt is kept; one that names no saved key or
another deployment is stale and goes, without any request. A receipt for
the saved key marks the deployment as awaiting activation and is sent, with
the receipt and key this run read: up to three requests before its
deadline, or the one request after it. A confirmation removes the receipt
only while it is still this run's and announces the sign-in while that key
is still saved. A refusal, or no confirmation after the deadline, removes
the key only while it is still the exact saved key and the receipt only
while it is still this run's, then revokes it and reports. With no settling
answer before the deadline, the background rounds take over. A closed
plugin sends nothing more.

```quint
type ReceiptCase = NoStoredReceipt | MatchingStoredReceipt | ReceiptWithoutKey | ReceiptForOtherKey | ReceiptForOtherDeployment | ExpiredStoredReceipt | UnparsedReceipt
type AckReply = ReplyAcknowledged | ReplyAlreadyComplete | ReplyRetryable | ReplyWrongCredential | ReplyDenied | ReplyUnexpected
pure def canLoadReceipt(a: Activation): bool = a.recovery.runs == 0 and a.recovery.phase == RecoveryIdle
pure def loadReceipt(a: Activation, receiptCase: ReceiptCase): Activation = { ...a, recovery:
  if (receiptCase == NoStoredReceipt) recoveryFrom(noReceipt, myKey)
  else if (receiptCase == ReceiptWithoutKey) recoveryFrom(matchingReceipt, 0)
  else if (receiptCase == ReceiptForOtherKey) recoveryFrom(matchingReceipt, newerKey)
  else if (receiptCase == ReceiptForOtherDeployment) recoveryFrom({ ...matchingReceipt, environment: staging }, myKey)
  else if (receiptCase == ExpiredStoredReceipt) recoveryFrom({ ...matchingReceipt, expired: true }, myKey)
  else if (receiptCase == UnparsedReceipt) recoveryFrom({ ...matchingReceipt, parsed: false }, myKey)
  else recoveryFrom(matchingReceipt, myKey) }
pure def recoveryMatches(r: AckRecovery): bool =
  r.receipt.present and r.receipt.parsed and r.receipt.credential == r.saved and r.receipt.environment == production
pure def recoveryFinished(verdict: RecoveryOutcome, r: AckRecovery): AckRecovery = { ...r, phase: RecoveryFinished, verdict: verdict }
pure def canBeginRecovery(a: Activation): bool = a.recovery.phase == RecoveryIdle or a.recovery.phase == RecoveryFinished
pure def beginRecovery(a: Activation): Activation = { ...a, recovery: { ...a.recovery, live: true, runs: a.recovery.runs + 1,
  runReceipt: a.recovery.receipt, runSaved: a.recovery.saved, phase: Reading, calls: 0, latePosts: 0, post: noPost,
  verdict: NoRecoveryOutcome, pending: false } }
pure def canReadReceipt(a: Activation): bool = a.recovery.phase == Reading
pure def readReceiptRecovery(r: AckRecovery, readable: bool): AckRecovery =
  if (not(readable)) recoveryFinished(ReceiptKept, r)
  else if (not(r.receipt.present)) recoveryFinished(ReceiptAbsent, r)
  else if (not(r.receipt.parsed)) recoveryFinished(ReceiptKept, r)
  else if (not(recoveryMatches(r))) { ...r, phase: RemovingStale }
  else if (r.receipt.expired) { ...r, phase: SendingLate, pending: true }
  else { ...r, phase: Sending, pending: true }
pure def readReceipt(a: Activation, readable: bool): Activation = { ...a, recovery: readReceiptRecovery(a.recovery, readable) }
pure def canSendAck(a: Activation): bool = a.recovery.phase == Sending and a.recovery.calls < 3
pure def sendAckRecovery(r: AckRecovery): AckRecovery =
  if (r.live) { ...r, phase: Waiting, calls: r.calls + 1, post: { environment: production, credential: r.runReceipt.credential, saved: r.runSaved, late: false } }
  else recoveryFinished(ReceiptKept, r)
pure def sendAck(a: Activation): Activation = { ...a, recovery: sendAckRecovery(a.recovery) }
pure def canSendLateAck(a: Activation): bool = a.recovery.phase == SendingLate and a.recovery.latePosts < 1
pure def sendLateAckRecovery(r: AckRecovery): AckRecovery =
  if (r.live) { ...r, phase: WaitingLate, latePosts: 1, post: { environment: production, credential: r.runReceipt.credential, saved: r.runSaved, late: true } }
  else recoveryFinished(ReceiptKept, r)
pure def sendLateAck(a: Activation): Activation = { ...a, recovery: sendLateAckRecovery(a.recovery) }
pure def confirmedReply(reply: AckReply): bool = reply == ReplyAcknowledged or reply == ReplyAlreadyComplete
pure def canAckAnswered(a: Activation): bool = a.recovery.phase == Waiting
pure def ackAnsweredRecovery(r: AckRecovery, reply: AckReply): AckRecovery =
  if (not(r.live)) recoveryFinished(ReceiptKept, r)
  else if (confirmedReply(reply)) { ...r, phase: Confirming }
  else if (reply == ReplyDenied) { ...r, phase: ExpiringRefused }
  else if (reply == ReplyRetryable and r.calls < 3) { ...r, phase: Sending }
  else recoveryFinished(HandedOver, r)
pure def ackAnswered(a: Activation, reply: AckReply): Activation = { ...a, recovery: ackAnsweredRecovery(a.recovery, reply) }
pure def canLateAckAnswered(a: Activation): bool = a.recovery.phase == WaitingLate
pure def lateAckAnsweredRecovery(r: AckRecovery, reply: AckReply): AckRecovery =
  if (not(r.live)) recoveryFinished(ReceiptKept, r)
  else if (confirmedReply(reply)) { ...r, phase: Confirming }
  else { ...r, phase: ExpiringUnconfirmed }
pure def lateAckAnswered(a: Activation, reply: AckReply): Activation = { ...a, recovery: lateAckAnsweredRecovery(a.recovery, reply) }
pure def canRemoveStale(a: Activation, removed: bool): bool = a.recovery.phase == RemovingStale and (not(removed) or a.recovery.live)
pure def removeStale(a: Activation, removed: bool): Activation = { ...a, recovery:
  if (removed) { ...recoveryFinished(StaleRemoved, a.recovery), receipt: noReceipt, removal: RemovalStale, removedReceipt: a.recovery.receipt }
  else recoveryFinished(ReceiptKept, a.recovery) }
pure def canConfirmKey(a: Activation, removed: bool): bool = a.recovery.phase == Confirming and (not(removed) or a.recovery.live)
pure def confirmKeyRecovery(r: AckRecovery, removed: bool): AckRecovery = {
  val own = r.receipt == r.runReceipt
  { ...r, phase: RecoveryFinished, pending: false, receipt: if (own and removed) noReceipt else r.receipt,
    removal: if (own and removed) RemovalAcknowledged else r.removal,
    removedReceipt: if (own and removed) r.receipt else r.removedReceipt,
    completed: r.completed + (if (r.live and r.saved == r.runSaved) 1 else 0),
    verdict: if (not(own)) RunSuperseded else if (removed) KeyConfirmed else ReceiptKept }
}
pure def confirmKey(a: Activation, removed: bool): Activation = { ...a, recovery: confirmKeyRecovery(a.recovery, removed) }
pure def canExpireKey(a: Activation): bool = a.recovery.phase == ExpiringRefused or a.recovery.phase == ExpiringUnconfirmed
pure def expireKeyRecovery(r: AckRecovery): AckRecovery = {
  val reason = if (r.phase == ExpiringRefused) RemovedRefused else RemovedUnconfirmed
  if (not(r.live)) recoveryFinished(ReceiptKept, r)
  else if (r.saved != r.runSaved or r.receipt != r.runReceipt) { ...recoveryFinished(RunSuperseded, r), pending: false }
  else { ...recoveryFinished(KeyExpired, r), pending: false, saved: 0, receipt: noReceipt, keyRemoval: reason,
    removedKey: r.runSaved, removedLate: r.runReceipt.expired, removal: RemovalExpired, revoked: true, removedReceipt: r.receipt,
    expiredReports: r.expiredReports + 1 }
}
pure def expireKey(a: Activation): Activation = { ...a, recovery: expireKeyRecovery(a.recovery) }
pure def canReplaceDuringRecovery(a: Activation): bool = not(a.recovery.replaced) and
  (a.recovery.phase == Sending or a.recovery.phase == Waiting or a.recovery.phase == SendingLate or a.recovery.phase == WaitingLate or
    a.recovery.phase == Confirming or a.recovery.phase == ExpiringRefused or a.recovery.phase == ExpiringUnconfirmed)
pure def replaceDuringRecovery(a: Activation): Activation = { ...a, recovery: { ...a.recovery, replaced: true, receipt: newerReceipt, saved: newerKey } }
pure def canCloseRecovery(a: Activation): bool = a.recovery.live
pure def closeRecovery(a: Activation): Activation = { ...a, recovery: { ...a.recovery, live: false } }
pure def alwaysAckUsesRunReceipt(a: Activation): bool = {
  val r = a.recovery
  r.post != noPost implies (r.runReceipt.present and r.runReceipt.parsed and r.post.late == r.runReceipt.expired and
    r.post.environment == r.runReceipt.environment and r.post.credential == r.runReceipt.credential and r.post.credential == r.post.saved)
}
pure def alwaysRecoveryRetryBudget(a: Activation): bool = {
  val r = a.recovery
  r.calls >= 0 and r.calls <= 3 and r.latePosts >= 0 and r.latePosts <= 1 and not(r.calls > 0 and r.latePosts > 0) and
    (r.phase == Waiting implies r.calls > 0) and (r.phase == Sending implies r.calls < 3)
}
pure def alwaysSavedKeyRemovedOnlyWhenDead(a: Activation): bool = {
  val r = a.recovery
  r.saved == (if (r.keyRemoval != NoKeyRemoval) 0 else if (r.replaced) newerKey else r.initialSaved) and
    (r.keyRemoval != NoKeyRemoval implies (r.revoked and r.expiredReports > 0 and
      r.removedKey == (if (r.replaced) newerKey else r.initialSaved) and (r.keyRemoval == RemovedUnconfirmed) == r.removedLate))
}
pure def alwaysDeadKeyNotLeftSaved(a: Activation): bool =
  a.recovery.verdict == KeyExpired implies (a.recovery.saved == 0 and not(a.recovery.receipt.present) and a.recovery.revoked)
pure def alwaysNewerSignInSurvives(a: Activation): bool =
  (a.recovery.replaced and a.recovery.receipt != newerReceipt) implies a.recovery.removedReceipt == newerReceipt
pure def alwaysRemoveOnlyStaleAcknowledgedOrDead(a: Activation): bool = {
  val r = a.recovery
  not(r.initialReceipt.present and not(r.receipt.present) and r.removal == NoRemoval) and
    (r.removal == RemovalStale implies (r.initialReceipt.credential != r.initialSaved or r.initialReceipt.environment != production)) and
    (r.verdict == ReceiptKept implies (r.receipt == r.runReceipt or (r.replaced and r.receipt == newerReceipt)))
}
pure def alwaysReportedOnce(a: Activation): bool = {
  val r = a.recovery
  r.completed >= 0 and r.completed <= r.runs and r.expiredReports >= 0 and r.expiredReports <= 1 and
    ((r.verdict == KeyConfirmed or r.verdict == KeyExpired or r.verdict == RunSuperseded) implies not(r.pending))
}
pure def sometimesStartupConfirmed(a: Activation): bool = a.recovery.verdict == KeyConfirmed and a.recovery.completed == 1
pure def sometimesStartupExpiredAfterDeadline(a: Activation): bool = a.recovery.keyRemoval == RemovedUnconfirmed
pure def sometimesStaleReceiptRemoved(a: Activation): bool = a.recovery.verdict == StaleRemoved and a.recovery.calls == 0
pure def sometimesHandedToBackgroundRounds(a: Activation): bool = a.recovery.verdict == HandedOver and a.recovery.pending
pure def sometimesNewerSignInSurvivedRecovery(a: Activation): bool = a.recovery.verdict == RunSuperseded and a.recovery.saved == newerKey
```
