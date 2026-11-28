# Agent notice projection

The agent's notifications reach Android through the native projection in
`android/notifications/` (`NativeNotificationInbox`,
`NativeNotificationWire`, `NativeNotificationChannels`,
`NativeNotificationProjector`, `NativeNotificationRoute`). The agent owns the
inbox and its pages ([notification cursor](../../core/notifications/cursor.md));
this machine owns the device's durable journal for the signed-in account: its
epoch, the coordinate it has closed through, the fence of an unfinished
crawl, the live buffer, and the post receipts of the
[notice routes](./noticeRoutes.md) ledger. The projection reads inbox pages
and live notice events through the native caller path of the agent service
(`AgentService` request and subscription on the native route table,
[agent channel](../agentService/channel.md)), never through the renderer.

The machine follows one notification through a baseline or catch-up crawl.
A page is abstracted to the cursor it answers, the coordinate it closes
through (`closes`, the cursor's next `after`) and what it says of that
notification's row. Inbox epochs are identities; here a positive number
stands for one and `0` for none yet. Journal bounds and compaction stay in
the shell.

## Story: Show the agent's notices once

> As the owner, I want a live notice and the inbox page it belongs to to agree
> on what I have seen, so that nothing I already saw is announced again,
> nothing new is missed, and one notice never interrupts me twice.

### A retained arrival waits for matching evidence inside an exhausted fence

A live notification that arrives before the baseline is ready, or from
another epoch than the journal's, enters the durable buffer. A page of the
crawl that shows its exact epoch and sequence records that evidence, which
holds for the rest of the same fence. Only a complete page of its own epoch
whose fence covers it settles a buffered arrival: observed evidence projects
it (or ignores it when the row is read, low priority or expired), and no
evidence means it was deleted, so it is dropped without posting. An arrival
above the fence waits for the next fence. A row the first complete crawl
finds without a live counterpart becomes a baseline receipt and never posts.

```quint
import noticeRoutes.* from "./noticeRoutes"
import cursor as K from "../../core/notifications/cursor"
type ReceiptPhase = NoneSeen | Buffered | Projected | BaselineOnly | Ignored | Gone
type ArrivalEvidence = Unobserved | ObservedLive | ObservedMuted
type PageRow = RowAbsent | RowLive | RowMuted
type PageEvidence = { query: K::Cursor, closes: int, coordinate: int, row: PageRow }
type NoticeProjection = {
  receipt: ReceiptPhase, evidence: ArrivalEvidence, notice: NoticeLedger, arrivalEpoch: int, sequence: int,
  journalEpoch: int, closedThrough: int, openThrough: int, initialized: bool, baselineReady: bool, authorityLive: bool
}
pure val initial: NoticeProjection = {
  receipt: NoneSeen, evidence: Unobserved, notice: emptyNotice, arrivalEpoch: 0, sequence: 0,
  journalEpoch: 0, closedThrough: 0, openThrough: 0, initialized: false, baselineReady: false, authorityLive: true
}
pure def projectReceipt(receipt: ReceiptPhase, n: NoticeProjection): NoticeProjection =
  if (receipt == Projected) { ...n, receipt: Projected, notice: pendNotice(n.notice) } else { ...n, receipt: receipt }
pure def canAcceptLiveNotice(n: NoticeProjection, epoch: int, coordinate: int): bool =
  n.authorityLive and n.receipt == NoneSeen and epoch > 0 and coordinate > 0 and
  (epoch != n.journalEpoch or coordinate > n.closedThrough)
pure def acceptLiveNotice(n: NoticeProjection, epoch: int, coordinate: int, mutedReadOrExpired: bool): NoticeProjection =
  projectReceipt(
    if (not(n.initialized) or not(n.baselineReady) or epoch != n.journalEpoch) Buffered
    else if (mutedReadOrExpired) Ignored else Projected,
    { ...n, arrivalEpoch: epoch, sequence: coordinate })
pure val epochValues = Set(1, 2)
pure val coordinateValues = Set(1, 2, 3)
pure def alwaysQualifiedReceipt(n: NoticeProjection): bool = n.receipt != NoneSeen implies (n.arrivalEpoch > 0 and n.sequence > 0)
pure def alwaysOnlyProjectedReceiptsEnterTheLedger(n: NoticeProjection): bool = (n.receipt == Projected) == (n.notice.phase != NoticeNone)
pure def alwaysEvidenceBelongsToTheOpenCrawl(n: NoticeProjection): bool =
  n.evidence != Unobserved implies (n.receipt == Buffered and n.openThrough > 0 and n.arrivalEpoch == n.journalEpoch)
pure def stepBufferedArrivalSettledOnlyByItsCompleteFence(before: NoticeProjection, after: NoticeProjection): bool =
  (before.receipt == Buffered and after.receipt != Buffered) implies
    (after.openThrough == 0 and after.arrivalEpoch == after.journalEpoch and after.sequence <= after.closedThrough)
pure def stepObservedArrivalIsNeverDropped(before: NoticeProjection, after: NoticeProjection): bool =
  (before.evidence != Unobserved and after.receipt != Buffered) implies after.receipt != Gone
pure def sometimesBaselineQuiet(n: NoticeProjection): bool = n.receipt == BaselineOnly
pure def sometimesDeletedArrivalDropped(n: NoticeProjection): bool = n.receipt == Gone
pure def sometimesMatchHeldAcrossPages(n: NoticeProjection): bool = n.evidence == ObservedLive and n.closedThrough < n.openThrough
pure def sometimesArrivalWaitsForTheNextFence(n: NoticeProjection): bool =
  n.receipt == Buffered and n.initialized and not(n.baselineReady) and n.arrivalEpoch == n.journalEpoch and n.sequence > n.closedThrough
```

### A page continues the journal's own cursor, and only a complete page closes its whole fence

In the journal's epoch a page starts after the coordinate the journal closed
through and, while a crawl is open, reads through that crawl's fixed fence;
a page of a new epoch starts a crawl from zero and resets the journal. An
incomplete page returns at least one row and closes through its last one,
short of its fence; a complete page closes its whole fence, deleted rows
included. A row a page shows lies inside the range it closes.

```quint
pure def canReconcilePage(n: NoticeProjection, page: PageEvidence): bool =
  n.authorityLive and page.query.epoch > 0 and page.query.after >= 0 and
  page.query.after <= page.closes and page.closes <= page.query.through and
  (page.closes == page.query.through or page.closes > page.query.after) and
  (if (page.query.epoch == n.journalEpoch)
     page.query.after == n.closedThrough and (n.openThrough == 0 or page.query.through == n.openThrough)
   else page.query.after == 0) and
  (page.row == RowAbsent or (page.coordinate > page.query.after and page.coordinate <= page.closes))
pure def reconcilePage(n: NoticeProjection, page: PageEvidence): NoticeProjection = {
  val epoch = page.query.epoch
  val sameEpoch = epoch == n.journalEpoch
  val complete = page.closes == page.query.through
  val baseline = not(n.initialized) or not(sameEpoch)
  val present = page.row != RowAbsent
  val ownArrival = n.receipt == Buffered and n.arrivalEpoch == epoch
  val evidence =
    if (ownArrival and present and n.sequence == page.coordinate) (if (page.row == RowMuted) ObservedMuted else ObservedLive)
    else if (sameEpoch and n.openThrough > 0) n.evidence else Unobserved
  val adopts = n.receipt == NoneSeen and present
  val receipt =
    if (adopts) (if (baseline) BaselineOnly else if (page.row == RowMuted) Ignored else Projected)
    else if (ownArrival and complete and n.sequence <= page.query.through)
      (if (evidence == ObservedLive) Projected else if (evidence == ObservedMuted) Ignored else Gone)
    else n.receipt
  val located = if (adopts) { ...n, arrivalEpoch: epoch, sequence: page.coordinate } else n
  val projected = if (receipt == n.receipt) located else projectReceipt(receipt, located)
  { ...projected, evidence: if (complete) Unobserved else evidence, journalEpoch: epoch,
    closedThrough: page.closes, openThrough: if (complete) 0 else page.query.through,
    initialized: complete or not(baseline),
    baselineReady: if (complete) not(ownArrival and n.sequence > page.query.through) else n.baselineReady }
}
pure val pageValues: Set[PageEvidence] = List(
  { query: { epoch: 1, after: 0, through: 1 }, closes: 1, coordinate: 1, row: RowLive },
  { query: { epoch: 1, after: 0, through: 1 }, closes: 1, coordinate: 1, row: RowAbsent },
  { query: { epoch: 1, after: 0, through: 2 }, closes: 1, coordinate: 1, row: RowLive },
  { query: { epoch: 1, after: 1, through: 2 }, closes: 2, coordinate: 2, row: RowMuted },
  { query: { epoch: 1, after: 1, through: 2 }, closes: 2, coordinate: 2, row: RowAbsent },
  { query: { epoch: 2, after: 0, through: 1 }, closes: 1, coordinate: 1, row: RowLive },
  { query: { epoch: 2, after: 0, through: 3 }, closes: 3, coordinate: 3, row: RowLive }
).foldl(Set(), (acc, p) => acc.union(Set(p)))
pure def alwaysOpenCrawlStopsShortOfItsFence(n: NoticeProjection): bool = n.openThrough > 0 implies n.closedThrough < n.openThrough
pure def stepFenceNeverRunsBack(before: NoticeProjection, after: NoticeProjection): bool =
  after.journalEpoch == before.journalEpoch implies after.closedThrough >= before.closedThrough
```

### A pending notice is dispatched once, and its settlement never posts twice

Dispatch reserves the pending notice under the live account authority, as
the [notice routes](./noticeRoutes.md) ledger says; only a live settlement
counts a post, and a recovered one reads Android and never posts. A lost
process or a retired account drops the permit.

```quint
pure def canDispatchNotice(n: NoticeProjection): bool = n.authorityLive and n.notice.phase == NoticePending
pure def dispatchNotice(n: NoticeProjection, permitted: bool): NoticeProjection = { ...n, notice: reserveNotice(n.notice, permitted) }
pure def canSettleDispatch(n: NoticeProjection, settlement: PostSettlement): bool = mayPostSettle(n.notice, settlement)
pure def settleDispatch(n: NoticeProjection, settlement: PostSettlement, stored: bool): NoticeProjection = { ...n, notice: settleNotice(n.notice, settlement, stored) }
pure def canInterruptDispatch(n: NoticeProjection): bool = n.notice.permit
pure def interruptDispatch(n: NoticeProjection): NoticeProjection = { ...n, notice: dropPermit(n.notice) }
pure def canRetireAuthority(n: NoticeProjection): bool = n.authorityLive
pure def retireAuthority(n: NoticeProjection): NoticeProjection = { ...n, authorityLive: false, notice: dropPermit(n.notice) }
pure def alwaysNoticeLedgerValid(n: NoticeProjection): bool = noticeLedgerValid(n.notice)
pure def alwaysPermitNeedsAuthority(n: NoticeProjection): bool = n.notice.permit implies n.authorityLive
pure def stepPostNeedsLivePermit(before: NoticeProjection, after: NoticeProjection): bool =
  after.notice.posts > before.notice.posts implies (before.authorityLive and before.notice.permit)
pure def sometimesNotificationPosted(n: NoticeProjection): bool = n.notice.phase == NoticePosted and n.notice.posts == 1
pure def sometimesNotificationUncertain(n: NoticeProjection): bool = n.notice.phase == NoticeUnknown
pure def sometimesRecoveredWithoutPosting(n: NoticeProjection): bool = n.notice.phase == NoticePosted and n.notice.posts == 0
pure val weight_dispatchNotice = 4
```

### A tap opens a projected notice once, and an Ask tap backed out of keeps it

Each tap step checks the live account authority before it captures,
consumes or releases a token; the token rules are the
[notice routes](./noticeRoutes.md) ledger's.

```quint
pure def canCaptureNoticeTap(n: NoticeProjection, ask: bool): bool = n.authorityLive and tapEligible(n.notice)
pure def captureNoticeTap(n: NoticeProjection, ask: bool): NoticeProjection = { ...n, notice: captureTap(n.notice, ask) }
pure def canConsumeNoticeTap(n: NoticeProjection, token: int, write: TapWrite): bool = n.authorityLive and tapMatches(n.notice, token)
pure def consumeNoticeTap(n: NoticeProjection, token: int, write: TapWrite): NoticeProjection = { ...n, notice: consumeTap(n.notice, write) }
pure def canReleaseNoticeTap(n: NoticeProjection, token: int): bool = n.authorityLive and tapMatches(n.notice, token) and n.notice.tapAsk
pure def releaseNoticeTap(n: NoticeProjection, token: int): NoticeProjection = { ...n, notice: releaseTap(n.notice) }
pure def stepTapTokenClearedOnlyByItsTap(before: NoticeProjection, via: str, after: NoticeProjection): bool =
  after.notice.tapToken < before.notice.tapToken implies (via == "consumeNoticeTap" or via == "releaseNoticeTap")
pure def sometimesNoticeOpened(n: NoticeProjection): bool = n.notice.phase == NoticeOpened and n.notice.tapToken == 0
pure def sometimesOpenedWithStaleToken(n: NoticeProjection): bool = n.notice.phase == NoticeOpened and n.notice.tapToken > 0
pure def sometimesAskTapReleased(n: NoticeProjection): bool = n.notice.phase == NoticePosted and n.notice.tapToken == 0 and n.notice.tokenSerial > 0
pure val weight_captureNoticeTap = 6
pure val weight_consumeNoticeTap = 8
```

## Story: Keep an approval notice whose publication failed until it provably ended

> As the owner, I want an approval notice whose posting failed either cleaned
> up or kept tappable, never silently lost while it might be live.

### A failed approval publication forgets its route only on a definite terminal receipt

After an authorized approval call prepares its route, publication can fail
with storage unchanged, committed, uncertain, malformed or foreign. Cleanup
reads the receipt. Only a readable receipt that is absent, failed, withdrawn
or a recorded withdrawal intent for this exact notice ends the publication;
the route is then forgotten if it can be, and otherwise kept with the notice
suppressed. An unreadable, corrupt, foreign or wrong-expiry receipt keeps
the route and suppresses the notice; a live or uncertain one keeps both.
Cleanup decides only the route: it never posts, and the caller still sees
the publication error.

```quint
type ApprovalReceipt = ReceiptAbsent | ReceiptFailedExact | ReceiptWithdrawnExact | ReceiptWithdrawalIntent | ReceiptLive | ReceiptUncertain | ReceiptCorrupt | ReceiptForeign | ReceiptWrongExpiry
type ApprovalCleanup = RouteForgotten | RouteKeptSuppressed | RouteKept
pure def definiteApprovalEnd(receipt: ApprovalReceipt): bool =
  receipt == ReceiptAbsent or receipt == ReceiptFailedExact or receipt == ReceiptWithdrawnExact or receipt == ReceiptWithdrawalIntent
pure def validApprovalReceipt(receipt: ApprovalReceipt): bool = not(receipt == ReceiptCorrupt or receipt == ReceiptForeign or receipt == ReceiptWrongExpiry)
pure def cleanupApprovalRoute(receipt: ApprovalReceipt, readable: bool, canForget: bool): ApprovalCleanup =
  if (not(readable) or not(validApprovalReceipt(receipt))) RouteKeptSuppressed
  else if (not(definiteApprovalEnd(receipt))) RouteKept
  else if (canForget) RouteForgotten else RouteKeptSuppressed
pure def lawRouteForgottenOnlyWithProof(receipt: ApprovalReceipt, readable: bool, canForget: bool): bool =
  cleanupApprovalRoute(receipt, readable, canForget) == RouteForgotten implies (readable and definiteApprovalEnd(receipt) and canForget)
pure def lawUnreadableOrInvalidReceiptSuppresses(receipt: ApprovalReceipt, readable: bool, canForget: bool): bool =
  not(readable and validApprovalReceipt(receipt)) implies cleanupApprovalRoute(receipt, readable, canForget) == RouteKeptSuppressed
pure def lawLiveOrUncertainReceiptKeepsTheNotice(receipt: ApprovalReceipt, canForget: bool): bool =
  (receipt == ReceiptLive or receipt == ReceiptUncertain) implies cleanupApprovalRoute(receipt, true, canForget) == RouteKept
```

## Story: Get an alert and a new-mail count only as I set them up

> As the owner, I want an occurrence alert to land on the channel I left it
> on and a new-mail notice to count only mail I have not dealt with, so that
> a host's own grouping never overrides my choices and the mail count still
> includes unread notices removed by the shade's limit.

### An occurrence alert leaves the updates channel only while the owner left that channel as the host made it

`NativeNotificationChannels` posts a high-priority occurrence alert on
`eliza_notifications` unless the owner customised `eliza_updates`: Android
older than 11, a changed importance, sound or lock-screen visibility, or a
channel group. A host may name the groups it assigns itself
(`setHostAssignedGroups`, empty by default); such a group alone is no
customisation, but the owner blocking it is, so the alert stays on the
blocked `eliza_updates` instead of escaping the group. Every other priority
has its own fixed channel.

```quint
type ReminderPriority = PriorityUrgent | PriorityHigh | PriorityNormal | PriorityLow
type ReminderChannel = OnAlerts | OnNotifications | OnUpdates | OnQuiet
type UpdatesChannelFacts = {
  present: bool, platformChoices: bool, defaultImportance: bool, publicLockscreen: bool,
  group: str, hostAssignedGroup: bool, groupBlocked: bool, userSetImportance: bool, userSetSound: bool
}
pure def updatesCustomised(updates: UpdatesChannelFacts): bool =
  updates.present and (not(updates.platformChoices) or not(updates.defaultImportance) or not(updates.publicLockscreen) or
    (updates.group != "" and (not(updates.hostAssignedGroup) or updates.groupBlocked)) or updates.userSetImportance or updates.userSetSound)
pure def reminderChannel(priority: ReminderPriority, occurrence: bool, updates: UpdatesChannelFacts): ReminderChannel =
  if (priority == PriorityHigh and occurrence and updatesCustomised(updates)) OnUpdates
  else if (priority == PriorityUrgent) OnAlerts
  else if (priority == PriorityHigh) OnNotifications
  else if (priority == PriorityNormal) OnUpdates
  else OnQuiet
pure val updatesValues: Set[UpdatesChannelFacts] = {
  val plain = { present: true, platformChoices: true, defaultImportance: true, publicLockscreen: true, group: "", hostAssignedGroup: false, groupBlocked: false, userSetImportance: false, userSetSound: false }
  val hosted = { ...plain, group: "alpha", hostAssignedGroup: true }
  List(plain, hosted, { ...hosted, groupBlocked: true }, { ...plain, group: "alpha" }, { ...plain, group: "alpha", groupBlocked: true },
    { ...plain, userSetSound: true }, { ...plain, present: false }).foldl(Set(), (acc, u) => acc.union(Set(u)))
}
pure def lawHostAssignedGroupAloneIsNoCustomisation(updates: UpdatesChannelFacts): bool =
  (updates.hostAssignedGroup and not(updates.groupBlocked)) implies updatesCustomised(updates) == updatesCustomised({ ...updates, group: "" })
pure def lawBlockedGroupKeepsTheOccurrenceAlertBlocked(updates: UpdatesChannelFacts): bool =
  (updates.present and updates.group != "" and updates.groupBlocked) implies reminderChannel(PriorityHigh, true, updates) == OnUpdates
pure def lawUnassignedGroupStaysTheOwnersChoice(updates: UpdatesChannelFacts): bool =
  (updates.present and updates.group != "" and not(updates.hostAssignedGroup)) implies reminderChannel(PriorityHigh, true, updates) == OnUpdates
pure def lawOnlyOccurrenceAlertsFollowTheOwnersChoice(priority: ReminderPriority, occurrence: bool, updates: UpdatesChannelFacts): bool =
  (priority != PriorityHigh or not(occurrence)) implies reminderChannel(priority, occurrence, updates) == reminderChannel(priority, occurrence, { ...updates, present: false })
```

### A new-mail count counts the notices still unread, a notice the shade cap withdrew included

`MailHistoryReconciliation` hands a host the count with each new-mail
notice it posts (`Poster.post(key, count)`; the default shows none). The
count is the ledger's notices not opened, read, deleted or denied, the new
one included. Withdrawing the oldest shown notice to keep five in the shade
marks it capped, and it still counts; a later read or delete withdraws it
and removes the mark. A notice the ledger retired is no longer counted, so
the count is a lower bound, never the mailbox's unread total.

```quint
type MailNoticePhase = MailPending | MailDispatching | MailPosted | MailUncertain | MailWithdrawn | MailOpened | MailDenied
type MailNotice = { mailPhase: MailNoticePhase, capped: bool }
pure def mailNoticeUnread(mail: MailNotice): bool =
  mail.mailPhase == MailPending or mail.mailPhase == MailDispatching or mail.mailPhase == MailPosted or
  mail.mailPhase == MailUncertain or (mail.mailPhase == MailWithdrawn and mail.capped)
pure def unreadMailCount(notices: List[MailNotice]): int = notices.foldl(0, (total, mail) => if (mailNoticeUnread(mail)) total + 1 else total)
pure val cappedMail: MailNotice = { mailPhase: MailWithdrawn, capped: true }
pure val readOrDeletedMail: MailNotice = { mailPhase: MailWithdrawn, capped: false }
pure val mailValues: Set[MailNotice] = List(
  { mailPhase: MailPending, capped: false }, { mailPhase: MailPosted, capped: false }, { mailPhase: MailUncertain, capped: false },
  cappedMail, readOrDeletedMail, { mailPhase: MailOpened, capped: false }, { mailPhase: MailDenied, capped: false }
).foldl(Set(), (acc, m) => acc.union(Set(m)))
pure val noticesValues: Set[List[MailNotice]] = List(
  List(), List({ mailPhase: MailPosted, capped: false }), List(cappedMail, { mailPhase: MailOpened, capped: false })
).foldl(Set(), (acc, l) => acc.union(Set(l)))
pure def lawCappingAShownNoticeKeepsTheCount(mail: MailNotice, notices: List[MailNotice]): bool =
  (mail.mailPhase == MailPosted or mail.mailPhase == MailUncertain) implies
    unreadMailCount(notices.append(cappedMail)) == unreadMailCount(notices.append(mail))
pure def lawReadOrDeletedMailIsNeverCounted(notices: List[MailNotice]): bool =
  unreadMailCount(notices.append(readOrDeletedMail)) == unreadMailCount(notices)
pure def lawTheNewNoticeCountsItself(notices: List[MailNotice]): bool =
  unreadMailCount(notices.append({ mailPhase: MailPending, capped: false })) == unreadMailCount(notices) + 1
```
