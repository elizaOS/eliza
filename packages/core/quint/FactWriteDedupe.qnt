// src/runtime/data-mutations.ts and src/runtime/fact-write-dedupe.ts.
// Each read, update and insert is a separate await. Serialised=false retains the
// original counterexample mode. The maintained cases use Serialised=true.
module FactWriteDedupe {

  const Writers: Set[str]

  const Prefilled: bool

  const Serialised: bool

  const Seed: str

  type State = {
    rows: List[Set[str]],
    pc: str -> str,
    seen: str -> Set[str],
    owner: str
  }

  var s: State

  action init = s' = {
    rows: if (Prefilled)[Set(Seed)] else[],
    pc: Writers.mapBy(w => "idle"),
    seen: Writers.mapBy(w => Set()),
    owner: Seed
  }

  action Check(w: str): bool = all {
    s.pc.get(w) == "idle",
    Serialised implies s.owner == Seed,
    s' = if (s.rows.length() == 0) {
      ...s,
      owner: if (Serialised) w else s.owner,
      pc: s.pc.set(w, "miss")
    } else {
      ...s,
      owner: if (Serialised) w else s.owner,
      pc: s.pc.set(w, "hit"),
      seen: s.seen.set(w, s.rows.nth(0))
    }
  }

  action Update(w: str): bool = all {
    s.pc.get(w) == "hit",
    s' = {
      ...s,
      rows: s.rows.replaceAt(0, s.seen.get(w).union(Set(w))),
      pc: s.pc.set(w, "done"),
      owner: if (Serialised) Seed else s.owner
    }
  }

  action Insert(w: str): bool = all {
    s.pc.get(w) == "miss",
    s' = {
      ...s,
      rows: s.rows.append(Set(w)),
      pc: s.pc.set(w, "done"),
      owner: if (Serialised) Seed else s.owner
    }
  }

  action WriterStep(w: str): bool = any {
    Check(w),
    Update(w),
    Insert(w)
  }

  val Finished = Writers.forall(w => s.pc.get(w) == "done")

  action nextStep = {
    nondet w = Writers.oneOf()
    any {
      WriterStep(w),
      all {
        Finished,
        s' = s
      }
    }
  }

  action step = any {
    nextStep,
    s' = s
  }

  val TypeOK = and {
    s.rows.indices().forall(i => s.rows.nth(i).subseteq(Writers.union(Set(Seed)))),
    s.pc.keys() == Writers,
    Writers.forall(w => Set("idle", "hit", "miss", "done").contains(s.pc.get(w)) and s.seen.get(w).subseteq(Writers.union(Set(Seed)))),
    Writers.union(Set(Seed)).contains(s.owner)
  }

  val NoDuplicateFact = s.rows.length() <= 1

  val NoLostEvidence = Writers.forall(w => s.pc.get(w) == "done" implies s.rows.indices().exists(i => s.rows.nth(i).contains(w)))

  temporal Fairness = Writers.forall(w => WriterStep(w).weakFair(s))

  temporal WriteReturns = Fairness implies Writers.forall(w => eventually(s.pc.get(w) == "done"))

  temporal DeadlockFree = always(enabled(nextStep))
}
module FactWriteDedupe_empty {
  import FactWriteDedupe(Writers = Set("w1", "w2", "w3"), Prefilled = false, Serialised = true, Seed = "Seed").*
}
module FactWriteDedupe_prefilled {
  import FactWriteDedupe(Writers = Set("w1", "w2", "w3"), Prefilled = true, Serialised = true, Seed = "Seed").*
}
