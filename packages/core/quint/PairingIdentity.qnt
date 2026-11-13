// Identity projection of PairingService and SQL pairing writes. Owner values
// stand for (agent, channel, sender) tuples. Fresh request UUIDs and collision-
// resistant hashing of canonical grant tuples are assumed; raw bits are omitted.
module PairingIdentityOwners {
  pure val owners = Set(0, 1, 2, 3, 4)
  // 0/1 differ at a hyphen-delimited channel/sender boundary. 0/2 differ only
  // in agent. 3/4 differ at a colon-delimited reply-claim boundary.
  pure def legacyRequestKey(owner: int): int = if (owner <= 2) 0 else owner
  pure def legacyReplyKey(owner: int): int = if (owner == 4) 3 else owner
}

module PairingReplyIdentity {
  import PairingIdentityOwners.*
  var s: { ownersSeen: Set[int], claimKeys: Set[int], accepted: bool, first: bool }
  action init = s' = { ownersSeen: Set(), claimKeys: Set(), accepted: true, first: true }
  action claim(owner: int, legacy: bool): bool = {
    val key = if (legacy) legacyReplyKey(owner) else owner
    s' = {
      ownersSeen: s.ownersSeen.union(Set(owner)),
      claimKeys: s.claimKeys.union(Set(key)),
      accepted: not(s.claimKeys.contains(key)),
      first: not(s.ownersSeen.contains(owner)),
    }
  }
  action step = { nondet owner = owners.oneOf(); claim(owner, false) }
  val IndependentClaimScopes = s.first.implies(s.accepted)
  val ClaimOncePerOwner = s.accepted.implies(s.first)
  run distinctScopesReceiveRepliesTest = init.then(claim(3, false)).then(claim(4, false))
    .expect(IndependentClaimScopes and s.accepted)
  run oldDelimitedKeyAliasesScopesTest = init.then(claim(3, true)).then(claim(4, true))
    .expect(not(IndependentClaimScopes))
}

module PairingRequestIdentity {
  import PairingIdentityOwners.*
  var s: { rows: int -> int, accepted: bool }
  action init = s' = { rows: owners.mapBy(_ => -1), accepted: true }
  action admit(owner: int, legacy: bool): bool = {
    val key = if (legacy) legacyRequestKey(owner) else owner
    val accepted = s.rows.get(key) == -1 or s.rows.get(key) == owner
    s' = { rows: if (accepted) s.rows.set(key, owner) else s.rows, accepted: accepted }
  }
  action step = { nondet owner = owners.oneOf(); admit(owner, false) }
  val IndependentRequestScopes = s.accepted
  val RowsRetainTheirScope = owners.forall(owner => s.rows.get(owner) == -1 or s.rows.get(owner) == owner)
  run distinctTupleRequestsRemainIndependentTest = init.then(admit(0, false)).then(admit(1, false))
    .then(admit(2, false)).expect(IndependentRequestScopes)
  run oldTimestampIdentityAliasesAgentsTest = init.then(admit(0, true)).then(admit(2, true))
    .expect(not(IndependentRequestScopes))
}

module PairingGrantIdentity {
  pure val owners = Set(0, 1, 2)
  pure val rowKeys = Set(0, 1, 2)
  var s: { rows: int -> int, ownerKey: int -> int,
    lastOwner: int, lastKey: int, accepted: bool, reported: bool }
  action init = s' = { rows: rowKeys.mapBy(_ => -1), ownerKey: owners.mapBy(_ => -1),
    lastOwner: 0, lastKey: 0, accepted: false, reported: false }
  action write(owner: int, key: int): bool = {
    val stored = s.ownerKey.get(owner)
    val insert = stored == -1 and s.rows.get(key) == -1
    val accepted = stored >= 0 or insert
    s' = {
      rows: if (insert) s.rows.set(key, owner) else s.rows,
      ownerKey: if (insert) s.ownerKey.set(owner, key) else s.ownerKey,
      lastOwner: owner, lastKey: if (stored >= 0) stored else key,
      accepted: accepted, reported: true,
    }
  }
  // Models the former unconditional ID return after ON CONFLICT DO NOTHING.
  action legacyWrite(owner: int, key: int): bool = {
    val insert = s.ownerKey.get(owner) == -1 and s.rows.get(key) == -1
    s' = {
      rows: if (insert) s.rows.set(key, owner) else s.rows,
      ownerKey: if (insert) s.ownerKey.set(owner, key) else s.ownerKey,
      lastOwner: owner, lastKey: key, accepted: true, reported: true,
    }
  }
  action remove(key: int): bool = {
    val owner = s.rows.get(key)
    s' = { ...s, rows: s.rows.set(key, -1),
      ownerKey: if (owner >= 0) s.ownerKey.set(owner, -1) else s.ownerKey,
      reported: false }
  }
  action step = {
    nondet owner = owners.oneOf()
    nondet key = rowKeys.oneOf()
    any { write(owner, key), remove(key) }
  }
  val ReceiptMatchesStoredScope = not(s.reported) or not(s.accepted) or s.rows.get(s.lastKey) == s.lastOwner
  val GrantIndexesAgree = owners.forall(owner => s.ownerKey.get(owner) == -1 or
    s.rows.get(s.ownerKey.get(owner)) == owner) and rowKeys.forall(key => s.rows.get(key) == -1 or
    s.ownerKey.get(s.rows.get(key)) == key)
  run existingGrantReturnsActualIdentityTest = init.then(write(0, 0)).then(write(0, 1))
    .expect(s.lastKey == 0 and ReceiptMatchesStoredScope)
  run conflictingScopeCannotReportSuccessTest = init.then(write(0, 0)).then(write(1, 0))
    .expect(not(s.accepted) and ReceiptMatchesStoredScope)
  run oldConflictReturnFabricatesReceiptTest = init.then(legacyWrite(0, 0)).then(legacyWrite(1, 0))
    .expect(not(ReceiptMatchesStoredScope))
  run oldDuplicateReturnFabricatesIdentityTest = init.then(legacyWrite(0, 0)).then(legacyWrite(0, 1))
    .expect(not(ReceiptMatchesStoredScope))
}
