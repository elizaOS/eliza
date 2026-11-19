# Text messages: reviewed sends, receipts, notices and deletion

The messages module (`packages/os/android/messages/`, from
`plugins/plugin-native-messages/android`). A host that declares telephony
subclasses the abstract `TelephonyPlugin` under its own plugin name and
registers it only on a verified system image; calls are admitted as
[the bridge](./bridge.md) says. The operations `sms_send` and `mms_send`,
their shape checks and the capabilities `sms.send.v1`, `mms.send.v1` and
`messages.read.v1` are the agent's
([operations](../../agent/deviceActions/operations.md),
[capabilities](../../agent/deviceActions/capabilities.md)); a request for the
default SMS role is [system](./system.md)'s. This spec keeps what Android must
confirm before a send, what the send journal answers, what a status may
claim, what a new-message notice action may write and what a deletion may
report. Carrier delivery is never inferred. Calls and voicemail are
[phone](./phone.md)'s and [voicemail](./voicemail.md)'s.

## Story: Send only what I reviewed, once

> As the person, I want to review a message before it is sent, cancel it
> until Android takes it, and have it go out at most once even if I press
> Send twice or the phone restarts mid-send, so that nothing is sent I did
> not approve and I am told honestly when the phone cannot know whether it
> went.

### Native confirmation and current ownership precede dispatch, and a cancel is refused once Android has the message

A send is admitted only from the unlocked phone in front, with the send
grant and a phone that can send texts, and names its operation ID before the
journal lookup. With no record for that ID, the native review dialog is
queued and the visible owner approves it once; a send the owner composed and
tapped Send on in the host's own composer is its own review. A cancel for
the exact operation retires it and is acknowledged; a background or destroyed
owner also retires it; a cancel for another ID changes nothing. A retired
send settles as cancelled with no platform call. Once Android has the
dispatch, a cancel is refused, and the real or unknown result is still
reported if the owner goes away.

```quint
import bridge.* from "./bridge"
type ReviewSource = NativeDialog | OwnerComposer
type MessageKind = TextMessage | MultimediaMessage
type ReviewPhase = NoReview | ReadingJournal | MainQueued | Reviewing | ApprovedForDispatch | NativeDispatched | ReviewSettled
type SendRecord = NotSent | SendDenied | SendCancelled | SendSubmitted | SendSent | SendDelivered | SendFailed | SendUnknown | SendDropped
type SmsReview = {
  phase: ReviewPhase, source: ReviewSource, kind: MessageKind, operationId: str, retired: bool,
  cancelAcknowledged: bool, dispatched: bool, outgoingRow: bool, result: SendRecord
}
pure val initial: SmsReview = {
  phase: NoReview, source: NativeDialog, kind: TextMessage, operationId: "", retired: false,
  cancelAcknowledged: false, dispatched: false, outgoingRow: false, result: NotSent
}
pure val sendCall: BridgeCall = { need: WhileUnlocked, needsGrant: true, needsFeature: true }
pure def canBeginReview(s: SmsReview, operationId: str, presence: PluginPresence, facts: HostFacts): bool =
  s.phase == NoReview and operationId != "" and admitCall(presence, sendCall, facts) == CallAdmitted
pure def beginReview(s: SmsReview, operationId: str, source: ReviewSource, kind: MessageKind, presence: PluginPresence, facts: HostFacts): SmsReview =
  { ...s, phase: ReadingJournal, source: source, kind: kind, operationId: operationId }
pure def canShowReview(s: SmsReview): bool = s.phase == MainQueued and s.source == NativeDialog and not(s.retired)
pure def showReview(s: SmsReview): SmsReview = { ...s, phase: Reviewing }
pure def canApproveReview(s: SmsReview): bool = s.phase == Reviewing and not(s.retired)
pure def approveReview(s: SmsReview): SmsReview = { ...s, phase: ApprovedForDispatch }
pure def canAcceptComposerSend(s: SmsReview): bool = s.phase == MainQueued and s.source == OwnerComposer and not(s.retired)
pure def acceptComposerSend(s: SmsReview): SmsReview = { ...s, phase: ApprovedForDispatch }
pure def canRejectReview(s: SmsReview): bool = s.phase == Reviewing and not(s.retired)
pure def rejectReview(s: SmsReview): SmsReview = { ...s, phase: ReviewSettled, result: SendCancelled }
pure def pendingReview(s: SmsReview): bool = s.phase != NoReview and s.phase != ReviewSettled
pure def canCancelReview(s: SmsReview, operationId: str): bool =
  pendingReview(s) and operationId == s.operationId and not(s.cancelAcknowledged) and not(s.dispatched)
pure def cancelReview(s: SmsReview, operationId: str): SmsReview = { ...s, retired: true, cancelAcknowledged: true }
pure def canRetireReview(s: SmsReview): bool = pendingReview(s) and not(s.retired)
pure def retireReview(s: SmsReview): SmsReview = { ...s, retired: true }
pure def canSettleRetiredReview(s: SmsReview): bool =
  s.retired and (s.phase == MainQueued or s.phase == Reviewing or s.phase == ApprovedForDispatch)
pure def settleRetiredReview(s: SmsReview): SmsReview = { ...s, phase: ReviewSettled, result: SendCancelled }
pure def canReportDispatch(s: SmsReview, receipt: SendRecord): bool =
  s.phase == NativeDispatched and (receipt == SendSubmitted or receipt == SendFailed or receipt == SendUnknown)
pure def reportDispatch(s: SmsReview, receipt: SendRecord): SmsReview = { ...s, phase: ReviewSettled, result: receipt }
pure val operationIdValues = Set("", "op1", "op2")
pure val receiptValues = Set(SendSubmitted, SendFailed, SendUnknown, SendSent)
pure def alwaysCancellationRetires(s: SmsReview): bool = s.cancelAcknowledged implies s.retired
pure def alwaysAcknowledgedCancelNeverDispatches(s: SmsReview): bool = s.cancelAcknowledged implies not(s.dispatched)
pure def alwaysDispatchIsLastOrSettled(s: SmsReview): bool =
  (s.dispatched implies (s.phase == NativeDispatched or s.phase == ReviewSettled)) and (s.phase == NativeDispatched implies s.dispatched)
pure def alwaysSettledHasAResult(s: SmsReview): bool = (s.phase == ReviewSettled) == (s.result != NotSent)
pure def alwaysReviewNamesItsOperation(s: SmsReview): bool = (s.phase == NoReview) == (s.operationId == "")
pure def stepResultIsFinal(before: SmsReview, after: SmsReview): bool = before.result != NotSent implies after == before
pure def stepDispatchNeedsApproval(before: SmsReview, after: SmsReview): bool =
  (after.dispatched and not(before.dispatched)) implies (before.phase == ApprovedForDispatch and not(before.retired))
pure def sometimesCancelledBeforeDispatch(s: SmsReview): bool = s.result == SendCancelled and s.cancelAcknowledged
pure def sometimesResultSurvivesRetirement(s: SmsReview): bool = s.result == SendSubmitted and s.retired
pure def sometimesComposerSendDispatched(s: SmsReview): bool = s.source == OwnerComposer and s.phase == NativeDispatched
```

### A repeated operation ID answers its journal record and never sends again

The operation ID is the send's idempotency key, shared by SMS and MMS. The
journal keeps a hash of the recipients, the text and the subscription (and,
for an MMS, each attachment's type, name, hash and size), never the text or
bytes. A repeated ID with the same content answers its record; with other
content it is denied; a dropped record leaves a tombstone that answers
unknown. A new ID is denied without a platform call when sending is not
permitted, the default SMS app could not prepare its outbox row, or the text
cannot be divided into one to `maxPartsPerRecipient` parts for each
recipient; otherwise it is recorded as dispatching before the first
platform call.

```quint
type SendPlan = DispatchNew | DenyNew | AnswerRecord | RefuseReuse
pure val maxPartsPerRecipient = 10
pure def planSend(existing: SendRecord, sameContent: bool, permitted: bool, parts: int): SendPlan =
  if (existing != NotSent) (if (sameContent) AnswerRecord else RefuseReuse)
  else if (permitted and parts >= 1 and parts <= maxPartsPerRecipient) DispatchNew
  else DenyNew
pure def journalAnswer(existing: SendRecord): SendRecord = if (existing == SendDropped) SendUnknown else existing
pure def canFinishLookup(s: SmsReview): bool = s.phase == ReadingJournal
pure def finishLookup(s: SmsReview, existing: SendRecord, sameContent: bool): SmsReview = {
  val plan = planSend(existing, sameContent, true, 1)
  if (s.retired) { ...s, phase: ReviewSettled, result: SendCancelled }
  else if (plan == AnswerRecord) { ...s, phase: ReviewSettled, result: journalAnswer(existing) }
  else if (plan == RefuseReuse) { ...s, phase: ReviewSettled, result: SendDenied }
  else { ...s, phase: MainQueued }
}
pure def canDispatchApproved(s: SmsReview): bool = s.phase == ApprovedForDispatch and not(s.retired) and not(s.dispatched)
pure def dispatchApproved(s: SmsReview, permitted: bool, parts: int, smsRoleHeld: bool): SmsReview =
  if (planSend(NotSent, true, permitted, parts) == DispatchNew and (s.kind == TextMessage or smsRoleHeld))
    { ...s, phase: NativeDispatched, dispatched: true, outgoingRow: smsRoleHeld }
  else { ...s, phase: ReviewSettled, result: SendDenied }
pure val partsValues = Set(0, 1, 10, 11)
pure val existingValues = Set(NotSent, SendSent, SendDropped, SendCancelled)
pure def lawRecordedOperationNeverSendsAgain(existing: SendRecord, sameContent: bool, permitted: bool, parts: int): bool =
  existing != NotSent implies planSend(existing, sameContent, permitted, parts) != DispatchNew
pure def alwaysTombstoneIsNeverReported(s: SmsReview): bool = s.result != SendDropped
pure def alwaysRefusedSendNeverDispatched(s: SmsReview): bool =
  (s.result == SendCancelled or s.result == SendDenied) implies not(s.dispatched)
pure def sometimesRepeatAnswersItsRecord(s: SmsReview): bool = s.result == SendSent and not(s.dispatched)
pure def sometimesDroppedRecordAnswersUnknown(s: SmsReview): bool = s.result == SendUnknown and not(s.dispatched)
pure def sometimesSendDenied(s: SmsReview): bool = s.result == SendDenied
```

### A send's provider row is written only by an approved dispatch, and an MMS only while the app holds the SMS role

While the app is the default SMS app it writes the outgoing row itself, as
part of the dispatch the owner approved; otherwise Android records the send.
An MMS or group send needs the default SMS role and is denied without it.
The assistant's own text, briefings and proposals have no review, so they
never reach the providers or a thread; only these rows and incoming
messages do.

```quint
pure def alwaysOutgoingRowOnlyForDispatch(s: SmsReview): bool = s.outgoingRow implies s.dispatched
pure def alwaysMultimediaDispatchHoldsTheRole(s: SmsReview): bool =
  (s.kind == MultimediaMessage and s.dispatched) implies s.outgoingRow
pure def sometimesMultimediaRowWritten(s: SmsReview): bool = s.kind == MultimediaMessage and s.outgoingRow
```

### A message's status is supported by the evidence of every part, and an interrupted send reads unknown

A text is divided into parts for each recipient, each with its own sent and
delivery evidence. Any failed part makes the message failed; sent needs a
sent receipt for every part; delivered also needs a complete delivery
report for every part and is never claimed for an MMS, which is sent on the
carrier's confirmation. Otherwise the message is submitted only when every
platform call returned and its receipts can still arrive. A dispatch the
process did not finish, and receipts a restart or a timeout lost, read
unknown; an unknown record is never sent again (above).

```quint
type PartState = PartWaiting | PartSucceeded | PartFailed
type PartEvidence = { sentState: PartState, deliveryState: PartState }
type CallEvidence = StillDispatching | AllCallsReturned | ReceiptsLost
type SendEvidence = { parts: List[PartEvidence], mms: bool, calls: CallEvidence }
pure def evidenceStatus(e: SendEvidence): SendRecord = {
  val allSent = e.parts.length() > 0 and e.parts.every(p => p.sentState == PartSucceeded)
  if (e.parts.some(p => p.sentState == PartFailed)) SendFailed
  else if (allSent) (if (not(e.mms) and e.parts.every(p => p.deliveryState == PartSucceeded)) SendDelivered else SendSent)
  else if (e.calls == AllCallsReturned) SendSubmitted
  else SendUnknown
}
pure def afterRestart(e: SendEvidence): SendEvidence = { ...e, calls: ReceiptsLost }
pure val eValues: Set[SendEvidence] = {
  val sent = { sentState: PartSucceeded, deliveryState: PartWaiting }
  val delivered = { sentState: PartSucceeded, deliveryState: PartSucceeded }
  val waiting = { sentState: PartWaiting, deliveryState: PartWaiting }
  val failed = { sentState: PartFailed, deliveryState: PartWaiting }
  List(
    { parts: List(), mms: false, calls: StillDispatching },
    { parts: List(waiting, sent), mms: false, calls: AllCallsReturned },
    { parts: List(delivered, delivered), mms: false, calls: AllCallsReturned },
    { parts: List(delivered), mms: true, calls: AllCallsReturned },
    { parts: List(sent, failed), mms: false, calls: ReceiptsLost },
    { parts: List(waiting), mms: true, calls: ReceiptsLost }
  ).foldl(Set(), (acc, e) => acc.union(Set(e)))
}
pure def lawSentNeedsEveryPartSent(e: SendEvidence): bool =
  (evidenceStatus(e) == SendSent or evidenceStatus(e) == SendDelivered) implies
    (e.parts.length() > 0 and e.parts.every(p => p.sentState == PartSucceeded))
pure def lawDeliveredNeedsEveryReportAndNeverMms(e: SendEvidence): bool =
  evidenceStatus(e) == SendDelivered implies (not(e.mms) and e.parts.every(p => p.deliveryState == PartSucceeded))
pure def lawFailedPartIsNeverHidden(e: SendEvidence): bool =
  e.parts.some(p => p.sentState == PartFailed) implies evidenceStatus(e) == SendFailed
pure def lawRestartNeverReadsSubmitted(e: SendEvidence): bool = evidenceStatus(afterRestart(e)) != SendSubmitted
```

## Story: Mark a conversation read from its notice without sending anything

> As the person, I want the Mark read action on a new-message notice to
> mark exactly that conversation read and dismiss only its notice, and
> never to send a message for me.

### A notice action writes only for its own conversation and only while its ticket is current

The action captures the notice's ticket when chosen. A newer incoming
message for the same conversation advances the ticket, and a failed
publication of that newer notice clears it, so the old action can no longer
write even if the newer notice later appears. The worker writes only while
the default SMS role is held and the captured ticket is both the current
and the visible one; it marks SMS read first and MMS read second, and
dismisses the notice only after both providers acknowledge. Without the role
it dismisses the notice and writes nothing. A partial provider failure keeps
the notice for a retry. Each conversation keeps its full identity, so
colliding hashed IDs never redirect a write. Reply only opens the compose
screen, and every worker run releases the held receiver.

```quint
type NoticeTicket = { captured: int, current: int, visible: int, roleHeld: bool }
type NoticeWork = SkipStaleNotice | DismissWithoutWrite | MarkConversationRead
pure def noticeWork(ticket: NoticeTicket): NoticeWork =
  if (ticket.captured == 0 or ticket.captured != ticket.current or ticket.captured != ticket.visible) SkipStaleNotice
  else if (not(ticket.roleHeld)) DismissWithoutWrite
  else MarkConversationRead
pure def noticeDismissed(work: NoticeWork, smsAcknowledged: bool, mmsAcknowledged: bool): bool =
  work == DismissWithoutWrite or (work == MarkConversationRead and smsAcknowledged and mmsAcknowledged)
pure val ticketValues = Set(
  { captured: 1, current: 1, visible: 1, roleHeld: true },
  { captured: 1, current: 1, visible: 1, roleHeld: false },
  { captured: 1, current: 2, visible: 2, roleHeld: true },
  { captured: 1, current: 0, visible: 2, roleHeld: true },
  { captured: 2, current: 2, visible: 1, roleHeld: true }
)
pure def lawStaleNoticeNeverWrites(ticket: NoticeTicket): bool =
  (ticket.captured != ticket.current or ticket.captured != ticket.visible) implies noticeWork(ticket) == SkipStaleNotice
pure def lawLostRoleNeverWrites(ticket: NoticeTicket): bool = not(ticket.roleHeld) implies noticeWork(ticket) != MarkConversationRead
pure def lawPartialProviderFailureKeepsNotice(work: NoticeWork): bool =
  work == MarkConversationRead implies (not(noticeDismissed(work, true, false)) and not(noticeDismissed(work, false, true)))
```

## Story: Delete one message I chose

> As the person, I want to delete exactly the message I selected and
> confirmed, and be told it is gone only when it is.

### A deletion removes only the selected settled row and confirms only a removal Android reported

The bridge reads the row's identity (thread, date, box) and checks
authority again before one conditional delete in the row's own table. A row
that is gone answers not-found, one whose identity changed answers stale,
and a draft, queued, outbox or failed row belongs to a send and answers
not-settled; none of these is deleted. Only a removal Android reported is
`MessageDeleted`; a delete that removed nothing is explained by a second
read, and a lost reply or an unexplained count is unknown, never deleted.

```quint
type RowSeen = RowMissing | RowMoved | RowInSend | RowSettled
type DeleteReply = ProviderRemoved | ProviderRemovedNothing | ProviderSilent
type DeleteStatus = MessageDeleted | MessageNotFound | MessageStale | MessageNotSettled | DeleteUnknown | DeleteRefused
pure def deleteDispatched(allowed: bool, seen: RowSeen): bool = allowed and seen == RowSettled
pure def explainNothingRemoved(after: RowSeen): DeleteStatus =
  if (after == RowMissing) MessageNotFound else if (after == RowMoved) MessageStale else if (after == RowInSend) MessageNotSettled else DeleteUnknown
pure def deleteStatus(allowed: bool, seen: RowSeen, reply: DeleteReply, after: RowSeen): DeleteStatus =
  if (not(allowed)) DeleteRefused
  else if (seen != RowSettled) explainNothingRemoved(seen)
  else if (reply == ProviderRemoved) MessageDeleted
  else if (reply == ProviderRemovedNothing) explainNothingRemoved(after)
  else DeleteUnknown
pure def lawDeletedOnlyByAReportedRemovalOfASettledRow(allowed: bool, seen: RowSeen, reply: DeleteReply, after: RowSeen): bool =
  deleteStatus(allowed, seen, reply, after) == MessageDeleted iff (deleteDispatched(allowed, seen) and reply == ProviderRemoved)
pure def lawRowInASendIsNeverDeleted(allowed: bool, reply: DeleteReply, after: RowSeen): bool =
  not(deleteDispatched(allowed, RowInSend)) and deleteStatus(allowed, RowInSend, reply, after) != MessageDeleted
pure def lawRefusalNeverDispatches(seen: RowSeen, reply: DeleteReply, after: RowSeen): bool =
  not(deleteDispatched(false, seen)) and deleteStatus(false, seen, reply, after) == DeleteRefused
```
