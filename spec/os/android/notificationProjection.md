# Android notification projection and notice ledger

A consumer stages `NativeNotificationInbox`, `NativeNotificationWire`,
`NativeNotificationRoute`, `NativeNotificationChannels` and
`NativeNotificationProjector` from `plugins/plugin-native-notifications/android`
through its consumer host descriptor ([bridge composition](./bridge.md)).
`NativeNotificationInbox` owns the durable cursor, live buffer and per-owner
post receipts; the [notification cursor](../../core/notifications/cursor.md)
owns server page generation. This spec also owns the device notice ledger
that every native notice source shares:
[hosted result notices](./hostedResultNotices.md) and
[mail background delivery](./mailBackgroundDelivery.md) import it and add
only their own admission. The machine below projects one owner and one
notification through a baseline or catch-up fence; journal bounds and
compaction are separate.

## Story: Reconcile a live notification with a durable inbox page

> As the person, I want a live notification and the inbox page it belongs to
> to agree on what I have seen, so that nothing I already saw is announced
> again and nothing new is missed.

### A retained arrival waits for matching evidence inside an exhausted fence

A live notification received before baseline or from another epoch enters
the durable buffer. A validated page captures an epoch and fixed upper fence
before any projection, and describes the crawl up to that observation,
including an earlier match in the same fence. A buffered arrival below the
fence becomes a pending notice only if the crawl observed its exact ID and
sequence; a completed crawl removes a deleted arrival without posting. An
arrival above the fence waits for the next authoritative range. Low
priority, read and expired rows become ignored receipts. Initial-page
records without a live counterpart become baseline receipts and never post.

```quint
type ReceiptPhase = NoneSeen | Buffered | Projected | BaselineOnly | Ignored | Gone
type PageEvidence = { epoch: int, coordinate: int, through: int, present: bool, complete: bool, mutedReadOrExpired: bool }
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
pure def canReconcilePage(n: NoticeProjection, page: PageEvidence): bool =
  n.authorityLive and page.epoch > 0 and page.coordinate > 0 and page.through >= 0 and
  (page.epoch != n.journalEpoch or page.through >= n.closedThrough) and
  (not(page.present) or page.coordinate <= page.through)
pure def pageReceipt(n: NoticeProjection, page: PageEvidence): ReceiptPhase = {
  val sameArrival = n.arrivalEpoch == page.epoch and n.sequence == page.coordinate
  val existingFence = if (n.journalEpoch == page.epoch) n.closedThrough else 0
  val baseline = not(n.initialized) or n.journalEpoch != page.epoch
  val observedBelowFence = n.receipt == Buffered and n.arrivalEpoch == page.epoch and n.sequence <= page.through
  if (n.receipt == NoneSeen and page.present and page.coordinate > existingFence)
    (if (baseline) BaselineOnly else if (page.mutedReadOrExpired) Ignored else Projected)
  else if (observedBelowFence and page.complete)
    (if (not(page.present) or not(sameArrival)) Gone else if (page.mutedReadOrExpired) Ignored else Projected)
  else n.receipt
}
pure def reconcilePage(n: NoticeProjection, page: PageEvidence): NoticeProjection = {
  val existingFence = if (n.journalEpoch == page.epoch) n.closedThrough else 0
  val baseline = not(n.initialized) or n.journalEpoch != page.epoch
  val aboveFence = n.receipt == Buffered and n.arrivalEpoch == page.epoch and n.sequence > page.through
  val adopts = n.receipt == NoneSeen and page.present and page.coordinate > existingFence
  val located = if (adopts) { ...n, arrivalEpoch: page.epoch, sequence: page.coordinate } else n
  val receipt = pageReceipt(n, page)
  val projected = if (receipt == n.receipt) located else projectReceipt(receipt, located)
  { ...projected, journalEpoch: page.epoch,
    initialized: page.complete or not(baseline),
    baselineReady: page.complete and not(aboveFence),
    closedThrough: if (page.complete) page.through else existingFence }
}
pure val pageValues = Set(
  {epoch: 1, coordinate: 1, through: 1, present: true, complete: true, mutedReadOrExpired: false},
  {epoch: 1, coordinate: 1, through: 1, present: false, complete: true, mutedReadOrExpired: false},
  {epoch: 1, coordinate: 1, through: 1, present: true, complete: false, mutedReadOrExpired: false},
  {epoch: 1, coordinate: 2, through: 2, present: true, complete: true, mutedReadOrExpired: true},
  {epoch: 2, coordinate: 1, through: 1, present: true, complete: true, mutedReadOrExpired: false},
  {epoch: 2, coordinate: 3, through: 3, present: true, complete: true, mutedReadOrExpired: false}
)
pure def alwaysQualifiedReceipt(n: NoticeProjection): bool =
  n.receipt != NoneSeen implies n.arrivalEpoch > 0 and n.sequence > 0
pure def alwaysOnlyProjectedReceiptsEnterTheLedger(n: NoticeProjection): bool =
  (n.receipt == Projected) == (n.notice.phase != NoticeNone)
pure def alwaysValidJournalFence(n: NoticeProjection): bool = n.closedThrough >= 0 and n.journalEpoch >= 0
pure def sometimesBaselineQuiet(n: NoticeProjection): bool = n.receipt == BaselineOnly
pure def sometimesDeletedArrivalDropped(n: NoticeProjection): bool = n.receipt == Gone
```

## Story: Post a device notice once, even when Android's answer is lost

> As the person, I want a notice whose post Android may or may not have shown
> never to be posted twice, so that one event never interrupts me twice.

### A notice is posted at most once and an uncertain post is never repeated

A pending notice is reserved as dispatching, with a live permit, before the
Android call; refused permission settles it declined without posting. Only
the live permit may post. A live return settles shown as posted, a definite
not-shown or permission refusal as declined, and a throw as unknown. A
failed ledger write after the call drops the permit and leaves the row
dispatching. An interrupted process, or an owner change, also drops the
permit. A dispatching row without its permit is recovered only by reading
Android for its exact key and dispatch ID: an exact match records posted,
anything else unknown, and recovery never posts. A row never returns to
pending, so later input with the same receipt cannot post again. Arming a
notice for new content starts a fresh pending row that keeps only the token
serial, so no tap captured on the earlier content can open it.

```quint
type NoticePhase = NoticeNone | NoticePending | NoticeDispatching | NoticePosted | NoticeDeclined | NoticeUnknown | NoticeOpened | NoticeWithdrawn
type NoticeLedger = { phase: NoticePhase, permit: bool, posts: int, tokenSerial: int, tapToken: int, tapAsk: bool }
type PostSettlement = LiveShown | LiveNotShown | LiveThrew | RecoveredExact | RecoveredInexact
pure val emptyNotice: NoticeLedger = { phase: NoticeNone, permit: false, posts: 0, tokenSerial: 0, tapToken: 0, tapAsk: false }
pure def pendNotice(n: NoticeLedger): NoticeLedger = if (n.phase == NoticeNone) { ...n, phase: NoticePending } else n
pure def rearmNotice(n: NoticeLedger): NoticeLedger = { ...emptyNotice, phase: NoticePending, tokenSerial: n.tokenSerial }
pure def reserveNotice(n: NoticeLedger, permitted: bool): NoticeLedger =
  if (n.phase != NoticePending) n
  else { ...n, phase: if (permitted) NoticeDispatching else NoticeDeclined, permit: permitted }
pure def liveSettlement(settlement: PostSettlement): bool =
  settlement == LiveShown or settlement == LiveNotShown or settlement == LiveThrew
pure def mayPostSettle(n: NoticeLedger, settlement: PostSettlement): bool =
  n.phase == NoticeDispatching and n.permit == liveSettlement(settlement)
pure def settleNotice(n: NoticeLedger, settlement: PostSettlement, stored: bool): NoticeLedger = {
  val posts = if (liveSettlement(settlement)) n.posts + 1 else n.posts
  if (not(stored)) { ...n, permit: false, posts: posts }
  else { ...n, permit: false, posts: posts,
    phase: if (settlement == LiveShown or settlement == RecoveredExact) NoticePosted
      else if (settlement == LiveNotShown) NoticeDeclined else NoticeUnknown }
}
pure def dropPermit(n: NoticeLedger): NoticeLedger = { ...n, permit: false }
pure def withdrawNotice(n: NoticeLedger, tapCleared: bool): NoticeLedger =
  if (n.phase == NoticeNone) n
  else { ...n, phase: NoticeWithdrawn, permit: false,
    tapToken: if (tapCleared) 0 else n.tapToken, tapAsk: n.tapAsk and not(tapCleared) }
pure def noticeLedgerValid(n: NoticeLedger): bool =
  n.posts >= 0 and n.posts <= 1 and
  (n.permit implies n.phase == NoticeDispatching and n.posts == 0) and
  ((n.phase == NoticeNone or n.phase == NoticePending) implies n.posts == 0 and n.tapToken == 0) and
  n.tapToken >= 0 and n.tapToken <= n.tokenSerial and (n.tapToken == 0 implies not(n.tapAsk))
pure val ledgerValues = Set(emptyNotice, { ...emptyNotice, phase: NoticeDispatching, permit: true },
  { ...emptyNotice, phase: NoticeDispatching }, { ...emptyNotice, phase: NoticePosted, posts: 1, tokenSerial: 1, tapToken: 1, tapAsk: true })
pure def lawRecoveryNeverPosts(ledger: NoticeLedger, stored: bool): bool =
  settleNotice(ledger, RecoveredExact, stored).posts == ledger.posts and settleNotice(ledger, RecoveredInexact, stored).posts == ledger.posts

pure def canDispatchNotice(n: NoticeProjection, permitted: bool): bool = n.authorityLive and n.notice.phase == NoticePending
pure def dispatchNotice(n: NoticeProjection, permitted: bool): NoticeProjection = { ...n, notice: reserveNotice(n.notice, permitted) }
pure def canSettleDispatch(n: NoticeProjection, settlement: PostSettlement): bool = mayPostSettle(n.notice, settlement)
pure def settleDispatch(n: NoticeProjection, settlement: PostSettlement, stored: bool): NoticeProjection =
  { ...n, notice: settleNotice(n.notice, settlement, stored) }
pure def canInterruptDispatch(n: NoticeProjection): bool = n.notice.permit
pure def interruptDispatch(n: NoticeProjection): NoticeProjection = { ...n, notice: dropPermit(n.notice) }
pure def canRetireAuthority(n: NoticeProjection): bool = n.authorityLive
pure def retireAuthority(n: NoticeProjection): NoticeProjection = { ...n, authorityLive: false, notice: dropPermit(n.notice) }
pure def alwaysNoticeLedgerValid(n: NoticeProjection): bool = noticeLedgerValid(n.notice)
pure def alwaysPermitNeedsAuthority(n: NoticeProjection): bool = n.notice.permit implies n.authorityLive
pure def stepPostNeedsLivePermit(before: NoticeProjection, after: NoticeProjection): bool =
  after.notice.posts > before.notice.posts implies before.authorityLive and before.notice.permit
pure def sometimesNotificationPosted(n: NoticeProjection): bool = n.notice.phase == NoticePosted
pure def sometimesNotificationUncertain(n: NoticeProjection): bool = n.notice.phase == NoticeUnknown
pure def sometimesRecoveredWithoutPosting(n: NoticeProjection): bool = n.notice.phase == NoticePosted and n.notice.posts == 0
```

## Story: Open a notice exactly once from its tap

> As the person, I want tapping a notice to open what it announced once, and
> an Ask tap I back out of to leave the notice in place.

### Only the exact current tap token opens or releases a notice

Capturing a tap on a dispatching, posted or unknown notice durably assigns
a fresh token, unless the same kind of tap already holds one. A replacement
token makes an older one useless. Consuming requires the exact current
token: it writes the row opened first, clears the token second and only then
cancels the Android notice, so a fault can leave an opened row with its old
token, never a cleared token on an unopened row. Opening a notice whose live
post is still in flight drops the permit and counts that post, so the
at-most-once count covers it. Releasing an Ask tap clears
only that exact token and keeps the notice. Each source adds its own live
authority check before capture, consume and release.

```quint
type TapWrite = TapUnwritten | TapOpenedOnly | TapCleared
pure def tapEligible(n: NoticeLedger): bool =
  n.phase == NoticeDispatching or n.phase == NoticePosted or n.phase == NoticeUnknown
pure def captureTap(n: NoticeLedger, ask: bool): NoticeLedger =
  if (n.tapToken > 0 and n.tapAsk == ask) n
  else { ...n, tokenSerial: n.tokenSerial + 1, tapToken: n.tokenSerial + 1, tapAsk: ask }
pure def tapMatches(n: NoticeLedger, token: int): bool = n.tapToken > 0 and n.tapToken == token
pure def markOpened(n: NoticeLedger): NoticeLedger =
  { ...n, phase: NoticeOpened, permit: false, posts: if (n.permit) n.posts + 1 else n.posts }
pure def consumeTap(n: NoticeLedger, write: TapWrite): NoticeLedger =
  if (write == TapUnwritten) n
  else if (write == TapOpenedOnly) markOpened(n)
  else { ...markOpened(n), tapToken: 0, tapAsk: false }
pure def releaseTap(n: NoticeLedger): NoticeLedger = { ...n, tapToken: 0, tapAsk: false }
pure def lawConsumeOpensBeforeClearing(ledger: NoticeLedger, write: TapWrite): bool =
  consumeTap(ledger, write).tapToken < ledger.tapToken implies consumeTap(ledger, write).phase == NoticeOpened
pure def lawReleaseKeepsNotice(ledger: NoticeLedger): bool = releaseTap(ledger).phase == ledger.phase

pure def canCaptureNoticeTap(n: NoticeProjection, ask: bool): bool = n.authorityLive and tapEligible(n.notice)
pure def captureNoticeTap(n: NoticeProjection, ask: bool): NoticeProjection = { ...n, notice: captureTap(n.notice, ask) }
pure def canConsumeNoticeTap(n: NoticeProjection, token: int, write: TapWrite): bool = n.authorityLive and tapMatches(n.notice, token)
pure def consumeNoticeTap(n: NoticeProjection, token: int, write: TapWrite): NoticeProjection = { ...n, notice: consumeTap(n.notice, write) }
pure def canReleaseNoticeTap(n: NoticeProjection, token: int): bool = n.authorityLive and tapMatches(n.notice, token) and n.notice.tapAsk
pure def releaseNoticeTap(n: NoticeProjection, token: int): NoticeProjection = { ...n, notice: releaseTap(n.notice) }
pure val tokenValues = Set(0, 1, 2)
pure def stepTokenClearedOnlyBySettlement(before: NoticeProjection, via: str, after: NoticeProjection): bool =
  after.notice.tapToken < before.notice.tapToken implies (via == "consumeNoticeTap" or via == "releaseNoticeTap")
pure def sometimesNoticeOpened(n: NoticeProjection): bool = n.notice.phase == NoticeOpened and n.notice.tapToken == 0
pure def sometimesOpenedWithStaleToken(n: NoticeProjection): bool = n.notice.phase == NoticeOpened and n.notice.tapToken > 0
pure def lawOpeningCountsInFlightPost(ledger: NoticeLedger): bool =
  noticeLedgerValid(ledger) and ledger.permit implies markOpened(ledger).posts == 1 and noticeLedgerValid(markOpened(ledger))
pure val weight_dispatchNotice = 4
pure val weight_captureNoticeTap = 6
pure val weight_consumeNoticeTap = 8
```

## Story: Clean up an approval notice route only when its publication provably ended

> As the person, I want an approval notice whose posting failed either
> cleaned up or kept tappable, never silently lost while it might be live.

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
pure def validApprovalReceipt(receipt: ApprovalReceipt): bool =
  not(receipt == ReceiptCorrupt or receipt == ReceiptForeign or receipt == ReceiptWrongExpiry)
pure def cleanupApprovalRoute(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): ApprovalCleanup = {
  val valid = readable and validApprovalReceipt(receipt)
  val definite = valid and definiteApprovalEnd(receipt)
  { routeKept: not(definite and canForget), suppressed: not(valid) or (definite and not(canForget)),
    cleanupAuthority: definite, posts: postsAtFailure, publicationError: true }
}
pure val postsAtFailureValues = Set(0, 1)
pure def lawRouteForgottenOnlyWithProof(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): bool =
  not(cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).routeKept) implies readable and definiteApprovalEnd(receipt)
pure def lawUncertainRouteRemains(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): bool =
  not(definiteApprovalEnd(receipt)) implies cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).routeKept
pure def lawSuppressedNoticeKeepsRoute(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): bool =
  cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).suppressed implies cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).routeKept
pure def lawCleanupNeverPostsAndKeepsError(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): bool =
  cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).posts == postsAtFailure and cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).publicationError
```
