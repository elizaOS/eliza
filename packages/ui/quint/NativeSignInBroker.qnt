// Renderer request broker. Native credential issuance and durable recovery are
// owned by the Android/native host, not by this promise or its return listener.
module NativeSignInBroker {
  pure val Ids = Set(1, 2)
  // The omitted port joins only another omitted port. Its native events
  // arrive on the registered default port A.
  pure val EventKeys = Set("production:A", "staging:A", "production:B")
  pure val Keys = EventKeys.union(Set("production:default"))
  pure val EmptyRoute = { kind: "none", source: "", ownerKey: "" }

  type Route = { kind: str, source: str, ownerKey: str }
  type State = {
    issued: int,
    owner: int,
    ownerKey: str,
    outcomes: int -> str,
    callbacks: int -> str,
    subscribed: bool,
    retained: bool,
    route: Route,
    staleSettled: bool
  }
  var s: State

  action init = s' = {
    issued: 0, owner: 0, ownerKey: "",
    outcomes: Map(1 -> "unused", 2 -> "unused"),
    callbacks: Map(1 -> "idle", 2 -> "idle"),
    subscribed: false, retained: false, route: EmptyRoute, staleSettled: false
  }

  action request(key: str): bool = {
    val id = s.issued + 1
    all {
      s.owner == 0,
      s.issued < 2,
      s' = { ...s, issued: id, owner: id, ownerKey: key,
        outcomes: s.outcomes.set(id, "pending") }
    }
  }

  // Same environment and port join the existing promise. A different pair
  // rejects as login-active without acquiring a new identity.
  action requestWhileOpen(key: str): bool = all {
    s.owner != 0,
    s' = { ...s, route: { kind: if (key == s.ownerKey) "join" else "busy",
      source: key, ownerKey: s.ownerKey } }
  }

  pure def close(x: State, id: int, outcome: str): State =
    if (x.owner == id) { ...x, owner: 0, ownerKey: "", subscribed: false,
      retained: false, outcomes: x.outcomes.set(id, outcome) }
    else x

  // Direct completion validates the payload. Explicit abandonment rejects.
  action settle(id: int, outcome: str): bool = s' = close(s, id, outcome)

  // The caller uses a fresh non-aborted signal to retry a failed activation.
  action beginActivation(id: int): bool = all {
    s.owner == id,
    s.callbacks.get(id) == "idle",
    s' = { ...s, callbacks: s.callbacks.set(id, "running") }
  }

  action cancelActivation(id: int): bool = all {
    s.callbacks.get(id) == "running",
    s' = { ...s, callbacks: s.callbacks.set(id, "aborted") }
  }

  action finishActivation(id: int, accepted: bool): bool = {
    val running = s.callbacks.get(id)
    val retired = s.owner != id or running == "aborted"
    val finished = { ...s, callbacks: s.callbacks.set(id, "idle") }
    val updated = if (accepted and not(retired)) close(finished, id, "resolved")
      else finished
    all {
      running != "idle",
      s' = { ...updated, staleSettled: s.staleSettled or
        (retired and updated.outcomes != s.outcomes) }
    }
  }

  // The event is already parsed for the listener environment. Malformed events
  // stutter. A matching request gets the event, never the startup handler.
  pure def eventKey(key: str): str =
    if (key == "production:default") "production:A" else key

  action nativeReturn(source: str): bool = {
    val expected = eventKey(s.ownerKey)
    val matches = s.owner != 0 and source == expected
    val kind = if (not(matches)) "cold" else if (s.subscribed) "view" else "retain"
    s' = { ...s, retained: s.retained or kind == "retain",
      route: { kind: kind, source: source, ownerKey: expected } }
  }

  action subscribe(id: int): bool = all {
    s.owner == id,
    s' = { ...s, subscribed: true, retained: false,
      route: if (s.retained) { kind: "view", source: eventKey(s.ownerKey), ownerKey: eventKey(s.ownerKey) }
        else s.route }
  }

  action unsubscribe(id: int): bool = all {
    s.owner == id,
    s' = { ...s, subscribed: false }
  }

  action activationReply(id: int): bool = any {
    finishActivation(id, true), finishActivation(id, false)
  }

  action idle = s' = s
  action step = any {
    nondet key = Keys.oneOf()
    any { request(key), requestWhileOpen(key) },
    nondet source = EventKeys.oneOf()
    nativeReturn(source),
    nondet id = Ids.oneOf()
    any { settle(id, "resolved"), settle(id, "rejected"),
      beginActivation(id), cancelActivation(id), activationReply(id),
      subscribe(id), unsubscribe(id) },
    idle
  }

  val OneOpenRequest = all {
    Ids.filter(id => s.outcomes.get(id) == "pending") ==
      Ids.filter(id => id == s.owner),
    Ids.forall(id => (id > s.issued) == (s.outcomes.get(id) == "unused")),
    (s.owner == 0 and s.ownerKey == "") or
      (Ids.contains(s.owner) and Keys.contains(s.ownerKey))
  }
  val ReturnUsesMatchingOwner = all {
    Set("view", "retain", "join").contains(s.route.kind).implies(
      s.route.source == s.route.ownerKey),
    Set("cold", "busy").contains(s.route.kind).implies(
      s.route.source != s.route.ownerKey),
    s.retained.implies(s.owner != 0 and not(s.subscribed))
  }
  val CancelledOrRetiredCannotSettle = not(s.staleSettled)

  temporal EachActivationReturns = Ids.forall(id => always(
    (s.callbacks.get(id) != "idle").implies(eventually(s.callbacks.get(id) == "idle"))))
  temporal UnderFairReplies = Ids.forall(id => activationReply(id).weakFair(s))
    .implies(EachActivationReturns)

  run retiredReplyCannotCloseReplacementTest = init
    .then(request("production:A")).then(beginActivation(1))
    .then(settle(1, "rejected")).then(request("staging:A"))
    .then(finishActivation(1, true))
    .expect(s.owner == 2 and s.outcomes.get(1) == "rejected")
  run retainedReturnBelongsToViewTest = init.then(request("production:A"))
    .then(nativeReturn("production:A")).expect(s.retained)
    .then(nativeReturn("production:B")).expect(s.route.kind == "cold" and s.retained)
    .then(subscribe(1)).expect(s.route.kind == "view" and not(s.retained))
  run retryActivationWithoutNewRequestTest = init.then(request("production:A"))
    .then(beginActivation(1)).then(cancelActivation(1)).then(finishActivation(1, true))
    .expect(s.owner == 1).then(beginActivation(1)).then(finishActivation(1, true))
    .expect(s.owner == 0 and s.outcomes.get(1) == "resolved")
}
