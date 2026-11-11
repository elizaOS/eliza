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
