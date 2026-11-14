# Inbox drafts and provider review custody

Alpha's shipping Inbox installs `inbox-cloud-adapter.ts` from `main.tsx`
outside the browser development profile. Its `inbox-drafts.ts` and
`inbox-provider-controls.ts` instantiate the pinned Eliza mailbox
`drafts-controller.ts`, `review-controller.ts` and `operation-journal.ts`.
The pins are Alpha `8d44dfe52` and Eliza `c518127a`. The local draft store,
retained edit coalescer and receipt guard are injected by Alpha. The
[Inbox cache](./inboxCache.md) owns mailbox reads. [Managed Google](./managedGoogle.md)
owns remote send admission and its receipt. This model owns the installed
client records and the transition from a reviewed local draft to one
provider request.

## Story: Keep drafts recoverable across account switches and provider failures

### Saved and retained content belongs to the exact From account

The saved slot uses `inbox-drafts:v1:<owner>`, and the shelf uses
`inbox-drafts:v1:shelf:<sha256(owner)>`. Owner is the JSON tuple
of environment, Cloud user, organization or empty string, and Gmail grant.
The current Cloud session must match the account session to bind. A
new binding retires pending publication from the old binding. Same-owner
in-memory edits may resume, but a newer saved revision fences their next
write until the conflict is reviewed.

Saving compares against the exact saved value. Shelving writes the full
shelf by compare-and-exchange before clearing the old saved and retained
copies. Within one draft ID the current composer wins over retained edits,
which win over the saved row and existing shelf row. A failed later cleanup
may leave copies in both locations. A malformed saved or shelf record
opens recovery without an empty overwrite. The draft and shelf each have
an 8 MiB serialized UTF-8 bound. A shelf contains at most 50 distinct
draft IDs and can retain uncommitted recipient text. The Android store
uses secure slots. The browser uses a scoped document, with the saved
draft owner hashed in its document name. The controller validates local recipients,
attachments and draft layout before writing. The provider journal has its
own 7.5 MiB proposal bound before attempting review.

```quint
type Copy = { id: int, content: int, revision: int }
pure val emptyCopy: Copy = { id: 0, content: 0, revision: 0 }
pure def hasCopy(copy: Copy): bool = copy.id > 0
pure def preferredCopy(shelf: Copy, saved: Copy, retained: Copy, composer: Copy): Copy =
  if (hasCopy(composer)) composer else if (hasCopy(retained)) retained else if (hasCopy(saved)) saved else shelf
type LocalWrite = { currentEpoch: bool, validRecord: bool, expectedRevision: bool, completeBytes: int }
pure val writeValues = Set(
  { currentEpoch: true, validRecord: true, expectedRevision: true, completeBytes: 8388608 },
  { currentEpoch: true, validRecord: true, expectedRevision: false, completeBytes: 1 },
  { currentEpoch: true, validRecord: true, expectedRevision: true, completeBytes: 8388609 },
  { currentEpoch: false, validRecord: true, expectedRevision: true, completeBytes: 1 },
  { currentEpoch: true, validRecord: false, expectedRevision: true, completeBytes: 1 }
)
pure val completeBytesValues = Set(-1, 0, 7864320, 7864321, 8388608, 8388609)
pure def localWriteAllowed(write: LocalWrite): bool =
  write.currentEpoch and write.validRecord and write.expectedRevision and write.completeBytes >= 0 and write.completeBytes <= 8388608
pure def brokerReviewSizeAllowed(completeBytes: int): bool = completeBytes >= 0 and completeBytes <= 7864320
pure def mayClearOldCopies(shelfAcknowledged: bool, currentEpoch: bool): bool = shelfAcknowledged and currentEpoch
pure def lawStaleLocalCopyCannotReplace(write: LocalWrite): bool = not(write.expectedRevision) implies not(localWriteAllowed(write))
pure def lawComposerWinsSameDraft(composer: Copy, shelf: Copy, saved: Copy, retained: Copy): bool =
  hasCopy(composer) implies preferredCopy(shelf, saved, retained, composer) == composer
pure def lawFailedShelfWriteKeepsCopies(currentEpoch: bool): bool = not(mayClearOldCopies(false, currentEpoch))
pure def lawProviderReviewHasSeparateBytes(completeBytes: int): bool = completeBytes > 7864320 implies not(brokerReviewSizeAllowed(completeBytes))
```

### Retained edits coalesce under the owner and flush on departure

Alpha's retained binding is the JSON tuple `["inbox-unsaved", profile, owner]`
and its slot is `inbox-drafts:v1:unsaved:<sha256(binding)>`. The retained
coalescer schedules a zero-delay timer. Each new edit replaces the one waiting
copy. An in-flight write holds the waiting copy until release, unless a
flush explicitly transfers it to the durable controller. Hiding, retiring
or preparing an app update flushes current edits. Retiring stops publication
to the retired view and app update can require readback of the retired
binding. Clear must not consume an edit pushed after the captured content.

```quint
type RetainedWrite = { sameBinding: bool, currentCopy: int, capturedCopy: int, queued: bool }
pure val clearValues = Set(
  { sameBinding: true, currentCopy: 1, capturedCopy: 1, queued: false },
  { sameBinding: true, currentCopy: 2, capturedCopy: 1, queued: true },
  { sameBinding: false, currentCopy: 1, capturedCopy: 1, queued: false }
)
pure def mayClearRetained(clear: RetainedWrite): bool =
  clear.sameBinding and clear.capturedCopy > 0 and clear.currentCopy == clear.capturedCopy and not(clear.queued)
pure def retainedWriteDue(hasWaiting: bool, timerDue: bool, writeInFlight: bool, flushRequested: bool): bool =
  hasWaiting and (flushRequested or (timerDue and not(writeInFlight)))
pure def lawLaterEditSurvivesClear(clear: RetainedWrite): bool =
  clear.queued or clear.currentCopy != clear.capturedCopy implies not(mayClearRetained(clear))
pure def lawBusyTimerKeepsWaiting(hasWaiting: bool, timerDue: bool): bool =
  not(retainedWriteDue(hasWaiting, timerDue, true, false))
```

### A provider request is bound to the current draft and reserves its one dispatch durably

The operation slot is `inbox-operation:v1:<sha256(JSON.stringify([owner, grantId]))>`.
Its owner is the Cloud environment, user and organization tuple. Only one
record occupies that slot. The request ID and complete proposal survive
retry. Review compares draft identity and the serialized mode, recipients,
subject, body, attachments, forward attachments and reply source against
the composer. A changed or replaced composer discards the unsent review.
An absent composer blocks confirmation while the review stays saved.
Delete has its own permanent-delete review and needs no active composer.

A fresh confirmation checks current operation capability, composer
binding and reviewed forward capability. Acknowledged durable reservation
precedes network dispatch. A saved reservation with a lost acknowledgement
cannot cause a dispatch in the acknowledging caller, and a restarted
caller can only read its receipt. Model integers denote distinct exact
identities, one journal slot and one visible binding generation. Loading
another slot is modeled by a state machine for that slot. The attached
session epoch fences callback and dispatch authority within the slot.

```quint
type MailKind = NoMail | CreateMail | ReplaceMail | DeleteMail | SendMail
type MailPhase = EmptyJournal | PreparingMail | ReviewingMail | ReservedMail | DispatchUnknown | ObservedUnknown | SucceededMail | RefusedMail
type MailReceipt = PreparedReceipt | UnknownReceipt | SuccessReceipt | RefusalReceipt
type Reservation = ReservationAck | ReservationLost | ReservationFailed
type MailState = { epoch: int, attached: bool, composer: Copy, phase: MailPhase, kind: MailKind, request: int, lastRequest: int, review: int, remoteRevision: int, captured: Copy, forwarded: bool, dispatchEpoch: int, dispatches: int, sentMessage: int, cleanupHeld: bool, cleanupReady: bool, localReference: int, referenceRequest: int }
pure val initial: MailState = { epoch: 0, attached: false, composer: emptyCopy, phase: EmptyJournal, kind: NoMail, request: 0, lastRequest: 0, review: 0, remoteRevision: 0, captured: emptyCopy, forwarded: false, dispatchEpoch: 0, dispatches: 0, sentMessage: 0, cleanupHeld: false, cleanupReady: false, localReference: 0, referenceRequest: 0 }
pure val copyValues = Set(emptyCopy, { id: 1, content: 1, revision: 1 }, { id: 1, content: 2, revision: 1 }, { id: 2, content: 1, revision: 2 })
pure val composerValues = copyValues
pure val shelfValues = copyValues
pure val savedValues = copyValues
pure val retainedValues = copyValues
pure val requestIdValues = Set(1, 2, 3)
pure val digestValues = Set(1, 2)
pure val revisionValues = Set(0, 1, 2)
pure val messageValues = Set(0, 1, 2)
pure val epochIdValues = Set(1, 2, 3, 4, 5)
pure def needsComposer(mailKind: MailKind): bool = mailKind == CreateMail or mailKind == ReplaceMail or mailKind == SendMail
pure def sameComposed(before: Copy, shown: Copy): bool = hasCopy(before) and before.id == shown.id and before.content == shown.content
pure val weight_prepareMail = 8
pure val weight_observeReview = 10
pure val weight_reserveDispatch = 10
pure val weight_adoptProviderReference = 18
pure val weight_readReceipt = 10
pure def canOpenBinding(s: MailState): bool = not(s.attached)
pure def openBinding(s: MailState): MailState = { ...s, attached: true, epoch: s.epoch + 1 }
pure def canRetireBinding(s: MailState): bool = s.attached
pure def retireBinding(s: MailState): MailState = { ...s, attached: false, composer: emptyCopy, dispatchEpoch: 0, cleanupHeld: s.cleanupHeld or (s.kind == SendMail and s.phase == SucceededMail), cleanupReady: false }
pure def canShowComposer(s: MailState): bool = s.attached
pure def showComposer(s: MailState, copy: Copy): MailState = { ...s, composer: copy }
pure def canPrepareMail(s: MailState, mailKind: MailKind, requestId: int, revision: int, fromForward: bool, capability: bool): bool =
  s.attached and s.phase == EmptyJournal and capability and requestId > s.lastRequest and
  (needsComposer(mailKind) or mailKind == DeleteMail) and
  (not(needsComposer(mailKind)) or hasCopy(s.composer)) and
  (not(mailKind == DeleteMail) or not(fromForward)) and
  (not(mailKind == ReplaceMail or mailKind == DeleteMail) or revision > 0)
pure def prepareMail(s: MailState, mailKind: MailKind, requestId: int, revision: int, fromForward: bool, capability: bool): MailState =
  { ...s, phase: PreparingMail, kind: mailKind, request: requestId, lastRequest: requestId, captured: s.composer, remoteRevision: revision, forwarded: fromForward }
pure def observedPhase(receipt: MailReceipt): MailPhase =
  if (receipt == SuccessReceipt) SucceededMail else if (receipt == RefusalReceipt) RefusedMail
  else if (receipt == UnknownReceipt) ObservedUnknown else ReviewingMail
pure def canObserveReview(s: MailState, epochId: int, requestId: int, mailKind: MailKind, digest: int, exactProposal: bool): bool =
  s.attached and s.epoch == epochId and s.phase == PreparingMail and requestId == s.request and mailKind == s.kind and digest > 0 and exactProposal
pure def observeReview(s: MailState, epochId: int, requestId: int, mailKind: MailKind, digest: int, exactProposal: bool, receipt: MailReceipt, message: int): MailState = {
  val confirmed = receipt == SuccessReceipt and mailKind == SendMail and message > 0
  { ...s, phase: observedPhase(receipt), review: digest,
    sentMessage: if (confirmed) message else 0, cleanupReady: confirmed }
}
pure def canReserveDispatch(s: MailState, capability: bool, forwardAllowed: bool): bool =
  s.attached and s.phase == ReviewingMail and capability and (not(s.forwarded) or forwardAllowed) and
  (not(needsComposer(s.kind)) or sameComposed(s.captured, s.composer))
pure def reserveDispatch(s: MailState, capability: bool, forwardAllowed: bool, result: Reservation): MailState =
  if (result == ReservationFailed) s
  else { ...s, phase: ReservedMail, dispatchEpoch: if (result == ReservationAck) s.epoch else 0 }
pure def canDispatchMail(s: MailState): bool =
  s.attached and s.phase == ReservedMail and s.dispatchEpoch == s.epoch and s.dispatchEpoch > 0
pure def dispatchMail(s: MailState): MailState =
  { ...s, phase: DispatchUnknown, dispatchEpoch: 0, dispatches: 1 }
pure def emptyJournal(empty: Copy, s: MailState): MailState =
  { ...initial, attached: s.attached, epoch: s.epoch, composer: s.composer, lastRequest: s.lastRequest, localReference: s.localReference }
pure def canDiscardStaleReview(s: MailState): bool =
  s.attached and (s.phase == PreparingMail or s.phase == ReviewingMail) and
  needsComposer(s.kind) and hasCopy(s.composer) and not(sameComposed(s.captured, s.composer))
pure def discardStaleReview(s: MailState): MailState = emptyJournal(emptyCopy, s)
pure def alwaysRecordHasIdentity(s: MailState): bool =
  s.lastRequest >= 0 and (
    if (s.phase == EmptyJournal) s.request == 0 and s.kind == NoMail
    else s.request > 0 and s.request == s.lastRequest and s.kind != NoMail and (not(needsComposer(s.kind)) or hasCopy(s.captured)))
pure def alwaysReviewAfterPrepareHasDigest(s: MailState): bool =
  (s.phase != EmptyJournal and s.phase != PreparingMail) implies s.review > 0
pure def alwaysDispatchPermitOwnsReservation(s: MailState): bool =
  s.dispatchEpoch == 0 or (s.attached and s.epoch == s.dispatchEpoch and s.phase == ReservedMail)
pure def alwaysEpochHasOwner(s: MailState): bool = s.epoch >= 0 and (s.attached implies s.epoch > 0)
pure def alwaysDispatchAtMostOnce(s: MailState): bool =
  (s.dispatches == 0 or s.dispatches == 1) and
  ((s.phase == EmptyJournal or s.phase == PreparingMail or s.phase == ReviewingMail or s.phase == ReservedMail) implies s.dispatches == 0)
pure def stepDispatchHasDurableReservation(before: MailState, via: str, after: MailState): bool =
  via == "dispatchMail" implies before.phase == ReservedMail and before.dispatches == 0 and after.dispatches == 1
pure def stepReservationCannotChangeRequest(before: MailState, via: str, after: MailState): bool =
  via == "reserveDispatch" implies before.request == after.request and before.review == after.review and before.captured == after.captured
pure def sometimesUnacknowledgedReservation(s: MailState): bool = s.phase == ReservedMail and s.dispatchEpoch == 0
pure def sometimesDispatchInDoubt(s: MailState): bool = s.phase == DispatchUnknown and s.dispatches == 1
```

### Recovery reads the recorded request and cannot resend it

Recovery of an unreviewed proposal may repeat the idempotent preparation.
Once the durable reservation exists, recovery uses a receipt read. A stale
prepared reply does not regress or clear an attempted operation. A separate
confirmed abandon can observe an exact prepared receipt while the durable
record is still dispatching, warn that a delayed request could arrive,
and only then remove that record. A provider success or rejection needs the
same request, operation kind and review digest. Unknown receipts keep their
durable record. An observed terminal receipt can be retired separately.
Different operations use different request IDs. Increasing model IDs
represent creation order for fresh UUIDs. Clearing a journal is restricted to the explicit abandon,
review-discard or terminal-retirement events.

```quint
pure def receiptAttempt(s: MailState): bool =
  s.phase == ReservedMail or s.phase == DispatchUnknown or s.phase == ObservedUnknown or s.phase == SucceededMail or s.phase == RefusedMail
pure def receiptMatches(s: MailState, epochId: int, requestId: int, mailKind: MailKind, digest: int): bool =
  s.attached and s.epoch == epochId and s.request == requestId and s.kind == mailKind and s.review == digest
pure def canReadReceipt(s: MailState, epochId: int, requestId: int, mailKind: MailKind, digest: int): bool =
  receiptAttempt(s) and s.dispatchEpoch == 0 and receiptMatches(s, epochId, requestId, mailKind, digest)
pure def readReceipt(s: MailState, epochId: int, requestId: int, mailKind: MailKind, digest: int, receipt: MailReceipt, message: int): MailState = {
  val confirmed = receipt == SuccessReceipt and s.kind == SendMail and message > 0
  val sameSavedSend = confirmed and s.phase == SucceededMail and s.sentMessage == message
  if (receipt == PreparedReceipt) s
  else { ...s, phase: observedPhase(receipt), dispatchEpoch: 0,
    sentMessage: if (confirmed) message else 0, cleanupHeld: s.cleanupHeld and not(sameSavedSend),
    cleanupReady: confirmed and (not(s.cleanupHeld) or sameSavedSend) }
}
pure def canAbandonPrepared(s: MailState, epochId: int, requestId: int, mailKind: MailKind, digest: int, receipt: MailReceipt, warned: bool): bool =
  (s.phase == ReservedMail or s.phase == DispatchUnknown) and s.dispatchEpoch == 0 and
  receiptMatches(s, epochId, requestId, mailKind, digest) and receipt == PreparedReceipt and warned
pure def abandonPrepared(s: MailState, epochId: int, requestId: int, mailKind: MailKind, digest: int, receipt: MailReceipt, warned: bool): MailState =
  emptyJournal(emptyCopy, s)
pure def canRetireReceipt(s: MailState): bool = s.attached and (s.phase == SucceededMail or s.phase == RefusedMail)
pure def retireReceipt(s: MailState): MailState = emptyJournal(emptyCopy, s)
pure def stepReceiptReadNeverReserves(before: MailState, via: str, after: MailState): bool =
  via == "readReceipt" implies after.dispatches == before.dispatches and (after.dispatchEpoch == 0 or after.dispatchEpoch == before.dispatchEpoch)
pure def stepOldBindingCannotChangeJournal(before: MailState, via: str, after: MailState): bool =
  via == "retireBinding" implies after.phase == before.phase and after.request == before.request and after.dispatchEpoch == 0
pure def sometimesCanonicalSuccess(s: MailState): bool = s.phase == SucceededMail
```

### A provider reference is adopted only after exact readback and local acknowledgement

Create and replacement yield the reference used by Edit. Reopening checks
the current Cloud epoch, exact provider draft ID and the freshly read
digest. The library stores only `draftId` and `providerDigest`.
An edited composer or unresolved retained copy blocks adoption. An
unchanged already-saved reference may reopen without writing. Otherwise
an unrelated saved copy must first be shelved, and the new provider
reference must be saved locally before the old receipt is clearable. Lost
write acknowledgement leaves the old receipt available for recovery.

Forwarded original parts come from the reviewed source message ID and
history ID and the exact ordered reviewed part IDs. The draft carries
accepted metadata and rechecks the outgoing policy. A text-only retained
recovery record never invents original forward parts. Provider review may
capture source bytes before dispatch. Provider replacement checks the
expected digest when preparing the review and requires explicit
acknowledgement of non-atomic replacement. Gmail's remote replacement is
non-atomic with that check, so a change after review may be overwritten.
The client records the observed outcome without representing that provider
behavior as an atomic compare-and-exchange.

```quint
type ProviderRead = { currentEpoch: bool, exactId: bool, exactDigest: bool, localCanAdopt: bool, forwardedSource: bool, exactForwardMetadata: bool, localAcknowledged: bool }
pure val providerReadValues = Set(
  { currentEpoch: true, exactId: true, exactDigest: true, localCanAdopt: true, forwardedSource: true, exactForwardMetadata: true, localAcknowledged: true },
  { currentEpoch: true, exactId: true, exactDigest: false, localCanAdopt: true, forwardedSource: false, exactForwardMetadata: true, localAcknowledged: true },
  { currentEpoch: true, exactId: true, exactDigest: true, localCanAdopt: true, forwardedSource: true, exactForwardMetadata: false, localAcknowledged: true },
  { currentEpoch: false, exactId: true, exactDigest: true, localCanAdopt: true, forwardedSource: false, exactForwardMetadata: true, localAcknowledged: true },
  { currentEpoch: true, exactId: true, exactDigest: true, localCanAdopt: true, forwardedSource: false, exactForwardMetadata: true, localAcknowledged: false }
)
pure def adoptAllowed(providerRead: ProviderRead): bool =
  providerRead.currentEpoch and providerRead.exactId and providerRead.exactDigest and providerRead.localCanAdopt and
  (not(providerRead.forwardedSource) or providerRead.exactForwardMetadata) and providerRead.localAcknowledged
pure def forwardMetadataMatches(messageId: str, historyId: str, partIds: List[str], reviewedMessageId: str, reviewedHistoryId: str, reviewedParts: List[str]): bool =
  messageId == reviewedMessageId and historyId == reviewedHistoryId and partIds == reviewedParts and partIds.length() > 0
pure def canAdoptProviderReference(s: MailState, epochId: int, requestId: int, revision: int, providerRead: ProviderRead): bool =
  s.attached and s.epoch == epochId and s.request == requestId and s.phase == SucceededMail and
  (s.kind == CreateMail or s.kind == ReplaceMail) and revision > 0 and
  providerRead.forwardedSource == s.forwarded and adoptAllowed(providerRead)
pure def adoptProviderReference(s: MailState, epochId: int, requestId: int, revision: int, providerRead: ProviderRead): MailState =
  { ...s, localReference: revision, referenceRequest: requestId }
pure def canCloseAdoptedReceipt(s: MailState): bool =
  s.attached and s.phase == SucceededMail and s.referenceRequest == s.request and s.localReference > 0
pure def closeAdoptedReceipt(s: MailState): MailState = emptyJournal(emptyCopy, s)
pure def lawStaleDigestCannotAdopt(providerRead: ProviderRead): bool = not(providerRead.exactDigest) implies not(adoptAllowed(providerRead))
pure def lawUnacknowledgedLocalWriteCannotAdopt(providerRead: ProviderRead): bool = not(providerRead.localAcknowledged) implies not(adoptAllowed(providerRead))
pure def lawChangedForwardCannotAdopt(providerRead: ProviderRead): bool =
  providerRead.forwardedSource and not(providerRead.exactForwardMetadata) implies not(adoptAllowed(providerRead))
pure def sometimesProviderReferenceSaved(s: MailState): bool = s.localReference > 0
```

### A confirmed send cleans up only copies of the reviewed local draft

A send cleanup starts from an exact succeeded send receipt with matching
request identity and provider message ID. After a restart, the journal hides
the source of a saved confirmed send until the current provider read agrees
on the request, operation kind, review digest and exact message ID. If the
matching open or retained copy contains different content or a pending recipient, cleanup leaves its
copies in place. An unreadable retained copy also fences cleanup. An exact
saved copy is removed by compare-and-exchange. A differing saved copy is
marked earlier only if still at the revision captured before Send. Later
revisions remain unchanged. In the shelf, the exact sent draft is removed
and a different copy of that draft is marked rather than removed. Reusing
an earlier draft needs confirmation. A sent Gmail draft remains in Gmail
until a separate draft-delete review captures the exact reference and the
permanent-delete choice.

Discovered by the proof. A held cleanup belongs to an already observed
send. New and still-preparing reviews have no prior sent source to unlock.

```quint
type CleanupDecision = KeepCopy | DropSentCopy | MarkEarlierCopy
type Cleanup = { exactReceipt: bool, source: Copy, openConflict: bool, retainedConflict: bool, retainedReadable: bool }
pure val cleanupValues = Set(
  { exactReceipt: true, source: { id: 1, content: 1, revision: 1 }, openConflict: false, retainedConflict: false, retainedReadable: true },
  { exactReceipt: true, source: { id: 1, content: 2, revision: 1 }, openConflict: true, retainedConflict: false, retainedReadable: true },
  { exactReceipt: true, source: { id: 1, content: 1, revision: 1 }, openConflict: false, retainedConflict: true, retainedReadable: true },
  { exactReceipt: true, source: { id: 1, content: 1, revision: 1 }, openConflict: false, retainedConflict: false, retainedReadable: false },
  { exactReceipt: false, source: { id: 1, content: 1, revision: 1 }, openConflict: false, retainedConflict: false, retainedReadable: true }
)
pure def cleanupAllowed(cleanup: Cleanup): bool =
  cleanup.exactReceipt and hasCopy(cleanup.source) and not(cleanup.openConflict) and not(cleanup.retainedConflict) and cleanup.retainedReadable
pure def decideSavedCleanup(cleanup: Cleanup, copy: Copy): CleanupDecision =
  if (not(cleanupAllowed(cleanup)) or copy.id != cleanup.source.id) KeepCopy
  else if (copy.content == cleanup.source.content) DropSentCopy
  else if (cleanup.source.revision > 0 and copy.revision == cleanup.source.revision) MarkEarlierCopy
  else KeepCopy
pure def decideShelfCleanup(cleanup: Cleanup, copy: Copy, pendingRecipient: bool): CleanupDecision =
  if (not(cleanupAllowed(cleanup)) or copy.id != cleanup.source.id) KeepCopy
  else if (copy.content == cleanup.source.content and not(pendingRecipient)) DropSentCopy
  else MarkEarlierCopy
pure def alwaysHeldCleanupFollowsObservedSend(s: MailState): bool =
  s.cleanupHeld implies s.kind == SendMail and
  (s.phase == SucceededMail or s.phase == RefusedMail or s.phase == ObservedUnknown)
pure def alwaysCleanupHasExactSend(s: MailState): bool =
  s.cleanupReady implies s.attached and not(s.cleanupHeld) and s.phase == SucceededMail and s.kind == SendMail and s.sentMessage > 0
pure def stepRetirementFencesSendCleanup(before: MailState, via: str, after: MailState): bool =
  via == "retireBinding" implies not(after.cleanupReady)
pure def sometimesExactConfirmedSend(s: MailState): bool = s.cleanupReady
pure def lawDifferentDraftSurvives(cleanup: Cleanup, copy: Copy, pendingRecipient: bool): bool =
  copy.id != cleanup.source.id implies decideSavedCleanup(cleanup, copy) == KeepCopy and decideShelfCleanup(cleanup, copy, pendingRecipient) == KeepCopy
pure def lawNewerChangedSavedCopySurvives(cleanup: Cleanup, copy: Copy): bool =
  copy.revision != cleanup.source.revision and copy.content != cleanup.source.content implies decideSavedCleanup(cleanup, copy) == KeepCopy
pure def lawUnknownSendCannotCleanCopies(cleanup: Cleanup, copy: Copy, pendingRecipient: bool): bool =
  not(cleanup.exactReceipt) implies decideSavedCleanup(cleanup, copy) == KeepCopy and decideShelfCleanup(cleanup, copy, pendingRecipient) == KeepCopy
```

Pinned source evidence lives in Alpha's `test/quint-inbox-provider-drafts.test.mjs`,
`test/inbox-draft-copies.test.mjs`, `test/inbox-operation-guards.test.mjs`
and `specs/quint/refinement/services/inbox-provider-drafts.mjs`. The source
harness drives real Alpha adapters and pinned client controllers with
scripted Gmail and compare-and-exchange ports. Android secure storage
and Gmail's live behavior are separate conformance boundaries.
