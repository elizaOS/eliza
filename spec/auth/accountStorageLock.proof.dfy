lemma LockOf(s: StorageLock, q: int)
  ensures lockerOf(s, q) == (if 0 < |ProofLib.Filter((l: Locker) => (l.process == q), s.lockers)| then ProofLib.Filter((l: Locker) => (l.process == q), s.lockers)[0] else noLocker)
{
}

lemma LockFound(s: StorageLock, q: int)
  requires !lockerOf(s, q).pc.Dead?
  ensures lockerOf(s, q) in s.lockers && lockerOf(s, q).process == q
{
  LockOf(s, q);
  var f := ProofLib.Filter((l: Locker) => (l.process == q), s.lockers);
  assert f[0] in f;
  ProofLib.FilterMember((l: Locker) => (l.process == q), s.lockers, f[0]);
}

lemma LockWith(s: StorageLock, a: StorageLock, p: int, change: Locker)
  requires a.lockers == withLocker(p, change, s) && change.process == p && !lockerOf(s, p).pc.Dead?
  ensures lockerOf(s, p) in s.lockers && lockerOf(s, p).process == p
  ensures lockerOf(a, p) == change && change in a.lockers
  ensures forall q :: q != p ==> lockerOf(a, q) == lockerOf(s, q)
  ensures forall l :: l in a.lockers ==> l == change || (l in s.lockers && l.process != p)
{
  LockFound(s, p);
  LockOf(s, p);
  LockOf(a, p);
  var i :| 0 <= i < |s.lockers| && s.lockers[i] == lockerOf(s, p);
  assert a.lockers[i] == change;
  ProofLib.FilterPointwise((l: Locker) => (l.process == p), (l: Locker) => (l.process == p), (x: Locker, y: Locker) => (x.process == p ==> x == change), a.lockers, s.lockers);
  ProofLib.FilterMember((l: Locker) => (l.process == p), a.lockers, change);
  var fa := ProofLib.Filter((l: Locker) => (l.process == p), a.lockers);
  assert fa[0] in fa;
  ProofLib.FilterMember((l: Locker) => (l.process == p), a.lockers, fa[0]);
  forall q | q != p
    ensures lockerOf(a, q) == lockerOf(s, q)
  {
    LockOf(s, q);
    LockOf(a, q);
    ProofLib.FilterPointwise((l: Locker) => (l.process == q), (l: Locker) => (l.process == q), (x: Locker, y: Locker) => (x.process == q ==> x == y), a.lockers, s.lockers);
    var fq := ProofLib.Filter((l: Locker) => (l.process == q), a.lockers);
    if 0 < |fq| {
      assert fq[0] in fq;
      ProofLib.FilterMember((l: Locker) => (l.process == q), a.lockers, fq[0]);
    }
  }
  forall l | l in a.lockers
    ensures l == change || (l in s.lockers && l.process != p)
  {
    var j :| 0 <= j < |a.lockers| && a.lockers[j] == l;
  }
}

lemma LockUnchanged(s: StorageLock, p: int, change: Locker)
  requires alwaysLockersAreWellFormed(s) && lockerOf(s, p).pc.Dead? && p in s.alive
  ensures withLocker(p, change, s) == s.lockers
{
  LockOf(s, p);
  forall i | 0 <= i < |s.lockers|
    ensures s.lockers[i].process != p
  {
    if s.lockers[i].process == p {
      ProofLib.FilterMember((l: Locker) => (l.process == p), s.lockers, s.lockers[i]);
      var f := ProofLib.Filter((l: Locker) => (l.process == p), s.lockers);
      assert f[0] in f;
      ProofLib.FilterMember((l: Locker) => (l.process == p), s.lockers, f[0]);
    }
  }
}

lemma LockOut(xs: seq<int>, t: int)
  ensures forall x :: x in ProofLib.Filter((set_x: int) => !((set_x in [t])), xs) <==> (x in xs && x != t)
  ensures |ProofLib.Filter((set_x: int) => !((set_x in [t])), xs)| <= |xs|
{
  forall x
    ensures x in ProofLib.Filter((set_x: int) => !((set_x in [t])), xs) <==> (x in xs && x != t)
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in [t])), xs, x);
  }
}

lemma LockIn(xs: seq<int>, t: int)
  ensures forall x :: x in (xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [t])) <==> (x in xs || x == t)
  ensures |xs| == 0 ==> |(xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [t]))| <= 1
{
  forall x
    ensures x in (xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [t])) <==> (x in xs || x == t)
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in xs)), [t], x);
  }
  ProofLib.FilterCons((set_x: int) => !((set_x in xs)), [t]);
  ProofLib.FilterNil((set_x: int) => !((set_x in xs)), [t][1..]);
}

lemma LockFacts(s: StorageLock)
  requires inv(s)
  ensures forall q :: q in s.critical ==> lockerOf(s, q) in s.lockers && lockerOf(s, q).process == q && lockerOf(s, q).pc.Inside? && q > 0 && livePublished(s, q + 1)
  ensures forall l :: l in s.lockers && (l.pc.Ready? || l.pc.Checked? || l.pc.Inside?) ==> l.token == l.process + 1 && livePublished(s, l.token)
  ensures forall l :: l in s.lockers && !l.pc.Fresh? && !l.pc.Observed? && !l.pc.Finished? && !l.pc.Dead? ==> l.token == l.process + 1 && l.token > 1
{
  forall q | q in s.critical
    ensures lockerOf(s, q) in s.lockers && lockerOf(s, q).process == q && lockerOf(s, q).pc.Inside? && q > 0 && livePublished(s, q + 1)
  {
    LockFound(s, q);
  }
}

lemma CleanQuarantineSets(s: StorageLock, token: int)
  ensures cleanQuarantine(s, token).quarantined == ProofLib.Filter((set_x: int) => !((set_x in [token])), s.quarantined)
  ensures cleanQuarantine(s, token).exists_ == ProofLib.Filter((set_x: int) => !((set_x in [token])), s.exists_)
  ensures cleanQuarantine(s, token).published == ProofLib.Filter((set_x: int) => !((set_x in [token])), s.published)
{
}

lemma QuarantineObservedSets(s: StorageLock, p: int)
  requires s.current != 0
  ensures quarantineObserved(s, p).quarantined == s.quarantined + ProofLib.Filter((set_x: int) => !((set_x in s.quarantined)), [s.current])
{
}

lemma CreateSets(s: StorageLock, p: int)
  ensures create(s, p).exists_ == s.exists_ + ProofLib.Filter((set_x: int) => !((set_x in s.exists_)), [(p + 1)])
{
}

lemma LeaveSets(s: StorageLock, p: int)
  ensures leave(s, p).critical == ProofLib.Filter((set_x: int) => !((set_x in [p])), s.critical)
{
}

lemma PublishSets(s: StorageLock, p: int)
  requires lockerOf(s, p).token in s.exists_
  ensures publish(s, p).published == s.published + ProofLib.Filter((set_x: int) => !((set_x in s.published)), [lockerOf(s, p).token])
{
}

lemma EnterSets(s: StorageLock, p: int)
  requires s.current == lockerOf(s, p).token
  ensures enter(s, p).critical == s.critical + ProofLib.Filter((set_x: int) => !((set_x in s.critical)), [p])
{
}

lemma CrashSets(s: StorageLock, p: int)
  ensures crash(s, p).alive == ProofLib.Filter((set_x: int) => !((set_x in [p])), s.alive)
  ensures crash(s, p).critical == ProofLib.Filter((set_x: int) => !((set_x in [p])), s.critical)
{
}

lemma FinishReleaseSets(s: StorageLock, p: int)
  requires lockerOf(s, p).staged == lockerOf(s, p).token
  ensures finishRelease(s, p).quarantined == ProofLib.Filter((set_x: int) => !((set_x in [lockerOf(s, p).token])), s.quarantined)
  ensures finishRelease(s, p).exists_ == ProofLib.Filter((set_x: int) => !((set_x in [lockerOf(s, p).token])), s.exists_)
  ensures finishRelease(s, p).published == ProofLib.Filter((set_x: int) => !((set_x in [lockerOf(s, p).token])), s.published)
{
}

lemma StageReleaseSets(s: StorageLock, p: int, taken: int)
  requires taken == (if lockerOf(s, p).ordinaryRelease then s.current else lockerOf(s, p).token) && taken != 0
  ensures stageRelease(s, p).quarantined == s.quarantined + ProofLib.Filter((set_x: int) => !((set_x in s.quarantined)), [taken])
{
}

lemma cleanQuarantine_ensures(s: StorageLock, token: int)
  ensures (inv(s) ==> canCleanQuarantine(s, token) ==> alwaysMutualExclusion(cleanQuarantine(s, token)))
  ensures (inv(s) ==> canCleanQuarantine(s, token) ==> alwaysActiveOwnership(cleanQuarantine(s, token)))
  ensures (inv(s) ==> canCleanQuarantine(s, token) ==> alwaysLiveQuarantineProtected(cleanQuarantine(s, token)))
  ensures (inv(s) ==> canCleanQuarantine(s, token) ==> alwaysLockersAreWellFormed(cleanQuarantine(s, token)))
  ensures (inv(s) ==> canCleanQuarantine(s, token) ==> alwaysAdmissionHoldsItsOwnLock(cleanQuarantine(s, token)))
  ensures (inv(s) ==> canCleanQuarantine(s, token) ==> stepReleaseRemovesOnlyOwnToken(s, "cleanQuarantine", cleanQuarantine(s, token)))
{
  if inv(s) && canCleanQuarantine(s, token) {
    var a := cleanQuarantine(s, token);
    LockFacts(s);
    CleanQuarantineSets(s, token);
    LockOut(s.quarantined, token);
    LockOut(s.exists_, token);
    LockOut(s.published, token);
  }
}

lemma observeDead_ensures(s: StorageLock, p: int)
  ensures (inv(s) ==> canObserveDead(s, p) ==> alwaysMutualExclusion(observeDead(s, p)))
  ensures (inv(s) ==> canObserveDead(s, p) ==> alwaysActiveOwnership(observeDead(s, p)))
  ensures (inv(s) ==> canObserveDead(s, p) ==> alwaysLiveQuarantineProtected(observeDead(s, p)))
  ensures (inv(s) ==> canObserveDead(s, p) ==> alwaysLockersAreWellFormed(observeDead(s, p)))
  ensures (inv(s) ==> canObserveDead(s, p) ==> alwaysAdmissionHoldsItsOwnLock(observeDead(s, p)))
  ensures (inv(s) ==> canObserveDead(s, p) ==> stepReleaseRemovesOnlyOwnToken(s, "observeDead", observeDead(s, p)))
{
  if inv(s) && canObserveDead(s, p) {
    var a := observeDead(s, p);
    LockFacts(s);
    LockWith(s, a, p, lockerOf(s, p).(pc := LockerPc.Observed));
  }
}

lemma quarantineObserved_ensures(s: StorageLock, p: int)
  ensures (inv(s) ==> canQuarantineObserved(s, p) ==> alwaysMutualExclusion(quarantineObserved(s, p)))
  ensures (inv(s) ==> canQuarantineObserved(s, p) ==> alwaysActiveOwnership(quarantineObserved(s, p)))
  ensures (inv(s) ==> canQuarantineObserved(s, p) ==> alwaysLiveQuarantineProtected(quarantineObserved(s, p)))
  ensures (inv(s) ==> canQuarantineObserved(s, p) ==> alwaysLockersAreWellFormed(quarantineObserved(s, p)))
  ensures (inv(s) ==> canQuarantineObserved(s, p) ==> alwaysAdmissionHoldsItsOwnLock(quarantineObserved(s, p)))
  ensures (inv(s) ==> canQuarantineObserved(s, p) ==> stepReleaseRemovesOnlyOwnToken(s, "quarantineObserved", quarantineObserved(s, p)))
{
  if inv(s) && canQuarantineObserved(s, p) {
    var a := quarantineObserved(s, p);
    LockFacts(s);
    LockWith(s, a, p, lockerOf(s, p).(pc := LockerPc.Fresh));
    if s.current != 0 {
      QuarantineObservedSets(s, p);
      LockIn(s.quarantined, s.current);
    }
  }
}

lemma create_ensures(s: StorageLock, p: int)
  ensures (inv(s) ==> canCreate(s, p) ==> alwaysMutualExclusion(create(s, p)))
  ensures (inv(s) ==> canCreate(s, p) ==> alwaysActiveOwnership(create(s, p)))
  ensures (inv(s) ==> canCreate(s, p) ==> alwaysLiveQuarantineProtected(create(s, p)))
  ensures (inv(s) ==> canCreate(s, p) ==> alwaysLockersAreWellFormed(create(s, p)))
  ensures (inv(s) ==> canCreate(s, p) ==> alwaysAdmissionHoldsItsOwnLock(create(s, p)))
  ensures (inv(s) ==> canCreate(s, p) ==> stepReleaseRemovesOnlyOwnToken(s, "create", create(s, p)))
{
  if inv(s) && canCreate(s, p) {
    var a := create(s, p);
    LockFacts(s);
    LockWith(s, a, p, lockerOf(s, p).(token := (p + 1), pc := LockerPc.Publishing));
    CreateSets(s, p);
    LockIn(s.exists_, p + 1);
  }
}

lemma publicationFails_ensures(s: StorageLock, p: int)
  ensures (inv(s) ==> canPublicationFails(s, p) ==> alwaysMutualExclusion(publicationFails(s, p)))
  ensures (inv(s) ==> canPublicationFails(s, p) ==> alwaysActiveOwnership(publicationFails(s, p)))
  ensures (inv(s) ==> canPublicationFails(s, p) ==> alwaysLiveQuarantineProtected(publicationFails(s, p)))
  ensures (inv(s) ==> canPublicationFails(s, p) ==> alwaysLockersAreWellFormed(publicationFails(s, p)))
  ensures (inv(s) ==> canPublicationFails(s, p) ==> alwaysAdmissionHoldsItsOwnLock(publicationFails(s, p)))
  ensures (inv(s) ==> canPublicationFails(s, p) ==> stepReleaseRemovesOnlyOwnToken(s, "publicationFails", publicationFails(s, p)))
{
  if inv(s) && canPublicationFails(s, p) {
    var a := publicationFails(s, p);
    LockFacts(s);
    LockWith(s, a, p, lockerOf(s, p).(pc := LockerPc.Closing));
  }
}

lemma leave_ensures(s: StorageLock, p: int)
  ensures (inv(s) ==> canLeave(s, p) ==> alwaysMutualExclusion(leave(s, p)))
  ensures (inv(s) ==> canLeave(s, p) ==> alwaysActiveOwnership(leave(s, p)))
  ensures (inv(s) ==> canLeave(s, p) ==> alwaysLiveQuarantineProtected(leave(s, p)))
  ensures (inv(s) ==> canLeave(s, p) ==> alwaysLockersAreWellFormed(leave(s, p)))
  ensures (inv(s) ==> canLeave(s, p) ==> alwaysAdmissionHoldsItsOwnLock(leave(s, p)))
  ensures (inv(s) ==> canLeave(s, p) ==> stepReleaseRemovesOnlyOwnToken(s, "leave", leave(s, p)))
{
  if inv(s) && canLeave(s, p) {
    var a := leave(s, p);
    LockFacts(s);
    LockWith(s, a, p, lockerOf(s, p).(pc := LockerPc.Closing));
    LeaveSets(s, p);
    LockOut(s.critical, p);
    assert p in s.critical;
  }
}

lemma publish_ensures(s: StorageLock, p: int)
  ensures (inv(s) ==> canPublish(s, p) ==> alwaysMutualExclusion(publish(s, p)))
  ensures (inv(s) ==> canPublish(s, p) ==> alwaysActiveOwnership(publish(s, p)))
  ensures (inv(s) ==> canPublish(s, p) ==> alwaysLiveQuarantineProtected(publish(s, p)))
  ensures (inv(s) ==> canPublish(s, p) ==> alwaysLockersAreWellFormed(publish(s, p)))
  ensures (inv(s) ==> canPublish(s, p) ==> alwaysAdmissionHoldsItsOwnLock(publish(s, p)))
  ensures (inv(s) ==> canPublish(s, p) ==> stepReleaseRemovesOnlyOwnToken(s, "publish", publish(s, p)))
{
  if inv(s) && canPublish(s, p) {
    var a := publish(s, p);
    LockFacts(s);
    if lockerOf(s, p).token in s.exists_ {
      LockWith(s, a, p, lockerOf(s, p).(pc := LockerPc.Ready));
      PublishSets(s, p);
      LockIn(s.published, lockerOf(s, p).token);
    } else {
      LockWith(s, a, p, lockerOf(s, p).(pc := LockerPc.Closing));
    }
  }
}

lemma enter_ensures(s: StorageLock, p: int)
  ensures (inv(s) ==> canEnter(s, p) ==> alwaysMutualExclusion(enter(s, p)))
  ensures (inv(s) ==> canEnter(s, p) ==> alwaysActiveOwnership(enter(s, p)))
  ensures (inv(s) ==> canEnter(s, p) ==> alwaysLiveQuarantineProtected(enter(s, p)))
  ensures (inv(s) ==> canEnter(s, p) ==> alwaysLockersAreWellFormed(enter(s, p)))
  ensures (inv(s) ==> canEnter(s, p) ==> alwaysAdmissionHoldsItsOwnLock(enter(s, p)))
  ensures (inv(s) ==> canEnter(s, p) ==> stepReleaseRemovesOnlyOwnToken(s, "enter", enter(s, p)))
{
  if inv(s) && canEnter(s, p) {
    var a := enter(s, p);
    LockFacts(s);
    if s.current == lockerOf(s, p).token {
      LockWith(s, a, p, lockerOf(s, p).(pc := LockerPc.Inside));
      EnterSets(s, p);
      assert |s.critical| == 0;
      LockIn(s.critical, p);
    } else {
      LockWith(s, a, p, lockerOf(s, p).(pc := LockerPc.Closing));
    }
  }
}

lemma inspectAdmission_ensures(s: StorageLock, p: int)
  ensures (inv(s) ==> canInspectAdmission(s, p) ==> alwaysMutualExclusion(inspectAdmission(s, p)))
  ensures (inv(s) ==> canInspectAdmission(s, p) ==> alwaysActiveOwnership(inspectAdmission(s, p)))
  ensures (inv(s) ==> canInspectAdmission(s, p) ==> alwaysLiveQuarantineProtected(inspectAdmission(s, p)))
  ensures (inv(s) ==> canInspectAdmission(s, p) ==> alwaysLockersAreWellFormed(inspectAdmission(s, p)))
  ensures (inv(s) ==> canInspectAdmission(s, p) ==> alwaysAdmissionHoldsItsOwnLock(inspectAdmission(s, p)))
  ensures (inv(s) ==> canInspectAdmission(s, p) ==> stepReleaseRemovesOnlyOwnToken(s, "inspectAdmission", inspectAdmission(s, p)))
{
  if inv(s) && canInspectAdmission(s, p) {
    var a := inspectAdmission(s, p);
    var l := lockerOf(s, p);
    var admitted := (s.current == l.token) && !(exists t :: t in s.quarantined && livePublished(s, t));
    LockFacts(s);
    LockWith(s, a, p, l.(pc := (if admitted then LockerPc.Checked else LockerPc.Closing)));
    if admitted && |s.critical| > 0 {
      var q := s.critical[0];
      assert q in s.critical;
      assert q != p;
    }
  }
}

lemma crash_ensures(s: StorageLock, p: int)
  ensures (inv(s) ==> canCrash(s, p) ==> alwaysMutualExclusion(crash(s, p)))
  ensures (inv(s) ==> canCrash(s, p) ==> alwaysActiveOwnership(crash(s, p)))
  ensures (inv(s) ==> canCrash(s, p) ==> alwaysLiveQuarantineProtected(crash(s, p)))
  ensures (inv(s) ==> canCrash(s, p) ==> alwaysLockersAreWellFormed(crash(s, p)))
  ensures (inv(s) ==> canCrash(s, p) ==> alwaysAdmissionHoldsItsOwnLock(crash(s, p)))
  ensures (inv(s) ==> canCrash(s, p) ==> stepReleaseRemovesOnlyOwnToken(s, "crash", crash(s, p)))
{
  if inv(s) && canCrash(s, p) {
    var a := crash(s, p);
    LockFacts(s);
    CrashSets(s, p);
    LockOut(s.alive, p);
    LockOut(s.critical, p);
    if lockerOf(s, p).pc.Dead? {
      LockUnchanged(s, p, lockerOf(s, p).(pc := LockerPc.Dead));
      assert a.lockers == s.lockers;
      forall q ensures lockerOf(a, q) == lockerOf(s, q) {
        LockOf(a, q);
        LockOf(s, q);
      }
    } else {
      LockWith(s, a, p, lockerOf(s, p).(pc := LockerPc.Dead));
    }
  }
}

lemma finishRelease_ensures(s: StorageLock, p: int)
  ensures (inv(s) ==> canFinishRelease(s, p) ==> alwaysMutualExclusion(finishRelease(s, p)))
  ensures (inv(s) ==> canFinishRelease(s, p) ==> alwaysActiveOwnership(finishRelease(s, p)))
  ensures (inv(s) ==> canFinishRelease(s, p) ==> alwaysLiveQuarantineProtected(finishRelease(s, p)))
  ensures (inv(s) ==> canFinishRelease(s, p) ==> alwaysLockersAreWellFormed(finishRelease(s, p)))
  ensures (inv(s) ==> canFinishRelease(s, p) ==> alwaysAdmissionHoldsItsOwnLock(finishRelease(s, p)))
  ensures (inv(s) ==> canFinishRelease(s, p) ==> stepReleaseRemovesOnlyOwnToken(s, "finishRelease", finishRelease(s, p)))
{
  if inv(s) && canFinishRelease(s, p) {
    var a := finishRelease(s, p);
    var l := lockerOf(s, p);
    LockFacts(s);
    if l.staged == l.token {
      LockWith(s, a, p, l.(pc := LockerPc.Finished));
      FinishReleaseSets(s, p);
      LockOut(s.quarantined, l.token);
      LockOut(s.exists_, l.token);
      LockOut(s.published, l.token);
    } else {
      LockWith(s, a, p, l.(pc := LockerPc.Closing));
    }
  }
}

lemma findRelease_ensures(s: StorageLock, p: int)
  ensures (inv(s) ==> canFindRelease(s, p) ==> alwaysMutualExclusion(findRelease(s, p)))
  ensures (inv(s) ==> canFindRelease(s, p) ==> alwaysActiveOwnership(findRelease(s, p)))
  ensures (inv(s) ==> canFindRelease(s, p) ==> alwaysLiveQuarantineProtected(findRelease(s, p)))
  ensures (inv(s) ==> canFindRelease(s, p) ==> alwaysLockersAreWellFormed(findRelease(s, p)))
  ensures (inv(s) ==> canFindRelease(s, p) ==> alwaysAdmissionHoldsItsOwnLock(findRelease(s, p)))
  ensures (inv(s) ==> canFindRelease(s, p) ==> stepReleaseRemovesOnlyOwnToken(s, "findRelease", findRelease(s, p)))
{
  if inv(s) && canFindRelease(s, p) {
    var a := findRelease(s, p);
    var l := lockerOf(s, p);
    LockFacts(s);
    LockWith(s, a, p, l.(ordinaryRelease := (s.current == l.token), pc := (if ((l.token > 0) && ((s.current == l.token) || (l.token in s.quarantined))) then LockerPc.ReleaseRename else LockerPc.Finished)));
  }
}

lemma stageRelease_ensures(s: StorageLock, p: int)
  ensures (inv(s) ==> canStageRelease(s, p) ==> alwaysMutualExclusion(stageRelease(s, p)))
  ensures (inv(s) ==> canStageRelease(s, p) ==> alwaysActiveOwnership(stageRelease(s, p)))
  ensures (inv(s) ==> canStageRelease(s, p) ==> alwaysLiveQuarantineProtected(stageRelease(s, p)))
  ensures (inv(s) ==> canStageRelease(s, p) ==> alwaysLockersAreWellFormed(stageRelease(s, p)))
  ensures (inv(s) ==> canStageRelease(s, p) ==> alwaysAdmissionHoldsItsOwnLock(stageRelease(s, p)))
  ensures (inv(s) ==> canStageRelease(s, p) ==> stepReleaseRemovesOnlyOwnToken(s, "stageRelease", stageRelease(s, p)))
{
  if inv(s) && canStageRelease(s, p) {
    var a := stageRelease(s, p);
    var l := lockerOf(s, p);
    var taken := if l.ordinaryRelease then s.current else l.token;
    LockFacts(s);
    LockWith(s, a, p, l.(staged := taken, pc := LockerPc.ReleaseCheck));
    if taken != 0 {
      StageReleaseSets(s, p, taken);
      LockIn(s.quarantined, taken);
    }
  }
}
