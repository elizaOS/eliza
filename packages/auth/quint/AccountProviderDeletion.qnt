// Provider inventory preflight and commit each take the credential lock.
// A writer may run between the two calls. Commit validates the entire plan
// before the first unlink. A second-unlink failure compensates under the lock.
module AccountProviderDeletion {
  val targets = Set(1, 2, 3)
  val files = targets.union(Set(4))
  type Artifact = { bytes: int, fingerprint: int }
  type Store = int -> Artifact
  type State = {
    current: Store, plan: Store, baseline: Store,
    badEntry: bool, mutated: bool, attempts: int,
    phase: str, outcome: str, removed: Set[int], count: int,
  }
  val absent = { bytes: 0, fingerprint: 0 }
  val initial = files.mapBy(id => if (id == 3) absent else { bytes: id, fingerprint: id })
  val empty = files.mapBy(_ => absent)
  var s: State

  pure def inventory(store: Store): Set[int] = targets.filter(id => store.get(id) != absent)
  pure def sameTargets(plan: Store, current: Store): bool =
    inventory(plan).forall(id => plan.get(id).fingerprint == current.get(id).fingerprint)

  action start(badEntry: bool): bool = s' = {
    current: initial, plan: empty, baseline: initial, badEntry: badEntry,
    mutated: false, attempts: 0, phase: "idle", outcome: "none", removed: Set(), count: 0,
  }
  action init = any { start(true), start(false) }

  action preflight = all {
    s.phase == "idle" or (s.phase == "done" and s.outcome != "deleted"),
    s.attempts < 2,
    s' = {
      ...s, attempts: s.attempts + 1, baseline: s.current,
      plan: if (s.badEntry) empty else s.current, removed: Set(), count: 0,
      phase: if (s.badEntry) "done" else "prepared",
      outcome: if (s.badEntry) "invalid-account-id" else "pending",
    },
  }
  action abandon = all {
    s.phase == "prepared",
    s' = { ...s, phase: "done", outcome: "abandoned", baseline: s.current },
  }

  // These separate locked calls cannot run while commit owns the lock.
  action replaceFile(id: int): bool = all {
    s.phase == "prepared", not(s.mutated), inventory(s.current).contains(id),
    s' = { ...s, current: s.current.set(id, { bytes: 5, fingerprint: 5 }), mutated: true },
  }
  action addAccount = all {
    s.phase == "prepared", not(s.mutated), s.current.get(3) == absent,
    s' = { ...s, current: s.current.set(3, { bytes: 3, fingerprint: 3 }), mutated: true },
  }
  action removeAccount(id: int): bool = all {
    s.phase == "prepared", not(s.mutated), inventory(s.current).contains(id),
    s' = { ...s, current: s.current.set(id, absent), mutated: true },
  }

  action validate = {
    val result = if (inventory(s.plan) != inventory(s.current)) "inventory-changed"
      else if (not(sameTargets(s.plan, s.current))) "target-changed" else "pending"
    all {
      s.phase == "prepared",
      s' = {
        ...s, baseline: s.current, outcome: result,
        phase: if (result == "pending") "unlinking" else "done",
      },
    }
  }
  val remaining = inventory(s.plan).exclude(s.removed)
  action unlink(id: int): bool = all {
    s.phase == "unlinking", remaining.contains(id),
    s' = { ...s, current: s.current.set(id, absent), removed: s.removed.union(Set(id)) },
  }
  action failSecondUnlink = all {
    s.phase == "unlinking", s.removed.size() == 1, remaining.size() > 0,
    s' = { ...s, phase: "rollback" },
  }
  action restore(id: int, sameFingerprint: bool): bool = all {
    s.phase == "rollback", s.removed.contains(id),
    s' = {
      ...s, phase: "done", outcome: "transaction-failed",
      current: s.current.set(id, {
        bytes: s.plan.get(id).bytes,
        fingerprint: if (sameFingerprint) s.plan.get(id).fingerprint else id + 5,
      }),
    },
  }
  // The result is published only after all required directory syncs succeed.
  action confirm = all {
    s.phase == "unlinking", remaining.size() == 0,
    s' = { ...s, phase: "done", outcome: "deleted", count: s.removed.size() },
  }
  action commitWork = any {
    { nondet id = targets.oneOf() unlink(id) },
    failSecondUnlink,
    { nondet id = targets.oneOf() nondet same = Set(true, false).oneOf() restore(id, same) },
    confirm,
  }
  action step = any {
    preflight, abandon, validate, commitWork, addAccount,
    { nondet id = targets.oneOf() replaceFile(id) },
    { nondet id = targets.oneOf() removeAccount(id) },
    s' = s,
  }

  val TypeOK = and {
    s.current.keys() == files, s.plan.keys() == files, s.baseline.keys() == files,
    s.attempts.in(0.to(2)), s.count.in(0.to(3)), s.removed.subseteq(targets),
    s.phase.in(Set("idle", "prepared", "unlinking", "rollback", "done")),
    s.outcome.in(Set("none", "pending", "invalid-account-id", "abandoned",
      "inventory-changed", "target-changed", "transaction-failed", "deleted")),
  }
  val OutsideProviderUntouched = s.current.get(4) == initial.get(4)
  val RefusedPlanRetainsFiles =
    s.outcome.in(Set("invalid-account-id", "abandoned", "inventory-changed", "target-changed"))
      .implies(s.current == s.baseline and s.removed.size() == 0 and s.count == 0)
  val CompleteValidationBeforeUnlink =
    (s.phase.in(Set("unlinking", "rollback")) or s.outcome.in(Set("deleted", "transaction-failed")))
      .implies(inventory(s.plan) == inventory(s.baseline) and sameTargets(s.plan, s.baseline))
  val UnlinksStayInsidePlan = s.removed.subseteq(inventory(s.plan))
  val SuccessConfirmsExactlyPlan = (s.outcome == "deleted")
    .implies(inventory(s.current).size() == 0 and s.count == inventory(s.plan).size())
  val RollbackRestoresCiphertext = (s.outcome == "transaction-failed").implies(
    s.removed.size() == 1 and s.count == 0 and
      files.forall(id => s.current.get(id).bytes == s.baseline.get(id).bytes))

  temporal AdmittedCommitSettles = commitWork.weakFair(s) implies
    always(s.phase.in(Set("unlinking", "rollback")).implies(eventually(s.phase == "done")))

  run invalidProviderInventoryDoesNotDeleteTest = start(true).then(preflight)
    .expect(s.outcome == "invalid-account-id" and s.current == initial and RefusedPlanRetainsFiles)
  run changedTargetRejectsThenFreshPlanSucceedsTest = start(false).then(preflight)
    .then(replaceFile(2)).then(validate)
    .expect(s.outcome == "target-changed" and RefusedPlanRetainsFiles)
    .then(preflight).then(validate).then(unlink(1)).then(unlink(2)).then(confirm)
    .expect(s.count == 2 and SuccessConfirmsExactlyPlan and OutsideProviderUntouched)
  run newAccountRejectsStaleInventoryTest = start(false).then(preflight).then(addAccount).then(validate)
    .expect(s.outcome == "inventory-changed" and RefusedPlanRetainsFiles)
  run secondUnlinkFailureRestoresFirstTest = start(false).then(preflight).then(validate)
    .then(unlink(1)).then(failSecondUnlink).then(restore(1, false))
    .expect(s.outcome == "transaction-failed" and s.current.get(1).bytes == 1 and RollbackRestoresCiphertext)
}
