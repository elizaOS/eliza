// consume preflight, clear receipt, rollback of exactly that receipt, and review.
// The real host restore is synchronous here. Async ownership has its own model.
module DraftConsumeRollback {
  type State = {
    phase: int,
    event: str,
    active: bool,
    authority: bool,
    editor: str,
    saved: str,
    revision: int,
    receipt: int,
    mutation: str,
    clearFault: str,
    rollbackFault: str,
    rollbackText: str,
    readFailure: bool,
    consuming: bool,
    conflict: bool,
    error: bool,
    result: str
  }
  var s: State
  action init = s' = {
    phase: 0, event: "init", active: true, authority: true,
    editor: "saved", saved: "saved", revision: 0, receipt: 0,
    mutation: "none", clearFault: "ok", rollbackFault: "ok",
    rollbackText: "", readFailure: false,
    consuming: false, conflict: false, error: false, result: "not-started"
  }
  action begin = all {
    s.phase == 0,
    s' = { ...s, phase: 1, event: "begin", consuming: true, result: "pending" }
  }
  action interleave(mutation: str): bool = all {
    s.phase == 1,
    s' = {
      ...s, phase: 2, event: "interleave", mutation: mutation,
      editor: if (mutation == "edit") "new" else if (mutation == "retire") "other" else s.editor,
      active: mutation != "retire", authority: mutation != "revoke",
      consuming: mutation != "retire",
      saved: if (mutation == "external") "external" else s.saved,
      revision: if (mutation == "external") 1 else s.revision
    }
  }
  pure def refused(previous: State, readFailure: bool): State = {
    ...previous, phase: 5, consuming: false, result: "rejected",
    readFailure: readFailure,
    conflict: previous.active and not(readFailure),
    error: previous.active and readFailure
  }
  action finishClear(fault: str, readFailure: bool): bool = {
    val failed = fault == "before" or s.receipt != s.revision
    val wrote = not(failed)
    val afterWrite = {
      ...s, clearFault: fault, event: "finish-clear", readFailure: readFailure,
      saved: if (wrote) "" else s.saved,
      revision: if (wrote) s.revision + 1 else s.revision,
      receipt: if (wrote and fault != "after") s.revision + 1 else s.receipt
    }
    all {
      s.phase == 2,
      s' = if (failed or fault == "after") refused(afterWrite, readFailure)
      else if (not(s.active) or not(s.authority) or s.editor != "saved") {
        ...afterWrite, phase: 3, rollbackText: if (s.active) s.editor else "saved"
      } else {
        ...afterWrite, phase: 5, editor: "", consuming: false, result: "fulfilled"
      }
    }
  }
  action interleaveRollback(external: bool): bool = all {
    s.phase == 3,
    s' = {
      ...s, phase: 4, event: if (external) "external-rollback" else "wait-rollback",
      saved: if (external) "external" else s.saved,
      revision: if (external) s.revision + 1 else s.revision
    }
  }
  action finishRollback(fault: str): bool = {
    val wrote = fault != "before" and s.receipt == s.revision
    val afterWrite = {
      ...s, event: "finish-rollback", rollbackFault: fault,
      saved: if (wrote) s.rollbackText else s.saved,
      revision: if (wrote) s.revision + 1 else s.revision,
      receipt: if (wrote and fault != "after") s.revision + 1 else s.receipt
    }
    all { s.phase == 4, s' = refused(afterWrite, s.readFailure) }
  }
  action step = any {
    begin,
    { nondet mutation = Set("none", "edit", "retire", "revoke", "external").oneOf()
      interleave(mutation) },
    { nondet fault = Set("ok", "before", "after").oneOf()
      nondet readFailure = Set(true, false).oneOf()
      finishClear(fault, readFailure) },
    { nondet external = Set(true, false).oneOf()
      interleaveRollback(external) },
    { nondet fault = Set("ok", "before", "after").oneOf()
      finishRollback(fault) },
    all { s.phase == 5, s' = s }
  }
  val invariant = all {
    s.phase >= 0, s.phase <= 5,
    s.revision >= 0, s.revision <= 3,
    s.receipt >= 0, s.receipt <= s.revision,
    s.result == "fulfilled" implies s.active and s.authority and s.editor == "" and s.saved == "",
    s.phase == 5 implies not(s.consuming),
    s.conflict implies s.active and s.result == "rejected" and not(s.error),
    not(s.active) implies s.editor == "other"
  }
  run rollbackUsesClearReceiptTest = init.then(begin).then(interleave("edit"))
    .then(finishClear("ok", false)).then(interleaveRollback(true))
    .then(finishRollback("ok"))
    .expect(s.saved == "external" and s.editor == "new" and s.conflict and invariant)
  run failedRollbackKeepsTypedCopyTest = init.then(begin).then(interleave("edit"))
    .then(finishClear("ok", false)).then(interleaveRollback(false))
    .then(finishRollback("before"))
    .expect(s.saved == "" and s.editor == "new" and s.conflict)
  run lostClearAcknowledgementDoesNotAdmitEffectTest = init.then(begin)
    .then(interleave("none")).then(finishClear("after", false))
    .expect(s.saved == "" and s.editor == "saved" and s.result == "rejected")
}
