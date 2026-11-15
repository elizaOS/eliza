// useCloudState native read and sign-out publication. A replacement changes the
// port and advances the revision. Sign-out admission and teardown advance the
// revision even if the same port object remains installed. Host replies can
// still settle after abort. Only the current revision can change the view.
module CloudSessionProjectionBase {
  const fenceReadErrors: bool
  const fenceSignOutJoin: bool

  pure val Reads = Set(1, 2)
  type Operation = { port: int, revision: int }
  type Read = { phase: str, owner: Operation }
  type State = {
    mounted: bool,
    port: int,
    revision: int,
    replacements: int,
    retirements: int,
    reads: int -> Read,
    signOut: Operation,
    signOutAcknowledged: bool,
    account: int,
    unavailable: bool,
    suppressConnected: bool,
    staleReadPublished: bool,
    staleSignOutPublished: bool,
  }

  var s: State

  pure val noOwner: Operation = { port: 0, revision: 0 }
  pure val unused: Read = { phase: "unused", owner: noOwner }
  pure val done: Read = { phase: "done", owner: noOwner }

  pure def owner(t: State): Operation = { port: t.port, revision: t.revision }
  pure def current(t: State, operation: Operation): bool =
    t.mounted and owner(t) == operation

  action init = s' = {
    mounted: true, port: 1, revision: 0, replacements: 0, retirements: 0,
    reads: Reads.mapBy(_ => unused), signOut: noOwner, signOutAcknowledged: false,
    account: 0, unavailable: false, suppressConnected: false,
    staleReadPublished: false, staleSignOutPublished: false,
  }

  action replace = all {
    s.mounted,
    s.replacements < 2,
    s' = { ...s, port: 3 - s.port, revision: s.revision + 1,
      replacements: s.replacements + 1 },
  }

  action unmount = all {
    s.mounted,
    s' = { ...s, mounted: false, revision: s.revision + 1 },
  }

  action startRead(id: int): bool = all {
    s.mounted,
    s.signOut == noOwner,
    s.reads.get(id) == unused,
    s' = { ...s, reads: s.reads.set(id, { phase: "pending", owner: owner(s) }) },
  }

  action readReply(id: int, reply: str): bool = {
    val read = s.reads.get(id)
    val owns = current(s, read.owner) and s.signOut == noOwner
    val settled = { ...s, reads: s.reads.set(id, done) }
    all {
      read.phase == "pending",
      s' = if (reply == "unavailable" and (owns or not(fenceReadErrors))) {
        ...settled, unavailable: true,
        staleReadPublished: s.staleReadPublished or not(owns),
      } else if (owns and reply == "absent") {
        ...settled, account: 0, unavailable: false, suppressConnected: false,
      } else if (owns and reply == "connected") {
        ...settled, account: if (s.suppressConnected) s.account else read.owner.port,
        unavailable: false,
      } else settled,
    }
  }

  action startSignOut = all {
    s.mounted,
    s.signOut == noOwner,
    s.retirements < 2,
    s' = { ...s, signOut: { port: s.port, revision: s.revision + 1 },
      revision: s.revision + 1, retirements: s.retirements + 1 },
  }

  action signOutReply(acknowledged: bool): bool = all {
    s.signOut != noOwner,
    not(s.signOutAcknowledged),
    s' = if (acknowledged and current(s, s.signOut)) {
      ...s, signOutAcknowledged: true,
    } else { ...s, signOut: noOwner },
  }

  // withNativeSession can resolve before the caller's reset continuation.
  // Replacement and teardown may run between these two actions.
  action joinSignOut = {
    val owns = current(s, s.signOut)
    val settled = { ...s, signOut: noOwner, signOutAcknowledged: false }
    all {
      s.signOutAcknowledged,
      s' = if (owns or not(fenceSignOutJoin)) {
        ...settled, account: 0, suppressConnected: true,
        staleSignOutPublished: s.staleSignOutPublished or not(owns),
      } else settled,
    }
  }

  action finishRead(id: int): bool = any {
    readReply(id, "connected"),
    readReply(id, "absent"),
    readReply(id, "unavailable"),
    readReply(id, "aborted"),
  }

  action finishSignOut = any { signOutReply(true), signOutReply(false) }

  action step = any {
    replace,
    unmount,
    { nondet id = Reads.oneOf() startRead(id) },
    finishRead(1),
    finishRead(2),
    startSignOut,
    finishSignOut,
    joinSignOut,
    s' = s,
  }

  val NoStaleReadPublication = not(s.staleReadPublished)
  val NoStaleSignOutPublication = not(s.staleSignOutPublished)
  val SuppressedAccountIsCleared = s.suppressConnected implies s.account == 0

  temporal EveryHostCallSettles = and {
    always((s.reads.get(1).phase == "pending").implies(
      eventually(s.reads.get(1).phase == "done"))),
    always((s.reads.get(2).phase == "pending").implies(
      eventually(s.reads.get(2).phase == "done"))),
    always((s.signOut != noOwner).implies(eventually(s.signOut == noOwner))),
  }

  temporal UnderFairHostReplies = and {
    weakFair(finishRead(1), s),
    weakFair(finishRead(2), s),
    weakFair(finishSignOut, s),
    weakFair(joinSignOut, s),
  } implies EveryHostCallSettles

  // A bad error publication is recorded permanently to give a looping trace.
  temporal NoStaleErrorReceipt = eventually(always(not(s.staleReadPublished)))
  temporal NoStaleSignOutReceipt = eventually(always(not(s.staleSignOutPublished)))
}

module CloudSessionProjection {
  import CloudSessionProjectionBase(fenceReadErrors = true, fenceSignOutJoin = true).*
}

module CloudSessionProjectionBeforeFix {
  import CloudSessionProjectionBase(fenceReadErrors = false, fenceSignOutJoin = false).*
}
