// One reviewed read. A new relative range uses the run's admitted day.
// An older run can keep a range already queued under the legacy protocol.
module WorkflowCalendarRunScope {
  var s: { phase: int, relative: bool, anchored: bool, legacyQueued: bool,
    peer: int, sourceValid: bool,
    owner: bool, day: int, grace: bool, capturedDay: int,
    reads: int, authorityAtRead: bool, windowAtRead: bool, peerAtRead: int }
  action initialize(relative: bool, anchored: bool, legacyQueued: bool, peer: int, valid: bool, owner: bool): bool =
    s' = { phase: 0, relative: relative, anchored: anchored, legacyQueued: legacyQueued,
      peer: peer, sourceValid: valid,
      owner: owner, day: 0, grace: false, capturedDay: if (legacyQueued) 0 else -1, reads: 0,
      authorityAtRead: false, windowAtRead: false, peerAtRead: -1 }
  action init = {
    nondet relative = Set(false, true).oneOf()
    nondet anchored = Set(false, true).oneOf()
    nondet legacyQueued = Set(false, true).oneOf()
    nondet peer = Set(3, 4, 5).oneOf()
    nondet valid = Set(false, true).oneOf()
    nondet owner = Set(false, true).oneOf()
    all { legacyQueued implies relative and not(anchored),
      initialize(relative, anchored, legacyQueued, peer, valid, owner) }
  }
  val relativeProtocol = if (s.anchored) 5 else 4
  val admitted = s.owner and s.sourceValid and (not(s.relative) or s.peer >= relativeProtocol)
  val hasRange = not(s.relative) or s.anchored or s.legacyQueued
  val windowCurrent = not(s.relative) or (if (s.anchored) s.capturedDay == 0
    else s.capturedDay == s.day or (s.grace and s.capturedDay == s.day - 1))
  action resolve = all { s.phase == 0,
    s' = s.with("phase", if (admitted and hasRange) 1 else 3)
      .with("capturedDay", if (hasRange) 0 else -1) }
  action queue = all { s.phase == 1,
    s' = s.with("phase", if (admitted) 2 else 3) }
  action read = all { s.phase == 2,
    s' = s.with("phase", 3)
      .with("reads", if (admitted and windowCurrent) 1 else 0)
      .with("authorityAtRead", s.owner and s.sourceValid)
      .with("windowAtRead", windowCurrent).with("peerAtRead", s.peer) }
  action midnight = all { s.day == 0, s' = s.with("day", 1).with("grace", true) }
  action endGrace = all { s.grace, s' = s.with("grace", false) }
  action revoke = all { s.owner, s' = s.with("owner", false) }
  action downgrade = all { s.peer > 3, s' = s.with("peer", s.peer - 1) }
  action advance = any { resolve, queue, read }
  action step = any { advance, midnight, endGrace, revoke, downgrade, s' = s }
  val TypeOK = s.phase.in(0.to(3)) and s.peer.in(Set(3, 4, 5))
    and s.day.in(0.to(1)) and s.capturedDay.in(Set(-1, 0, 1)) and s.reads.in(0.to(1))
    and s.peerAtRead.in(Set(-1, 3, 4, 5))
  val OnlyReviewedRead = s.reads == 1 implies s.authorityAtRead and s.windowAtRead
    and (not(s.relative) or s.peerAtRead >= relativeProtocol)
  val InvalidSourceNeverReads = not(s.sourceValid) implies s.reads == 0
  temporal ResolutionStaysPinned = always((s.capturedDay >= 0 implies
    next(s.capturedDay) == s.capturedDay).orKeep(s))
  temporal Settles = (s.phase < 3).leadsTo(s.phase == 3)
  temporal FairSettlement = advance.weakFair(s) implies Settles
  run oldPeerCannotReviewRelativeSpecTest = initialize(true, true, false, 4, true, true)
    .then(resolve).expect(s.phase == 3 and s.reads == 0)
  run absoluteRangeKeepsLegacyPeerTest = initialize(false, false, false, 3, true, true)
    .then(resolve).then(queue).then(midnight).then(endGrace).then(read)
    .expect(s.reads == 1 and s.capturedDay == 0)
  run delayedDispatchKeepsRunDayTest = initialize(true, true, false, 5, true, true)
    .then(midnight).then(endGrace).then(resolve).then(queue).then(read)
    .expect(s.reads == 1 and s.capturedDay == 0)
  run legacyQueuedWindowKeepsItsDayTest = initialize(true, false, true, 4, true, true)
    .then(midnight).then(resolve).then(queue).then(read)
    .expect(s.reads == 1 and s.capturedDay == 0)
  run expiredWindowIsNotReboundTest = initialize(true, false, true, 4, true, true)
    .then(midnight).then(endGrace).then(resolve).then(queue).then(read)
    .expect(s.reads == 0 and s.capturedDay == 0)
  run missingLegacyProposalDoesNotResolveTest = initialize(true, false, false, 4, true, true)
    .then(resolve).expect(s.phase == 3 and s.capturedDay == -1)
  run revokedOwnerCannotReadTest = initialize(true, true, false, 5, true, true)
    .then(resolve).then(queue).then(revoke).then(read).expect(s.reads == 0)
  run downgradeBlocksAnchoredReadTest = initialize(true, true, false, 5, true, true)
    .then(resolve).then(queue).then(downgrade).then(read).expect(s.reads == 0)
}
