// Protected registration selects a consumer. Its browser keeps the exact
// callback binding, live state and one-use pending record in sessionStorage.
module BrowserSignInReturn {
  val clients = Set(1, 2)
  type State = {
    registered: Set[int], started: Set[int], pending: Set[int],
    delivered: int -> int, now: int, safe: bool,
  }
  var s: State

  action init = {
    nondet registered = Set(Set(), Set(1), Set(1, 2)).oneOf()
    s' = { registered: registered, started: Set(), pending: Set(),
      delivered: clients.mapBy(_ => 0), now: 0, safe: true }
  }
  action start(client: int, validOriginAndProof: bool): bool = all {
    not(s.started.contains(client)),
    s' = if (s.registered.contains(client) and validOriginAndProof) {
      ...s, started: s.started.union(Set(client)),
      pending: s.pending.union(Set(client)),
    } else { ...s },
  }
  action callback(client: int, boundClient: int, matchingState: bool, validShape: bool): bool = {
    val admitted = and {
      s.registered.contains(client), s.pending.contains(client),
      client == boundClient, matchingState, validShape, s.now < 2,
    }
    all {
      s' = if (admitted) {
        ...s, pending: s.pending.exclude(Set(client)),
        delivered: s.delivered.put(client, s.delivered.get(client) + 1),
        safe: s.safe and client == boundClient and s.now < 2,
      } else { ...s },
    }
  }
  action tick = all { s.now < 2, s' = { ...s, now: s.now + 1 } }
  action step = any {
    { nondet client = clients.oneOf()
      nondet valid = Set(false, true).oneOf()
      start(client, valid) },
    { nondet client = clients.oneOf()
      nondet bound = clients.oneOf()
      nondet matching = Set(false, true).oneOf()
      nondet shape = Set(false, true).oneOf()
      callback(client, bound, matching, shape) },
    tick, s' = s,
  }
  val TypeOK = and {
    s.registered.subseteq(clients), s.started.subseteq(s.registered),
    s.pending.subseteq(s.started), s.now.in(0.to(2)),
    clients.forall(client => s.delivered.get(client).in(0.to(1))),
  }
  val ExactLiveConsumer = s.safe and clients.forall(client =>
    (s.delivered.get(client) > 0).implies(s.registered.contains(client)))
  val ConsumedOnce = clients.forall(client =>
    (s.delivered.get(client) == 1).implies(not(s.pending.contains(client))))
  val IndependentConsumers = clients.forall(client =>
    (s.started.contains(client) and s.delivered.get(client) == 0).iff(s.pending.contains(client)))
  val invariant = TypeOK and ExactLiveConsumer and ConsumedOnce and IndependentConsumers
}
