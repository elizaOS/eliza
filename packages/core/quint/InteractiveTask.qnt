// src/messaging/interactive-task.ts, transitionInteractiveTask.
// The finite graph is compared with the implementation in the existing
// interactive-task-conformance test. Context refusals are exercised there.
module InteractiveTask {
  pure val Ops = Set("op1", "op2")
  pure val Origins = Set("A", "B")
  pure val OpStates = Set("none", "prepared", "dispatched", "succeeded", "failed", "cancelled", "unknown")
  pure val Statuses = Set("active", "paused", "blocked", "waiting", "completed", "cancelled")
  type State = {
    status: str, auth: str, obs: str, op: str -> str,
    scopeB: bool, extended: bool
  }
  var s: State

  pure def unresolved(status: str): bool =
    Set("prepared", "dispatched", "unknown").contains(status)

  pure def firstUnresolved(state: State): str =
    if (unresolved(state.op.get("op1"))) "op1"
    else if (unresolved(state.op.get("op2"))) "op2"
    else "none"

  pure def ended(state: State): bool =
    Set("completed", "cancelled").contains(state.status)

  pure def cancelPrepared(state: State): str -> str = {
    val operation = firstUnresolved(state)
    if (operation != "none" and state.op.get(operation) == "prepared")
      state.op.set(operation, "cancelled")
    else state.op
  }

  pure val initialState = {
    status: "active", auth: "active", obs: "none",
    op: Ops.mapBy(operation => "none"), scopeB: false, extended: false
  }
  action init = s' = initialState

  // Pure successors also drive exhaustive graph extraction.
  pure def observe(state: State, origin: str, resume: bool): Set[State] = {
    val operation = firstUnresolved(state)
    if (and {
      not(ended(state)), state.auth == "active",
      resume implies state.status == "paused",
      operation != "none" implies state.op.get(operation) == "prepared",
      origin == "B" implies state.scopeB
    }) Set({...state, op: cancelPrepared(state), obs: origin,
      status: if (resume) "active" else state.status})
    else Set()
  }

  pure def extend(state: State): Set[State] = {
    val operation = firstUnresolved(state)
    if (and {
      not(ended(state)), state.auth == "active", not(state.scopeB),
      operation != "none" implies state.op.get(operation) == "prepared"
    }) Set({...state, op: cancelPrepared(state), obs: "none", scopeB: true, extended: true})
    else Set()
  }

  pure def retract(state: State): Set[State] = {
    val operation = firstUnresolved(state)
    val dispatched = operation != "none" and state.op.get(operation) == "dispatched"
    if (state.scopeB) Set({...state,
      op: if (dispatched) state.op.set(operation, "unknown") else cancelPrepared(state),
      status: if (dispatched) "paused" else state.status,
      obs: "none", scopeB: false})
    else Set()
  }

  pure def interrupt(state: State, kind: str): Set[State] = {
    val operation = firstUnresolved(state)
    if (Set("pause", "cancel").contains(kind) implies not(ended(state))) Set({...state,
      op: if (operation != "none" and state.op.get(operation) == "dispatched")
        state.op.set(operation, "unknown") else cancelPrepared(state),
      auth: if (kind == "revoke") "revoked" else state.auth,
      status: if (ended(state)) state.status
        else if (kind == "cancel") "cancelled" else "paused"})
    else Set()
  }

  pure def prepare(state: State, operation: str): Set[State] =
    if (and {
      state.status == "active", state.auth == "active", state.obs != "none",
      firstUnresolved(state) == "none", state.op.get(operation) == "none"
    }) Set({...state, op: state.op.set(operation, "prepared")})
    else Set()

  pure def dispatch(state: State, operation: str): Set[State] =
    if (and {
      not(ended(state)), firstUnresolved(state) == operation,
      state.op.get(operation) == "prepared"
    }) Set({...state, op: state.op.set(operation, "dispatched"), status: "waiting"})
    else Set()

  pure def result(state: State, operation: str, outcome: str): Set[State] =
    if (not(ended(state)) and state.op.get(operation) == "dispatched") Set({...state,
      op: state.op.set(operation, outcome),
      status: if (state.status == "waiting")
        (if (outcome == "unknown") "blocked" else "active") else state.status})
    else Set()

  pure def reconcile(state: State, operation: str, outcome: str): Set[State] =
    if (state.op.get(operation) == "unknown") Set({...state,
      op: state.op.set(operation, outcome),
      obs: if (outcome == "unknown") state.obs else "none",
      status: if (outcome != "unknown" and state.status == "blocked") "paused" else state.status})
    else Set()

  pure def complete(state: State): Set[State] =
    if (not(ended(state)) and firstUnresolved(state) == "none")
      Set({...state, status: "completed"}) else Set()

  pure def successors(state: State): Set[State] = {
    val observations = Origins.fold(Set(), (found, origin) =>
      Set(false, true).fold(found, (acc, resume) => acc.union(observe(state, origin, resume))))
    val interruptions = Set("pause", "cancel", "recover", "revoke").fold(Set(),
      (found, kind) => found.union(interrupt(state, kind)))
    val prepared = Ops.fold(Set(), (found, operation) =>
      found.union(prepare(state, operation)).union(dispatch(state, operation)))
    val settled = Ops.fold(Set(), (found, operation) =>
      Set("succeeded", "failed", "unknown").fold(found, (acc, outcome) =>
        acc.union(result(state, operation, outcome)).union(reconcile(state, operation, outcome))))
    observations.union(extend(state)).union(retract(state)).union(interruptions)
      .union(prepared).union(settled).union(complete(state))
  }

  action nextStep = {
    nondet nextState = successors(s).oneOf()
    s' = nextState
  }
  action step = any {nextStep, s' = s}

  val TypeOK = and {
    Statuses.contains(s.status), Set("active", "revoked").contains(s.auth),
    Origins.union(Set("none")).contains(s.obs), s.op.keys() == Ops,
    Ops.forall(operation => OpStates.contains(s.op.get(operation)))
  }
  val AtMostOneUnresolved = Ops.filter(operation => unresolved(s.op.get(operation))).size() <= 1
  val WaitingIffDispatched =
    (s.status == "waiting") iff Ops.exists(operation => s.op.get(operation) == "dispatched")
  val BlockedHasUnknown =
    s.status == "blocked" implies Ops.exists(operation => s.op.get(operation) == "unknown")
  val RevokedIsNotRunning =
    s.auth == "revoked" implies not(Set("active", "waiting").contains(s.status))
  val PreparedIsFenced = Ops.exists(operation => s.op.get(operation) == "prepared") implies
    (s.obs != "none" and s.auth == "active" and s.status == "active")
  val ObservedOriginIsAllowed = s.obs == "B" implies s.scopeB
  val ScopeComesFromGrant = s.scopeB implies s.extended
  val EndedIsSettled = ended(s) implies
    Ops.forall(operation => not(Set("prepared", "dispatched").contains(s.op.get(operation))))

  temporal OutcomesAreFinal = always((Ops.forall(operation => and {
    Set("succeeded", "failed", "cancelled").forall(outcome =>
      s.op.get(operation) == outcome implies next(s.op.get(operation)) == outcome),
    s.op.get(operation) != "none" implies next(s.op.get(operation)) != "none"
  })).orKeep(s))
  temporal RevocationIsFinal = always((
    s.auth == "revoked" implies next(s.auth) == "revoked"
  ).orKeep(s))
}

module InteractiveTask_reducer {
  import InteractiveTask.*
}

// Every edge comes from successors, which also defines the transition relation.
module InteractiveTaskGraph {
  import InteractiveTask.*
  var seen: Set[State]
  var frontier: Set[State]
  var edges: Set[(State, State)]

  action graphInit = all {
    s' = initialState, seen' = Set(initialState),
    frontier' = Set(initialState), edges' = Set()
  }
  action graphStep = {
    val reached = frontier.fold(Set(), (found, state) => found.union(successors(state)))
    val additions = frontier.fold(Set(), (found, state) =>
      found.union(successors(state).map(target => (state, target))))
    all {
      s' = s,
      seen' = seen.union(reached),
      frontier' = reached.exclude(seen),
      edges' = edges.union(additions)
    }
  }
  val graphComplete = frontier.size() == 0
}
