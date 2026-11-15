// A presentation-only operation over one authenticated canonical Notes list.
module CanonicalNotesListFilter {
  // scope: 0 canonical list, 1 previous notes, 2 editor/trash, 3 private/other.
  var s: { phase: int, scope: int, epoch: int, reviewedEpoch: int,
    currentOwner: bool, capable: bool, validFilter: bool,
    proposalAdmitted: bool, applied: bool, admittedAtApply: bool }
  action initialize(scope: int, capable: bool, validFilter: bool): bool =
    s' = { phase: 0, scope: scope, epoch: 0, reviewedEpoch: -1,
      currentOwner: true, capable: capable, validFilter: validFilter,
      proposalAdmitted: false, applied: false, admittedAtApply: false }
  action init = {
    nondet scope = 0.to(3).oneOf()
    nondet capable = Set(false, true).oneOf()
    nondet validFilter = Set(false, true).oneOf()
    initialize(scope, capable, validFilter)
  }
  val allowed = s.currentOwner and s.scope == 0 and s.capable and s.validFilter
  action propose = all { s.phase == 0,
    s' = s.with("phase", if (allowed) 1 else 3).with("proposalAdmitted", allowed) }
  action review = all { s.phase == 1,
    s' = s.with("phase", if (allowed) 2 else 3)
      .with("reviewedEpoch", if (allowed) s.epoch else -1) }
  action applyFilter = all { s.phase == 2,
    val exact = allowed and s.reviewedEpoch == s.epoch
    s' = s.with("phase", 3).with("applied", exact).with("admittedAtApply", exact) }
  action moveScope(scope: int): bool = all { s.scope != scope, s.epoch < 2,
    s' = s.with("scope", scope).with("epoch", s.epoch + 1) }
  action retire = all { s.currentOwner, s' = s.with("currentOwner", false) }
  action downgrade = all { s.capable, s' = s.with("capable", false) }
  action advance = any { propose, review, applyFilter }
  action step = {
    nondet scope = 0.to(3).oneOf()
    any { advance, moveScope(scope), retire, downgrade, s' = s }
  }
  val TypeOK = s.phase.in(0.to(3)) and s.scope.in(0.to(3))
    and s.epoch.in(0.to(2)) and s.reviewedEpoch.in((-1).to(2))
  val OnlyExactListApplies = s.applied implies s.proposalAdmitted and s.admittedAtApply
  val DisallowedInputNeverApplies = not(s.validFilter) implies not(s.applied)
  temporal Settles = (s.phase < 3).leadsTo(s.phase == 3)
  temporal FairSettlement = advance.weakFair(s) implies Settles
  temporal TerminalNeverReapplies = always((s.phase == 3 implies
    next(s.phase) == 3 and next(s.applied) == s.applied).orKeep(s))
  run exactListTest = initialize(0, true, true).then(propose).then(review).then(applyFilter)
    .expect(s.applied)
  run previousNotesRefusedTest = initialize(1, true, true).then(propose)
    .expect(s.phase == 3 and not(s.proposalAdmitted))
  run unnegotiatedTest = initialize(0, false, true).then(propose)
    .expect(s.phase == 3 and not(s.proposalAdmitted))
  run folderOrMutationRefusedTest = initialize(0, true, false).then(propose)
    .expect(s.phase == 3 and not(s.proposalAdmitted))
  run changedListCannotRebindReviewTest = initialize(0, true, true).then(propose).then(review)
    .then(moveScope(1)).then(moveScope(0)).then(applyFilter).expect(not(s.applied))
  run ownerRetirementRefusedTest = initialize(0, true, true).then(propose).then(review)
    .then(retire).then(applyFilter).expect(not(s.applied))
}
