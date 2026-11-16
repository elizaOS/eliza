# Android key renewal

The Android sign-in plugin renews the device's cloud key without a new
sign-in. The custody chain is: an exclusive encrypted renewal request, the
successor's secret and proof, the cloud's exact acknowledgement, a durable
confirmation, a durable duty to retire the predecessor, and only then the
successor selected as the saved key. The cloud side, which issues the
successor and retires the predecessor, is
[native clients](../../../cloud/nativeClients.md). Keys are numbered: `1`
is the key the device holds, `2` its successor and `3` a key a newer
sign-in saved.

## Story: Renew the device key without signing in again

> As a person whose device stays signed in, I want its key renewed in the
> background, and never to be left with no working key or to be signed out
> by a renewal that went wrong.

### A renewal holds an exclusive durable request before anything is sent

A due check claims the renewal by writing an encrypted request record,
which compare-and-set refuses while any request or secret record exists:
a second instance of the same generation is blocked, and a request left
by a crash is never taken over, even after a timeout. The request is
dispatched only by its exact owner, only while the saved key is still the
old one and its plain preference record committed; otherwise nothing is
sent. A dispatched request stays claimed on every refusal or transport
uncertainty, so a predecessor is dispatched at most once.

```quint
type RenewJournal = JournalNone | JournalRequest | JournalPending | JournalConfirmed | JournalForeign
type RenewPhase = RenewIdle | RenewClaim | RenewClaimed | RenewAsked | RenewToken | RenewStage | RenewAck | RenewConfirm | RenewDuty | RenewPublish | RenewCleanup | RenewRevokeOld | RenewFinished
type RenewOutcome = NoRenewOutcome | RenewUnavailable | RenewDeferred | RenewSignInRequired | RenewCurrent | RenewDone
type ServerKey = ServerNone | ServerMinted | ServerActive
type RenewalAnswer = RenewCode | RenewRefused | RenewKeyRefused | RenewRetry
type KeyRenewal = { saved: int, intentCurrent: bool, attemptActive: bool, live: bool, supersededSaved: int,
  installed: bool, partialWrite: bool, journal: RenewJournal, claimOwner: int, worker: int, foreignJournal: bool,
  duty: bool, server: ServerKey, oldAccepted: bool, successorConfirmed: bool, phase: RenewPhase, rounds: int,
  requests: int, recorded: bool, ackWithoutCustody: bool, renewedTwice: bool, oldRevokeSent: bool,
  announced: bool, keyRefused: bool, competitorBlocked: bool, verdict: RenewOutcome }
pure val oldKey = 1
pure val successorKey = 2
pure val initial: KeyRenewal = { saved: oldKey, intentCurrent: true, attemptActive: false, live: true, supersededSaved: -1,
  installed: false, partialWrite: false, journal: JournalNone, claimOwner: 0, worker: 1, foreignJournal: false,
  duty: false, server: ServerNone, oldAccepted: true, successorConfirmed: false, phase: RenewIdle, rounds: 0,
  requests: 0, recorded: false, ackWithoutCustody: false, renewedTwice: false, oldRevokeSent: false,
  announced: false, keyRefused: false, competitorBlocked: false, verdict: NoRenewOutcome }
pure val ackRounds = 6
pure def owns(k: KeyRenewal): bool = k.live and k.intentCurrent and not(k.attemptActive)
pure def holdsSecret(k: KeyRenewal): bool = k.journal == JournalPending or k.journal == JournalConfirmed
pure def finishWith(verdict: RenewOutcome, k: KeyRenewal): KeyRenewal = { ...k, phase: RenewFinished, verdict: verdict }
pure def canCheck(k: KeyRenewal): bool = (k.phase == RenewIdle or k.phase == RenewFinished) and k.live
pure def check(k: KeyRenewal, due: bool, supported: bool): KeyRenewal =
  if (not(supported)) finishWith(RenewUnavailable, k)
  else if (not(owns(k))) finishWith(RenewDeferred, k)
  else if (k.journal == JournalConfirmed) { ...k, phase: RenewDuty }
  else if (k.journal == JournalPending and k.rounds < ackRounds) { ...k, phase: RenewAck }
  else if (k.journal == JournalRequest) finishWith(RenewSignInRequired, k)
  else if (k.journal != JournalNone) finishWith(RenewDeferred, k)
  else if (k.saved != oldKey or not(due)) finishWith(RenewCurrent, k)
  else { ...k, phase: RenewClaim, worker: 1, verdict: NoRenewOutcome }
pure def canCompetingClaim(k: KeyRenewal): bool = k.live and k.intentCurrent
pure def competingClaim(k: KeyRenewal): KeyRenewal =
  if (k.journal != JournalNone) { ...k, competitorBlocked: true }
  else if (k.phase == RenewIdle or k.phase == RenewFinished) { ...k, journal: JournalRequest, claimOwner: 2, worker: 2, phase: RenewClaimed }
  else k
pure def canClaim(k: KeyRenewal): bool = k.phase == RenewClaim
pure def claim(k: KeyRenewal, stored: bool): KeyRenewal =
  if (stored and owns(k) and k.journal == JournalNone) { ...k, journal: JournalRequest, claimOwner: k.worker, phase: RenewClaimed }
  else finishWith(RenewDeferred, k)
pure def canDispatch(k: KeyRenewal): bool = k.phase == RenewClaimed
pure def dispatch(k: KeyRenewal, recordStored: bool): KeyRenewal =
  if (not(owns(k)) or k.journal != JournalRequest or k.claimOwner != k.worker) finishWith(RenewDeferred, k)
  else if (not(recordStored) or k.saved != oldKey or k.recorded) finishWith(RenewDeferred, { ...k, journal: JournalNone, claimOwner: 0 })
  else { ...k, phase: RenewAsked, recorded: true, requests: k.requests + 1, renewedTwice: k.renewedTwice or k.successorConfirmed }
pure def canRenewReply(k: KeyRenewal): bool = k.phase == RenewAsked
pure def renewReply(k: KeyRenewal, answer: RenewalAnswer): KeyRenewal =
  if (answer == RenewKeyRefused) finishWith(RenewSignInRequired, { ...k, keyRefused: true, oldAccepted: false })
  else if (answer == RenewCode) { ...k, phase: RenewToken }
  else finishWith(if (answer == RenewRefused) RenewSignInRequired else RenewDeferred, k)
pure def canLosePreferences(k: KeyRenewal): bool = k.recorded
pure def losePreferences(k: KeyRenewal): KeyRenewal = { ...k, recorded: false }
pure def alwaysOnePredecessorDispatch(k: KeyRenewal): bool = k.requests >= 0 and k.requests <= 1
pure def alwaysNeverRenewsAfterConfirmedSuccessor(k: KeyRenewal): bool = not(k.renewedTwice)
pure def sometimesCompetitorBlocked(k: KeyRenewal): bool = k.competitorBlocked and k.requests == 0
```

### Only an exact acknowledgement of durably staged custody confirms the successor

The successor's secret and proof are staged as a full encrypted receipt
over the exact request and read back; a failure leaves the request, and a
lost claim never sends an acknowledgement. Only an exact acknowledgement
with the credential id lets the successor through; a token exchange that
reports authorization complete is not that receipt. A refusal keeps
custody, because an earlier acknowledgement may still be in flight, and a
lost reply commits remotely only. The acknowledgement is retried at most
six times.

```quint
type AckAnswer = AckAcknowledged | AckExchangeComplete | AckRetry | AckLost | AckRefused | AckRefusedAfterCommit
pure def canTokenReply(k: KeyRenewal): bool = k.phase == RenewToken
pure def tokenReply(k: KeyRenewal, minted: bool): KeyRenewal =
  if (minted) { ...k, server: ServerMinted, phase: RenewStage } else finishWith(RenewDeferred, k)
pure def canStage(k: KeyRenewal): bool = k.phase == RenewStage
pure def stage(k: KeyRenewal, stored: bool): KeyRenewal =
  if (stored and owns(k) and k.journal == JournalRequest and k.claimOwner == k.worker and k.saved == oldKey)
    { ...k, journal: JournalPending, phase: RenewAck }
  else finishWith(RenewDeferred, k)
pure def canReplaceRequest(k: KeyRenewal): bool = k.journal == JournalRequest and k.server != ServerActive
pure def replaceRequest(k: KeyRenewal): KeyRenewal = { ...k, journal: JournalForeign, foreignJournal: true, claimOwner: 0 }
pure def canAckReply(k: KeyRenewal): bool = k.phase == RenewAck and k.rounds < ackRounds
pure def answerAck(answer: AckAnswer, k: KeyRenewal): KeyRenewal = {
  val sent = { ...k, rounds: k.rounds + 1, ackWithoutCustody: k.ackWithoutCustody or not(holdsSecret(k)) }
  if (answer == AckAcknowledged) { ...sent, server: ServerActive, successorConfirmed: true, phase: RenewConfirm }
  else if (answer == AckLost) finishWith(RenewDeferred, { ...sent, server: ServerActive, successorConfirmed: true })
  else if (answer == AckRefusedAfterCommit) finishWith(RenewSignInRequired, { ...sent, server: ServerActive, successorConfirmed: true })
  else finishWith(if (answer == AckRefused) RenewSignInRequired else RenewDeferred, sent)
}
pure def ackReply(k: KeyRenewal, answer: AckAnswer): KeyRenewal =
  if (not(owns(k)) or k.journal != JournalPending) finishWith(RenewDeferred, k)
  else answerAck(answer, k)
pure def canConfirmSuccessor(k: KeyRenewal): bool = k.phase == RenewConfirm
pure def confirmSuccessor(k: KeyRenewal, stored: bool): KeyRenewal =
  if (stored and owns(k) and k.journal == JournalPending) { ...k, journal: JournalConfirmed, phase: RenewDuty }
  else finishWith(RenewDeferred, k)
pure def alwaysAckRequiresDurableCustody(k: KeyRenewal): bool = not(k.ackWithoutCustody) and k.rounds >= 0 and k.rounds <= ackRounds
pure def alwaysActiveSuccessorRecoverable(k: KeyRenewal): bool =
  (k.successorConfirmed and k.intentCurrent) implies (holdsSecret(k) or k.saved == successorKey)
pure def sometimesLostAckKeepsCustody(k: KeyRenewal): bool = k.successorConfirmed and k.journal == JournalPending and k.phase == RenewFinished
```

### The predecessor is retired only after the successor is durably selected

After confirmation the plugin records a durable duty to retire the
predecessor, then selects the successor. A partial host write can leave no
key selected; the confirmed receipt and the duty are enough to repair it
under the same generation. The receipt is cleaned up and the old key is
revoked only once the successor is the saved key, and the renewal is
announced only then. A working key stays saved until it is replaced. A
renewal can run to the end, with the successor saved and the old key
retired.

```quint
type Publication = PublishStored | PublishFailed | PublishPartial
pure def canRetirementDuty(k: KeyRenewal): bool = k.phase == RenewDuty
pure def retirementDuty(k: KeyRenewal, stored: bool): KeyRenewal =
  if (stored and owns(k) and k.journal == JournalConfirmed) { ...k, duty: true, phase: RenewPublish }
  else finishWith(RenewDeferred, k)
pure def canPublish(k: KeyRenewal): bool = k.phase == RenewPublish
pure def publish(k: KeyRenewal, publication: Publication): KeyRenewal =
  if (not(owns(k)) or k.journal != JournalConfirmed or not(k.duty)) finishWith(RenewDeferred, k)
  else if (publication == PublishStored) { ...k, saved: successorKey, installed: true, partialWrite: false, phase: RenewCleanup }
  else if (publication == PublishPartial) finishWith(RenewDeferred, { ...k, saved: 0, partialWrite: true })
  else finishWith(RenewDeferred, k)
pure def canCleanup(k: KeyRenewal): bool = k.phase == RenewCleanup
pure def cleanup(k: KeyRenewal, stored: bool): KeyRenewal =
  if (owns(k) and k.saved == successorKey and k.journal == JournalConfirmed)
    { ...k, journal: if (stored) JournalNone else k.journal, phase: RenewRevokeOld }
  else finishWith(RenewDeferred, k)
pure def canRevokeOld(k: KeyRenewal): bool = k.phase == RenewRevokeOld
pure def revokeOld(k: KeyRenewal): KeyRenewal =
  if (owns(k) and k.saved == successorKey and k.duty) finishWith(RenewDone, { ...k, oldRevokeSent: true, oldAccepted: false, announced: true })
  else finishWith(RenewDeferred, k)
pure def alwaysPublicationRequiresConfirmedReceipt(k: KeyRenewal): bool = k.installed implies (k.server == ServerActive and k.duty)
pure def alwaysPartialPublicationRecoverable(k: KeyRenewal): bool =
  (k.partialWrite and k.intentCurrent) implies (k.journal == JournalConfirmed and k.duty)
pure def alwaysOldKeyRevokedOnlyAfterInstall(k: KeyRenewal): bool = k.oldRevokeSent implies k.installed
pure def alwaysAnnouncedOnlyWhenRenewed(k: KeyRenewal): bool = k.announced implies k.installed
pure def alwaysWorkingKeyKept(k: KeyRenewal): bool =
  (not(k.installed) and k.supersededSaved == -1 and not(k.partialWrite)) implies k.saved == oldKey
pure def alwaysSavedKeyAcceptedOrReportedRefused(k: KeyRenewal): bool =
  (k.saved == oldKey and k.supersededSaved == -1 and not(k.keyRefused)) implies k.oldAccepted
pure def sometimesPartialPublicationLeavesNoKey(k: KeyRenewal): bool = k.partialWrite and k.saved == 0 and k.duty
pure def sometimesRenewed(k: KeyRenewal): bool = k.verdict == RenewDone and k.saved == successorKey
pure val weight_check = 40
pure val weight_claim = 40
pure val weight_dispatch = 40
pure val weight_renewReply = 40
pure val weight_tokenReply = 40
pure val weight_stage = 40
pure val weight_ackReply = 40
pure val weight_confirmSuccessor = 40
pure val weight_retirementDuty = 40
pure val weight_publish = 40
pure val weight_cleanup = 40
pure val weight_revokeOld = 40
```

### A newer credential action, a restart or a sign-in wins over a renewal

A sign-out or a newer sign-in saves its own key and journal; a renewal never
overwrites them and recovers nothing under the older intent. A restart
adopts the original durable generation and continues from the journal; a
sign-in in progress defers the renewal. Losing the plain preference record
cannot free an encrypted request or receipt.

```quint
pure def canSignInStarts(k: KeyRenewal): bool = not(k.attemptActive)
pure def signInStarts(k: KeyRenewal): KeyRenewal = { ...k, attemptActive: true }
pure def canCredentialAction(k: KeyRenewal): bool = k.intentCurrent
pure def credentialAction(k: KeyRenewal, replacement: int): KeyRenewal =
  { ...k, intentCurrent: false, attemptActive: false, saved: replacement, supersededSaved: replacement,
    journal: JournalForeign, foreignJournal: true, claimOwner: 0 }
pure def canDestroy(k: KeyRenewal): bool = k.live
pure def destroy(k: KeyRenewal): KeyRenewal = { ...k, live: false }
pure def canRestart(k: KeyRenewal): bool = not(k.live)
pure def restart(k: KeyRenewal): KeyRenewal = { ...k, live: true, phase: RenewIdle, worker: 3 }
pure val replacementValues = Set(0, 3)
pure def alwaysNewerActionWins(k: KeyRenewal): bool = k.supersededSaved != -1 implies k.saved == k.supersededSaved
pure def alwaysNewerJournalPreserved(k: KeyRenewal): bool = k.foreignJournal implies k.journal == JournalForeign
pure def sometimesNewerIntentFencedRecovery(k: KeyRenewal): bool = k.supersededSaved == 3 and k.successorConfirmed
```
