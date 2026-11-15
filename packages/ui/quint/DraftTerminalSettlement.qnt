// One marked send and one release racing a terminal callback. The host applies
// and acknowledges separately. The commit queue samples the editor on start.
module DraftTerminalSettlement {
  type State = {
    event: str, terminal: str, editor: str, saved: str, revision: int,
    held: bool, applied: bool, acknowledged: bool, joined: bool,
    releaseResult: str, commitResult: str
  }
  var s: State

  action init = s' = {
    event: "init", terminal: "none", editor: "", saved: "draft", revision: 2,
    held: true, applied: false, acknowledged: false, joined: false,
    releaseResult: "pending", commitResult: "none"
  }
  action join = all {
    s.held, not(s.joined),
    s' = { ...s, event: "join", joined: true }
  }
  action apply = all {
    not(s.applied),
    s' = { ...s, event: "apply", applied: true,
      editor: if (s.held and not(s.acknowledged)) "draft" else s.editor }
  }
  action terminal(outcome: str): bool = all {
    s.terminal == "none",
    s' = { ...s, event: outcome, terminal: outcome, held: false,
      commitResult: if (outcome == "abandon") "none"
        else if (s.held) "pending" else "fulfilled" }
  }
  action acknowledge(rejected: bool): bool = all {
    not(s.acknowledged),
    s' = { ...s, event: if (rejected) "reject" else "acknowledge",
      held: false, acknowledged: true,
      releaseResult: if (s.held and (rejected or s.editor != "draft")) "rejected" else "fulfilled",
      revision: if (s.held) 3 else s.revision }
  }
  action finishCommit = all {
    s.commitResult == "pending",
    s' = { ...s, event: "write", saved: s.editor, revision: 3, commitResult: "fulfilled" }
  }
  action completeRelease = any { acknowledge(false), acknowledge(true) }
  action idle = s' = s
  action step = any {
    join, apply, terminal("dispatch"), terminal("unknown"), terminal("abandon"),
    completeRelease, finishCommit, idle
  }

  val invariant = all {
    s.revision.in(Set(2, 3)),
    s.held implies (s.revision == 2 and s.releaseResult == "pending" and s.terminal == "none"),
    s.commitResult == "pending" implies (s.revision == 2 and not(s.held)),
    s.saved == "" implies (s.commitResult == "fulfilled" and s.revision == 3 and s.editor == ""),
    s.releaseResult == "rejected" implies (s.saved == "draft" and s.revision == 3)
  }
  temporal LateHostApplyCannotRestore = always((
    ((not(s.held) or s.acknowledged) and not(s.applied) and next(s.applied)) implies next(s.editor) == s.editor
  ).orKeep(s))
  temporal ReleaseSettles = (s.releaseResult == "pending").leadsTo(s.releaseResult != "pending")
  temporal FairSettlement = (completeRelease.weakFair(s) and finishCommit.weakFair(s)).implies(
    ReleaseSettles and (s.commitResult == "pending").leadsTo(s.commitResult == "fulfilled"))

  run unknownRetiresPendingReleaseTest = init.then(join).then(terminal("unknown"))
    .then(apply).then(acknowledge(true)).then(finishCommit)
    .expect(s.joined and s.releaseResult == "fulfilled" and s.saved == "" and invariant)
  run dispatchPreservesAlreadyAppliedEditorTest = init.then(apply).then(terminal("dispatch"))
    .then(finishCommit).then(acknowledge(false))
    .expect(s.releaseResult == "fulfilled" and s.editor == "draft" and s.saved == "draft" and invariant)
  run abandonKeepsMarkAndRevokesLateApplicationTest = init.then(terminal("abandon"))
    .then(acknowledge(false)).then(apply)
    .expect(s.releaseResult == "fulfilled" and s.editor == "" and s.revision == 2 and invariant)
  run commitAfterReleaseIsNoOpTest = init.then(apply).then(acknowledge(false)).then(terminal("dispatch"))
    .expect(s.releaseResult == "fulfilled" and s.commitResult == "fulfilled" and s.saved == "draft" and invariant)
  run acknowledgementWithoutApplyRequiresReviewTest = init.then(acknowledge(false)).then(apply)
    .expect(s.releaseResult == "rejected" and s.editor == "" and s.saved == "draft" and invariant)
}
