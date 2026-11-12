// A browser Google return that arrives in a process that did not start the
// sign-in (CloudSignInPlugin.captureCallback, adoptReturn; the host's durable
// credential generation, CredentialIntentFence.attach/generation/adopt).
// The pending record carries the generation recorded when its attempt reserved
// its credential intent. A later process completes the return only while that
// generation is still the recorded one: no credential action was reserved
// since, in any process. Adoption reserves nothing.
module NativeAndroidReturnAdoption {
  type State = {
    // Durable: the ledger's generation and the pending record (0: no generation).
    ledger: int, record: bool, recordGeneration: int, recordExpired: bool,
    // This process: its intents, whether it holds a ledger, the adopted owner.
    hasLedger: bool, epoch: int, processes: int, attemptActive: bool,
    adoptedAt: int, phase: str,
    // History.
    actionsSinceRecord: int, completions: int, completedAfterAction: bool
  }
  var s: State

  // The first process: a host with or without a durable generation reserved the
  // attempt's intent and wrote the pending record.
  action init = any {
    s' = { ledger: 1, record: true, recordGeneration: 1, recordExpired: false,
      hasLedger: true, epoch: 1, processes: 1, attemptActive: true, adoptedAt: -1,
      phase: "waiting", actionsSinceRecord: 0, completions: 0,
      completedAfterAction: false },
    s' = { ledger: 0, record: true, recordGeneration: 0, recordExpired: false,
      hasLedger: false, epoch: 1, processes: 1, attemptActive: true, adoptedAt: -1,
      phase: "waiting", actionsSinceRecord: 0, completions: 0,
      completedAfterAction: false }
  }

  // Android ends the host while the browser is in front. Only durable state stays.
  action processDeath = all {
    s.processes < 3,
    s' = { ...s, processes: s.processes + 1, epoch: 0, attemptActive: false, adoptedAt: -1,
      phase: "waiting" }
  }

  // Any credential action (sign-out, another sign-in, a provider change, a
  // reset) reserves an intent and records a new generation. A sign-out or a
  // completed sign-in also removes the pending record.
  action credentialAction(removesRecord: bool): bool = all {
    s.epoch < 3,
    s' = { ...s, epoch: s.epoch + 1, ledger: if (s.hasLedger) s.ledger + 1 else s.ledger,
      actionsSinceRecord: s.actionsSinceRecord + 1,
      record: s.record and not(removesRecord) }
  }
  action recordExpires = all { s.record, not(s.recordExpired), s' = { ...s, recordExpired: true } }

  // The return, with the matching state, in a process that has no attempt for it.
  action returnArrives = all {
    s.processes > 1, s.phase == "waiting", not(s.attemptActive),
    s' = if (s.record and s.recordGeneration != 0 and not(s.recordExpired) and s.hasLedger
          and s.recordGeneration == s.ledger)
        { ...s, adoptedAt: s.epoch, attemptActive: true, phase: "adopted" }
      else { ...s, phase: "finished" }
  }
  // The record is consumed, then the key is saved; each under the adopted intent.
  action consume = all {
    s.phase == "adopted",
    s' = if (s.adoptedAt == s.epoch and s.record) { ...s, record: false, phase: "consumed" }
      else { ...s, attemptActive: false, phase: "finished" }
  }
  action save = all {
    s.phase == "consumed",
    s' = if (s.adoptedAt == s.epoch)
        { ...s, attemptActive: false, phase: "finished", completions: s.completions + 1,
          completedAfterAction: s.completedAfterAction or s.actionsSinceRecord > 0 }
      else { ...s, attemptActive: false, phase: "finished" }
  }

  action idle = s' = s
  action step = any {
    processDeath,
    nondet removes = Set(true, false).oneOf()
    credentialAction(removes),
    recordExpires, returnArrives, consume, save, idle
  }

  // A return completes only when no credential action was reserved after its record was written.
  val CompletesOnlyWithoutNewerAction = not(s.completedAfterAction)
  // A record is completed at most once.
  val SingleUse = s.completions.in(Set(0, 1))
  // A host without a durable generation never completes a return in a new process.
  val NoLedgerNoCompletion = (s.recordGeneration == 0).implies(s.completions == 0)
  // An adopted return is bound to an intent of its own process; it reserved none.
  val AdoptedOwnerBound =
    (s.phase.in(Set("adopted", "consumed"))).implies(s.adoptedAt >= 0 and s.adoptedAt <= s.epoch and s.attemptActive)
  val Bounds = s.epoch.in(0.to(3)) and s.processes.in(1.to(3))

  action initDurable = s' = { ledger: 1, record: true, recordGeneration: 1, recordExpired: false,
    hasLedger: true, epoch: 1, processes: 1, attemptActive: true, adoptedAt: -1,
    phase: "waiting", actionsSinceRecord: 0, completions: 0,
    completedAfterAction: false }

  run returnAfterProcessDeathCompletesTest = initDurable.then(processDeath).then(returnArrives)
    .then(consume).then(save)
    .expect(s.completions == 1 and not(s.record) and s.epoch == 0)

  run signOutInBetweenRefusesTest = initDurable.then(processDeath).then(credentialAction(false))
    .then(returnArrives).expect(s.phase == "finished" and s.completions == 0 and s.record)

  run actionInAnEarlierProcessRefusesTest = initDurable.then(processDeath)
    .then(credentialAction(false)).then(processDeath).then(returnArrives)
    .expect(s.phase == "finished" and s.completions == 0)

  run actionAfterAdoptionWinsTest = initDurable.then(processDeath).then(returnArrives)
    .then(consume).then(credentialAction(false)).then(save)
    .expect(s.completions == 0 and s.phase == "finished")

  run repeatedReturnFindsNoRecordTest = initDurable.then(processDeath).then(returnArrives)
    .then(consume).then(save).then(processDeath).then(returnArrives)
    .expect(s.completions == 1 and s.phase == "finished")
}
