// RuntimePipelineHooks captures the current phase before it awaits any handler.
module PipelineHookSnapshotModel {
  const Parallel: bool
  val Calls = Set("first", "second")
  val Targets = Set("original", "replacement")
  val Registry = Set("mutator", "original", "removable", "reader-a", "reader-b")
  type Dispatch = {
    status: str, captured: Set[str], started: Set[str], done: Set[str],
    group: int, diagnostic: bool, refusedBy: Set[str]
  }
  var s: { registry: Set[str], calls: str -> Dispatch }

  val emptyDispatch = { status: "idle", captured: Set(), started: Set(),
    done: Set(), group: 0, diagnostic: false, refusedBy: Set() }
  action init = s' = { registry: Registry, calls: Calls.mapBy(_ => emptyDispatch) }
  action replaceHook = all {
    s.registry.contains("original"),
    s' = { ...s, registry: s.registry.exclude(Set("original")).union(Set("replacement")) },
  }
  action removeHook = all {
    s.registry.contains("removable"),
    s' = { ...s, registry: s.registry.exclude(Set("removable")) },
  }
  action admit(call: str): bool = all {
    s.calls.get(call).status == "idle",
    s' = { ...s, calls: s.calls.set(call, { ...emptyDispatch,
      status: "running", captured: s.registry }) },
  }

  pure def groups(captured: Set[str]): List[Set[str]] =
    if (Parallel) List(captured)
    else List(Set("mutator"), Targets.intersect(captured),
      Set("removable").intersect(captured), Set("reader-a", "reader-b"))

  action launchGroup(call: str): bool = {
    val dispatch = s.calls.get(call)
    val selected = groups(dispatch.captured)
    all {
      dispatch.status == "running",
      dispatch.started == dispatch.done,
      dispatch.group < selected.length(),
      s' = { ...s, calls: s.calls.set(call, { ...dispatch,
        started: dispatch.started.union(selected[dispatch.group]),
        group: dispatch.group + 1 }) },
    }
  }
  action finishHook(call: str, hook: str, outcome: str): bool = {
    val dispatch = s.calls.get(call)
    all {
      dispatch.status == "running",
      dispatch.started.exclude(dispatch.done).contains(hook),
      outcome == "ok" or Targets.contains(hook),
      (outcome == "refused").implies(not(Parallel)),
      s' = { ...s, calls: s.calls.set(call, { ...dispatch,
        done: dispatch.done.union(Set(hook)),
        diagnostic: dispatch.diagnostic or outcome == "diagnostic",
        status: if (outcome == "refused") "rejected" else "running",
        refusedBy: if (outcome == "refused") Set(hook) else Set() }) },
    }
  }
  action settle(call: str): bool = {
    val dispatch = s.calls.get(call)
    all {
      dispatch.status == "running",
      dispatch.group == groups(dispatch.captured).length(),
      dispatch.started == dispatch.done,
      s' = { ...s, calls: s.calls.set(call, { ...dispatch, status: "fulfilled" }) },
    }
  }
  action progress(call: str): bool = any {
    launchGroup(call), settle(call),
    {
      nondet hook = Registry.union(Targets).oneOf()
      nondet outcome = Set("ok", "diagnostic", "refused").oneOf()
      finishHook(call, hook, outcome)
    },
  }
  action step = any {
    replaceHook, removeHook, s' = s,
    { nondet call = Calls.oneOf() any { admit(call), progress(call) } },
  }

  val StartsOnlyCaptured = Calls.forall(call => {
    val dispatch = s.calls.get(call)
    dispatch.done.subseteq(dispatch.started) and dispatch.started.subseteq(dispatch.captured)
  })
  val GroupsWaitForCompletion = Calls.forall(call => {
    val dispatch = s.calls.get(call)
    val selected = groups(dispatch.captured)
    0.to(selected.length() - 1).forall(group => and {
      (group + 1 < dispatch.group).implies(selected[group].subseteq(dispatch.done)),
      (group >= dispatch.group).implies(selected[group].intersect(dispatch.started) == Set()),
    })
  })
  val HonestSettlement = Calls.forall(call => {
    val dispatch = s.calls.get(call)
    and {
      (dispatch.status == "fulfilled").implies(dispatch.done == dispatch.captured),
      (dispatch.status == "rejected") == (dispatch.refusedBy.size() == 1),
      dispatch.refusedBy.subseteq(Targets.intersect(dispatch.done)),
      (dispatch.status == "rejected").implies(not(Parallel)
        and not(dispatch.started.contains("reader-a")) and not(dispatch.started.contains("reader-b"))),
      dispatch.diagnostic.implies(dispatch.refusedBy == Set()
        and Targets.intersect(dispatch.done).size() == 1),
    }
  })
  temporal SnapshotSelection = always(Calls.forall(call => and {
    (s.calls.get(call).status == "idle" and next(s.calls.get(call).status) != "idle")
      .implies(next(s.calls.get(call).captured) == s.registry),
    (s.calls.get(call).status != "idle")
      .implies(next(s.calls.get(call).captured) == s.calls.get(call).captured),
  }).orKeep(s))
  temporal UnfairDispatchSettles = Calls.forall(call =>
    (s.calls.get(call).status == "running")
      .leadsTo(Set("fulfilled", "rejected").contains(s.calls.get(call).status)))
  temporal DispatchSettles = Calls.forall(call => progress(call).weakFair(s))
    .implies(UnfairDispatchSettles)
}

module PipelineHookSnapshot {
  import PipelineHookSnapshotModel(Parallel = false).*

  run heldDispatchRetainsOldHandlersTest = init.then(admit("first"))
    .then(launchGroup("first")).then(removeHook).then(replaceHook)
    .then(admit("second")).then(launchGroup("second"))
    .then(finishHook("second", "mutator", "ok")).then(launchGroup("second"))
    .then(finishHook("second", "replacement", "ok"))
    .then(launchGroup("second")).then(launchGroup("second"))
    .then(finishHook("second", "reader-a", "ok")).then(finishHook("second", "reader-b", "ok"))
    .then(settle("second"))
    .expect(s.calls.get("first").started == Set("mutator")
      and not(s.calls.get("second").captured.contains("removable")))
    .then(finishHook("first", "mutator", "ok")).then(launchGroup("first"))
    .then(finishHook("first", "original", "diagnostic")).then(launchGroup("first"))
    .then(finishHook("first", "removable", "ok")).then(launchGroup("first"))
    .then(finishHook("first", "reader-b", "ok")).then(finishHook("first", "reader-a", "ok"))
    .then(settle("first"))
    .expect(s.calls.get("first").status == "fulfilled" and s.calls.get("first").diagnostic)

  run localAdmissionRefusalStopsDispatchTest = init.then(admit("first"))
    .then(launchGroup("first")).then(finishHook("first", "mutator", "ok"))
    .then(launchGroup("first")).then(finishHook("first", "original", "refused"))
    .expect(s.calls.get("first").status == "rejected"
      and s.calls.get("first").started == Set("mutator", "original"))
}

module PipelineHookSnapshotParallel {
  import PipelineHookSnapshotModel(Parallel = true).*

  run concurrentHooksSettleIndependentlyTest = init.then(admit("first"))
    .then(launchGroup("first")).then(finishHook("first", "reader-b", "ok"))
    .then(finishHook("first", "original", "diagnostic"))
    .expect(s.calls.get("first").started == Registry
      and s.calls.get("first").done == Set("reader-b", "original")
      and s.calls.get("first").status == "running")
}
