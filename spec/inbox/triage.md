# Unified cross-channel triage and subscriptions

The inbox package aggregates unread and recent messages across connected
messaging platforms, classifies them by priority without hiding partial source
outages, tracks each triage item's lifecycle monotonically, and gates email
unsubscribe network calls on explicit owner authorization and safe HTTPS hosts.

## Story: Triage my unified cross-channel inbox and safely manage subscriptions

> As the owner, I want a bounded, priority-ranked cross-channel inbox view that
> reports degraded platforms honestly, lets me snooze, reply, archive, or
> dismiss items cleanly, and executes unsubscribe requests only after my
> authorization on safe public HTTPS targets.

### Triage windows are bounded, priority buckets are deterministic, and source failures remain visible

A cross-channel triage request accepts between 1 and 100 items. Scores at or
above 80 are urgent, 50 to 79 are important, 20 to 49 are normal, and below 20
are low. A feed is complete only when at least one source ran and zero sources
failed.

```quint
type TriagePriority = TriageUrgent | TriageImportant | TriageNormal | TriageLow
pure def triageWindowAllowed(limit: int): bool =
  limit >= 1 and limit <= 100
pure val limitValues: Set[int] = Set(0, 1, 25, 100, 101)
pure def triagePriorityBucket(score: int): TriagePriority =
  if (score >= 80) TriageUrgent
  else if (score >= 50) TriageImportant
  else if (score >= 20) TriageNormal
  else TriageLow
pure val scoreValues: Set[int] = Set(0, 19, 20, 49, 50, 79, 80, 100)
pure def lawScoreAtOrAboveEightyIsUrgent(score: int): bool =
  score >= 80 implies triagePriorityBucket(score) == TriageUrgent
pure def triageFeedComplete(totalSources: int, failedSources: int): bool =
  totalSources > 0 and failedSources == 0
pure val totalSourcesValues: Set[int] = Set(0, 1, 3)
pure val failedSourcesValues: Set[int] = Set(0, 1, 2)
pure def lawAnyFailureMarksFeedIncomplete(totalSources: int, failedSources: int): bool =
  failedSources > 0 implies not(triageFeedComplete(totalSources, failedSources))
```

### Email unsubscribe dispatch requires explicit owner authorization and a safe public HTTPS target

Untrusted email headers may supply arbitrary URLs. Unsubscribe dispatch is
admitted only when the owner explicitly authorized the action and the parsed
target uses HTTPS on a public host.

```quint
pure def mayDispatchUnsubscribe(userAuthorized: bool, httpsUrl: bool, publicHost: bool): bool =
  userAuthorized and httpsUrl and publicHost
pure def lawUnsubscribeRequiresAuthorization(httpsUrl: bool, publicHost: bool): bool =
  not(mayDispatchUnsubscribe(false, httpsUrl, publicHost))
pure def lawUnsubscribeRefusesPrivateHost(userAuthorized: bool, httpsUrl: bool): bool =
  not(mayDispatchUnsubscribe(userAuthorized, httpsUrl, false))
```

### Triage item state transitions advance the revision monotonically

Each triage item starts pending and may be snoozed until a future timestamp,
replied, archived, dismissed, or reopened. Snoozed items always carry a wake
time strictly greater than zero, and every accepted transition advances the
item's revision counter without rewinding.

```quint
type TriageStatus = TriagePending | TriageSnoozed | TriageReplied | TriageArchived | TriageDismissed
type InboxTriageItem = {
  status: TriageStatus,
  version: int,
  snoozedUntilMs: int
}
pure val initial: InboxTriageItem = {
  status: TriagePending,
  version: 0,
  snoozedUntilMs: 0
}
pure def canSnoozeItem(s: InboxTriageItem, untilMs: int, nowMs: int): bool =
  (s.status == TriagePending or s.status == TriageSnoozed) and nowMs >= 0 and untilMs > nowMs
pure def snoozeItem(s: InboxTriageItem, untilMs: int, nowMs: int): InboxTriageItem =
  { status: TriageSnoozed, version: s.version + 1, snoozedUntilMs: untilMs }
pure def canReplyItem(s: InboxTriageItem): bool =
  s.status == TriagePending or s.status == TriageSnoozed
pure def replyItem(s: InboxTriageItem): InboxTriageItem =
  { status: TriageReplied, version: s.version + 1, snoozedUntilMs: 0 }
pure def canArchiveItem(s: InboxTriageItem): bool =
  s.status != TriageArchived
pure def archiveItem(s: InboxTriageItem): InboxTriageItem =
  { status: TriageArchived, version: s.version + 1, snoozedUntilMs: 0 }
pure def canDismissItem(s: InboxTriageItem): bool =
  s.status != TriageDismissed
pure def dismissItem(s: InboxTriageItem): InboxTriageItem =
  { status: TriageDismissed, version: s.version + 1, snoozedUntilMs: 0 }
pure def canReopenItem(s: InboxTriageItem): bool =
  s.status != TriagePending
pure def reopenItem(s: InboxTriageItem): InboxTriageItem =
  { status: TriagePending, version: s.version + 1, snoozedUntilMs: 0 }
pure def alwaysSnoozedHasPositiveWakeTime(s: InboxTriageItem): bool =
  s.status == TriageSnoozed implies s.snoozedUntilMs > 0
pure def alwaysVersionNonNegative(s: InboxTriageItem): bool =
  s.version >= 0
pure def stepTriageVersionMonotonic(before: InboxTriageItem, after: InboxTriageItem): bool =
  before.version <= after.version
pure def sometimesItemSnoozedThenArchived(s: InboxTriageItem): bool =
  s.status == TriageArchived and s.version >= 2
pure val eval_witness_sometimesItemSnoozedThenArchived = (
  ("snoozeItem", 2000, 1000),
  ("archiveItem")
)
pure val untilMsValues: Set[int] = Set(0, 500, 2000)
pure val nowMsValues: Set[int] = Set(0, 1000)
```
