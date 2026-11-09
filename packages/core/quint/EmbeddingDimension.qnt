// src/runtime/embeddings.ts and the embedding adapter contract in plugin-sql.
// Each provider, adapter resize, space update, pin, clear and write await remains
// separate. Runtime and stored vectors carry immutable named or unversioned
// provenance. Unmarked direct inputs can write only to an unnamed store.
// Init starts with an empty/correct index. Previously mislabeled persisted
// vectors need the existing explicit fresh-index/re-embedding workflow.
module EmbeddingDimension {
  const Embedders: Set[str]
  const MaxProbes: int
  pure val Providers = Set("named", "plain", "wide")
  pure val None = "none"
  pure def space(p: str): str = if (p == "named") "S" else None
  pure def dim(p: str): int = if (p == "wide") 3 else 2
  type Vector = {space: str, dim: int, from: str}
  type State = {col: int, aspace: str, stored: Set[Vector], pinProv: str,
    pinSpace: str, pinDim: int, ppc: str, pprov: str, probes: int,
    epc: str -> str, eprov: str -> str, writeSpace: str -> str, writeDim: str -> int,
    dropped: int, clearFailed: bool}
  var s: State
  action init = s' = {col: 2, aspace: None, stored: Set(), pinProv: None,
    pinSpace: None, pinDim: 0, ppc: "idle", pprov: None, probes: 0,
    epc: Embedders.mapBy(e => "idle"), eprov: Embedders.mapBy(e => None),
    writeSpace: Embedders.mapBy(e => None), writeDim: Embedders.mapBy(e => 0),
    dropped: 0, clearFailed: false}
  action ProbeStart(p: str): bool = all {
    s.ppc == "idle", s.probes < MaxProbes,
    s' = {...s, ppc: "called", pprov: p, probes: s.probes + 1}
  }
  action ProbeResize = {
    val p = s.pprov
    val expected = if (s.pinSpace != None) s.pinSpace else space(p)
    val refused = expected != None and
      (space(p) != expected or (s.pinDim != 0 and dim(p) != s.pinDim))
    val guard = space(p) != None and s.pinProv != None and s.pinSpace != space(p)
    all {s.ppc == "called", s' =
      if (refused or guard or (s.aspace != None and dim(p) != s.col))
        {...s, ppc: "idle", pprov: None}
      else {...s, col: dim(p), ppc: "resized"}
    }
  }
  action ProbeSpace = {
    val target = space(s.pprov)
    all {s.ppc == "resized", s' =
      if (target != None and s.aspace != None and s.aspace != target)
        {...s, ppc: "idle", pprov: None}
      else {...s, aspace: if (target != None) target else s.aspace, ppc: "spaced"}
    }
  }
  action ProbePin = all {
    s.ppc == "spaced",
    s' = {...s, pinProv: s.pprov, pinSpace: space(s.pprov),
      pinDim: dim(s.pprov), ppc: "pinned"}
  }
  action ProbeClear = all {
    s.ppc == "pinned",
    any {
      s' = {...s, stored: s.stored.filter(v => v.space != s.aspace or v.dim == s.col),
        clearFailed: false, ppc: "idle", pprov: None},
      s' = {...s, clearFailed: true, ppc: "idle", pprov: None}
    }
  }
  action EmbedCall(e: str, p: str): bool = all {
    s.epc.get(e) == "idle", s.pinProv != None implies p == s.pinProv,
    s' = {...s, epc: s.epc.set(e, "called"), eprov: s.eprov.set(e, p)}
  }
  action EmbedValidate(e: str): bool = {
    val named = space(s.eprov.get(e))
    val expected = if (s.pinSpace != None) s.pinSpace else named
    all {
      s.epc.get(e) == "called",
      named != None and s.pinSpace == None implies s.ppc == "idle",
      s' = {...s, epc: s.epc.set(e,
        if (expected == None) "valid"
        else if (s.pinSpace == None) "done"
        else if (named == expected and dim(s.eprov.get(e)) == s.pinDim) "valid"
        else "done")}
    }
  }
  // Storage captures the vector's provenance and selected column before awaits.
  action EmbedAdmit(e: str): bool = all {
    s.epc.get(e) == "valid",
    s' = if (space(s.eprov.get(e)) != s.aspace)
      {...s, epc: s.epc.set(e, "done"), dropped: s.dropped + 1}
    else {...s, epc: s.epc.set(e, "admitted"),
      writeSpace: s.writeSpace.set(e, space(s.eprov.get(e))),
      writeDim: s.writeDim.set(e, s.col)}
  }
  // Actual writes recheck the capture after every database await and retain its label.
  action EmbedWrite(e: str): bool = {
    val v = {space: s.writeSpace.get(e), dim: dim(s.eprov.get(e)), from: space(s.eprov.get(e))}
    val current = s.writeSpace.get(e) == s.aspace and s.writeDim.get(e) == s.col
    all {s.epc.get(e) == "admitted", s' =
      if (current and v.dim == s.col)
        {...s, stored: s.stored.union(Set(v)), epc: s.epc.set(e, "done")}
      else {...s, dropped: s.dropped + 1, epc: s.epc.set(e, "done")}
    }
  }
  action DirectUnmarkedWrite(e: str): bool = all {
    s.epc.get(e) == "idle",
    s' = if (s.aspace == None)
      {...s, epc: s.epc.set(e, "done"), stored: s.stored.union(Set({space: None, dim: s.col, from: None}))}
    else {...s, epc: s.epc.set(e, "done"), dropped: s.dropped + 1}
  }
  val Finished = s.ppc == "idle" and Embedders.forall(e => s.epc.get(e) == "done")
  action nextStep = {
    nondet p = Providers.oneOf()
    nondet e = Embedders.oneOf()
    any {ProbeStart(p), ProbeResize, ProbeSpace, ProbePin, ProbeClear,
      EmbedCall(e, p), EmbedValidate(e), EmbedAdmit(e), EmbedWrite(e),
      DirectUnmarkedWrite(e), all {Finished, s' = s}}
  }
  action step = any {nextStep, s' = s}
  val TypeOK = and {
    Set(2, 3).contains(s.col), Set("S", None).contains(s.aspace),
    s.stored.forall(v => Set("S", None).contains(v.space) and Set(2, 3).contains(v.dim) and Set("S", None).contains(v.from)),
    Providers.union(Set(None)).contains(s.pinProv), Set("S", None).contains(s.pinSpace),
    Set(0, 2, 3).contains(s.pinDim), Set("idle", "called", "resized", "spaced", "pinned").contains(s.ppc),
    Providers.union(Set(None)).contains(s.pprov), s.probes >= 0, s.probes <= MaxProbes,
    s.epc.keys() == Embedders, s.eprov.keys() == Embedders,
    s.writeSpace.keys() == Embedders, s.writeDim.keys() == Embedders,
    Embedders.forall(e => Set("S", None).contains(s.writeSpace.get(e)) and Set(0, 2, 3).contains(s.writeDim.get(e))),
    Embedders.forall(e => Set("idle", "called", "valid", "admitted", "done").contains(s.epc.get(e)) and Providers.union(Set(None)).contains(s.eprov.get(e))),
    s.dropped >= 0
  }
  val StoredOneSpace = s.stored.forall(v => v.space == v.from)
  val PinMatchesStore = s.ppc == "idle" and s.pinProv != None implies
    (s.pinDim == s.col and (s.pinSpace != None implies s.aspace == s.pinSpace))
  val StoredInColumn = s.ppc == "idle" and not(s.clearFailed) implies s.stored.forall(v => v.dim == s.col)
  temporal PinSpaceStable = always((s.pinProv != None implies next(s.pinSpace) == s.pinSpace).orKeep(s))
  temporal DeadlockFree = always(enabled(nextStep))
}
module EmbeddingDimension_probes {import EmbeddingDimension(Embedders = Set("e1", "e2"), MaxProbes = 3).*}
