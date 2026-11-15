// src/services/post-delivery-task-tracker.ts. Lease acquisition itself is covered
// by RoomHandlerQueue. Here each room has one live capability and stale/wrong
// capabilities are refused. One delivery boundary and drain observer per room,
// one runtime drain, and two distinct task registrations bound this protocol.
module PostDeliveryTasks {
  const ExplicitOwnership: bool
  pure val Rooms = Set(1, 2)
  pure val Tasks = Set(1, 2)
  type State = {
    task: int -> str,
    room: int -> int,
    scopedAdmissionValid: bool,
    explicitAdmissionValid: bool,
    runtimeIndex: Set[int],
    roomIndex: int -> Set[int],
    aborted: Set[int],
    invoked: Set[int],
    cooperative: Set[int],
    permission: int -> str,
    effects: Set[int],
    boundary: int -> str,
    roomDrain: int -> str,
    roomBatch: int -> Set[int],
    runtimeDrain: str,
    runtimeBatch: Set[int],
    abortableDrain: bool,
    quarantined: bool
  }
  var s: State
  pure def pending(v: State): Set[int] = v.runtimeIndex
  pure def roomPending(v: State, r: int): Set[int] = v.roomIndex.get(r)
  // Both concrete indexes are removed in one synchronous finally callback.
  // A settled callback's cooperation selector cannot affect any future action.
  pure def settleTask(v: State, t: int): State = {
    ...v,
    task: v.task.set(t, "settled"),
    runtimeIndex: v.runtimeIndex.exclude(Set(t)),
    roomIndex: if (v.room.get(t) == 0) v.roomIndex
      else v.roomIndex.set(v.room.get(t), v.roomIndex.get(v.room.get(t)).exclude(Set(t))),
    cooperative: v.cooperative.exclude(Set(t))
  }
  action init = s' = {
    task: Tasks.mapBy(_ => "new"),
    room: Tasks.mapBy(_ => 0),
    scopedAdmissionValid: true,
    explicitAdmissionValid: true,
    runtimeIndex: Set(),
    roomIndex: Rooms.mapBy(_ => Set()),
    aborted: Set(),
    invoked: Set(),
    cooperative: Set(),
    permission: Tasks.mapBy(_ => "unknown"),
    effects: Set(),
    boundary: Rooms.mapBy(_ => "none"),
    roomDrain: Rooms.mapBy(_ => "idle"),
    roomBatch: Rooms.mapBy(_ => Set()),
    runtimeDrain: "idle",
    runtimeBatch: Set(),
    abortableDrain: false,
    quarantined: false
  }

  // The explicit pair is complete and owns the room. Ambient ownership is
  // admitted only in the async-local configuration. Diagnostics are unscoped.
  action Admit(t: int, r: int, mode: str, cooperative: bool): bool = all {
    s.task.get(t) == "new",
    not(s.quarantined),
    (mode == "explicit" and Rooms.contains(r)) or
    (mode == "ambient" and not(ExplicitOwnership) and Rooms.contains(r)) or
    (mode == "unscoped" and not(ExplicitOwnership) and r == 0) or
    (mode == "diagnostic" and r == 0),
    s' = {
      ...s,
      task: s.task.set(t, "queued"),
      room: s.room.set(t, r),
      // Admission mode is an argument, not retained tracker state. Sticky
      // witnesses retain the guard obligations without distinct alias states.
      scopedAdmissionValid: s.scopedAdmissionValid and
        (r == 0 or Set("explicit", "ambient").contains(mode)),
      explicitAdmissionValid: s.explicitAdmissionValid and
        (not(ExplicitOwnership) or not(Set("ambient", "unscoped").contains(mode))),
      runtimeIndex: s.runtimeIndex.union(Set(t)),
      roomIndex: if (r == 0) s.roomIndex else s.roomIndex.set(r, s.roomIndex.get(r).union(Set(t))),
      cooperative: if (cooperative) s.cooperative.union(Set(t)) else s.cooperative
    }
  }
  // Rejected calls leave all task and boundary ownership state intact.
  action Refuse = {
    nondet reason = Set("partial-pair", "stale-lease", "wrong-room", "duplicate-boundary", "quarantined", "explicit-required").oneOf()
    all {
      (reason == "quarantined" implies s.quarantined),
      (Set("partial-pair", "stale-lease", "wrong-room", "explicit-required").contains(reason) implies not(s.quarantined)),
      (reason == "explicit-required" implies ExplicitOwnership),
      (reason == "duplicate-boundary" implies Rooms.exists(r => Set("pending", "delivered", "failed").contains(s.boundary.get(r)))),
      s' = s
    }
  }
  action BeginDelivery(r: int): bool = all {
    s.boundary.get(r) == "none", s.roomDrain.get(r) == "idle",
    s' = {
      ...s,
      boundary: s.boundary.set(r, "pending")
    }
  }
  action ResolveDelivery(r: int, delivered: bool): bool = all {
    s.boundary.get(r) == "pending",
    s' = {
      ...s,
      boundary: s.boundary.set(r, if (delivered) "delivered" else "failed"),
      roomDrain: s.roomDrain.set(r, if (s.quarantined) "rejected" else if (roomPending(s, r).size() == 0) "returned" else "waiting"),
      roomBatch: s.roomBatch.set(r, roomPending(s, r)),
      permission: Tasks.mapBy(t =>
        if (s.task.get(t) == "waiting" and s.room.get(t) == r)
          (if (delivered) "yes" else "no")
        else s.permission.get(t))
    }
  }
  // The queued microtask checks cancellation before invoking the callback.
  // A real callback may wait for the boundary and then honor its boolean.
  action AdvanceTask(t: int): bool = any {
    all {
      s.task.get(t) == "queued",
      s.aborted.contains(t),
      s' = settleTask(s, t)
    },
    all {
      s.task.get(t) == "queued",
      not(s.aborted.contains(t)),
      s' = {
        ...s,
        invoked: s.invoked.union(Set(t)),
        task: s.task.set(t,
          if (s.room.get(t) != 0 and s.boundary.get(s.room.get(t)) == "pending")
            "waiting"
          else "running"),
        permission: s.permission.set(t,
          if (s.room.get(t) != 0 and s.boundary.get(s.room.get(t)) == "failed")
            "no"
          else if (s.room.get(t) != 0 and s.boundary.get(s.room.get(t)) == "pending")
            "unknown"
          else "yes")
      }
    },
    all {
      s.task.get(t) == "waiting",
      s.permission.get(t) != "unknown",
      s' = {
        ...s,
        task: s.task.set(t, "running")
      }
    },
    all {
      s.task.get(t) == "running",
      s' = settleTask(s, t)
    }
  }
  // Effects can occur before completion or failure. Cancellation only prevents
  // them for callbacks which cooperate with their AbortSignal.
  action TaskEffect(t: int): bool = all {
    s.task.get(t) == "running", s.permission.get(t) == "yes",
    not(s.cooperative.contains(t) and s.aborted.contains(t)),
    s' = {
      ...s,
      effects: s.effects.union(Set(t))
    }
  }
  // Rejected callbacks are reported and removed from both indexes. The error
  // history belongs to the diagnostic sink, not retained task-tracker state.
  action RejectTask(t: int): bool = all {
    Set("running", "waiting").contains(s.task.get(t)),
    s' = settleTask(s, t)
  }
  action BeginRoomDrain(r: int): bool = all {
    s.roomDrain.get(r) == "idle", s.boundary.get(r) == "none",
    s' = {
      ...s,
      roomDrain: s.roomDrain.set(r, if (s.quarantined) "rejected" else if (roomPending(s, r).size() == 0) "returned" else "waiting"),
      roomBatch: s.roomBatch.set(r, roomPending(s, r))
    }
  }
  action AdvanceRoomDrain(r: int): bool = all {
    s.roomDrain.get(r) == "waiting", s.roomBatch.get(r).intersect(pending(s)).size() == 0,
    s' = {
      ...s,
      roomDrain: s.roomDrain.set(r, if (roomPending(s, r).size() == 0) "returned" else "waiting"),
      roomBatch: s.roomBatch.set(r, roomPending(s, r))
    }
  }
  action CloseDelivery(r: int): bool = all {
    Set("delivered", "failed").contains(s.boundary.get(r)),
    Set("returned", "rejected").contains(s.roomDrain.get(r)),
    s' = {
      ...s,
      boundary: s.boundary.set(r, "closed")
    }
  }
  action BeginRuntimeDrain(abortable: bool): bool = all {
    s.runtimeDrain == "idle",
    s' = {
      ...s,
      runtimeDrain: if (s.quarantined) "rejected" else if (pending(s).size() == 0) "returned" else "waiting",
      runtimeBatch: pending(s),
      abortableDrain: abortable
    }
  }
  action AdvanceRuntimeDrain = all {
    s.runtimeDrain == "waiting", s.runtimeBatch.intersect(pending(s)).size() == 0,
    s' = {
      ...s,
      runtimeDrain: if (pending(s).size() == 0) "returned" else "waiting",
      runtimeBatch: pending(s)
    }
  }
  // External quarantine aborts callbacks but does not retroactively reject a
  // drain which already passed its entry check. Its own signal must abort.
  action Quarantine = all {
    not(s.quarantined),
    s' = {
      ...s,
      quarantined: true,
      aborted: s.aborted.union(pending(s))
    }
  }
  action AbortRuntimeDrain = all {
    s.runtimeDrain == "waiting", s.abortableDrain,
    s' = {
      ...s,
      quarantined: true,
      aborted: s.aborted.union(pending(s)),
      runtimeDrain: "rejected"
    }
  }
  action step = any {
    {
      nondet t = Tasks.oneOf()
      nondet r = Set(0, 1, 2).oneOf()
      nondet mode = Set("explicit", "ambient", "unscoped", "diagnostic").oneOf()
      nondet cooperative = Set(false, true).oneOf()
      Admit(t, r, mode, cooperative)
    },
    Refuse,
    { nondet r = Rooms.oneOf(); BeginDelivery(r) },
    {
      nondet r = Rooms.oneOf()
      nondet delivered = Set(false, true).oneOf()
      ResolveDelivery(r, delivered)
    },
    { nondet t = Tasks.oneOf(); AdvanceTask(t) },
    { nondet t = Tasks.oneOf(); RejectTask(t) },
    { nondet t = Tasks.oneOf(); TaskEffect(t) },
    { nondet r = Rooms.oneOf(); BeginRoomDrain(r) },
    { nondet r = Rooms.oneOf(); AdvanceRoomDrain(r) },
    { nondet r = Rooms.oneOf(); CloseDelivery(r) },
    { nondet abortable = Set(false, true).oneOf(); BeginRuntimeDrain(abortable) },
    AdvanceRuntimeDrain,
    Quarantine,
    AbortRuntimeDrain,
    s' = s
  }
  val TypeOK = and {
    Tasks.forall(t => Set("new", "queued", "waiting", "running", "settled").contains(s.task.get(t))),
    Tasks.forall(t => Set(0, 1, 2).contains(s.room.get(t))),
    Tasks.forall(t => Set("unknown", "yes", "no").contains(s.permission.get(t))),
    Rooms.forall(r => Set("none", "pending", "delivered", "failed", "closed").contains(s.boundary.get(r))),
    Rooms.forall(r => Set("idle", "waiting", "returned", "rejected").contains(s.roomDrain.get(r))),
    Set("idle", "waiting", "returned", "rejected").contains(s.runtimeDrain),
    s.aborted.subseteq(Tasks), s.invoked.subseteq(Tasks), s.effects.subseteq(Tasks), s.runtimeIndex.subseteq(Tasks),
    Rooms.forall(r => s.roomIndex.get(r).subseteq(Tasks))
  }
  val ScopedAdmission = s.scopedAdmissionValid
  val ExplicitModeEnforced = s.explicitAdmissionValid
  val EffectsRequireInvocation = s.effects.subseteq(s.invoked)
  val FailedDeliveryBlocksEffects = Tasks.forall(t => s.permission.get(t) == "no" implies not(s.effects.contains(t)))
  val AbortedBeforeInvocationHasNoEffect = s.aborted.exclude(s.invoked).intersect(s.effects).size() == 0
  val TaskIndexesAgree = and {
    s.runtimeIndex == Tasks.filter(t => Set("queued", "waiting", "running").contains(s.task.get(t))),
    Rooms.forall(r => s.roomIndex.get(r) == s.runtimeIndex.filter(t => s.room.get(t) == r))
  }
  val CapturedSettlementRetained = Tasks.forall(t => s.task.get(t) == "waiting" and s.boundary.get(s.room.get(t)) == "closed" implies s.permission.get(t) != "unknown")
  temporal QuarantineIsFinal = always((s.quarantined implies next(s.quarantined)).orKeep(s))
  temporal QuarantineRetainsPending = always((not(s.quarantined) and next(s.quarantined) implies pending(s).subseteq(next(pending(s)))).orKeep(s))
  temporal NoAdmissionAfterQuarantine = always((s.quarantined implies Tasks.forall(t => s.task.get(t) == "new" implies next(s.task).get(t) == "new")).orKeep(s))
  temporal RuntimeReturnsEmpty = always((s.runtimeDrain != "returned" and next(s.runtimeDrain) == "returned" implies pending(s).size() == 0).orKeep(s))
  temporal RoomReturnsEmpty = Rooms.forall(r => always((s.roomDrain.get(r) != "returned" and next(s.roomDrain).get(r) == "returned" implies roomPending(s, r).size() == 0).orKeep(s)))
  temporal Fairness = and {
    Tasks.forall(t => AdvanceTask(t).weakFair(s)),
    Rooms.forall(r => ResolveDelivery(r, true).weakFair(s)),
    Rooms.forall(r => AdvanceRoomDrain(r).weakFair(s)),
    Rooms.forall(r => CloseDelivery(r).weakFair(s)),
    AdvanceRuntimeDrain.weakFair(s)
  }
  temporal DrainsFinishExpanded = Fairness implies and {
    always(s.runtimeDrain == "waiting" implies eventually(s.runtimeDrain != "waiting")),
    Rooms.forall(r => always(s.roomDrain.get(r) == "waiting" implies eventually(s.roomDrain.get(r) != "waiting"))),
    Rooms.forall(r => always(s.boundary.get(r) == "pending" implies eventually(s.boundary.get(r) == "closed")))
  }

  // Each of the two room observers/boundaries and the runtime observer can
  // start once. Under these finite, monotone observer states, every started
  // observer eventually finishing is equivalent to eventual permanent
  // quiescence. The compact form uses one TLC liveness graph rather than five.
  // DrainsFinishExpanded above retains the per-observer statement explicitly.
  val ObserversQuiescent = and {
    s.runtimeDrain != "waiting",
    Rooms.forall(r => s.roomDrain.get(r) != "waiting"),
    Rooms.forall(r => Set("none", "closed").contains(s.boundary.get(r)))
  }
  temporal DrainsFinish = Fairness implies eventually(always(ObserversQuiescent))

  run initiallyEmptyDrainsReturnWithoutQuarantineTest = init
    .then(BeginRuntimeDrain(true)).then(BeginRoomDrain(1))
    .expect(s.runtimeDrain == "returned" and s.roomDrain.get(1) == "returned" and not(s.quarantined))

  // These finite traces have matching real lease/promise tests.
  run capturedSettlementSurvivesCleanupTest = init
    .then(BeginDelivery(1)).then(Admit(1, 1, "explicit", false))
    .then(AdvanceTask(1)).then(Quarantine).then(ResolveDelivery(1, false))
    .then(CloseDelivery(1))
    .expect(s.task.get(1) == "waiting" and s.permission.get(1) == "no")
    .then(AdvanceTask(1)).then(AdvanceTask(1))
    .expect(s.task.get(1) == "settled" and not(s.effects.contains(1)))

  run queuedCancellationNeverInvokesTest = init
    .then(Admit(1, 1, "explicit", true)).then(BeginRuntimeDrain(true))
    .then(AbortRuntimeDrain).then(AdvanceTask(1))
    .expect(s.quarantined and s.invoked.size() == 0 and pending(s).size() == 0)

  run nonCooperativeTaskRemainsVisibleTest = init
    .then(Admit(1, 0, "diagnostic", false)).then(AdvanceTask(1))
    .then(BeginRuntimeDrain(true)).then(AbortRuntimeDrain)
    .expect(pending(s) == Set(1) and s.runtimeDrain == "rejected")
    .then(TaskEffect(1)).then(AdvanceTask(1))
    .expect(s.quarantined and s.effects == Set(1) and pending(s).size() == 0)

  run runtimeDrainRechecksNewTasksTest = init
    .then(Admit(1, 0, "diagnostic", false)).then(AdvanceTask(1))
    .then(BeginRuntimeDrain(false)).then(Admit(2, 0, "diagnostic", false))
    .then(AdvanceTask(1)).then(AdvanceRuntimeDrain)
    .expect(s.runtimeDrain == "waiting" and s.runtimeBatch == Set(2))
    .then(AdvanceTask(2)).then(AdvanceTask(2)).then(AdvanceRuntimeDrain)
    .expect(s.runtimeDrain == "returned" and pending(s).size() == 0)

  run externalQuarantineDoesNotRejectExistingDrainTest = init
    .then(Admit(1, 0, "diagnostic", false)).then(AdvanceTask(1))
    .then(BeginRuntimeDrain(false)).then(Quarantine).then(AdvanceTask(1))
    .then(AdvanceRuntimeDrain)
    .expect(s.quarantined and s.runtimeDrain == "returned")

}
module PostDeliveryTasks_ambient { import PostDeliveryTasks(ExplicitOwnership = false).* }
module PostDeliveryTasks_explicit { import PostDeliveryTasks(ExplicitOwnership = true).* }
