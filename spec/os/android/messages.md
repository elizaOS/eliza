# Text messages: reviewed sends, receipts, notices and deletion

The messages module (`packages/os/android/messages/`, from
`plugins/plugin-native-messages/android`). A host that declares telephony
subclasses the abstract `TelephonyPlugin` under its own plugin name and
registers it only on a verified system image ([the bridge](./bridge.md));
the client's default name is `ElizaTelephony`. The owner and Android role
policy stay the host's. The operations `sms-send` and `mms-send`, their
shape checks and the capabilities `sms.send.v1`, `mms.send.v1` and
`messages.read.v1` are the agent's
([operations](../../agent/deviceActions/operations.md),
[capabilities](../../agent/deviceActions/capabilities.md)); this spec keeps
what Android must confirm before a send, what the send journal answers, what
a receipt may claim, what is written to Android's providers, what a notice
action may do and what a deletion may report. Carrier delivery is never
inferred. Calls and voicemail are [phone](./phone.md)'s and
[voicemail](./voicemail.md)'s.

## Story: Send only what I reviewed, once

> As the person, I want to review a message before it is sent, cancel it
> until Android takes it, and have it go out at most once even if I press
> Send twice or the phone restarts mid-send, so that nothing is sent I did
> not approve and I am told honestly when the phone cannot know whether it
> went.

### Native confirmation and current ownership precede dispatch, and a cancel is refused once Android has the message

A send is admitted only from the unlocked phone in front, with the send
grant and a phone that can send texts. The send captures its operation ID
before its journal lookup. A usable journal answer queues the native review
dialog, which the visible owner can approve once. A cancel for the exact
operation retires it before it is acknowledged; a background or destroyed
owner also retires it; a cancel for another ID changes nothing. Retirement
before dispatch settles as cancelled with no platform call. Once Android has
accepted the dispatch, a cancel is refused, and the real or unknown result
stays reportable even if the owner goes away.

```quint
import bridge.* from "./bridge"
type ReviewPhase = NoReview | ReadingJournal | MainQueued | Reviewing | ApprovedForDispatch | NativeDispatched | ReviewSettled
type ReviewResult = NoReviewResult | ReviewCancelled | ReviewRefused | ReviewSubmitted | ReviewFailed | ReviewUnknown
type SmsReview = {
  phase: ReviewPhase, operationId: str, retired: bool, cancelAcknowledged: bool,
  dispatched: bool, result: ReviewResult
}
pure val initial: SmsReview = {
  phase: NoReview, operationId: "", retired: false, cancelAcknowledged: false,
  dispatched: false, result: NoReviewResult
}
pure val sendCall: BridgeCall = { need: WhileUnlocked, needsGrant: true, needsFeature: true }
pure def canBeginReview(s: SmsReview, operationId: str, admission: Admission): bool =
  s.phase == NoReview and operationId != "" and admission == CallAdmitted
pure def beginReview(s: SmsReview, operationId: str, admission: Admission): SmsReview =
  { ...s, phase: ReadingJournal, operationId: operationId }
pure def canFinishLookup(s: SmsReview): bool = s.phase == ReadingJournal
pure def finishLookup(s: SmsReview, journalAllowsReview: bool): SmsReview =
  if (s.retired) { ...s, phase: ReviewSettled, result: ReviewCancelled }
  else if (journalAllowsReview) { ...s, phase: MainQueued }
  else { ...s, phase: ReviewSettled, result: ReviewRefused }
pure def canShowReview(s: SmsReview): bool = s.phase == MainQueued and not(s.retired)
pure def showReview(s: SmsReview): SmsReview = { ...s, phase: Reviewing }
pure def canApproveReview(s: SmsReview): bool = s.phase == Reviewing and not(s.retired)
pure def approveReview(s: SmsReview): SmsReview = { ...s, phase: ApprovedForDispatch }
pure def canRejectReview(s: SmsReview): bool = s.phase == Reviewing and not(s.retired)
pure def rejectReview(s: SmsReview): SmsReview = { ...s, phase: ReviewSettled, result: ReviewCancelled }
pure def pendingReview(s: SmsReview): bool = s.phase != NoReview and s.phase != ReviewSettled
pure def canCancelReview(s: SmsReview, operationId: str): bool =
  pendingReview(s) and operationId == s.operationId and not(s.cancelAcknowledged) and not(s.dispatched)
pure def cancelReview(s: SmsReview, operationId: str): SmsReview = { ...s, retired: true, cancelAcknowledged: true }
pure def canRetireReview(s: SmsReview): bool = pendingReview(s) and not(s.retired)
pure def retireReview(s: SmsReview): SmsReview = { ...s, retired: true }
pure def canSettleRetiredReview(s: SmsReview): bool =
  s.retired and (s.phase == MainQueued or s.phase == Reviewing or s.phase == ApprovedForDispatch)
pure def settleRetiredReview(s: SmsReview): SmsReview = { ...s, phase: ReviewSettled, result: ReviewCancelled }
pure def canDispatchApproved(s: SmsReview): bool = s.phase == ApprovedForDispatch and not(s.retired) and not(s.dispatched)
pure def dispatchApproved(s: SmsReview): SmsReview = { ...s, phase: NativeDispatched, dispatched: true }
pure def canReportDispatch(s: SmsReview, receipt: ReviewResult): bool =
  s.phase == NativeDispatched and (receipt == ReviewSubmitted or receipt == ReviewFailed or receipt == ReviewUnknown)
pure def reportDispatch(s: SmsReview, receipt: ReviewResult): SmsReview = { ...s, phase: ReviewSettled, result: receipt }
pure val operationIdValues = Set("", "op1", "op2")
pure val admissionValues = Set(CallAdmitted, HostNotReady, PermissionRequired)
pure def alwaysCancellationOwnsRetirement(s: SmsReview): bool = s.cancelAcknowledged implies s.retired
pure def alwaysAcknowledgedCancelNeverDispatches(s: SmsReview): bool = s.cancelAcknowledged implies not(s.dispatched)
pure def alwaysDispatchHasOwnedPhase(s: SmsReview): bool =
  s.dispatched == (s.phase == NativeDispatched or s.result == ReviewSubmitted or s.result == ReviewFailed or s.result == ReviewUnknown)
pure def alwaysTerminalResultIsExplicit(s: SmsReview): bool = (s.phase == ReviewSettled) == (s.result != NoReviewResult)
pure def alwaysReviewNamesItsOperation(s: SmsReview): bool = (s.phase == NoReview) == (s.operationId == "")
pure def stepKnownResultPersists(before: SmsReview, after: SmsReview): bool =
  before.result != NoReviewResult implies after.result == before.result
pure def stepOperationNeverChanges(before: SmsReview, after: SmsReview): bool =
  before.operationId != "" implies after.operationId == before.operationId
pure def sometimesCancelledBeforeInvoke(s: SmsReview): bool = s.result == ReviewCancelled and s.cancelAcknowledged
pure def sometimesResultSurvivesRetirement(s: SmsReview): bool = s.result == ReviewSubmitted and s.retired
```

### A repeated operation ID reads its journal record and never sends again

Each reviewed send carries an operation ID, the idempotency key of the
send, and the journal records it before any platform call. The record holds
a hash of the recipients, the text and the subscription (and, for an MMS,
each attachment's type, name, hash and size), never the text or bytes. A
repeated ID with the same content answers its record and sends nothing; a
repeated ID with other content is refused. A new ID is denied without a
platform call when sending is not permitted or the text cannot be divided
into one to `maxPartsPerRecipient` parts for each recipient; otherwise its
dispatch is recorded and then started. A dropped record leaves a tombstone,
so a repeated dropped ID answers unknown and is never sent. SMS and MMS
share the journal and its ID space.

```quint
type JournalRecord = JournalNone | JournalDenied | JournalCancelled | JournalDispatching | JournalSubmitted | JournalSent | JournalDelivered | JournalFailed | JournalUnknown | JournalDropped
type SendPlan = { planned: JournalRecord, dispatch: bool, reuseRefused: bool }
pure val maxPartsPerRecipient = 10
pure def divisible(parts: int): bool = parts >= 1 and parts <= maxPartsPerRecipient
pure def planSend(existing: JournalRecord, sameContent: bool, permitted: bool, parts: int): SendPlan =
  if (existing == JournalNone)
    (if (permitted and divisible(parts)) { planned: JournalDispatching, dispatch: true, reuseRefused: false }
     else { planned: JournalDenied, dispatch: false, reuseRefused: false })
  else if (not(sameContent)) { planned: existing, dispatch: false, reuseRefused: true }
  else { planned: existing, dispatch: false, reuseRefused: false }
pure def sendAnswer(plan: SendPlan): JournalRecord = if (plan.planned == JournalDropped) JournalUnknown else plan.planned
pure val partsValues = Set(0, 1, 10, 11)
pure def lawRepeatedOperationNeverSends(existing: JournalRecord, sameContent: bool, permitted: bool, parts: int): bool =
  existing != JournalNone implies (not(planSend(existing, sameContent, permitted, parts).dispatch) and planSend(existing, sameContent, permitted, parts).planned == existing)
pure def lawDroppedOperationAnswersUnknown(permitted: bool, parts: int): bool =
  sendAnswer(planSend(JournalDropped, true, permitted, parts)) == JournalUnknown
pure def lawReusedOperationForOtherContentIsRefused(existing: JournalRecord, permitted: bool, parts: int): bool =
  existing != JournalNone implies planSend(existing, false, permitted, parts).reuseRefused
pure def lawNewSendDispatchesOnlyWhenPermittedAndDivisible(permitted: bool, parts: int): bool =
  planSend(JournalNone, true, permitted, parts).dispatch iff (permitted and divisible(parts))
```

### An interrupted send reads unknown, and only receipts advance a record

A record still dispatching when the process dies, or submitted when a
restart means its sent receipts can no longer arrive, becomes unknown, and an
unknown record is never sent again. Submitted means every platform call
returned; sent needs a successful sent receipt for every part; delivered
needs a complete delivery report for every part. An MMS is sent on the
carrier's confirmation and is never reported delivered. After seven days no
more evidence is awaited for a record.

```quint
pure val evidenceWindowDays = 7
pure def recoverAfterRestart(r: JournalRecord): JournalRecord =
  if (r == JournalDispatching or r == JournalSubmitted) JournalUnknown else r
pure def settleEvidence(r: JournalRecord, groupMessage: bool, allSent: bool, allDelivered: bool): JournalRecord =
  if (r == JournalSubmitted and allSent) JournalSent
  else if (r == JournalSent and allDelivered and not(groupMessage)) JournalDelivered
  else r
pure def lawInterruptedDispatchIsUnknownAndNotResent(sameContent: bool, permitted: bool, parts: int): bool =
  recoverAfterRestart(JournalDispatching) == JournalUnknown and
    not(planSend(recoverAfterRestart(JournalDispatching), sameContent, permitted, parts).dispatch)
pure def lawGroupMessageNeverDelivered(r: JournalRecord, allSent: bool, allDelivered: bool): bool =
  settleEvidence(r, true, allSent, allDelivered) == JournalDelivered implies r == JournalDelivered
pure def lawSentNeedsEveryReceipt(r: JournalRecord, groupMessage: bool, allDelivered: bool): bool =
  settleEvidence(r, groupMessage, false, allDelivered) != JournalSent or r == JournalSent
```

### A message's reported status is supported by the evidence of every part

A text is divided into parts for each recipient, each with its own sent and
delivery evidence; a part is delivered only after it was sent. A cancelled
or denied send has no evidence. Submitted, sent and delivered need at least one
part for every recipient and nothing else; submitted needs no part to have
failed; sent needs every part sent; delivered needs every part delivered.
An MMS result carries no parts and is never delivered.

```quint
type PartState = PartUnknown | PartSucceeded | PartFailed
type PartEvidence = { recipientIndex: int, sentState: PartState, deliveryState: PartState }
type SendStatus = StatusCancelled | StatusDenied | StatusFailed | StatusUnknown | StatusSubmitted | StatusSent | StatusDelivered
pure def partConsistent(p: PartEvidence): bool = p.deliveryState == PartSucceeded implies p.sentState == PartSucceeded
pure def recipientsCovered(evidence: List[PartEvidence], recipients: int): bool = {
  val seen = evidence.foldl(Set(), (acc, p) => acc.union(Set(p.recipientIndex)))
  recipients >= 1 and evidence.length() > 0 and seen.size() == recipients and seen.forall(i => i >= 0 and i < recipients)
}
pure def statusSupported(status: SendStatus, evidence: List[PartEvidence], recipients: int): bool =
  evidence.every(p => partConsistent(p)) and
  (if (status == StatusCancelled or status == StatusDenied) evidence.length() == 0
   else if (status == StatusSubmitted) recipientsCovered(evidence, recipients) and evidence.every(p => p.sentState != PartFailed and p.deliveryState != PartFailed)
   else if (status == StatusSent) recipientsCovered(evidence, recipients) and evidence.every(p => p.sentState == PartSucceeded)
   else if (status == StatusDelivered) recipientsCovered(evidence, recipients) and evidence.every(p => p.deliveryState == PartSucceeded)
   else true)
pure def mmsStatusAllowed(status: SendStatus): bool = status != StatusDelivered
pure val evidenceValues = Set(
  List(),
  List({ recipientIndex: 0, sentState: PartSucceeded, deliveryState: PartSucceeded }),
  List({ recipientIndex: 0, sentState: PartSucceeded, deliveryState: PartUnknown }, { recipientIndex: 1, sentState: PartFailed, deliveryState: PartUnknown }),
  List({ recipientIndex: 0, sentState: PartUnknown, deliveryState: PartSucceeded })
)
pure val recipientsValues = Set(0, 1, 2)
pure def lawDeliveredNeedsEveryPartDelivered(evidence: List[PartEvidence], recipients: int): bool =
  statusSupported(StatusDelivered, evidence, recipients) implies
    (evidence.length() > 0 and evidence.every(p => p.sentState == PartSucceeded and p.deliveryState == PartSucceeded))
pure def lawSentNeedsEveryPartSent(evidence: List[PartEvidence], recipients: int): bool =
  statusSupported(StatusSent, evidence, recipients) implies (evidence.length() > 0 and evidence.every(p => p.sentState == PartSucceeded))
pure def lawRefusedSendHasNoParts(evidence: List[PartEvidence], recipients: int): bool =
  (statusSupported(StatusCancelled, evidence, recipients) or statusSupported(StatusDenied, evidence, recipients)) implies evidence.length() == 0
pure def lawMmsIsNeverDelivered(status: SendStatus): bool = mmsStatusAllowed(status) iff status != StatusDelivered
```

### An outgoing message only moves forward, and only a review that never left the app or a refused send may be reviewed again

A handoff ends the app's part; a direct send records what the radio
reports. Handed off, delivered, failed and unknown are final. A message that
may exist is never offered again: only a review that never left the app, or
a send the radio refused, may be offered again, and then only as a new
review with a new operation ID. No result permits an automatic repeat.

```quint
type OutgoingState = OutReviewed | OutHandedOff | OutDispatched | OutSent | OutDelivered | OutFailed | OutcomeUnknown
pure def outgoingMayMove(origin: OutgoingState, target: OutgoingState): bool =
  if (origin == OutReviewed) target == OutHandedOff or target == OutDispatched or target == OutFailed
  else if (origin == OutDispatched) target == OutSent or target == OutFailed or target == OutcomeUnknown
  else if (origin == OutSent) target == OutDelivered
  else false
pure def mayBeReviewedAgain(outgoing: OutgoingState): bool = outgoing == OutReviewed or outgoing == OutFailed
pure def outgoingFinal(outgoing: OutgoingState): bool =
  outgoing == OutHandedOff or outgoing == OutDelivered or outgoing == OutFailed or outgoing == OutcomeUnknown
pure def lawFinalStatesNeverMove(origin: OutgoingState, target: OutgoingState): bool = outgoingFinal(origin) implies not(outgoingMayMove(origin, target))
pure def lawNothingReturnsToReview(origin: OutgoingState): bool = not(outgoingMayMove(origin, OutReviewed))
pure def lawPossiblySentIsNeverReviewedAgain(outgoing: OutgoingState): bool =
  (outgoing == OutHandedOff or outgoing == OutDispatched or outgoing == OutSent or outgoing == OutDelivered or outgoing == OutcomeUnknown) implies not(mayBeReviewedAgain(outgoing))
```

### Only the owner's reviewed sends and incoming messages are written to the Android providers

The bridge writes a row into Android's SMS or MMS providers only for an
incoming message or a send the owner reviewed, and only while the app holds
the default SMS role. The assistant's own text, briefings and proposals are
never written there or into a thread. The SMS role is requested only through
Android's role dialog, offered only when the host declares every component
Android requires for it; the person decides and the bridge reads the result
back. A group message or attachment send needs direct sending, the host's
message file provider and the default SMS role.

```quint
type ProviderWriteSource = OwnerReviewedSend | IncomingMessage | AssistantText
pure def providerWriteAdmitted(source: ProviderWriteSource, smsRoleHeld: bool): bool = smsRoleHeld and source != AssistantText
pure def roleRequestOffered(roleAvailable: bool, roleHeld: bool, hostEligible: bool): bool = roleAvailable and not(roleHeld) and hostEligible
pure def groupSendAvailable(directSend: bool, fileProvider: bool, smsRoleHeld: bool): bool = directSend and fileProvider and smsRoleHeld
pure def lawAssistantTextNeverReachesProviders(smsRoleHeld: bool): bool = not(providerWriteAdmitted(AssistantText, smsRoleHeld))
pure def lawNoProviderWriteWithoutRole(source: ProviderWriteSource): bool = not(providerWriteAdmitted(source, false))
pure def lawIneligibleHostIsNeverOfferedARole(roleAvailable: bool, roleHeld: bool): bool = not(roleRequestOffered(roleAvailable, roleHeld, false))
pure def lawGroupSendNeedsSmsRole(directSend: bool, fileProvider: bool): bool = not(groupSendAvailable(directSend, fileProvider, false))
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
the notice for a retry. Each conversation keeps its own full identity, so
colliding hashed IDs never redirect a write. Reply opens the compose screen.
A notice action's only effects are marking read and opening compose, so none
can send, and every worker run releases the held receiver.

```quint
type NoticeTicket = { captured: int, current: int, visible: int, roleHeld: bool }
type NoticeWork = SkipStaleNotice | DismissWithoutWrite | MarkConversationRead
type NoticeAction = NoticeMarkRead | NoticeReply
type NoticeEffect = ProviderReadWrite | OpenCompose
pure def noticeWork(ticket: NoticeTicket): NoticeWork =
  if (ticket.captured == 0 or ticket.captured != ticket.current or ticket.captured != ticket.visible) SkipStaleNotice
  else if (not(ticket.roleHeld)) DismissWithoutWrite
  else MarkConversationRead
pure def noticeDismissed(work: NoticeWork, smsAcknowledged: bool, mmsAcknowledged: bool): bool =
  work == DismissWithoutWrite or (work == MarkConversationRead and smsAcknowledged and mmsAcknowledged)
pure def noticeEffect(noticeAction: NoticeAction): NoticeEffect = if (noticeAction == NoticeReply) OpenCompose else ProviderReadWrite
pure val ticketValues = Set(
  { captured: 1, current: 1, visible: 1, roleHeld: true },
  { captured: 1, current: 1, visible: 1, roleHeld: false },
  { captured: 1, current: 2, visible: 2, roleHeld: true },
  { captured: 1, current: 0, visible: 2, roleHeld: true },
  { captured: 2, current: 2, visible: 1, roleHeld: true }
)
pure val workValues = Set(SkipStaleNotice, DismissWithoutWrite, MarkConversationRead)
pure def lawStaleNoticeNeverWrites(ticket: NoticeTicket): bool =
  (ticket.captured != ticket.current or ticket.captured != ticket.visible) implies noticeWork(ticket) == SkipStaleNotice
pure def lawLostRoleNeverWrites(ticket: NoticeTicket): bool = not(ticket.roleHeld) implies noticeWork(ticket) != MarkConversationRead
pure def lawPartialProviderFailureKeepsNotice(work: NoticeWork): bool =
  work == MarkConversationRead implies (not(noticeDismissed(work, true, false)) and not(noticeDismissed(work, false, true)))
```

### Marking a conversation read from the app changes nothing unless the app is the default SMS app

The owner marks a conversation read up to the newest message shown. Only
the default SMS app may keep read state, so elsewhere the answer says the
app is not the default and that no row changed.

```quint
pure def readMarkerConsistent(defaultSmsApp: bool, updated: int): bool = updated >= 0 and (defaultSmsApp or updated == 0)
pure val updatedValues = Set(-1, 0, 2)
pure def lawNoReadStateWithoutTheRole(updated: int): bool = readMarkerConsistent(false, updated) iff updated == 0
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
`Deleted`; a delete that removed nothing is explained by a second read, and
a lost reply or an unexplained count is unknown, which never grants a retry
or hides the message. A deletion never sends, cancels a send or retries.

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
