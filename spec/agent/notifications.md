# Push notifications

The agent's push service delivers notices to the user's devices. The
[core notifications](../core/notifications/) own the notice records; this
spec owns the push service's attachment to the runtime's notification bus
and the device token it delivers to, the owner's notice list and its
read marks, and the live notice stream a device holds. Platform transports
are outside the model.

## Story: Get each notice once on my device, and nothing after the service stops

> As a user, I get a push for each notice once, not once per attachment, and
> the service sends nothing after it stops. My device token is used only after
> it is saved.

### Concurrent lazy attachments keep their startup epoch and publish one listener

The service attaches to the bus at start, or lazily, and two lazy
attachments may be in flight at once. Each remembers the epoch it started in. One that completes in the
current epoch subscribes the single listener, or finds it already there;
one that started before the last stop completes without subscribing.

```quint
type PushService = { subscribed: bool, listeners: int, epoch: int, pendingCurrent: int, pendingStale: int, stopped: bool, committedToken: bool, candidateToken: bool, writing: bool, deliveries: int, owner: int, streamOpen: bool, streamOwner: int, streamed: int }
pure val initial: PushService = { subscribed: false, listeners: 0, epoch: 0, pendingCurrent: 0, pendingStale: 0, stopped: false, committedToken: false, candidateToken: false, writing: false, deliveries: 0, owner: 1, streamOpen: false, streamOwner: 0, streamed: 0 }
pure def attach(p: PushService): PushService = { ...p, subscribed: true, listeners: 1, stopped: false }
pure def canBeginLazyAttach(p: PushService): bool = not(p.subscribed)
pure def beginLazyAttach(p: PushService): PushService = { ...p, pendingCurrent: p.pendingCurrent + 1, stopped: false }
pure def canCompleteCurrentAttach(p: PushService): bool = p.pendingCurrent > 0
pure def completeCurrentAttach(p: PushService): PushService = { ...p, pendingCurrent: p.pendingCurrent - 1, subscribed: true, listeners: 1 }
pure def canCompleteStaleAttach(p: PushService): bool = p.pendingStale > 0
pure def completeStaleAttach(p: PushService): PushService = { ...p, pendingStale: p.pendingStale - 1 }
pure def alwaysOneListenerAtMost(p: PushService): bool = (p.listeners == 0 or p.listeners == 1) and p.subscribed == (p.listeners == 1)
pure def stepStaleAttachNeverSubscribes(before: PushService, via: str, after: PushService): bool =
  via == "completeStaleAttach" implies (after.subscribed == before.subscribed and after.listeners == before.listeners)
pure def sometimesConcurrentAttachesShareOneListener(p: PushService): bool = p.listeners == 1 and p.pendingCurrent > 0
```

### Stopping invalidates every attachment

Stopping unsubscribes the listener, advances the epoch and turns every
attachment still in flight into a stale one. A stopped service has no
listener and no current attachment until it is started or attached again.

```quint
pure def stop(p: PushService): PushService = { ...p, subscribed: false, listeners: 0, epoch: p.epoch + 1, stopped: true, pendingStale: p.pendingStale + p.pendingCurrent, pendingCurrent: 0 }
pure def alwaysStoppedServiceHasNoListener(p: PushService): bool = p.stopped implies (p.listeners == 0 and p.pendingCurrent == 0)
pure def sometimesStaleAttachDiscardedAfterStop(p: PushService): bool = p.stopped and p.epoch > 0 and p.pendingStale == 0 and p.pendingCurrent == 0 and p.listeners == 0 and not(p.subscribed)
```

### A device token is persisted before it is acknowledged or used

A new or cleared token is staged and written. Only a successful write makes it
the committed token; a failed write restores the committed one. Delivery
needs a listener and a committed token.

```quint
pure def canStageToken(p: PushService, present: bool): bool = not(p.writing)
pure def stageToken(p: PushService, present: bool): PushService = { ...p, candidateToken: present, writing: true }
pure def canPersistToken(p: PushService, ok: bool): bool = p.writing
pure def persistToken(p: PushService, ok: bool): PushService =
  if (ok) { ...p, committedToken: p.candidateToken, writing: false } else { ...p, candidateToken: p.committedToken, writing: false }
pure def canDeliver(p: PushService): bool = p.subscribed and p.committedToken
pure def deliver(p: PushService): PushService = { ...p, deliveries: p.deliveries + 1 }
pure def alwaysUnwrittenTokenIsNotVisible(p: PushService): bool = not(p.writing) implies p.candidateToken == p.committedToken
pure def stepDeliveryUsesAPersistedToken(before: PushService, via: str, after: PushService): bool =
  via == "deliver" implies (before.committedToken and before.subscribed)
pure def sometimesDelivered(p: PushService): bool = p.deliveries > 0
```

## Story: Read and clear my notices from my own client

> As the owner, my client lists only the notices I ask for, marks exactly
> the one I read, and a live notice stream stops the moment my device
> belongs to someone else.

### A notice list holds only the notices its filters ask for

The list may filter by one known category (reminder, task, workflow,
agent, approval, message, health, system or general), by unread only, and
by a page limit. An unknown category, an unread filter that is repeated or
other than empty, true or false, and a limit that is not a positive whole
number are refused. A
limit above five hundred is read as five hundred. With unread only, no read
notice is listed; with a category, no notice of another category is.

```quint
type NoticeCategory = AnyCategory | ReminderNotice | TaskNotice | WorkflowNotice | AgentNotice | ApprovalNotice | MessageNotice | HealthNotice | SystemNotice | GeneralNotice
type NoticeRow = { category: NoticeCategory, unread: bool }
type NoticeFilter = { category: NoticeCategory, unreadOnly: bool }
pure def noticeListed(noticeFilter: NoticeFilter, row: NoticeRow): bool =
  (not(noticeFilter.unreadOnly) or row.unread) and (noticeFilter.category == AnyCategory or row.category == noticeFilter.category)
pure def noticeFilterAccepted(categoryKnown: bool, unreadGiven: int, unreadValid: bool, limitValid: bool): bool =
  categoryKnown and unreadGiven <= 1 and (unreadGiven == 0 or unreadValid) and limitValid
pure def noticePageSize(limit: int): int = if (limit > 500) 500 else limit
pure val noticeFilterValues = Set({ category: AnyCategory, unreadOnly: false }, { category: ReminderNotice, unreadOnly: true }, { category: MessageNotice, unreadOnly: false })
pure val rowValues = Set({ category: ReminderNotice, unread: true }, { category: ReminderNotice, unread: false }, { category: MessageNotice, unread: true })
pure val unreadGivenValues = Set(0, 1, 2)
pure val limitValues = Set(1, 20, 500, 900)
pure def lawUnreadOnlyListsNoReadNotice(noticeFilter: NoticeFilter, row: NoticeRow): bool = (noticeFilter.unreadOnly and not(row.unread)) implies not(noticeListed(noticeFilter, row))
pure def lawCategoryFilterListsOnlyThatCategory(noticeFilter: NoticeFilter, row: NoticeRow): bool =
  (noticeFilter.category != AnyCategory and row.category != noticeFilter.category) implies not(noticeListed(noticeFilter, row))
pure def lawUnknownCategoryIsRefused(unreadGiven: int, unreadValid: bool, limitValid: bool): bool = not(noticeFilterAccepted(false, unreadGiven, unreadValid, limitValid))
pure def lawPageNeverExceedsTheCap(limit: int): bool = noticePageSize(limit) <= 500
```

### Marking a notice read changes only that notice, and says whether it existed

Marking one notice read by its ID makes that notice read and leaves every
other notice as it was. The reply says whether a notice with that ID
existed; a malformed ID is refused.

```quint
type MarkedRow = { id: int, unread: bool }
pure def markedRead(marked: MarkedRow, id: int): MarkedRow = if (marked.id == id) { ...marked, unread: false } else marked
pure def markReadReply(rows: List[MarkedRow], id: int): bool = rows.some(r => r.id == id)
pure val markedValues = Set({ id: 1, unread: true }, { id: 2, unread: true }, { id: 1, unread: false })
pure val idValues = Set(1, 2, 3)
pure def lawMarkReadChangesOnlyTheNamedNotice(marked: MarkedRow, id: int): bool =
  markedRead(marked, id).id == marked.id and markedRead(marked, id).unread == (marked.unread and marked.id != id)
pure def lawMarkReadReplyNamesAnExistingNotice(marked: MarkedRow, id: int): bool = markReadReply(List(marked), id) == (marked.id == id)
```

### A live notice stream belongs to the owner who opened it and ends when the owner changes

A device opens a live notice stream for the current owner. When the owner
changes, the open stream is cancelled; nothing is streamed on it again, and
a new stream must be opened for the new owner.

```quint
pure def canOpenNoticeStream(p: PushService): bool = not(p.streamOpen)
pure def openNoticeStream(p: PushService): PushService = { ...p, streamOpen: true, streamOwner: p.owner }
pure def changeNoticeOwner(p: PushService): PushService = { ...p, owner: p.owner + 1, streamOpen: false }
pure def canStreamNotice(p: PushService): bool = p.streamOpen
pure def streamNotice(p: PushService): PushService = { ...p, streamed: p.streamed + 1 }
pure def alwaysOpenStreamIsTheOwners(p: PushService): bool = p.streamOpen implies p.streamOwner == p.owner
pure def stepStreamedNoticeGoesToTheCurrentOwner(before: PushService, via: str, after: PushService): bool =
  via == "streamNotice" implies (before.streamOpen and before.streamOwner == before.owner)
pure def sometimesStreamReopenedForNewOwner(p: PushService): bool = p.streamOpen and p.owner > 1 and p.streamed > 0
```
