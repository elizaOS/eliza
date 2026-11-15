// The live trace map and the ordered run index move together.
module ActivePromptTraces {
  val Runs = Set("first", "second")
  val Traces = Set("original", "latest", "other")
  val Owner = Map("original" -> "first", "latest" -> "first", "other" -> "second")
  val Ttl = 2
  var s: {
    now: int, active: Set[str], byRun: str -> List[str], recorded: str -> int,
    created: str -> int, enriched: Set[str]
  }

  action init = s' = { now: 0, active: Set(), byRun: Runs.mapBy(_ => List()),
    recorded: Traces.mapBy(_ => 0), created: Traces.mapBy(_ => 0), enriched: Set() }

  def stale(t: str): bool = s.now - s.created.get(t) > Ttl
  def latest(ownerRun: str): str = {
    val index = s.byRun.get(ownerRun)
    if (index.length() == 0) "" else index.nth(index.length() - 1)
  }
  action record(t: str): bool = {
    val owner = Owner.get(t)
    all {
      s.recorded.get(t) == 0,
      s' = { ...s, active: s.active.union(Set(t)),
        byRun: s.byRun.set(owner, s.byRun.get(owner).append(t)),
        recorded: s.recorded.set(t, Traces.filter(x => s.recorded.get(x) > 0).size() + 1),
        created: s.created.set(t, s.now) },
    }
  }
  action enrich(ownerRun: str, target: str): bool = {
    val selected = s.active.filter(t => Owner.get(t) == ownerRun and (target == "" or target == t))
    s' = { ...s, enriched: s.enriched.union(selected) }
  }
  action remove(traces: Set[str]): bool = {
    val remaining = s.active.exclude(traces)
    s' = { ...s, active: remaining, enriched: s.enriched.intersect(remaining),
      byRun: Runs.mapBy(ownerRun =>
        s.byRun.get(ownerRun).foldl(List(), (index, t) =>
          if (remaining.contains(t)) index.append(t) else index)) }
  }
  action deleteTrace(t: str): bool = remove(Set(t))
  action finalizeRun(ownerRun: str): bool = remove(Traces.filter(t => Owner.get(t) == ownerRun))
  action purge = all {
    s.active.exists(t => stale(t)),
    remove(s.active.filter(t => stale(t))),
  }
  action tick = all { s.now < Ttl + 1, s' = { ...s, now: s.now + 1 } }
  action step = any {
    tick, purge, s' = s,
    { nondet t = Traces.oneOf() any { record(t), deleteTrace(t) } },
    { nondet ownerRun = Runs.oneOf()
      nondet target = Traces.union(Set("")).oneOf()
      any { enrich(ownerRun, target), finalizeRun(ownerRun) }
    },
  }

  val IndexAgreesWithOwners = Runs.forall(ownerRun => {
    val index = s.byRun.get(ownerRun)
    index.indices().map(i => index.nth(i)) == s.active.filter(t => Owner.get(t) == ownerRun)
  })
  val IndexKeepsInsertionOrder = Runs.forall(ownerRun => {
    val index = s.byRun.get(ownerRun)
    index.indices().forall(i => index.indices().forall(j =>
      (i < j).implies(s.recorded.get(index.nth(i)) < s.recorded.get(index.nth(j)))))
  })
  val LatestIsNewest = Runs.forall(ownerRun =>
    s.active.filter(t => Owner.get(t) == ownerRun).forall(t => {
      val current = latest(ownerRun)
      if (current == "") false else s.recorded.get(t) <= s.recorded.get(current)
    }))
  val OnlyLiveTracesAreEnriched = s.enriched.subseteq(s.active)
  temporal EnrichmentStaysInOneRun = always(Runs.exists(ownerRun =>
    next(s.enriched).exclude(s.enriched).subseteq(s.active.filter(t => Owner.get(t) == ownerRun))
  ).orKeep(s))
  temporal UnfairStaleTracesRetire = Traces.forall(t =>
    (s.active.contains(t) and stale(t)).leadsTo(not(s.active.contains(t))))
  temporal StaleTracesRetire = purge.weakFair(s).implies(UnfairStaleTracesRetire)

  run sameRunTraceSelectionTest = init.then(record("original")).then(record("other"))
    .then(record("latest")).then(enrich("first", "other")).expect(s.enriched == Set())
    .then(enrich("first", "original")).expect(s.enriched == Set("original"))
    .then(enrich("first", "")).expect(s.enriched == Set("original", "latest"))
    .expect(latest("first") == "latest" and latest("second") == "other")
    .then(deleteTrace("latest")).expect(latest("first") == "original")
    .then(finalizeRun("first")).expect(latest("first") == "" and latest("second") == "other")

  run expiresPastBoundaryTest = init.then(record("original"))
    .then(tick).then(tick).then(record("latest")).then(record("other"))
    .expect(not(stale("original")) and s.active == Traces).then(tick).then(purge)
    .expect(s.active == Set("latest", "other") and latest("first") == "latest")
}
