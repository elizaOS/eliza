# Agent notice projection

The agent's notifications reach Android through the native projection in
`android/notifications/` (`NoticeProjection`, `NativeNotificationInbox`,
`NativeNotificationWire`, `NativeNotificationChannels`,
`NativeNotificationProjector`, `NativeNotificationRoute`). The agent owns the
inbox and its pages ([notification cursor](../../core/notifications/cursor.md));
this machine owns the device's durable journal for one account: its cursor,
its live buffer and the post receipts of the [notice routes](./noticeRoutes.md)
ledger. The projection reads the inbox page and the notice events through the
native caller path of the agent service (`AgentService` request and
subscription on the native route table,
[agent channel](../agentService/channel.md)), never through the renderer. The
machine projects one account and one notification through a baseline or
catch-up fence; journal bounds and compaction stay in the shell.

## Story: Show the agent's notices once

> As the owner, I want a live notice and the inbox page it belongs to to agree
> on what I have seen, so that nothing I already saw is announced again,
> nothing new is missed, and one notice never interrupts me twice.

### A retained arrival waits for matching evidence inside an exhausted fence

A live notification received before the baseline or from another epoch enters
the durable buffer. A validated page captures an epoch and a fixed upper
fence before any projection, and describes the crawl up to that observation,
including an earlier match in the same fence. A buffered arrival below the
fence becomes a pending notice only if the crawl observed its exact ID and
sequence; a completed crawl removes a deleted arrival without posting. An
arrival above the fence waits for the next authoritative range. Low
priority, read and expired rows become ignored receipts. Initial-page
records without a live counterpart become baseline receipts and never post.

```quint
import noticeRoutes.* from "./noticeRoutes"
import cursor as K from "../../core/notifications/cursor"
type ReceiptPhase = NoneSeen | Buffered | Projected | BaselineOnly | Ignored | Gone
type PageEvidence = { query: K::Cursor, coordinate: int, present: bool, complete: bool, mutedReadOrExpired: bool }
type NoticeProjection = {
  receipt: ReceiptPhase, notice: NoticeLedger, arrivalEpoch: int, sequence: int, closedThrough: int,
  journalEpoch: int, initialized: bool, baselineReady: bool, authorityLive: bool
}
pure val initial: NoticeProjection = {
  receipt: NoneSeen, notice: emptyNotice, arrivalEpoch: 0, sequence: 0, closedThrough: 0,
  journalEpoch: 0, initialized: false, baselineReady: false, authorityLive: true
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
pure def alwaysValidJournalFence(n: NoticeProjection): bool = n.closedThrough >= 0 and n.journalEpoch >= 0
pure def sometimesBaselineQuiet(n: NoticeProjection): bool = n.receipt == BaselineOnly
pure def sometimesDeletedArrivalDropped(n: NoticeProjection): bool = n.receipt == Gone
```

### A page is reconciled only at the journal's cursor, and only a complete page closes its fence

The page answers the journal's own cursor: the inbox epoch, the coordinate
after which it reads and the fixed fence it reads through. In the journal's
epoch the fence never runs behind what is already closed. A present row lies
inside the page's range. An incomplete page closes nothing; a complete page
closes its whole fence, deleted rows included.

```quint
pure def canReconcilePage(n: NoticeProjection, page: PageEvidence): bool =
  n.authorityLive and page.query.epoch > 0 and page.query.after >= 0 and page.query.after <= page.query.through and
  (page.query.epoch != n.journalEpoch or page.query.through >= n.closedThrough) and
  (not(page.present) or (page.coordinate > page.query.after and page.coordinate <= page.query.through))
pure def pageReceipt(n: NoticeProjection, page: PageEvidence): ReceiptPhase = {
  val sameArrival = n.arrivalEpoch == page.query.epoch and n.sequence == page.coordinate
  val existingFence = if (n.journalEpoch == page.query.epoch) n.closedThrough else 0
  val baseline = not(n.initialized) or n.journalEpoch != page.query.epoch
  val observedBelowFence = n.receipt == Buffered and n.arrivalEpoch == page.query.epoch and n.sequence <= page.query.through
  if (n.receipt == NoneSeen and page.present and page.coordinate > existingFence)
    (if (baseline) BaselineOnly else if (page.mutedReadOrExpired) Ignored else Projected)
  else if (observedBelowFence and page.complete)
    (if (not(page.present) or not(sameArrival)) Gone else if (page.mutedReadOrExpired) Ignored else Projected)
  else n.receipt
}
pure def reconcilePage(n: NoticeProjection, page: PageEvidence): NoticeProjection = {
  val existingFence = if (n.journalEpoch == page.query.epoch) n.closedThrough else 0
  val baseline = not(n.initialized) or n.journalEpoch != page.query.epoch
  val aboveFence = n.receipt == Buffered and n.arrivalEpoch == page.query.epoch and n.sequence > page.query.through
  val adopts = n.receipt == NoneSeen and page.present and page.coordinate > existingFence
  val located = if (adopts) { ...n, arrivalEpoch: page.query.epoch, sequence: page.coordinate } else n
  val receipt = pageReceipt(n, page)
  val projected = if (receipt == n.receipt) located else projectReceipt(receipt, located)
  { ...projected, journalEpoch: page.query.epoch,
    initialized: page.complete or not(baseline),
    baselineReady: page.complete and not(aboveFence),
    closedThrough: if (page.complete) page.query.through else existingFence }
}
pure val pageValues: Set[PageEvidence] = List(
  { query: { epoch: 1, after: 0, through: 1 }, coordinate: 1, present: true, complete: true, mutedReadOrExpired: false },
  { query: { epoch: 1, after: 0, through: 1 }, coordinate: 1, present: false, complete: true, mutedReadOrExpired: false },
  { query: { epoch: 1, after: 0, through: 1 }, coordinate: 1, present: true, complete: false, mutedReadOrExpired: false },
  { query: { epoch: 1, after: 1, through: 2 }, coordinate: 2, present: true, complete: true, mutedReadOrExpired: true },
  { query: { epoch: 2, after: 0, through: 1 }, coordinate: 1, present: true, complete: true, mutedReadOrExpired: false },
  { query: { epoch: 2, after: 0, through: 3 }, coordinate: 3, present: true, complete: true, mutedReadOrExpired: false }
).foldl(Set(), (acc, p) => acc.union(Set(p)))
pure def stepIncompletePageClosesNothing(before: NoticeProjection, via: str, after: NoticeProjection): bool =
  (via == "reconcilePage" and after.journalEpoch == before.journalEpoch and after.closedThrough != before.closedThrough) implies after.initialized
```

### A pending notice is dispatched once, and its settlement never posts twice

Dispatch reserves the pending notice under the live authority, as the
[notice routes](./noticeRoutes.md) ledger says; only a live settlement counts
a post, and a recovered one reads Android and never posts. A lost process or
a retired account drops the permit.

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
pure def sometimesNotificationPosted(n: NoticeProjection): bool = n.notice.phase == NoticePosted
pure def sometimesNotificationUncertain(n: NoticeProjection): bool = n.notice.phase == NoticeUnknown
pure def sometimesRecoveredWithoutPosting(n: NoticeProjection): bool = n.notice.phase == NoticePosted and n.notice.posts == 0
pure val weight_dispatchNotice = 4
```

### A tap opens a projected notice once, and an Ask tap backed out of keeps it

Each tap step checks the live account authority before it captures, consumes
or releases a token.

```quint
pure def canCaptureNoticeTap(n: NoticeProjection, ask: bool): bool = n.authorityLive and tapEligible(n.notice)
pure def captureNoticeTap(n: NoticeProjection, ask: bool): NoticeProjection = { ...n, notice: captureTap(n.notice, ask) }
pure def canConsumeNoticeTap(n: NoticeProjection, token: int, write: TapWrite): bool = n.authorityLive and tapMatches(n.notice, token)
pure def consumeNoticeTap(n: NoticeProjection, token: int, write: TapWrite): NoticeProjection = { ...n, notice: consumeTap(n.notice, write) }
pure def canReleaseNoticeTap(n: NoticeProjection, token: int): bool = n.authorityLive and tapMatches(n.notice, token) and n.notice.tapAsk
pure def releaseNoticeTap(n: NoticeProjection, token: int): NoticeProjection = { ...n, notice: releaseTap(n.notice) }
pure def stepTokenClearedOnlyBySettlement(before: NoticeProjection, via: str, after: NoticeProjection): bool =
  after.notice.tapToken < before.notice.tapToken implies (via == "consumeNoticeTap" or via == "releaseNoticeTap")
pure def sometimesNoticeOpened(n: NoticeProjection): bool = n.notice.phase == NoticeOpened and n.notice.tapToken == 0
pure def sometimesOpenedWithStaleToken(n: NoticeProjection): bool = n.notice.phase == NoticeOpened and n.notice.tapToken > 0
pure val weight_captureNoticeTap = 6
pure val weight_consumeNoticeTap = 8
```

## Story: Clean up an approval notice route only when its publication provably ended

> As the owner, I want an approval notice whose posting failed either cleaned
> up or kept tappable, never silently lost while it might be live.

### A failed approval publication forgets its route only on a definite terminal receipt

After an authorized approval call prepares its route, publication can fail
with storage unchanged, committed, uncertain, malformed or foreign. Cleanup
reads the receipt. Only a readable receipt that is absent, failed, withdrawn
or a recorded withdrawal intent for this exact notice gives cleanup
authority; the route is then forgotten if it can be. A live, uncertain,
corrupt, foreign or wrong-expiry receipt, or an unreadable one, keeps the
route. Cleanup that cannot forget suppresses the notice but keeps the route.
The publication error is what the caller sees, and cleanup never posts.

```quint
type ApprovalReceipt = ReceiptAbsent | ReceiptFailedExact | ReceiptWithdrawnExact | ReceiptWithdrawalIntent | ReceiptLive | ReceiptUncertain | ReceiptCorrupt | ReceiptForeign | ReceiptWrongExpiry
type ApprovalCleanup = { routeKept: bool, suppressed: bool, cleanupAuthority: bool, posts: int, publicationError: bool }
pure def definiteApprovalEnd(receipt: ApprovalReceipt): bool =
  receipt == ReceiptAbsent or receipt == ReceiptFailedExact or receipt == ReceiptWithdrawnExact or receipt == ReceiptWithdrawalIntent
pure def validApprovalReceipt(receipt: ApprovalReceipt): bool = not(receipt == ReceiptCorrupt or receipt == ReceiptForeign or receipt == ReceiptWrongExpiry)
pure def cleanupApprovalRoute(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): ApprovalCleanup = {
  val valid = readable and validApprovalReceipt(receipt)
  val definite = valid and definiteApprovalEnd(receipt)
  { routeKept: not(definite and canForget), suppressed: not(valid) or (definite and not(canForget)),
    cleanupAuthority: definite, posts: postsAtFailure, publicationError: true }
}
pure val postsAtFailureValues = Set(0, 1)
pure def lawRouteForgottenOnlyWithProof(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): bool =
  not(cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).routeKept) implies (readable and definiteApprovalEnd(receipt))
pure def lawUncertainRouteRemains(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): bool =
  not(definiteApprovalEnd(receipt)) implies cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).routeKept
pure def lawSuppressedNoticeKeepsRoute(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): bool =
  cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).suppressed implies cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).routeKept
pure def lawCleanupNeverPostsAndKeepsError(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): bool =
  cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).posts == postsAtFailure and cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).publicationError
```
