// account-deletion-saga.ts ordered head selection and account-deletion-requests.ts
// phase claim, canonical completion, retry and terminal database erasure.
// All production phase identities/orders are retained. Provider internals are
// separately modeled by AccountDeletionPhase; this model owns coordination.
module AccountDeletionOrderModel {
  const InitialStatus: str
  const ExistingEffects: Set[str]
  // One injected fault per full phase sequence; per-phase retry interleavings
  // are independently covered by AccountDeletionPhase.
  pure val FaultBudget = 1
  pure val Workers = Set("standard", "full")
  pure val None = "none"
  pure val Ordered = List(
    "account_authority", "export", "steward_deactivation", "export_revoke",
    "stripe", "domains", "spools", "secondary_backups", "compute_containers",
    "github_repositories", "connector_credentials", "voice_credentials",
    "primary_object_storage", "vault_key_bindings", "other_grants", "steward_deletion", "database_erasure"
  )
  pure val Phases = Ordered.indices().map(i => Ordered.nth(i))
  pure val InitialComplete = Set("account_authority", "export", "steward_deactivation")
  type State = {
    status: str, phase: str -> str, generation: str -> int, owner: str -> str,
    receipts: Set[str], external: Set[str], issued: Set[str],
    workerPhase: str -> str, pc: str -> str, observed: str -> int,
    faults: int, authority: bool, soleOwner: bool, identifiersPresent: bool, completionReceipt: bool
  }
  var s: State
  val Remaining = Ordered.indices().filter(i => s.phase.get(Ordered.nth(i)) != "completed")
  val Head = if (Remaining.size() == 0) None else Ordered.nth(Remaining.fold(Ordered.length(), (n, i) => if (i < n) i else n))
  pure def Allowed(w: str, phase: str): bool = w == "full" or not(Set("spools", "secondary_backups").contains(phase))
  action init = s' = {
    status: InitialStatus,
    phase: Phases.mapBy(p => if (InitialComplete.contains(p)) "completed" else "pending"),
    generation: Phases.mapBy(_ => 0), owner: Phases.mapBy(_ => None),
    receipts: InitialComplete, external: ExistingEffects.union(InitialComplete), issued: Set(),
    workerPhase: Workers.mapBy(_ => "export_revoke"), pc: Workers.mapBy(_ => "idle"), observed: Workers.mapBy(_ => 0),
    faults: 0, authority: true, soleOwner: true, identifiersPresent: true, completionReceipt: false
  }
  action Claim(w: str): bool = all {
    Set("scheduled", "processing").contains(s.status), s.pc.get(w) == "idle", Head != None,
    { val p = Head
      all {
        Allowed(w, p), p == "export_revoke" or s.authority, s.owner.get(p) == None, s.phase.get(p) != "action_required", s.generation.get(p) < 3,
        s' = { ...s, status: if (p == "export_revoke") s.status else "processing", owner: s.owner.set(p, w), generation: s.generation.set(p, s.generation.get(p) + 1),
          phase: s.phase.set(p, if (Set("calling", "reconciling").contains(s.phase.get(p))) "reconciling" else "leased"),
          workerPhase: s.workerPhase.set(w, p), observed: s.observed.set(w, s.generation.get(p) + 1), pc: s.pc.set(w, "inspect") }
      }
    }
  }
  def Current(w: str): bool = s.generation.get(s.workerPhase.get(w)) == s.observed.get(w) and s.owner.get(s.workerPhase.get(w)) == w
  action Inspect(w: str): bool = all {
    s.pc.get(w) == "inspect",
    s' = { ...s, pc: s.pc.set(w, if (s.workerPhase.get(w) == "database_erasure") "finalize"
      else if (s.external.contains(s.workerPhase.get(w))) "confirm" else "start") }
  }
  action Start(w: str): bool = all {
    s.pc.get(w) == "start",
    { val p = s.workerPhase.get(w)
      if (Current(w) and s.phase.get(p) == "leased")
        s' = { ...s, phase: s.phase.set(p, "calling"), issued: s.issued.union(Set(p)), pc: s.pc.set(w, "execute") }
      else s' = { ...s, pc: s.pc.set(w, "retry") }
    }
  }
  action Execute(w: str): bool = all {
    s.pc.get(w) == "execute",
    s' = { ...s, external: s.external.union(Set(s.workerPhase.get(w))), pc: s.pc.set(w, "confirm") }
  }
  action Confirm(w: str): bool = all {
    s.pc.get(w) == "confirm",
    { val p = s.workerPhase.get(w)
      val allowed = Current(w) and s.external.contains(p) and s.authority and
        (p == "export_revoke" or s.status == "processing")
      s' = { ...s, pc: s.pc.set(w, "idle"),
        phase: if (allowed) s.phase.set(p, "completed") else s.phase,
        receipts: if (allowed) s.receipts.union(Set(p)) else s.receipts,
        owner: if (allowed) s.owner.set(p, None) else s.owner }
    }
  }
  action Retry(w: str): bool = all {
    Set("inspect", "execute", "retry").contains(s.pc.get(w)), s.faults < FaultBudget,
    { val p = s.workerPhase.get(w)
      val current = Current(w)
      s' = { ...s, faults: s.faults + 1, status: if (Set("scheduled", "processing").contains(s.status)) "processing" else s.status,
        pc: s.pc.set(w, "idle"), owner: if (current) s.owner.set(p, None) else s.owner,
        phase: if (current) s.phase.set(p, if (s.issued.contains(p)) "reconciling" else "retry") else s.phase }
    }
  }
  action Expire(p: str): bool = all {
    s.owner.get(p) != None, s.phase.get(p) != "completed", s.faults < FaultBudget,
    s' = { ...s, owner: s.owner.set(p, None), faults: s.faults + 1 }
  }
  action RequireAction(w: str): bool = all {
    s.pc.get(w) != "idle", Current(w), s.faults < FaultBudget,
    s' = { ...s, status: "action_required", faults: s.faults + 1, pc: s.pc.set(w, "idle"),
      phase: s.phase.set(s.workerPhase.get(w), "action_required"), owner: s.owner.set(s.workerPhase.get(w), None) }
  }
  action Finalize(w: str): bool = all {
    s.pc.get(w) == "finalize", Current(w), s.workerPhase.get(w) == "database_erasure",
    s.authority, s.soleOwner,
    Phases.exclude(Set("database_erasure")).forall(p => s.phase.get(p) == "completed"),
    s' = { ...s, status: "completed", identifiersPresent: false, completionReceipt: true,
      phase: s.phase.set("database_erasure", "completed"), receipts: s.receipts.union(Set("database_erasure")),
      owner: s.owner.set("database_erasure", None), pc: s.pc.set(w, "idle") }
  }
  action LoseAuthority = all { s.authority, s.faults < FaultBudget, s' = { ...s, authority: false, faults: s.faults + 1 } }
  action MembershipChanged = all { s.soleOwner, s.faults < FaultBudget, s' = { ...s, soleOwner: false, faults: s.faults + 1 } }
  action progressStep = any {
    { nondet w = Workers.oneOf()
      any { Claim(w), Inspect(w), Confirm(w), Finalize(w) } }, s' = s
  }
  action step = any {
    { nondet w = Workers.oneOf()
      any { Claim(w), Inspect(w), Start(w), Execute(w), Confirm(w), Retry(w), RequireAction(w), Finalize(w) } },
    { nondet p = Phases.oneOf()
      Expire(p) }, LoseAuthority, MembershipChanged, s' = s
  }
  val CompletionHasEveryReceipt = s.completionReceipt.implies(Phases.subseteq(s.receipts) and not(s.identifiersPresent))
  val ReceiptsStayOrdered = Ordered.indices().forall(i =>
    (s.phase.get(Ordered.nth(i)) == "completed").implies(Ordered.indices().filter(j => j < i).forall(j => s.phase.get(Ordered.nth(j)) == "completed")))
  // The initial state assumes an admission receipt. This checks its retention,
  // not live authority at adapter dispatch after a worker has claimed a phase.
  val RetainedAdmissionReceipt = s.receipts.contains("account_authority")
  val ReceiptMatchesPhase = Phases.forall(p => s.receipts.contains(p).iff(s.phase.get(p) == "completed"))
  val ErasureIsTerminal = (s.status == "completed").iff(s.completionReceipt)
  // Dedicated liveness lane assumes every provider effect is already visible,
  // stable authority, no expiry, and fair execution of local coordination steps.
  temporal FairProgress = Workers.forall(w => Claim(w).weakFair(s) and Inspect(w).weakFair(s) and Confirm(w).weakFair(s) and Finalize(w).weakFair(s))
  temporal CompletesVerifiedEffects = FairProgress.implies(eventually(s.completionReceipt))

  run retainedReceiptDoesNotImplyLiveAuthorityTest = init.then(LoseAuthority)
    .expect(RetainedAdmissionReceipt and not(s.authority))
}
module AccountDeletionOrder {
  import AccountDeletionOrderModel(InitialStatus = "scheduled", ExistingEffects = Set()).* from "./AccountDeletionOrder"
}
module AccountDeletionOrderProcessing {
  import AccountDeletionOrderModel(InitialStatus = "processing", ExistingEffects = Set(
    "export_revoke", "stripe", "domains", "spools", "secondary_backups", "compute_containers",
    "github_repositories", "connector_credentials", "voice_credentials", "primary_object_storage",
    "vault_key_bindings", "other_grants", "steward_deletion"
  )).* from "./AccountDeletionOrder"
}
module AccountDeletionOrderScheduled {
  import AccountDeletionOrderModel(InitialStatus = "scheduled", ExistingEffects = Set(
    "export_revoke", "stripe", "domains", "spools", "secondary_backups", "compute_containers",
    "github_repositories", "connector_credentials", "voice_credentials", "primary_object_storage",
    "vault_key_bindings", "other_grants", "steward_deletion"
  )).* from "./AccountDeletionOrder"
}
