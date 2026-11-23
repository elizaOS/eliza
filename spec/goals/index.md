# Goals and check-in views

The [assistant goal policy](../assistant/goals.md) owns goal mutations and the reconciliation of check-in schedules. This package serves the owner-facing goal and check-in view and maps stored goal records, including eligible legacy records, to it.

## Story: Review my goals and check-in history

> As the owner, I can see my active or archived goals alongside their check-in history and open the corresponding goal.

### Only the owner's goals are returned in the selected status group

```quint
import goals as GoalPolicy from "../assistant/goals"
type GoalViewFilter = ActiveGoals | ArchivedGoals | AllGoals
type GoalViewRow = { ownerId: str, goalId: str, title: str, goalStatus: GoalPolicy::GoalStatus, goalReview: GoalPolicy::ReviewState }
pure def matchesGoalView(row: GoalViewRow, ownerId: str, goalGroup: GoalViewFilter): bool =
  row.ownerId == ownerId and GoalPolicy::goalExists(row.goalStatus) and
  (goalGroup == AllGoals or (goalGroup == ActiveGoals and row.goalStatus == GoalPolicy::GoalActive) or
  (goalGroup == ArchivedGoals and row.goalStatus == GoalPolicy::GoalArchived))
pure def visibleGoals(rows: List[GoalViewRow], ownerId: str, goalGroup: GoalViewFilter): List[GoalViewRow] =
  rows.select(row => matchesGoalView(row, ownerId, goalGroup))
pure def lawGoalViewIsOwnerScoped(rows: List[GoalViewRow], ownerId: str, goalGroup: GoalViewFilter): bool =
  visibleGoals(rows, ownerId, goalGroup).every(row => row.ownerId == ownerId)
```

### A goal's history is scoped to the exact owner and goal identifier

```quint
type GoalReviewEntry = { reviewOwner: str, reviewGoal: str, recordedAt: int, reviewText: str }
pure def checkinsFor(entries: List[GoalReviewEntry], ownerId: str, goalId: str): List[GoalReviewEntry] =
  entries.select(entry => entry.reviewOwner == ownerId and entry.reviewGoal == goalId)
pure def mayImportGoal(row: GoalViewRow, ownerId: str, existingIds: Set[str]): bool =
  row.ownerId == ownerId and row.goalId != "" and row.title != "" and GoalPolicy::goalExists(row.goalStatus) and not(existingIds.contains(row.goalId))
pure def lawGoalHistoryStaysScoped(entries: List[GoalReviewEntry], ownerId: str, goalId: str): bool =
  checkinsFor(entries, ownerId, goalId).every(entry => entry.reviewOwner == ownerId and entry.reviewGoal == goalId)
pure val rowsValues = Set(List(), List({ ownerId: "owner", goalId: "goal-1", title: "Practice piano", goalStatus: GoalPolicy::GoalActive, goalReview: GoalPolicy::OnTrack }, { ownerId: "other", goalId: "goal-2", title: "Read books", goalStatus: GoalPolicy::GoalArchived, goalReview: GoalPolicy::ReviewIdle }))
pure val entriesValues = Set(List(), List({ reviewOwner: "owner", reviewGoal: "goal-1", recordedAt: 10, reviewText: "Practice logged" }, { reviewOwner: "other", reviewGoal: "goal-1", recordedAt: 15, reviewText: "Other owner" }))
```
