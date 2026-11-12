// load, restoreSaved, release and consume use restoreEditor to retain ownership
// through host completion. Applying and acknowledging are separate host events.
// The acknowledgement may arrive first, or fail after the host applied a change.
module DraftRestoreOwnership {
  type State = {
    mode: str,
    event: str,
    active: bool,
    authority: bool,
    editor: str,
    expected: str,
    target: str,
    saved: str,
    storageFault: str,
    marked: bool,
    unsettled: bool,
    guard: bool,
    applied: bool,
    acknowledged: bool,
    edited: bool,
    retired: bool,
    revoked: bool,
    keepTried: bool,
    holding: bool,
    consuming: bool,
    opening: bool,
    conflict: bool,
    error: bool,
    result: str
  }
  var s: State

  pure def initialState(mode: str, fault: str): State = {
    mode: mode, event: "init", active: true, authority: true,
    editor: if (mode == "review") "typed" else if (mode == "consume") "saved" else "",
    expected: if (mode == "review") "typed" else if (mode == "consume") "saved" else "",
    target: if (mode == "consume") "" else "saved",
    saved: if (mode == "consume") "" else "saved",
    storageFault: fault, marked: mode == "release", unsettled: false,
    guard: true, applied: false, acknowledged: false,
    edited: false, retired: false, revoked: false, keepTried: false,
    holding: mode == "release", consuming: mode == "consume",
    opening: mode == "open", conflict: mode == "review",
    error: false, result: "pending"
  }
  action initWithStorage(mode: str, fault: str): bool = s' = initialState(mode, fault)
  action initCase(mode: str): bool = s' = initialState(mode, "ok")
  action init = {
    nondet mode = Set("open", "review", "release", "consume").oneOf()
    nondet fault = Set("ok", "before", "after").oneOf()
    s' = initialState(mode, if (mode == "release") fault else "ok")
  }

  // Every host application checks the exact initial editor text and operation
  // guard. An expired completion cannot apply even when the text still matches.
  action apply = all {
    not(s.applied),
    s' = {
      ...s, event: "apply", applied: true,
      editor: if (s.guard and s.active and s.editor == s.expected and
        (s.mode != "consume" or s.authority)) s.target else s.editor
    }
  }

  action edit = all {
    not(s.acknowledged), s.active, not(s.edited),
    s' = { ...s, event: "edit", edited: true, editor: "new" }
  }
  action retire = all {
    not(s.acknowledged), s.active,
    s' = {
      ...s, event: "retire", active: false, retired: true,
      editor: "other", opening: true, conflict: false, error: false,
      consuming: false
    }
  }
  action tryKeep = all {
    s.mode == "review", s.active, not(s.acknowledged), not(s.keepTried),
    s' = { ...s, event: "keep", keepTried: true }
  }
  action revoke = all {
    s.mode == "consume", not(s.acknowledged), not(s.revoked),
    s' = { ...s, event: "revoke", authority: false, revoked: true }
  }

  pure def retained(editor: str): str =
    if (editor == "saved") "saved"
    else if (editor == "") "saved"
    else "saved+new"

  // Source work after host completion is awaited to a stable storage receipt.
  // Release persistence may fail before writing or lose its acknowledgement.
  // Consume storage failures are covered separately by DraftConsumeRollback.
  action acknowledge(failed: bool): bool = {
    val accepted = not(failed) and s.active and s.editor == s.target and
      (s.mode != "consume" or s.authority)
    val completed = {
      ...s, event: if (failed) "reject" else "acknowledge",
      guard: false, acknowledged: true, result: if (accepted) "fulfilled" else "rejected"
    }
    all {
      not(s.acknowledged),
      s' = if (s.mode == "open") {
        ...completed, result: "fulfilled",
        opening: if (s.active) false else s.opening,
        conflict: s.active and not(failed) and s.editor != "saved",
        error: s.active and failed
      } else if (s.mode == "review") {
        ...completed,
        conflict: s.active and not(accepted),
        error: s.active and failed,
        result: if (failed) "rejected" else "fulfilled"
      } else if (s.mode == "release") {
        ...completed, holding: false,
        saved: if (s.storageFault == "before" or not(s.active)) "saved"
          else if (accepted) s.target else retained(s.editor),
        marked: s.storageFault == "before",
        unsettled: s.active and accepted and s.storageFault == "before",
        conflict: s.active and (not(accepted) or s.storageFault != "ok"),
        result: if ((not(s.active) or accepted) and s.storageFault == "ok") "fulfilled" else "rejected"
      } else {
        ...completed, consuming: false,
        saved: if (accepted) "" else if (s.active and s.editor != "") s.editor
          else if (not(s.active) and s.edited) "new" else "saved",
        conflict: s.active and not(accepted)
      }
    }
  }

  action completion = any { acknowledge(false), acknowledge(true) }
  action progress = any { apply, completion }
  action step = any {
    progress, edit, retire, revoke, tryKeep,
    all { s.applied, s.acknowledged, s' = s }
  }

  val invariant = all {
    s.acknowledged implies not(s.guard),
    not(s.active) implies s.editor == "other",
    s.mode == "consume" and s.result == "fulfilled" implies
      s.active and s.authority and s.editor == "" and s.saved == "",
    s.mode == "release" and s.result != "pending" implies not(s.holding),
    s.mode == "release" implies s.saved != "",
    s.conflict implies s.active,
    s.mode == "consume" and s.result == "rejected" implies s.saved != ""
  }
  // A host which never calls or settles its callback may leave the operation
  // pending. Completion follows only under weak fairness of these host events.
  temporal Terminates = progress.weakFair(s) implies eventually(s.applied and s.acknowledged)

  run failedUnmarkRequiresReviewTest = initWithStorage("release", "before")
    .then(apply).then(acknowledge(false))
    .expect(s.marked and s.unsettled and s.conflict and not(s.holding))
  run lateReviewCannotApplyTest = initCase("review")
    .then(acknowledge(false)).then(apply)
    .expect(s.editor == "typed" and s.conflict and invariant)
  run typingBeforeConsumeClearTest = initCase("consume")
    .then(edit).then(apply).then(acknowledge(false))
    .expect(s.saved == "new" and s.editor == "new" and s.result == "rejected")
  run failedAfterConsumeClearTest = initCase("consume")
    .then(apply).then(acknowledge(true))
    .expect(s.saved == "saved" and s.editor == "" and s.conflict)
  run releaseAfterRetirementTest = initCase("release")
    .then(retire).then(apply).then(acknowledge(false))
    .expect(s.editor == "other" and s.saved == "saved" and not(s.holding))
}
