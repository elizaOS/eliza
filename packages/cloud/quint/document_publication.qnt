// One immutable document with two fragments. Only committed rows are visible.
// The primary transaction owns publication/deletion; provider uploads are separate.
module document_publication {
  type State = {
    parent: bool, fragments: int, phase: str, stagedParent: bool,
    stagedFragments: int, deleted: bool, refused: bool
  }
  var s: State
  action init = s' = {
    parent: false, fragments: 0, phase: "idle", stagedParent: false,
    stagedFragments: 0, deleted: false, refused: false
  }
  action beginCreate = all {
    s.phase == "idle", not(s.parent), not(s.deleted),
    s' = { ...s, phase: "creating", stagedParent: false, stagedFragments: 0 }
  }
  action stageParent = all {
    s.phase == "creating", not(s.stagedParent),
    s' = { ...s, stagedParent: true }
  }
  action stageFragments = all {
    s.phase == "creating", s.stagedParent,
    s' = { ...s, stagedFragments: 2 }
  }
  action commitCreate = all {
    s.phase == "creating", s.stagedParent, s.stagedFragments == 2,
    s' = { ...s, parent: true, fragments: 2, phase: "idle",
      stagedParent: false, stagedFragments: 0 }
  }
  action beginDelete = all {
    s.phase == "idle", s.parent,
    s' = { ...s, phase: "deleting", stagedParent: true, stagedFragments: s.fragments }
  }
  action stageFragmentDeletion = all {
    s.phase == "deleting", s' = { ...s, stagedFragments: 0 }
  }
  // A successful DELETE RETURNING receipt is required before committing.
  // A suppressed DELETE leaves the staged parent present and must roll back.
  action stageParentDeletion = all {
    s.phase == "deleting", s.stagedFragments == 0,
    s' = { ...s, stagedParent: false }
  }
  action commitDelete = all {
    s.phase == "deleting", s.stagedFragments == 0, not(s.stagedParent),
    s' = { ...s, parent: false, fragments: 0, phase: "idle", deleted: true }
  }
  action rollback = all {
    s.phase != "idle",
    s' = { ...s, phase: "idle", stagedParent: false, stagedFragments: 0 }
  }
  // A different resolved scope cannot acquire document mutation authority.
  action foreignDelete = s' = { ...s, refused: true }
  action finish = any { stageParent, stageFragments, commitCreate,
    stageFragmentDeletion, stageParentDeletion, commitDelete, rollback }
  action step = any { beginCreate, beginDelete, finish, foreignDelete, s' = s }

  val completePublication = s.parent == (s.fragments == 2)
  val noOrphanFragments = s.fragments > 0 implies s.parent
  val deletionIsTerminal = s.deleted implies not(s.parent) and s.fragments == 0
  val safety = completePublication and noOrphanFragments and deletionIsTerminal
  temporal TransactionsSettle = finish.weakFair(s) implies
    always(s.phase != "idle" implies eventually(s.phase == "idle"))

  run completeDocumentCommitsTest = init.then(beginCreate).then(stageParent)
    .then(stageFragments).then(commitCreate).expect(safety and s.parent)
  run fragmentFailureRollsBackTest = init.then(beginCreate).then(stageParent)
    .then(rollback).expect(safety and not(s.parent))
  run deletionFailureRetainsWholeGraphTest = init.then(beginCreate).then(stageParent)
    .then(stageFragments).then(commitCreate).then(beginDelete)
    .then(stageFragmentDeletion).then(rollback).expect(safety and s.fragments == 2)
  run deletionCommitsWholeGraphTest = init.then(beginCreate).then(stageParent)
    .then(stageFragments).then(commitCreate).then(beginDelete)
    .then(stageFragmentDeletion).then(stageParentDeletion).then(commitDelete)
    .expect(safety and s.deleted)
  run suppressedDeletionRollsBackTest = init.then(beginCreate).then(stageParent)
    .then(stageFragments).then(commitCreate).then(beginDelete)
    .then(stageFragmentDeletion).expect(s.stagedParent)
    .then(rollback).expect(safety and s.parent and s.fragments == 2)
  run foreignScopeRetainsGraphTest = init.then(beginCreate).then(stageParent)
    .then(stageFragments).then(commitCreate).then(foreignDelete)
    .expect(safety and s.parent and s.refused)

  // The old independent writes exposed these impossible committed states.
  action oldPublishParent = s' = { ...s, parent: true }
  action oldDeleteFragments = s' = { ...s, fragments: 0 }
  action oldLateFragment = s' = { ...s, fragments: 1 }
  run oldPartialPublicationWitnessTest = init.then(oldPublishParent).expect(not(safety))
  run oldPartialDeletionWitnessTest = init.then(beginCreate).then(stageParent)
    .then(stageFragments).then(commitCreate).then(oldDeleteFragments).expect(not(safety))
  run oldOrphanFragmentWitnessTest = init.then(oldLateFragment).expect(not(safety))
}
