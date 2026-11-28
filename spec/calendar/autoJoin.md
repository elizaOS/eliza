# Meeting auto-join and conflict severity

When a calendar event carries a recognized HTTPS conference link and has not
ended, the owner's auto-join policy governs whether no task, an approval-gated
pair, or a direct join task is scheduled. Conflict scans classify overlapping
events deterministically and never mark a scan definitive when any calendar
source is unread.

## Story: Detect calendar conflicts honestly and schedule meeting auto-join by policy

> As the owner, I want conflict detection to classify overlapping and
> back-to-back events accurately without hiding unread calendars, and meeting
> auto-join to schedule approval-gated or direct join tasks strictly according
> to my policy.

### Conflict scans classify overlap severity and require complete reads to be definitive

Two timed events with positive overlap are a hard conflict; adjacent events
within 5 minutes are back-to-back; otherwise they do not conflict. A scan is
definitive only when at least one calendar source exists and zero sources are
unread.

```quint
type ConflictSeverity = ConflictNone | ConflictBackToBack | ConflictHardOverlap
pure def classifyPairConflict(aStart: int, aEnd: int, bStart: int, bEnd: int): ConflictSeverity =
  if (aStart < bEnd and bStart < aEnd) ConflictHardOverlap
  else if ((aEnd <= bStart and bStart - aEnd <= 300000) or (bEnd <= aStart and aStart - bEnd <= 300000)) ConflictBackToBack
  else ConflictNone
pure def conflictScanDefinitive(totalSources: int, unreadSources: int): bool =
  totalSources > 0 and unreadSources == 0
pure val totalSourcesValues: Set[int] = Set(0, 1, 3)
pure val unreadSourcesValues: Set[int] = Set(0, 1, 2)
pure def lawUnreadSourceNeverDefinitive(totalSources: int, unreadSources: int): bool =
  unreadSources > 0 implies not(conflictScanDefinitive(totalSources, unreadSources))
```

### Auto-join task planning obeys policy, link recognition, and event end time

An event with policy `off`, without a recognized HTTPS meeting link, or whose
end time has already passed schedules zero tasks. Policy `ask` schedules an
approval task plus a dependent join task (2 tasks), while policy `all`
schedules one direct join task (1 task).

```quint
type AutoJoinPolicy = AutoJoinOff | AutoJoinAsk | AutoJoinAll
pure def plannedAutoJoinTaskCount(policy: AutoJoinPolicy, hasMeetingLink: bool, eventEnded: bool): int =
  if (policy == AutoJoinOff or not(hasMeetingLink) or eventEnded) 0
  else if (policy == AutoJoinAsk) 2
  else 1
pure def lawOffPolicySchedulesNothing(hasMeetingLink: bool, eventEnded: bool): bool =
  plannedAutoJoinTaskCount(AutoJoinOff, hasMeetingLink, eventEnded) == 0
pure def lawEndedEventSchedulesNothing(policy: AutoJoinPolicy, hasMeetingLink: bool): bool =
  plannedAutoJoinTaskCount(policy, hasMeetingLink, true) == 0
```

### Auto-join approval lifecycle joins only after owner approval or under all-policy

A tracked meeting join starts idle, can be armed for approval or direct join,
transitions to joined only once approved (or directly when policy is `all`),
and cancels cleanly when declined, ended, or disabled without rewinding its
revision counter.

```quint
type AutoJoinPhase = JoinIdle | JoinAwaitingApproval | JoinArmed | JoinDispatched | JoinCancelled
type AutoJoinMachine = {
  phase: AutoJoinPhase,
  policy: AutoJoinPolicy,
  revision: int,
  approved: bool
}
pure val initial: AutoJoinMachine = {
  phase: JoinIdle,
  policy: AutoJoinOff,
  revision: 0,
  approved: false
}
pure def canArmAutoJoin(s: AutoJoinMachine, policy: AutoJoinPolicy, hasMeetingLink: bool, eventEnded: bool): bool =
  s.phase == JoinIdle and plannedAutoJoinTaskCount(policy, hasMeetingLink, eventEnded) > 0
pure def armAutoJoin(s: AutoJoinMachine, policy: AutoJoinPolicy, hasMeetingLink: bool, eventEnded: bool): AutoJoinMachine =
  if (policy == AutoJoinAsk) { phase: JoinAwaitingApproval, policy: policy, revision: s.revision + 1, approved: false }
  else { phase: JoinArmed, policy: policy, revision: s.revision + 1, approved: true }
pure def canApproveAutoJoin(s: AutoJoinMachine): bool =
  s.phase == JoinAwaitingApproval
pure def approveAutoJoin(s: AutoJoinMachine): AutoJoinMachine =
  { ...s, phase: JoinArmed, revision: s.revision + 1, approved: true }
pure def canDispatchAutoJoin(s: AutoJoinMachine): bool =
  s.phase == JoinArmed and s.approved
pure def dispatchAutoJoin(s: AutoJoinMachine): AutoJoinMachine =
  { ...s, phase: JoinDispatched, revision: s.revision + 1 }
pure def canCancelAutoJoin(s: AutoJoinMachine): bool =
  s.phase == JoinAwaitingApproval or s.phase == JoinArmed
pure def cancelAutoJoin(s: AutoJoinMachine): AutoJoinMachine =
  { phase: JoinCancelled, policy: s.policy, revision: s.revision + 1, approved: false }
pure def alwaysDispatchedWasApproved(s: AutoJoinMachine): bool =
  s.phase == JoinDispatched implies s.approved
pure def alwaysAskRequiresApprovalBeforeArmed(s: AutoJoinMachine): bool =
  (s.phase == JoinArmed and s.policy == AutoJoinAsk) implies s.approved
pure def stepAutoJoinRevisionMonotonic(before: AutoJoinMachine, after: AutoJoinMachine): bool =
  before.revision <= after.revision
pure def sometimesApprovedThenDispatched(s: AutoJoinMachine): bool =
  s.phase == JoinDispatched and s.policy == AutoJoinAsk and s.approved
pure val eval_witness_sometimesApprovedThenDispatched = (
  ("armAutoJoin", AutoJoinAsk, true, false),
  ("approveAutoJoin"),
  ("dispatchAutoJoin")
)
```
