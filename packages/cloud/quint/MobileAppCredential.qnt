// Source protocol for one issued mobile authorization code. Encryption and
// policy admission are external awaits. SQL publication and acknowledgement
// are atomic. Confirm checks fresh time after either encryption or decryption.
module MobileAppCredential {
  const Initial: str
  pure val Requests = Set(1, 2)
  pure val CodeDeadline = 1
  pure val KeyDeadline = 3
  type State = {
    clock: int,
    grant: str,
    issuance: str,
    deadline: int,
    owner: int,
    ownerActive: bool,
    appActive: bool,
    key: int,
    keyOwner: int,
    active: bool,
    cipher: bool,
    deleted: bool,
    hash: int,
    provenance: bool,
    minted: Set[int],
    exchanges: int -> str,
    exchangeTime: int -> int,
    exchangeOwner: int -> int,
    snapshotKey: int -> int,
    snapshotHash: int -> int,
    confirmTime: int -> int,
    acknowledgements: int -> str,
    ackTime: int -> int,
    ackOwner: int -> int,
    ackHash: int -> int,
    confirmed: Set[int],
    receipts: Set[int],
    invalidDelivery: bool,
    invalidActivation: bool,
    cleanupViolation: bool
  }
  var s: State

  action init = s' = {
    clock: 0,
    grant: if (Initial == "pending") "unissued" else Initial,
    issuance: if (Initial == "pending") "new" else "done",
    deadline: if (Initial == "acknowledged") KeyDeadline else CodeDeadline,
    owner: 0, ownerActive: true, appActive: true,
    key: if (Initial == "pending") 0 else 1,
    keyOwner: 0,
    active: Initial == "acknowledged",
    cipher: Initial == "exchanged",
    deleted: false,
    hash: 1,
    provenance: true,
    minted: if (Initial == "pending") Set() else Set(1),
    exchanges: Requests.mapBy(_ => "new"),
    exchangeTime: Requests.mapBy(_ => 0),
    exchangeOwner: Requests.mapBy(_ => 0),
    snapshotKey: Requests.mapBy(_ => 0),
    snapshotHash: Requests.mapBy(_ => 0),
    confirmTime: Requests.mapBy(_ => 0),
    acknowledgements: Requests.mapBy(_ => "new"),
    ackTime: Requests.mapBy(_ => 0),
    ackOwner: Requests.mapBy(_ => 0),
    ackHash: Requests.mapBy(_ => 0),
    confirmed: Set(), receipts: Set(),
    invalidDelivery: false, invalidActivation: false, cleanupViolation: false
  }

  val Integrity = s.provenance and (s.grant == "pending" or
    (s.key != 0 and s.keyOwner == s.owner))
  // Completed request locals have no further source readers. Clear them so
  // equivalent settled requests do not multiply the persistent state space.
  pure def EndExchange(state: State, r: int): State = {
    ...state, exchanges: state.exchanges.set(r, "done"),
    exchangeTime: state.exchangeTime.set(r, 0), exchangeOwner: state.exchangeOwner.set(r, 0),
    snapshotKey: state.snapshotKey.set(r, 0), snapshotHash: state.snapshotHash.set(r, 0),
    confirmTime: state.confirmTime.set(r, 0)
  }
  pure def EndAck(state: State, r: int): State = {
    ...state, acknowledgements: state.acknowledgements.set(r, "done"),
    ackTime: state.ackTime.set(r, 0), ackOwner: state.ackOwner.set(r, 0),
    ackHash: state.ackHash.set(r, 0)
  }
  // Time is relative to the issuance request. Its timestamp is captured
  // before the app-row transaction, which may complete after code expiry.
  action Issue(bindingMatches: bool): bool = all {
    s.grant == "unissued", s.issuance == "new", s.clock == 0,
    s' = {...s, issuance: if (bindingMatches) "prepared" else "done"}
  }
  action CommitIssue = all {
    s.issuance == "prepared",
    s' = {...s, issuance: "done", grant: if (s.appActive) "pending" else "unissued"}
  }
  action IssueFails = all {
    s.issuance == "prepared", s' = {...s, issuance: "done"}
  }
  action Tick = all { s.clock < KeyDeadline, s' = {...s, clock: s.clock + 1} }
  action ChangeOwner = all { s.grant != "unissued", s.owner == 0, s' = {...s, owner: 1} }
  action OwnerStops = all { s.ownerActive, s' = {...s, ownerActive: false} }
  action AppStops = all { s.appActive, s' = {...s, appActive: false} }
  action ChangeKey = all { s.key != 0, s.hash == 1, s' = {...s, hash: 2} }
  action CorruptProvenance = all { s.key != 0, s.provenance, s' = {...s, provenance: false} }

  // A wrong client, redirect, environment, code, state or PKCE proof rejects
  // before any candidate is prepared. Their byte strings form two input classes.
  action BeginExchange(r: int, bindingMatches: bool): bool = all {
    s.exchanges.get(r) == "new",
    s' = if (bindingMatches and s.clock < s.deadline and Integrity and
      Set("pending", "exchanged").contains(s.grant)) {
      ...s,
      exchanges: s.exchanges.set(r, if (s.grant == "pending") "prepare" else "decrypt"),
      exchangeTime: s.exchangeTime.set(r, s.clock),
      exchangeOwner: s.exchangeOwner.set(r, s.owner),
      snapshotKey: s.snapshotKey.set(r, s.key),
      snapshotHash: s.snapshotHash.set(r, s.hash)
    } else EndExchange(s, r)
  }
  // Candidate publication uses the captured request timestamp. A changed
  // owner fails assertStateIntegrity and rolls back the entire transaction.
  action Publish(r: int): bool = all {
    s.exchanges.get(r) == "prepare",
    s' = if (s.appActive and s.exchangeTime.get(r) < s.deadline and Integrity and
      s.exchangeOwner.get(r) == s.owner and s.grant == "pending") {
      ...s, grant: "exchanged", key: r, keyOwner: s.owner, cipher: true,
      hash: 1, minted: s.minted.union(Set(r)),
      exchanges: s.exchanges.set(r, "confirm"),
      snapshotKey: s.snapshotKey.set(r, r), snapshotHash: s.snapshotHash.set(r, 1)
    } else if (s.appActive and s.exchangeTime.get(r) < s.deadline and
      Integrity and s.grant == "exchanged") {
      ...s, exchanges: s.exchanges.set(r, "decrypt"),
      snapshotKey: s.snapshotKey.set(r, s.key), snapshotHash: s.snapshotHash.set(r, s.hash)
    } else EndExchange(s, r)
  }
  action Decrypt(r: int): bool = all {
    s.exchanges.get(r) == "decrypt",
    // The modeled ciphertext contains the original hash-1 secret. A changed
    // stored hash fails the service's post-decrypt integrity comparison.
    s' = if (s.snapshotHash.get(r) == 1) {...s, exchanges: s.exchanges.set(r, "confirm")}
      else EndExchange(s, r)
  }
  // The service samples the wall clock after KMS and passes that timestamp
  // into the confirmation transaction. A row-lock wait can cross its deadline.
  action BeginConfirm(r: int): bool = all {
    s.exchanges.get(r) == "confirm",
    s' = {...s, exchanges: s.exchanges.set(r, "query"),
      confirmTime: s.confirmTime.set(r, s.clock)}
  }
  def Revealable(r: int): bool = and {
    s.appActive, Integrity, s.grant == "exchanged",
    s.confirmTime.get(r) < s.deadline, s.confirmTime.get(r) < KeyDeadline,
    not(s.active), not(s.deleted), s.cipher,
    s.key == s.snapshotKey.get(r), s.hash == s.snapshotHash.get(r), s.snapshotHash.get(r) == 1
  }
  action Confirm(r: int): bool = all {
    s.exchanges.get(r) == "query",
    s' = EndExchange({...s,
      confirmed: if (Revealable(r)) s.confirmed.union(Set(r)) else s.confirmed,
      invalidDelivery: s.invalidDelivery or (Revealable(r) and
        (s.key == 0 or s.keyOwner != s.owner or s.confirmTime.get(r) >= s.deadline or s.snapshotHash.get(r) != 1))}, r)
  }
  action ExchangeFails(r: int): bool = all {
    Set("prepare", "decrypt", "confirm", "query").contains(s.exchanges.get(r)),
    s' = EndExchange(s, r)
  }

  // Correct proof may be retried after a lost acknowledgement reply. The
  // retained grant deadline becomes the credential deadline on the first ack.
  action BeginAck(r: int, proofMatches: bool): bool = all {
    s.acknowledgements.get(r) == "new",
    s' = if (proofMatches and s.clock < s.deadline and Integrity and s.key != 0 and
      Set("exchanged", "acknowledged").contains(s.grant)) {
      ...s, acknowledgements: s.acknowledgements.set(r, "planned"),
      ackTime: s.ackTime.set(r, s.clock), ackOwner: s.ackOwner.set(r, s.owner),
      ackHash: s.ackHash.set(r, s.hash)
    } else EndAck(s, r)
  }
  action Acknowledge(r: int): bool = {
    val updated = if (s.appActive and Integrity and s.ackOwner.get(r) == s.owner and
      s.ackHash.get(r) == s.hash and
      s.ackTime.get(r) < s.deadline and s.ackTime.get(r) < KeyDeadline and
      not(s.deleted) and s.ownerActive and s.grant == "exchanged" and not(s.active)) {
      ...s, grant: "acknowledged", deadline: KeyDeadline, active: true, cipher: false,
      receipts: s.receipts.union(Set(s.key)),
      invalidActivation: s.invalidActivation or s.key == 0 or s.keyOwner != s.owner
    } else if (s.appActive and Integrity and s.ackOwner.get(r) == s.owner and
      s.ackHash.get(r) == s.hash and
      s.ackTime.get(r) < s.deadline and s.ackTime.get(r) < KeyDeadline and
      not(s.deleted) and s.grant == "acknowledged" and s.active) {
      ...s, receipts: s.receipts.union(Set(s.key))
    } else s
    all { s.acknowledgements.get(r) == "planned", s' = EndAck(updated, r) }
  }
  action AckFails(r: int): bool = all {
    s.acknowledgements.get(r) == "planned",
    s' = EndAck(s, r)
  }

  // One safe cleanup transaction. Candidate planning, skip-locked pagination
  // and reference multiplicity are refined by MobileAppGrantCleanup.qnt.
  action Reap = all {
    s.grant != "deleted", s.clock >= s.deadline, Integrity,
    s' = {...s, grant: "deleted", active: false, cipher: false,
      deleted: s.key != 0,
      cleanupViolation: s.cleanupViolation or (s.active and s.clock < KeyDeadline)}
  }
  action step = any {
    Tick, CommitIssue, IssueFails, ChangeOwner, OwnerStops, AppStops, ChangeKey, CorruptProvenance, Reap,
    { nondet valid = Set(true, false).oneOf(); Issue(valid) },
    { nondet r = Requests.oneOf(); nondet valid = Set(true, false).oneOf(); BeginExchange(r, valid) },
    { nondet r = Requests.oneOf(); Publish(r) },
    { nondet r = Requests.oneOf(); Decrypt(r) },
    { nondet r = Requests.oneOf(); BeginConfirm(r) },
    { nondet r = Requests.oneOf(); Confirm(r) },
    { nondet r = Requests.oneOf(); ExchangeFails(r) },
    { nondet r = Requests.oneOf(); nondet valid = Set(true, false).oneOf(); BeginAck(r, valid) },
    { nondet r = Requests.oneOf(); Acknowledge(r) },
    { nondet r = Requests.oneOf(); AckFails(r) },
    s' = s
  }
  val TypeOK = and {
    Set(0, 1, 2, 3).contains(s.clock),
    Set("unissued", "pending", "exchanged", "acknowledged", "deleted").contains(s.grant),
    Set("new", "prepared", "done").contains(s.issuance),
    Set(0, 1, 2).contains(s.key), Set(CodeDeadline, KeyDeadline).contains(s.deadline),
    Requests.forall(r => Set("new", "prepare", "decrypt", "confirm", "query", "done").contains(s.exchanges.get(r))),
    Requests.forall(r => Set("new", "planned", "done").contains(s.acknowledgements.get(r)))
  }
  val OneCredential = s.minted.size() <= 1
  val ActivationHasReceipt = s.active implies s.grant == "acknowledged"
  val ReceiptErasesCiphertext = s.grant == "acknowledged" implies not(s.cipher)
  val ExactDelivery = not(s.invalidDelivery)
  val ExactActivation = not(s.invalidActivation)
  val OneReceiptIdentity = s.receipts.size() <= 1
  val ActiveReceiptSurvivesCodeExpiry = not(s.cleanupViolation)
  val safety = TypeOK and OneCredential and ActivationHasReceipt and ReceiptErasesCiphertext and
    ExactDelivery and ExactActivation and OneReceiptIdentity and ActiveReceiptSurvivesCodeExpiry
  val Idle = s.issuance != "prepared" and Requests.forall(r => Set("new", "done").contains(s.exchanges.get(r))) and
    Requests.forall(r => Set("new", "done").contains(s.acknowledgements.get(r)))
  temporal Fairness = CommitIssue.weakFair(s) and Requests.forall(r => and {
    Publish(r).weakFair(s), Decrypt(r).weakFair(s), BeginConfirm(r).weakFair(s),
    Confirm(r).weakFair(s), Acknowledge(r).weakFair(s)
  })
  temporal RequestsSettle = Fairness implies eventually(always(Idle))
}

module MobileAppCredential_pending {
  import MobileAppCredential(Initial = "pending").*
  run exchangeRaceKeepsOneCredentialTest = init.then(Issue(true)).then(CommitIssue)
    .then(BeginExchange(1, true)).then(BeginExchange(2, true))
    .then(Publish(1)).then(Publish(2)).then(Decrypt(2))
    .then(BeginConfirm(1)).then(Confirm(1)).then(BeginConfirm(2)).then(Confirm(2))
    .expect(s.confirmed == Set(1, 2) and s.minted == Set(1))
  run delayedEncryptionCannotRevealExpiredCodeTest = init.then(Issue(true)).then(CommitIssue)
    .then(BeginExchange(1, true)).then(Tick).then(Publish(1))
    .then(BeginConfirm(1)).then(Confirm(1))
    .expect(s.grant == "exchanged" and s.confirmed.size() == 0)
  run acknowledgedReceiptReplaysPastCodeDeadlineTest = init.then(Issue(true)).then(CommitIssue)
    .then(BeginExchange(1, true)).then(Publish(1)).then(BeginConfirm(1)).then(Confirm(1))
    .then(BeginAck(1, true)).then(Acknowledge(1)).then(Tick).then(Tick)
    .then(BeginAck(2, true)).then(Acknowledge(2))
    .expect(s.active and s.receipts == Set(1) and s.deadline == KeyDeadline)
  run delayedIssuanceCannotRevealExpiredCodeTest = init.then(Issue(true)).then(Tick).then(Tick)
    .then(CommitIssue).then(BeginExchange(1, true))
    .expect(s.grant == "pending" and s.key == 0 and s.exchanges.get(1) == "done")
  run changedHashCannotProduceReplayTest = init.then(Issue(true)).then(CommitIssue)
    .then(BeginExchange(1, true)).then(Publish(1)).then(ChangeKey)
    .then(BeginExchange(2, true)).then(Decrypt(2))
    .expect(s.confirmed.size() == 0 and s.exchanges.get(2) == "done")
}
module MobileAppCredential_exchanged { import MobileAppCredential(Initial = "exchanged").* }
module MobileAppCredential_acknowledged { import MobileAppCredential(Initial = "acknowledged").* }
