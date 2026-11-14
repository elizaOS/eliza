# Android notification projection ownership

Alpha stages `NativeNotificationInbox`, `NativeNotificationWire`,
`NativeNotificationRoute`, `NativeNotificationChannels` and
`NativeNotificationProjector` through `android/consumer-host.json`.
The pinned producer sources are under
`packages/app/platforms/android/app/src/main/java/ai/elizaos/app`.
`NativeNotificationInbox` owns the durable cursor, live buffer and
per-owner post receipts. The core cursor in `spec/core/notificationCursor.md`
owns server page generation. This model projects one owner and one
notification through a baseline or catch-up fence. Other notifications
have their own receipt identities. Whole journal bounds and
compaction remain separate from this item-level contract.

## Story: Reconcile a live notification with a durable inbox page

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
