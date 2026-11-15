// Two pending rows. Unrelated payload availability never owns settlement admission.
// Financial outcomes are outside this projection/rotation model.
module video_settlement_projection {
  type State = { rows: Set[int], current: int, phase: str, stamp0: int, stamp1: int,
    nextStamp: int, receipts: Set[int], claims: Set[int], payload0: bool, payload1: bool }
  var s: State
  pure def fresh(payload0: bool, payload1: bool): State = {
    rows: Set(0, 1), current: -1, phase: "idle", stamp0: 0, stamp1: 0,
    nextStamp: 0, receipts: Set(), claims: Set(), payload0: payload0, payload1: payload1
  }
  action init = {
    nondet payload0 = Set(false, true).oneOf()
    nondet payload1 = Set(false, true).oneOf()
    s' = fresh(payload0, payload1)
  }
  action selectRow = all {
    s.phase == "idle", s.rows.size() > 0, s.nextStamp < 2,
    val row = if (s.rows.contains(0) and
      (not(s.rows.contains(1)) or s.stamp0 <= s.stamp1)) 0 else 1
    s' = { ...s, current: row, phase: "probing" }
  }
  // Provider status remains unknown; the original hold is retained.
  action probeUnknown = all {
    s.phase == "probing", s' = { ...s, phase: "writing" }
  }
  action persistMarker = all {
    s.phase == "writing", s.rows.contains(s.current),
    s' = { ...s, phase: "acknowledged", nextStamp: s.nextStamp + 1,
      stamp0: if (s.current == 0) s.nextStamp + 1 else s.stamp0,
      stamp1: if (s.current == 1) s.nextStamp + 1 else s.stamp1,
      receipts: s.receipts.union(Set(s.current)) }
  }
  action claimProgress = all {
    s.phase == "acknowledged", s.receipts.contains(s.current),
    s' = { ...s, phase: "idle", claims: s.claims.union(Set(s.current)) }
  }
  action missingReceipt = all {
    s.phase == "writing", not(s.rows.contains(s.current)),
    s' = { ...s, phase: "failed" }
  }
  action deleteSelected = all {
    Set("probing", "writing").contains(s.phase), s.rows.contains(s.current),
    s' = { ...s, rows: s.rows.exclude(Set(s.current)) }
  }
  action finish = any { probeUnknown, persistMarker, claimProgress, missingReceipt }
  action step = any { selectRow, finish, deleteSelected, s' = s }
  val safety = s.claims.subseteq(s.receipts)
    and (s.phase == "acknowledged" implies s.receipts.contains(s.current))
  temporal RotationReachesLater =
    (selectRow.weakFair(s) and finish.weakFair(s) and always(s.rows == Set(0, 1)))
    implies eventually(s.claims == Set(0, 1))

  action missingPayloadInit = s' = fresh(false, false)
  run missingPayloadDoesNotOwnRotationTest = missingPayloadInit
    .then(selectRow).then(probeUnknown).then(persistMarker).then(claimProgress)
    .then(selectRow).expect(s.current == 1)
    .then(probeUnknown).then(persistMarker).then(claimProgress)
    .expect(safety and s.claims == Set(0, 1))
  run deletedRowCannotClaimReceiptTest = missingPayloadInit.then(selectRow)
    .then(probeUnknown).then(deleteSelected).then(missingReceipt)
    .expect(safety and s.phase == "failed" and s.claims == Set())

  action oldHydrateUnrelatedPayload = all {
    s.phase == "probing", not(s.payload0), s.current == 0,
    s' = { ...s, phase: "blocked" }
  }
  action oldClaimMissingUpdate = all {
    s.phase == "writing", not(s.rows.contains(s.current)),
    s' = { ...s, phase: "idle", claims: s.claims.union(Set(s.current)) }
  }
  run oldMissingPayloadBlocksQueueWitnessTest = missingPayloadInit.then(selectRow)
    .then(oldHydrateUnrelatedPayload).expect(s.phase == "blocked" and s.claims == Set())
  run oldMissingUpdateClaimsSuccessWitnessTest = missingPayloadInit.then(selectRow)
    .then(probeUnknown).then(deleteSelected).then(oldClaimMissingUpdate).expect(not(safety))
}
