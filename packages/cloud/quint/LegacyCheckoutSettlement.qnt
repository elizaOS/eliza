// Pre-authority Checkout: paid custom amounts settle from cents, while packs
// retain an immutable quarantine receipt and never use the current catalog.
module LegacyCheckoutSettlement {
  type Receipt = { org: int, session: int, intent: int, digest: int, pack: bool, valid: bool }
  type Grant = { org: int, amount: int }
  type Quarantine = { org: int, intent: int, digest: int }
  var s: {
    phase: str, userOrg: int, receipt: Receipt,
    ledger: int -> Grant, originalLedger: int -> Grant,
    quarantine: int -> Quarantine, originalQuarantine: int -> Quarantine,
    balances: int -> int, catalogRevision: int, outcome: str,
    beforeBalance: int, cache: str
  }
  pure val ids = Set(1, 2)
  pure val emptyGrant = { org: 0, amount: 0 }
  pure val emptyQuarantine = { org: 0, intent: 0, digest: 0 }
  action init = s' = {
    phase: "idle", userOrg: 1,
    receipt: { org: 1, session: 1, intent: 1, digest: 1, pack: false, valid: true },
    ledger: ids.mapBy(_ => emptyGrant), originalLedger: ids.mapBy(_ => emptyGrant),
    quarantine: ids.mapBy(_ => emptyQuarantine), originalQuarantine: ids.mapBy(_ => emptyQuarantine),
    balances: ids.mapBy(_ => 0), catalogRevision: 1, outcome: "none",
    beforeBalance: 0, cache: "none"
  }
  action begin(org, session, intent, digest, pack, valid) = all {
    s.phase != "locked",
    s' = s.with("phase", "locked")
      .with("receipt", { org: org, session: session, intent: intent, digest: digest, pack: pack, valid: valid })
      .with("beforeBalance", s.balances.get(org)).with("outcome", "none")
  }
  // The implementation locks the current organization and membership rows.
  action moveUser = all {
    s.phase != "locked",
    s' = s.with("userOrg", if (s.userOrg == 1) 2 else 1)
  }
  action changeCatalog = s' = s.with("catalogRevision", if (s.catalogRevision == 1) 2 else 1)
  action reject = all {
    s.phase == "locked", not(s.receipt.valid) or s.receipt.org != s.userOrg,
    s' = s.with("phase", "idle").with("outcome", "rejected")
  }
  action settleCustom = all {
    s.phase == "locked", s.receipt.valid, s.receipt.org == s.userOrg, not(s.receipt.pack),
    val old = s.ledger.get(s.receipt.intent)
    val conflict = old.org != 0 and old.org != s.receipt.org
    val first = old.org == 0
    val grant = { org: s.receipt.org, amount: 2 }
    s' = if (conflict) s.with("phase", "idle").with("outcome", "rejected")
      else s.with("phase", "idle").with("outcome", if (first) "granted" else "replayed")
        .with("ledger", if (first) s.ledger.set(s.receipt.intent, grant) else s.ledger)
        .with("originalLedger", if (first) s.originalLedger.set(s.receipt.intent, grant) else s.originalLedger)
        .with("balances", if (first) s.balances.set(s.receipt.org, s.balances.get(s.receipt.org) + 2) else s.balances)
        .with("cache", "pending")
  }
  action quarantinePack = all {
    s.phase == "locked", s.receipt.valid, s.receipt.org == s.userOrg, s.receipt.pack,
    val old = s.quarantine.get(s.receipt.session)
    val desired = { org: s.receipt.org, intent: s.receipt.intent, digest: s.receipt.digest }
    val collision = ids.exists(id => id != s.receipt.session and s.quarantine.get(id).intent == s.receipt.intent)
    val first = old.org == 0 and not(collision)
    val exact = old == desired
    s' = if (first) s.with("phase", "idle").with("outcome", "quarantined")
        .with("quarantine", s.quarantine.set(s.receipt.session, desired))
        .with("originalQuarantine", s.originalQuarantine.set(s.receipt.session, desired))
      else s.with("phase", "idle").with("outcome", if (exact) "quarantined" else "rejected")
  }
  action rollback = all {
    s.phase == "locked", s' = s.with("phase", "idle").with("outcome", "transaction_failed")
  }
  action cacheSuccess = all { s.cache == "pending", s' = s.with("cache", "done") }
  action cacheFailure = all { s.cache == "pending", s' = s.with("cache", "failed") }
  action step = any {
    nondet org = ids.oneOf()
    nondet session = ids.oneOf()
    nondet intent = ids.oneOf()
    nondet digest = ids.oneOf()
    nondet pack = Set(false, true).oneOf()
    nondet valid = Set(false, true).oneOf()
    begin(org, session, intent, digest, pack, valid),
    moveUser, changeCatalog, reject, settleCustom, quarantinePack,
    rollback, cacheSuccess, cacheFailure, s' = s
  }
  val ReceiptImmutability = s.ledger == s.originalLedger and s.quarantine == s.originalQuarantine
  val CreditConservation = ids.forall(org => s.balances.get(org) == ids.fold(0, (amount, intent) =>
    amount + (if (s.ledger.get(intent).org == org) s.ledger.get(intent).amount else 0)))
  val NoPackGrant = s.outcome == "quarantined" implies s.balances.get(s.receipt.org) == s.beforeBalance
  val UniqueQuarantinedIntent = ids.forall(a => ids.forall(b =>
    (a != b and s.quarantine.get(a).intent != 0) implies
      s.quarantine.get(a).intent != s.quarantine.get(b).intent))
  val safety = ReceiptImmutability and CreditConservation and NoPackGrant and UniqueQuarantinedIntent

  run packDoesNotUseCurrentCatalogTest = init.then(changeCatalog)
    .then(begin(1, 1, 1, 1, true, true)).then(quarantinePack)
    .expect(s.outcome == "quarantined" and s.balances.get(1) == 0 and safety)
  run exactQuarantineReplayTest = init.then(begin(1, 1, 1, 1, true, true)).then(quarantinePack)
    .then(begin(1, 1, 1, 1, true, true)).then(quarantinePack).expect(s.outcome == "quarantined" and safety)
  run changedQuarantineReceiptRejectedTest = init.then(begin(1, 1, 1, 1, true, true)).then(quarantinePack)
    .then(begin(1, 1, 1, 2, true, true)).then(quarantinePack).expect(s.outcome == "rejected" and safety)
  run reusedIntentForAnotherSessionRejectedTest = init.then(begin(1, 1, 1, 1, true, true)).then(quarantinePack)
    .then(begin(1, 2, 1, 1, true, true)).then(quarantinePack).expect(s.outcome == "rejected" and safety)
  run foreignMemberCannotGrantTest = init.then(begin(2, 1, 1, 1, false, true)).then(reject)
    .expect(s.balances.get(2) == 0 and safety)
  run priorIntentCannotMoveAcrossTenantsTest = init.then(begin(1, 1, 1, 1, false, true)).then(settleCustom)
    .then(moveUser).then(begin(2, 1, 1, 1, false, true)).then(settleCustom)
    .expect(s.outcome == "rejected" and s.balances.get(1) == 2 and s.balances.get(2) == 0 and safety)
  run cacheFailureDoesNotDuplicateGrantTest = init.then(begin(1, 1, 1, 1, false, true)).then(settleCustom)
    .then(cacheFailure).then(begin(1, 1, 1, 1, false, true)).then(settleCustom)
    .expect(s.outcome == "replayed" and s.balances.get(1) == 2 and safety)
  run failedTransactionDoesNotPublishTest = init.then(begin(1, 1, 1, 1, false, true)).then(rollback)
    .expect(s.balances.get(1) == 0 and safety)
}
