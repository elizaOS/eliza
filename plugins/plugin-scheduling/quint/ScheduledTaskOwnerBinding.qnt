// runner-service.ts: a deferred consumer replaces the boot fallback binding.
// Store ownership and committed claims survive the change. Work already started
// uses its original binding; a later operation must select the current owner.
module ScheduledTaskOwnerBinding {
  pure val Callers = Set("early", "late")
  var registered: bool
  var cached: str
  var phase: str -> str
  var ownerAtStart: str -> bool
  var binding: str -> str
  var claimed: bool
  var deliveries: int
  action init = all {
    registered' = false, cached' = "none",
    phase' = Callers.mapBy(_ => "idle"),
    ownerAtStart' = Callers.mapBy(_ => false),
    binding' = Callers.mapBy(_ => "none"),
    claimed' = false, deliveries' = 0
  }
  action registerOwner = all {
    not(registered), registered' = true, cached' = cached,
    phase' = phase, ownerAtStart' = ownerAtStart, binding' = binding,
    claimed' = claimed, deliveries' = deliveries
  }
  action begin(c: str): bool = all {
    phase.get(c) == "idle",
    registered' = registered,
    cached' = if (registered) "owner" else "fallback",
    phase' = phase.set(c, "ready"),
    ownerAtStart' = ownerAtStart.set(c, registered),
    binding' = binding.set(c, if (registered) "owner" else "fallback"),
    claimed' = claimed, deliveries' = deliveries
  }
  action claim(c: str): bool = all {
    phase.get(c) == "ready",
    phase' = phase.set(c, if (claimed) "raced" else "claimed"),
    claimed' = true, registered' = registered, cached' = cached,
    ownerAtStart' = ownerAtStart, binding' = binding, deliveries' = deliveries
  }
  action finish(c: str): bool = all {
    phase.get(c) == "claimed", phase' = phase.set(c, "done"),
    deliveries' = deliveries + 1, claimed' = claimed,
    registered' = registered, cached' = cached,
    ownerAtStart' = ownerAtStart, binding' = binding
  }
  action step = any {
    registerOwner,
    { nondet c = Callers.oneOf(); any { begin(c), claim(c), finish(c) } },
    all { registered' = registered, cached' = cached, phase' = phase,
      ownerAtStart' = ownerAtStart, binding' = binding,
      claimed' = claimed, deliveries' = deliveries }
  }
  val NewOperationsUseOwner = Callers.forall(c => ownerAtStart.get(c).implies(binding.get(c) == "owner"))
  val OneDeliveryAcrossRebind = deliveries <= 1
  val DeliveryHasClaim = (deliveries > 0).implies(claimed)
  val TypeOK = Set("none", "fallback", "owner").contains(cached) and deliveries >= 0
}
