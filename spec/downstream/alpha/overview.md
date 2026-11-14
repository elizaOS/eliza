# Alpha Home overview projections

`apps/app/src/prototype/home-cards.ts` binds all of the pinned Eliza
`packages/ui/src/overview/daily-overview.ts` agenda, Inbox, short calendar,
workflow freshness and retained digest presentation. Alpha supplies its locale,
hour cycle, event visibility policy and exact connected owner. Its
`home-overview-cards.ts` renders the shared components and hides cards
without eligible content. This is read-only view data. It does not query
providers, refresh email, request a digest, or authorize an effect.

## Story: See what Home actually knows from my current sources

### Freshness describes a read by this device

An absent, invalid or future read does not count as stale. An earlier
local day is stale even if fewer than 24 hours have elapsed. Display time
is the app's successful read timestamp or the selected Calendar feed's
explicit snapshot instant; no provider's sync time is inferred. The
host normalizes valid time evidence and derives local midnight in the
user's time zone. Presentation may shorten text with an explicit
ellipsis; this does not change [authorized source data](../conversation.md).

Inbox is a projection of the last already-loaded page metadata for the
current connection. The host clears a revoked or departed account from
eligible data. Its projection reports error before loading, then loaded,
disconnected or idle. Last-known stale status with a valid read time and
no new page does not display stale subjects. Incomplete pages describe
their count as a lower bound, not a mailbox total. At most two unread
subjects and senders are shown, and no body is accepted. In Alpha the
card also requires a connected account, visibility and eligible rows.

```quint
type InboxView = MailError | MailLoading | MailReady | MailDisconnected | MailIdle | MailStale
type InboxCard = { failed: bool, pending: bool, loaded: bool, disconnected: bool, current: bool, stale: bool, hasReadTime: bool, unread: int, partial: bool, shown: bool }
pure val cValues = Set(
  { failed: false, pending: false, loaded: true, disconnected: false, current: true, stale: false, hasReadTime: true, unread: 4, partial: true, shown: true },
  { failed: true, pending: true, loaded: false, disconnected: true, current: false, stale: false, hasReadTime: false, unread: 0, partial: false, shown: true },
  { failed: false, pending: false, loaded: false, disconnected: false, current: true, stale: true, hasReadTime: true, unread: 3, partial: true, shown: true }
)
pure def overviewStale(readAt: int, now: int, midnight: int): bool = readAt > 0 and readAt <= now and readAt < midnight
pure def eligibleMail(c: InboxCard): bool = c.current and c.loaded
pure def mailView(c: InboxCard): InboxView =
  if (c.failed) MailError else if (c.pending) MailLoading else if (eligibleMail(c)) MailReady else
    if (c.current and c.stale and c.hasReadTime) MailStale else if (c.disconnected) MailDisconnected else MailIdle
pure def subjectRows(c: InboxCard): int =
  if (not(eligibleMail(c)) or c.unread <= 0) 0 else if (c.unread > 2) 2 else c.unread
pure def lowerBoundOnly(c: InboxCard): bool = eligibleMail(c) and c.unread > 0 and c.partial
pure def alphaMailShows(c: InboxCard): bool = c.shown and not(c.disconnected) and subjectRows(c) > 0
pure def lawFutureClockIsNotStale(readAt: int, now: int, midnight: int): bool =
  readAt > now implies not(overviewStale(readAt, now, midnight))
pure def lawMailboxNeverShowsAnotherOwner(c: InboxCard): bool = not(c.current) implies not(alphaMailShows(c)) and subjectRows(c) == 0
pure def lawMailboxShowsAtMostTwo(c: InboxCard): bool = subjectRows(c) >= 0 and subjectRows(c) <= 2
pure def lawIncompleteCountIsLowerBound(c: InboxCard): bool = (c.partial and subjectRows(c) > 0) implies lowerBoundOnly(c)
pure def lawMailFailureTakesPrecedence(c: InboxCard): bool = c.failed implies mailView(c) == MailError
```

### Agenda preserves uncertainty and user's calendar selection

A native/local candidate needs a finite start, a finite end unless
overdue, and an end not before now (strictly after now for all-day).
Completed reminders and hidden Calendar sources are excluded. Sort
overdue first (even ahead of an in-progress event), then start/due
ascending, preserving input order on ties. Keep the earliest eligible
nonoverdue item visible under an overdue one. Alpha may pick the
earliest eligible local reminder or agent event as that next item,
with the local reminder winning a start tie.

A provider calendar can show representative rows from a verified current
and complete snapshot with no mutation in flight. A full today, Monday
through Sunday week, and current month must be covered by the query
with exact local midnight at the first required day when starting
there. Events require a visible source with provider, side, grant,
account when supplied, calendar ID, inclusion and role all matching;
cancelled events are excluded. Use civil days in the configured time
zone, except all-day boundaries are UTC civil dates. Among candidates
overlapping a period, prioritize today, then current week, then current
month; within that period take the earliest-start unended event, or the
most recent ended event. The full identity key orders exact ties.
A partial or older feed can present labeled stale rows, without
claiming emptiness. Distinguish loading, disconnected, legacy review,
failure, empty, stale and current. No upcoming event is a verified
statement only for a complete current feed.

```quint
type AgendaRow = { begin: int, end: int, ordered: int, overdue: bool, allDay: bool, allowed: bool, finiteBegin: bool, finiteEnd: bool }
pure val aValues = Set(
  { begin: 1, end: 1, ordered: 0, overdue: true, allDay: false, allowed: true, finiteBegin: true, finiteEnd: false },
  { begin: 1, end: 3, ordered: 1, overdue: false, allDay: true, allowed: true, finiteBegin: true, finiteEnd: true },
  { begin: 3, end: 4, ordered: 2, overdue: false, allDay: false, allowed: false, finiteBegin: true, finiteEnd: true }
)
pure val bValues = aValues
pure def eligibleAgenda(row: AgendaRow, now: int): bool =
  row.allowed and row.finiteBegin and (row.overdue or (row.finiteEnd and (if (row.allDay) row.end > now else row.end >= now)))
pure def aheadAgenda(a: AgendaRow, b: AgendaRow): bool =
  if (a.overdue != b.overdue) a.overdue else a.begin < b.begin or (a.begin == b.begin and a.ordered <= b.ordered)
pure def agendaPair(a: AgendaRow, b: AgendaRow, now: int): AgendaRow =
  if (not(eligibleAgenda(b, now)) or (eligibleAgenda(a, now) and aheadAgenda(a, b))) a else b
type CalendarFeed = { current: bool, ready: bool, mutating: bool, complete: bool, fullRange: bool, stale: bool, hasItem: bool }
pure val feedValues = Set(
  { current: true, ready: true, mutating: false, complete: true, fullRange: true, stale: false, hasItem: false },
  { current: true, ready: true, mutating: false, complete: false, fullRange: false, stale: true, hasItem: true },
  { current: false, ready: true, mutating: true, complete: true, fullRange: true, stale: false, hasItem: false }
)
pure def calendarVerified(feed: CalendarFeed): bool = feed.current and feed.ready and not(feed.mutating) and feed.complete and feed.fullRange and not(feed.stale)
pure def overviewEmpty(feed: CalendarFeed): bool = calendarVerified(feed) and not(feed.hasItem)
pure def lawEligibleOverdueWins(a: AgendaRow, b: AgendaRow, now: int): bool =
  (a.overdue and not(b.overdue) and eligibleAgenda(a, now)) implies agendaPair(a, b, now) == a
pure def lawSelectedPairIsEligibleWhenPossible(a: AgendaRow, b: AgendaRow, now: int): bool =
  (eligibleAgenda(a, now) or eligibleAgenda(b, now)) implies eligibleAgenda(agendaPair(a, b, now), now)
pure def lawAllDayEndIsExclusive(a: AgendaRow, now: int): bool =
  (a.allDay and not(a.overdue) and a.end <= now) implies not(eligibleAgenda(a, now))
pure def lawIncompleteCannotClaimEmpty(feed: CalendarFeed): bool = (not(feed.complete) or not(feed.fullRange) or feed.stale) implies not(overviewEmpty(feed))
pure def lawOtherOwnerCannotVerifyCalendar(feed: CalendarFeed): bool = not(feed.current) implies not(calendarVerified(feed))
```

### Retained results are distinct from a new completed run

A brief card has a current retained result with nonempty normalized
summary and a valid occurrence time. Failed, error or cancelled statuses
mean failed; missed, overlap and unavailable show Did not run.
The remaining statuses display Ran according to the pinned helper.
Workflow freshness is empty until the current connection actually
loaded a list; the card labels agent-only, phone reminders only, or
unified provenance. Failure notices are separately owned by the Home
launcher adapter (`HomeFailureNotice` in the pinned Alpha Quint set).
Any full rendered-copy, DST, accessibility and presentation parity
fixture must use the real parser and renderer alongside these laws.

```quint
type RetainedBrief = FailedRun | MissedOccurrence | OverlapOccurrence | UnavailableOccurrence | RanOther
pure def displaysRun(status: RetainedBrief): bool = status == RanOther
pure def showsBrief(ownerCurrent: bool, summary: bool, readTime: bool): bool = ownerCurrent and summary and readTime
pure def lawMissedIsNeverPresentedAsRan(status: RetainedBrief): bool =
  (status == MissedOccurrence or status == OverlapOccurrence or status == UnavailableOccurrence) implies not(displaysRun(status))
pure def lawForeignBriefDoesNotShow(summary: bool, readTime: bool): bool = not(showsBrief(false, summary, readTime))
```
