# Native message review, notices and exact cancellation

A consumer that declares telephony registers its telephony plugin only on
a verified system image ([bridge composition](./bridge.md)). The plugin
subclasses Eliza's `TelephonyPlugin` from
`plugins/plugin-native-messages/android`. Its owner and Android role
policy remain consumer supplied. Android permissions, image evidence, role
and destination validation are host admission, and carrier delivery is never
inferred. The agent's
[telephony review](../../agent/deviceActions/telephonyReview.md) decides
what reaches this review.

## Story: Review one message and cancel before native invocation

> As the person, I want to review a message before it is sent and be able
> to cancel it until Android takes it, so that nothing is sent I did not
> approve.

### Native confirmation and current ownership must precede dispatch

The authenticated operation captures its exact ID before its journal
lookup. A usable journal result may queue a review dialog. The visible
owner can approve that dialog once. A cancel for the exact operation
retires it before acknowledging. A background or destroyed owner also
retires it. A cancel for another ID does not affect it. Retirement
before the native dispatch settles as cancelled with no invocation.
After the platform accepts dispatch, the actual or ambiguous result
remains reportable even if the owner retires. Idempotency across
repeated operation IDs is the send journal's, in the story below.

```quint
type ReviewPhase = NoReview | ReadingJournal | MainQueued | Reviewing | ApprovedForDispatch | NativeDispatched | ReviewSettled
type NativeMessageResult = NoMessageResult | MessageCancelled | MessageRefused | MessageSubmitted | MessageFailed | MessageUnknown
type SmsReview = {
  phase: ReviewPhase, operationId: int, retired: bool, cancelAcknowledged: bool,
  dispatched: bool, result: NativeMessageResult
}
pure val initial: SmsReview = {
  phase: NoReview, operationId: 0, retired: false, cancelAcknowledged: false,
  dispatched: false, result: NoMessageResult
}
pure def canBeginReview(s: SmsReview, operationId: int, deviceAdmitted: bool): bool =
  s.phase == NoReview and operationId > 0 and deviceAdmitted
pure def beginReview(s: SmsReview, operationId: int, deviceAdmitted: bool): SmsReview =
  {...s, phase: ReadingJournal, operationId: operationId}
pure val operationIdValues = Set(0, 1, 2)
pure def canFinishLookup(s: SmsReview): bool = s.phase == ReadingJournal
pure def finishLookup(s: SmsReview, journalAllowsReview: bool): SmsReview =
  if (s.retired) {...s, phase: ReviewSettled, result: MessageCancelled}
  else if (journalAllowsReview) {...s, phase: MainQueued}
  else {...s, phase: ReviewSettled, result: MessageRefused}
pure def canShowReview(s: SmsReview): bool = s.phase == MainQueued and not(s.retired)
pure def showReview(s: SmsReview): SmsReview = {...s, phase: Reviewing}
pure def canApproveReview(s: SmsReview): bool = s.phase == Reviewing and not(s.retired)
pure def approveReview(s: SmsReview): SmsReview = {...s, phase: ApprovedForDispatch}
pure def canRejectReview(s: SmsReview): bool = s.phase == Reviewing and not(s.retired)
pure def rejectReview(s: SmsReview): SmsReview = {...s, phase: ReviewSettled, result: MessageCancelled}
pure def pendingReview(s: SmsReview): bool = s.phase != NoReview and s.phase != ReviewSettled
pure def canCancelReview(s: SmsReview, operationId: int): bool = pendingReview(s) and operationId == s.operationId and not(s.cancelAcknowledged)
pure def cancelReview(s: SmsReview, operationId: int): SmsReview = {...s, retired: true, cancelAcknowledged: true}
pure def canRetireReview(s: SmsReview): bool = pendingReview(s) and not(s.retired)
pure def retireReview(s: SmsReview): SmsReview = {...s, retired: true}
pure def canSettleRetiredReview(s: SmsReview): bool =
  s.retired and (s.phase == MainQueued or s.phase == Reviewing or s.phase == ApprovedForDispatch)
pure def settleRetiredReview(s: SmsReview): SmsReview = {...s, phase: ReviewSettled, result: MessageCancelled}
pure def canDispatchApproved(s: SmsReview): bool =
  s.phase == ApprovedForDispatch and not(s.retired) and not(s.dispatched)
pure def dispatchApproved(s: SmsReview): SmsReview = {...s, phase: NativeDispatched, dispatched: true}
pure def canReportDispatch(s: SmsReview, receipt: NativeMessageResult): bool =
  s.phase == NativeDispatched and (receipt == MessageSubmitted or receipt == MessageFailed or receipt == MessageUnknown)
pure def reportDispatch(s: SmsReview, receipt: NativeMessageResult): SmsReview =
  {...s, phase: ReviewSettled, result: receipt}
pure def alwaysCancellationOwnsRetirement(s: SmsReview): bool = s.cancelAcknowledged implies s.retired
pure def alwaysDispatchHasOwnedPhase(s: SmsReview): bool =
  s.dispatched == (s.phase == NativeDispatched or s.result == MessageSubmitted or s.result == MessageFailed or s.result == MessageUnknown)
pure def alwaysTerminalResultIsExplicit(s: SmsReview): bool = (s.phase == ReviewSettled) == (s.result != NoMessageResult)
pure def stepCancelledCannotInvoke(before: SmsReview, after: SmsReview): bool =
  before.cancelAcknowledged implies after.dispatched == before.dispatched
pure def stepKnownResultPersists(before: SmsReview, after: SmsReview): bool =
  before.result != NoMessageResult implies after.result == before.result
pure def sometimesCancelledBeforeInvoke(s: SmsReview): bool = s.result == MessageCancelled and s.cancelAcknowledged
pure def sometimesResultSurvivesRetirement(s: SmsReview): bool = s.result == MessageSubmitted and s.retired
```

## Story: Mark a conversation read from its notice without sending anything

> As the person, I want the Mark read action on a new-message notice to
> mark exactly that conversation read and dismiss only its notice, and
> never to send a message for me.

### A notice action writes only for its own conversation and only while its ticket is current

The action captures the notice's ticket when chosen. A newer incoming
message for the same conversation advances the ticket, and a failed
publication of that newer notice clears it, so the old action can no
longer write even if the newer notice later appears. The worker writes
only while the default-SMS role is held and the captured ticket is both
the current and the visible one; it marks SMS read first and MMS read
second, and dismisses the notice only after both providers acknowledge.
Without the role it dismisses the notice and writes nothing. A partial
provider failure keeps the notice for a retry. Each conversation keeps
its own full identity, so colliding hashed IDs never redirect a write.
Reply opens the compose screen. A notice action's only effects are
marking read in the providers and opening compose, so none can send, and every worker
run releases the held receiver.

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
  ticket.captured != ticket.current or ticket.captured != ticket.visible implies noticeWork(ticket) == SkipStaleNotice
pure def lawLostRoleNeverWrites(ticket: NoticeTicket): bool = not(ticket.roleHeld) implies noticeWork(ticket) != MarkConversationRead
pure def lawPartialProviderFailureKeepsNotice(work: NoticeWork): bool =
  work == MarkConversationRead implies not(noticeDismissed(work, true, false)) and not(noticeDismissed(work, false, true))
```

## Story: Send a reviewed message at most once, whatever is repeated

> As the person, I want a message I approved to go out at most once, even
> if I press Send twice or the phone restarts mid-send, and to be told
> honestly when the phone cannot know whether it went.

### A repeated operation ID reads its journal record and never sends again

Each reviewed send carries an operation ID, the idempotency key of the
shared `sms.send.v1` and `mms.send.v1` device-action contracts, and the
journal records it before any platform call. The record holds a hash of
the recipients, the text and the subscription (and, for a group message,
each attachment's type, name, hash and size), never the text or bytes. A
repeated ID with the same content answers its record's status and sends
nothing; a repeated ID with other content is refused. A new ID is denied
without a platform call when sending is not permitted or the text cannot
be divided into at most ten parts for each recipient; otherwise its dispatch is recorded and
then started. A dropped record leaves a tombstone, or a filter entry with
no false negatives, so a repeated dropped ID answers unknown and is never
sent. Group messages share the ID space.

```quint
type JournalRecord = JournalNone | JournalDenied | JournalCancelled | JournalDispatching | JournalSubmitted | JournalSent | JournalDelivered | JournalUnknown | JournalDropped
type SendPlan = { planned: JournalRecord, dispatch: bool, reuseRefused: bool }
pure def planSend(existing: JournalRecord, sameContent: bool, permitted: bool, divisible: bool): SendPlan =
  if (existing == JournalNone)
    (if (permitted and divisible) { planned: JournalDispatching, dispatch: true, reuseRefused: false }
     else { planned: JournalDenied, dispatch: false, reuseRefused: false })
  else if (not(sameContent)) { planned: existing, dispatch: false, reuseRefused: true }
  else { planned: existing, dispatch: false, reuseRefused: false }
pure def sendAnswer(plan: SendPlan): JournalRecord = if (plan.planned == JournalDropped) JournalUnknown else plan.planned
pure def lawRepeatedOperationNeverSends(existing: JournalRecord, sameContent: bool, permitted: bool, divisible: bool): bool =
  existing != JournalNone implies not(planSend(existing, sameContent, permitted, divisible).dispatch) and
    planSend(existing, sameContent, permitted, divisible).planned == existing
pure def lawDroppedOperationAnswersUnknown(permitted: bool, divisible: bool): bool =
  sendAnswer(planSend(JournalDropped, true, permitted, divisible)) == JournalUnknown
pure def lawReusedOperationForOtherContentIsRefused(existing: JournalRecord, permitted: bool, divisible: bool): bool =
  existing != JournalNone implies planSend(existing, false, permitted, divisible).reuseRefused
pure def lawUnpermittedSendIsDeniedWithoutDispatch(divisible: bool): bool =
  planSend(JournalNone, true, false, divisible) == { planned: JournalDenied, dispatch: false, reuseRefused: false }
```

### An interrupted send reads unknown, and only receipts advance a record

A record still dispatching when the process dies, or submitted when a
restart means its sent receipts can no longer arrive, becomes unknown,
and an unknown record is never sent again. Submitted means every platform
call returned; sent needs a successful sent receipt for every part;
delivered needs a complete delivery report for every part. A group
message is sent on the carrier's confirmation and is never reported
delivered. After seven days no more evidence is awaited for a record.

```quint
pure def recoverAfterRestart(r: JournalRecord): JournalRecord =
  if (r == JournalDispatching or r == JournalSubmitted) JournalUnknown else r
pure def settleEvidence(r: JournalRecord, groupMessage: bool, allSent: bool, allDelivered: bool): JournalRecord =
  if (r == JournalSubmitted and allSent) JournalSent
  else if (r == JournalSent and allDelivered and not(groupMessage)) JournalDelivered
  else r
pure def lawInterruptedDispatchIsUnknownAndNotResent(sameContent: bool, permitted: bool, divisible: bool): bool =
  recoverAfterRestart(JournalDispatching) == JournalUnknown and
  not(planSend(recoverAfterRestart(JournalDispatching), sameContent, permitted, divisible).dispatch)
pure def lawGroupMessageNeverDelivered(r: JournalRecord, allSent: bool, allDelivered: bool): bool =
  settleEvidence(r, true, allSent, allDelivered) == JournalDelivered implies r == JournalDelivered
pure def lawSentNeedsEveryReceipt(r: JournalRecord, groupMessage: bool, allDelivered: bool): bool =
  settleEvidence(r, groupMessage, false, allDelivered) != JournalSent or r == JournalSent
```

### Only the owner's reviewed sends and incoming messages are written to the Android providers

The messages bridge writes a row into Android's SMS, MMS or call-log
providers only for an incoming message or a send the owner reviewed, and
only while the app holds the default SMS role. The assistant's own text,
briefings and proposals are never written there or into a thread. The
SMS and dialer roles are requested only through Android's role dialog,
offered only when the host declares every component Android requires for
that role; the person decides and the bridge re-reads the result. A group
message or attachment send is available only with direct sending, the
host's message file provider and the default SMS role.

```quint
type ProviderWriteSource = OwnerReviewedSend | IncomingMessage | AssistantText
pure def providerWriteAdmitted(source: ProviderWriteSource, smsRoleHeld: bool): bool =
  smsRoleHeld and source != AssistantText
pure def roleRequestOffered(roleAvailable: bool, roleHeld: bool, hostEligible: bool): bool =
  roleAvailable and not(roleHeld) and hostEligible
pure def groupSendAvailable(directSend: bool, fileProvider: bool, smsRoleHeld: bool): bool =
  directSend and fileProvider and smsRoleHeld
pure def lawAssistantTextNeverReachesProviders(smsRoleHeld: bool): bool = not(providerWriteAdmitted(AssistantText, smsRoleHeld))
pure def lawNoProviderWriteWithoutRole(source: ProviderWriteSource): bool = not(providerWriteAdmitted(source, false))
pure def lawIneligibleHostIsNeverOfferedARole(roleAvailable: bool, roleHeld: bool): bool =
  not(roleRequestOffered(roleAvailable, roleHeld, false))
pure def lawGroupSendNeedsSmsRole(directSend: bool, fileProvider: bool): bool = not(groupSendAvailable(directSend, fileProvider, false))
```
