// The repository commits the live-row swap or rolls back its demotion.
// Deployment DELETE can interleave between the rollback service's read and swap.
// The parent app stays present and matches the authorized organization.
// frontend_publication covers a foreign organization. app_frontend_deletion
// covers serialization with whole-app deletion under the same parent lock.
module FrontendActivationSwap {
  type State = { current: str, target: str, activate: str, delete: str }
  var s: State

  action init = s' = {
    current: "active", target: "superseded", activate: "idle", delete: "idle"
  }

  action readActivation = all {
    s.activate == "idle",
    s' = { ...s, activate: if (s.target == "missing") "rejected" else "read" }
  }
  action readDeletion = all {
    s.delete == "idle",
    s' = { ...s, delete: if (s.target == "superseded") "read" else "rejected" }
  }

  action finishActivation = all {
    s.activate == "read",
    if (s.target == "missing")
      s' = { ...s, activate: "rejected" }
    else
      s' = { ...s, current: "superseded", target: "active", activate: "committed" }
  }
  action finishDeletion = all {
    s.delete == "read",
    if (s.target == "active")
      s' = { ...s, delete: "rejected" }
    else
      s' = { ...s, target: "missing", delete: "committed" }
  }

  action step = any {
    readActivation, readDeletion, finishActivation, finishDeletion, s' = s
  }

  val ExactlyOneLive = (s.current == "active") != (s.target == "active")
  val CommittedEffectMatchesReceipt = all {
    (s.target == "active") == (s.activate == "committed"),
    (s.target == "missing") == (s.delete == "committed")
  }

  temporal RejectedWritesKeepLiveRow = always((
    (
      (s.activate == "read" and next(s.activate) == "rejected") or
      (s.delete == "read" and next(s.delete) == "rejected")
    ).implies(next(s.current) == s.current and next(s.target) == s.target)
  ).orKeep(s))
  temporal ReadsFinish = always(
    (s.activate == "read").implies(eventually(s.activate != "read")) and
    (s.delete == "read").implies(eventually(s.delete != "read"))
  )
  temporal FairReadsFinish =
    (finishActivation.weakFair(s) and finishDeletion.weakFair(s)).implies(ReadsFinish)

  run activationBeatsStaleDeleteTest = init.then(readDeletion).then(readActivation)
    .then(finishActivation).then(finishDeletion)
    .expect(s.target == "active" and s.delete == "rejected")
  run deletionBeatsStaleRollbackTest = init.then(readActivation).then(readDeletion)
    .then(finishDeletion).then(finishActivation)
    .expect(s.current == "active" and s.target == "missing" and s.activate == "rejected")
}
