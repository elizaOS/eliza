// A consume owns its clear and rollback after its editor binding retires.
// flush waits for that work, and a failed retired receipt stays outstanding
// until a later successful write to the same key supersedes it.
module DraftConsumeHandoff {
  type State = {
    phase: int,
    sameKey: bool,
    event: str,
    saved: str,
    otherSaved: str,
    editor: str,
    rollbackFault: str,
    consume: str,
    flush: str,
    outstanding: bool,
    conflict: bool
  }
  var s: State
  action init = {
    nondet sameKey = Set(true, false).oneOf()
    s' = {
      phase: 0, sameKey: sameKey, event: "init", saved: "draft",
      otherSaved: "", editor: "draft", rollbackFault: "ok",
      consume: "not-started", flush: "not-started", outstanding: false,
      conflict: false
    }
  }
  action begin = all {
    s.phase == 0,
    s' = { ...s, phase: 1, event: "begin", consume: "pending", outstanding: true }
  }
  action rebind = all {
    s.phase == 1,
    s' = { ...s, phase: 2, event: "rebind", editor: if (s.sameKey) "draft" else "" }
  }
  action flush = all {
    s.phase == 2,
    s' = { ...s, phase: 3, event: "flush", flush: "pending" }
  }
  action finishClear = all {
    s.phase == 3,
    s' = { ...s, phase: 4, event: "finish-clear", saved: "" }
  }
  action finishRollback(fault: str): bool = all {
    s.phase == 4,
    s' = {
      ...s, phase: 5, event: "finish-rollback", rollbackFault: fault,
      saved: if (fault == "before") "" else "draft",
      consume: "rejected", flush: "rejected", conflict: s.sameKey
    }
  }
  action retry = all {
    s.phase == 5,
    s' = {
      ...s, phase: 6, event: "retry",
      conflict: s.sameKey
    }
  }
  action writeNew = all {
    s.phase == 6,
    s' = {
      ...s, phase: 7, event: "write-new", editor: "new", conflict: false,
      saved: if (s.sameKey) "new" else s.saved,
      otherSaved: if (s.sameKey) s.otherSaved else "new"
    }
  }
  action flushAgain = all {
    s.phase == 7,
    s' = {
      ...s, phase: 8, event: "flush-again",
      flush: if (s.sameKey) "fulfilled" else "rejected",
      outstanding: not(s.sameKey)
    }
  }
  action step = any {
    begin, rebind, flush, finishClear,
    { nondet fault = Set("ok", "before", "after").oneOf()
      finishRollback(fault) },
    retry, writeNew, flushAgain,
    all { s.phase == 8, s' = s }
  }
  val invariant = all {
    s.phase >= 0, s.phase <= 8,
    s.phase == 3 or s.phase == 4 implies s.flush == "pending" and s.consume == "pending",
    s.flush == "fulfilled" implies s.sameKey and s.saved == "new" and not(s.outstanding),
    s.phase >= 2 and s.phase < 7 implies s.editor == (if (s.sameKey) "draft" else ""),
    s.phase >= 5 implies s.consume == "rejected"
  }
}
