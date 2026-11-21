// Sign-out of one deployment and the stored duties to end its keys (CloudSignInPlugin.signOut,
// signedOut, owedAbove, retireReplaced, retryRetirement, retireStored, retireOwed). The duty is stored
// above the duties still owed before the key leaves its slot; the key, its receipt and the pending
// record are removed; Cloud is asked to end the key at once, twice more in this process and on every
// later start until it answers (2xx or 401) or the key lapses. A damaged saved record is removed with
// nothing owed. The process can end at any point; a newer sign-in can follow the removal and be signed
// out of in turn while the first key is still owed. Without the lock between storing the duty and
// removing the key, the start-up check could drop the duty of a key it still saw saved.
module NativeAndroidSignOut {
  pure val First = 1
  pure val Second = 2
  pure val Damaged = 3
  pure val Keys = Set(First, Second)
  pure val Retries = 2

  type State = {
    initial: int, saved: int, receipt: bool, attempt: str, owed: Set[int],
    step: str, out: int, removed: Set[int], retries: int -> int,
    status: int -> str, lapsed: Set[int], result: str
  }
  var s: State

  action start(saved: int): bool = s' = {
    initial: saved, saved: saved, receipt: true, attempt: "running", owed: Set(),
    step: "idle", out: 0, removed: Set(), retries: Keys.mapBy(_ => 0),
    status: Keys.mapBy(k => if (k == saved) "active" else "absent"), lapsed: Set(), result: "none"
  }
  action init = { nondet saved = Set(First, Damaged).oneOf() start(saved) }

  pure def accepts(x: State, k: int): bool = x.status.get(k) == "active" and not(x.lapsed.contains(k))
  // Cloud's answer to a bare self-revocation of a signed-out key: 2xx ends it, 401 says it is
  // already ended or lapsed, and no answer leaves it as it was.
  pure def answered(x: State, k: int, answer: str): bool =
    answer == "ok" or (answer == "refused" and not(accepts(x, k)))
  pure def ended(x: State, k: int): State =
    { ...x, status: x.status.set(k, "ended"), owed: x.owed.exclude(Set(k)), retries: x.retries.set(k, 0) }
  pure def honest(x: State, k: int, answer: str): bool = answer != "refused" or not(accepts(x, k))

  action signOut = all {
    s.step.in(Set("idle", "restarted", "answered")), s.saved.in(Set(First, Second, Damaged)),
    s' = { ...s, attempt: if (s.attempt == "running") "cancelled" else s.attempt, step: "storing", out: s.saved, result: "none" },
  }
  // owedAbove: the new duty goes above the duties still owed, without those that have lapsed.
  action storeDuty = all {
    s.step == "storing",
    s' = { ...s, owed: if (Keys.contains(s.out)) s.owed.filter(k => not(s.lapsed.contains(k))).union(Set(s.out)) else s.owed, step: "removing" },
  }
  action remove = all {
    s.step == "removing",
    s' = { ...s, removed: if (Keys.contains(s.out)) s.removed.union(Set(s.out)) else s.removed, saved: 0, receipt: false, step: "asking" },
  }
  action ask(answer: str): bool = all {
    s.step == "asking", if (Keys.contains(s.out)) honest(s, s.out, answer) else true,
    s' = if (not(Keys.contains(s.out))) { ...s, step: "answered", result: "signed-out" }
      else if (answered(s, s.out, answer)) { ...ended(s, s.out), step: "answered", result: "revoked" }
      else { ...s, step: "answered", retries: s.retries.set(s.out, Retries), result: "unconfirmed" },
  }
  action retry(k: int, answer: str): bool = all {
    s.retries.get(k) > 0, honest(s, k, answer),
    s' = if (answered(s, k, answer)) ended(s, k) else { ...s, retries: s.retries.set(k, s.retries.get(k) - 1) },
  }
  // The process ends: the in-memory retries and any unfinished sign-out step are lost.
  action restart = all {
    s.step != "restarted" or Keys.exists(k => s.retries.get(k) > 0),
    s' = { ...s, step: "restarted", retries: Keys.mapBy(_ => 0) },
  }
  // On load and with the hourly check, newest first, each duty in turn. A duty for the key that is
  // still saved or that has lapsed is dropped without a request. It reads the duty and the saved key
  // under the lock (`duties`) a sign-out holds from storing its duty to removing the key.
  action retireStored(k: int, answer: str): bool = all {
    s.owed.contains(k), s.step != "removing", honest(s, k, answer),
    s' = if (s.saved == k or s.lapsed.contains(k)) { ...s, owed: s.owed.exclude(Set(k)) }
      else if (answered(s, k, answer)) ended(s, k)
      else s,
  }
  action newerSignIn = all {
    s.saved == 0, s.step.in(Set("answered", "restarted")), s.status.get(Second) == "absent",
    s' = { ...s, saved: Second, receipt: true, status: s.status.set(Second, "active") },
  }
  action lapse(k: int): bool = all { s.status.get(k) != "absent", not(s.lapsed.contains(k)), s' = { ...s, lapsed: s.lapsed.union(Set(k)) } }

  action step = any {
    signOut, storeDuty, remove,
    nondet answer = Set("ok", "refused", "none").oneOf()
    nondet k = Keys.oneOf()
    any { ask(answer), retry(k, answer), retireStored(k, answer), lapse(k) },
    restart, newerSignIn,
  }

  // A key the owner signed out of that Cloud may still accept is owed: its duty is stored, also
  // after a later sign-out stored its own.
  val OwedUntilEnded = Keys.forall(k => (s.removed.contains(k) and accepts(s, k)).implies(s.owed.contains(k)))
  // Nothing is sent for the key that is still saved.
  val SavedKeyKept = Keys.forall(k => (s.saved == k).implies(s.status.get(k) == "active"))
  // A newer sign-in's key is never ended by an earlier sign-out.
  val NewerKeyKept = not(s.removed.contains(Second)).implies(s.status.get(Second) != "ended")
  // Only a key the owner signed out of is ended.
  val OnlySignedOutKeysEnd = Keys.forall(k => (s.status.get(k) == "ended").implies(s.removed.contains(k)))
  // A damaged saved record owes nothing.
  val DamagedOwesNothing = (s.initial == Damaged).implies(not(s.owed.contains(First)) and not(s.removed.contains(First)))
  // Signing out ends the sign-in in progress.
  val AttemptEnded = s.step.in(Set("storing", "removing", "asking", "answered")).implies(s.attempt != "running")
  // The key goes with its receipt and the pending record.
  val RemovedTogether = s.step.in(Set("asking", "answered")).implies(s.saved != s.out and (s.saved != 0 or not(s.receipt)))
  // Revoked is reported only once Cloud no longer accepts the key.
  val RevokedMeansEnded = (s.result == "revoked").implies(not(accepts(s, s.out)))
  val RetryBudget = Keys.forall(k => s.retries.get(k).in(0.to(Retries)))

  // Every stored duty is settled once restarts stop cutting the sign-out short and Cloud answers the
  // start-up check.
  temporal DutiesSettle =
    (storeDuty.strongFair(s) and remove.strongFair(s) and Keys.forall(k => retireStored(k, "ok").strongFair(s)))
      .implies(always((s.owed != Set()).implies(eventually(s.owed == Set()))))

  run onlineSignOutTest = start(First).then(signOut).then(storeDuty).then(remove).then(ask("ok"))
    .expect(s.result == "revoked" and s.owed == Set() and s.saved == 0 and not(s.receipt) and s.status.get(First) == "ended")

  run offlineSignOutEndsOnNextStartTest = start(First).then(signOut).then(storeDuty).then(remove)
    .then(ask("none")).then(retry(First, "none")).then(restart).then(retireStored(First, "ok"))
    .expect(s.result == "unconfirmed" and s.owed == Set() and s.status.get(First) == "ended" and s.saved == 0)

  run alreadyEndedKeyIsSettledTest = start(First).then(signOut).then(storeDuty).then(remove)
    .then(ask("none")).then(lapse(First)).then(restart).then(retireStored(First, "refused"))
    .expect(s.owed == Set() and not(accepts(s, First)))

  run damagedRecordOwesNothingTest = start(Damaged).then(signOut).then(storeDuty).then(remove).then(ask("none"))
    .expect(s.saved == 0 and s.owed == Set() and s.result == "signed-out" and s.retries.get(First) == 0)

  run interruptedBeforeRemovalKeepsKeyTest = start(First).then(signOut).then(storeDuty).then(restart)
    .then(retireStored(First, "ok"))
    .expect(s.saved == First and s.owed == Set() and s.status.get(First) == "active")

  run newerSignInKeepsItsKeyTest = start(First).then(signOut).then(storeDuty).then(remove).then(ask("none"))
    .then(newerSignIn).then(restart).then(retireStored(First, "ok"))
    .expect(s.saved == Second and s.status.get(Second) == "active" and s.status.get(First) == "ended" and s.owed == Set())

  run secondSignOutKeepsFirstDutyTest = start(First).then(signOut).then(storeDuty).then(remove).then(ask("none"))
    .then(newerSignIn).then(signOut).then(storeDuty).then(remove).then(ask("none"))
    .then(restart).then(retireStored(Second, "ok")).then(retireStored(First, "ok"))
    .expect(s.owed == Set() and s.status.get(First) == "ended" and s.status.get(Second) == "ended" and s.saved == 0)
}
