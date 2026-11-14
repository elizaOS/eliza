# Native Cloud enrollment and credential custody

Grace wraps `createNativeCloudAuth` from
`packages/auth/native-host/cloud-enrollment.mjs` and `createCloudRoutes`
from `packages/cloud/sdk/native-host/cloud-services.mjs` at its Eliza pin.
Its renderer uses the native config, start, verify, MFA, resume and cancel
routes. The product turns off the generic Google and browser routes and
installs its own API-only Google return. The producer's enrollment epoch,
pending receipt, active credential, verified owner and revocation receipt
are separate pieces of state. Grace's `NativeEnrollment.tla`,
`SetupSignInCancel.tla` and `AccountKeyCustody.tla` provide source cases.
The first two carry older route annotations. The pinned source now maps
`/cloud/native/cancel` to `cancel()` and `/cloud/logout` to
`cancel({ disconnect: true })`.

## Story: Recover enrollment safely after a lost acknowledgement

### A saved credential remains private and cannot activate before acknowledgement

The host validates the application binding and maintains one enrollment
operation. The verified email, phone or Google session supplies authority
for mobile PKCE. The host saves the exact pending proof before contacting
the mobile acknowledgement endpoint. The returned credential ID and
expiry must match the receipt contract. Recovery uses the saved proof
for the same application binding. A lost reply can be retried even
past the original acknowledgement deadline because a landed ack is
replayable. The Cloud decides whether the grant can still be acknowledged.
In verified-account mode the host resolves the exact authority origin,
user and organization with the acknowledged credential. It checks the
stored verified owner, persists and reads back a new owner receipt if
needed, then activates by compare-exchange. A successful result is
published after pending receipt removal. The model represents secrets
and owner tuples by identities and represents storage confirmations as
separate transitions.

```quint
type JournalMode = EmptyJournal | PendingEnrollment | PendingRevocation
type EnrollmentPhase = EnrollmentIdle | CheckingSession | Acknowledging | VerifyingOwner | StoringOwner | Activating | ClearingEnrollment | WaitingForRevocation
type EnrollmentReply = EnrollmentNoReply | EnrollmentSuccess | EnrollmentCancelled | EnrollmentRefused | EnrollmentOffline
type Enrollment = { epoch: int, ticket: int, phase: EnrollmentPhase, journal: JournalMode, receipt: str, receiptBinding: str, verifiedOwner: str, ownerStored: bool, activeCredential: str, activeOwner: str, disconnecting: bool, reply: EnrollmentReply }
pure val initial: Enrollment = { epoch: 0, ticket: 0, phase: EnrollmentIdle, journal: EmptyJournal, receipt: "", receiptBinding: "", verifiedOwner: "", ownerStored: false, activeCredential: "", activeOwner: "", disconnecting: false, reply: EnrollmentNoReply }
pure def canStartEnrollment(e: Enrollment): bool = e.phase == EnrollmentIdle and e.journal == EmptyJournal and e.activeCredential == ""
pure def startEnrollment(e: Enrollment): Enrollment = { ...e, phase: CheckingSession, ticket: e.epoch, reply: EnrollmentNoReply }
pure def canStoreEnrollment(e: Enrollment, credential: str, binding: str): bool = e.phase == CheckingSession and e.ticket == e.epoch and credential != "" and binding != ""
pure def storeEnrollment(e: Enrollment, credential: str, binding: str): Enrollment = { ...e, phase: Acknowledging, journal: PendingEnrollment, receipt: credential, receiptBinding: binding }
pure def canResumeEnrollment(e: Enrollment, binding: str): bool = e.phase == EnrollmentIdle and e.journal == PendingEnrollment and e.receiptBinding == binding
pure def resumeEnrollment(e: Enrollment, binding: str): Enrollment = { ...e, phase: Acknowledging, ticket: e.epoch, reply: EnrollmentNoReply }
pure def canObserveAcknowledgement(e: Enrollment): bool = e.phase == Acknowledging and e.ticket == e.epoch
pure def observeAcknowledgement(e: Enrollment, credential: str, expiryValid: bool, transportFailed: bool): Enrollment =
  if (transportFailed) { ...e, phase: EnrollmentIdle, reply: EnrollmentOffline }
  else if (credential != e.receipt or not(expiryValid)) { ...e, phase: EnrollmentIdle, reply: EnrollmentRefused }
  else { ...e, phase: VerifyingOwner }
pure def canObserveOwner(e: Enrollment, owner: str): bool = e.phase == VerifyingOwner and e.ticket == e.epoch and owner != ""
pure def observeOwner(e: Enrollment, owner: str): Enrollment =
  if (e.ownerStored and owner != e.verifiedOwner) { ...e, phase: EnrollmentIdle, reply: EnrollmentRefused }
  else if (e.ownerStored) { ...e, phase: Activating }
  else { ...e, phase: StoringOwner, verifiedOwner: owner }
pure def canConfirmOwnerStorage(e: Enrollment): bool = e.phase == StoringOwner and e.ticket == e.epoch
pure def confirmOwnerStorage(e: Enrollment, matchesReadback: bool): Enrollment =
  if (matchesReadback) { ...e, phase: Activating, ownerStored: true }
  else { ...e, phase: EnrollmentIdle, reply: EnrollmentRefused, verifiedOwner: "" }
pure def canConfirmActivation(e: Enrollment): bool = e.phase == Activating and e.ticket == e.epoch
pure def confirmActivation(e: Enrollment, exchanged: bool): Enrollment =
  if (exchanged) { ...e, phase: ClearingEnrollment, activeCredential: e.receipt, activeOwner: e.verifiedOwner }
  else { ...e, phase: EnrollmentIdle, reply: EnrollmentRefused }
pure def clearReceipt(completion: EnrollmentReply, e: Enrollment): Enrollment = { ...e, phase: EnrollmentIdle, journal: EmptyJournal, receipt: "", receiptBinding: "", verifiedOwner: "", ownerStored: false, disconnecting: false, reply: completion }
pure def canPublishEnrollment(e: Enrollment): bool = e.phase == ClearingEnrollment and e.ticket == e.epoch
pure def publishEnrollment(e: Enrollment): Enrollment = clearReceipt(EnrollmentSuccess, e)
pure val credentialValues = Set("", "key-a", "key-b")
pure val bindingValues = Set("app-prod", "app-stage")
pure val ownerValues = Set("", "alice-org-a", "bob-org-b")
pure def alwaysActiveHasOwner(e: Enrollment): bool = (e.activeCredential == "") == (e.activeOwner == "")
pure def alwaysEnrollmentOwnsJournal(e: Enrollment): bool = (e.journal == EmptyJournal) == (e.receipt == "") and (e.journal == PendingEnrollment implies e.receiptBinding != "") and (e.ownerStored implies e.verifiedOwner != "") and ((e.phase == Acknowledging or e.phase == VerifyingOwner or e.phase == StoringOwner or e.phase == Activating or e.phase == ClearingEnrollment) implies e.journal == PendingEnrollment and e.ticket == e.epoch)
pure def alwaysActivationHasOwnerReceipt(e: Enrollment): bool = (e.phase == Activating or e.phase == ClearingEnrollment) implies e.ownerStored and e.verifiedOwner != ""
pure def alwaysOwnerWriteHasTuple(e: Enrollment): bool = e.phase == StoringOwner implies e.verifiedOwner != "" and not(e.ownerStored)
pure def alwaysClearingFollowsActivation(e: Enrollment): bool = e.phase == ClearingEnrollment implies e.activeCredential == e.receipt and e.activeOwner == e.verifiedOwner
pure def sometimesEnrollmentAuthenticated(e: Enrollment): bool = e.reply == EnrollmentSuccess
pure def sometimesPendingAckCanResume(e: Enrollment): bool = e.phase == EnrollmentIdle and e.journal == PendingEnrollment and e.reply == EnrollmentOffline
```

### Cancel retires the pending attempt and logout retires the connected key

Cancellation invalidates the enrollment epoch and waits for in-flight
storage and network work before consulting the journal. Once the
revocation marker is durable, resume cannot activate it. The operation
revokes only the journaled credential and clears its journal after an
exact, valid revocation response. A lost or invalid response leaves the
revocation journal pending. Ordinary cancellation can clear an active
credential if it is the same key already journaled by that incomplete
attempt. It preserves an unrelated active credential. Logout clears an
active credential, journaling it first when it is a revocable Cloud key.
A different pending receipt must finish before that logout can proceed.
This slice starts at the host's serialized point after waiting for
outstanding work and abstracts a validated Cloud key by a nonempty ID.

```quint
pure def canBeginCancel(e: Enrollment, disconnect: bool): bool = e.phase != WaitingForRevocation and (not(disconnect) or e.activeCredential == "" or e.receipt == "" or e.receipt == e.activeCredential)
pure def beginCancel(e: Enrollment, disconnect: bool): Enrollment = {
  val revokeKey = if (e.receipt != "") e.receipt else if (disconnect) e.activeCredential else ""
  { ...e, epoch: e.epoch + 1, phase: if (revokeKey != "") WaitingForRevocation else EnrollmentIdle,
    journal: if (revokeKey != "") PendingRevocation else EmptyJournal, receipt: revokeKey,
    activeCredential: if (disconnect) "" else e.activeCredential, activeOwner: if (disconnect) "" else e.activeOwner,
    disconnecting: disconnect and revokeKey != "", reply: if (revokeKey != "") EnrollmentNoReply else EnrollmentCancelled }
}
pure def canRetryRevocation(e: Enrollment): bool = e.phase == EnrollmentIdle and e.journal == PendingRevocation
pure def retryRevocation(e: Enrollment): Enrollment = { ...e, phase: WaitingForRevocation, reply: EnrollmentNoReply }
pure def canObserveRevocation(e: Enrollment): bool = e.phase == WaitingForRevocation
pure def observeRevocation(e: Enrollment, credential: str, revoked: bool): Enrollment =
  if (not(revoked) or credential != e.receipt) { ...e, phase: EnrollmentIdle, reply: EnrollmentOffline }
  else { ...clearReceipt(EnrollmentCancelled, e), activeCredential: if (e.activeCredential == credential) "" else e.activeCredential, activeOwner: if (e.activeCredential == credential) "" else e.activeOwner }
pure def alwaysRevocationOwnsJournal(e: Enrollment): bool = e.phase == WaitingForRevocation implies e.journal == PendingRevocation
pure def stepResumeCannotActivateRevocation(before: Enrollment, via: str, after: Enrollment): bool = via != "resumeEnrollment" or before.journal == PendingEnrollment
pure def sometimesLostRevocationRetainsJournal(e: Enrollment): bool = e.phase == EnrollmentIdle and e.journal == PendingRevocation and e.reply == EnrollmentOffline
```
