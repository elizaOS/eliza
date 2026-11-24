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
claim, what a new-message notice action may write, and what a deletion of a
message or a conversation may stage in the
[deletion journal](./deferredDeletion.md) and report. Carrier delivery is never inferred. Calls and voicemail are
[phone](./phone.md)'s and [voicemail](./voicemail.md)'s. A new-message
notice is this module's own: it is posted for an incoming message, not for
an agent result, so the account fence and tap tokens of
[notice routes](./noticeRoutes.md) do not apply to it.

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
tapped Send on in the host's own composer is its own review. Declining the
dialog settles the send as cancelled. A cancel for the exact operation
retires it and is acknowledged; a background or destroyed owner also retires
it; a cancel for another ID changes nothing. A retired send settles as
cancelled with no platform call. Once Android has the dispatch, a cancel is
refused, and the real or unknown result is still reported if the owner goes
away.

```quint
import bridge.* from "./bridge"
type ReviewSource = NativeDialog | OwnerComposer
type MessageKind = TextMessage | MultimediaMessage
type ReviewPhase = NoReview | ReadingJournal | MainQueued | Reviewing | ApprovedForDispatch | NativeDispatched | ReviewSettled
type SendAnswer = NoAnswer | SendDenied | SendCancelled | SendSubmitted | SendSent | SendDelivered | SendFailed | SendUnknown
  | ReuseRefused | RecordExpired | JournalUnreadable
type SmsReview = {
  phase: ReviewPhase, source: ReviewSource, kind: MessageKind, operationId: str, retired: bool,
  cancelAcknowledged: bool, dispatched: bool, outgoingRow: bool, result: SendAnswer
}
pure val initial: SmsReview = {
  phase: NoReview, source: NativeDialog, kind: TextMessage, operationId: "", retired: false,
  cancelAcknowledged: false, dispatched: false, outgoingRow: false, result: NoAnswer
}
pure val sendCall: BridgeCall = { need: WhileUnlocked, needsGrant: true, needsFeature: true }
pure def canBeginReview(s: SmsReview, operationId: str, presence: PluginPresence, facts: HostFacts): bool =
  s.phase == NoReview and operationId != "" and admitCall(presence, sendCall, facts) == CallAdmitted
pure def beginReview(s: SmsReview, operationId: str, source: ReviewSource, kind: MessageKind, presence: PluginPresence, facts: HostFacts): SmsReview =
  { ...s, phase: ReadingJournal, source: source, kind: kind, operationId: operationId }
pure def canApproveReview(s: SmsReview): bool = s.phase == Reviewing and not(s.retired)
pure def approveReview(s: SmsReview): SmsReview = { ...s, phase: ApprovedForDispatch }
pure def canDeclineReview(s: SmsReview): bool = s.phase == Reviewing and not(s.retired)
pure def declineReview(s: SmsReview): SmsReview = { ...s, phase: ReviewSettled, result: SendCancelled }
pure def pendingReview(s: SmsReview): bool = s.phase != NoReview and s.phase != ReviewSettled
pure def canCancelReview(s: SmsReview, operationId: str): bool =
  pendingReview(s) and operationId == s.operationId and not(s.cancelAcknowledged) and not(s.dispatched)
pure def cancelReview(s: SmsReview, operationId: str): SmsReview = { ...s, retired: true, cancelAcknowledged: true }
pure def canRetireReview(s: SmsReview): bool = pendingReview(s) and not(s.retired)
pure def retireReview(s: SmsReview): SmsReview = { ...s, retired: true }
pure def canSettleRetiredReview(s: SmsReview): bool =
  s.retired and (s.phase == MainQueued or s.phase == Reviewing or s.phase == ApprovedForDispatch)
pure def settleRetiredReview(s: SmsReview): SmsReview = { ...s, phase: ReviewSettled, result: SendCancelled }
pure def canReportDispatch(s: SmsReview, receipt: SendAnswer): bool =
  s.phase == NativeDispatched and (receipt == SendSubmitted or receipt == SendFailed or receipt == SendUnknown)
pure def reportDispatch(s: SmsReview, receipt: SendAnswer): SmsReview = { ...s, phase: ReviewSettled, result: receipt }
pure val operationIdValues = Set("", "op1", "op2")
pure val receiptValues = Set(SendSubmitted, SendFailed, SendUnknown, SendSent)
pure def alwaysCancellationRetires(s: SmsReview): bool = s.cancelAcknowledged implies s.retired
pure def alwaysAcknowledgedCancelNeverDispatches(s: SmsReview): bool = s.cancelAcknowledged implies not(s.dispatched)
pure def alwaysDispatchIsLastOrSettled(s: SmsReview): bool =
  (s.dispatched implies (s.phase == NativeDispatched or s.phase == ReviewSettled)) and (s.phase == NativeDispatched implies s.dispatched)
pure def alwaysSettledHasAResult(s: SmsReview): bool = (s.phase == ReviewSettled) == (s.result != NoAnswer)
pure def alwaysReviewNamesItsOperation(s: SmsReview): bool = (s.phase == NoReview) == (s.operationId == "")
pure def stepResultIsFinal(before: SmsReview, after: SmsReview): bool = before.result != NoAnswer implies after == before
pure def stepDispatchNeedsApproval(before: SmsReview, after: SmsReview): bool =
  (after.dispatched and not(before.dispatched)) implies (before.phase == ApprovedForDispatch and not(before.retired))
pure def sometimesCancelledBeforeDispatch(s: SmsReview): bool = s.result == SendCancelled and s.cancelAcknowledged
pure def sometimesDeclinedInTheDialog(s: SmsReview): bool = s.result == SendCancelled and not(s.retired)
pure def sometimesResultSurvivesRetirement(s: SmsReview): bool = s.result == SendSubmitted and s.retired
pure def sometimesComposerSendDispatched(s: SmsReview): bool = s.source == OwnerComposer and s.phase == NativeDispatched
```

### A repeated operation ID answers its journal record and never sends again

The operation ID is the send's idempotency key, shared by SMS and MMS. The
journal keeps a hash of the recipients, the text and the subscription (and,
for an MMS, each attachment's type, name, hash and size), never the text or
bytes. A repeated ID with the same content answers its record, even if its
caller has since been cancelled; with other content it is refused. A record
dropped to bound the journal leaves its ID behind, so a repeat is refused as
too old to read back. An unreadable journal refuses too. None of these sends
or records anything; only an ID with no record goes on to review.

```quint
type JournalLookup = NoRecord | SameContent | OtherContent | DroppedRecord | Unreadable
pure def isJournalStatus(a: SendAnswer): bool =
  a == SendDenied or a == SendCancelled or a == SendSubmitted or a == SendSent or a == SendDelivered or a == SendFailed or a == SendUnknown
pure def lookupAnswer(lookup: JournalLookup, recorded: SendAnswer): SendAnswer =
  if (lookup == SameContent) recorded else if (lookup == OtherContent) ReuseRefused
  else if (lookup == DroppedRecord) RecordExpired else if (lookup == Unreadable) JournalUnreadable else NoAnswer
pure def canFinishLookup(s: SmsReview, lookup: JournalLookup, recorded: SendAnswer): bool =
  s.phase == ReadingJournal and (lookup == SameContent implies isJournalStatus(recorded))
pure def finishLookup(s: SmsReview, lookup: JournalLookup, recorded: SendAnswer): SmsReview =
  if (lookup == NoRecord) { ...s, phase: MainQueued } else { ...s, phase: ReviewSettled, result: lookupAnswer(lookup, recorded) }
pure val recordedValues = Set(NoAnswer, SendSent, SendUnknown, SendCancelled)
pure def alwaysRefusedLookupNeverDispatched(s: SmsReview): bool =
  not(s.result == NoAnswer or isJournalStatus(s.result)) implies not(s.dispatched)
pure def sometimesRepeatAnswersItsRecord(s: SmsReview): bool = s.result == SendSent and not(s.dispatched)
pure def sometimesRepeatAfterCancelAnswersItsRecord(s: SmsReview): bool = s.result == SendUnknown and s.cancelAcknowledged and not(s.dispatched)
pure def sometimesReuseRefused(s: SmsReview): bool = s.result == ReuseRefused
pure def sometimesDroppedRecordRefused(s: SmsReview): bool = s.result == RecordExpired
```

### A send is denied before any platform call unless Android allows it at review and again at dispatch

Before the review, a send is denied and recorded when the phone cannot send
it now (no SMS capability, a missing send or phone-state grant, an inactive
SIM, and for an MMS no file authority, no default SMS role or a carrier that
refuses MMS), or when its text cannot be divided into one to
`maxPartsPerRecipient` parts for each recipient. At dispatch the same checks
run again, an MMS needs the default SMS role, and the default SMS app must
first prepare its own outbox rows; any failure is denied with no platform
call.

```quint
pure val maxPartsPerRecipient = 10
pure def sendable(kind: MessageKind, blocked: bool, parts: int): bool =
  not(blocked) and (kind == MultimediaMessage or (parts >= 1 and parts <= maxPartsPerRecipient))
pure def canPresentReview(s: SmsReview): bool = s.phase == MainQueued and not(s.retired)
pure def presentReview(s: SmsReview, blocked: bool, parts: int): SmsReview =
  if (not(sendable(s.kind, blocked, parts))) { ...s, phase: ReviewSettled, result: SendDenied }
  else if (s.source == NativeDialog) { ...s, phase: Reviewing }
  else { ...s, phase: ApprovedForDispatch }
pure def canDispatchApproved(s: SmsReview): bool = s.phase == ApprovedForDispatch and not(s.retired) and not(s.dispatched)
pure def dispatchApproved(s: SmsReview, blocked: bool, smsRoleHeld: bool, rowsPrepared: bool): SmsReview =
  if (blocked or (s.kind == MultimediaMessage and not(smsRoleHeld)) or (smsRoleHeld and not(rowsPrepared)))
    { ...s, phase: ReviewSettled, result: SendDenied }
  else { ...s, phase: NativeDispatched, dispatched: true, outgoingRow: smsRoleHeld }
pure val partsValues = Set(0, 1, 10, 11)
pure def alwaysRefusedSendNeverDispatched(s: SmsReview): bool =
  (s.result == SendCancelled or s.result == SendDenied) implies not(s.dispatched)
pure def sometimesSendDenied(s: SmsReview): bool = s.result == SendDenied and s.phase == ReviewSettled
```

### A send's provider row is written only by an approved dispatch, and an MMS only while the app holds the SMS role

While the app is the default SMS app it writes the outgoing row itself, as
part of the dispatch the owner approved; otherwise Android records the send.
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
pure def evidenceStatus(e: SendEvidence): SendAnswer = {
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
the notice for a retry. The ticket belongs to the conversation's full
identity, so colliding hashed IDs never redirect a write. The notice offers
no send: Reply opens the compose screen, where a send is reviewed as above.

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
> confirmed, with ten seconds to undo it, and be told it is gone only when
> it is.

### A deletion removes only the selected settled row and confirms only a removal Android reported

The owner confirms on the app's screen, with the SMS role and read grant on
the unlocked phone in front. The bridge reads the row's identity (thread,
date, box) and checks authority again before it stages anything. A row that
is gone answers not-found, one whose identity changed answers stale, and a
draft, queued, outbox or failed row belongs to a send and answers
not-settled; none of these is staged. A settled row is staged as a message
record (`DeleteQueued`) and leaves the thread until its window settles. At
expiry the journal's provider call, under the role and read grant held then,
reads the identity again and makes one conditional delete in the row's own
table. Only a removal Android reported is `MessageDeleted`; a delete that
removed nothing is explained by a second read, and a lost reply or an
unexplained count is unknown, never deleted.

```quint
type RowSeen = RowMissing | RowMoved | RowInSend | RowSettled
type DeleteReply = ProviderRemoved | ProviderRemovedNothing | ProviderSilent
type DeleteStatus = DeleteQueued | MessageDeleted | MessageNotFound | MessageStale | MessageNotSettled | DeleteUnknown | DeleteRefused
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
pure def stagedStatus(allowed: bool, seen: RowSeen): DeleteStatus =
  if (not(allowed)) DeleteRefused else if (seen == RowSettled) DeleteQueued else explainNothingRemoved(seen)
pure def lawOnlyASettledRowIsQueued(allowed: bool, seen: RowSeen, reply: DeleteReply, after: RowSeen): bool =
  (stagedStatus(allowed, seen) == DeleteQueued iff deleteDispatched(allowed, seen)) and deleteStatus(allowed, seen, reply, after) != DeleteQueued
```

## Story: Delete a conversation I chose

> As the person, I want to delete a whole conversation I confirmed, with
> ten seconds to undo it, without losing a text that arrives meanwhile or
> one that is still being sent.

### A conversation deletion removes only its settled rows up to the newest one I saw

The owner confirms with the same authority as a message deletion. The
boundary is the date of the newest row the owner saw in the conversation.
The bridge counts the conversation's rows at or before it: with a settled
row among them the conversation is staged as a thread record
(`DeleteQueued`); with only rows that belong to a send it answers
not-settled; with none, not-found. At expiry the provider call deletes, in
SMS and then MMS, only the settled rows of that thread at or before the
boundary. A text that arrived after the boundary and every row of a send
stay. The conversation is `MessageDeleted` only when Android reported a
removal and a second read finds no settled row left at or before the
boundary; a removal of nothing with none left is not-found, and a lost reply
or any other count is unknown.

```quint
type ThreadSeen = { settledThrough: int, inSendThrough: int }
type ThreadReply = ThreadRemoved({ count: int }) | ThreadSilent
pure def threadStaged(allowed: bool, held: ThreadSeen): DeleteStatus =
  if (not(allowed)) DeleteRefused
  else if (held.settledThrough > 0) DeleteQueued
  else if (held.inSendThrough > 0) MessageNotSettled
  else MessageNotFound
pure def threadDeleteStatus(allowed: bool, held: ThreadSeen, threadReply: ThreadReply, left: ThreadSeen): DeleteStatus =
  if (threadStaged(allowed, held) != DeleteQueued) threadStaged(allowed, held)
  else match threadReply {
    | ThreadRemoved(r) =>
      if (r.count >= 1 and r.count <= held.settledThrough and left.settledThrough == 0) MessageDeleted
      else if (r.count == 0 and left.settledThrough == 0) MessageNotFound
      else DeleteUnknown
    | ThreadSilent => DeleteUnknown
  }
pure val heldValues = Set({ settledThrough: 0, inSendThrough: 0 }, { settledThrough: 0, inSendThrough: 1 }, { settledThrough: 2, inSendThrough: 1 }, { settledThrough: 1, inSendThrough: 0 })
pure val leftValues = heldValues
pure val threadReplyValues = Set(ThreadSilent, ThreadRemoved({ count: 0 }), ThreadRemoved({ count: 1 }), ThreadRemoved({ count: 2 }), ThreadRemoved({ count: 3 }))
pure def lawAConversationIsDeletedOnlyWhenAndroidRemovedItsSettledRows(allowed: bool, held: ThreadSeen, threadReply: ThreadReply, left: ThreadSeen): bool =
  threadDeleteStatus(allowed, held, threadReply, left) == MessageDeleted implies
    (allowed and held.settledThrough > 0 and left.settledThrough == 0 and threadReply != ThreadSilent and threadReply != ThreadRemoved({ count: 0 }))
pure def lawAConversationOfOnlySendsIsNeverStaged(allowed: bool, held: ThreadSeen): bool =
  held.settledThrough == 0 implies threadStaged(allowed, held) != DeleteQueued
```

## Story: Keep my conversation list whole and current

> As the person, I want every conversation and message on the phone to keep
> its place in the list, even one too large to show, and the list to refresh
> when something changes, without the phone handing over what changed.

### A row the provider cannot report whole keeps its place without content, and costs the page neither its other rows nor its cursor

A conversation or message the host refuses to clip (a body, address list or
part count beyond what a row may carry, an address it cannot read, or text
stored as an attachment) arrives as its ID, its date and one of those named
reasons, and nothing else. Its date keeps the page order and the cursor, so
it counts as a row of the page: the rest of the page stays and the next
cursor stays. A clipped row that carries any other field, or a reason that is
not one of the named ones, refuses the whole reply as malformed. A next
cursor is kept only after a page that listed at least one row and only when
it differs from the cursor the page was asked with, so paging always moves
on or ends.

```quint
type ListedRow = WholeRow | IncompleteRow({ reasonNamed: bool, carriesContent: bool })
type PageNext = LastPage | NextCursor({ repeatsAsked: bool })
pure def rowShown(row: ListedRow): bool = match row {
  | WholeRow => true
  | IncompleteRow(r) => r.reasonNamed and not(r.carriesContent)
}
pure def cursorKept(rowsListed: int, pageNext: PageNext): bool = match pageNext {
  | LastPage => true
  | NextCursor(c) => rowsListed > 0 and not(c.repeatsAsked)
}
pure def pageShown(listed: List[ListedRow], pageNext: PageNext): bool =
  listed.every(row => rowShown(row)) and cursorKept(listed.length(), pageNext)
pure val bareIncompleteRow: ListedRow = IncompleteRow({ reasonNamed: true, carriesContent: false })
pure val listedValues = Set(List(), List(WholeRow), List(WholeRow, IncompleteRow({ reasonNamed: true, carriesContent: false })),
  List(IncompleteRow({ reasonNamed: true, carriesContent: true }), WholeRow), List(IncompleteRow({ reasonNamed: false, carriesContent: false })))
pure val pageNextValues = Set(LastPage, NextCursor({ repeatsAsked: false }), NextCursor({ repeatsAsked: true }))
pure def lawAnIncompleteRowKeepsTheRestOfThePageAndItsCursor(listed: List[ListedRow], pageNext: PageNext): bool =
  pageShown(listed, pageNext) implies pageShown(listed.append(bareIncompleteRow), pageNext)
pure def lawNoClippedContentOrUnnamedReasonIsShown(listed: List[ListedRow], pageNext: PageNext, reasonNamed: bool, carriesContent: bool): bool =
  (carriesContent or not(reasonNamed)) implies not(pageShown(listed.append(IncompleteRow({ reasonNamed: reasonNamed, carriesContent: carriesContent })), pageNext))
pure def lawPagingMovesOnOrEnds(rowsListed: int): bool =
  cursorKept(rowsListed, LastPage) and not(cursorKept(rowsListed, NextCursor({ repeatsAsked: true })))
    and not(cursorKept(0, NextCursor({ repeatsAsked: false })))
```

### A change notice carries no message content, and a send update reaches only the handler of its own kind

While the screen watches, Android's notices are passed on without what
changed: a change in the message providers calls the change handler with
nothing, and an SMS or MMS send update gives its own kind's handler only the
send's operation ID. A send update whose ID is not well formed, or of a kind
the screen did not ask to follow, reaches no handler. The watch adds its
listeners before it turns observation on. If setup fails, the watch stops
forwarding notices, attempts to remove every listener it added, and returns
the setup refusal. Stopping also stops forwarding immediately, attempts to
remove every listener, and then turns observation off even if a listener
cannot be removed.

```quint
type ChangeNotice = MessagesChanged | SmsSendUpdated({ wellFormedId: bool }) | MmsSendUpdated({ wellFormedId: bool })
type NoticeHandler = ChangeHandler | SmsSendHandler | MmsSendHandler | NoHandler
pure def noticeHandler(notice: ChangeNotice, smsFollowed: bool, mmsFollowed: bool): NoticeHandler = match notice {
  | MessagesChanged => ChangeHandler
  | SmsSendUpdated(u) => if (u.wellFormedId and smsFollowed) SmsSendHandler else NoHandler
  | MmsSendUpdated(u) => if (u.wellFormedId and mmsFollowed) MmsSendHandler else NoHandler
}
pure val noticeValues = Set(MessagesChanged, SmsSendUpdated({ wellFormedId: true }), SmsSendUpdated({ wellFormedId: false }),
  MmsSendUpdated({ wellFormedId: true }), MmsSendUpdated({ wellFormedId: false }))
pure def lawASendUpdateReachesOnlyItsOwnKindsHandler(notice: ChangeNotice, smsFollowed: bool, mmsFollowed: bool): bool =
  (noticeHandler(notice, smsFollowed, mmsFollowed) == SmsSendHandler implies (notice == SmsSendUpdated({ wellFormedId: true }) and smsFollowed))
    and (noticeHandler(notice, smsFollowed, mmsFollowed) == MmsSendHandler implies (notice == MmsSendUpdated({ wellFormedId: true }) and mmsFollowed))
pure def lawAMalformedSendUpdateReachesNoHandler(smsFollowed: bool, mmsFollowed: bool): bool =
  noticeHandler(SmsSendUpdated({ wellFormedId: false }), smsFollowed, mmsFollowed) == NoHandler
    and noticeHandler(MmsSendUpdated({ wellFormedId: false }), smsFollowed, mmsFollowed) == NoHandler
```

## Story: Name the sender of my latest text without reading it

> As the person, I want the assistant to tell me who sent my newest text,
> and to draft a reply to exactly that sender in exactly that conversation,
> without the phone handing over what the message says.

### A sender lookup reads only the newest incoming row's address, and names it whole only when asked

The lookup is a read with the SMS grant on the unlocked phone in front,
fenced again before it is published. It asks the Inbox for the newest
incoming row, newest date first and the row ID breaking ties, and projects
only its address, with its thread when the whole address is asked for;
it never requests a body and never sees an outgoing row. An empty Inbox
answers empty, and an address that is not a dial-shaped number answers
sender-unavailable. Without the ask it names only the last four digits.
With the ask (the agent's `sms.latest-sender.v2`) it names the whole
dialable number, its separators removed and 2 to 20 digits after an
optional `+`, and Android's thread when the row has one, so that a reply
draft goes to that sender in that conversation; a draft is still reviewed
and sent as above.

```quint
type SenderAsk = AskSenderSuffix | AskSenderAddress
type NewestIncoming = NoIncomingText | SenderNotDialShaped | SenderDialShaped({ digits: int, plusOnlyFirst: bool, thread: int })
type SenderAnswer = SenderInboxEmpty | SenderNotNamed | SenderSuffixNamed | SenderAddressNamed({ withThread: bool }) | SenderNotRead
pure val senderCall: BridgeCall = { need: WhileUnlocked, needsGrant: true, needsFeature: false }
pure val senderSuffixDigits = 4
pure def senderNumberAdmitted(digits: int): bool = digits >= 2 and digits <= 20
pure def senderAnswer(presence: PluginPresence, facts: HostFacts, ask: SenderAsk, newest: NewestIncoming, fenceHolds: bool): SenderAnswer =
  if (admitCall(presence, senderCall, facts) != CallAdmitted or not(fenceHolds)) SenderNotRead
  else match newest {
    | NoIncomingText => SenderInboxEmpty
    | SenderNotDialShaped => SenderNotNamed
    | SenderDialShaped(s) =>
      if (ask == AskSenderAddress) (if (s.plusOnlyFirst and senderNumberAdmitted(s.digits)) SenderAddressNamed({ withThread: s.thread > 0 }) else SenderNotNamed)
      else if (s.digits >= senderSuffixDigits) SenderSuffixNamed
      else SenderNotNamed
  }
pure def senderAddressNamed(answer: SenderAnswer): bool = match answer { | SenderAddressNamed(_) => true | _ => false }
pure def senderNamed(answer: SenderAnswer): bool = answer == SenderSuffixNamed or senderAddressNamed(answer)
pure val newestValues = Set(NoIncomingText, SenderNotDialShaped,
  SenderDialShaped({ digits: 3, plusOnlyFirst: true, thread: 0 }), SenderDialShaped({ digits: 11, plusOnlyFirst: true, thread: 42 }),
  SenderDialShaped({ digits: 11, plusOnlyFirst: false, thread: 7 }), SenderDialShaped({ digits: 21, plusOnlyFirst: true, thread: 1 }),
  SenderDialShaped({ digits: 1, plusOnlyFirst: true, thread: 0 }))
pure val digitsValues = Set(1, 2, 4, 20, 21)
pure def lawASenderIsNamedOnlyWhenTheReadIsAdmittedAndStillFenced(presence: PluginPresence, facts: HostFacts, ask: SenderAsk, newest: NewestIncoming, fenceHolds: bool): bool =
  senderNamed(senderAnswer(presence, facts, ask, newest, fenceHolds)) implies (admitCall(presence, senderCall, facts) == CallAdmitted and fenceHolds)
pure def lawOnlyTheAskNamesTheWholeAddress(presence: PluginPresence, facts: HostFacts, newest: NewestIncoming, fenceHolds: bool): bool =
  not(senderAddressNamed(senderAnswer(presence, facts, AskSenderSuffix, newest, fenceHolds))) and
    senderAnswer(presence, facts, AskSenderAddress, newest, fenceHolds) != SenderSuffixNamed
pure def lawAWholeAddressIsADialableNumber(digits: int): bool =
  senderAddressNamed(senderAnswer(PluginRegistered, { foreground: true, unlocked: true, focused: true, granted: true, featurePresent: true }, AskSenderAddress, SenderDialShaped({ digits: digits, plusOnlyFirst: true, thread: 0 }), true)) iff senderNumberAdmitted(digits)
```
