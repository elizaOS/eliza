// One synchronous event service. The runtime forwards listener errors back
// to this service before the service emits its aggregate warning.
module AgentEventSequence {
  type Run = { seq: int, session: str }
  val Runs = Set("a", "b")
  val emptyRun = { seq: 0, session: "none" }
  val emptyRuns = Runs.mapBy(_ => emptyRun)
  val Limit = 4
  var s: { runs: str -> Run, phase: str, active: str, base: int,
    received: List[int], requested: str, saved: str, session: str,
    failed: bool }

  action init = s' = { runs: emptyRuns, phase: "idle", active: "a", base: 0,
    received: [], requested: "none", saved: "none", session: "none",
    failed: false }
  action register(runId: str): bool = all {
    s.phase == "idle",
    s' = { ...s, runs: s.runs.set(runId, { ...s.runs.get(runId), session: "saved" }) },
  }
  action clear(runId: str): bool = all {
    s.phase == "idle",
    s' = { ...s, runs: s.runs.set(runId, emptyRun) },
  }
  action stop = all {
    s.phase == "idle",
    s' = { ...s, runs: emptyRuns },
  }
  action admit(runId: str, requested: str, failed: bool): bool = {
    val current = s.runs.get(runId)
    all {
      s.phase == "idle",
      current.seq + (if (failed) 3 else 1) <= Limit,
      s' = { ...s, runs: s.runs.set(runId, { ...current, seq: current.seq + 1 }),
        phase: "original", active: runId, base: current.seq, received: [],
        requested: requested, saved: current.session, failed: failed,
        session: if (requested == "none") current.session else requested },
    }
  }
  action deliver = all {
    s.phase == "original",
    s' = { ...s, phase: if (s.failed) "report" else "idle",
      received: s.received.append(s.runs.get(s.active).seq) },
  }
  action diagnostic(phase: str, nextPhase: str): bool = {
    val current = s.runs.get(s.active)
    all {
      s.phase == phase,
      s' = { ...s, phase: nextPhase,
        runs: s.runs.set(s.active, { ...current, seq: current.seq + 1 }),
        received: s.received.append(current.seq + 1) },
    }
  }
  action report = diagnostic("report", "warning")
  action warning = diagnostic("warning", "idle")
  action drain = any { deliver, report, warning }
  action step = {
    nondet runId = Runs.oneOf()
    nondet requested = Set("caller", "none").oneOf()
    nondet failed = Set(false, true).oneOf()
    any { register(runId), clear(runId), stop, admit(runId, requested, failed), drain, s' = s }
  }

  val SequenceBounds = Runs.forall(runId => 0 <= s.runs.get(runId).seq and s.runs.get(runId).seq <= Limit)
  val PeerReceivesInSequence = s.received.indices()
    .forall(i => s.received.nth(i) == s.base + i + 1)
  val DiagnosticsFollowOriginal = all {
    (s.phase == "original").implies(s.received.length() == 0),
    (s.phase == "report").implies(s.received.length() == 1),
    (s.phase == "warning").implies(s.received.length() == 2),
    (s.phase == "idle" and s.failed).implies(s.received.length() == 3),
  }
  val SessionUsesCallerOrRun = s.session == (if (s.requested == "none") s.saved else s.requested)
  temporal FanoutFinishes = drain.weakFair(s)
    .implies((s.phase != "idle").leadsTo(s.phase == "idle"))

  run diagnosticCannotOvertakeOriginalTest = init.then(register("a"))
    .then(admit("a", "none", true)).then(deliver).then(report).then(warning)
    .expect(s.received == [1, 2, 3] and s.session == "saved")
    .then(admit("b", "caller", false)).then(deliver)
    .expect(s.received == [1] and s.session == "caller" and s.runs.get("a").seq == 3)
    .then(clear("a")).expect(s.runs.get("a") == emptyRun and s.runs.get("b").seq == 1)
    .then(stop).expect(s.runs == emptyRuns)
}

// A listener callback has at most one active handle on each channel.
// The finite generation represents handle identity, including retired handles.
module AgentEventSubscriptions {
  type Registration = { generation: int, active: int }
  val Channels = Set("event", "heartbeat")
  val Heartbeats = Set("sent", "failed")
  var s: { registrations: str -> Registration, lastHeartbeat: str,
    indicator: str, operation: str, channel: str, handle: int, previous: int }

  action init = s' = {
    registrations: Channels.mapBy(_ => { generation: 0, active: 0 }),
    lastHeartbeat: "none", indicator: "none", operation: "init",
    channel: "event", handle: 0, previous: 0,
  }
  action subscribe(channel: str): bool = {
    val current = s.registrations.get(channel)
    all {
      s.operation != "self-detach",
      current.active != 0 or current.generation < 3,
      s' = { ...s, operation: "subscribe",
        registrations: s.registrations.set(channel, if (current.active != 0) current
          else { generation: current.generation + 1, active: current.generation + 1 }) },
    }
  }
  action detach(channel: str, handle: int): bool = {
    val current = s.registrations.get(channel)
    all {
      s.operation != "self-detach",
      handle <= current.generation,
      s' = { ...s, operation: "detach", channel: channel, handle: handle,
        previous: current.active,
        registrations: s.registrations.set(channel, if (current.active == handle)
          { ...current, active: 0 } else current) },
    }
  }
  // The Android IPC observer detaches inside its callback when delivery fails.
  // Another observer remains registered and receives the same emission.
  action closeFromCallback = {
    val current = s.registrations.get("event")
    all {
      s.operation != "self-detach",
      current.active != 0,
      s' = { ...s, operation: "self-detach",
        registrations: s.registrations.set("event", { ...current, active: 0 }) },
    }
  }
  action deliverPeer = all {
    s.operation == "self-detach",
    s' = { ...s, operation: "peer-delivered" },
  }
  action heartbeat(status: str): bool = all {
    s.operation != "self-detach",
    s' = { ...s, operation: "heartbeat",
      lastHeartbeat: status, indicator: if (status == "failed") "error" else "alert" },
  }
  action stop = all {
    s.operation != "self-detach",
    s' = { ...s, operation: "stop", lastHeartbeat: "none",
      indicator: "none", registrations: Channels.mapBy(channel =>
        { ...s.registrations.get(channel), active: 0 }) },
  }
  action step = {
    nondet channel = Channels.oneOf()
    nondet handle = Set(1, 2, 3).oneOf()
    nondet status = Heartbeats.oneOf()
    any {
      subscribe(channel), detach(channel, handle), heartbeat(status), stop,
      closeFromCallback, deliverPeer, s' = s,
    }
  }

  val OneCurrentRegistration = Channels.forall(channel => {
    val current = s.registrations.get(channel)
    current.active == 0 or current.active == current.generation
  })
  val DetachRequiresCurrentHandle = (s.operation == "detach").implies(
    s.registrations.get(s.channel).active ==
      (if (s.handle == s.previous) 0 else s.previous))
  val CallbackDetachesBeforePeer = Set("self-detach", "peer-delivered").contains(s.operation)
    .implies(s.registrations.get("event").active == 0)
  val HeartbeatStatusMatchesIndicator = all {
    (s.lastHeartbeat == "sent").implies(s.indicator == "alert"),
    (s.lastHeartbeat == "failed").implies(s.indicator == "error"),
    (s.lastHeartbeat == "none").implies(s.indicator == "none"),
  }
  val StopClearsRegistrationsAndHeartbeat = (s.operation == "stop").implies(
    s.lastHeartbeat == "none" and Channels.forall(channel => s.registrations.get(channel).active == 0))
  temporal PeerStillReceives = deliverPeer.weakFair(s)
    .implies((s.operation == "self-detach").leadsTo(s.operation == "peer-delivered"))

  run staleHandleDoesNotDetachReplacementTest = init.then(subscribe("event"))
    .then(detach("event", 1)).then(subscribe("event")).then(subscribe("event"))
    .then(detach("event", 1)).expect(s.registrations.get("event").active == 2)
    .then(subscribe("heartbeat")).then(heartbeat("failed"))
    .expect(s.lastHeartbeat == "failed" and s.indicator == "error")
    .then(stop).expect(StopClearsRegistrationsAndHeartbeat)
    .then(subscribe("heartbeat")).then(detach("heartbeat", 1))
    .expect(s.registrations.get("heartbeat").active == 2)

  run callbackDetachDoesNotSkipPeerTest = init.then(subscribe("event"))
    .then(closeFromCallback).expect(CallbackDetachesBeforePeer)
    .then(deliverPeer).expect(s.operation == "peer-delivered" and CallbackDetachesBeforePeer)
}
