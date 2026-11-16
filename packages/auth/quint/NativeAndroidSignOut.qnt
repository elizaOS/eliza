// Sign-out of one deployment and the stored duty to end its key (CloudSignInPlugin.signOut,
// signedOut, retireReplaced, retryRetirement, retireStored). The duty is stored before the key
// leaves its slot; the key, its receipt and the pending record are removed; Cloud is asked to end
// the key at once, twice more in this process and on every later start until it answers (2xx or
// 401) or the key lapses. A damaged saved record is removed with nothing owed. The process can end
// at any point; a newer sign-in can follow the removal. Without the lock between storing the duty
// and removing the key, the start-up check could drop the duty of a key it still saw saved.
module NativeAndroidSignOut {
  pure val Mine = 1
  pure val Newer = 2
  pure val Damaged = 3
  pure val Retries = 2

  type State = {
    initial: int, saved: int, receipt: bool, attempt: str, duty: int,
    step: str, removedMine: bool, retries: int,
    mine: str, newer: str, lapsed: bool, result: str
  }
  var s: State

  action start(saved: int): bool = s' = {
    initial: saved, saved: saved, receipt: true, attempt: "running", duty: 0,
    step: "idle", removedMine: false, retries: 0,
    mine: "active", newer: "absent", lapsed: false, result: "none"
  }
  action init = { nondet saved = Set(Mine, Damaged).oneOf() start(saved) }

  pure def accepts(x: State): bool = x.mine == "active" and not(x.lapsed)
  // Cloud's answer to a bare self-revocation of the signed-out key: 2xx ends it, 401 says it is
  // already ended or lapsed, and no answer leaves it as it was.
  pure def answered(x: State, answer: str): bool =
    answer == "ok" or (answer == "refused" and not(accepts(x)))
  pure def ended(x: State): State = { ...x, mine: "ended", duty: if (x.duty == Mine) 0 else x.duty }

  action signOut = all {
    s.step.in(Set("idle", "restarted")), s.saved.in(Set(Mine, Damaged)),
    s' = { ...s, attempt: if (s.attempt == "running") "cancelled" else s.attempt, step: "storing" },
  }
  action storeDuty = all {
    s.step == "storing",
    s' = { ...s, duty: if (s.saved == Mine) Mine else s.duty, step: "removing" },
  }
  action remove = all {
    s.step == "removing",
    s' = { ...s, removedMine: s.removedMine or s.saved == Mine, saved: 0, receipt: false, step: "asking" },
  }
  action ask(answer: str): bool = all {
    s.step == "asking", answer != "refused" or not(accepts(s)),
    s' = if (not(s.removedMine)) { ...s, step: "answered", result: "signed-out" }
      else if (answered(s, answer)) { ...ended(s), step: "answered", result: "revoked" }
      else { ...s, step: "answered", retries: Retries, result: "unconfirmed" },
  }
  action retry(answer: str): bool = all {
    s.retries > 0, answer != "refused" or not(accepts(s)),
    s' = if (answered(s, answer)) { ...ended(s), retries: 0 } else { ...s, retries: s.retries - 1 },
  }
  // The process ends: the in-memory retries and any unfinished sign-out step are lost.
  action restart = all {
    s.step != "restarted" or s.retries > 0,
    s' = { ...s, step: "restarted", retries: 0 },
  }
  // On load and with the hourly check. A duty for the key that is still saved or that has lapsed is
  // dropped without a request. It reads the duty and the saved key under the lock (`duties`) a
  // sign-out holds from storing its duty to removing the key.
  action retireStored(answer: str): bool = all {
    s.duty == Mine, s.step != "removing", answer != "refused" or not(accepts(s)),
    s' = if (s.saved == Mine or s.lapsed) { ...s, duty: 0 }
      else if (answered(s, answer)) ended(s)
      else s,
  }
  action newerSignIn = all {
    s.saved == 0, s.step.in(Set("answered", "restarted")), s.newer == "absent",
    s' = { ...s, saved: Newer, receipt: true, newer: "active" },
  }
  action lapse = all { not(s.lapsed), s' = { ...s, lapsed: true } }

  action step = any {
    signOut, storeDuty, remove,
    nondet answer = Set("ok", "refused", "none").oneOf()
    any { ask(answer), retry(answer), retireStored(answer) },
    restart, newerSignIn, lapse,
  }

  // A key the owner signed out of that Cloud may still accept is owed: its duty is stored.
  val OwedUntilEnded = (s.removedMine and accepts(s)).implies(s.duty == Mine)
  // Nothing is sent for the key that is still saved.
  val SavedKeyKept = (s.saved == Mine).implies(s.mine == "active")
  // A newer sign-in's key is never ended by this sign-out.
  val NewerKeyKept = s.newer != "ended"
  // A damaged saved record owes nothing.
  val DamagedOwesNothing = (s.initial == Damaged).implies(s.duty == 0 and not(s.removedMine))
  // Signing out ends the sign-in in progress.
  val AttemptEnded = s.step.in(Set("storing", "removing", "asking", "answered")).implies(s.attempt != "running")
  // The key goes with its receipt and the pending record.
  val RemovedTogether = s.step.in(Set("asking", "answered")).implies(s.saved != Mine and s.saved != Damaged and (s.saved == Newer or not(s.receipt)))
  // Revoked is reported only once Cloud no longer accepts the key.
  val RevokedMeansEnded = (s.result == "revoked").implies(not(accepts(s)))
  val RetryBudget = s.retries.in(0.to(Retries))

  run onlineSignOutTest = start(Mine).then(signOut).then(storeDuty).then(remove).then(ask("ok"))
    .expect(s.result == "revoked" and s.duty == 0 and s.saved == 0 and not(s.receipt) and s.mine == "ended")

  run offlineSignOutEndsOnNextStartTest = start(Mine).then(signOut).then(storeDuty).then(remove)
    .then(ask("none")).then(retry("none")).then(restart).then(retireStored("ok"))
    .expect(s.result == "unconfirmed" and s.duty == 0 and s.mine == "ended" and s.saved == 0)

  run alreadyEndedKeyIsSettledTest = start(Mine).then(signOut).then(storeDuty).then(remove)
    .then(ask("none")).then(lapse).then(restart).then(retireStored("refused"))
    .expect(s.duty == 0 and not(accepts(s)))

  run damagedRecordOwesNothingTest = start(Damaged).then(signOut).then(storeDuty).then(remove).then(ask("none"))
    .expect(s.saved == 0 and s.duty == 0 and s.result == "signed-out" and s.retries == 0)

  run interruptedBeforeRemovalKeepsKeyTest = start(Mine).then(signOut).then(storeDuty).then(restart)
    .then(retireStored("ok"))
    .expect(s.saved == Mine and s.duty == 0 and s.mine == "active")

  run newerSignInKeepsItsKeyTest = start(Mine).then(signOut).then(storeDuty).then(remove).then(ask("none"))
    .then(newerSignIn).then(restart).then(retireStored("ok"))
    .expect(s.saved == Newer and s.newer == "active" and s.mine == "ended" and s.duty == 0)
}
