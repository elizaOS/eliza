// Funding-source selection only: two callers observe a confirmed paid/free policy or a failed read.
// Database authority derivation, reservation arithmetic, locks and settlement are separate owners.
module subscription_funding_authority {
  pure val callers = Set(0, 1)
  pure val policies = Set("paid", "free", "unavailable")
  var s: { phase: int -> str, observed: int -> str, lane: int -> str }
  action init = s' = {
    phase: callers.mapBy(_ => "idle"),
    observed: callers.mapBy(_ => "none"),
    lane: callers.mapBy(_ => "none")
  }
  action chooseFunding(caller: int, policy: str): bool = all {
    callers.contains(caller), policies.contains(policy), s.phase.get(caller) == "idle",
    s' = {
      ...s,
      phase: s.phase.set(caller, if (policy == "unavailable") "refused" else "selected"),
      observed: s.observed.set(caller, policy),
      lane: s.lane.set(caller, if (policy == "paid") "allowance-first" else if (policy == "free") "purchased" else "none")
    }
  }
  action step = any {
    nondet caller = callers.oneOf()
    nondet policy = policies.oneOf()
    chooseFunding(caller, policy),
    s' = s
  }
  val safety = callers.forall(caller => all {
    s.observed.get(caller) == "unavailable" implies all {
      s.phase.get(caller) == "refused", s.lane.get(caller) == "none"
    },
    s.lane.get(caller) == "purchased" implies s.observed.get(caller) == "free",
    s.lane.get(caller) == "allowance-first" implies s.observed.get(caller) == "paid"
  })
  run unavailableNeverSelectsCashTest = init.then(chooseFunding(0, "unavailable"))
    .expect(s.lane.get(0) == "none" and safety)
  run paidAndFreeKeepTheirLanesTest = init.then(chooseFunding(0, "paid")).then(chooseFunding(1, "free"))
    .expect(s.lane.get(0) == "allowance-first" and s.lane.get(1) == "purchased" and safety)
  run failedReadDoesNotChangeOtherCallerTest = init.then(chooseFunding(0, "paid")).then(chooseFunding(1, "unavailable"))
    .expect(s.lane.get(0) == "allowance-first" and s.lane.get(1) == "none" and safety)
}
