# Goals

A goal is something the owner works towards over time: active, paused,
archived or satisfied. A goal with a cadence gets check-ins, one scheduled
task for each slot its cadence declares, fired at the owner's local hour
by the agent's scheduled-task runner. The owner's answer to a check-in
sets the goal's review state. This machine follows one goal and its
check-in slots.

A cadence declares its slots by trigger shape: a daily cadence a morning
and an evening slot, a weekly cadence one weekly slot. A goal without a
cadence schedules no check-ins and none are invented for it.

## Story: Keep my goals and check in on them when I asked

> As an owner, I want check-ins only for my active goals, at the times
> their cadence names, and a check-in I dismissed never to come back.

### A goal's check-ins are reconciled with its status and cadence on every change

Every write of the goal reconciles its check-in tasks: an active goal has
a live check-in for each slot its cadence declares, except slots the owner
dismissed; any other goal has none. Deleting a goal dismisses all of them.

```quint
type GoalStatus = NoGoal | GoalActive | GoalPaused | GoalArchived | GoalSatisfied | GoalDeleted
type Cadence = NoCadence | DailyCadence | WeeklyCadence
type ReviewState = ReviewIdle | NeedsAttention | OnTrack | AtRisk
type Goal = { status: GoalStatus, cadence: Cadence, liveSlots: Set[int], dismissedSlots: Set[int], firedSlots: Set[int], reviewState: ReviewState, checkinLog: int }
pure val initial: Goal = { status: NoGoal, cadence: NoCadence, liveSlots: Set(), dismissedSlots: Set(), firedSlots: Set(), reviewState: ReviewIdle, checkinLog: 0 }
pure def cadenceSlots(cadence: Cadence): Set[int] = if (cadence == DailyCadence) Set(1, 2) else if (cadence == WeeklyCadence) Set(3) else Set()
pure def reconcileCheckins(status: GoalStatus, cadence: Cadence, g: Goal): Goal = {
  val live = if (status == GoalActive) cadenceSlots(cadence).exclude(g.dismissedSlots) else Set()
  { ...g, status: status, cadence: cadence, liveSlots: live, firedSlots: g.firedSlots.intersect(live) }
}
pure def canCreateGoal(s: Goal, cadence: Cadence): bool = s.status == NoGoal
pure def createGoal(s: Goal, cadence: Cadence): Goal = reconcileCheckins(GoalActive, cadence, s)
pure def goalExists(status: GoalStatus): bool = status != NoGoal and status != GoalDeleted
pure def canUpdateGoal(s: Goal, status: GoalStatus, cadence: Cadence): bool = goalExists(s.status) and goalExists(status)
pure def updateGoal(s: Goal, status: GoalStatus, cadence: Cadence): Goal = reconcileCheckins(status, cadence, s)
pure def canDeleteGoal(s: Goal): bool = goalExists(s.status)
pure def deleteGoal(s: Goal): Goal = reconcileCheckins(GoalDeleted, s.cadence, s)
pure def alwaysCheckinsOnlyForActiveGoals(s: Goal): bool =
  s.liveSlots.subseteq(cadenceSlots(s.cadence)) and (s.status != GoalActive implies s.liveSlots.size() == 0)
```

### A check-in the owner dismissed never comes back for the same slot

```quint
pure val slotValues = Set(1, 2, 3, 4)
pure def canDismissCheckin(s: Goal, slot: int): bool = s.liveSlots.contains(slot)
pure def dismissCheckin(s: Goal, slot: int): Goal =
  { ...s, liveSlots: s.liveSlots.exclude(Set(slot)), firedSlots: s.firedSlots.exclude(Set(slot)), dismissedSlots: s.dismissedSlots.union(Set(slot)) }
pure def alwaysDismissedCheckinsStayDismissed(s: Goal): bool = s.liveSlots.intersect(s.dismissedSlots).size() == 0
pure def stepDismissalsAreKept(before: Goal, after: Goal): bool = before.dismissedSlots.subseteq(after.dismissedSlots)
```

### The owner's answer to a fired check-in sets the goal's review state

A check-in fires from a live slot. The answer completes that firing,
records the reported progress as the review state, and adds an entry to
the goal's check-in log, which keeps its latest twenty entries.

```quint
pure val checkinLogLimit = 20
pure def canFireCheckin(s: Goal, slot: int): bool = s.liveSlots.contains(slot) and not(s.firedSlots.contains(slot))
pure def fireCheckin(s: Goal, slot: int): Goal = { ...s, firedSlots: s.firedSlots.union(Set(slot)) }
pure def canAnswerCheckin(s: Goal, slot: int, progress: ReviewState): bool = s.firedSlots.contains(slot) and progress != ReviewIdle
pure def answerCheckin(s: Goal, slot: int, progress: ReviewState): Goal =
  { ...s, firedSlots: s.firedSlots.exclude(Set(slot)), reviewState: progress, checkinLog: if (s.checkinLog < checkinLogLimit) s.checkinLog + 1 else checkinLogLimit }
pure def alwaysFiredCheckinsAreLive(s: Goal): bool = s.firedSlots.subseteq(s.liveSlots) and s.checkinLog >= 0 and s.checkinLog <= checkinLogLimit
```

### A goal can be checked in on, paused, and resumed without a dismissed check-in

```quint
pure def sometimesAnsweredOnTrack(s: Goal): bool = s.status == GoalActive and s.reviewState == OnTrack
pure def sometimesPausedWithoutCheckins(s: Goal): bool = s.status == GoalPaused and s.cadence != NoCadence
pure def sometimesResumedWithoutTheDismissedSlot(s: Goal): bool = s.status == GoalActive and s.dismissedSlots.contains(1) and s.liveSlots.contains(2)
```
