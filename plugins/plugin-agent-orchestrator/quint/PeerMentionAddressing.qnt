// createActiveSessionForwardHandler
// (plugins/plugin-agent-orchestrator/src/services/active-session-forward.ts)
// hands a user message posted in a task room to every live sub-agent bound to
// that room. For each sub-agent it asks decideInterruptionWithModel
// (src/services/interruption-decider.ts) whether to cancel the running turn,
// deliver the message now, queue it for after the turn, or ignore it. When
// the classifier model gives no usable verdict, decideInterruption decides
// from the text. A room with more than one bound sub-agent is crowded: a
// message there reaches a sub-agent only when it addresses that sub-agent.
// rooms: one to three live sub-agents labeled Ada, Bob and Cy (0, 1, 2).
// busy: the sub-agents in the middle of a turn; the others are ready.
// address: 0 no name ("stop"), 1 a sub-agent's label ("Ada, stop"),
// 2 an @-mention of a sub-agent's label ("@Ada stop"), 3 a connector mention
// whose id the room cannot map to a sub-agent ("<@1234567890> stop"),
// 4 an @-handle that names no sub-agent ("@eliza stop").
// target: the sub-agent that address 1 or 2 names (0 otherwise).
// intent: 0 an explicit stop, 1 a course correction ("no, don't do that"),
// 2 a plain instruction ("rename the button").
// outcome per sub-agent: 0 untouched, 1 delivered now, 2 queued for after the
// running turn, 3 running turn cancelled.
// phase: 0 the message is posted, 1 every bound sub-agent has its outcome.
module PeerMentionAddressing {
  pure val NoName = 0
  pure val Label = 1
  pure val AtLabel = 2
  pure val ConnectorMention = 3
  pure val OtherHandle = 4
  pure val Stop = 0
  pure val Redirect = 1
  pure val Instruction = 2
  pure val Untouched = 0
  pure val Delivered = 1
  pure val Queued = 2
  pure val Cancelled = 3
  pure val NoOutcome: List[int] = []

  var rooms: int
  var busy: Set[int]
  var address: int
  var target: int
  var intent: int
  var phase: int
  var outcome: List[int]

  pure def names(a: int): bool = a == Label or a == AtLabel
  // A label or an @-mention addresses only the sub-agent it names; a mention
  // the room cannot map to a sub-agent addresses every sub-agent.
  pure def addressed(a: int, t: int, i: int): bool =
    if (names(a)) i == t else a == ConnectorMention or a == OtherHandle
  // decideInterruption followed by the forward handler's action for it.
  // A sub-agent hears a message that addresses it, and every message when it
  // is alone in the room.
  pure def decide(crowded: bool, running: bool, addr: bool, want: int): int = {
    val heard = addr or not(crowded)
    if (want == Stop and heard and running) Cancelled
    else if (want == Stop and heard) Delivered
    else if (not(running) and heard) Delivered
    else if (not(running)) Untouched
    else if (addr and want == Redirect) Cancelled
    else if (heard) Queued
    else Untouched
  }
  pure def outcomes(n: int, b: Set[int], a: int, t: int, want: int): List[int] =
    range(0, n).foldl(NoOutcome, (out, i) =>
      out.append(decide(n > 1, b.contains(i), addressed(a, t, i), want)))

  action init = {
    nondet n = 1.to(3).oneOf()
    nondet b = 0.to(n - 1).powerset().oneOf()
    nondet a = 0.to(4).oneOf()
    nondet t = 0.to(n - 1).oneOf()
    nondet want = 0.to(2).oneOf()
    all {
      rooms' = n,
      busy' = b,
      address' = a,
      target' = if (names(a)) t else 0,
      intent' = want,
      phase' = 0,
      outcome' = NoOutcome,
    }
  }
  // The forward handler decides and acts for every bound sub-agent.
  action forward = all {
    phase == 0,
    rooms' = rooms,
    busy' = busy,
    address' = address,
    target' = target,
    intent' = intent,
    phase' = 1,
    outcome' = outcomes(rooms, busy, address, target, intent),
  }
  // The classifier model call may still be running.
  action stutter = all {
    rooms' = rooms,
    busy' = busy,
    address' = address,
    target' = target,
    intent' = intent,
    phase' = phase,
    outcome' = outcome,
  }
  action step = any { forward, stutter }

  val ModelState = {
    rooms: rooms,
    busy: busy,
    address: address,
    target: target,
    intent: intent,
    phase: phase,
    outcome: outcome,
  }
  temporal MessageHandledWithoutFairness = (phase == 0).leadsTo(phase == 1)
  temporal MessageHandled = forward.weakFair(ModelState)
    .implies(MessageHandledWithoutFairness)

  // "@Ada stop" or "@Ada rename the button" in a crowded room leaves every
  // other sub-agent alone: no cancel, no delivery, nothing queued.
  val PeerMentionLeavesOthersAlone =
    phase == 0 or address != AtLabel or rooms == 1 or
    outcome.indices().forall(i => i == target or outcome[i] == Untouched)
  // A sub-agent named by its label or an @-mention always gets the message.
  val NamedSubAgentReached =
    phase == 0 or not(names(address)) or outcome[target] != Untouched
  // A named stop cancels the named sub-agent's running turn.
  val NamedStopCancelsRunningTurn =
    phase == 0 or not(names(address)) or intent != Stop or
    not(busy.contains(target)) or outcome[target] == Cancelled
  // A label and an @-mention of the same sub-agent have the same effect.
  val AtMentionMatchesLabel =
    phase == 0 or not(names(address)) or
    outcome == outcomes(rooms, busy, Label, target, intent)
  // A mention the room cannot map to a sub-agent still reaches all of them.
  val UnmappedMentionReachesEveryone =
    phase == 0 or names(address) or address == NoName or
    outcome.indices().forall(i => outcome[i] != Untouched)
  // An unaddressed line in a crowded room is ambient chatter.
  val AmbientChatterIgnored =
    phase == 0 or address != NoName or rooms == 1 or
    outcome.indices().forall(i => outcome[i] == Untouched)
  // A sub-agent alone in its room gets every message.
  val SoloSubAgentReached = phase == 0 or rooms > 1 or outcome[0] != Untouched
  // Only a running turn is cancelled or queued behind; a ready sub-agent is
  // never handed a message to queue.
  val OutcomeMatchesTurnState =
    outcome.indices().forall(i => and {
      outcome[i] == Cancelled implies busy.contains(i),
      outcome[i] == Queued implies busy.contains(i),
      outcome[i] == Delivered implies not(busy.contains(i)),
    })
  val TypeOK = and {
    rooms.in(1.to(3)),
    busy.subseteq(0.to(rooms - 1)),
    address.in(0.to(4)),
    target.in(0.to(rooms - 1)),
    names(address) or target == 0,
    intent.in(0.to(2)),
    phase.in(0.to(1)),
    phase == 0 implies outcome == NoOutcome,
    phase == 1 implies outcome.length() == rooms,
    outcome.indices().forall(i => outcome[i].in(0.to(3))),
  }
}
