// Two binding instances queue one edit each. flush snapshots both queues while
// the writes are pending, then reads receipts back. The instances either own
// different stores or reopen the same store. Each await is exercised explicitly.
module DraftQueuedHandoff {
  var s: {
    phase: int,
    sameStore: bool,
    first: int,
    failOld: bool,
    failNew: bool,
    mutation: str,
    mutationAfterFirst: bool,
    readFailure: int,
    editor: str,
    savedOne: str,
    savedTwo: str,
    markedOne: bool,
    markedTwo: bool,
    oldSucceeded: bool,
    newSucceeded: bool,
    result: str,
    conflict: bool,
    mutationApplied: bool
  }
  action init = {
    nondet sameStore = Set(true, false).oneOf()
    nondet first = Set(1, 2).oneOf()
    nondet failOld = Set(true, false).oneOf()
    nondet failNew = Set(true, false).oneOf()
    nondet mutation = Set("none", "edit", "retire", "revision", "marked").oneOf()
    nondet mutationAfterFirst = Set(true, false).oneOf()
    nondet readFailure = Set(0, 1, 2).oneOf()
    s' = {
      phase: 0,
      sameStore: sameStore,
      first: first,
      failOld: failOld,
      failNew: failNew,
      mutation: mutation,
      mutationAfterFirst: mutationAfterFirst,
      readFailure: readFailure,
      editor: "",
      savedOne: "",
      savedTwo: "",
      markedOne: false,
      markedTwo: false,
      oldSucceeded: false,
      newSucceeded: false,
      result: "not-started",
      conflict: false,
      mutationApplied: false
    }
  }
  action queueOld = all {
    s.phase == 0,
    s' = {
      ...s,
      phase: 1,
      editor: "old"
    }
  }
  action openAndQueueNew = all {
    s.phase == 1,
    s' = {
      ...s,
      phase: 2,
      editor: "new"
    }
  }
  action beginFlush = all {
    s.phase == 2,
    s' = {
      ...s,
      phase: 3,
      result: "pending"
    }
  }
  // Both instances read the original empty receipt before either write commits.
  // On a shared store the second commit therefore fails its CAS.
  action completeWrite(owner: int, second: bool): bool = {
    val configuredFailure = if (owner == 1) s.failOld else s.failNew
    val firstSucceeded = s.oldSucceeded or s.newSucceeded
    val succeeded = not(configuredFailure) and not(second and s.sameStore and firstSucceeded)
    val oldSucceeded = if (owner == 1) succeeded else s.oldSucceeded
    val newSucceeded = if (owner == 2) succeeded else s.newSucceeded
    val canReadBack = newSucceeded and (oldSucceeded or s.sameStore)
    all {
      s.phase == (if (second) 4 else 3),
      s' = {
        ...s,
        phase: if (second) 5 else 4,
        oldSucceeded: oldSucceeded,
        newSucceeded: newSucceeded,
        savedOne: if (succeeded and (owner == 1 or s.sameStore))
        (if (owner == 1) "old" else "new") else s.savedOne,
        savedTwo: if (succeeded and owner == 2 and not(s.sameStore)) "new" else s.savedTwo,
        conflict: if (owner == 2) not(succeeded) else s.conflict,
        result: if (second and not(canReadBack)) "rejected" else s.result
      }
    }
  }
  action firstWrite = completeWrite(s.first, false)
  action secondWrite = completeWrite(if (s.first == 1) 2 else 1, true)
  // A successful newer write may supersede a failed retired write for the same
  // key. Changing a captured queue or owner still refuses the handoff.
  action mutate(secondRead: bool): bool = {
    val atSecond = s.mutationAfterFirst and not(s.sameStore)
    val applied = s.result == "pending" and (secondRead == atSecond) and s.mutation != "none"
    val changesText = applied and s.mutation == "edit"
    val targetOne = s.sameStore or not(secondRead)
    all {
      s.phase == (if (secondRead) 7 else 5),
      s' = {
        ...s,
        phase: if (secondRead) 8 else 6,
        mutationApplied: s.mutationApplied or applied,
        editor: if (changesText) "newer" else if (applied and s.mutation == "retire") "" else s.editor,
        savedOne: if (changesText and s.sameStore) "newer" else s.savedOne,
        savedTwo: if (changesText and not(s.sameStore)) "newer" else s.savedTwo,
        markedOne: s.markedOne or (applied and s.mutation == "marked" and targetOne),
        markedTwo: s.markedTwo or (applied and s.mutation == "marked" and not(targetOne))
      }
    }
  }
  action mutateFirst = mutate(false)
  action mutateSecond = mutate(true)
  action readBack(second: bool): bool = {
    val failureAtThisRead = s.readFailure == (if (second) 2 else 1)
    val rejects = s.mutationApplied or failureAtThisRead
    val finalRead = second or s.sameStore
    all {
      s.phase == (if (second) 8 else 6),
      s' = {
        ...s,
        phase: if (second) 9 else 7,
        result: if (s.result != "pending") s.result
        else if (rejects) "rejected" else if (finalRead) "fulfilled" else "pending"
      }
    }
  }
  action readFirst = readBack(false)
  action readSecond = readBack(true)
  action step = any {
    queueOld,
    openAndQueueNew,
    beginFlush,
    firstWrite,
    secondWrite,
    mutateFirst,
    readFirst,
    mutateSecond,
    readSecond,
    all {
      s.phase == 9,
      s' = s
    }
  }
  val invariant = and {
    (s.result == "fulfilled") implies (s.newSucceeded and (s.oldSucceeded or s.sameStore)),
    (s.result == "fulfilled") implies not(s.mutationApplied),
    (s.result == "fulfilled") implies not(s.markedOne or s.markedTwo),
    (s.result == "fulfilled") implies s.editor == "new",
    (s.result == "fulfilled" and s.sameStore) implies s.savedOne == "new",
    (s.result == "fulfilled" and not(s.sameStore)) implies (s.savedOne == "old" and s.savedTwo == "new"),
    s.savedTwo != "old"
  }
}
