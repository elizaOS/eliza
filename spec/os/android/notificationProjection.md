# Android notification projection ownership

A consumer stages `NativeNotificationInbox`, `NativeNotificationWire`,
`NativeNotificationRoute`, `NativeNotificationChannels` and
`NativeNotificationProjector` through its consumer host descriptor
([bridge composition](./bridge.md)).
The pinned producer sources are under
`packages/app/platforms/android/app/src/main/java/ai/elizaos/app`.
`NativeNotificationInbox` owns the durable cursor, live buffer and
per-owner post receipts. The core cursor in `spec/core/notificationCursor.md`
owns server page generation. This model projects one owner and one
notification through a baseline or catch-up fence. Other notifications
have their own receipt identities. Whole journal bounds and
compaction remain separate from this item-level contract.

## Story: Reconcile a live notification with a durable inbox page

> As the person, I want a live notification and the inbox page it
> belongs to to agree on what I have seen.

### A retained arrival waits for matching evidence inside an exhausted fence

A live notification received before baseline or from another epoch
enters the durable buffer. A validated page captures an epoch and
fixed upper fence before any projection. Page evidence describes the
crawl up to that observation, including an earlier match in the same
fence. A page driver must check the requested cursor and retain those
matches until the crawl settles. A buffered arrival below
the fence is eligible only if the page crawl observed its exact ID
and sequence. A completed crawl removes a deleted arrival without
posting. An arrival above the fence waits for the next authoritative
range. Low priority, read and expired rows become ignored receipts.
Initial-page records without a live counterpart become baseline
receipts and do not post.

```quint
type ReceiptPhase = NoneSeen | Buffered | Candidate | BaselineOnly | Ignored | Gone | Dispatched | Accepted | Declined | Unknown
type PageEvidence = { epoch: int, coordinate: int, through: int, present: bool, complete: bool, mutedReadOrExpired: bool }
type NoticeProjection = {
  receipt: ReceiptPhase, arrivalEpoch: int, sequence: int, closedThrough: int,
  journalEpoch: int, initialized: bool, baselineReady: bool, authorityLive: bool, postAttempts: int
}
pure val initial: NoticeProjection = {
  receipt: NoneSeen, arrivalEpoch: 0, sequence: 0, closedThrough: 0,
  journalEpoch: 0, initialized: false, baselineReady: false, authorityLive: true, postAttempts: 0
}
pure def canAcceptLiveNotice(n: NoticeProjection, epoch: int, coordinate: int): bool =
  n.authorityLive and n.receipt == NoneSeen and epoch > 0 and coordinate > 0 and
  (epoch != n.journalEpoch or coordinate > n.closedThrough)
pure def acceptLiveNotice(n: NoticeProjection, epoch: int, coordinate: int, mutedReadOrExpired: bool): NoticeProjection =
  { ...n, arrivalEpoch: epoch, sequence: coordinate,
    receipt: if (not(n.initialized) or not(n.baselineReady) or epoch != n.journalEpoch) Buffered
      else if (mutedReadOrExpired) Ignored else Candidate }
pure val epochValues = Set(1, 2)
pure val coordinateValues = Set(1, 2, 3)
pure def canReconcilePage(n: NoticeProjection, page: PageEvidence): bool =
  n.authorityLive and page.epoch > 0 and page.coordinate > 0 and page.through >= 0 and
  (page.epoch != n.journalEpoch or page.through >= n.closedThrough) and
  (not(page.present) or page.coordinate <= page.through)
pure def reconcilePage(n: NoticeProjection, page: PageEvidence): NoticeProjection = {
  val sameArrival = n.arrivalEpoch == page.epoch and n.sequence == page.coordinate
  val existingFence = if (n.journalEpoch == page.epoch) n.closedThrough else 0
  val baseline = not(n.initialized) or n.journalEpoch != page.epoch
  val observedBelowFence = n.receipt == Buffered and n.arrivalEpoch == page.epoch and n.sequence <= page.through
  val aboveFence = n.receipt == Buffered and n.arrivalEpoch == page.epoch and n.sequence > page.through
  val adopted = if (n.receipt == NoneSeen and page.present and page.coordinate > existingFence) {
    ...n, arrivalEpoch: page.epoch, sequence: page.coordinate,
    receipt: if (baseline) BaselineOnly else if (page.mutedReadOrExpired) Ignored else Candidate
  } else if (observedBelowFence and page.complete) {
    ...n, receipt: if (not(page.present) or not(sameArrival)) Gone else if (page.mutedReadOrExpired) Ignored else Candidate
  } else n
  { ...adopted, journalEpoch: page.epoch,
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
pure def alwaysValidJournalFence(n: NoticeProjection): bool = n.closedThrough >= 0 and n.journalEpoch >= 0
pure def sometimesBaselineQuiet(n: NoticeProjection): bool = n.receipt == BaselineOnly
pure def sometimesDeletedArrivalDropped(n: NoticeProjection): bool = n.receipt == Gone
```

## Story: Keep an uncertain Android post from being repeated

> As the person, I want a notification whose post Android may or may not
> have shown never to be posted twice.

### Persisted dispatch precedes the attempt and an uncertain return remains terminal

The owner must still be current at the Android call. A definite false
means Android did not present a notification and also closes the
attempt. Throwing after the durable dispatch marker records unknown.
A process interruption preserves that marker and recovery treats it
as unknown. Later input with the same retained receipt cannot repeat
the post. A concurrent owner change fences the call. The source keeps
terminal receipts across epoch changes subject to its durable retention
and closed-range compaction policy.

```quint
type NativePostResult = Shown | NotShown | Ambiguous
pure def canRecordDispatch(n: NoticeProjection): bool = n.authorityLive and n.receipt == Candidate
pure def recordDispatch(n: NoticeProjection): NoticeProjection = { ...n, receipt: Dispatched }
pure def canReportPost(n: NoticeProjection): bool = n.receipt == Dispatched
pure def reportPost(n: NoticeProjection, postResult: NativePostResult): NoticeProjection =
  if (not(n.authorityLive)) { ...n, receipt: Unknown }
  else { ...n, postAttempts: n.postAttempts + 1,
    receipt: if (postResult == Shown) Accepted else if (postResult == NotShown) Declined else Unknown }
pure def canRecoverDispatch(n: NoticeProjection): bool = n.receipt == Dispatched
pure def recoverDispatch(n: NoticeProjection): NoticeProjection = { ...n, receipt: Unknown }
pure def canRetireAuthority(n: NoticeProjection): bool = n.authorityLive
pure def retireAuthority(n: NoticeProjection): NoticeProjection = { ...n, authorityLive: false }
pure def alwaysAtMostOnePost(n: NoticeProjection): bool =
  n.postAttempts >= 0 and n.postAttempts <= 1 and
  (n.postAttempts > 0 implies n.receipt == Accepted or n.receipt == Declined or n.receipt == Unknown)
pure def stepPostNeedsCurrentAuthority(before: NoticeProjection, after: NoticeProjection): bool =
  after.postAttempts > before.postAttempts implies before.authorityLive and before.receipt == Dispatched
pure def sometimesNotificationPosted(n: NoticeProjection): bool = n.receipt == Accepted
pure def sometimesNotificationUncertain(n: NoticeProjection): bool = n.receipt == Unknown
```

## Story: Clean up an approval notice route only when its publication provably ended

> As the person, I want an approval notice whose posting failed either
> cleaned up or kept tappable, never silently lost while it might be live.

### A failed approval publication forgets its route only on a definite terminal receipt

Ported from the producer's `ApprovalPublicationCleanup` model. After an
authorized approval call prepares its route, publication can fail with
storage unchanged, committed, uncertain, malformed or foreign. Cleanup
reads the receipt. Only a readable receipt that is absent, failed,
withdrawn or a recorded withdrawal intent for this exact notice gives
cleanup authority; the route is then forgotten if it can be. A live,
uncertain, corrupt, foreign or wrong-expiry receipt, or an unreadable
one, keeps the route. Cleanup that cannot forget suppresses the notice
but keeps the route. The publication error is what the caller sees, and
cleanup never posts.

```quint
type ApprovalReceipt = ReceiptAbsent | ReceiptFailedExact | ReceiptWithdrawnExact | ReceiptWithdrawalIntent | ReceiptLive | ReceiptUncertain | ReceiptCorrupt | ReceiptForeign | ReceiptWrongExpiry
type ApprovalCleanup = { routeKept: bool, suppressed: bool, cleanupAuthority: bool, posts: int, error: str }
pure def definiteApprovalEnd(receipt: ApprovalReceipt): bool =
  receipt == ReceiptAbsent or receipt == ReceiptFailedExact or receipt == ReceiptWithdrawnExact or receipt == ReceiptWithdrawalIntent
pure def validApprovalReceipt(receipt: ApprovalReceipt): bool =
  not(receipt == ReceiptCorrupt or receipt == ReceiptForeign or receipt == ReceiptWrongExpiry)
pure def cleanupApprovalRoute(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): ApprovalCleanup = {
  val valid = readable and validApprovalReceipt(receipt)
  val definite = valid and definiteApprovalEnd(receipt)
  { routeKept: not(definite and canForget), suppressed: not(valid) or (definite and not(canForget)),
    cleanupAuthority: definite, posts: postsAtFailure, error: "publication" }
}
pure val postsAtFailureValues = Set(0, 1)
pure def lawRouteForgottenOnlyWithProof(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): bool =
  not(cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).routeKept) implies readable and definiteApprovalEnd(receipt)
pure def lawUncertainRouteRemains(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): bool =
  not(definiteApprovalEnd(receipt)) implies cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).routeKept
pure def lawSuppressedNoticeKeepsRoute(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): bool =
  cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).suppressed implies cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).routeKept
pure def lawCleanupNeverPostsAndKeepsError(receipt: ApprovalReceipt, readable: bool, canForget: bool, postsAtFailure: int): bool =
  cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).posts == postsAtFailure and cleanupApprovalRoute(receipt, readable, canForget, postsAtFailure).error == "publication"
```
