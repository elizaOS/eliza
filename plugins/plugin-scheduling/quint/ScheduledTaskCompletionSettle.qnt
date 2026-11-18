// runner.ts evaluateCompletion: the personal-assistant plugin runs two owner
// reply scans per message (handleScheduledTaskInboundMessage and
// completeFiredTasksOnOwnerReply). Both evaluate the same fired task whose
// completion check passes and whose pipeline.onComplete holds one child.
// A scan reads the row, leaves it when it is already settled, and otherwise
// commits `completed` only if the row is still the one it read. The commit
// records the completed log row and creates the onComplete child.
module ScheduledTaskCompletionSettle {
  pure val Scans = Set(1, 2)
  pure val Done = Set("completed", "raced", "terminal")
  var status: str
  var revision: int
  var phase: int -> str
  var seen: int -> int
  var readAt: int -> int
  var commitAt: int -> int
  var clock: int
  var children: int
  var completedLogs: int
  action init = all {
    status' = "fired", revision' = 0,
    phase' = Scans.mapBy(_ => "idle"),
    seen' = Scans.mapBy(_ => -1),
    readAt' = Scans.mapBy(_ => 0),
    commitAt' = Scans.mapBy(_ => 0),
    clock' = 0, children' = 0, completedLogs' = 0
  }
  action read(s: int): bool = all {
    phase.get(s) == "idle",
    phase' = phase.set(s, if (status == "completed") "terminal" else "read"),
    seen' = seen.set(s, revision),
    readAt' = readAt.set(s, clock + 1),
    clock' = clock + 1,
    status' = status, revision' = revision, commitAt' = commitAt,
    children' = children, completedLogs' = completedLogs
  }
  action commit(s: int): bool = {
    val wins = seen.get(s) == revision
    all {
      phase.get(s) == "read",
      phase' = phase.set(s, if (wins) "completed" else "raced"),
      status' = if (wins) "completed" else status,
      revision' = if (wins) revision + 1 else revision,
      children' = if (wins) children + 1 else children,
      completedLogs' = if (wins) completedLogs + 1 else completedLogs,
      commitAt' = commitAt.set(s, clock + 1),
      clock' = clock + 1,
      seen' = seen, readAt' = readAt
    }
  }
  action settled = all {
    Scans.forall(s => Done.contains(phase.get(s))),
    status' = status, revision' = revision, phase' = phase, seen' = seen,
    readAt' = readAt, commitAt' = commitAt, clock' = clock,
    children' = children, completedLogs' = completedLogs
  }
  // A paused scan may stutter while its owner or store has not settled.
  action stutter = all {
    status' = status, revision' = revision, phase' = phase, seen' = seen,
    readAt' = readAt, commitAt' = commitAt, clock' = clock,
    children' = children, completedLogs' = completedLogs
  }
  action step = any { read(1), read(2), commit(1), commit(2), settled, stutter }
  val ModelState = {
    status: status, revision: revision, phase: phase, seen: seen,
    readAt: readAt, commitAt: commitAt, clock: clock,
    children: children, completedLogs: completedLogs
  }
  temporal ScansFinishWithoutFairness = Scans.forall(s =>
    (not(Done.contains(phase.get(s)))).leadsTo(Done.contains(phase.get(s))))
  temporal ScansFinish = Scans.forall(s =>
    read(s).weakFair(ModelState) and commit(s).weakFair(ModelState))
      .implies(ScansFinishWithoutFairness)
  val SettleAtMostOnce = children <= 1 and completedLogs <= 1
  val OneWinner = Scans.filter(s => phase.get(s) == "completed").size() <= 1
  val ChildrenFollowWinner =
    children == Scans.filter(s => phase.get(s) == "completed").size() and
    completedLogs == children
  val CompletedRowSettledOnce = (status == "completed") == (children == 1)
  val TerminalReadSawSettledRow =
    Scans.forall(s => phase.get(s) == "terminal" implies
      Scans.exists(o => o != s and commitAt.get(o) > 0 and commitAt.get(o) < readAt.get(s)))
  val TypeOK =
    Set("fired", "completed").contains(status) and
    Scans.forall(s => Set("idle", "read", "completed", "raced", "terminal").contains(phase.get(s))) and
    revision >= 0 and revision <= 1 and clock <= 4
}
