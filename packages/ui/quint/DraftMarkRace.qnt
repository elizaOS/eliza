// One hold with a deferred mark write. Every change occurs after hold owns the
// send but before the durable mark acknowledges. No external dispatch occurs
// until the returned hold promise fulfills.
module DraftMarkRace {
  var s: {
    phase: int,
    change: str,
    markFault: str,
    postEdit: bool,
    editor: str,
    saved: str,
    marked: bool,
    otherSaved: str,
    held: bool,
    fulfilled: bool,
    conflict: bool,
    unsettled: bool
  }
  action init = {
    nondet change = Set("none", "edit", "retire", "same", "other", "authority", "external").oneOf()
    nondet markFault = Set("ok", "before", "after", "too-large").oneOf()
    nondet postEdit = Set(true, false).oneOf()
    s' = {
      phase: 0,
      change: change,
      markFault: markFault,
      postEdit: postEdit,
      editor: "draft",
      saved: "draft",
      marked: false,
      otherSaved: "",
      held: false,
      fulfilled: false,
      conflict: false,
      unsettled: false
    }
  }
  action beginHold = all {
    s.phase == 0,
    s' = {
      ...s,
      phase: 1,
      held: true
    }
  }
  action changeDuringMark = all {
    s.phase == 1,
    s' = {
      ...s,
      phase: 2,
      editor: if (s.change == "edit") "later"
      else if (Set("retire", "same", "other").contains(s.change)) ""
      else s.editor,
      saved: if (s.change == "external") "foreign" else s.saved
    }
  }
  action finishMark = {
    val external = s.change == "external"
    val failed = s.markFault != "ok" or external
    val persisted = not(external) and Set("ok", "after").contains(s.markFault)
    val fulfilled = not(failed) and s.change == "none"
    val cancelled = not(failed) and s.change != "none"
    val activeOriginal = not(Set("retire", "same", "other").contains(s.change))
    val conflict = failed and s.markFault != "too-large" and activeOriginal
    all {
      s.phase == 2,
      s' = {
        ...s,
        phase: 3,
        held: fulfilled,
        fulfilled: fulfilled,
        saved: if (cancelled and s.change == "edit") "later" else s.saved,
        marked: persisted and not(cancelled),
        conflict: conflict,
        unsettled: conflict and persisted
      }
    }
  }
  // A peer opened before the mark has a stale CAS receipt after the old binding
  // writes or unmarks it. Its next edit must surface a conflict, not overwrite.
  action editReopenedPeer = {
    val editing = s.postEdit and s.change == "same"
    val stale = Set("ok", "after").contains(s.markFault)
    all {
      s.phase == 3,
      s' = {
        ...s,
        phase: 4,
        editor: if (editing) "later" else s.editor,
        saved: if (editing and not(stale)) "later" else s.saved,
        marked: if (editing and not(stale)) false else s.marked,
        conflict: if (editing) stale else s.conflict,
        unsettled: if (editing) stale and s.marked else s.unsettled
      }
    }
  }
  action step = any {
    beginHold,
    changeDuringMark,
    finishMark,
    editReopenedPeer,
    all {
      s.phase == 4,
      s' = s
    }
  }
  val invariant = and {
    s.fulfilled implies (s.change == "none" and s.markFault == "ok"),
    s.unsettled implies (s.conflict and s.marked),
    (s.phase >= 3 and not(s.fulfilled)) implies not(s.held),
    s.otherSaved == "",
    (s.phase == 4 and s.postEdit and s.change == "same" and Set("ok", "after").contains(s.markFault))
    implies (s.conflict and s.saved == "draft")
  }
}
