// scheduler.ts reconciles derived approval tasks against the owner-scoped queue.
// A dispatch already admitted while pending may finish concurrently with resolution.
module ApprovalFollowup {
  var s: { resolved: bool, processing: bool, checked: bool, held: bool, completed: bool, prompt: bool, sendsAfterCheck: int }
  action init = s' = { resolved: false, processing: false, checked: false, held: false, completed: false, prompt: true, sendsAfterCheck: 0 }
  action approve = all { not(s.resolved), s' = s.with("processing", true) }
  action preflightFailure = all { not(s.resolved), s' = s.with("processing", false) }
  action resolve = all { not(s.resolved), s' = s.with("resolved", true) }
  action read = all { not(s.completed), s' = s.with("checked", s.resolved).with("held", s.resolved or s.processing) }
  action readFailure = all { not(s.completed), s' = s.with("held", true) }
  action cleanup = all { s.checked, not(s.completed), s' = s.with("completed", true).with("prompt", false) }
  action cleanupFailure = all { s.checked, not(s.completed), s' = s.with("held", true) }
  action dispatch = all { not(s.held), not(s.completed), s' = s.with("sendsAfterCheck", if (s.checked) s.sendsAfterCheck + 1 else s.sendsAfterCheck) }
  action step = any { approve, preflightFailure, resolve, read, readFailure, cleanup, cleanupFailure, dispatch, s' = s }
  val ResolvedReadStopsDelivery = s.sendsAfterCheck == 0
  val CompletionRetiresPrompt = s.completed implies not(s.prompt)
  temporal EventuallyRetired = (read.weakFair(s) and cleanup.weakFair(s)) implies (s.resolved leadsTo s.completed)
}

// Two terminal, owner-bound approvals with a per-tick cleanup limit of one.
// Read/cleanup failures are covered by ApprovalFollowup; this case assumes success.
module ApprovalCleanupBudget {
  val tasks = Set(0, 1)
  var s: { phase: int, used: int, examined: Set[int], held: Set[int],
    completed: Set[int], prompts: Set[int], sent: Set[int] }
  action init = s' = { phase: 0, used: 0, examined: Set(), held: Set(),
    completed: Set(), prompts: tasks, sent: Set() }
  action reconcile = {
    nondet task = tasks.oneOf()
    val retire = not(s.completed.contains(task)) and s.used < 1
    all { s.phase == 0, not(s.examined.contains(task)),
      s' = s.with("examined", s.examined.union(Set(task)))
        .with("held", s.held.union(Set(task)))
        .with("used", if (retire) s.used + 1 else s.used)
        .with("completed", if (retire) s.completed.union(Set(task)) else s.completed)
        .with("prompts", if (retire) s.prompts.filter(id => id != task) else s.prompts) }
  }
  action finishReconcile = all { s.phase == 0, tasks.forall(task => s.examined.contains(task)),
    s' = s.with("phase", 1) }
  action dispatch = {
    nondet task = tasks.oneOf()
    all { s.phase == 1, not(s.completed.contains(task)), not(s.held.contains(task)),
      s' = s.with("sent", s.sent.union(Set(task))) }
  }
  action nextTick = all { s.phase == 1, s.completed != tasks,
    s' = s.with("phase", 0).with("used", 0).with("examined", Set()).with("held", Set()) }
  action step = any { reconcile, finishReconcile, dispatch, nextTick, s' = s }
  val CleanupBudgetRespected = s.used <= 1
  val DeferredApprovalHeld = s.phase == 1 implies
    tasks.forall(task => not(s.completed.contains(task)) implies s.held.contains(task))
  val NoDeferredDelivery = s.sent == Set()
  val PromptMatchesRetirement = tasks.forall(task => s.prompts.contains(task) == not(s.completed.contains(task)))
  temporal FairBudgetCleanup = (reconcile.weakFair(s) and finishReconcile.weakFair(s) and nextTick.weakFair(s)) implies eventually(s.completed == tasks)
}
