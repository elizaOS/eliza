// PostgreSQL payment-row -> sweep-outbox lock order for receipt publication
// and deletion cascade. Two transactions, one payment and one outbox. A matching
// receipt was already observed; RPC, nonce allocation and fairness are separate.
module evm_sweep_receipt_locks {
  type State = { payment: str, outbox: str, publication: str, deletion: str,
    confirmed: bool, retained: bool }
  var s: State
  action init = s' = { payment: "free", outbox: "free", publication: "ready",
    deletion: "ready", confirmed: false, retained: true }
  action publicationParent = all { s.publication == "ready", s.payment == "free", s.retained,
    s' = s.with("payment", "publication").with("publication", "payment") }
  action publicationChild = all { s.publication == "payment", s.outbox == "free",
    s' = s.with("outbox", "publication").with("publication", "both") }
  action publish = all { s.publication == "both",
    s' = s.with("confirmed", true).with("payment", "free").with("outbox", "free")
      .with("publication", "done") }
  action deletionParent = all { s.deletion == "ready", s.payment == "free",
    s' = s.with("payment", "deletion").with("deletion", "payment") }
  action deletionChild = all { s.deletion == "payment", s.outbox == "free",
    s' = s.with("outbox", "deletion").with("deletion", "both") }
  // The trigger rejects deletion until confirmation. Either outcome releases
  // both locks after transaction completion or rollback.
  action finishDeletion = all { s.deletion == "both",
    s' = s.with("retained", not(s.confirmed)).with("payment", "free")
      .with("outbox", "free").with("deletion", "done") }
  action idle = s' = s
  action step = any { publicationParent, publicationChild, publish,
    deletionParent, deletionChild, finishDeletion, idle }
  val noLockCycle = not(s.payment == "deletion" and s.outbox == "publication"
    and s.publication == "outbox" and s.deletion == "payment")
  val safety = noLockCycle and (s.retained or s.confirmed)
    and (s.outbox != "publication" or s.payment == "publication")
    and (s.outbox != "deletion" or s.payment == "deletion")
  run publicationBeforeDeletionTest = init.then(publicationParent).then(publicationChild)
    .then(publish).then(deletionParent).then(deletionChild).then(finishDeletion)
    .expect(safety and s.confirmed and not(s.retained))
  run rejectedDeletionThenPublicationTest = init.then(deletionParent).then(deletionChild)
    .then(finishDeletion).then(publicationParent).then(publicationChild).then(publish)
    .expect(safety and s.confirmed and s.retained)
  run parentOwnerKeepsChildAvailableTest = init.then(deletionParent)
    .expect(safety and s.outbox == "free")
  // Before the fix, publication acquired outbox first. Deletion can then own
  // payment while each transaction waits for the other row.
  action legacyPublicationChild = all { s.publication == "ready", s.outbox == "free",
    s' = s.with("outbox", "publication").with("publication", "outbox") }
  run reversedOrderDeadlockNegativeWitnessTest = init.then(legacyPublicationChild)
    .then(deletionParent).expect(not(noLockCycle))
}
