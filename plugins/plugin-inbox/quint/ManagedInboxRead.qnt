// One owner-verified managed read. The aggregate never consumes legacy Gmail cache.
module ManagedInboxRead {
  var owner: int
  var pendingOwner: int
  var phase: int
  var permission: bool
  var returnedOwner: int

  action init = all {
    owner' = 0, pendingOwner' = -1, phase' = 0,
    permission' = true, returnedOwner' = -1
  }
  action begin = all {
    phase == 0, phase' = 1, pendingOwner' = owner,
    owner' = owner, permission' = permission, returnedOwner' = -1
  }
  action replaceOwner = all {
    phase == 1, owner' = 1 - owner,
    phase' = phase, pendingOwner' = pendingOwner,
    permission' = permission, returnedOwner' = returnedOwner
  }
  action revoke = all {
    phase == 1, permission' = false,
    owner' = owner, phase' = phase,
    pendingOwner' = pendingOwner, returnedOwner' = returnedOwner
  }
  action receive = all {
    phase == 1,
    phase' = if (permission and pendingOwner == owner) 2 else 3,
    returnedOwner' = if (permission and pendingOwner == owner) owner else -1,
    owner' = owner, permission' = permission, pendingOwner' = pendingOwner
  }
  action sourceFailure = all {
    phase == 1, phase' = 3, returnedOwner' = -1,
    owner' = owner, permission' = permission, pendingOwner' = pendingOwner
  }
  action nextRead = all {
    phase == 2 or phase == 3, phase' = 0, returnedOwner' = -1,
    owner' = owner, permission' = true, pendingOwner' = -1
  }
  action step = any { begin, replaceOwner, revoke, receive, sourceFailure, nextRead }
  val CurrentOwnerOnly = phase != 2 or returnedOwner == owner
  val RevocationRefuses = phase != 2 or permission
  val FailureHasNoMail = phase != 3 or returnedOwner == -1
  val invariant = CurrentOwnerOnly and RevocationRefuses and FailureHasNoMail
}
