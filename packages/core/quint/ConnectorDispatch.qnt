// runtime/connector-registry.ts: canonical message routes and one admitted send.
// Descriptor presence is separate from transport ownership. Plugin lifecycle
// owns plugin teardown; replacing a route does not cancel a captured transport.
module ConnectorDispatchModel {
  const Target: int
  pure val routes = Set(0, 1) // source-only and one named account
  pure val owners = Set(1, 2)
  type State = {
    descriptors: Set[int], handlers: int -> int,
    phase: str, selectedRoute: int, selectedOwner: int,
    invoked: int, result: str
  }
  var s: State
  val route = if (s.handlers.get(Target) != 0) Target
    else if (s.handlers.get(0) != 0) 0 else -1
  val owner = if (route == -1) 0 else s.handlers.get(route)
  action init = s' = {
    descriptors: Set(), handlers: routes.mapBy(_ => 0),
    phase: "idle", selectedRoute: -1, selectedOwner: 0,
    invoked: 0, result: "none"
  }
  action legacy(handler: int): bool = s' = {
    ...s, descriptors: s.descriptors.union(Set(0)), handlers: s.handlers.set(0, handler)
  }
  action internal(handler: int): bool = s' = { ...s, handlers: s.handlers.set(0, handler) }
  action register(r: int, handler: int): bool = s' = {
    ...s, descriptors: s.descriptors.union(Set(r)),
    handlers: if (handler == 0) s.handlers else s.handlers.set(r, handler)
  }
  action removeExact(r: int): bool = s' = {
    ...s, descriptors: s.descriptors.exclude(Set(r)), handlers: s.handlers.set(r, 0)
  }
  action removeSource = s' = { ...s, descriptors: Set(), handlers: routes.mapBy(_ => 0) }
  action dispatch = all {
    s.phase == "idle",
    s' = { ...s, selectedRoute: route, selectedOwner: owner,
      phase: if (owner == 0) "done" else "voice",
      result: if (owner == 0) "missing" else "none" }
  }
  // Valid content passes the cosmetic gate even when its model fails. The
  // source sanitizes content, then invokes the handler selected before await.
  action passVoice = all {
    s.phase == "voice", s' = { ...s, phase: "handler", invoked: s.selectedOwner }
  }
  action settle(ok: bool): bool = all {
    s.phase == "handler", s' = { ...s, phase: "done", result: if (ok) "ok" else "failed" }
  }
  action settleHandler = any { settle(true), settle(false) }
  action step = {
    nondet r = routes.oneOf()
    nondet handler = owners.oneOf()
    any {
      legacy(handler), internal(handler), register(r, 0), register(r, handler),
      removeExact(r), removeSource, dispatch, passVoice, settleHandler, s' = s
    }
  }

  val RegistryShape = and {
    s.descriptors.subseteq(routes), routes.forall(r => Set(0, 1, 2).contains(s.handlers.get(r))),
    Set(-1, 0, 1).contains(s.selectedRoute), Set(0, 1, 2).contains(s.selectedOwner)
  }
  val UsesAdmittedHandler = s.invoked != 0 implies s.invoked == s.selectedOwner
  val WaitsForVoice = s.phase == "voice" implies s.invoked == 0
  val MissingNeverInvokes = s.result == "missing" implies and {
    s.phase == "done", s.selectedOwner == 0, s.selectedRoute == -1, s.invoked == 0
  }
  val ResultRequiresSettlement = Set("ok", "failed").contains(s.result) implies and {
    s.phase == "done", s.invoked != 0
  }
  temporal AdmissionSelectsRoute = always(((s.phase == "idle" and next(s.phase) != "idle") implies and {
    next(s.selectedRoute) == route, next(s.selectedOwner) == owner
  }).orKeep(s))
  temporal AdmittedOwnerStays = always(((s.phase != "idle") implies and {
    next(s.selectedRoute) == s.selectedRoute, next(s.selectedOwner) == s.selectedOwner
  }).orKeep(s))
  temporal DispatchFinishes = (s.phase != "idle").leadsTo(s.phase == "done")
  temporal FairDispatchFinishes = and {
    passVoice.weakFair(s), settleHandler.weakFair(s)
  } implies DispatchFinishes

  run metadataRetainsTransportTest = init.then(internal(1)).expect(s.descriptors == Set())
    .then(register(0, 0)).then(dispatch).then(passVoice).then(settle(true))
    .expect(s.invoked == 1 and s.descriptors == Set(0))
  run unregisterKeepsAdmittedTransportTest = init.then(register(Target, 1)).then(dispatch)
    .then(removeSource).then(passVoice).then(settle(false))
    .expect(s.handlers == routes.mapBy(_ => 0) and s.invoked == 1 and s.result == "failed")
  run replacementKeepsAdmittedTransportTest = init.then(register(Target, 1)).then(dispatch)
    .then(register(Target, 2)).then(passVoice).then(settle(true))
    .expect(s.handlers.get(Target) == 2 and s.invoked == 1)
}

module ConnectorDefaultDispatch {
  import ConnectorDispatchModel(Target = 0).*
}
module ConnectorAccountDispatch {
  import ConnectorDispatchModel(Target = 1).*
  run accountPrecedesFallbackTest = init.then(legacy(1)).then(register(1, 2)).then(dispatch)
    .then(passVoice).then(settle(true)).expect(s.selectedRoute == 1 and s.invoked == 2)
  run exactRemovalRetainsFallbackTest = init.then(legacy(1)).then(register(1, 2)).then(removeExact(1))
    .then(dispatch).then(passVoice).then(settle(true)).expect(s.selectedRoute == 0 and s.invoked == 1)
  run descriptorOnlyAccountUsesFallbackTest = init.then(legacy(1)).then(register(1, 0))
    .then(dispatch).then(passVoice).then(settle(true)).expect(s.descriptors == routes and s.selectedRoute == 0 and s.invoked == 1)
}
