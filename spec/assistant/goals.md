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

## Story: Save the goal I asked for, once

> As an owner, I want a goal I ask for saved, unless I already work
> towards that same goal, and never folded into another goal whose title
> only contains its words.

### A new goal is refused only when an active goal has the same title

Titles are compared without case and without the spaces around them. A
title that is part of a longer one names another goal: "Run a marathon"
is saved beside "Run a half marathon". A paused, archived or satisfied
goal never stops a new goal with its title.

```quint
pure def duplicatesGoal(status: GoalStatus, title: str, requested: str): bool = status == GoalActive and title == requested
pure def lawOnlyAnActiveGoalIsADuplicate(status: GoalStatus, title: str): bool = duplicatesGoal(status, title, title) iff status == GoalActive
pure def lawADifferentTitleIsNeverADuplicate(status: GoalStatus, title: str, requested: str): bool = title != requested implies not(duplicatesGoal(status, title, requested))
```

### A message may ask for several goals, and a goal is renamed only to a nonblank title no other active goal has

Each goal a message asks for is saved under its own title, so two goals
asked for in one message are both saved, and the same request made again
saves nothing more. A rename names the goal as [names](./names.md) says
and gives it a new title: the goal keeps its status, cadence, check-ins
and answers. A blank title, or one another active goal already has,
renames nothing.

```quint
pure def renameGoalAdmitted(renamed: str, takenByAnotherActiveGoal: bool): bool = renamed != "" and not(takenByAnotherActiveGoal)
pure def lawABlankTitleNeverRenamesAGoal(takenByAnotherActiveGoal: bool): bool = not(renameGoalAdmitted("", takenByAnotherActiveGoal))
pure def lawATitleAnotherActiveGoalHasNeverRenamesAGoal(renamed: str): bool = not(renameGoalAdmitted(renamed, true))
```

## Story: Review how my goals are going

> As an owner, I want to ask how a goal is going, or how all my goals did
> this week, and hear it from my own check-in answers, with nothing about
> them changed.

### A review reads one named goal's latest answer, or groups every active goal by how it is going, and changes nothing

A review of a named goal gives its status, its latest check-in answer
and when it came, and how many check-ins were answered in the last seven
days. With no goal named, the weekly review groups every active goal by
its latest answer: on track, at risk, needing attention, or not answered
yet; a paused, archived or satisfied goal is left out. An answer older
than the goal's cadence allows, two days for a daily goal, ten for a
weekly one and seven for a goal without a cadence, no longer says how it
is going: the goal has gone quiet and needs attention, whatever that
answer said, in the review and in a brief alike. A name that matches no
goal, or several, reviews none and says so. A weekly review that finds no
active goal answers with the owner's open to-dos, waiting reminders and
active routines instead.

```quint
type ReviewGroup = GroupOnTrack | GroupAtRisk | GroupNeedsAttention | GroupUnanswered | NotInReview
pure val reviewLookbackMs = 604800000
pure def staleAfterMs(cadence: Cadence): int =
  if (cadence == DailyCadence) 172800000 else if (cadence == WeeklyCadence) 864000000 else 604800000
pure def answerFresh(cadence: Cadence, answeredAt: int, now: int): bool = answeredAt <= now and now - answeredAt <= staleAfterMs(cadence)
pure def reviewGroup(status: GoalStatus, answer: ReviewState, fresh: bool): ReviewGroup =
  if (status != GoalActive) NotInReview
  else if (answer == ReviewIdle) GroupUnanswered
  else if (not(fresh)) GroupNeedsAttention
  else if (answer == OnTrack) GroupOnTrack
  else if (answer == AtRisk) GroupAtRisk
  else GroupNeedsAttention
pure def answeredRecently(at: int, now: int): bool = at <= now and now - at <= reviewLookbackMs
pure def lawOnlyActiveGoalsAreReviewed(status: GoalStatus, answer: ReviewState, fresh: bool): bool = (reviewGroup(status, answer, fresh) == NotInReview) iff status != GoalActive
pure def lawAFreshAnswerGroupsTheGoal(answer: ReviewState): bool =
  (reviewGroup(GoalActive, answer, true) == GroupOnTrack iff answer == OnTrack) and (reviewGroup(GoalActive, answer, true) == GroupAtRisk iff answer == AtRisk)
  and (reviewGroup(GoalActive, answer, true) == GroupNeedsAttention iff answer == NeedsAttention) and (reviewGroup(GoalActive, answer, true) == GroupUnanswered iff answer == ReviewIdle)
pure def lawAQuietGoalNeedsAttention(answer: ReviewState): bool =
  answer != ReviewIdle implies reviewGroup(GoalActive, answer, false) == GroupNeedsAttention
pure def lawAnAnswerPastItsCadenceIsNotFresh(cadence: Cadence, answeredAt: int, now: int): bool =
  now - answeredAt > staleAfterMs(cadence) implies not(answerFresh(cadence, answeredAt, now))
pure def lawAnAnswerOlderThanAWeekIsNotRecent(at: int, now: int): bool = now - at > reviewLookbackMs implies not(answeredRecently(at, now))
```

### A list tells every goal the owner keeps with its status, and changes nothing

A list names every goal that was saved and not deleted, the paused,
archived and satisfied ones too, each with its status and cadence, so the
owner can resume or review one that is not active.

```quint
pure def goalListed(status: GoalStatus): bool = goalExists(status)
pure def lawADeletedGoalIsNeverListed(status: GoalStatus): bool = (status == GoalDeleted or status == NoGoal) implies not(goalListed(status))
pure def lawAPausedOrArchivedGoalIsListed(status: GoalStatus): bool = (status == GoalPaused or status == GoalArchived) implies goalListed(status)
```
