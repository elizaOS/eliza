// durable-draft-controller.ts load/open: three factory/read attempts, with
// the exact 150ms and 600ms retry gates. A successful factory still completes
// its read after retirement, but retired work cannot publish or restore.
module DraftOpenRecovery {
  type State = {
    event: str,
    phase: str,
    attempt: int,
    factoryFailures: Set[int],
    readFailures: Set[int],
    initial: str,
    marked: bool,
    factoryCalls: int,
    readCalls: int,
    retryMs: int,
    beforeDeadline: bool,
    active: bool,
    editor: str,
    edited: bool,
    joined: bool,
    opening: bool,
    ready: bool,
    failed: bool,
    conflict: bool,
    unsettled: bool
  }
  var s: State

  action initCase(text: str, marked: bool, factoryFailures: Set[int], readFailures: Set[int]): bool =
    s' = {
      event: "init", phase: "factory", attempt: 0,
      factoryFailures: factoryFailures, readFailures: readFailures,
      initial: text, marked: marked, factoryCalls: 1, readCalls: 0,
      retryMs: 0, beforeDeadline: false, active: true, editor: text,
      edited: false, joined: false, opening: true, ready: false,
      failed: false, conflict: false, unsettled: false
    }

  action init = {
    nondet text = Set("", "saved", "typed").oneOf()
    nondet marked = Set(true, false).oneOf()
    nondet factoryFailures = Set(0, 1, 2).powerset().oneOf()
    nondet readFailures = Set(0, 1, 2).powerset().oneOf()
    initCase(text, marked, factoryFailures, readFailures)
  }

  def failedAttempt(previous: State): State =
    if (not(previous.active)) { ...previous, phase: "done" }
    else if (previous.attempt < 2) {
      ...previous,
      phase: "delay",
      retryMs: if (previous.attempt == 0) 150 else 600,
      beforeDeadline: false
    } else {
      ...previous, phase: "done", opening: false, failed: true
    }

  action finishFactory = all {
    s.phase == "factory",
    s' = if (s.factoryFailures.contains(s.attempt))
      { ...failedAttempt(s), event: "factory-failed" }
    else
      { ...s, event: "factory-opened", phase: "read", readCalls: s.readCalls + 1 }
  }

  action finishRead = {
    val conflict = s.marked or s.editor != "saved"
    val preserveEditor = s.initial != "" or s.editor != s.initial
    all {
      s.phase == "read",
      s' = if (s.readFailures.contains(s.attempt))
        { ...failedAttempt(s), event: "read-failed" }
      else if (not(s.active))
        { ...s, event: "read-opened", phase: "done" }
      else if (preserveEditor or s.marked) {
        ...s, event: "read-opened", phase: "done", opening: false,
        ready: true, failed: conflict, conflict: conflict,
        unsettled: conflict and s.marked
      } else {
        ...s, event: "read-opened", phase: "done", opening: false,
        ready: true, editor: "saved"
      }
    }
  }

  action waitBeforeDeadline = all {
    s.phase == "delay", not(s.beforeDeadline),
    s' = { ...s, event: "before-deadline", beforeDeadline: true }
  }

  action fireRetry = all {
    s.phase == "delay",
    s' = if (s.active) {
      ...s, event: "retry", phase: "factory", attempt: s.attempt + 1,
      factoryCalls: s.factoryCalls + 1, retryMs: 0, beforeDeadline: false
    } else {
      ...s, event: "retry", phase: "done", retryMs: 0, beforeDeadline: false
    }
  }

  action edit = all {
    s.phase != "done", s.active, not(s.edited),
    s' = { ...s, event: "edit", editor: "typed", edited: true }
  }

  action join = all {
    s.phase != "done", s.active, not(s.joined),
    s' = { ...s, event: "join", joined: true }
  }

  action retire = all {
    s.phase != "done", s.active,
    s' = { ...s, event: "retire", active: false, editor: "other",
      opening: true, ready: false, failed: false, conflict: false,
      unsettled: false }
  }

  action progress = any { finishFactory, finishRead, fireRetry }
  action step = any {
    progress, waitBeforeDeadline, edit, join, retire,
    all { s.phase == "done", s' = s }
  }

  val invariant = all {
    s.attempt >= 0, s.attempt <= 2,
    s.factoryCalls == s.attempt + 1,
    s.readCalls >= 0, s.readCalls <= s.factoryCalls,
    s.retryMs.in(Set(0, 150, 600)),
    not(s.active) implies s.editor == "other",
    s.conflict implies s.active and s.ready and s.failed and not(s.opening),
    s.unsettled implies s.conflict and s.marked,
    s.failed implies not(s.opening)
  }
  // The host must eventually resolve/reject each store call and fire each
  // scheduled retry. No fairness is assumed for editor/retirement actions.
  temporal Terminates = progress.weakFair(s) implies eventually(s.phase == "done")

  run transientReadRetriesTest = initCase("", false, Set(), Set(0))
    .then(finishFactory).then(finishRead).then(waitBeforeDeadline)
    .expect(s.factoryCalls == 1 and s.retryMs == 150)
    .then(fireRetry).then(finishFactory).then(finishRead)
    .expect(s.editor == "saved" and s.factoryCalls == 2 and invariant)
  run exhaustedFactoryReportsFailureTest = initCase("typed", false, Set(0, 1, 2), Set())
    .then(finishFactory).then(fireRetry).then(finishFactory)
    .expect(s.retryMs == 600).then(fireRetry).then(finishFactory)
    .expect(s.phase == "done" and s.failed and s.editor == "typed")
  run retirementStopsRetryTest = initCase("", false, Set(0), Set())
    .then(finishFactory).then(retire).then(fireRetry)
    .expect(s.factoryCalls == 1 and s.editor == "other" and invariant)
}
