// Retired consume failures keep their own last text. Reopening exposes it for
// review, and a newer successful same-key CAS can retire the failed owner.
module DraftRetiredConsumeRecovery {
  type State = {
    phase: int,
    mode: str,
    typed: bool,
    early: bool,
    newerFirst: bool,
    rollbackAfter: bool,
    equalEditor: bool,
    editor: str,
    stored: str,
    offered: str,
    conflict: bool,
    error: bool,
    consuming: bool,
    consume: str,
    flush: str
  }
  var s: State
  pure def retained(value: State): str = if (value.typed) "edited" else "draft"
  pure def initialState(
    mode: str, typed: bool, early: bool, newerFirst: bool,
    rollbackAfter: bool, equalEditor: bool
  ): State = {
    phase: 0, mode: mode, typed: mode == "recover" and typed,
    early: early, newerFirst: newerFirst, rollbackAfter: rollbackAfter,
    equalEditor: mode == "recover" and rollbackAfter and equalEditor,
    editor: "draft", stored: "draft", offered: "", conflict: false,
    error: false, consuming: false, consume: "idle", flush: "idle"
  }
  action init = {
    nondet mode = Set("recover", "newer").oneOf()
    nondet typed = Set(true, false).oneOf()
    nondet early = Set(true, false).oneOf()
    nondet newerFirst = Set(true, false).oneOf()
    nondet rollbackAfter = Set(true, false).oneOf()
    nondet equalEditor = Set(true, false).oneOf()
    s' = initialState(mode, typed, early, newerFirst, rollbackAfter, equalEditor)
  }
  action matchingReopenInit = s' = initialState("recover", false, false, false, true, true)
  action begin = all {
    s.phase == 0,
    s' = { ...s, phase: 1, consuming: true, consume: "pending" }
  }
  action rebind = all {
    s.phase == 1,
    s' = {
      ...s, phase: 2, editor: if (s.mode == "newer") "newer" else "",
      consuming: false
    }
  }
  action firstCompletion = all {
    s.phase == 2,
    s' = {
      ...s, phase: 3,
      editor: if (s.mode == "recover" and s.early and s.equalEditor) retained(s) else s.editor,
      conflict: s.mode == "recover" and s.early and s.equalEditor,
      stored: if (s.mode == "newer" and s.newerFirst) "newer"
        else if (s.mode == "newer" and s.rollbackAfter) "draft" else "",
      consume: if (s.mode == "newer" and not(s.newerFirst)) "rejected" else s.consume
    }
  }
  action secondCompletion = all {
    s.phase == 3,
    s' = if (s.mode == "recover") {
      ...s, phase: 4, stored: if (s.rollbackAfter) retained(s) else "",
      editor: if (s.equalEditor) retained(s) else "",
      offered: retained(s), conflict: true,
      error: not(s.early and s.rollbackAfter), consume: "rejected"
    } else if (s.newerFirst) {
      ...s, phase: 4, consume: "rejected"
    } else {
      ...s, phase: 4, offered: s.stored, conflict: true, consume: "rejected"
    }
  }
  action recover = all {
    s.phase == 4,
    s' = {
      ...s, phase: 5,
      editor: if (s.mode == "recover") retained(s) else "newer",
      stored: if (s.mode == "recover") retained(s) else "newer",
      conflict: false, error: false
    }
  }
  action flush = all {
    s.phase == 5,
    s' = { ...s, phase: 6, flush: "fulfilled" }
  }
  action reopen = all {
    s.phase == 6,
    s' = { ...s, phase: 7, offered: "", flush: "idle" }
  }
  action flushAgain = all {
    s.phase == 7,
    s' = { ...s, phase: 8, flush: "fulfilled" }
  }
  action step = any {
    begin, rebind, firstCompletion, secondCompletion, recover,
    flush, reopen, flushAgain, all { s.phase == 8, s' = s }
  }
  val invariant = all {
    s.phase >= 0, s.phase <= 8,
    s.phase == 4 and s.mode == "recover" implies
      s.conflict and s.offered == retained(s),
    s.phase >= 5 implies s.editor == s.stored and not(s.conflict),
    s.phase >= 7 implies s.offered == "",
    s.flush == "fulfilled" implies s.phase >= 6 and not(s.consuming)
  }
  run matchingReopenStillConfirmsTest = matchingReopenInit.then(begin).then(rebind)
    .then(firstCompletion).then(secondCompletion)
    .expect(s.editor == "draft" and s.stored == "draft" and s.conflict)
    .then(recover).then(flush).then(reopen).then(flushAgain)
    .expect(s.flush == "fulfilled" and not(s.conflict) and invariant)

}
