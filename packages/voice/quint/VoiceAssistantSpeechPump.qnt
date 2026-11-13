// One voice turn with an optional streamed prefix. Host callbacks and pump continuations are separate
// steps. Sentence IDs denote their positions in the ordered spoken plan.
module VoiceAssistantSpeechPump {
  pure val Sentences = Set(1, 2, 3)
  pure val Pending = Set("queued", "audible")
  pure val Ended = Set("completed", "failed")
  type State = {
    plan: int, handed: int, played: int, confirmed: bool, started: bool,
    failure: int, calls: int -> str, outcome: str,
    heardReceipt: int, unheardReceipt: int, reopened: bool,
  }

  var s: State

  action init = s' = {
    plan: 0, handed: 0, played: 0, confirmed: false, started: false,
    failure: 0, calls: Sentences.mapBy(_ => "unhanded"), outcome: "owned",
    heardReceipt: -1, unheardReceipt: -1, reopened: false,
  }

  val owned = s.outcome == "owned"
  val pending = Sentences.filter(id => Pending.contains(s.calls.get(id)))
  val canceled = Set("interrupted", "failed").contains(s.outcome)

  pure def earlierEnded(calls: int -> str, id: int): bool =
    Sentences.filter(other => other < id).forall(other => Ended.contains(calls.get(other)))

  // Direct model frames add a matching prefix, even while the pump waits for
  // existing playback. The confirmed reply supplies the remaining suffix.
  action streamPrefix(total: int): bool = all {
    owned and not(s.confirmed) and s.failure == 0,
    total <= 2 and total == s.plan + 1,
    s' = { ...s, plan: total },
  }

  action confirm(total: int): bool = all {
    owned and not(s.confirmed) and total >= s.plan and total >= 2,
    s' = { ...s, confirmed: true, plan: total },
  }

  action handoff(id: int): bool = all {
    owned and s.failure == 0,
    id == s.handed + 1 and id <= s.plan,
    if (id == 1) true else Set("audible", "completed").contains(s.calls.get(id - 1)),
    s' = { ...s, handed: id, calls: s.calls.set(id, "queued") },
  }

  action hostStarts(id: int): bool = all {
    owned and s.calls.get(id) == "queued",
    earlierEnded(s.calls, id),
    s' = { ...s, started: true, calls: s.calls.set(id, "audible") },
  }

  action hostCompletes(id: int): bool = all {
    owned and pending.contains(id),
    earlierEnded(s.calls, id),
    s' = {
      ...s, calls: s.calls.set(id, "completed"),
      played: if (id == s.played + 1) id else s.played,
    },
  }

  // The current playback fails while a later call may already be queued.
  // Its promise can still settle before the failure continuation runs.
  action hostFails(id: int): bool = all {
    owned and s.confirmed and s.failure == 0 and pending.contains(id),
    earlierEnded(s.calls, id),
    s' = { ...s, failure: id, calls: s.calls.set(id, "failed") },
  }

  pure def receipt(previous: State, outcome: str): State = {
    ...previous, outcome: outcome,
    heardReceipt: previous.played, unheardReceipt: previous.plan - previous.played,
  }

  action finishReply = all {
    owned and s.confirmed and s.failure == 0 and s.played == s.plan,
    s' = receipt(s, "complete"),
  }

  action reportFailure = all {
    owned and s.confirmed and s.failure != 0,
    s' = receipt(s, "failed"),
  }

  action interrupt = all {
    owned and s.confirmed and s.started,
    s' = receipt(s, "interrupted"),
  }

  // After cancellation an old host promise may reject or fulfil. It only
  // drains its own call and cannot advance the heard prefix or emit a receipt.
  action retirePlayback(id: int): bool = all {
    canceled and pending.contains(id),
    s' = { ...s, calls: s.calls.set(id, "retired") },
  }

  action reopen = all {
    Set("complete", "interrupted").contains(s.outcome),
    pending == Set() and not(s.reopened),
    s' = { ...s, reopened: true },
  }

  action step = any {
    { nondet id = Sentences.oneOf() streamPrefix(id) },
    { nondet id = Sentences.oneOf() confirm(id) },
    { nondet id = Sentences.oneOf() handoff(id) },
    { nondet id = Sentences.oneOf() hostStarts(id) },
    { nondet id = Sentences.oneOf() hostCompletes(id) },
    { nondet id = Sentences.oneOf() hostFails(id) },
    { nondet id = Sentences.oneOf() retirePlayback(id) },
    finishReply, reportFailure, interrupt, reopen, s' = s,
  }

  val InOrderAndAtMostTwoCalls = and {
    pending.size() <= 2,
    s.handed <= s.plan,
    Sentences.forall(id => (s.calls.get(id) != "unhanded") == (id <= s.handed)),
  }

  val HeardIsCompletedPrefix = s.played == Sentences.filter(id =>
    Sentences.filter(other => other <= id).forall(other => s.calls.get(other) == "completed")
  ).size()

  val TruthfulTerminalReceipt = and {
    owned implies s.heardReceipt == -1 and s.unheardReceipt == -1,
    not(owned) implies s.heardReceipt == s.played and s.unheardReceipt == s.plan - s.played,
    s.outcome == "complete" implies s.confirmed and s.handed == s.plan and s.played == s.plan,
    s.reopened implies pending == Set() and Set("complete", "interrupted").contains(s.outcome),
  }

  temporal TerminalCannotAdoptLateCallbacks = always((
    not(owned) implies next(s.outcome) == s.outcome and next(s.handed) == s.handed
      and next(s.heardReceipt) == s.heardReceipt and next(s.unheardReceipt) == s.unheardReceipt
  ).orKeep(s))

  temporal ConfirmedWorkSettles = and {
    (owned and s.confirmed).leadsTo(not(owned)),
    (canceled and pending != Set()).leadsTo(pending == Set()),
    Set("complete", "interrupted").contains(s.outcome).leadsTo(s.reopened),
  }

  temporal UnderFairPumpAndHostReceipts = and {
    Sentences.forall(id => handoff(id).weakFair(s) and hostCompletes(id).weakFair(s)
      and retirePlayback(id).weakFair(s)),
    finishReply.weakFair(s), reportFailure.weakFair(s), reopen.weakFair(s),
  } implies ConfirmedWorkSettles

  run LateFrameAndConfirmedSuffixTest = init
    .then(streamPrefix(1)).then(handoff(1)).then(hostStarts(1))
    .then(streamPrefix(2)).then(handoff(2)).then(confirm(3))
    .expect(s.handed == 2 and s.plan == 3 and InOrderAndAtMostTwoCalls)
    .then(hostCompletes(1)).then(hostStarts(2)).then(handoff(3))
    .then(hostCompletes(2)).then(hostCompletes(3)).then(finishReply).then(reopen)
    .expect(s.heardReceipt == 3 and s.unheardReceipt == 0 and s.reopened)

  run InterruptWaitsForQueuedDrainTest = init
    .then(confirm(3)).then(handoff(1)).then(hostStarts(1)).then(handoff(2))
    .then(hostCompletes(1)).then(hostStarts(2)).then(handoff(3)).then(interrupt)
    .expect(s.heardReceipt == 1 and s.unheardReceipt == 2 and not(s.reopened))
    .then(retirePlayback(2)).then(retirePlayback(3)).then(reopen)
    .expect(s.reopened and TruthfulTerminalReceipt)

  run EarlierFailureDoesNotWaitForQueuedStartTest = init
    .then(confirm(2)).then(handoff(1)).then(hostStarts(1)).then(handoff(2))
    .then(hostFails(1)).then(reportFailure)
    .expect(s.outcome == "failed" and pending == Set(2) and s.heardReceipt == 0)
    .then(retirePlayback(2)).expect(not(s.reopened) and pending == Set())

  run QueuedCompletionCannotFillFailedGapTest = init
    .then(confirm(2)).then(handoff(1)).then(hostStarts(1)).then(handoff(2))
    .then(hostFails(1)).then(hostStarts(2)).then(hostCompletes(2)).then(reportFailure)
    .expect(s.heardReceipt == 0 and s.unheardReceipt == 2 and HeardIsCompletedPrefix)
}
