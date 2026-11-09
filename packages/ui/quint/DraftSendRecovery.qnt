// The symbolic text draft+later denotes the exact string draft, newline, later.
// One admitted send, one optional binding handoff and one controller restart.
// Store calls settle before the next public action in this case. The separate
// mark-race case covers changes while hold's mark write is still awaiting.
module DraftSendRecovery {
  type State = {
    phase: int,
    markFault: str,
    route: str,
    settlement: str,
    typed: bool,
    clearFault: str,
    review: str,
    editor: str,
    saved: str,
    marked: bool,
    otherSaved: str,
    held: bool,
    admitted: bool,
    conflict: bool,
    unsettled: bool,
    error: bool,
    restoredAutomatically: bool,
    restartWasMarked: bool
  }
  var s: State
  action init = {
    nondet markFault = Set("ok", "before", "after", "too-large").oneOf()
    nondet route = Set("same", "other", "none").oneOf()
    nondet settlement = Set("release", "dispatch", "unknown", "abandon").oneOf()
    nondet typed = Set(true, false).oneOf()
    nondet clearFault = Set("ok", "before", "after").oneOf()
    nondet review = Set("none", "restore", "discard").oneOf()
    s' = {
      phase: 0,
      markFault: markFault,
      route: route,
      settlement: settlement,
      typed: typed,
      clearFault: clearFault,
      review: review,
      editor: "draft",
      saved: "draft",
      marked: false,
      otherSaved: "",
      held: false,
      admitted: false,
      conflict: false,
      unsettled: false,
      error: false,
      restoredAutomatically: false,
      restartWasMarked: false
    }
  }
  // hold waits for the mark. A write which persisted before rejecting remains
  // a reviewable marked row; no rejection admits an external dispatch.
  action hold = all {
    s.phase == 0,
    s' = {
      ...s,
      phase: 1,
      marked: Set("ok", "after").contains(s.markFault),
      held: s.markFault == "ok",
      admitted: s.markFault == "ok",
      conflict: Set("before", "after").contains(s.markFault),
      unsettled: s.markFault == "after"
    }
  }
  // The caller clears its composer only after hold fulfilled. The controller's
  // edit method retains the in-flight marked row while this binding holds it.
  action clearComposer = all {
    s.phase == 1,
    s' = {
      ...s,
      phase: 2,
      editor: if (s.held) "" else s.editor
    }
  }
  // A new Binding instance can be a peer of the same conversation, or a
  // different owner/agent/conversation identity. The host clears on identity change.
  action reopen = all {
    s.phase == 2,
    s' = {
      ...s,
      phase: 3
    }
  }
  // A peer binding saves new typing immediately. The original binding keeps
  // typing in memory until its held send settles.
  action typeDuringSend = {
    val typed = s.held and s.typed
    val peerWrite = typed and s.route == "same"
    all {
      s.phase == 3,
      s' = {
        ...s,
        phase: 4,
        editor: if (typed) "later" else s.editor,
        saved: if (peerWrite) "later" else s.saved,
        marked: if (peerWrite) false else s.marked,
        otherSaved: if (typed and s.route == "other") "later" else s.otherSaved
      }
    }
  }
  // The old binding's CAS receipt is stale after a peer saved new typing.
  // commit catches that failure and leaves the peer's newer row intact.
  action settle = {
    val releaseHere = s.settlement == "release" and s.route != "other"
    val committing = Set("dispatch", "unknown").contains(s.settlement)
    val staleReceipt = s.route == "same" and s.typed
    val clearWrites = committing and not(staleReceipt) and s.clearFault != "before"
    val remaining = if (s.route == "none" and s.typed) "later" else ""
    val released = if (s.typed) "draft+later" else "draft"
    val clearFailed = committing and (staleReceipt or s.clearFault != "ok")
    all {
      s.phase == 4,
      s' = if (not(s.held)) {
        ...s,
        phase: 5
      } else {
        ...s,
        phase: 5,
        held: false,
        editor: if (releaseHere) released else s.editor,
        saved: if (s.settlement == "release")
        (if (releaseHere) released else s.saved)
        else if (clearWrites) remaining else s.saved,
        marked: if (s.settlement == "release" or clearWrites) false else s.marked,
        error: clearFailed and s.route == "none"
      }
    }
  }
  // A fresh controller sees durable state only. A marked row is offered for
  // review and is never silently restored as an ordinary draft.
  action restart = all {
    s.phase == 5,
    s' = {
      ...s,
      phase: 6,
      held: false,
      editor: if (s.marked) "" else s.saved,
      conflict: s.marked,
      unsettled: s.marked,
      error: false,
      restoredAutomatically: not(s.marked) and s.saved != "",
      restartWasMarked: s.marked
    }
  }
  // Only an explicit review choice may unmark an interrupted send.
  action review = {
    val resolving = s.unsettled and s.review != "none"
    val restored = s.review == "restore"
    all {
      s.phase == 6,
      s' = {
        ...s,
        phase: 7,
        saved: if (resolving and not(restored)) "" else s.saved,
        editor: if (resolving and restored) s.saved else s.editor,
        marked: if (resolving) false else s.marked,
        conflict: if (resolving) false else s.conflict,
        unsettled: if (resolving) false else s.unsettled
      }
    }
  }
  action nextStep = any {
    hold,
    clearComposer,
    reopen,
    typeDuringSend,
    settle,
    restart,
    review,
    all {
      s.phase == 7,
      s' = s
    }
  }
  action step = nextStep
  val AdmissionNeedsConfirmedMark = s.admitted implies s.markFault == "ok"
  val NoCrossBindingDraft = s.otherSaved == "" or s.otherSaved == "later"
  val NoAutomaticReplay = s.restartWasMarked implies not(s.restoredAutomatically)
  val UnknownOutcomeSafe =
  (s.phase == 6 and s.admitted and s.settlement == "unknown") implies
  (s.editor != "draft" and (s.saved != "draft" or s.marked))
  val invariant = and {
    AdmissionNeedsConfirmedMark,
    NoCrossBindingDraft,
    NoAutomaticReplay,
    UnknownOutcomeSafe,
    s.unsettled implies s.conflict,
    (s.phase >= 5) implies not(s.held)
  }
}
