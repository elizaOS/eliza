# Text messages: reviewed sends, receipts, incoming messages, notices, reads and deletion

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
claim, what the default SMS app stores and announces for an incoming text or
picture message, what a new-message notice action may write, what a page of
conversations or messages may hold and what opening a conversation marks
read, and what a deletion of a message or a conversation may stage in the
[deletion journal](./deferredDeletion.md) and report. Carrier delivery is never inferred. Calls and voicemail are
[phone](./phone.md)'s and [voicemail](./voicemail.md)'s. A new-message
notice is this module's own: it is posted for an incoming message, not for
an agent result, so the account fence and tap tokens of
[notice routes](./noticeRoutes.md) do not apply to it. Pages follow
[keyset paging](./paging.md).

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
pure val eval_witness_sometimesResultSurvivesRetirement = (
  ("beginReview", "op1", NativeDialog, TextMessage, PluginRegistered,
    { foreground: true, unlocked: true, focused: true, granted: true, featurePresent: true }),
  ("finishLookup", NoRecord, NoAnswer),
  ("presentReview", false, 1),
  "approveReview",
  ("dispatchApproved", false, true, true),
  "retireReview",
  ("reportDispatch", SendSubmitted)
)
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

## Story: Keep every message I receive

> As the person, with this app as my SMS app, I want every text and picture
> message that reaches my phone stored once in its conversation and
> announced, so that none is lost, stored twice or announced without being
> there.

### An incoming text is stored before it is announced, and only while the app holds the SMS role

Android delivers an incoming text only to the default SMS app, which must
store it. The receiver joins the parts Android delivered, takes the first
part's sender and time, and hands the store to the module's one worker. The
row goes to the Inbox unread before its notice is asked for, so a notice
Android did not confirm leaves the text stored, and a text that has no
sender or that the provider refused has no notice. Without the role
nothing is stored or announced: Android's SMS app keeps the text. The
broadcast is finished whether the worker stored the text, refused it or
never ran.

```quint
type IncomingText = TextNotOurs | TextNotStored | TextStoredUnannounced | TextStoredAndAnnounced
pure def incomingText(smsRoleHeld: bool, senderKnown: bool, workerRan: bool, providerStored: bool, noticeConfirmed: bool): IncomingText =
  if (not(smsRoleHeld)) TextNotOurs
  else if (not(senderKnown) or not(workerRan) or not(providerStored)) TextNotStored
  else if (noticeConfirmed) TextStoredAndAnnounced
  else TextStoredUnannounced
pure def textKept(arrived: IncomingText): bool = arrived == TextStoredUnannounced or arrived == TextStoredAndAnnounced
pure def lawATextIsKeptExactlyWhenTheRoleHolderStoredIt(smsRoleHeld: bool, senderKnown: bool, workerRan: bool, providerStored: bool, noticeConfirmed: bool): bool =
  textKept(incomingText(smsRoleHeld, senderKnown, workerRan, providerStored, noticeConfirmed)) iff (smsRoleHeld and senderKnown and workerRan and providerStored)
pure def lawOnlyAStoredTextIsAnnounced(smsRoleHeld: bool, senderKnown: bool, workerRan: bool, providerStored: bool, noticeConfirmed: bool): bool =
  incomingText(smsRoleHeld, senderKnown, workerRan, providerStored, noticeConfirmed) == TextStoredAndAnnounced implies (providerStored and noticeConfirmed)
pure def lawAnUnconfirmedNoticeNeverLosesTheText(smsRoleHeld: bool, senderKnown: bool, workerRan: bool, providerStored: bool): bool =
  textKept(incomingText(smsRoleHeld, senderKnown, workerRan, providerStored, false)) == textKept(incomingText(smsRoleHeld, senderKnown, workerRan, providerStored, true))
```

### A picture message is downloaded once for its transaction, stored whole or not at all, and answered only once stored

A WAP push is acted on only by the default SMS app, and only when it is a
message notification that names its transaction and its content location;
delivery and read reports are not stored, since MMS delivery is never
claimed. A notification whose transaction is already stored starts no
download and is answered "retrieved" again, so a carrier that missed the
first answer stops repeating it. A new one starts one download into a
private file. The file is stored only when Android reported the download
done, the role is still held, the file is a retrieved message of at most
`maxIncomingMmsBytes` and its transaction is not stored yet: the message
row with its addresses and every part, or, if one of them fails, nothing,
so the carrier's repeat can store it whole. The carrier is answered
"retrieved" only for a stored message, the private file is removed in every
case, and the notice follows the stored row as it does for a text.

```quint
type WapPush = PushNotANotice | PushNewTransaction | PushStoredTransaction
type PushWork = PushIgnored | PushDownloaded | PushAnsweredAgain
type MmsKept = MmsNotStored | MmsAlreadyStored | MmsStored
pure val maxIncomingMmsBytes = 2097152
pure def pushWork(smsRoleHeld: bool, wapPush: WapPush): PushWork =
  if (not(smsRoleHeld) or wapPush == PushNotANotice) PushIgnored
  else if (wapPush == PushStoredTransaction) PushAnsweredAgain
  else PushDownloaded
pure def keepDownloadedMms(smsRoleHeld: bool, downloadDone: bool, retrievedWithinSize: bool, transactionStored: bool, rowsWritten: bool): MmsKept =
  if (not(smsRoleHeld) or not(downloadDone) or not(retrievedWithinSize)) MmsNotStored
  else if (transactionStored) MmsAlreadyStored
  else if (rowsWritten) MmsStored
  else MmsNotStored
pure def carrierAnswered(pushed: PushWork, kept: MmsKept): bool = pushed == PushAnsweredAgain or (pushed == PushDownloaded and kept == MmsStored)
pure def lawARepeatedNotificationNeverDownloads(smsRoleHeld: bool): bool = pushWork(smsRoleHeld, PushStoredTransaction) != PushDownloaded
pure def lawOnlyTheRoleHolderDownloadsOrStores(wapPush: WapPush, downloadDone: bool, retrievedWithinSize: bool, transactionStored: bool, rowsWritten: bool): bool =
  pushWork(false, wapPush) == PushIgnored and keepDownloadedMms(false, downloadDone, retrievedWithinSize, transactionStored, rowsWritten) == MmsNotStored
pure def lawAPictureMessageIsStoredWholeAndOnce(smsRoleHeld: bool, downloadDone: bool, retrievedWithinSize: bool, transactionStored: bool, rowsWritten: bool): bool =
  keepDownloadedMms(smsRoleHeld, downloadDone, retrievedWithinSize, transactionStored, rowsWritten) == MmsStored iff
    (smsRoleHeld and downloadDone and retrievedWithinSize and not(transactionStored) and rowsWritten)
pure def lawTheCarrierIsAnsweredOnlyForAStoredMessage(smsRoleHeld: bool, downloadDone: bool, retrievedWithinSize: bool, transactionStored: bool, rowsWritten: bool): bool =
  carrierAnswered(PushDownloaded, keepDownloadedMms(smsRoleHeld, downloadDone, retrievedWithinSize, transactionStored, rowsWritten)) implies (rowsWritten and not(transactionStored))
```

### A conversation has one notice, and a newer message replaces it without losing the texts it showed

A notice is tagged with its conversation's whole thread ID, or with the
message's own row when the provider names no thread, so two conversations
whose IDs share a hash never share a notice or a tap. A new message builds
the replacement from the texts the published notice shows and its own,
retires the older notice's Mark read action and asks Android to publish it;
the replacement counts only once Android shows it, within
`noticeConfirmSeconds`. One that is not confirmed has its own action
retired too ([below](#story-mark-a-conversation-read-from-its-notice-without-sending-anything)),
and its message stays stored. The lock screen shows only "New message";
the sender's contact name or number and the texts show once unlocked. Reply
is offered only for a well-formed sender and Mark read only for a known
conversation.

```quint
type ConversationNotice = { texts: int, offersReply: bool, offersMarkRead: bool }
pure val noticeConfirmSeconds = 3
pure def replacementNotice(shownTexts: int, senderWellFormed: bool, threadKnown: bool): ConversationNotice =
  { texts: (if (shownTexts > 0) shownTexts else 0) + 1, offersReply: senderWellFormed, offersMarkRead: threadKnown }
pure val shownTextsValues = Set(-1, 0, 1, 5)
pure def lawAReplacementKeepsEveryTextAlreadyShown(shownTexts: int, senderWellFormed: bool, threadKnown: bool): bool =
  replacementNotice(shownTexts, senderWellFormed, threadKnown).texts >= 1 and replacementNotice(shownTexts, senderWellFormed, threadKnown).texts > shownTexts
pure def lawMarkReadIsOfferedOnlyForAKnownConversation(shownTexts: int, senderWellFormed: bool, threadKnown: bool): bool =
  replacementNotice(shownTexts, senderWellFormed, threadKnown).offersMarkRead == threadKnown
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

## Story: Read my conversations a page at a time

> As the person, I want to read my conversations and the messages of one,
> newest first and a page at a time, and have opening a conversation mark
> read only what I was shown, so that nothing is repeated, skipped or
> marked read behind my back.

### A page of conversations or messages is read only on an unlocked phone with the SMS grant, and holds 1 to 50 rows

A page is a read with the SMS grant on the unlocked phone in front, admitted
as a sender lookup is (`senderCall`), run off the main thread and fenced
again before it is published. Its limit is 1 to `maxConversationPage` rows
and an older-than date, when one is given, is a positive whole number of
milliseconds; any other ask is refused before Android is asked anything.
Messages are read newest first; at one date a picture message comes before a
text, and the higher provider ID first, so that rows with one timestamp are
neither repeated nor lost between two pages. A row the provider cannot
report completely is returned with only its ID, its date and the reason,
never cut short, and drafts and attachment bytes are never read. A
conversation or message waiting in its
[deletion window](./deletionWindow.md) is left off the page.

```quint
import paging as Pg from "./paging"
type PageCheck = PageAdmitted | PageLimitRefused | PageDateRefused
pure val maxConversationPage = 50
pure def checkPageAsk(pageLimit: int, dated: bool, beforeDate: int): PageCheck =
  if (pageLimit < 1 or pageLimit > maxConversationPage) PageLimitRefused
  else if (dated and beforeDate <= 0) PageDateRefused
  else PageAdmitted
pure def messageKey(date: int, kind: MessageKind, rowId: int): Pg::RowKey =
  { major: 0 - date, minor: if (kind == MultimediaMessage) 0 else 1, rowId: 0 - rowId }
pure val pageLimitValues = Set(0, 1, 50, 51)
pure val beforeDateValues = Set(-1, 0, 1)
pure val dateValues = Set(1, 2)
pure val rowIdValues = Set(1, 2)
pure def lawAPageAskIsAdmittedOnlyWithinItsBounds(pageLimit: int, dated: bool, beforeDate: int): bool =
  checkPageAsk(pageLimit, dated, beforeDate) == PageAdmitted iff (pageLimit >= 1 and pageLimit <= maxConversationPage and (not(dated) or beforeDate > 0))
pure def lawNewerMessagesComeFirst(date: int, kind: MessageKind, rowId: int): bool =
  Pg::precedes(messageKey(date + 1, kind, rowId), messageKey(date, kind, rowId)) and Pg::precedes(messageKey(date, kind, rowId + 1), messageKey(date, kind, rowId))
    and Pg::precedes(messageKey(date, MultimediaMessage, rowId), messageKey(date, TextMessage, rowId))
```

### Opening a conversation marks read only its received messages up to the newest one shown, and only as the SMS app

The owner's screen names the conversation and the date of the newest
message it shows. As the default SMS app the module marks read, in SMS and
then MMS, the received rows of that conversation at or before that date
that were still unread, removes the conversation's notice and answers how
many rows changed; a message that arrived after the shown page stays
unread, and a sent row is never touched. Android accepts this write only
from the default SMS app, so without the role nothing is written and the
answer says so with no rows changed; an answer that claims rows without the
role is refused as malformed. The call has the admission and fence of a
read and returns no message content.

```quint
pure def openingMarksRead(smsRoleHeld: bool, received: bool, unread: bool, rowDate: int, throughDate: int): bool =
  smsRoleHeld and received and unread and throughDate > 0 and rowDate <= throughDate
pure def readMarkHolds(defaultSmsApp: bool, updated: int): bool = updated >= 0 and (defaultSmsApp or updated == 0)
pure val rowDateValues = Set(1, 2, 3)
pure val throughDateValues = Set(0, 1, 2)
pure def lawWithoutTheRoleNothingIsMarkedRead(received: bool, unread: bool, rowDate: int, throughDate: int, updated: int): bool =
  not(openingMarksRead(false, received, unread, rowDate, throughDate)) and (readMarkHolds(false, updated) iff updated == 0)
pure def lawAMessageAfterTheShownPageStaysUnread(smsRoleHeld: bool, received: bool, unread: bool, rowDate: int, throughDate: int): bool =
  rowDate > throughDate implies not(openingMarksRead(smsRoleHeld, received, unread, rowDate, throughDate))
pure def lawOnlyReceivedUnreadMessagesAreMarked(smsRoleHeld: bool, received: bool, unread: bool, rowDate: int, throughDate: int): bool =
  openingMarksRead(smsRoleHeld, received, unread, rowDate, throughDate) implies (received and unread)
```
