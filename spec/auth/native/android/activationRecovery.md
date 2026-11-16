# Android activation at startup

At its next start the Android sign-in plugin settles an enrollment receipt
it finds stored, with the same outcomes as the background rounds of
[Android key activation](./activation.md): a confirmed key stays and is
announced; a refused or unconfirmed key is removed with its receipt,
revoked and reported; a newer sign-in's key and receipt are never touched.

## Story: Settle a sign-in left unconfirmed by a restart

> As a person whose app restarted before the cloud confirmed my sign-in, I
> want the app to finish or retire that sign-in at the next start, and never
> to undo a newer sign-in.

### A stored receipt is settled with the same outcomes as the background rounds, by the run that read it

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
import activation as A from "./activation"
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
pure val production = 1
pure val staging = 2
pure val noReceipt: AckReceipt = { present: false, parsed: false, environment: 0, credential: 0, expired: false }
pure val matchingReceipt: AckReceipt = { present: true, parsed: true, environment: production, credential: A::myKey, expired: false }
pure val newerReceipt: AckReceipt = { present: true, parsed: true, environment: production, credential: A::newerKey, expired: false }
pure val noPost: AckPost = { environment: 0, credential: 0, saved: 0, late: false }
pure def recoveryFrom(receipt: AckReceipt, saved: int): AckRecovery = { saved: saved, initialSaved: saved, receipt: receipt,
  initialReceipt: receipt, runReceipt: noReceipt, runSaved: 0, replaced: false, live: true, runs: 0, pending: false,
  phase: RecoveryIdle, calls: 0, latePosts: 0, post: noPost, removal: NoRemoval, verdict: NoRecoveryOutcome,
  keyRemoval: NoKeyRemoval, removedKey: 0, removedLate: false, revoked: false, completed: 0, expiredReports: 0, removedReceipt: noReceipt }
pure val initial: AckRecovery = recoveryFrom(matchingReceipt, A::myKey)
type ReceiptCase = NoStoredReceipt | MatchingStoredReceipt | ReceiptWithoutKey | ReceiptForOtherKey | ReceiptForOtherDeployment | ExpiredStoredReceipt | UnparsedReceipt
type AckReply = ReplyAcknowledged | ReplyAlreadyComplete | ReplyRetryable | ReplyWrongCredential | ReplyDenied | ReplyUnexpected
pure def canLoadReceipt(a: AckRecovery): bool = a.runs == 0 and a.phase == RecoveryIdle
pure def loadReceipt(a: AckRecovery, receiptCase: ReceiptCase): AckRecovery =
  if (receiptCase == NoStoredReceipt) recoveryFrom(noReceipt, A::myKey)
  else if (receiptCase == ReceiptWithoutKey) recoveryFrom(matchingReceipt, 0)
  else if (receiptCase == ReceiptForOtherKey) recoveryFrom(matchingReceipt, A::newerKey)
  else if (receiptCase == ReceiptForOtherDeployment) recoveryFrom({ ...matchingReceipt, environment: staging }, A::myKey)
  else if (receiptCase == ExpiredStoredReceipt) recoveryFrom({ ...matchingReceipt, expired: true }, A::myKey)
  else if (receiptCase == UnparsedReceipt) recoveryFrom({ ...matchingReceipt, parsed: false }, A::myKey)
  else recoveryFrom(matchingReceipt, A::myKey)
pure def recoveryMatches(r: AckRecovery): bool =
  r.receipt.present and r.receipt.parsed and r.receipt.credential == r.saved and r.receipt.environment == production
pure def recoveryFinished(verdict: RecoveryOutcome, r: AckRecovery): AckRecovery = { ...r, phase: RecoveryFinished, verdict: verdict }
pure def canBeginRecovery(a: AckRecovery): bool = a.phase == RecoveryIdle or a.phase == RecoveryFinished
pure def beginRecovery(a: AckRecovery): AckRecovery = { ...a, live: true, runs: a.runs + 1,
  runReceipt: a.receipt, runSaved: a.saved, phase: Reading, calls: 0, latePosts: 0, post: noPost,
  verdict: NoRecoveryOutcome, pending: false }
pure def canReadReceipt(a: AckRecovery): bool = a.phase == Reading
pure def readReceipt(r: AckRecovery, readable: bool): AckRecovery =
  if (not(readable)) recoveryFinished(ReceiptKept, r)
  else if (not(r.receipt.present)) recoveryFinished(ReceiptAbsent, r)
  else if (not(r.receipt.parsed)) recoveryFinished(ReceiptKept, r)
  else if (not(recoveryMatches(r))) { ...r, phase: RemovingStale }
  else if (r.receipt.expired) { ...r, phase: SendingLate, pending: true }
  else { ...r, phase: Sending, pending: true }
pure def canSendAck(a: AckRecovery): bool = a.phase == Sending and a.calls < 3
pure def sendAck(r: AckRecovery): AckRecovery =
  if (r.live) { ...r, phase: Waiting, calls: r.calls + 1, post: { environment: production, credential: r.runReceipt.credential, saved: r.runSaved, late: false } }
  else recoveryFinished(ReceiptKept, r)
pure def canSendLateAck(a: AckRecovery): bool = a.phase == SendingLate and a.latePosts < 1
pure def sendLateAck(r: AckRecovery): AckRecovery =
  if (r.live) { ...r, phase: WaitingLate, latePosts: 1, post: { environment: production, credential: r.runReceipt.credential, saved: r.runSaved, late: true } }
  else recoveryFinished(ReceiptKept, r)
pure def confirmedReply(reply: AckReply): bool = reply == ReplyAcknowledged or reply == ReplyAlreadyComplete
pure def canAckAnswered(a: AckRecovery): bool = a.phase == Waiting
pure def ackAnswered(r: AckRecovery, reply: AckReply): AckRecovery =
  if (not(r.live)) recoveryFinished(ReceiptKept, r)
  else if (confirmedReply(reply)) { ...r, phase: Confirming }
  else if (reply == ReplyDenied) { ...r, phase: ExpiringRefused }
  else if (reply == ReplyRetryable and r.calls < 3) { ...r, phase: Sending }
  else recoveryFinished(HandedOver, r)
pure def canLateAckAnswered(a: AckRecovery): bool = a.phase == WaitingLate
pure def lateAckAnswered(r: AckRecovery, reply: AckReply): AckRecovery =
  if (not(r.live)) recoveryFinished(ReceiptKept, r)
  else if (confirmedReply(reply)) { ...r, phase: Confirming }
  else { ...r, phase: ExpiringUnconfirmed }
pure def canRemoveStale(a: AckRecovery, removed: bool): bool = a.phase == RemovingStale and (not(removed) or a.live)
pure def removeStale(a: AckRecovery, removed: bool): AckRecovery =
  if (removed) { ...recoveryFinished(StaleRemoved, a), receipt: noReceipt, removal: RemovalStale, removedReceipt: a.receipt }
  else recoveryFinished(ReceiptKept, a)
pure def canConfirmKey(a: AckRecovery, removed: bool): bool = a.phase == Confirming and (not(removed) or a.live)
pure def confirmKey(r: AckRecovery, removed: bool): AckRecovery = {
  val own = r.receipt == r.runReceipt
  { ...r, phase: RecoveryFinished, pending: false, receipt: if (own and removed) noReceipt else r.receipt,
    removal: if (own and removed) RemovalAcknowledged else r.removal,
    removedReceipt: if (own and removed) r.receipt else r.removedReceipt,
    completed: r.completed + (if (r.live and r.saved == r.runSaved) 1 else 0),
    verdict: if (not(own)) RunSuperseded else if (removed) KeyConfirmed else ReceiptKept }
}
pure def canExpireKey(a: AckRecovery): bool = a.phase == ExpiringRefused or a.phase == ExpiringUnconfirmed
pure def expireKey(r: AckRecovery): AckRecovery = {
  val reason = if (r.phase == ExpiringRefused) RemovedRefused else RemovedUnconfirmed
  if (not(r.live)) recoveryFinished(ReceiptKept, r)
  else if (r.saved != r.runSaved or r.receipt != r.runReceipt) { ...recoveryFinished(RunSuperseded, r), pending: false }
  else { ...recoveryFinished(KeyExpired, r), pending: false, saved: 0, receipt: noReceipt, keyRemoval: reason,
    removedKey: r.runSaved, removedLate: r.runReceipt.expired, removal: RemovalExpired, revoked: true, removedReceipt: r.receipt,
    expiredReports: r.expiredReports + 1 }
}
pure def canReplaceDuringRecovery(a: AckRecovery): bool = not(a.replaced) and
  (a.phase == Sending or a.phase == Waiting or a.phase == SendingLate or a.phase == WaitingLate or
    a.phase == Confirming or a.phase == ExpiringRefused or a.phase == ExpiringUnconfirmed)
pure def replaceDuringRecovery(a: AckRecovery): AckRecovery = { ...a, replaced: true, receipt: newerReceipt, saved: A::newerKey }
pure def canCloseRecovery(a: AckRecovery): bool = a.live
pure def closeRecovery(a: AckRecovery): AckRecovery = { ...a, live: false }
pure def alwaysAckUsesRunReceipt(r: AckRecovery): bool =
  r.post != noPost implies (r.runReceipt.present and r.runReceipt.parsed and r.post.late == r.runReceipt.expired and
    r.post.environment == r.runReceipt.environment and r.post.credential == r.runReceipt.credential and r.post.credential == r.post.saved)
pure def alwaysRecoveryRetryBudget(r: AckRecovery): bool =
  r.calls >= 0 and r.calls <= 3 and r.latePosts >= 0 and r.latePosts <= 1 and not(r.calls > 0 and r.latePosts > 0) and
    (r.phase == Waiting implies r.calls > 0) and (r.phase == Sending implies r.calls < 3)
pure def alwaysSavedKeyRemovedOnlyWhenDead(r: AckRecovery): bool =
  r.saved == (if (r.keyRemoval != NoKeyRemoval) 0 else if (r.replaced) A::newerKey else r.initialSaved) and
    (r.keyRemoval != NoKeyRemoval implies (r.revoked and r.expiredReports > 0 and
      r.removedKey == (if (r.replaced) A::newerKey else r.initialSaved) and (r.keyRemoval == RemovedUnconfirmed) == r.removedLate))
pure def alwaysDeadKeyNotLeftSaved(a: AckRecovery): bool =
  a.verdict == KeyExpired implies (a.saved == 0 and not(a.receipt.present) and a.revoked)
pure def alwaysNewerSignInSurvives(a: AckRecovery): bool =
  (a.replaced and a.receipt != newerReceipt) implies a.removedReceipt == newerReceipt
pure def alwaysRemoveOnlyStaleAcknowledgedOrDead(r: AckRecovery): bool =
  not(r.initialReceipt.present and not(r.receipt.present) and r.removal == NoRemoval) and
    (r.removal == RemovalStale implies (r.initialReceipt.credential != r.initialSaved or r.initialReceipt.environment != production)) and
    (r.verdict == ReceiptKept implies (r.receipt == r.runReceipt or (r.replaced and r.receipt == newerReceipt)))
pure def alwaysReportedOnce(r: AckRecovery): bool =
  r.completed >= 0 and r.completed <= r.runs and r.expiredReports >= 0 and r.expiredReports <= 1 and
    ((r.verdict == KeyConfirmed or r.verdict == KeyExpired or r.verdict == RunSuperseded) implies not(r.pending))
pure def sometimesStartupConfirmed(a: AckRecovery): bool = a.verdict == KeyConfirmed and a.completed == 1
pure def sometimesStartupExpiredAfterDeadline(a: AckRecovery): bool = a.keyRemoval == RemovedUnconfirmed
pure def sometimesStaleReceiptRemoved(a: AckRecovery): bool = a.verdict == StaleRemoved and a.calls == 0
pure def sometimesHandedToBackgroundRounds(a: AckRecovery): bool = a.verdict == HandedOver and a.pending
pure def sometimesNewerSignInSurvivedRecovery(a: AckRecovery): bool = a.verdict == RunSuperseded and a.saved == A::newerKey
```
