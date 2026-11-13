// The outer handleSelectConversation callback in useChatCallbacks.ts.
// The cold, no-cache loader prefix clears old rows synchronously. Success is
// projected to one user row. Cache/overlay and loader-owned 404 recovery are
// explicit gaps. Missing outcomes below isolate the outer callback's branch,
// not a composed proof of the loader that can change the owner before returning.
module ConversationSelection {
  type Call = {
    phase: str,
    epoch: int,
    previous: int,
    target: int,
    mounted: bool,
    result: str,
    recovery: str
  }
  type State = {
    epoch: int,
    active: int,
    composer: int,
    drafts: int -> int,
    loaded: int,
    hasRows: bool,
    userRows: bool,
    emptyCandidate: bool,
    removed: Set[int],
    interrupted: int,
    claims: int,
    ws: List[int],
    notices: int,
    rejected: Set[int],
    calls: int -> Call,
    retiredWrite: bool
  }
  var s: State
  pure val callIds = Set(1, 2)
  pure val conversations = Set(1, 2, 3)
  pure val unused: Call = {
    phase: "unused", epoch: 0, previous: 0, target: 0,
    mounted: true, result: "none", recovery: "none"
  }
  pure def initial(emptyCandidate: bool): State = {
    epoch: 0,
    active: 1,
    composer: 4,
    drafts: Map(1 -> 1, 2 -> 2, 3 -> 3),
    loaded: 1,
    hasRows: true,
    userRows: not(emptyCandidate),
    emptyCandidate: emptyCandidate,
    removed: Set(),
    interrupted: 0,
    claims: 0,
    ws: List(),
    notices: 0,
    rejected: Set(),
    calls: callIds.mapBy(_ => unused),
    retiredWrite: false
  }
  action init = s' = initial(false)
  action initEmptyDraft = s' = initial(true)

  // This synchronous prefix increments the hydration epoch even on its early
  // same-conversation return. No promise can interleave inside this action.
  action chooseConversation(id: int, target: int, storageWorks: bool): bool = {
    val call = s.calls.get(id)
    val sameLoaded = target == s.active and s.hasRows
    val reap = s.active != 0 and target != s.active and s.loaded == s.active
      and not(s.userRows) and s.emptyCandidate
    val saves = s.active != 0 and target != s.active and not(reap)
    val saved = if (storageWorks and (reap or saves))
      s.drafts.set(s.active, if (reap) 0 else s.composer) else s.drafts
    val started = {
      ...call,
      phase: if (sameLoaded) "done" else "primary",
      epoch: s.epoch + 1,
      previous: s.active,
      target: target
    }
    all {
      call.phase == "unused",
      call.mounted,
      conversations.contains(target),
      s' = if (sameLoaded) {
        ...s,
        epoch: s.epoch + 1,
        calls: s.calls.set(id, started)
      } else {
        ...s,
        epoch: s.epoch + 1,
        active: target,
        loaded: if (s.loaded == target) target else 0,
        hasRows: s.loaded == target and s.hasRows,
        composer: if (target != s.active) saved.get(target) else s.composer,
        drafts: saved,
        removed: if (reap) s.removed.union(Set(s.active)) else s.removed,
        interrupted: s.interrupted + 1,
        claims: s.claims + 1,
        ws: s.ws.append(target),
        calls: s.calls.set(id, started)
      }
    }
  }

  // Removing ChatOverlay currently does not increment the shared hydration
  // epoch. A pending callback can therefore remain the latest selection.
  action unmount(id: int): bool = {
    val call = s.calls.get(id)
    all {
      call.phase != "unused",
      call.mounted,
      s' = { ...s, calls: s.calls.set(id, { ...call, mounted: false }) }
    }
  }

  // The loader result is a boundary value, not a proof of its internal writes.
  // The shared hydration epoch is checked immediately after every awaited load.
  action primaryReply(id: int, result: str): bool = {
    val call = s.calls.get(id)
    val current = call.epoch == s.epoch
    val recover = current and result != "ok"
    val restore = recover and result != "missing"
    val needsLoad = restore and call.previous != 0
    val updated = {
      ...call,
      phase: if (not(current) or result == "ok") "done"
        else if (result == "missing") "list"
        else if (needsLoad) "recovery" else "done",
      result: result,
      recovery: if (restore) "restore" else "none"
    }
    all {
      call.phase == "primary",
      Set("ok", "missing", "forbidden", "failed").contains(result),
      s' = {
        ...s,
        active: if (restore) call.previous else s.active,
        loaded: if (current and result == "ok") call.target
          else if (restore and s.loaded != call.previous) 0 else s.loaded,
        hasRows: if (current and result == "ok") true
          else if (restore and s.loaded != call.previous) false else s.hasRows,
        userRows: if (current and result == "ok") true else s.userRows,
        emptyCandidate: if (current and result == "ok") false else s.emptyCandidate,
        composer: if (needsLoad) s.drafts.get(call.previous) else s.composer,
        claims: s.claims + (if (restore) 1 else 0),
        ws: if (restore) s.ws.append(call.previous) else s.ws,
        notices: s.notices + (if (restore and not(needsLoad)) 1 else 0),
        rejected: if (recover and Set("missing", "forbidden").contains(result))
          s.rejected.union(Set(id)) else s.rejected,
        calls: s.calls.set(id, updated),
        retiredWrite: s.retiredWrite or (recover and not(call.mounted))
      }
    }
  }

  // Missing-target recovery refreshes the list before choosing its first row.
  // A failed or empty list produces null. This has no automatic retry loop.
  action listReply(id: int, fallback: int): bool = {
    val call = s.calls.get(id)
    val current = call.epoch == s.epoch
    val updated = {
      ...call,
      phase: if (current and fallback != 0) "recovery" else "done",
      recovery: "fallback"
    }
    all {
      call.phase == "list",
      conversations.union(Set(0)).contains(fallback),
      s' = if (not(current)) {
        ...s,
        calls: s.calls.set(id, updated)
      } else {
        ...s,
        active: fallback,
        composer: if (fallback == 0) 0 else s.drafts.get(fallback),
        claims: s.claims + 1,
        ws: s.ws.append(fallback),
        notices: s.notices + (if (fallback == 0) 1 else 0),
        loaded: if (s.loaded == fallback) fallback else 0,
        hasRows: fallback != 0 and s.loaded == fallback and s.hasRows,
        calls: s.calls.set(id, updated),
        retiredWrite: s.retiredWrite or not(call.mounted)
      }
    }
  }

  // A recovery load can itself fail. It changes notice count, then the original
  // missing/transient notice is published. It never starts another recovery.
  action recoveryReply(id: int, result: str): bool = {
    val call = s.calls.get(id)
    val current = call.epoch == s.epoch
    all {
      call.phase == "recovery",
      Set("ok", "failed").contains(result),
      s' = {
        ...s,
        notices: s.notices + (if (current) (if (result == "ok") 1 else 2) else 0),
        loaded: if (current and result == "ok") s.active else s.loaded,
        hasRows: if (current and result == "ok") true else s.hasRows,
        userRows: if (current and result == "ok") true else s.userRows,
        emptyCandidate: if (current and result == "ok") false else s.emptyCandidate,
        calls: s.calls.set(id, { ...call, phase: "done" }),
        retiredWrite: s.retiredWrite or (current and not(call.mounted))
      }
    }
  }

  action idle = s' = s
  action step = any {
    {
      nondet id = callIds.oneOf()
      nondet target = conversations.oneOf()
      nondet storageWorks = Set(true, false).oneOf()
      chooseConversation(id, target, storageWorks)
    },
    {
      nondet id = callIds.oneOf()
      unmount(id)
    },
    {
      nondet id = callIds.oneOf()
      nondet result = Set("ok", "missing", "forbidden", "failed").oneOf()
      primaryReply(id, result)
    },
    {
      nondet id = callIds.oneOf()
      nondet fallback = conversations.union(Set(0)).oneOf()
      listReply(id, fallback)
    },
    {
      nondet id = callIds.oneOf()
      nondet result = Set("ok", "failed").oneOf()
      recoveryReply(id, result)
    },
    idle
  }
  val finiteBounds = s.epoch <= 2 and s.interrupted <= 2 and s.claims <= 4
    and s.ws.length() <= 4 and s.notices <= 4
  val knownOwner = conversations.union(Set(0)).contains(s.active)
  val terminalCallsStayFinite = callIds.forall(id =>
    Set("unused", "primary", "list", "recovery", "done").contains(s.calls.get(id).phase))
  val invariant = finiteBounds and knownOwner and terminalCallsStayFinite
  // Expected negative result. The mounted scope is not part of this callback's
  // source guard, even though its caller uses that scope for the final anchor.
  val NoRetiredSelectionWrites = not(s.retiredWrite)
  // The retired-write witness is sticky. A safe suffix exists only if no
  // retired write occurred; the expected failure includes a looping trace.
  temporal EventuallyNoRetiredWriteWitness = eventually(always(NoRetiredSelectionWrites))
  temporal SettlesUnderFairReplies =
    (callIds.forall(id => primaryReply(id, "ok").weakFair(s))
      and callIds.forall(id => listReply(id, 0).weakFair(s))
      and callIds.forall(id => recoveryReply(id, "ok").weakFair(s)))
    implies always(callIds.forall(id => s.calls.get(id).phase != "unused"
      implies eventually(s.calls.get(id).phase == "done")))

  run lateRetiredFailureRestoresPreviousTest = init.then(chooseConversation(1, 2, true))
    .then(unmount(1)).then(primaryReply(1, "failed"))
    .expect(s.active == 1 and s.composer == 4 and s.retiredWrite and invariant)
  run successorEpochKeepsItsSelectionTest = init.then(chooseConversation(1, 2, true))
    .then(chooseConversation(2, 3, true)).then(primaryReply(1, "failed"))
    .expect(s.active == 3 and s.composer == 3 and not(s.retiredWrite) and invariant)
  run missingTargetFallsBackTest = init.then(chooseConversation(1, 2, true))
    .then(primaryReply(1, "missing")).then(listReply(1, 3))
    .then(recoveryReply(1, "ok"))
    .expect(s.active == 3 and s.rejected.contains(1) and s.notices == 1 and invariant)
  run storageFailureKeepsActualStoredDraftTest = init.then(chooseConversation(1, 2, false))
    .then(primaryReply(1, "failed"))
    .expect(s.composer == s.drafts.get(1) and invariant)
  run reapedDraftIsNotPersistedTest = initEmptyDraft.then(chooseConversation(1, 2, true))
    .expect(s.removed.contains(1) and s.drafts.get(1) == 0 and invariant)
}
