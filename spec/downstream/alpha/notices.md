# Alpha browser notice projection and exact actions

`apps/app/src/browser/{notifications,notice-action,workflow-notices}.ts`
combine an installed browser notification bridge with Calendar, device
reminder, workflow, Focus and hosted agent notice routes. The
[shared mobile notification model](../mobileNotification.md) owns native
resident notification projection; [reminder](../reminderCustody.md)
and [workflow intent](../workflowIntents.md) own their individual effects.
Pinned Alpha evidence includes `WorkflowNoticeTaps`, `NoticesAndCaches`,
`BrowserHostedResultNotice` and `ShadeNoticeQuestionAdmission`.
Here a browser row is selected, opened or dismissed without replaying
its source workflow or implicitly switching owners.

## Story: Act on the current notice without showing its contents after I leave

### Route to the source that actually owns the current notice

The Focus prefix wins, then the own workflow prefix, then hosted or
external source tags, then Calendar prefix and finally reminder.
This routing is a projection only. Own reminder, Calendar and Focus
actions require an exact listed ID and revision, and each source checks
authority at the effect. A hosted tap requires exact origin, scope,
owner, agent, run, workflow and workflow version from current
revalidated history. A pending token alone is not enough; an unknown
or other-account result does not display history, switch account or
consume another owner's tap. External notice text is hidden when
locked, secret or previews are disabled; secret or locked entries
cannot open. Cross-app observation handles include the policy epoch and
current foreground session. The revoked or out-of-session handle
cannot authorize a later device effect.

```quint
type NoticeSource = Own | Hosted | External | Other
type NoticePrefix = FocusPrefix | WorkflowPrefix | CalendarPrefix | OtherPrefix
type NoticeRoute = Focus | Workflow | HostedResult | ExternalApp | Calendar | Reminder
pure def routeNotice(source: NoticeSource, prefix: NoticePrefix): NoticeRoute =
  if (prefix == FocusPrefix) Focus else if (source == Own and prefix == WorkflowPrefix) Workflow else
    if (source == Hosted) HostedResult else if (source == External) ExternalApp else if (prefix == CalendarPrefix) Calendar else Reminder
pure def showsExternalText(visible: bool, secret: bool, previews: bool): bool = visible and not(secret) and previews
pure def externalOpen(visible: bool, secret: bool, launchable: bool): bool = visible and not(secret) and launchable
pure def lawWorkflowRequiresOwn(source: NoticeSource, prefix: NoticePrefix): bool =
  routeNotice(source, prefix) == Workflow implies source == Own and prefix == WorkflowPrefix
pure def lawFocusPrefixWins(source: NoticeSource): bool = routeNotice(source, FocusPrefix) == Focus
pure def lawSecretCannotOpenOrReveal(visible: bool, previews: bool, launchable: bool): bool =
  not(showsExternalText(visible, true, previews) or externalOpen(visible, true, launchable))
```

### A stored workflow receipt is not a repeatable post or implied navigation

The browser workflow store isolates one immutable action identity,
binding, title and full text. A same-identity exact retry reads the
receipt, even after it was dismissed, opened or compacted. A changed
payload conflicts. Bounds are 1–128 character operation IDs under the
pinned pattern, 1–200 character title with no NUL, 1–16,000 character
body, and at most 200 uncompacted rows; overflow reports failure. A
binding hash is a 64-digit lowercase hexadecimal value. An old row
without that hash cannot verify an exact action. Only terminal notices
can be archived; compaction under a captured current recovery receipt
replaces text with its digest and keeps identity. Browser navigation is
after a successful exact action and only while the initiating lease
is still current. Back, Home, visibility, lock, device state, incoming
call, another browser view or page teardown retire that lease. The
same listing can be used to request several actions under its epoch;
it does not make them one successful effect. Per-row requested or
unavailable outcomes remain distinct.

The reducer uses one workflow identity and symbols for full validated
payload bytes. A committed browser-store receipt and later navigation
are distinct transitions. Host event registration, hashing, persistence
and multiplexed source dispatch require conformance fixtures.

```quint
type WorkflowNoticePhase = Unposted | Posted | Opened | Dismissed | Archived
type NoticeRow = { phase: WorkflowNoticePhase, revision: int, payload: int, bound: bool, visible: bool, lease: int, navigation: bool, captured: int }
pure val initial: NoticeRow = { phase: Unposted, revision: 0, payload: 0, bound: false, visible: true, lease: 1, navigation: false, captured: 0 }
pure def canPostNotice(s: NoticeRow, payloadId: int, bound: bool): bool = s.phase == Unposted and payloadId > 0
pure def postNotice(s: NoticeRow, payloadId: int, bound: bool): NoticeRow =
  { ...s, phase: Posted, revision: s.revision + 1, payload: payloadId, bound: bound }
pure def verifiedReceipt(s: NoticeRow, payloadId: int): bool =
  s.phase != Unposted and s.bound and s.payload == payloadId
pure def canActOnNotice(s: NoticeRow, noticeRevision: int, requestedOpen: bool): bool =
  s.phase == Posted and s.visible and noticeRevision == s.revision
pure def actOnNotice(s: NoticeRow, noticeRevision: int, requestedOpen: bool): NoticeRow =
  { ...s, phase: if (requestedOpen) Opened else Dismissed, revision: s.revision + 1,
    captured: if (requestedOpen) s.lease else 0 }
pure def canRetireNoticeLease(s: NoticeRow): bool = s.visible
pure def retireNoticeLease(s: NoticeRow): NoticeRow =
  { ...s, visible: false, lease: s.lease + 1, navigation: false, captured: 0 }
pure def canResumeNoticeLease(s: NoticeRow): bool = not(s.visible)
pure def resumeNoticeLease(s: NoticeRow): NoticeRow = { ...s, visible: true }
pure def canNavigateToNotice(s: NoticeRow): bool =
  s.visible and s.phase == Opened and s.captured == s.lease and not(s.navigation)
pure def navigateToNotice(s: NoticeRow): NoticeRow = { ...s, captured: 0, navigation: true }
pure def canArchiveNotice(s: NoticeRow, noticeRevision: int): bool =
  s.visible and noticeRevision == s.revision and (s.phase == Opened or s.phase == Dismissed)
pure def archiveNotice(s: NoticeRow, noticeRevision: int): NoticeRow =
  { ...s, phase: Archived, revision: s.revision + 1, navigation: false, captured: 0 }
pure def alwaysNoticeLeasePositive(s: NoticeRow): bool = s.lease > 0
pure def alwaysStoredStateVersioned(s: NoticeRow): bool = s.revision >= 0 and (s.phase != Unposted implies s.revision > 0)
pure def alwaysNavigationRequiresVisibleOpenedNotice(s: NoticeRow): bool = s.navigation implies s.visible and s.phase == Opened
pure def stepArchiveRetainsExactIdentity(before: NoticeRow, via: str, after: NoticeRow): bool =
  via == "archiveNotice" implies after.phase == Archived and after.payload == before.payload and after.bound == before.bound
pure def lawWrongRevisionPreventsAction(s: NoticeRow, noticeRevision: int, requestedOpen: bool): bool =
  noticeRevision != s.revision implies not(canActOnNotice(s, noticeRevision, requestedOpen))
pure def lawForeignReceiptCannotVerify(s: NoticeRow, payloadId: int): bool =
  payloadId != s.payload or not(s.bound) implies not(verifiedReceipt(s, payloadId))
pure def lawPostedNeverCompacts(s: NoticeRow, noticeRevision: int): bool =
  s.phase == Posted implies not(canArchiveNotice(s, noticeRevision))
pure def sometimesNavigatesToOpen(s: NoticeRow): bool = s.navigation
pure def sometimesArchivesBoundReceipt(s: NoticeRow): bool = s.phase == Archived and verifiedReceipt(s, s.payload)
pure val payloadIdValues = Set(1, 2)
pure val noticeRevisionValues = Set(1, 2)
pure val weight_actOnNotice = 6
pure val weight_navigateToNotice = 4
pure val weight_archiveNotice = 4
```
