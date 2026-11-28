# Android links and alerts

A link the person follows, such as a sign-in return or an App Link, reaches
the app three ways: the Intent that launched the process, a warm Intent to
the running app, and the answer to the renderer's query of the native slot.
The native host gives each capture its own receipt before the app framework
dispatches the Intent, and keeps the latest one in a durable slot. The
renderer joins all three channels by receipt, opens a link once it is ready,
and acknowledges it only after it applied or rejected it. A browser sign-in
that returns through a link is then bound to its client by
browser return (`spec/os/signIn/browserReturn.md`).

The app registers no app-delegation callback: cloud issues no app
delegations, so no such link can be captured.

## Story: Open the link I followed exactly once, even across a cold start

> As a person following a sign-in or app link, I want the app to open it
> once it is ready, without opening it twice and without losing it when the
> app restarts.

### A link waits until the renderer is ready, then starts once

A receipt that reaches the renderer before it is ready waits; readiness
starts every waiting receipt. A receipt that is waiting, running or done in
this renderer joins it instead of starting again; one already done gets its
acknowledgement again. A relaunch, after process death or a re-created
renderer, drops the renderer's bookkeeping. If the host did not receive an
acknowledgement, the receipt in its durable slot can run again after relaunch.

```quint
type Receipt = int
type LinkOutcome = LinkApplied | LinkRejected | LinkFailed
type DeepLinks = { captured: Receipt, pending: Receipt, coldLaunch: Receipt, ready: bool, waiting: Set[Receipt],
  running: Set[Receipt], done: Set[Receipt], settled: Set[Receipt], acks: Set[Receipt] }
pure val initial: DeepLinks = { captured: 0, pending: 0, coldLaunch: 0, ready: false, waiting: Set(), running: Set(),
  done: Set(), settled: Set(), acks: Set() }
pure def launch(d: DeepLinks, withLink: bool): DeepLinks = {
  val id = d.captured + 1
  { ...d, captured: if (withLink) id else d.captured, pending: if (withLink) id else d.pending,
    coldLaunch: if (withLink) id else 0, ready: false, waiting: Set(), running: Set(), done: Set() }
}
pure def capture(d: DeepLinks): DeepLinks = { ...d, captured: d.captured + 1, pending: d.captured + 1 }
pure def canDeliver(d: DeepLinks, id: Receipt): bool = id >= 1 and id <= d.captured
pure def deliver(d: DeepLinks, id: Receipt): DeepLinks = {
  val known = d.waiting.contains(id) or d.running.contains(id) or d.done.contains(id)
  { ...d,
    waiting: if (known or d.ready) d.waiting else d.waiting.union(Set(id)),
    running: if (known or not(d.ready)) d.running else d.running.union(Set(id)),
    acks: if (d.done.contains(id)) d.acks.union(Set(id)) else d.acks }
}
pure def canRendererReady(d: DeepLinks): bool = not(d.ready)
pure def rendererReady(d: DeepLinks): DeepLinks = { ...d, ready: true, waiting: Set(), running: d.running.union(d.waiting) }
pure val idValues = Set(1, 2, 3)
pure def alwaysLinksWaitForTheRenderer(d: DeepLinks): bool =
  (d.ready implies d.waiting.size() == 0) and (not(d.ready) implies d.running.size() == 0)
pure def alwaysOneAttemptPerLink(d: DeepLinks): bool =
  d.waiting.intersect(d.running).size() == 0 and d.waiting.intersect(d.done).size() == 0 and
    d.running.intersect(d.done).size() == 0
pure def stepStartsOnlyNewLinks(before: DeepLinks, after: DeepLinks): bool =
  after.running.forall(id => before.running.contains(id) or not(before.done.contains(id)))
pure def sometimesLinkWaitsForTheRenderer(d: DeepLinks): bool = not(d.ready) and d.waiting.size() > 0
pure val fair_rendererReady = "weak"
pure def leadsToWaitingLinksStart(d: DeepLinks, later: DeepLinks): bool = d.waiting.size() > 0 implies later.waiting.size() == 0
```

### The native slot clears only after the renderer applied or rejected the link

An attempt that ends applied or rejected is done and acknowledged; a failed
attempt is neither, so the slot keeps it and the next delivery retries it.
The native host clears the slot only on an acknowledgement of the receipt
it holds.

```quint
pure def canFinish(d: DeepLinks, id: Receipt, linkOutcome: LinkOutcome): bool = d.running.contains(id)
pure def finish(d: DeepLinks, id: Receipt, linkOutcome: LinkOutcome): DeepLinks = {
  val ended = linkOutcome != LinkFailed
  { ...d, running: d.running.exclude(Set(id)),
    done: if (ended) d.done.union(Set(id)) else d.done,
    settled: if (ended) d.settled.union(Set(id)) else d.settled,
    acks: if (ended) d.acks.union(Set(id)) else d.acks }
}
pure def canAcknowledge(d: DeepLinks, id: Receipt): bool = d.acks.contains(id)
pure def acknowledge(d: DeepLinks, id: Receipt): DeepLinks =
  { ...d, acks: d.acks.exclude(Set(id)), pending: if (d.pending == id) 0 else d.pending }
pure def alwaysOnlySettledLinksAreAcknowledged(d: DeepLinks): bool = d.acks.subseteq(d.settled) and d.done.subseteq(d.settled)
pure def stepSlotClearsOnlySettledLinks(before: DeepLinks, after: DeepLinks): bool =
  (before.pending != 0 and after.pending == 0) implies before.settled.contains(before.pending)
pure def sometimesColdLaunchLinkOpened(d: DeepLinks): bool = d.coldLaunch > 0 and d.settled.contains(d.coldLaunch) and d.pending == 0
```

## Story: Keep two links I followed apart, even when they are the same URL

> As a person who followed two links quickly, I want each opened once, and
> neither lost because the other was handled first.

### Each capture keeps its own receipt, and only a newer capture takes the slot

Two captures of the same URL get distinct receipts, which never repeat. The
native host compares the receipt and the URL under one lock, so an
acknowledgement of an older receipt leaves a newer one in the slot. The slot
replays the latest pending receipt after a restart.

```quint
pure def alwaysReceiptsComeFromCaptures(d: DeepLinks): bool =
  d.pending >= 0 and d.pending <= d.captured and d.coldLaunch >= 0 and d.coldLaunch <= d.captured
pure def stepOnlyANewCaptureTakesTheSlot(before: DeepLinks, after: DeepLinks): bool =
  after.captured >= before.captured and
    ((after.pending != before.pending and after.pending != 0) implies
      (after.pending == after.captured and after.captured == before.captured + 1))
pure def sometimesSecondLinkSurvivesFirst(d: DeepLinks): bool =
  d.pending == 2 and d.settled.contains(1) and not(d.acks.contains(1)) and not(d.settled.contains(2))
```

## Story: Open the exact result from my notification

> As the device owner, I want tapping a result notice to open the result
> that was posted for me, including after a restart.

### A tap opens only its confirmed route for the current owner

Android's `NoticeRoutes` saves the exact typed route and its delivery
binding in encrypted host storage before it returns the tap token. The
intent carries only that opaque token. The route's owner includes origin,
owner, agent and scope. A retry for the same notice returns the stored
token only when the binding and route match. A notice token never grants
permission to perform an action.

The host confirms the route against the posted delivery receipt and checks
the current owner before a tap is captured or opens. A tap becomes durable
before the renderer receives it. Repeated taps keep one pending entry,
and the renderer consumes it only once. A withdrawn, lost or failed
receipt retires its tap. While the receipt is temporarily unsettled, a tap
waits. The ledger holds at most 512 routes and 192 KiB. It reclaims settled
routes oldest first when their notice is no longer shown and their tap is
no longer pending.

```quint
type NoticeTap = NoticeUntapped | NoticePending | NoticeConsumed
type NoticeReceipt = NoticePosted | NoticeUnsettled | NoticeEnded
type NoticeEvidence = { ownerMatches: bool, routeMatches: bool, receipt: NoticeReceipt, tap: NoticeTap }
pure val postedNotice: NoticeEvidence = { ownerMatches: true, routeMatches: true, receipt: NoticePosted, tap: NoticePending }
pure val eValues = Set(postedNotice, { ...postedNotice, ownerMatches: false }, { ...postedNotice, routeMatches: false },
  { ...postedNotice, receipt: NoticeUnsettled }, { ...postedNotice, receipt: NoticeEnded }, { ...postedNotice, tap: NoticeConsumed })
pure def noticeTapCapturable(e: NoticeEvidence): bool =
  e.ownerMatches and e.routeMatches and e.receipt == NoticePosted and e.tap != NoticeConsumed
pure def noticeTapOpenable(e: NoticeEvidence): bool =
  noticeTapCapturable(e) and e.tap == NoticePending
pure def noticeTapDiscardable(e: NoticeEvidence, targetGone: bool): bool =
  e.ownerMatches and e.tap == NoticePending and (e.receipt == NoticeEnded or (e.routeMatches and e.receipt == NoticePosted and targetGone))
pure def lawOnlyCurrentPostedRoutesOpen(e: NoticeEvidence): bool =
  noticeTapOpenable(e) implies (e.ownerMatches and e.routeMatches and e.receipt == NoticePosted)
pure def lawAConsumedNoticeCannotOpenAgain(e: NoticeEvidence): bool =
  e.tap == NoticeConsumed implies not(noticeTapOpenable(e))
pure def lawUnsettledDeliveryKeepsItsTap(e: NoticeEvidence, targetGone: bool): bool =
  e.receipt == NoticeUnsettled implies not(noticeTapDiscardable(e, targetGone))
```

## Story: Receive an alert for the current reminder occurrence

> As the device owner, I want a scheduled reminder to alert me when it is
> due, while an old or cancelled occurrence stays quiet.

### An alert uses the saved occurrence and the host's existing alarm capability

The Android reminders module keeps the occurrence, its due time and alert
setting before arming an alarm. A reminder without an alert or with a
suspended deletion arms no alarm. The host uses an exact alarm only when
Android already permits it. Missing or withdrawn exact-alarm authority
uses an inexact alarm. This module never asks for exact-alarm permission.

The receiver reads the current record under the store lock and checks its
occurrence and deadline. A stale delivery cannot alert. An early delivery
of the current occurrence rearms against the saved deadline. Android
notification permission is observed at delivery. A refused or failed post
produces no successful receipt. The notice's opaque tap opens only its
current saved occurrence.

```quint
type ReminderAlarm = NoReminderAlarm | InexactReminderAlarm | ExactReminderAlarm
type ReminderDelivery = IgnoreReminder | RearmReminder | DenyReminderNotice | PostReminderNotice
pure def alarmForReminder(hasAlert: bool, suspended: bool, exactPermitted: bool, exactAccepted: bool): ReminderAlarm =
  if (not(hasAlert) or suspended) NoReminderAlarm
  else if (exactPermitted and exactAccepted) ExactReminderAlarm
  else InexactReminderAlarm
pure def deliverReminder(matchingOccurrence: bool, scheduled: bool, hasAlert: bool, suspended: bool, due: bool, postingAllowed: bool): ReminderDelivery =
  if (not(matchingOccurrence and scheduled and hasAlert) or suspended) IgnoreReminder
  else if (not(due)) RearmReminder
  else if (not(postingAllowed)) DenyReminderNotice
  else PostReminderNotice
pure def lawAWithdrawnExactAlarmKeepsAnInexactAlarm(exactPermitted: bool): bool =
  alarmForReminder(true, false, exactPermitted, false) == InexactReminderAlarm
pure def lawOnlyTheCurrentDueOccurrenceCanPost(matchingOccurrence: bool, scheduled: bool, hasAlert: bool, suspended: bool, due: bool, postingAllowed: bool): bool =
  deliverReminder(matchingOccurrence, scheduled, hasAlert, suspended, due, postingAllowed) == PostReminderNotice implies
    (matchingOccurrence and scheduled and hasAlert and not(suspended) and due and postingAllowed)
```
