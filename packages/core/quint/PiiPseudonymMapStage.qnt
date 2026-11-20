// PiiScrubService (packages/core/src/services/pii-scrub.ts) drains two scrub
// items together (BatchQueue maxParallel 2). An item that has no
// requester-built context pack loads the encrypted corpus pseudonym map
// (security/pii-pseudonym-map-store.ts), mints a pseudonym for its person when
// the map has none, sends it to the PII_SCRUB model, and saves its whole copy
// of the map before the done-marker. A save replaces the stored map. Map
// stages queue on one FIFO promise chain: an item loads only at the head of
// the chain while no other item holds the stage. A failed model call releases
// the stage without saving, and BatchQueue retries the item behind the items
// already waiting. Both requests arrive in one drain batch, so both items
// join the chain before the first load.
// Item 1 names person 1. Item 2 names person 1 or person 2.
// Tokens are minted pseudonyms; 0 means none.
// phase: idle, queued (waiting on the chain), loaded (holds the stage, its
// model call is open), backoff (failed, waiting to retry), saved.
module PiiPseudonymMapStage {
  pure val Items = Set(1, 2)
  pure val People = Set(1, 2)
  pure val NoPseudonyms = People.mapBy(_ => 0)
  var person: int -> int
  var phase: int -> str
  var chain: List[int]
  var holder: int
  var stored: int -> int
  var local: int -> (int -> int)
  var artifact: int -> int
  var minted: int
  var failures: int

  action init = {
    nondet second = People.oneOf()
    all {
      person' = Map(1 -> 1, 2 -> second),
      phase' = Items.mapBy(_ => "idle"),
      chain' = List(),
      holder' = 0,
      stored' = NoPseudonyms,
      local' = Items.mapBy(_ => NoPseudonyms),
      artifact' = Items.mapBy(_ => 0),
      minted' = 0,
      failures' = 0,
    }
  }
  // BatchQueue hands the item to process(), which joins the map chain.
  action enter(s: int): bool = all {
    phase.get(s) == "idle",
    phase' = phase.set(s, "queued"),
    chain' = chain.append(s),
    person' = person, holder' = holder, stored' = stored, local' = local,
    artifact' = artifact, minted' = minted, failures' = failures,
  }
  // The head of the chain loads the stored map and mints a pseudonym for its
  // person when the map has none; its model call is now open.
  action load(s: int): bool = {
    val who = person.get(s)
    val known = stored.get(who) != 0
    all {
      phase.get(s) == "queued",
      Items.forall(t => phase.get(t) != "idle"),
      holder == 0,
      chain.length() > 0,
      chain.head() == s,
      phase' = phase.set(s, "loaded"),
      chain' = chain.tail(),
      holder' = s,
      local' = local.set(s, if (known) stored else stored.set(who, minted + 1)),
      minted' = if (known) minted else minted + 1,
      person' = person, stored' = stored, artifact' = artifact,
      failures' = failures,
    }
  }
  // The model call succeeds: the artifact carries the item's pseudonym, the
  // item saves its copy of the map, then releases the stage.
  action complete(s: int): bool = all {
    phase.get(s) == "loaded",
    phase' = phase.set(s, "saved"),
    artifact' = artifact.set(s, local.get(s).get(person.get(s))),
    stored' = local.get(s),
    holder' = 0,
    person' = person, chain' = chain, local' = local, minted' = minted,
    failures' = failures,
  }
  // One model call may reject: nothing is saved and the stage is released.
  action reject(s: int): bool = all {
    phase.get(s) == "loaded",
    failures < 1,
    phase' = phase.set(s, "backoff"),
    holder' = 0,
    failures' = failures + 1,
    person' = person, chain' = chain, stored' = stored, local' = local,
    artifact' = artifact, minted' = minted,
  }
  // After its backoff the failed item joins the chain again, at the tail.
  action retry(s: int): bool = all {
    phase.get(s) == "backoff",
    phase' = phase.set(s, "queued"),
    chain' = chain.append(s),
    person' = person, holder' = holder, stored' = stored, local' = local,
    artifact' = artifact, minted' = minted, failures' = failures,
  }
  // A model call or the drain may stay open without a deadline.
  action stutter = all {
    person' = person, phase' = phase, chain' = chain, holder' = holder,
    stored' = stored, local' = local, artifact' = artifact,
    minted' = minted, failures' = failures,
  }
  action step = any {
    enter(1), enter(2), load(1), load(2), complete(1), complete(2),
    reject(1), reject(2), retry(1), retry(2), stutter,
  }

  val ModelState = {
    person: person, phase: phase, chain: chain, holder: holder,
    stored: stored, local: local, artifact: artifact, minted: minted,
    failures: failures,
  }
  temporal ItemsSaveWithoutFairness = Items.forall(s =>
    (phase.get(s) != "saved").leadsTo(phase.get(s) == "saved"))
  temporal ItemsSave = Items.forall(s =>
    enter(s).weakFair(ModelState) and load(s).weakFair(ModelState) and
    complete(s).weakFair(ModelState) and retry(s).weakFair(ModelState))
      .implies(ItemsSaveWithoutFairness)

  // Every pseudonym written into a scrubbed artifact stays in the stored map.
  val ArtifactsStayInMap = Items.forall(s =>
    phase.get(s) == "saved" implies
      stored.get(person.get(s)) == artifact.get(s))
  // One person keeps one pseudonym across scrubbed artifacts.
  val OnePseudonymPerPerson = Items.forall(s => Items.forall(t =>
    (phase.get(s) == "saved" and phase.get(t) == "saved" and
      person.get(s) == person.get(t)) implies
      artifact.get(s) == artifact.get(t)))
  val OneStageAtATime =
    Items.filter(s => phase.get(s) == "loaded").size() <= 1 and
    (holder == 0) == Items.forall(s => phase.get(s) != "loaded") and
    (holder != 0 implies phase.get(holder) == "loaded")
  val ChainHoldsQueuedItems =
    chain.length() == Items.filter(s => phase.get(s) == "queued").size() and
    Items.forall(s => phase.get(s) == "queued" implies
      chain.indices().exists(i => chain[i] == s))
  val TypeOK =
    person.get(1) == 1 and People.contains(person.get(2)) and
    Items.forall(s => Set("idle", "queued", "loaded", "backoff", "saved")
      .contains(phase.get(s))) and
    Set(0, 1, 2).contains(holder) and chain.length() <= 2 and
    minted <= 3 and failures <= 1 and
    People.forall(p => stored.get(p) >= 0 and stored.get(p) <= minted)
}
