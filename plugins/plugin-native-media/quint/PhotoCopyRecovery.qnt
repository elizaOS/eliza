// Recovery reads one durable edit-copy receipt and its unique owned MediaStore row.
module PhotoCopyRecovery {
  var s: { receipt: str, row: str, copies: int, phase: str, outcome: str }
  action init = {
    nondet receipt = Set("writing", "saved").oneOf()
    nondet row = Set("pending", "published", "absent").oneOf()
    s' = {receipt: receipt, row: row, copies: if (row == "absent") 0 else 1, phase: "ready", outcome: "unknown"}
  }
  action recover = all {
    s.phase == "ready",
    s' = if (s.receipt == "saved") {...s, phase: "done", outcome: "saved"}
      else if (s.row == "published") {...s, receipt: "saved", phase: "done", outcome: "saved"}
      else if (s.row == "pending") {...s, phase: "deleting"}
      else {...s, receipt: "failed", phase: "done", outcome: "failed"}
  }
  action deletePending = all { s.phase == "deleting", s.row == "pending",
    s' = {...s, row: "absent", copies: 0, receipt: "failed", phase: "done", outcome: "failed"}
  }
  action cleanupUnconfirmed = all { s.phase == "deleting", s' = {...s, phase: "done", outcome: "unknown"} }
  action step = any { recover, deletePending, cleanupUnconfirmed, s' = s }
  val NoDuplicateCopy = s.copies >= 0 and s.copies <= 1
  val FailedHasNoPendingCopy = (s.outcome == "failed").implies(s.row == "absent")
  val PublishedReceiptStaysSuccessful = (s.receipt == "saved").implies(s.outcome != "failed")
  val safety = NoDuplicateCopy and FailedHasNoPendingCopy and PublishedReceiptStaysSuccessful
}
