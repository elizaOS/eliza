// Proofs for spec/tracker.md. Each transition's body opens with `if inv(s) && can<X>(...)`
// (or `if inv(s)` for one without a guard), names the state after, and calls the helpers below.

lemma create_ensures(s: Tracker, actor: string)
  ensures (inv(s) ==> canCreate(s, actor) ==> alwaysTaskNumbersAreUnique(create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> alwaysTheCounterCoversEveryTask(create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> alwaysNoOneIsToldOfTheirOwnEdit(create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> alwaysNothingIsSentTwice(create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> alwaysWhatWasSentIsRecorded(create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> alwaysRemindersAreTimely(create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> alwaysTheBookkeepingIsSane(create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> alwaysTheClockIsNeverNegative(create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> stepADashboardEditIsSignedByAMember(s, create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> stepOnlyAHandEditCorrupts(s, create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> stepANewNumberIsUnreferenced(s, create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> stepTheCounterNeverGoesBack(s, create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> stepANumberIsNeverReissued(s, create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "create", create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> stepAFixRemovesAProblem(s, create(s, actor)))
  ensures (inv(s) ==> canCreate(s, actor) ==> stepAPassSendsWhatItRecords(s, "create", create(s, actor), []))
{
  if inv(s) && canCreate(s, actor) {
    var s2 := create(s, actor);
    TSigned(s, s2, actor);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    kernel_lawNextIsAboveTheCounter_ensures(numbersInUse(s), s.lastId);
    var n := s2.tasks[|s.tasks|];
    assert s2.tasks == s.tasks + [n];
    assert n.id > s.lastId;
    TAppendFreshUnique(s.tasks, n);
    kernel_lawNextIsAboveEverythingSeen_ensures(numbersInUse(s), s.lastId);
    assert forall x :: x in numbersInUse(s) ==> n.id > x;
    forall j | 0 <= j < |s2.tasks|
      ensures hasTask(s, s2.tasks[j].id) || !(s2.tasks[j].id in numbersInUse(s))
    {
      if j < |s.tasks| {
        assert s.tasks[j] in s.tasks;
      }
    }
    forall j | 0 <= j < |s2.tasks|
      ensures s2.tasks[j].id > s.lastId || exists i :: 0 <= i < |s.tasks| && s.tasks[i] == s2.tasks[j]
    {
      if j < |s.tasks| {
        assert s.tasks[j] == s2.tasks[j];
      }
    }
    TSentRecordedKept(s, s2);
    forall j | 0 <= j < |s2.tasks|
      ensures forall q :: q in problemsOf(s2, s2.tasks[j]) ==> exists i :: 0 <= i < |s.tasks| && q in problemsOf(s, s.tasks[i])
    {
      TCreateTask(s, actor, j);
    }
    TSomeTaskNoNewProblem(s, s2);
  }
}

lemma setStatus_ensures(s: Tracker, id: int, status: Status, actor: string)
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> alwaysTaskNumbersAreUnique(setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> alwaysTheCounterCoversEveryTask(setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> alwaysNoOneIsToldOfTheirOwnEdit(setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> alwaysNothingIsSentTwice(setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> alwaysWhatWasSentIsRecorded(setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> alwaysRemindersAreTimely(setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> alwaysTheBookkeepingIsSane(setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> alwaysTheClockIsNeverNegative(setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> stepADashboardEditIsSignedByAMember(s, setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> stepOnlyAHandEditCorrupts(s, setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> stepANewNumberIsUnreferenced(s, setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> stepTheCounterNeverGoesBack(s, setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> stepANumberIsNeverReissued(s, setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "setStatus", setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> stepAFixRemovesAProblem(s, setStatus(s, id, status, actor)))
  ensures (inv(s) ==> canSetStatus(s, id, status, actor) ==> stepAPassSendsWhatItRecords(s, "setStatus", setStatus(s, id, status, actor), []))
{
  if inv(s) && canSetStatus(s, id, status, actor) {
    var s2 := setStatus(s, id, status, actor);
    TSigned(s, s2, actor);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
    TSameShapeProblems(s, s2);
    TSubsetNoNewProblem(s, s2);
  }
}

lemma setDue_ensures(s: Tracker, id: int, due: int, actor: string)
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> alwaysTaskNumbersAreUnique(setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> alwaysTheCounterCoversEveryTask(setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> alwaysNoOneIsToldOfTheirOwnEdit(setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> alwaysNothingIsSentTwice(setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> alwaysWhatWasSentIsRecorded(setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> alwaysRemindersAreTimely(setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> alwaysTheBookkeepingIsSane(setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> alwaysTheClockIsNeverNegative(setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> stepADashboardEditIsSignedByAMember(s, setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> stepOnlyAHandEditCorrupts(s, setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> stepANewNumberIsUnreferenced(s, setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> stepTheCounterNeverGoesBack(s, setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> stepANumberIsNeverReissued(s, setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "setDue", setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> stepAFixRemovesAProblem(s, setDue(s, id, due, actor)))
  ensures (inv(s) ==> canSetDue(s, id, due, actor) ==> stepAPassSendsWhatItRecords(s, "setDue", setDue(s, id, due, actor), []))
{
  if inv(s) && canSetDue(s, id, due, actor) {
    var s2 := setDue(s, id, due, actor);
    TSigned(s, s2, actor);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
    TSameShapeProblems(s, s2);
    TSubsetNoNewProblem(s, s2);
  }
}

lemma addOwner_ensures(s: Tracker, id: int, owner: string, actor: string)
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> alwaysTaskNumbersAreUnique(addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> alwaysTheCounterCoversEveryTask(addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> alwaysNoOneIsToldOfTheirOwnEdit(addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> alwaysNothingIsSentTwice(addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> alwaysWhatWasSentIsRecorded(addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> alwaysRemindersAreTimely(addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> alwaysTheBookkeepingIsSane(addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> alwaysTheClockIsNeverNegative(addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> stepADashboardEditIsSignedByAMember(s, addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> stepOnlyAHandEditCorrupts(s, addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> stepANewNumberIsUnreferenced(s, addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> stepTheCounterNeverGoesBack(s, addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> stepANumberIsNeverReissued(s, addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "addOwner", addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> stepAFixRemovesAProblem(s, addOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canAddOwner(s, id, owner, actor) ==> stepAPassSendsWhatItRecords(s, "addOwner", addOwner(s, id, owner, actor), []))
{
  if inv(s) && canAddOwner(s, id, owner, actor) {
    var s2 := addOwner(s, id, owner, actor);
    TSigned(s, s2, actor);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
    forall i | 0 <= i < |s.tasks|
      ensures problemsOf(s2, s.tasks[i]) == problemsOf(s2, s2.tasks[i])
    {
      if s.tasks[i].id == id {
        TMemberAddedSameProblems(s2, s.tasks[i], s2.tasks[i], owner);
      }
    }
    TSameProblems(s, s2);
    TSubsetNoNewProblem(s, s2);
  }
}

lemma removeOwner_ensures(s: Tracker, id: int, owner: string, actor: string)
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> alwaysTaskNumbersAreUnique(removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> alwaysTheCounterCoversEveryTask(removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> alwaysNoOneIsToldOfTheirOwnEdit(removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> alwaysNothingIsSentTwice(removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> alwaysWhatWasSentIsRecorded(removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> alwaysRemindersAreTimely(removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> alwaysTheBookkeepingIsSane(removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> alwaysTheClockIsNeverNegative(removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> stepADashboardEditIsSignedByAMember(s, removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> stepOnlyAHandEditCorrupts(s, removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> stepANewNumberIsUnreferenced(s, removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> stepTheCounterNeverGoesBack(s, removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> stepANumberIsNeverReissued(s, removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "removeOwner", removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> stepAFixRemovesAProblem(s, removeOwner(s, id, owner, actor)))
  ensures (inv(s) ==> canRemoveOwner(s, id, owner, actor) ==> stepAPassSendsWhatItRecords(s, "removeOwner", removeOwner(s, id, owner, actor), []))
{
  if inv(s) && canRemoveOwner(s, id, owner, actor) {
    var s2 := removeOwner(s, id, owner, actor);
    TSigned(s, s2, actor);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
    forall i, o | 0 <= i < |s.tasks| && o in s2.tasks[i].owners && !(o in s2.owners)
      ensures o in s.tasks[i].owners && !(o in s.owners)
    {
      if s.tasks[i].id == id {
        ProofLib.FilterMember((y: string) => (y != owner), s.tasks[i].owners, o);
      }
    }
    TOwnersShrinkNoNewProblem(s, s2);
  }
}

lemma addParent_ensures(s: Tracker, id: int, other: int, actor: string)
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> alwaysTaskNumbersAreUnique(addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> alwaysTheCounterCoversEveryTask(addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> alwaysNoOneIsToldOfTheirOwnEdit(addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> alwaysNothingIsSentTwice(addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> alwaysWhatWasSentIsRecorded(addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> alwaysRemindersAreTimely(addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> alwaysTheBookkeepingIsSane(addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> alwaysTheClockIsNeverNegative(addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> stepADashboardEditIsSignedByAMember(s, addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> stepOnlyAHandEditCorrupts(s, addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> stepANewNumberIsUnreferenced(s, addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> stepTheCounterNeverGoesBack(s, addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> stepANumberIsNeverReissued(s, addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "addParent", addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> stepAFixRemovesAProblem(s, addParent(s, id, other, actor)))
  ensures (inv(s) ==> canAddParent(s, id, other, actor) ==> stepAPassSendsWhatItRecords(s, "addParent", addParent(s, id, other, actor), []))
{
  if inv(s) && canAddParent(s, id, other, actor) {
    var s2 := addParent(s, id, other, actor);
    TSigned(s, s2, actor);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
    forall i | 0 <= i < |s.tasks|
      ensures forall q :: q in problemsOf(s2, s2.tasks[i]) ==> q in problemsOf(s, s.tasks[i])
    {
      TAddParentTask(s, id, other, actor, i);
    }
    TEachTaskNoNewProblem(s, s2);
  }
}

lemma removeParent_ensures(s: Tracker, id: int, other: int, actor: string)
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> alwaysTaskNumbersAreUnique(removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> alwaysTheCounterCoversEveryTask(removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> alwaysNoOneIsToldOfTheirOwnEdit(removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> alwaysNothingIsSentTwice(removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> alwaysWhatWasSentIsRecorded(removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> alwaysRemindersAreTimely(removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> alwaysTheBookkeepingIsSane(removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> alwaysTheClockIsNeverNegative(removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> stepADashboardEditIsSignedByAMember(s, removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> stepOnlyAHandEditCorrupts(s, removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> stepANewNumberIsUnreferenced(s, removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> stepTheCounterNeverGoesBack(s, removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> stepANumberIsNeverReissued(s, removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "removeParent", removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> stepAFixRemovesAProblem(s, removeParent(s, id, other, actor)))
  ensures (inv(s) ==> canRemoveParent(s, id, other, actor) ==> stepAPassSendsWhatItRecords(s, "removeParent", removeParent(s, id, other, actor), []))
{
  if inv(s) && canRemoveParent(s, id, other, actor) {
    var s2 := removeParent(s, id, other, actor);
    TSigned(s, s2, actor);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
    forall i | 0 <= i < |s.tasks|
      ensures forall q :: q in problemsOf(s2, s2.tasks[i]) ==> q in problemsOf(s, s.tasks[i])
    {
      TRemoveParentTask(s, id, other, actor, i);
    }
    TEachTaskNoNewProblem(s, s2);
  }
}

lemma relate_ensures(s: Tracker, id: int, other: int, actor: string)
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> alwaysTaskNumbersAreUnique(relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> alwaysTheCounterCoversEveryTask(relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> alwaysNoOneIsToldOfTheirOwnEdit(relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> alwaysNothingIsSentTwice(relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> alwaysWhatWasSentIsRecorded(relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> alwaysRemindersAreTimely(relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> alwaysTheBookkeepingIsSane(relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> alwaysTheClockIsNeverNegative(relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> stepADashboardEditIsSignedByAMember(s, relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> stepOnlyAHandEditCorrupts(s, relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> stepANewNumberIsUnreferenced(s, relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> stepTheCounterNeverGoesBack(s, relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> stepANumberIsNeverReissued(s, relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "relate", relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> stepAFixRemovesAProblem(s, relate(s, id, other, actor)))
  ensures (inv(s) ==> canRelate(s, id, other, actor) ==> stepAPassSendsWhatItRecords(s, "relate", relate(s, id, other, actor), []))
{
  if inv(s) && canRelate(s, id, other, actor) {
    var s2 := relate(s, id, other, actor);
    TSigned(s, s2, actor);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
    forall i | 0 <= i < |s.tasks|
      ensures forall q :: q in problemsOf(s2, s2.tasks[i]) ==> q in problemsOf(s, s.tasks[i])
    {
      TRelateTask(s, id, other, actor, i);
    }
    TEachTaskNoNewProblem(s, s2);
  }
}

lemma unrelate_ensures(s: Tracker, id: int, other: int, actor: string)
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> alwaysTaskNumbersAreUnique(unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> alwaysTheCounterCoversEveryTask(unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> alwaysNoOneIsToldOfTheirOwnEdit(unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> alwaysNothingIsSentTwice(unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> alwaysWhatWasSentIsRecorded(unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> alwaysRemindersAreTimely(unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> alwaysTheBookkeepingIsSane(unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> alwaysTheClockIsNeverNegative(unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> stepADashboardEditIsSignedByAMember(s, unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> stepOnlyAHandEditCorrupts(s, unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> stepANewNumberIsUnreferenced(s, unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> stepTheCounterNeverGoesBack(s, unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> stepANumberIsNeverReissued(s, unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "unrelate", unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> stepAFixRemovesAProblem(s, unrelate(s, id, other, actor)))
  ensures (inv(s) ==> canUnrelate(s, id, other, actor) ==> stepAPassSendsWhatItRecords(s, "unrelate", unrelate(s, id, other, actor), []))
{
  if inv(s) && canUnrelate(s, id, other, actor) {
    var s2 := unrelate(s, id, other, actor);
    TSigned(s, s2, actor);
    TUnrelateBookkeeping(s, id, other, actor);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
    forall i | 0 <= i < |s.tasks|
      ensures forall q :: q in problemsOf(s2, s2.tasks[i]) ==> q in problemsOf(s, s.tasks[i])
    {
      TUnrelateTask(s, id, other, actor, i);
    }
    TEachTaskNoNewProblem(s, s2);
  }
}

lemma deleteTask_ensures(s: Tracker, id: int, actor: string)
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> alwaysTaskNumbersAreUnique(deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> alwaysTheCounterCoversEveryTask(deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> alwaysNoOneIsToldOfTheirOwnEdit(deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> alwaysNothingIsSentTwice(deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> alwaysWhatWasSentIsRecorded(deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> alwaysRemindersAreTimely(deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> alwaysTheBookkeepingIsSane(deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> alwaysTheClockIsNeverNegative(deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> stepADashboardEditIsSignedByAMember(s, deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> stepOnlyAHandEditCorrupts(s, deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> stepANewNumberIsUnreferenced(s, deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> stepTheCounterNeverGoesBack(s, deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> stepANumberIsNeverReissued(s, deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "deleteTask", deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> stepAFixRemovesAProblem(s, deleteTask(s, id, actor)))
  ensures (inv(s) ==> canDeleteTask(s, id, actor) ==> stepAPassSendsWhatItRecords(s, "deleteTask", deleteTask(s, id, actor), []))
{
  if inv(s) && canDeleteTask(s, id, actor) {
    var s2 := deleteTask(s, id, actor);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    var kept := ProofLib.Filter((t: Task) => (t.id != id), s.tasks);
    assert |s2.tasks| == |kept|;
    assert forall j :: 0 <= j < |kept| ==> s2.tasks[j] == kept[j].(parents := drop(kept[j].parents, id), related := drop(kept[j].related, id));
    TFilterKeepsUnique((t: Task) => (t.id != id), s.tasks);
    TIdsKeptUnique(kept, s2.tasks);
    ProofLib.FilterSubset((t: Task) => (t.id != id), s.tasks);
    forall j | 0 <= j < |s2.tasks|
      ensures exists i :: 0 <= i < |s.tasks| && s.tasks[i].id == s2.tasks[j].id && s.tasks[i].notifiedAt == s2.tasks[j].notifiedAt && s.tasks[i].updatedAt == s2.tasks[j].updatedAt && s.tasks[i].toldSoon == s2.tasks[j].toldSoon && s.tasks[i].toldDue == s2.tasks[j].toldDue
    {
      assert kept[j] in s.tasks;
      var i :| 0 <= i < |s.tasks| && s.tasks[i] == kept[j];
    }
    TSentRecordedKept(s, s2);
    forall j | 0 <= j < |s2.tasks|
      ensures hasTask(s, s2.tasks[j].id)
    {
      assert kept[j] in s.tasks;
    }
    forall j | 0 <= j < |s2.tasks|
      ensures keepsItsSignature(s, s2.tasks[j])
    {
      assert kept[j] in s.tasks;
    }
    TOldNumbers(s, s2);
    forall j | 0 <= j < |s2.tasks|
      ensures exists i :: 0 <= i < |s.tasks| && forall q :: q in problemsOf(s2, s2.tasks[j]) ==> q in problemsOf(s, s.tasks[i])
    {
      TDeleteTaskTask(s, id, actor, j);
    }
    TSomeTaskNoNewProblem(s, s2);
  }
}

lemma renameOwner_ensures(s: Tracker, owner: string, name: string, actor: string)
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> alwaysTaskNumbersAreUnique(renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> alwaysTheCounterCoversEveryTask(renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> alwaysNoOneIsToldOfTheirOwnEdit(renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> alwaysNothingIsSentTwice(renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> alwaysWhatWasSentIsRecorded(renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> alwaysRemindersAreTimely(renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> alwaysTheBookkeepingIsSane(renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> alwaysTheClockIsNeverNegative(renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> stepADashboardEditIsSignedByAMember(s, renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> stepOnlyAHandEditCorrupts(s, renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> stepANewNumberIsUnreferenced(s, renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> stepTheCounterNeverGoesBack(s, renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> stepANumberIsNeverReissued(s, renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "renameOwner", renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> stepAFixRemovesAProblem(s, renameOwner(s, owner, name, actor)))
  ensures (inv(s) ==> canRenameOwner(s, owner, name, actor) ==> stepAPassSendsWhatItRecords(s, "renameOwner", renameOwner(s, owner, name, actor), []))
{
  if inv(s) && canRenameOwner(s, owner, name, actor) {
    var s2 := renameOwner(s, owner, name, actor);
    var w :| 0 <= w < |s.owners| && s.owners[w] == owner;
    assert s2.owners[w] == name;
    TSigned(s, s2, name);
    assert !(owner in s2.owners);
    forall i | 0 <= i < |s2.tasks|
      ensures var b := s.tasks[i]; var t := s2.tasks[i];
        b in s.tasks && b.id == t.id && (if b.authorIsMember && b.updatedBy in s.owners && !(b.updatedBy in s2.owners) then t.updatedBy in s2.owners && !(t.updatedBy in s.owners) else t.updatedBy == b.updatedBy)
    {
      var x := s.tasks[i].updatedBy;
      if x in s.owners && x != owner {
        var v :| 0 <= v < |s.owners| && s.owners[v] == x;
        assert s2.owners[v] == x;
      }
    }
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
    forall i, o | 0 <= i < |s.tasks| && o in s2.tasks[i].owners && !(o in s2.owners)
      ensures o in s.tasks[i].owners && !(o in s.owners)
    {
      var t := s.tasks[i];
      var renamed := (var s_map := t.owners; seq(|s_map|, i_map requires 0 <= i_map < |s_map| => var o := s_map[i_map]; (if (o == owner) then name else o)));
      assert s2.tasks[i].owners == distinctNames(renamed);
      ProofLib.FoldLeftDedupMember((acc: seq<string>, x: string) => (if (x in acc) then acc else (acc + [x])), [], renamed, o);
      var k :| 0 <= k < |renamed| && renamed[k] == o;
      if o in s.owners {
        var v :| 0 <= v < |s.owners| && s.owners[v] == o;
        assert s2.owners[v] == o;
      }
    }
    TOwnersShrinkNoNewProblem(s, s2);
  }
}

lemma deleteOwner_ensures(s: Tracker, owner: string, actor: string)
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> alwaysTaskNumbersAreUnique(deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> alwaysTheCounterCoversEveryTask(deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> alwaysNoOneIsToldOfTheirOwnEdit(deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> alwaysNothingIsSentTwice(deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> alwaysWhatWasSentIsRecorded(deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> alwaysRemindersAreTimely(deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> alwaysTheBookkeepingIsSane(deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> alwaysTheClockIsNeverNegative(deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> stepADashboardEditIsSignedByAMember(s, deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> stepOnlyAHandEditCorrupts(s, deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> stepANewNumberIsUnreferenced(s, deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> stepTheCounterNeverGoesBack(s, deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> stepANumberIsNeverReissued(s, deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "deleteOwner", deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> stepAFixRemovesAProblem(s, deleteOwner(s, owner, actor)))
  ensures (inv(s) ==> canDeleteOwner(s, owner, actor) ==> stepAPassSendsWhatItRecords(s, "deleteOwner", deleteOwner(s, owner, actor), []))
{
  if inv(s) && canDeleteOwner(s, owner, actor) {
    var s2 := deleteOwner(s, owner, actor);
    TSigned(s, s2, actor);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
    forall i, o | 0 <= i < |s.tasks| && o in s2.tasks[i].owners && !(o in s2.owners)
      ensures o in s.tasks[i].owners && !(o in s.owners)
    {
      ProofLib.FilterMember((y: string) => (y != owner), s.tasks[i].owners, o);
      ProofLib.FilterMember((y: string) => (y != owner), s.owners, o);
    }
    TOwnersShrinkNoNewProblem(s, s2);
  }
}

lemma handAddOwner_ensures(s: Tracker, id: int, name: string)
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> alwaysTaskNumbersAreUnique(handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> alwaysTheCounterCoversEveryTask(handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> alwaysNoOneIsToldOfTheirOwnEdit(handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> alwaysNothingIsSentTwice(handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> alwaysWhatWasSentIsRecorded(handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> alwaysRemindersAreTimely(handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> alwaysTheBookkeepingIsSane(handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> alwaysTheClockIsNeverNegative(handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> stepADashboardEditIsSignedByAMember(s, handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> stepOnlyAHandEditCorrupts(s, handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> stepANewNumberIsUnreferenced(s, handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> stepTheCounterNeverGoesBack(s, handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> stepANumberIsNeverReissued(s, handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "handAddOwner", handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> stepAFixRemovesAProblem(s, handAddOwner(s, id, name)))
  ensures (inv(s) ==> canHandAddOwner(s, id, name) ==> stepAPassSendsWhatItRecords(s, "handAddOwner", handAddOwner(s, id, name), []))
{
  if inv(s) && canHandAddOwner(s, id, name) {
    var s2 := handAddOwner(s, id, name);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
  }
}

lemma handAddParent_ensures(s: Tracker, id: int, other: int)
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> alwaysTaskNumbersAreUnique(handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> alwaysTheCounterCoversEveryTask(handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> alwaysNoOneIsToldOfTheirOwnEdit(handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> alwaysNothingIsSentTwice(handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> alwaysWhatWasSentIsRecorded(handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> alwaysRemindersAreTimely(handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> alwaysTheBookkeepingIsSane(handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> alwaysTheClockIsNeverNegative(handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> stepADashboardEditIsSignedByAMember(s, handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> stepOnlyAHandEditCorrupts(s, handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> stepANewNumberIsUnreferenced(s, handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> stepTheCounterNeverGoesBack(s, handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> stepANumberIsNeverReissued(s, handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "handAddParent", handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> stepAFixRemovesAProblem(s, handAddParent(s, id, other)))
  ensures (inv(s) ==> canHandAddParent(s, id, other) ==> stepAPassSendsWhatItRecords(s, "handAddParent", handAddParent(s, id, other), []))
{
  if inv(s) && canHandAddParent(s, id, other) {
    var s2 := handAddParent(s, id, other);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
  }
}

lemma handAddRelated_ensures(s: Tracker, id: int, other: int)
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> alwaysTaskNumbersAreUnique(handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> alwaysTheCounterCoversEveryTask(handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> alwaysNoOneIsToldOfTheirOwnEdit(handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> alwaysNothingIsSentTwice(handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> alwaysWhatWasSentIsRecorded(handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> alwaysRemindersAreTimely(handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> alwaysTheBookkeepingIsSane(handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> alwaysTheClockIsNeverNegative(handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> stepADashboardEditIsSignedByAMember(s, handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> stepOnlyAHandEditCorrupts(s, handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> stepANewNumberIsUnreferenced(s, handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> stepTheCounterNeverGoesBack(s, handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> stepANumberIsNeverReissued(s, handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "handAddRelated", handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> stepAFixRemovesAProblem(s, handAddRelated(s, id, other)))
  ensures (inv(s) ==> canHandAddRelated(s, id, other) ==> stepAPassSendsWhatItRecords(s, "handAddRelated", handAddRelated(s, id, other), []))
{
  if inv(s) && canHandAddRelated(s, id, other) {
    var s2 := handAddRelated(s, id, other);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
  }
}

lemma handDeleteTask_ensures(s: Tracker, id: int)
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> alwaysTaskNumbersAreUnique(handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> alwaysTheCounterCoversEveryTask(handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> alwaysNoOneIsToldOfTheirOwnEdit(handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> alwaysNothingIsSentTwice(handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> alwaysWhatWasSentIsRecorded(handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> alwaysRemindersAreTimely(handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> alwaysTheBookkeepingIsSane(handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> alwaysTheClockIsNeverNegative(handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> stepADashboardEditIsSignedByAMember(s, handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> stepOnlyAHandEditCorrupts(s, handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> stepANewNumberIsUnreferenced(s, handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> stepTheCounterNeverGoesBack(s, handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> stepANumberIsNeverReissued(s, handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "handDeleteTask", handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> stepAFixRemovesAProblem(s, handDeleteTask(s, id)))
  ensures (inv(s) ==> canHandDeleteTask(s, id) ==> stepAPassSendsWhatItRecords(s, "handDeleteTask", handDeleteTask(s, id), []))
{
  if inv(s) && canHandDeleteTask(s, id) {
    var s2 := handDeleteTask(s, id);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TFilterKeepsUnique((t: Task) => (t.id != id), s.tasks);
    ProofLib.FilterSubset((t: Task) => (t.id != id), s.tasks);
    forall j | 0 <= j < |s2.tasks|
      ensures exists i :: 0 <= i < |s.tasks| && s.tasks[i] == s2.tasks[j]
    {
      assert s2.tasks[j] in s.tasks;
    }
    TSentRecordedKept(s, s2);
    forall j | 0 <= j < |s2.tasks|
      ensures hasTask(s, s2.tasks[j].id)
    {
      assert s2.tasks[j] in s.tasks;
    }
    TOldNumbers(s, s2);
  }
}

lemma handDeleteOwner_ensures(s: Tracker, owner: string)
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> alwaysTaskNumbersAreUnique(handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> alwaysTheCounterCoversEveryTask(handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> alwaysNoOneIsToldOfTheirOwnEdit(handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> alwaysNothingIsSentTwice(handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> alwaysWhatWasSentIsRecorded(handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> alwaysRemindersAreTimely(handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> alwaysTheBookkeepingIsSane(handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> alwaysTheClockIsNeverNegative(handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> stepADashboardEditIsSignedByAMember(s, handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> stepOnlyAHandEditCorrupts(s, handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> stepANewNumberIsUnreferenced(s, handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> stepTheCounterNeverGoesBack(s, handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> stepANumberIsNeverReissued(s, handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "handDeleteOwner", handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> stepAFixRemovesAProblem(s, handDeleteOwner(s, owner)))
  ensures (inv(s) ==> canHandDeleteOwner(s, owner) ==> stepAPassSendsWhatItRecords(s, "handDeleteOwner", handDeleteOwner(s, owner), []))
{
  if inv(s) && canHandDeleteOwner(s, owner) {
    var s2 := handDeleteOwner(s, owner);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
    TSentRecordedKept(s, s2);
  }
}

lemma fix_ensures(s: Tracker, index: int, actor: string)
  ensures (inv(s) ==> canFix(s, index, actor) ==> alwaysTaskNumbersAreUnique(fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> alwaysTheCounterCoversEveryTask(fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> alwaysNoOneIsToldOfTheirOwnEdit(fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> alwaysNothingIsSentTwice(fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> alwaysWhatWasSentIsRecorded(fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> alwaysRemindersAreTimely(fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> alwaysTheBookkeepingIsSane(fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> alwaysTheClockIsNeverNegative(fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> stepADashboardEditIsSignedByAMember(s, fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> stepOnlyAHandEditCorrupts(s, fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> stepANewNumberIsUnreferenced(s, fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> stepTheCounterNeverGoesBack(s, fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> stepANumberIsNeverReissued(s, fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "fix", fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> stepAFixRemovesAProblem(s, fix(s, index, actor)))
  ensures (inv(s) ==> canFix(s, index, actor) ==> stepAPassSendsWhatItRecords(s, "fix", fix(s, index, actor), []))
{
  if inv(s) && canFix(s, index, actor) {
    var s2 := fix(s, index, actor);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
    forall k | 0 <= k < |s.tasks|
      ensures forall q :: q in problemsOf(s2, s2.tasks[k]) ==> q in problemsOf(s, s.tasks[k])
    {
      TFixTask(s, index, k, actor);
    }
    TEachTaskNoNewProblem(s, s2);
    TFixShortens(s, index, actor);
  }
}

lemma tick_ensures(s: Tracker)
  ensures (inv(s) ==> alwaysTaskNumbersAreUnique(tick(s)))
  ensures (inv(s) ==> alwaysTheCounterCoversEveryTask(tick(s)))
  ensures (inv(s) ==> alwaysNoOneIsToldOfTheirOwnEdit(tick(s)))
  ensures (inv(s) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(tick(s)))
  ensures (inv(s) ==> alwaysNothingIsSentTwice(tick(s)))
  ensures (inv(s) ==> alwaysWhatWasSentIsRecorded(tick(s)))
  ensures (inv(s) ==> alwaysRemindersAreTimely(tick(s)))
  ensures (inv(s) ==> alwaysTheBookkeepingIsSane(tick(s)))
  ensures (inv(s) ==> alwaysTheClockIsNeverNegative(tick(s)))
  ensures (inv(s) ==> stepADashboardEditIsSignedByAMember(s, tick(s)))
  ensures (inv(s) ==> stepOnlyAHandEditCorrupts(s, tick(s)))
  ensures (inv(s) ==> stepANewNumberIsUnreferenced(s, tick(s)))
  ensures (inv(s) ==> stepTheCounterNeverGoesBack(s, tick(s)))
  ensures (inv(s) ==> stepANumberIsNeverReissued(s, tick(s)))
  ensures (inv(s) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "tick", tick(s)))
  ensures (inv(s) ==> stepAFixRemovesAProblem(s, tick(s)))
  ensures (inv(s) ==> stepAPassSendsWhatItRecords(s, "tick", tick(s), []))
{
  if inv(s) {
    var s2 := tick(s);
    TSameIdsOldNumbers(s, s2);
    TSameShapeProblems(s, s2);
    TSubsetNoNewProblem(s, s2);
  }
}

lemma notify_ensures(s: Tracker)
  ensures (inv(s) ==> alwaysTaskNumbersAreUnique(notify(s).state))
  ensures (inv(s) ==> alwaysTheCounterCoversEveryTask(notify(s).state))
  ensures (inv(s) ==> alwaysNoOneIsToldOfTheirOwnEdit(notify(s).state))
  ensures (inv(s) ==> alwaysAnEditIsAnnouncedAfterTheQuietPeriod(notify(s).state))
  ensures (inv(s) ==> alwaysNothingIsSentTwice(notify(s).state))
  ensures (inv(s) ==> alwaysWhatWasSentIsRecorded(notify(s).state))
  ensures (inv(s) ==> alwaysRemindersAreTimely(notify(s).state))
  ensures (inv(s) ==> alwaysTheBookkeepingIsSane(notify(s).state))
  ensures (inv(s) ==> alwaysTheClockIsNeverNegative(notify(s).state))
  ensures (inv(s) ==> stepADashboardEditIsSignedByAMember(s, notify(s).state))
  ensures (inv(s) ==> stepOnlyAHandEditCorrupts(s, notify(s).state))
  ensures (inv(s) ==> stepANewNumberIsUnreferenced(s, notify(s).state))
  ensures (inv(s) ==> stepTheCounterNeverGoesBack(s, notify(s).state))
  ensures (inv(s) ==> stepANumberIsNeverReissued(s, notify(s).state))
  ensures (inv(s) ==> stepARenamedPersonSignsTheirEditsUnderTheNewName(s, "notify", notify(s).state))
  ensures (inv(s) ==> stepAFixRemovesAProblem(s, notify(s).state))
  ensures (inv(s) ==> stepAPassSendsWhatItRecords(s, "notify", notify(s).state, notify(s).out))
{
  if inv(s) {
    var s2 := notify(s).state;
    TNotifyAnnouncedAndTimely(s);
    TNotifyRecorded(s);
    TNotifyNothingSentTwice(s);
    TUniqueBridge(s);
    TUniqueBridge(s2);
    TIdsKeptUnique(s.tasks, s2.tasks);
    TSameIdsOldNumbers(s, s2);
    TSameShapeProblems(s, s2);
    TSubsetNoNewProblem(s, s2);
  }
}

// ===== A task edited through the dashboard is signed by a member =====

// A dashboard edit that keeps each task's signature in place, or signs it with a member after the edit, satisfies the rule.
lemma TSigned(s: Tracker, s2: Tracker, actor: string)
  requires s2.last.App?
  requires forall i :: 0 <= i < |s2.tasks| ==> (s2.tasks[i].updatedBy == actor && actor in s2.owners) || (i < |s.tasks| && s2.tasks[i].id == s.tasks[i].id && s2.tasks[i].updatedAt == s.tasks[i].updatedAt && s2.tasks[i].updatedBy == s.tasks[i].updatedBy)
  ensures stepADashboardEditIsSignedByAMember(s, s2)
{
  forall t | t in s2.tasks
    ensures keepsItsSignature(s, t) || isMember(s2, t.updatedBy)
  {
    var i :| 0 <= i < |s2.tasks| && s2.tasks[i] == t;
    if !(t.updatedBy == actor && actor in s2.owners) {
      assert s.tasks[i] in s.tasks;
    }
  }
}

// ===== Task numbers are unique =====

// The rule, restated over ProofLib.Filter.
lemma TUniqueBridge(s: Tracker)
  ensures alwaysTaskNumbersAreUnique(s) == !(exists a :: a in s.tasks && !(|ProofLib.Filter((b: Task) => (b.id == a.id), s.tasks)| == 1))
{
}

// A map over the tasks that keeps every number keeps the numbers unique.
lemma TIdsKeptUnique(xs: seq<Task>, ys: seq<Task>)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> xs[i].id == ys[i].id
  requires !(exists a :: a in xs && !(|ProofLib.Filter((b: Task) => (b.id == a.id), xs)| == 1))
  ensures !(exists a :: a in ys && !(|ProofLib.Filter((b: Task) => (b.id == a.id), ys)| == 1))
{
  forall j | 0 <= j < |ys|
    ensures |ProofLib.Filter((b: Task) => (b.id == ys[j].id), ys)| == 1
  {
    var a := xs[j];
    var a2 := ys[j];
    assert |ProofLib.Filter((b: Task) => (b.id == a.id), xs)| == 1;
    ProofLib.FilterLengthPointwise((b: Task) => (b.id == a.id), (b: Task) => (b.id == a2.id), xs, ys);
  }
}

// Appending a task whose number is above every other keeps the numbers unique.
lemma TAppendFreshUnique(xs: seq<Task>, n: Task)
  requires forall i :: 0 <= i < |xs| ==> xs[i].id < n.id
  requires !(exists a :: a in xs && !(|ProofLib.Filter((b: Task) => (b.id == a.id), xs)| == 1))
  ensures !(exists a :: a in xs + [n] && !(|ProofLib.Filter((b: Task) => (b.id == a.id), xs + [n])| == 1))
{
  var ys := xs + [n];
  forall j | 0 <= j < |ys|
    ensures |ProofLib.Filter((b: Task) => (b.id == ys[j].id), ys)| == 1
  {
    var a := ys[j];
    ProofLib.FilterAppend((b: Task) => (b.id == a.id), xs, n);
    if j == |xs| {
      ProofLib.FilterNone((b: Task) => (b.id == a.id), xs);
    } else {
      assert a == xs[j];
    }
  }
}

// Filtering the tasks keeps the numbers unique.
lemma TFilterKeepsUnique(f: Task -> bool, xs: seq<Task>)
  requires !(exists a :: a in xs && !(|ProofLib.Filter((b: Task) => (b.id == a.id), xs)| == 1))
  ensures !(exists a :: a in ProofLib.Filter(f, xs) && !(|ProofLib.Filter((b: Task) => (b.id == a.id), ProofLib.Filter(f, xs))| == 1))
{
  var ys := ProofLib.Filter(f, xs);
  ProofLib.FilterSubset(f, xs);
  forall j | 0 <= j < |ys|
    ensures |ProofLib.Filter((b: Task) => (b.id == ys[j].id), ys)| == 1
  {
    var a := ys[j];
    var k :| 0 <= k < |xs| && xs[k] == a;
    assert |ProofLib.Filter((b: Task) => (b.id == a.id), xs)| == 1;
    ProofLib.FilterOfFilterShorter(f, (b: Task) => (b.id == a.id), xs);
    ProofLib.FilterNone((b: Task) => (b.id == a.id), ys);
  }
}

// ===== The warning list is the truth, for every state =====

// One task has no problem exactly when it is well formed.
lemma TTaskClean(s: Tracker, t: Task)
  requires t in s.tasks
  ensures |problemsOf(s, t)| == 0 <==> ((((((!(exists o :: o in t.owners && !(o in s.owners)) && !(exists p :: p in t.parents && !(hasTask(s, p)))) && !(exists r :: r in t.related && !(hasTask(s, r)))) && !((t.id in t.parents))) && !((t.id in t.related))) && !((t.id in ancestors(s, t.id)))) && !(exists r :: r in t.related && !(linksBack(s, r, t.id))))
{
  assert hasTask(s, t.id);
  ProofLib.FilterNone((o: string) => !((o in s.owners)), t.owners);
  ProofLib.FilterNone((p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents);
  ProofLib.FilterNone((r: int) => ((r != t.id) && !(hasTask(s, r))), t.related);
  ProofLib.FilterNone((r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related);
}

lemma lawTheWarningListIsTheTruth_ensures(s: Tracker)
  ensures (lawTheWarningListIsTheTruth(s) == true)
{
  ProofLib.FoldLeftConcatEmpty((acc: seq<Problem>, t: Task) => (acc + problemsOf(s, t)), (t: Task) => problemsOf(s, t), [], s.tasks);
  forall i | 0 <= i < |s.tasks|
    ensures |problemsOf(s, s.tasks[i])| == 0 <==> ((((((!(exists o :: o in s.tasks[i].owners && !(o in s.owners)) && !(exists p :: p in s.tasks[i].parents && !(hasTask(s, p)))) && !(exists r :: r in s.tasks[i].related && !(hasTask(s, r)))) && !((s.tasks[i].id in s.tasks[i].parents))) && !((s.tasks[i].id in s.tasks[i].related))) && !((s.tasks[i].id in ancestors(s, s.tasks[i].id)))) && !(exists r :: r in s.tasks[i].related && !(linksBack(s, r, s.tasks[i].id))))
  {
    TTaskClean(s, s.tasks[i]);
  }
}

// ===== Each name is listed once =====

lemma lawEachNameIsListedOnce_ensures(xs: seq<string>)
  ensures (lawEachNameIsListedOnce(xs) == true)
{
  var d := distinctNames(xs);
  ProofLib.FoldLeftDedupDistinct((acc: seq<string>, x: string) => (if (x in acc) then acc else (acc + [x])), [], xs);
  forall k | 0 <= k < |d|
    ensures var o := d[k]; |ProofLib.Filter((x: string) => (x == o), d)| == 1
  {
    var o := d[k];
    ProofLib.FilterDistinctCountOne((x: string) => (x == o), d, o);
  }
}

// ===== A step issues no new number, except create =====

// Every task after has the number of a task before.
lemma TOldNumbers(s: Tracker, s2: Tracker)
  requires forall j :: 0 <= j < |s2.tasks| ==> hasTask(s, s2.tasks[j].id)
  ensures stepANewNumberIsUnreferenced(s, s2)
{
}

// The same, when every task keeps its number and its position.
lemma TSameIdsOldNumbers(s: Tracker, s2: Tracker)
  requires |s.tasks| == |s2.tasks|
  requires forall i :: 0 <= i < |s.tasks| ==> s.tasks[i].id == s2.tasks[i].id
  ensures stepANewNumberIsUnreferenced(s, s2)
{
  forall j | 0 <= j < |s2.tasks|
    ensures hasTask(s, s2.tasks[j].id)
  {
    assert s.tasks[j] in s.tasks;
  }
  TOldNumbers(s, s2);
}

// ===== Problems depend only on the members and each task's number, owners and links =====

// Same task numbers and links, position by position: the same tasks exist, and link back alike.
lemma TSameLinksHasTask(s: Tracker, s2: Tracker)
  requires |s.tasks| == |s2.tasks|
  requires forall i :: 0 <= i < |s.tasks| ==> s.tasks[i].id == s2.tasks[i].id && s.tasks[i].related == s2.tasks[i].related
  ensures forall p :: hasTask(s, p) == hasTask(s2, p)
  ensures forall r, id :: linksBack(s, r, id) == linksBack(s2, r, id)
{
  TSameIdsHasTask(s, s2);
  forall r, id
    ensures linksBack(s, r, id) == linksBack(s2, r, id)
  {
    if linksBack(s, r, id) {
      var t :| t in s.tasks && t.id == r && id in t.related;
      var i :| 0 <= i < |s.tasks| && s.tasks[i] == t;
      assert s2.tasks[i] in s2.tasks;
    }
    if linksBack(s2, r, id) {
      var t :| t in s2.tasks && t.id == r && id in t.related;
      var i :| 0 <= i < |s2.tasks| && s2.tasks[i] == t;
      assert s.tasks[i] in s.tasks;
    }
  }
}

lemma TSameParentsParentsOfAll(s: Tracker, s2: Tracker)
  requires |s.tasks| == |s2.tasks|
  requires forall i :: 0 <= i < |s.tasks| ==> s.tasks[i].id == s2.tasks[i].id && s.tasks[i].parents == s2.tasks[i].parents
  ensures forall ids :: parentsOfAll(s, ids) == parentsOfAll(s2, ids)
{
  forall ids
    ensures parentsOfAll(s, ids) == parentsOfAll(s2, ids)
  {
    var keep := (t: Task) => (t.id in ids);
    ProofLib.FilterPointwise(keep, keep, (a: Task, b: Task) => (a.id == b.id && a.parents == b.parents), s.tasks, s2.tasks);
    var f := (acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => ((p != t.id) && !((p in acc))), t.parents));
    ProofLib.FoldLeftPointwise(f, f, [], ProofLib.Filter(keep, s.tasks), ProofLib.Filter(keep, s2.tasks));
  }
}

lemma TSameParentsAncestors(s: Tracker, s2: Tracker)
  requires |s.tasks| == |s2.tasks|
  requires forall i :: 0 <= i < |s.tasks| ==> s.tasks[i].id == s2.tasks[i].id && s.tasks[i].parents == s2.tasks[i].parents
  ensures forall id :: ancestors(s, id) == ancestors(s2, id)
{
  TSameParentsParentsOfAll(s, s2);
  forall id
    ensures ancestors(s, id) == ancestors(s2, id)
  {
    ProofLib.FoldLeftPointwise(
      (acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))),
      (acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s2, acc))),
      parentsOfAll(s, [id]), s.tasks, s2.tasks);
  }
}

// Same members and links: one task's problems are judged alike in both states.
lemma TSameLinksProblemsOf(s: Tracker, s2: Tracker)
  requires s.owners == s2.owners && |s.tasks| == |s2.tasks|
  requires forall i :: 0 <= i < |s.tasks| ==> s.tasks[i].id == s2.tasks[i].id && s.tasks[i].parents == s2.tasks[i].parents && s.tasks[i].related == s2.tasks[i].related
  ensures forall t :: problemsOf(s, t) == problemsOf(s2, t)
{
  TSameLinksNoOwners(s, s2);
  forall t: Task
    ensures problemsOf(s, t) == problemsOf(s2, t)
  {
    TProblemsOfSplit(s, t);
    TProblemsOfSplit(s2, t);
  }
}

// Same members and links, and each task's problems unchanged: the warning list is unchanged.
lemma TSameProblems(s: Tracker, s2: Tracker)
  requires s.owners == s2.owners && |s.tasks| == |s2.tasks|
  requires forall i :: 0 <= i < |s.tasks| ==> s.tasks[i].id == s2.tasks[i].id && s.tasks[i].parents == s2.tasks[i].parents && s.tasks[i].related == s2.tasks[i].related
  requires forall i :: 0 <= i < |s.tasks| ==> problemsOf(s2, s.tasks[i]) == problemsOf(s2, s2.tasks[i])
  ensures problems(s) == problems(s2)
{
  TSameLinksProblemsOf(s, s2);
  ProofLib.FoldLeftPointwise((acc: seq<Problem>, t: Task) => (acc + problemsOf(s, t)), (acc: seq<Problem>, t: Task) => (acc + problemsOf(s2, t)), [], s.tasks, s2.tasks);
}

// Same members, and each task keeps its number, owners and links: the warning list is unchanged.
lemma TSameShapeProblems(s: Tracker, s2: Tracker)
  requires s.owners == s2.owners && |s.tasks| == |s2.tasks|
  requires forall i :: 0 <= i < |s.tasks| ==> s.tasks[i].id == s2.tasks[i].id && s.tasks[i].owners == s2.tasks[i].owners && s.tasks[i].parents == s2.tasks[i].parents && s.tasks[i].related == s2.tasks[i].related
  ensures problems(s) == problems(s2)
{
  forall i | 0 <= i < |s.tasks|
    ensures problemsOf(s2, s.tasks[i]) == problemsOf(s2, s2.tasks[i])
  {
    var a := s.tasks[i];
    var b := s2.tasks[i];
    assert a.id == b.id && a.owners == b.owners && a.parents == b.parents && a.related == b.related;
  }
  TSameProblems(s, s2);
}

// ===== Counter and bookkeeping when tasks are only removed =====

// ===== What was sent is recorded (alwaysWhatWasSentIsRecorded) =====

// Every note sent before is still recorded when each remaining task is an old one that recorded at least as much, or a new number.
lemma TOldNotesRecorded(s: Tracker, s2: Tracker)
  requires alwaysWhatWasSentIsRecorded(s)
  requires s2.lastId >= s.lastId
  requires forall j :: 0 <= j < |s2.tasks| ==> (s2.tasks[j].id > s.lastId || exists i :: 0 <= i < |s.tasks| && s.tasks[i].id == s2.tasks[j].id && s.tasks[i].notifiedAt <= s2.tasks[j].notifiedAt && (forall v :: v in s.tasks[i].toldSoon ==> v in s2.tasks[j].toldSoon) && (forall v :: v in s.tasks[i].toldDue ==> v in s2.tasks[j].toldDue))
  ensures forall k :: 0 <= k < |s.sent| ==> (s.sent[k].task <= s2.lastId && forall j :: 0 <= j < |s2.tasks| ==> (s2.tasks[j].id == s.sent[k].task ==> ((s.sent[k].kind.Update? ==> s.sent[k].version <= s2.tasks[j].notifiedAt) && (s.sent[k].kind.Soon? ==> s.sent[k].version in s2.tasks[j].toldSoon) && (s.sent[k].kind.Today? ==> s.sent[k].version in s2.tasks[j].toldDue))))
{
  forall k, j | 0 <= k < |s.sent| && 0 <= j < |s2.tasks| && s2.tasks[j].id == s.sent[k].task
    ensures (s.sent[k].kind.Update? ==> s.sent[k].version <= s2.tasks[j].notifiedAt) && (s.sent[k].kind.Soon? ==> s.sent[k].version in s2.tasks[j].toldSoon) && (s.sent[k].kind.Today? ==> s.sent[k].version in s2.tasks[j].toldDue)
  {
    var n := s.sent[k];
    assert n.task <= s.lastId;
    var i :| 0 <= i < |s.tasks| && s.tasks[i].id == s2.tasks[j].id && s.tasks[i].notifiedAt <= s2.tasks[j].notifiedAt && (forall v :: v in s.tasks[i].toldSoon ==> v in s2.tasks[j].toldSoon) && (forall v :: v in s.tasks[i].toldDue ==> v in s2.tasks[j].toldDue);
    var t := s.tasks[i];
    assert t.id == n.task;
  }
}

// The same, when nothing new was sent.
lemma TSentRecordedKept(s: Tracker, s2: Tracker)
  requires alwaysWhatWasSentIsRecorded(s)
  requires s2.sent == s.sent && s2.lastId >= s.lastId
  requires forall j :: 0 <= j < |s2.tasks| ==> (s2.tasks[j].id > s.lastId || exists i :: 0 <= i < |s.tasks| && s.tasks[i].id == s2.tasks[j].id && s.tasks[i].notifiedAt <= s2.tasks[j].notifiedAt && (forall v :: v in s.tasks[i].toldSoon ==> v in s2.tasks[j].toldSoon) && (forall v :: v in s.tasks[i].toldDue ==> v in s2.tasks[j].toldDue))
  ensures alwaysWhatWasSentIsRecorded(s2)
{
  TOldNotesRecorded(s, s2);
}

// ===== The notes of one notifier pass =====

// One task's notes of a pass: the edit announcements, then the heads-ups, then the due-day reminders.
lemma TNotesForParts(s: Tracker, t: Task)
  ensures var ko := knownOwners(s, t); var up := ProofLib.Filter((o: string) => (!t.authorIsMember || o != t.updatedBy), ko);
    notesFor(s, t) ==
      (if updateIsDue(t, s.now) then seq(|up|, i requires 0 <= i < |up| => Note(NoteKind.Update, t.id, up[i], t.updatedAt, s.now, t.updatedBy, t.authorIsMember)) else [])
      + (if reminder(t, s.now).DueSoon? then seq(|ko|, i requires 0 <= i < |ko| => Note(NoteKind.Soon, t.id, ko[i], t.due, s.now, "", false)) else [])
      + (if reminder(t, s.now).DueToday? then seq(|ko|, i requires 0 <= i < |ko| => Note(NoteKind.Today, t.id, ko[i], t.due, s.now, "", false)) else [])
{
}

// A note of one task's pass names the task, goes out now, and is due; an announcement skips its editor.
lemma TNoteFacts(s: Tracker, t: Task, x: Note)
  requires x in notesFor(s, t)
  ensures x.task == t.id && x.at == s.now
  ensures x.kind.Update? ==> updateIsDue(t, s.now) && x.version == t.updatedAt && x.by_ == t.updatedBy && x.authorIsMember == t.authorIsMember && (x.authorIsMember ==> x.to != x.by_)
  ensures x.kind.Soon? ==> reminder(t, s.now).DueSoon? && x.version == t.due
  ensures x.kind.Today? ==> reminder(t, s.now).DueToday? && x.version == t.due
{
  var ko := knownOwners(s, t);
  var up := ProofLib.Filter((o: string) => (!t.authorIsMember || o != t.updatedBy), ko);
  TNotesForParts(s, t);
  if x.kind.Update? {
    var a := seq(|up|, i requires 0 <= i < |up| => Note(NoteKind.Update, t.id, up[i], t.updatedAt, s.now, t.updatedBy, t.authorIsMember));
    assert updateIsDue(t, s.now) && x in a;
    var k :| 0 <= k < |a| && a[k] == x;
    ProofLib.FilterMember((o: string) => (!t.authorIsMember || o != t.updatedBy), ko, up[k]);
  }
}

// A note of one notifier pass comes from one task.
lemma TNewNote(s: Tracker, x: Note)
  requires x in Std.Collections.Seq.FoldLeft((acc: seq<Note>, t: Task) => (acc + notesFor(s, t)), [], s.tasks)
  ensures exists i :: 0 <= i < |s.tasks| && x in notesFor(s, s.tasks[i])
{
  ProofLib.FoldLeftConcatMember((acc: seq<Note>, t: Task) => (acc + notesFor(s, t)), (t: Task) => notesFor(s, t), [], s.tasks, x);
}

// Two positions of a list with unique task numbers that hold the same number are one position.
lemma TUniqueIndex(s: Tracker, i: int, j: int)
  requires alwaysTaskNumbersAreUnique(s)
  requires 0 <= i < |s.tasks| && 0 <= j < |s.tasks| && s.tasks[i].id == s.tasks[j].id
  ensures i == j
{
  TUniqueBridge(s);
  var a := s.tasks[i];
  assert |ProofLib.Filter((b: Task) => (b.id == a.id), s.tasks)| == 1;
  ProofLib.FilterCountOneIffUnique((b: Task) => (b.id == a.id), s.tasks, (t: Task) => t.id, i);
}

// The notes of a pass are announced after the quiet period, not to their editor, and timely, so the rules still hold after it.
lemma TNotifyAnnouncedAndTimely(s: Tracker)
  requires inv(s)
  ensures alwaysAnEditIsAnnouncedAfterTheQuietPeriod(notify(s).state)
  ensures alwaysNoOneIsToldOfTheirOwnEdit(notify(s).state)
  ensures alwaysRemindersAreTimely(notify(s).state)
{
  var s2 := notify(s).state;
  var newNotes := Std.Collections.Seq.FoldLeft((acc: seq<Note>, t: Task) => (acc + notesFor(s, t)), [], s.tasks);
  assert s2.sent == s.sent + newNotes;
  forall k | 0 <= k < |s2.sent|
    ensures (!(s2.sent[k].kind.Update?) || ((s2.sent[k].at - s2.sent[k].version) >= debounce))
    ensures (!(s2.sent[k].kind.Update? && s2.sent[k].authorIsMember) || (s2.sent[k].to != s2.sent[k].by_))
    ensures ((!(s2.sent[k].kind.Today?) || ((s2.sent[k].version <= today(s2.sent[k].at)) && ((today(s2.sent[k].at) - s2.sent[k].version) <= lateDays))) && (!(s2.sent[k].kind.Soon?) || (((s2.sent[k].version - today(s2.sent[k].at)) >= 1) && ((s2.sent[k].version - today(s2.sent[k].at)) <= soonDays))))
  {
    if k < |s.sent| {
      assert s2.sent[k] == s.sent[k];
    } else {
      var x := s2.sent[k];
      assert x == newNotes[k - |s.sent|];
      TNewNote(s, x);
      var i :| 0 <= i < |s.tasks| && x in notesFor(s, s.tasks[i]);
      TNoteFacts(s, s.tasks[i], x);
    }
  }
}

// Every note of a pass is recorded on its task by the same pass.
lemma TNotifyRecorded(s: Tracker)
  requires inv(s)
  ensures alwaysWhatWasSentIsRecorded(notify(s).state)
{
  var s2 := notify(s).state;
  var newNotes := Std.Collections.Seq.FoldLeft((acc: seq<Note>, t: Task) => (acc + notesFor(s, t)), [], s.tasks);
  assert s2.sent == s.sent + newNotes;
  forall j | 0 <= j < |s2.tasks|
    ensures exists i :: 0 <= i < |s.tasks| && s.tasks[i].id == s2.tasks[j].id && s.tasks[i].notifiedAt <= s2.tasks[j].notifiedAt && (forall v :: v in s.tasks[i].toldSoon ==> v in s2.tasks[j].toldSoon) && (forall v :: v in s.tasks[i].toldDue ==> v in s2.tasks[j].toldDue)
  {
    assert s2.tasks[j] == recorded(s.tasks[j], s.now);
  }
  TOldNotesRecorded(s, s2);
  forall k | 0 <= k < |s2.sent|
    ensures s2.sent[k].task <= s2.lastId && forall j :: 0 <= j < |s2.tasks| ==> (s2.tasks[j].id == s2.sent[k].task ==> ((s2.sent[k].kind.Update? ==> s2.sent[k].version <= s2.tasks[j].notifiedAt) && (s2.sent[k].kind.Soon? ==> s2.sent[k].version in s2.tasks[j].toldSoon) && (s2.sent[k].kind.Today? ==> s2.sent[k].version in s2.tasks[j].toldDue)))
  {
    if k < |s.sent| {
      assert s2.sent[k] == s.sent[k];
    } else {
      var x := s2.sent[k];
      assert x == newNotes[k - |s.sent|];
      TNewNote(s, x);
      var i :| 0 <= i < |s.tasks| && x in notesFor(s, s.tasks[i]);
      TNoteFacts(s, s.tasks[i], x);
      assert s.tasks[i].id <= s.lastId;
      forall j | 0 <= j < |s2.tasks| && s2.tasks[j].id == x.task
        ensures (x.kind.Update? ==> x.version <= s2.tasks[j].notifiedAt) && (x.kind.Soon? ==> x.version in s2.tasks[j].toldSoon) && (x.kind.Today? ==> x.version in s2.tasks[j].toldDue)
      {
        assert s2.tasks[j] == recorded(s.tasks[j], s.now);
        TUniqueIndex(s, i, j);
      }
    }
  }
}

// Adding a member as an owner changes none of the task's problems.
lemma TMemberAddedSameProblems(s: Tracker, t: Task, t2: Task, owner: string)
  requires owner in s.owners
  requires t2.id == t.id && t2.parents == t.parents && t2.related == t.related && t2.owners == addName(t.owners, owner)
  ensures problemsOf(s, t) == problemsOf(s, t2)
{
  ProofLib.FilterAppend((o: string) => !((o in s.owners)), t.owners, owner);
}

// ===== Nothing is sent twice by a notifier pass =====

// The rule, restated over ProofLib.Filter.
lemma TSentTwiceBridge(s: Tracker)
  ensures alwaysNothingIsSentTwice(s) == !(exists a :: a in s.sent && !(|ProofLib.Filter((b: Note) => ((((a.kind == b.kind) && (a.task == b.task)) && (a.to == b.to)) && (a.version == b.version)), s.sent)| == 1))
{
}

// Nothing sent twice means no two notes share kind, task, person and version.
lemma TSentDistinct(sent: seq<Note>)
  ensures !(exists a :: a in sent && !(|ProofLib.Filter((b: Note) => ((((a.kind == b.kind) && (a.task == b.task)) && (a.to == b.to)) && (a.version == b.version)), sent)| == 1)) <==> ProofLib.DistinctBy(sent, (n: Note) => (n.kind, n.task, n.to, n.version))
{
  forall i | 0 <= i < |sent|
    ensures (|ProofLib.Filter((b: Note) => ((((sent[i].kind == b.kind) && (sent[i].task == b.task)) && (sent[i].to == b.to)) && (sent[i].version == b.version)), sent)| == 1) <==> (forall j :: 0 <= j < |sent| && j != i ==> (sent[j].kind, sent[j].task, sent[j].to, sent[j].version) != (sent[i].kind, sent[i].task, sent[i].to, sent[i].version))
  {
    var a := sent[i];
    ProofLib.FilterCountOneIffUnique((b: Note) => ((((a.kind == b.kind) && (a.task == b.task)) && (a.to == b.to)) && (a.version == b.version)), sent, (n: Note) => (n.kind, n.task, n.to, n.version), i);
  }
}

// One task's notes of a pass repeat no key: each block has one kind, and goes to each person once.
lemma TNotesForDistinct(s: Tracker, t: Task)
  ensures ProofLib.DistinctBy(notesFor(s, t), (n: Note) => (n.kind, n.task, n.to, n.version))
{
  var key := (n: Note) => (n.kind, n.task, n.to, n.version);
  var ko := knownOwners(s, t);
  ProofLib.FoldLeftDedupDistinct((acc: seq<string>, x: string) => (if (x in acc) then acc else (acc + [x])), [], ProofLib.Filter((o: string) => (o in s.owners), t.owners));
  assert ProofLib.Distinct(ko);
  assert ProofLib.DistinctBy(ko, (o: string) => o);
  var up := ProofLib.Filter((o: string) => (!t.authorIsMember || o != t.updatedBy), ko);
  ProofLib.FilterKeepsDistinctBy((o: string) => (!t.authorIsMember || o != t.updatedBy), ko, (o: string) => o);
  var a := if updateIsDue(t, s.now) then seq(|up|, i requires 0 <= i < |up| => Note(NoteKind.Update, t.id, up[i], t.updatedAt, s.now, t.updatedBy, t.authorIsMember)) else [];
  var b := if reminder(t, s.now).DueSoon? then seq(|ko|, i requires 0 <= i < |ko| => Note(NoteKind.Soon, t.id, ko[i], t.due, s.now, "", false)) else [];
  var c := if reminder(t, s.now).DueToday? then seq(|ko|, i requires 0 <= i < |ko| => Note(NoteKind.Today, t.id, ko[i], t.due, s.now, "", false)) else [];
  TNotesForParts(s, t);
  assert notesFor(s, t) == a + b + c;
  assert ProofLib.DistinctBy(a, key);
  assert ProofLib.DistinctBy(b, key);
  assert ProofLib.DistinctBy(c, key);
  ProofLib.DistinctByConcat(a, b, key);
  ProofLib.DistinctByConcat(a + b, c, key);
}

lemma TNotifyNothingSentTwice(s: Tracker)
  requires inv(s)
  ensures alwaysNothingIsSentTwice(notify(s).state)
{
  var s2 := notify(s).state;
  var key := (n: Note) => (n.kind, n.task, n.to, n.version);
  var f := (acc: seq<Note>, t: Task) => (acc + notesFor(s, t));
  var newNotes := Std.Collections.Seq.FoldLeft((acc: seq<Note>, t: Task) => (acc + notesFor(s, t)), [], s.tasks);
  assert s2.sent == s.sent + newNotes;
  forall i | 0 <= i < |s.tasks|
    ensures ProofLib.DistinctBy(notesFor(s, s.tasks[i]), key)
  {
    TNotesForDistinct(s, s.tasks[i]);
  }
  forall i, j, x, y | 0 <= i < j < |s.tasks| && x in notesFor(s, s.tasks[i]) && y in notesFor(s, s.tasks[j])
    ensures key(x) != key(y)
  {
    TNoteFacts(s, s.tasks[i], x);
    TNoteFacts(s, s.tasks[j], y);
    if s.tasks[i].id == s.tasks[j].id {
      TUniqueIndex(s, i, j);
    }
  }
  ProofLib.FoldLeftConcatDistinctBy((acc: seq<Note>, t: Task) => (acc + notesFor(s, t)), (t: Task) => notesFor(s, t), key, [], s.tasks);
  TSentTwiceBridge(s);
  TSentDistinct(s.sent);
  forall x, y | x in s.sent && y in newNotes
    ensures key(x) != key(y)
  {
    TNewNote(s, y);
    var i :| 0 <= i < |s.tasks| && y in notesFor(s, s.tasks[i]);
    var t := s.tasks[i];
    TNoteFacts(s, t, y);
    if key(x) == key(y) {
      assert x.task == t.id;
    }
  }
  ProofLib.DistinctByConcat(s.sent, newNotes, key);
  TSentTwiceBridge(s2);
  TSentDistinct(s2.sent);
}

// ===== Edits that only take owners away, or members away, add no problem =====

// A problem is on the warning list exactly when it is a problem of one of the tasks.
lemma TProblemsMember(s: Tracker, p: Problem)
  ensures p in problems(s) <==> exists i :: 0 <= i < |s.tasks| && p in problemsOf(s, s.tasks[i])
{
  ProofLib.FoldLeftConcatMember((acc: seq<Problem>, t: Task) => (acc + problemsOf(s, t)), (t: Task) => problemsOf(s, t), [], s.tasks, p);
}

// Every problem after was already a problem before: nothing was added.
lemma TSubsetNoNewProblem(s: Tracker, s2: Tracker)
  requires forall p :: p in problems(s2) ==> p in problems(s)
  ensures addsNoProblem(s, s2)
{
  var ps := problems(s2);
  forall i | 0 <= i < |ps|
    ensures exists q :: q in problems(s) && sameProblem(ps[i], q)
  {
    assert ps[i] in problems(s) && sameProblem(ps[i], ps[i]);
  }
}

// A task's problems are its unknown owners, then the problems it would have with no owners.
lemma TProblemsOfSplit(s: Tracker, t: Task)
  ensures problemsOf(s, t) == seq(|ProofLib.Filter((o: string) => !((o in s.owners)), t.owners)|, i requires 0 <= i < |ProofLib.Filter((o: string) => !((o in s.owners)), t.owners)| => Problem(Code.UnknownOwner, t.id, 0, ProofLib.Filter((o: string) => !((o in s.owners)), t.owners)[i])) + problemsOf(s, t.(owners := []))
{
  ProofLib.FilterNil((o: string) => !((o in s.owners)), t.(owners := []).owners);
}

// What the unknown-owner part of a task's problems holds.
lemma TUnknownOwnerPart(s: Tracker, t: Task, p: Problem)
  ensures p in seq(|ProofLib.Filter((o: string) => !((o in s.owners)), t.owners)|, i requires 0 <= i < |ProofLib.Filter((o: string) => !((o in s.owners)), t.owners)| => Problem(Code.UnknownOwner, t.id, 0, ProofLib.Filter((o: string) => !((o in s.owners)), t.owners)[i]))
    <==> (p == Problem(Code.UnknownOwner, t.id, 0, p.name) && p.name in t.owners && !(p.name in s.owners))
{
  var m := ProofLib.Filter((o: string) => !((o in s.owners)), t.owners);
  var a := seq(|ProofLib.Filter((o: string) => !((o in s.owners)), t.owners)|, i requires 0 <= i < |ProofLib.Filter((o: string) => !((o in s.owners)), t.owners)| => Problem(Code.UnknownOwner, t.id, 0, ProofLib.Filter((o: string) => !((o in s.owners)), t.owners)[i]));
  ProofLib.FilterMember((o: string) => !((o in s.owners)), t.owners, p.name);
  if p in a {
    var k :| 0 <= k < |a| && a[k] == p;
    assert m[k] in m;
  }
  if p == Problem(Code.UnknownOwner, t.id, 0, p.name) && p.name in m {
    var k :| 0 <= k < |m| && m[k] == p.name;
    assert a[k] == p;
  }
}

// Same links: a task without owners has the same problems in both states, whatever the members.
lemma TSameLinksNoOwners(s: Tracker, s2: Tracker)
  requires |s.tasks| == |s2.tasks|
  requires forall i :: 0 <= i < |s.tasks| ==> s.tasks[i].id == s2.tasks[i].id && s.tasks[i].parents == s2.tasks[i].parents && s.tasks[i].related == s2.tasks[i].related
  ensures forall t: Task :: |t.owners| == 0 ==> problemsOf(s, t) == problemsOf(s2, t)
{
  TSameLinksHasTask(s, s2);
  TSameParentsAncestors(s, s2);
  forall t: Task | |t.owners| == 0
    ensures problemsOf(s, t) == problemsOf(s2, t)
  {
    ProofLib.FilterNil((o: string) => !((o in s.owners)), t.owners);
    ProofLib.FilterNil((o: string) => !((o in s2.owners)), t.owners);
    ProofLib.FilterSamePredicate((p: int) => ((p != t.id) && !(hasTask(s, p))), (p: int) => ((p != t.id) && !(hasTask(s2, p))), t.parents);
    ProofLib.FilterSamePredicate((r: int) => ((r != t.id) && !(hasTask(s, r))), (r: int) => ((r != t.id) && !(hasTask(s2, r))), t.related);
    ProofLib.FilterSamePredicate((r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), (r: int) => (((r != t.id) && hasTask(s2, r)) && !(linksBack(s2, r, t.id))), t.related);
  }
}

// Same links, and every unknown owner after was an unknown owner before: no task gains a problem.
lemma TOwnersShrinkProblems(s: Tracker, s2: Tracker, t: Task, t2: Task)
  requires |s.tasks| == |s2.tasks|
  requires forall i :: 0 <= i < |s.tasks| ==> s.tasks[i].id == s2.tasks[i].id && s.tasks[i].parents == s2.tasks[i].parents && s.tasks[i].related == s2.tasks[i].related
  requires t.id == t2.id && t.parents == t2.parents && t.related == t2.related
  requires forall o :: o in t2.owners && !(o in s2.owners) ==> o in t.owners && !(o in s.owners)
  ensures forall p :: p in problemsOf(s2, t2) ==> p in problemsOf(s, t)
{
  TSameLinksNoOwners(s, s2);
  TProblemsOfSplit(s, t);
  TProblemsOfSplit(s2, t2);
  var bare := t.(owners := []);
  var bare2 := t2.(owners := []);
  assert problemsOf(s2, bare) == problemsOf(s2, bare2) by {
    assert bare.id == bare2.id && bare.owners == bare2.owners && bare.parents == bare2.parents && bare.related == bare2.related;
  }
  forall p | p in problemsOf(s2, t2)
    ensures p in problemsOf(s, t)
  {
    TUnknownOwnerPart(s2, t2, p);
    TUnknownOwnerPart(s, t, p);
  }
}

// The same for the whole warning list.
lemma TOwnersShrinkNoNewProblem(s: Tracker, s2: Tracker)
  requires |s.tasks| == |s2.tasks|
  requires forall i :: 0 <= i < |s.tasks| ==> s.tasks[i].id == s2.tasks[i].id && s.tasks[i].parents == s2.tasks[i].parents && s.tasks[i].related == s2.tasks[i].related
  requires forall i, o :: 0 <= i < |s.tasks| && o in s2.tasks[i].owners && !(o in s2.owners) ==> o in s.tasks[i].owners && !(o in s.owners)
  ensures addsNoProblem(s, s2)
{
  forall p | p in problems(s2)
    ensures p in problems(s)
  {
    TProblemsMember(s2, p);
    var i :| 0 <= i < |s2.tasks| && p in problemsOf(s2, s2.tasks[i]);
    TOwnersShrinkProblems(s, s2, s.tasks[i], s2.tasks[i]);
    TProblemsMember(s, p);
  }
  TSubsetNoNewProblem(s, s2);
}

// ===== A task's problems, part by part; each part has its own code =====

lemma TProblemsOfParts(s: Tracker, t: Task)
  ensures problemsOf(s, t) ==
    seq(|ProofLib.Filter((o: string) => !((o in s.owners)), t.owners)|, i requires 0 <= i < |ProofLib.Filter((o: string) => !((o in s.owners)), t.owners)| => Problem(Code.UnknownOwner, t.id, 0, ProofLib.Filter((o: string) => !((o in s.owners)), t.owners)[i]))
    + seq(|ProofLib.Filter((p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents)|, i requires 0 <= i < |ProofLib.Filter((p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents)| => Problem(Code.UnknownParent, t.id, ProofLib.Filter((p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents)[i], ""))
    + seq(|ProofLib.Filter((r: int) => ((r != t.id) && !(hasTask(s, r))), t.related)|, i requires 0 <= i < |ProofLib.Filter((r: int) => ((r != t.id) && !(hasTask(s, r))), t.related)| => Problem(Code.UnknownRelated, t.id, ProofLib.Filter((r: int) => ((r != t.id) && !(hasTask(s, r))), t.related)[i], ""))
    + (if (t.id in t.parents) then [Problem(Code.SelfParent, t.id, t.id, "")] else [])
    + (if (t.id in t.related) then [Problem(Code.SelfRelated, t.id, t.id, "")] else [])
    + (if (t.id in ancestors(s, t.id)) then [Problem(Code.Cycle, t.id, t.id, "")] else [])
    + seq(|ProofLib.Filter((r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related)|, i requires 0 <= i < |ProofLib.Filter((r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related)| => Problem(Code.OneSided, t.id, ProofLib.Filter((r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related)[i], ""))
{
}

lemma TUnknownParentPart(s: Tracker, t: Task, q: Problem)
  ensures q in seq(|ProofLib.Filter((p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents)|, i requires 0 <= i < |ProofLib.Filter((p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents)| => Problem(Code.UnknownParent, t.id, ProofLib.Filter((p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents)[i], ""))
    <==> (q == Problem(Code.UnknownParent, t.id, q.ref, "") && q.ref in t.parents && q.ref != t.id && !hasTask(s, q.ref))
{
  var m := ProofLib.Filter((p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents);
  var a := seq(|ProofLib.Filter((p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents)|, i requires 0 <= i < |ProofLib.Filter((p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents)| => Problem(Code.UnknownParent, t.id, ProofLib.Filter((p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents)[i], ""));
  ProofLib.FilterMember((p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents, q.ref);
  if q in a {
    var k :| 0 <= k < |a| && a[k] == q;
    assert m[k] in m;
  }
  if q == Problem(Code.UnknownParent, t.id, q.ref, "") && q.ref in m {
    var k :| 0 <= k < |m| && m[k] == q.ref;
    assert a[k] == q;
  }
}

lemma TUnknownRelatedPart(s: Tracker, t: Task, q: Problem)
  ensures q in seq(|ProofLib.Filter((r: int) => ((r != t.id) && !(hasTask(s, r))), t.related)|, i requires 0 <= i < |ProofLib.Filter((r: int) => ((r != t.id) && !(hasTask(s, r))), t.related)| => Problem(Code.UnknownRelated, t.id, ProofLib.Filter((r: int) => ((r != t.id) && !(hasTask(s, r))), t.related)[i], ""))
    <==> (q == Problem(Code.UnknownRelated, t.id, q.ref, "") && q.ref in t.related && q.ref != t.id && !hasTask(s, q.ref))
{
  var m := ProofLib.Filter((r: int) => ((r != t.id) && !(hasTask(s, r))), t.related);
  var a := seq(|ProofLib.Filter((r: int) => ((r != t.id) && !(hasTask(s, r))), t.related)|, i requires 0 <= i < |ProofLib.Filter((r: int) => ((r != t.id) && !(hasTask(s, r))), t.related)| => Problem(Code.UnknownRelated, t.id, ProofLib.Filter((r: int) => ((r != t.id) && !(hasTask(s, r))), t.related)[i], ""));
  ProofLib.FilterMember((r: int) => ((r != t.id) && !(hasTask(s, r))), t.related, q.ref);
  if q in a {
    var k :| 0 <= k < |a| && a[k] == q;
    assert m[k] in m;
  }
  if q == Problem(Code.UnknownRelated, t.id, q.ref, "") && q.ref in m {
    var k :| 0 <= k < |m| && m[k] == q.ref;
    assert a[k] == q;
  }
}

lemma TOneSidedPart(s: Tracker, t: Task, q: Problem)
  ensures q in seq(|ProofLib.Filter((r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related)|, i requires 0 <= i < |ProofLib.Filter((r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related)| => Problem(Code.OneSided, t.id, ProofLib.Filter((r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related)[i], ""))
    <==> (q == Problem(Code.OneSided, t.id, q.ref, "") && q.ref in t.related && q.ref != t.id && hasTask(s, q.ref) && !linksBack(s, q.ref, t.id))
{
  var m := ProofLib.Filter((r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related);
  var a := seq(|ProofLib.Filter((r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related)|, i requires 0 <= i < |ProofLib.Filter((r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related)| => Problem(Code.OneSided, t.id, ProofLib.Filter((r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related)[i], ""));
  ProofLib.FilterMember((r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related, q.ref);
  if q in a {
    var k :| 0 <= k < |a| && a[k] == q;
    assert m[k] in m;
  }
  if q == Problem(Code.OneSided, t.id, q.ref, "") && q.ref in m {
    var k :| 0 <= k < |m| && m[k] == q.ref;
    assert a[k] == q;
  }
}

// Each kind of problem a task has after, it had before: the task gains no problem.
lemma TProblemsOfSubset(s: Tracker, s2: Tracker, t: Task, t2: Task)
  requires t2.id == t.id
  requires forall o :: o in t2.owners && !(o in s2.owners) ==> o in t.owners && !(o in s.owners)
  requires forall p :: p in t2.parents && p != t.id && !hasTask(s2, p) ==> p in t.parents && !hasTask(s, p)
  requires forall r :: r in t2.related && r != t.id && !hasTask(s2, r) ==> r in t.related && !hasTask(s, r)
  requires t.id in t2.parents ==> t.id in t.parents
  requires t.id in t2.related ==> t.id in t.related
  requires t.id in ancestors(s2, t.id) ==> t.id in ancestors(s, t.id)
  requires forall r :: r in t2.related && r != t.id && hasTask(s2, r) && !linksBack(s2, r, t.id) ==> r in t.related && hasTask(s, r) && !linksBack(s, r, t.id)
  ensures forall q :: q in problemsOf(s2, t2) ==> q in problemsOf(s, t)
{
  TProblemsOfParts(s, t);
  TProblemsOfParts(s2, t2);
  forall q | q in problemsOf(s2, t2)
    ensures q in problemsOf(s, t)
  {
    TUnknownOwnerPart(s2, t2, q);
    TUnknownOwnerPart(s, t, q);
    TUnknownParentPart(s2, t2, q);
    TUnknownParentPart(s, t, q);
    TUnknownRelatedPart(s2, t2, q);
    TUnknownRelatedPart(s, t, q);
    TOneSidedPart(s2, t2, q);
    TOneSidedPart(s, t, q);
  }
}

// Every task, position by position, gains no problem: the warning list gains none.
lemma TEachTaskNoNewProblem(s: Tracker, s2: Tracker)
  requires |s.tasks| == |s2.tasks|
  requires forall i, q :: 0 <= i < |s.tasks| && q in problemsOf(s2, s2.tasks[i]) ==> q in problemsOf(s, s.tasks[i])
  ensures addsNoProblem(s, s2)
{
  forall q | q in problems(s2)
    ensures q in problems(s)
  {
    TProblemsMember(s2, q);
    TProblemsMember(s, q);
  }
  TSubsetNoNewProblem(s, s2);
}

// Same task numbers: the same tasks exist.
lemma TSameIdsHasTask(s: Tracker, s2: Tracker)
  requires |s.tasks| == |s2.tasks|
  requires forall i :: 0 <= i < |s.tasks| ==> s.tasks[i].id == s2.tasks[i].id
  ensures forall p :: hasTask(s, p) == hasTask(s2, p)
{
  forall p
    ensures hasTask(s, p) == hasTask(s2, p)
  {
    if hasTask(s, p) {
      var t :| t in s.tasks && t.id == p;
      var i :| 0 <= i < |s.tasks| && s.tasks[i] == t;
      assert s2.tasks[i] in s2.tasks;
    }
    if hasTask(s2, p) {
      var t :| t in s2.tasks && t.id == p;
      var i :| 0 <= i < |s2.tasks| && s2.tasks[i] == t;
      assert s.tasks[i] in s.tasks;
    }
  }
}

// ===== relate and unrelate add no problem =====

lemma TLinksBackAt(s: Tracker, k: int, r: int, x: int)
  requires 0 <= k < |s.tasks| && s.tasks[k].id == r && x in s.tasks[k].related
  ensures linksBack(s, r, x)
{
  assert s.tasks[k] in s.tasks;
}

lemma TRelateTask(s: Tracker, id: int, other: int, actor: string, i: int)
  requires canRelate(s, id, other, actor) && 0 <= i < |s.tasks|
  ensures forall q :: q in problemsOf(relate(s, id, other, actor), relate(s, id, other, actor).tasks[i]) ==> q in problemsOf(s, s.tasks[i])
{
  var s2 := relate(s, id, other, actor);
  var t := s.tasks[i];
  var t2 := s2.tasks[i];
  TSameIdsHasTask(s, s2);
  TSameParentsAncestors(s, s2);
  forall r, x | linksBack(s, r, x)
    ensures linksBack(s2, r, x)
  {
    var u :| u in s.tasks && u.id == r && x in u.related;
    var k :| 0 <= k < |s.tasks| && s.tasks[k] == u;
    TLinksBackAt(s2, k, r, x);
  }
  forall r | r in t2.related && r != t.id && hasTask(s2, r) && !linksBack(s2, r, t.id)
    ensures r in t.related && hasTask(s, r) && !linksBack(s, r, t.id)
  {
    if !(r in t.related) {
      if t.id == id {
        assert r == other;
        var u :| u in s.tasks && u.id == other;
        var k :| 0 <= k < |s.tasks| && s.tasks[k] == u;
        TLinksBackAt(s2, k, other, id);
      } else {
        assert t.id == other && r == id;
        var u :| u in s.tasks && u.id == id;
        var k :| 0 <= k < |s.tasks| && s.tasks[k] == u;
        TLinksBackAt(s2, k, id, other);
      }
    }
  }
  TProblemsOfSubset(s, s2, t, t2);
}

// Unrelating keeps every task's bookkeeping, so what was sent stays recorded and the bookkeeping stays sane.
lemma TUnrelateBookkeeping(s: Tracker, id: int, other: int, actor: string)
  requires inv(s) && canUnrelate(s, id, other, actor)
  ensures alwaysWhatWasSentIsRecorded(unrelate(s, id, other, actor)) && alwaysTheBookkeepingIsSane(unrelate(s, id, other, actor))
{
  var s2 := unrelate(s, id, other, actor);
  forall j | 0 <= j < |s2.tasks|
    ensures s2.tasks[j].id > s.lastId || exists i :: 0 <= i < |s.tasks| && s.tasks[i].id == s2.tasks[j].id && s.tasks[i].notifiedAt <= s2.tasks[j].notifiedAt && (forall v :: v in s.tasks[i].toldSoon ==> v in s2.tasks[j].toldSoon) && (forall v :: v in s.tasks[i].toldDue ==> v in s2.tasks[j].toldDue)
  {
    assert s.tasks[j].id == s2.tasks[j].id && s.tasks[j].notifiedAt == s2.tasks[j].notifiedAt && s.tasks[j].toldSoon == s2.tasks[j].toldSoon && s.tasks[j].toldDue == s2.tasks[j].toldDue;
  }
  TSentRecordedKept(s, s2);
  forall t | t in s2.tasks
    ensures t.notifiedAt <= t.updatedAt && t.updatedAt <= s2.now
  {
    var j :| 0 <= j < |s2.tasks| && s2.tasks[j] == t;
    assert s.tasks[j] in s.tasks;
  }
}

lemma TUnrelateTask(s: Tracker, id: int, other: int, actor: string, i: int)
  requires canUnrelate(s, id, other, actor) && 0 <= i < |s.tasks|
  ensures forall q :: q in problemsOf(unrelate(s, id, other, actor), unrelate(s, id, other, actor).tasks[i]) ==> q in problemsOf(s, s.tasks[i])
{
  var s2 := unrelate(s, id, other, actor);
  var t := s.tasks[i];
  var t2 := s2.tasks[i];
  TSameIdsHasTask(s, s2);
  TSameParentsAncestors(s, s2);
  forall r | r in t2.related
    ensures r in t.related
  {
    if t.id == id {
      ProofLib.FilterMember((y: int) => (y != other), t.related, r);
    } else if t.id == other {
      ProofLib.FilterMember((y: int) => (y != id), t.related, r);
    }
  }
  forall r | r in t2.related && r != t.id && hasTask(s2, r) && !linksBack(s2, r, t.id)
    ensures !linksBack(s, r, t.id)
  {
    if linksBack(s, r, t.id) {
      var u :| u in s.tasks && u.id == r && t.id in u.related;
      var k :| 0 <= k < |s.tasks| && s.tasks[k] == u;
      if r == id {
        ProofLib.FilterMember((y: int) => (y != other), u.related, t.id);
        if t.id == other {
          ProofLib.FilterMember((y: int) => (y != id), t.related, r);
        } else {
          TLinksBackAt(s2, k, r, t.id);
        }
      } else if r == other {
        ProofLib.FilterMember((y: int) => (y != id), u.related, t.id);
        if t.id == id {
          ProofLib.FilterMember((y: int) => (y != other), t.related, r);
        } else {
          TLinksBackAt(s2, k, r, t.id);
        }
      } else {
        TLinksBackAt(s2, k, r, t.id);
      }
    }
  }
  TProblemsOfSubset(s, s2, t, t2);
}

// ===== Ancestors only shrink when links only shrink =====

// What the parent-collecting fold holds: every parent, other than the task itself, of a task it read.
lemma TParentsFoldMember(init: seq<int>, ts: seq<Task>, x: int)
  ensures x in Std.Collections.Seq.FoldLeft((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => ((p != t.id) && !((p in acc))), t.parents)), init, ts) <==> (x in init || exists i :: 0 <= i < |ts| && x in ts[i].parents && x != ts[i].id)
  decreases |ts|
{
  if |ts| > 0 {
    var t := ts[0];
    ProofLib.FilterMember((p: int) => ((p != t.id) && !((p in init))), t.parents, x);
    TParentsFoldMember(init + ProofLib.Filter((p: int) => ((p != t.id) && !((p in init))), t.parents), ts[1..], x);
    assert forall i :: 1 <= i < |ts| ==> ts[i] == ts[1..][i - 1];
  }
}

lemma TParentsOfAllMember(s: Tracker, ids: seq<int>, x: int)
  ensures x in parentsOfAll(s, ids) <==> exists t :: t in s.tasks && t.id in ids && x in t.parents && x != t.id
{
  var kept := ProofLib.Filter((t: Task) => (t.id in ids), s.tasks);
  TParentsFoldMember([], kept, x);
  forall t | t in s.tasks && t.id in ids && x in t.parents && x != t.id
    ensures exists i :: 0 <= i < |kept| && x in kept[i].parents && x != kept[i].id
  {
    ProofLib.FilterMember((t: Task) => (t.id in ids), s.tasks, t);
    var i :| 0 <= i < |kept| && kept[i] == t;
  }
  forall i | 0 <= i < |kept|
    ensures kept[i] in s.tasks && kept[i].id in ids
  {
    ProofLib.FilterMember((t: Task) => (t.id in ids), s.tasks, kept[i]);
  }
}

// One round of the ancestor search keeps what it had and adds the parents of what it had.
lemma TAncRoundMember(s: Tracker, acc: seq<int>, t: Task, x: int)
  ensures x in ((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))))(acc, t) <==> (x in acc || x in parentsOfAll(s, acc))
{
  ProofLib.FilterMember((p: int) => !((p in acc)), parentsOfAll(s, acc), x);
}

// The ancestor search never loses what it starts with.
lemma TAncInflate(s: Tracker, a: seq<int>, xs: seq<Task>, x: int)
  requires x in a
  ensures x in Std.Collections.Seq.FoldLeft((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))), a, xs)
  decreases |xs|
{
  if |xs| > 0 {
    TAncRoundMember(s, a, xs[0], x);
    TAncInflate(s, ((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))))(a, xs[0]), xs[1..], x);
  }
}

// Fewer links and no more rounds, from less: the ancestor search finds no more.
lemma TAncFoldShrink(s: Tracker, s2: Tracker, a: seq<int>, a2: seq<int>, xs: seq<Task>, xs2: seq<Task>, x: int)
  requires forall u2 :: u2 in s2.tasks ==> exists u :: u in s.tasks && u.id == u2.id && (forall p :: p in u2.parents ==> p in u.parents)
  requires forall y :: y in a2 ==> y in a
  requires |xs2| <= |xs|
  ensures x in Std.Collections.Seq.FoldLeft((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s2, acc))), a2, xs2) ==> x in Std.Collections.Seq.FoldLeft((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))), a, xs)
  decreases |xs|
{
  if |xs2| == 0 {
    if x in a2 {
      TAncInflate(s, a, xs, x);
    }
  } else {
    var b2 := ((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s2, acc))))(a2, xs2[0]);
    var b := ((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))))(a, xs[0]);
    forall y | y in b2
      ensures y in b
    {
      TAncRoundMember(s2, a2, xs2[0], y);
      TAncRoundMember(s, a, xs[0], y);
      if y in parentsOfAll(s2, a2) {
        TParentsOfAllMember(s2, a2, y);
        var u2 :| u2 in s2.tasks && u2.id in a2 && y in u2.parents && y != u2.id;
        var u :| u in s.tasks && u.id == u2.id && (forall p :: p in u2.parents ==> p in u.parents);
        TParentsOfAllMember(s, a, y);
      }
    }
    TAncFoldShrink(s, s2, b, b2, xs[1..], xs2[1..], x);
  }
}

// Fewer links and no more tasks: no task has more ancestors.
lemma TAncestorsShrink(s: Tracker, s2: Tracker)
  requires forall u2 :: u2 in s2.tasks ==> exists u :: u in s.tasks && u.id == u2.id && (forall p :: p in u2.parents ==> p in u.parents)
  requires |s2.tasks| <= |s.tasks|
  ensures forall id, x :: x in ancestors(s2, id) ==> x in ancestors(s, id)
{
  forall id, x | x in ancestors(s2, id)
    ensures x in ancestors(s, id)
  {
    forall y | y in parentsOfAll(s2, [id])
      ensures y in parentsOfAll(s, [id])
    {
      TParentsOfAllMember(s2, [id], y);
      var u2 :| u2 in s2.tasks && u2.id in [id] && y in u2.parents && y != u2.id;
      var u :| u in s.tasks && u.id == u2.id && (forall p :: p in u2.parents ==> p in u.parents);
      TParentsOfAllMember(s, [id], y);
    }
    TAncFoldShrink(s, s2, parentsOfAll(s, [id]), parentsOfAll(s2, [id]), s.tasks, s2.tasks, x);
  }
}

// Every task after gains no problem over some task before: the warning list gains none.
lemma TSomeTaskNoNewProblem(s: Tracker, s2: Tracker)
  requires forall j, q :: 0 <= j < |s2.tasks| && q in problemsOf(s2, s2.tasks[j]) ==> exists i :: 0 <= i < |s.tasks| && q in problemsOf(s, s.tasks[i])
  ensures addsNoProblem(s, s2)
{
  forall q | q in problems(s2)
    ensures q in problems(s)
  {
    TProblemsMember(s2, q);
    TProblemsMember(s, q);
  }
  TSubsetNoNewProblem(s, s2);
}

// ===== removeParent and deleteTask add no problem =====

lemma TRemoveParentTask(s: Tracker, id: int, other: int, actor: string, i: int)
  requires 0 <= i < |s.tasks|
  ensures forall q :: q in problemsOf(removeParent(s, id, other, actor), removeParent(s, id, other, actor).tasks[i]) ==> q in problemsOf(s, s.tasks[i])
{
  var s2 := removeParent(s, id, other, actor);
  var t := s.tasks[i];
  var t2 := s2.tasks[i];
  TSameLinksHasTask(s, s2);
  forall u2 | u2 in s2.tasks
    ensures exists u :: u in s.tasks && u.id == u2.id && (forall p :: p in u2.parents ==> p in u.parents)
  {
    var k :| 0 <= k < |s2.tasks| && s2.tasks[k] == u2;
    var u := s.tasks[k];
    forall p | p in u2.parents
      ensures p in u.parents
    {
      if u.id == id {
        ProofLib.FilterMember((y: int) => (y != other), u.parents, p);
      }
    }
    assert u in s.tasks;
  }
  TAncestorsShrink(s, s2);
  forall p | p in t2.parents
    ensures p in t.parents
  {
    if t.id == id {
      ProofLib.FilterMember((y: int) => (y != other), t.parents, p);
    }
  }
  TProblemsOfSubset(s, s2, t, t2);
}

lemma TDeleteTaskTask(s: Tracker, id: int, actor: string, j: int)
  requires 0 <= j < |deleteTask(s, id, actor).tasks|
  ensures exists i :: 0 <= i < |s.tasks| && forall q :: q in problemsOf(deleteTask(s, id, actor), deleteTask(s, id, actor).tasks[j]) ==> q in problemsOf(s, s.tasks[i])
{
  var s2 := deleteTask(s, id, actor);
  var kept := ProofLib.Filter((t: Task) => (t.id != id), s.tasks);
  assert |s2.tasks| == |kept|;
  assert forall k :: 0 <= k < |kept| ==> s2.tasks[k] == kept[k].(parents := drop(kept[k].parents, id), related := drop(kept[k].related, id));
  forall k | 0 <= k < |kept|
    ensures kept[k] in s.tasks && kept[k].id != id
  {
    ProofLib.FilterMember((t: Task) => (t.id != id), s.tasks, kept[k]);
  }
  var t := kept[j];
  var t2 := s2.tasks[j];
  // A task other than the deleted one exists after exactly when it existed before.
  forall p | p != id
    ensures hasTask(s2, p) == hasTask(s, p)
  {
    if hasTask(s, p) {
      var u :| u in s.tasks && u.id == p;
      ProofLib.FilterMember((t: Task) => (t.id != id), s.tasks, u);
      var k :| 0 <= k < |kept| && kept[k] == u;
      assert s2.tasks[k] in s2.tasks;
    }
    if hasTask(s2, p) {
      var u2 :| u2 in s2.tasks && u2.id == p;
      var k :| 0 <= k < |s2.tasks| && s2.tasks[k] == u2;
      assert kept[k] in s.tasks;
    }
  }
  forall u2 | u2 in s2.tasks
    ensures exists u :: u in s.tasks && u.id == u2.id && (forall p :: p in u2.parents ==> p in u.parents)
  {
    var k :| 0 <= k < |s2.tasks| && s2.tasks[k] == u2;
    var u := kept[k];
    forall p | p in u2.parents
      ensures p in u.parents
    {
      ProofLib.FilterMember((y: int) => (y != id), u.parents, p);
    }
  }
  assert |kept| <= |s.tasks| by {
    ProofLib.FilterSubset((t: Task) => (t.id != id), s.tasks);
  }
  TAncestorsShrink(s, s2);
  forall p | p in t2.parents
    ensures p in t.parents && p != id
  {
    ProofLib.FilterMember((y: int) => (y != id), t.parents, p);
  }
  forall r | r in t2.related
    ensures r in t.related && r != id
  {
    ProofLib.FilterMember((y: int) => (y != id), t.related, r);
  }
  forall r | r in t2.related && r != t.id && hasTask(s2, r) && !linksBack(s2, r, t.id)
    ensures !linksBack(s, r, t.id)
  {
    if linksBack(s, r, t.id) {
      var u :| u in s.tasks && u.id == r && t.id in u.related;
      ProofLib.FilterMember((t: Task) => (t.id != id), s.tasks, u);
      var k :| 0 <= k < |kept| && kept[k] == u;
      ProofLib.FilterMember((y: int) => (y != id), u.related, t.id);
      TLinksBackAt(s2, k, r, t.id);
    }
  }
  TProblemsOfSubset(s, s2, t, t2);
  var i :| 0 <= i < |s.tasks| && s.tasks[i] == t;
}

// ===== A fix adds no problem =====

// The problem a fix acts on is a problem of one of the tasks.
lemma TFixTarget(s: Tracker, index: int, actor: string)
  requires canFix(s, index, actor)
  ensures exists i :: 0 <= i < |s.tasks| && problemAt(s, index) in problemsOf(s, s.tasks[i])
{
  var p := problemAt(s, index);
  assert p == problems(s)[index];
  TProblemsMember(s, p);
}

// What a fix does to each task: it only takes owners, parents and related links away, except
// that it mirrors a one-sided link on the other task.
lemma TFixShape(s: Tracker, index: int, m: int, actor: string)
  requires 0 <= m < |s.tasks|
  ensures |fix(s, index, actor).tasks| == |s.tasks|
  ensures fix(s, index, actor).tasks[m].id == s.tasks[m].id
  ensures forall o :: o in fix(s, index, actor).tasks[m].owners ==> o in s.tasks[m].owners
  ensures forall x :: x in fix(s, index, actor).tasks[m].parents ==> x in s.tasks[m].parents
  ensures forall r :: r in fix(s, index, actor).tasks[m].related ==> r in s.tasks[m].related || (problemAt(s, index).code.OneSided? && s.tasks[m].id == problemAt(s, index).ref && r == problemAt(s, index).task)
  ensures forall r :: r in s.tasks[m].related ==> r in fix(s, index, actor).tasks[m].related || (s.tasks[m].id == problemAt(s, index).task && (problemAt(s, index).code.UnknownRelated? || problemAt(s, index).code.SelfRelated?) && r == problemAt(s, index).ref && !(problemAt(s, index).code.OneSided? && s.tasks[m].id == problemAt(s, index).ref))
{
  var p := problemAt(s, index);
  var t := s.tasks[m];
  var t2 := fix(s, index, actor).tasks[m];
  if p.code.OneSided? && t.id == p.ref {
  } else if t.id != p.task {
  } else if p.code.UnknownOwner? {
    forall o | o in t2.owners
      ensures o in t.owners
    {
      ProofLib.FilterMember((y: string) => (y != p.name), t.owners, o);
    }
  } else if p.code.UnknownParent? || p.code.SelfParent? {
    forall x | x in t2.parents
      ensures x in t.parents
    {
      ProofLib.FilterMember((y: int) => (y != p.ref), t.parents, x);
    }
  } else if p.code.UnknownRelated? || p.code.SelfRelated? {
    forall r | r in t2.related || r in t.related
      ensures (r in t2.related ==> r in t.related) && (r in t.related && r != p.ref ==> r in t2.related)
    {
      ProofLib.FilterMember((y: int) => (y != p.ref), t.related, r);
    }
  }
}

lemma TFixTask(s: Tracker, index: int, k: int, actor: string)
  requires canFix(s, index, actor) && 0 <= k < |s.tasks|
  ensures forall q :: q in problemsOf(fix(s, index, actor), fix(s, index, actor).tasks[k]) ==> q in problemsOf(s, s.tasks[k])
{
  var s2 := fix(s, index, actor);
  TFixShape(s, index, k, actor);
  TFixFacts(s, index, actor);
  TSameIdsHasTask(s, s2);
  TFixCycleLen(s, s2, index, k, actor);
  TFixOneSided(s, index, k, actor);
  TProblemsOfSubset(s, s2, s.tasks[k], s2.tasks[k]);
}

// After a fix, a related link that is one-sided was already there and already one-sided.
lemma TFixOneSided(s: Tracker, index: int, k: int, actor: string)
  requires canFix(s, index, actor) && 0 <= k < |s.tasks|
  ensures forall r :: r in fix(s, index, actor).tasks[k].related && r != s.tasks[k].id && hasTask(fix(s, index, actor), r) && !linksBack(fix(s, index, actor), r, s.tasks[k].id) ==> r in s.tasks[k].related && hasTask(s, r) && !linksBack(s, r, s.tasks[k].id)
{
  var s2 := fix(s, index, actor);
  var p := problemAt(s, index);
  TFixTarget(s, index, actor);
  var i :| 0 <= i < |s.tasks| && p in problemsOf(s, s.tasks[i]);
  var P := s.tasks[i];
  TFixHome(s, P, p);
  forall m | 0 <= m < |s.tasks|
    ensures s2.tasks[m].id == s.tasks[m].id
    ensures forall r :: r in s2.tasks[m].related ==> r in s.tasks[m].related || (p.code.OneSided? && s.tasks[m].id == p.ref && r == p.task)
    ensures forall r :: r in s.tasks[m].related ==> r in s2.tasks[m].related || (s.tasks[m].id == p.task && (p.code.UnknownRelated? || p.code.SelfRelated?) && r == p.ref && !(p.code.OneSided? && s.tasks[m].id == p.ref))
  {
    TFixShape(s, index, m, actor);
  }
  TSameIdsHasTask(s, s2);
  var t := s.tasks[k];
  var t2 := s2.tasks[k];
  // A task that linked back before still links back, unless the fix removed a link to a missing task or to itself.
  forall r | r in t2.related && r != t.id && hasTask(s2, r) && !linksBack(s2, r, t.id)
    ensures r in t.related && hasTask(s, r) && !linksBack(s, r, t.id)
  {
    if !(r in t.related) {
      // r is the mirrored link, and the task it names links back to this one
      assert p.code.OneSided? && t.id == p.ref && r == p.task;
      assert P.id != p.ref;
      assert s2.tasks[i].related == P.related || p.task in s2.tasks[i].related by {
        TFixShape(s, index, i, actor);
      }
      TLinksBackAt(s2, i, p.task, p.ref);
    }
    if linksBack(s, r, t.id) {
      var u :| u in s.tasks && u.id == r && t.id in u.related;
      var m :| 0 <= m < |s.tasks| && s.tasks[m] == u;
      if t.id in s2.tasks[m].related {
        TLinksBackAt(s2, m, r, t.id);
      } else {
        assert u.id == p.task && t.id == p.ref;
        assert t in s.tasks;
      }
    }
  }
}

// ===== A fix shortens the warning list =====

// Two folds that append a piece per element: if no piece is longer, the result is no longer; if one is shorter, shorter.
lemma TFoldLenLe<A, T, U>(f: (seq<A>, T) -> seq<A>, g: (seq<A>, U) -> seq<A>, h: T -> seq<A>, h2: U -> seq<A>, a: seq<A>, a2: seq<A>, xs: seq<T>, ys: seq<U>)
  requires forall acc, x :: f(acc, x) == acc + h(x)
  requires forall acc, y :: g(acc, y) == acc + h2(y)
  requires |xs| == |ys|
  requires forall i :: 0 <= i < |xs| ==> |h2(ys[i])| <= |h(xs[i])|
  ensures |Std.Collections.Seq.FoldLeft(g, a2, ys)| - |a2| <= |Std.Collections.Seq.FoldLeft(f, a, xs)| - |a|
  ensures (exists i :: 0 <= i < |xs| && |h2(ys[i])| < |h(xs[i])|) ==> |Std.Collections.Seq.FoldLeft(g, a2, ys)| - |a2| < |Std.Collections.Seq.FoldLeft(f, a, xs)| - |a|
  decreases |xs|
{
  if |xs| > 0 {
    assert forall i :: 0 <= i < |xs[1..]| ==> xs[1..][i] == xs[i + 1] && ys[1..][i] == ys[i + 1];
    TFoldLenLe(f, g, h, h2, f(a, xs[0]), g(a2, ys[0]), xs[1..], ys[1..]);
    if exists i :: 0 <= i < |xs| && |h2(ys[i])| < |h(xs[i])| {
      var i :| 0 <= i < |xs| && |h2(ys[i])| < |h(xs[i])|;
      if i > 0 {
        assert xs[1..][i - 1] == xs[i] && ys[1..][i - 1] == ys[i];
      }
    }
  }
}

// What a problem of a task says about that task.
lemma TFixHome(s: Tracker, t: Task, pr: Problem)
  requires pr in problemsOf(s, t)
  ensures pr.task == t.id
  ensures pr.code.UnknownOwner? ==> pr.name in t.owners && !(pr.name in s.owners)
  ensures pr.code.UnknownParent? ==> pr.ref in t.parents && pr.ref != t.id && !hasTask(s, pr.ref)
  ensures pr.code.SelfParent? ==> pr.ref == t.id && t.id in t.parents
  ensures pr.code.UnknownRelated? ==> pr.ref in t.related && pr.ref != t.id && !hasTask(s, pr.ref)
  ensures pr.code.SelfRelated? ==> pr.ref == t.id && t.id in t.related
  ensures pr.code.OneSided? ==> pr.ref in t.related && pr.ref != t.id && hasTask(s, pr.ref) && !linksBack(s, pr.ref, t.id)
{
  TProblemsOfParts(s, t);
  TUnknownOwnerPart(s, t, pr);
  TUnknownParentPart(s, t, pr);
  TUnknownRelatedPart(s, t, pr);
  TOneSidedPart(s, t, pr);
}

// The problem a fix acts on belongs to a task that exists.
lemma TFixFacts(s: Tracker, index: int, actor: string)
  requires canFix(s, index, actor)
  ensures hasTask(s, problemAt(s, index).task)
  ensures problemAt(s, index).code.OneSided? ==> problemAt(s, index).ref != problemAt(s, index).task && hasTask(s, problemAt(s, index).ref)
{
  TFixTarget(s, index, actor);
  var i :| 0 <= i < |s.tasks| && problemAt(s, index) in problemsOf(s, s.tasks[i]);
  TFixHome(s, s.tasks[i], problemAt(s, index));
  assert s.tasks[i] in s.tasks;
}

lemma TFixOwnersLen(s: Tracker, s2: Tracker, index: int, k: int, actor: string)
  requires canFix(s, index, actor) && s2 == fix(s, index, actor) && 0 <= k < |s.tasks|
  ensures |ProofLib.Filter((o: string) => !((o in s2.owners)), s2.tasks[k].owners)| <= |ProofLib.Filter((o: string) => !((o in s.owners)), s.tasks[k].owners)|
  ensures problemAt(s, index) in problemsOf(s, s.tasks[k]) && problemAt(s, index).code.UnknownOwner? ==> |ProofLib.Filter((o: string) => !((o in s2.owners)), s2.tasks[k].owners)| < |ProofLib.Filter((o: string) => !((o in s.owners)), s.tasks[k].owners)|
{
  var pr := problemAt(s, index);
  var t := s.tasks[k];
  var t2 := s2.tasks[k];
  if !(pr.code.OneSided? && t.id == pr.ref) && t.id == pr.task && pr.code.UnknownOwner? {
    assert t2.owners == ProofLib.Filter((y: string) => (y != pr.name), t.owners);
    ProofLib.FilterOfFilterLength((y: string) => (y != pr.name), (o: string) => !((o in s2.owners)), (o: string) => !((o in s.owners)), t.owners);
    if pr in problemsOf(s, t) {
      TFixHome(s, t, pr);
      var w :| 0 <= w < |t.owners| && t.owners[w] == pr.name;
    }
  } else {
    assert t2.owners == t.owners;
    ProofLib.FilterImpLength((o: string) => !((o in s2.owners)), (o: string) => !((o in s.owners)), t.owners);
  }
}

lemma TFixParentsLen(s: Tracker, s2: Tracker, index: int, k: int, actor: string)
  requires canFix(s, index, actor) && s2 == fix(s, index, actor) && 0 <= k < |s.tasks|
  ensures |ProofLib.Filter((p: int) => ((p != s2.tasks[k].id) && !(hasTask(s2, p))), s2.tasks[k].parents)| + (if s2.tasks[k].id in s2.tasks[k].parents then 1 else 0) <= |ProofLib.Filter((p: int) => ((p != s.tasks[k].id) && !(hasTask(s, p))), s.tasks[k].parents)| + (if s.tasks[k].id in s.tasks[k].parents then 1 else 0)
  ensures problemAt(s, index) in problemsOf(s, s.tasks[k]) && (problemAt(s, index).code.UnknownParent? || problemAt(s, index).code.SelfParent?) ==> |ProofLib.Filter((p: int) => ((p != s2.tasks[k].id) && !(hasTask(s2, p))), s2.tasks[k].parents)| + (if s2.tasks[k].id in s2.tasks[k].parents then 1 else 0) < |ProofLib.Filter((p: int) => ((p != s.tasks[k].id) && !(hasTask(s, p))), s.tasks[k].parents)| + (if s.tasks[k].id in s.tasks[k].parents then 1 else 0)
{
  var pr := problemAt(s, index);
  var t := s.tasks[k];
  var t2 := s2.tasks[k];
  TFixShape(s, index, k, actor);
  TSameIdsHasTask(s, s2);
  if !(pr.code.OneSided? && t.id == pr.ref) && t.id == pr.task && (pr.code.UnknownParent? || pr.code.SelfParent?) {
    assert t2.parents == ProofLib.Filter((y: int) => (y != pr.ref), t.parents);
    ProofLib.FilterOfFilterLength((y: int) => (y != pr.ref), (p: int) => ((p != t2.id) && !(hasTask(s2, p))), (p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents);
    if pr in problemsOf(s, t) {
      TFixHome(s, t, pr);
      if pr.code.UnknownParent? {
        var w :| 0 <= w < |t.parents| && t.parents[w] == pr.ref;
      } else {
        ProofLib.FilterMember((y: int) => (y != pr.ref), t.parents, t.id);
      }
    }
  } else {
    assert t2.parents == t.parents;
    ProofLib.FilterImpLength((p: int) => ((p != t2.id) && !(hasTask(s2, p))), (p: int) => ((p != t.id) && !(hasTask(s, p))), t.parents);
  }
}

lemma TFixRelatedLen(s: Tracker, s2: Tracker, index: int, k: int, actor: string)
  requires canFix(s, index, actor) && s2 == fix(s, index, actor) && 0 <= k < |s.tasks|
  ensures |ProofLib.Filter((r: int) => ((r != s2.tasks[k].id) && !(hasTask(s2, r))), s2.tasks[k].related)| + (if s2.tasks[k].id in s2.tasks[k].related then 1 else 0) + |ProofLib.Filter((r: int) => (((r != s2.tasks[k].id) && hasTask(s2, r)) && !(linksBack(s2, r, s2.tasks[k].id))), s2.tasks[k].related)| <= |ProofLib.Filter((r: int) => ((r != s.tasks[k].id) && !(hasTask(s, r))), s.tasks[k].related)| + (if s.tasks[k].id in s.tasks[k].related then 1 else 0) + |ProofLib.Filter((r: int) => (((r != s.tasks[k].id) && hasTask(s, r)) && !(linksBack(s, r, s.tasks[k].id))), s.tasks[k].related)|
  ensures problemAt(s, index) in problemsOf(s, s.tasks[k]) && (problemAt(s, index).code.UnknownRelated? || problemAt(s, index).code.SelfRelated? || problemAt(s, index).code.OneSided?) ==> |ProofLib.Filter((r: int) => ((r != s2.tasks[k].id) && !(hasTask(s2, r))), s2.tasks[k].related)| + (if s2.tasks[k].id in s2.tasks[k].related then 1 else 0) + |ProofLib.Filter((r: int) => (((r != s2.tasks[k].id) && hasTask(s2, r)) && !(linksBack(s2, r, s2.tasks[k].id))), s2.tasks[k].related)| < |ProofLib.Filter((r: int) => ((r != s.tasks[k].id) && !(hasTask(s, r))), s.tasks[k].related)| + (if s.tasks[k].id in s.tasks[k].related then 1 else 0) + |ProofLib.Filter((r: int) => (((r != s.tasks[k].id) && hasTask(s, r)) && !(linksBack(s, r, s.tasks[k].id))), s.tasks[k].related)|
{
  var pr := problemAt(s, index);
  var t := s.tasks[k];
  var t2 := s2.tasks[k];
  TFixShape(s, index, k, actor);
  TFixFacts(s, index, actor);
  TSameIdsHasTask(s, s2);
  TFixOneSided(s, index, k, actor);
  if pr.code.OneSided? && t.id == pr.ref {
    if !(pr.task in t.related) {
      assert t2.related == t.related + [pr.task];
      ProofLib.FilterAppend((r: int) => ((r != t2.id) && !(hasTask(s2, r))), t.related, pr.task);
      ProofLib.FilterAppend((r: int) => (((r != t2.id) && hasTask(s2, r)) && !(linksBack(s2, r, t2.id))), t.related, pr.task);
    } else {
      assert t2.related == t.related;
    }
    ProofLib.FilterImpLength((r: int) => ((r != t2.id) && !(hasTask(s2, r))), (r: int) => ((r != t.id) && !(hasTask(s, r))), t.related);
    ProofLib.FilterImpLength((r: int) => (((r != t2.id) && hasTask(s2, r)) && !(linksBack(s2, r, t2.id))), (r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related);
  } else if t.id == pr.task && (pr.code.UnknownRelated? || pr.code.SelfRelated?) {
    assert t2.related == ProofLib.Filter((y: int) => (y != pr.ref), t.related);
    forall r | r in t.related && r != pr.ref
      ensures r in t2.related
    {
      ProofLib.FilterMember((y: int) => (y != pr.ref), t.related, r);
    }
    ProofLib.FilterOfFilterLength((y: int) => (y != pr.ref), (r: int) => ((r != t2.id) && !(hasTask(s2, r))), (r: int) => ((r != t.id) && !(hasTask(s, r))), t.related);
    ProofLib.FilterOfFilterLength((y: int) => (y != pr.ref), (r: int) => (((r != t2.id) && hasTask(s2, r)) && !(linksBack(s2, r, t2.id))), (r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related);
    if pr in problemsOf(s, t) {
      TFixHome(s, t, pr);
      if pr.code.UnknownRelated? {
        var w :| 0 <= w < |t.related| && t.related[w] == pr.ref;
      } else {
        ProofLib.FilterMember((y: int) => (y != pr.ref), t.related, t.id);
      }
    }
  } else {
    assert t2.related == t.related;
    ProofLib.FilterImpLength((r: int) => ((r != t2.id) && !(hasTask(s2, r))), (r: int) => ((r != t.id) && !(hasTask(s, r))), t.related);
    ProofLib.FilterImpLength((r: int) => (((r != t2.id) && hasTask(s2, r)) && !(linksBack(s2, r, t2.id))), (r: int) => (((r != t.id) && hasTask(s, r)) && !(linksBack(s, r, t.id))), t.related);
    if pr in problemsOf(s, t) && pr.code.OneSided? {
      TFixHome(s, t, pr);
      // the other task now links back
      var u :| u in s.tasks && u.id == pr.ref;
      var m :| 0 <= m < |s.tasks| && s.tasks[m] == u;
      TFixShape(s, index, m, actor);
      assert pr.task in s2.tasks[m].related;
      TLinksBackAt(s2, m, pr.ref, t.id);
      var w :| 0 <= w < |t.related| && t.related[w] == pr.ref;
    }
  }
}

lemma TFixCycleLen(s: Tracker, s2: Tracker, index: int, k: int, actor: string)
  requires canFix(s, index, actor) && s2 == fix(s, index, actor) && 0 <= k < |s.tasks|
  ensures s2.tasks[k].id in ancestors(s2, s2.tasks[k].id) ==> s.tasks[k].id in ancestors(s, s.tasks[k].id)
{
  forall m | 0 <= m < |s.tasks|
    ensures s2.tasks[m].id == s.tasks[m].id
    ensures forall x :: x in s2.tasks[m].parents ==> x in s.tasks[m].parents
  {
    TFixShape(s, index, m, actor);
  }
  forall u2 | u2 in s2.tasks
    ensures exists u :: u in s.tasks && u.id == u2.id && (forall x :: x in u2.parents ==> x in u.parents)
  {
    var m :| 0 <= m < |s2.tasks| && s2.tasks[m] == u2;
    assert s.tasks[m] in s.tasks;
  }
  TAncestorsShrink(s, s2);
}

// A fix leaves each task with no more problems, and the task it fixes with fewer.
lemma TFixCountTask(s: Tracker, s2: Tracker, index: int, k: int, actor: string)
  requires canFix(s, index, actor) && s2 == fix(s, index, actor) && 0 <= k < |s.tasks|
  ensures |problemsOf(s2, s2.tasks[k])| <= |problemsOf(s, s.tasks[k])|
  ensures problemAt(s, index) in problemsOf(s, s.tasks[k]) ==> |problemsOf(s2, s2.tasks[k])| < |problemsOf(s, s.tasks[k])|
{
  var t := s.tasks[k];
  var t2 := s2.tasks[k];
  TFixShape(s, index, k, actor);
  TProblemsOfParts(s, t);
  TProblemsOfParts(s2, t2);
  TFixOwnersLen(s, s2, index, k, actor);
  TFixParentsLen(s, s2, index, k, actor);
  TFixRelatedLen(s, s2, index, k, actor);
  TFixCycleLen(s, s2, index, k, actor);
}

lemma TFixShortens(s: Tracker, index: int, actor: string)
  requires canFix(s, index, actor)
  ensures |problems(fix(s, index, actor))| < |problems(s)|
{
  var s2 := fix(s, index, actor);
  TFixTarget(s, index, actor);
  var i :| 0 <= i < |s.tasks| && problemAt(s, index) in problemsOf(s, s.tasks[i]);
  forall k | 0 <= k < |s.tasks|
    ensures |problemsOf(s2, s2.tasks[k])| <= |problemsOf(s, s.tasks[k])|
    ensures problemAt(s, index) in problemsOf(s, s.tasks[k]) ==> |problemsOf(s2, s2.tasks[k])| < |problemsOf(s, s.tasks[k])|
  {
    TFixCountTask(s, s2, index, k, actor);
  }
  TFoldLenLe((acc: seq<Problem>, t: Task) => (acc + problemsOf(s, t)), (acc: seq<Problem>, t: Task) => (acc + problemsOf(s2, t)), (t: Task) => problemsOf(s, t), (t: Task) => problemsOf(s2, t), [], [], s.tasks, s2.tasks);
}


// ===== The ancestor search finds everything there is to find =====
// A list c is closed when it holds every parent (other than itself) of each task it names.

// No more distinct task numbers than tasks.
lemma TIdCountBound(xs: seq<Task>, a: seq<int>)
  ensures |(set u | u in xs && u.id in a :: u.id)| <= |xs|
  decreases |xs|
{
  if |xs| > 0 {
    TIdCountBound(xs[1..], a);
    var r := (set u | u in xs[1..] && u.id in a :: u.id);
    var w := (set u | u in xs && u.id in a :: u.id);
    assert w <= r + {xs[0].id} by {
      forall v | v in w
        ensures v in r + {xs[0].id}
      {
        var u :| u in xs && u.id in a && u.id == v;
        var k :| 0 <= k < |xs| && xs[k] == u;
        if k > 0 {
          assert xs[1..][k - 1] == u;
        }
      }
    }
    ProofLib.SubsetCard(w, r + {xs[0].id});
  }
}

// Starting inside a closed list, the ancestor search stays inside it.
lemma TAncFoldWithin(s: Tracker, a: seq<int>, xs: seq<Task>, c: seq<int>)
  requires forall y :: y in a ==> y in c
  requires (forall u, p :: u in s.tasks && u.id in c && p in u.parents && p != u.id ==> p in c)
  ensures forall y :: y in Std.Collections.Seq.FoldLeft((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))), a, xs) ==> y in c
  decreases |xs|
{
  if |xs| > 0 {
    var b := ((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))))(a, xs[0]);
    forall y | y in b
      ensures y in c
    {
      TAncRoundMember(s, a, xs[0], y);
      TParentsOfAllMember(s, a, y);
    }
    TAncFoldWithin(s, b, xs[1..], c);
  }
}

// The ancestors of a task lie in any closed list that holds the task's own parents.
lemma TAncWithin(s: Tracker, y: int, c: seq<int>)
  requires (forall u, p :: u in s.tasks && u.id in c && p in u.parents && p != u.id ==> p in c)
  requires forall u, p :: u in s.tasks && u.id == y && p in u.parents && p != u.id ==> p in c
  ensures forall x :: x in ancestors(s, y) ==> x in c
{
  forall x | x in parentsOfAll(s, [y])
    ensures x in c
  {
    TParentsOfAllMember(s, [y], x);
  }
  TAncFoldWithin(s, parentsOfAll(s, [y]), s.tasks, c);
}

// A round that leaves the list open added a task number, and started from an open list.
lemma TAncRoundGrows(s: Tracker, a: seq<int>, t: Task)
  requires !(forall u, p :: u in s.tasks && u.id in ((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))))(a, t) && p in u.parents && p != u.id ==> p in ((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))))(a, t))
  ensures !(forall u, p :: u in s.tasks && u.id in a && p in u.parents && p != u.id ==> p in a)
  ensures |(set u | u in s.tasks && u.id in a :: u.id)| < |(set u | u in s.tasks && u.id in ((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))))(a, t) :: u.id)|
{
  var b := ((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))))(a, t);
  var u, p :| u in s.tasks && u.id in b && p in u.parents && p != u.id && !(p in b);
  TAncRoundMember(s, a, t, p);
  TAncRoundMember(s, a, t, u.id);
  if u.id in a {
    TParentsOfAllMember(s, a, p);
    assert false;
  }
  if u.id in parentsOfAll(s, a) {
    TParentsOfAllMember(s, a, u.id);
  }
  var sa := (set v | v in s.tasks && v.id in a :: v.id);
  var sb := (set v | v in s.tasks && v.id in b :: v.id);
  forall x | x in sa
    ensures x in sb
  {
    var v :| v in s.tasks && v.id in a && v.id == x;
    TAncRoundMember(s, a, t, x);
  }
  assert u.id in sb;
  assert !(u.id in sa);
  ProofLib.SubsetCard(sa + {u.id}, sb);
}

// Either the search ends closed, or every round added a task number to an open start.
lemma TAncConverge(s: Tracker, a: seq<int>, xs: seq<Task>)
  ensures (forall u, p :: u in s.tasks && u.id in Std.Collections.Seq.FoldLeft((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))), a, xs) && p in u.parents && p != u.id ==> p in Std.Collections.Seq.FoldLeft((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))), a, xs)) || (!(forall u, p :: u in s.tasks && u.id in a && p in u.parents && p != u.id ==> p in a) && |(set u | u in s.tasks && u.id in Std.Collections.Seq.FoldLeft((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))), a, xs) :: u.id)| >= |(set u | u in s.tasks && u.id in a :: u.id)| + |xs|)
  decreases |xs|
{
  if |xs| > 0 {
    var b := ((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))))(a, xs[0]);
    TAncConverge(s, b, xs[1..]);
    assert Std.Collections.Seq.FoldLeft((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))), a, xs) == Std.Collections.Seq.FoldLeft((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))), b, xs[1..]);
    if !(forall u, p :: u in s.tasks && u.id in Std.Collections.Seq.FoldLeft((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))), b, xs[1..]) && p in u.parents && p != u.id ==> p in Std.Collections.Seq.FoldLeft((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))), b, xs[1..])) {
      TAncRoundGrows(s, a, xs[0]);
    }
  }
}

// An open list names at least one task.
lemma TAncOpenCount(s: Tracker, a: seq<int>)
  requires !(forall u, p :: u in s.tasks && u.id in a && p in u.parents && p != u.id ==> p in a)
  ensures |(set u | u in s.tasks && u.id in a :: u.id)| >= 1
{
  var u, p :| u in s.tasks && u.id in a && p in u.parents && p != u.id && !(p in a);
  ProofLib.SubsetCard({u.id}, (set v | v in s.tasks && v.id in a :: v.id));
}

// After one round per task, the ancestors are closed: one more round finds nothing new.
lemma TAncestorsClosed(s: Tracker, y: int)
  ensures (forall u, p :: u in s.tasks && u.id in ancestors(s, y) && p in u.parents && p != u.id ==> p in ancestors(s, y))
{
  var a := parentsOfAll(s, [y]);
  assert ancestors(s, y) == Std.Collections.Seq.FoldLeft((acc: seq<int>, t: Task) => (acc + Std.Collections.Seq.Filter((p: int) => !((p in acc)), parentsOfAll(s, acc))), a, s.tasks);
  TAncConverge(s, a, s.tasks);
  if !(forall u, p :: u in s.tasks && u.id in ancestors(s, y) && p in u.parents && p != u.id ==> p in ancestors(s, y)) {
    TAncOpenCount(s, a);
    TIdCountBound(s.tasks, ancestors(s, y));
    assert false;
  }
}

// ===== create adds no problem =====

// Each old task keeps its problems or loses some; the new task has none.
lemma TCreateTask(s: Tracker, actor: string, j: int)
  requires inv(s)
  requires 0 <= j < |create(s, actor).tasks|
  ensures forall q :: q in problemsOf(create(s, actor), create(s, actor).tasks[j]) ==> exists i :: 0 <= i < |s.tasks| && q in problemsOf(s, s.tasks[i])
{
  var s2 := create(s, actor);
  var n := s2.tasks[|s.tasks|];
  assert s2.tasks == s.tasks + [n];
  kernel_lawNextIsAboveTheCounter_ensures(numbersInUse(s), s.lastId);
  kernel_lawNextIsAboveEverythingSeen_ensures(numbersInUse(s), s.lastId);
  assert n.id > s.lastId;
  assert forall u :: u in s.tasks ==> u.id <= s.lastId;
  assert forall x :: x in numbersInUse(s) ==> n.id > x;
  assert forall u :: u in s2.tasks ==> u in s.tasks || u == n;
  // The ancestors of every number are found among the same ones as before.
  forall y, x | x in ancestors(s2, y)
    ensures x in ancestors(s, y)
  {
    TAncestorsClosed(s, y);
    forall u, p | u in s2.tasks && u.id == y && p in u.parents && p != u.id
      ensures p in ancestors(s, y)
    {
      assert u in s.tasks;
      TParentsOfAllMember(s, [y], p);
      TAncInflate(s, parentsOfAll(s, [y]), s.tasks, p);
    }
    TAncWithin(s2, y, ancestors(s, y));
  }
  if j < |s.tasks| {
    var t := s.tasks[j];
    assert s2.tasks[j] == t;
    forall r | r in t.related
      ensures r != n.id
    {
      ProofLib.FoldLeftConcatMember((acc: seq<int>, t: Task) => (((acc + [t.id]) + t.parents) + t.related), (t: Task) => (([t.id] + t.parents) + t.related), [], s.tasks, r);
    }
    forall r | hasTask(s, r)
      ensures hasTask(s2, r)
    {
      var u :| u in s.tasks && u.id == r;
      assert u in s2.tasks;
    }
    forall r | r != n.id && hasTask(s2, r)
      ensures hasTask(s, r)
    {
      var u :| u in s2.tasks && u.id == r;
    }
    forall r, x | linksBack(s, r, x)
      ensures linksBack(s2, r, x)
    {
      var u :| u in s.tasks && u.id == r && x in u.related;
      assert u in s2.tasks;
    }
    TProblemsOfSubset(s, s2, t, t);
    forall q | q in problemsOf(s2, s2.tasks[j])
      ensures exists i :: 0 <= i < |s.tasks| && q in problemsOf(s, s.tasks[i])
    {
      assert q in problemsOf(s, s.tasks[j]);
    }
  } else {
    assert s2.tasks[j] == n;
    forall x | x in ancestors(s2, n.id)
      ensures false
    {
      TAncWithin(s2, n.id, []);
    }
    TProblemsOfParts(s2, n);
    ProofLib.FilterNil((o: string) => !((o in s2.owners)), n.owners);
    ProofLib.FilterNil((p: int) => ((p != n.id) && !(hasTask(s2, p))), n.parents);
    ProofLib.FilterNil((r: int) => ((r != n.id) && !(hasTask(s2, r))), n.related);
    ProofLib.FilterNil((r: int) => (((r != n.id) && hasTask(s2, r)) && !(linksBack(s2, r, n.id))), n.related);
    assert problemsOf(s2, n) == [];
  }
}

// ===== addParent adds no problem =====

// A loop after adding id -> other would run from other back to id before: the guard rules it out.
lemma TAddParentAncestors(s: Tracker, id: int, other: int, actor: string, y: int)
  requires canAddParent(s, id, other, actor)
  ensures y in ancestors(addParent(s, id, other, actor), y) ==> y in ancestors(s, y)
{
  var s2 := addParent(s, id, other, actor);
  forall u2 | u2 in s2.tasks
    ensures exists u :: u in s.tasks && u.id == u2.id && (forall p :: p in u2.parents ==> p in u.parents || (u.id == id && p == other))
  {
    var k :| 0 <= k < |s2.tasks| && s2.tasks[k] == u2;
    var u := s.tasks[k];
    assert u in s.tasks;
  }
  var c := ancestors(s, y);
  var d := ancestors(s, other);
  TAncestorsClosed(s, y);
  TAncestorsClosed(s, other);
  forall u, p | u in s.tasks && u.id == y && p in u.parents && p != u.id
    ensures p in c
  {
    TParentsOfAllMember(s, [y], p);
    TAncInflate(s, parentsOfAll(s, [y]), s.tasks, p);
  }
  forall u, p | u in s.tasks && u.id == other && p in u.parents && p != u.id
    ensures p in d
  {
    TParentsOfAllMember(s, [other], p);
    TAncInflate(s, parentsOfAll(s, [other]), s.tasks, p);
  }
  assert !(id in d);
  if !(id in c) && y != id {
    forall u2, p | u2 in s2.tasks && u2.id in c && p in u2.parents && p != u2.id
      ensures p in c
    {
      var u :| u in s.tasks && u.id == u2.id && (forall p :: p in u2.parents ==> p in u.parents || (u.id == id && p == other));
    }
    forall u2, p | u2 in s2.tasks && u2.id == y && p in u2.parents && p != u2.id
      ensures p in c
    {
      var u :| u in s.tasks && u.id == u2.id && (forall p :: p in u2.parents ==> p in u.parents || (u.id == id && p == other));
    }
    TAncWithin(s2, y, c);
  } else {
    var e := c + [other] + d;
    forall u2, p | u2 in s2.tasks && u2.id in e && p in u2.parents && p != u2.id
      ensures p in e
    {
      var u :| u in s.tasks && u.id == u2.id && (forall p :: p in u2.parents ==> p in u.parents || (u.id == id && p == other));
    }
    forall u2, p | u2 in s2.tasks && u2.id == y && p in u2.parents && p != u2.id
      ensures p in e
    {
      var u :| u in s.tasks && u.id == u2.id && (forall p :: p in u2.parents ==> p in u.parents || (u.id == id && p == other));
    }
    TAncWithin(s2, y, e);
    if y in ancestors(s2, y) && !(y in c) {
      assert y == other || y in d;
      if y == id {
        assert false;
      } else {
        assert id in c;
        if y in d {
          forall u, p | u in s.tasks && u.id == y && p in u.parents && p != u.id
            ensures p in d
          {
          }
          TAncWithin(s, y, d);
        }
        assert false;
      }
    }
  }
}

// Each task keeps its problems or loses some.
lemma TAddParentTask(s: Tracker, id: int, other: int, actor: string, i: int)
  requires canAddParent(s, id, other, actor)
  requires 0 <= i < |s.tasks|
  ensures forall q :: q in problemsOf(addParent(s, id, other, actor), addParent(s, id, other, actor).tasks[i]) ==> q in problemsOf(s, s.tasks[i])
{
  var s2 := addParent(s, id, other, actor);
  var t := s.tasks[i];
  var t2 := s2.tasks[i];
  TSameLinksHasTask(s, s2);
  TAddParentAncestors(s, id, other, actor, t.id);
  TProblemsOfSubset(s, s2, t, t2);
}
