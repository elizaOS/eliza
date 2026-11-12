// UI selection and review over three distinct (volume, trash-id) identities.
// Native storage owns per-record freshness and atomic filesystem effects.
module FilesTrashSelection {
  pure val Items = Set(1, 2, 3)
  type State = {listed: Set[int], selected: Set[int], reviewed: Set[int],
    lastReview: Set[int], lastEffect: Set[int], selecting: bool, pending: str}
  var s: State
  action init = s' = {listed: Set(1, 2), selected: Set(), reviewed: Set(),
    lastReview: Set(), lastEffect: Set(), selecting: false, pending: "none"}
  action beginSelection = all {s.pending == "none", s' = {...s, selecting: true}}
  action toggle(id: int): bool = all {s.selecting, s.pending == "none", s.listed.contains(id),
    s' = {...s, selected: if (s.selected.contains(id)) s.selected.exclude(Set(id)) else s.selected.union(Set(id))}}
  action refresh(rows: Set[int]): bool = all {s.pending == "none", rows.subseteq(Items),
    s' = {...s, listed: rows, selected: s.selected.intersect(rows)}}
  action reviewDelete = all {s.pending == "none", s.selected != Set(),
    s' = {...s, reviewed: s.selected, pending: "review"}}
  action cancel = all {s.pending == "review", s' = {...s, reviewed: Set(), pending: "none"}}
  action confirm = all {s.pending == "review", s' = {...s, pending: "delete"}}
  action recover = all {s.pending == "none", s.selected != Set(),
    s' = {...s, reviewed: s.selected, pending: "recover"}}
  action finish = all {s.pending.in(Set("delete", "recover")),
    {nondet success = Bool.oneOf()
      val effect = if (success) s.reviewed.intersect(s.listed) else Set()
      s' = {...s, listed: s.listed.exclude(effect), selected: Set(), reviewed: Set(),
        lastReview: s.reviewed, lastEffect: effect, selecting: false, pending: "none"}}}
  action leaveSelection = all {s.pending == "none", s' = {...s, selected: Set(), selecting: false}}
  action step = any {beginSelection, reviewDelete, cancel, confirm, recover, finish, leaveSelection,
    {nondet id = Items.oneOf(); toggle(id)},
    {nondet rows = Items.powerset().oneOf(); refresh(rows)}, s' = s}
  val TypeOK = s.listed.subseteq(Items) and s.selected.subseteq(s.listed)
    and s.reviewed.subseteq(Items) and s.pending.in(Set("none", "review", "delete", "recover"))
  val OnlyReviewedItemsChange = s.lastEffect.subseteq(s.lastReview)
  val ReviewDoesNotMutate = s.pending == "review" implies s.reviewed == s.selected
  temporal SettlesUnderStorageFairness = finish.weakFair(s).implies(always(s.pending.in(Set("delete", "recover")) implies eventually(s.pending == "none")))
  run selectionAndCancellationTest = init.then(beginSelection).then(toggle(1)).then(reviewDelete).then(cancel)
    .expect(s.listed == Set(1, 2) and s.lastEffect == Set())
  run removedSelectionIsPrunedTest = init.then(beginSelection).then(toggle(1)).then(toggle(2)).then(refresh(Set(1)))
    .expect(s.selected == Set(1) and TypeOK)
}
