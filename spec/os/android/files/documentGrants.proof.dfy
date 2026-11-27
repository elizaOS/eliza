lemma SetAddInt(xs: seq<int>, x: int)
  ensures var res := xs + ProofLib.Filter((set_x: int) => !(set_x in xs), [x]);
    forall y :: y in res <==> y in xs || y == x
{
  var p := (set_x: int) => !(set_x in xs);
  ProofLib.FilterCons(p, [x]);
  ProofLib.FilterNil(p, [x][1..]);
}

lemma SetRemoveInt(xs: seq<int>, x: int)
  ensures var res := ProofLib.Filter((set_x: int) => !(set_x in [x]), xs);
    forall y :: y in res <==> y in xs && y != x
{
  var p := (set_x: int) => !(set_x in [x]);
  forall y
    ensures y in ProofLib.Filter(p, xs) <==> y in xs && y != x
  {
    ProofLib.FilterMember(p, xs, y);
  }
}

lemma SetDiffInt(xs: seq<int>, ys: seq<int>)
  ensures var res := ProofLib.Filter((set_x: int) => !(set_x in ys), xs);
    forall y :: y in res <==> y in xs && !(y in ys)
{
  var p := (set_x: int) => !(set_x in ys);
  forall y
    ensures y in ProofLib.Filter(p, xs) <==> y in xs && !(y in ys)
  {
    ProofLib.FilterMember(p, xs, y);
  }
}

lemma EntryCounts(entries: seq<SelectedDocument>)
  ensures (forall e :: e in entries ==> |ProofLib.Filter((o: SelectedDocument) => (o.id == e.id), entries)| == 1) <==> ProofLib.DistinctBy(entries, (e: SelectedDocument) => e.id)
{
  forall i | 0 <= i < |entries|
    ensures |ProofLib.Filter((o: SelectedDocument) => (o.id == entries[i].id), entries)| == 1 <==> forall j :: 0 <= j < |entries| && j != i ==> entries[j].id != entries[i].id
  {
    ProofLib.FilterCountOneIffUnique((o: SelectedDocument) => (o.id == entries[i].id), entries, (e: SelectedDocument) => e.id, i);
  }
  if ProofLib.DistinctBy(entries, (e: SelectedDocument) => e.id) {
    forall e | e in entries
      ensures |ProofLib.Filter((o: SelectedDocument) => (o.id == e.id), entries)| == 1
    {
      var i :| 0 <= i < |entries| && entries[i] == e;
    }
  } else {
    var i, j :| 0 <= i < |entries| && 0 <= j < |entries| && i != j && entries[i].id == entries[j].id;
    assert entries[i] in entries;
  }
}

lemma IdsBridge(s: DocumentGrants)
  ensures alwaysIdsWereIssued(s) <==> (s.nextId >= 1 && (forall e :: e in s.entries ==> e.id >= 1 && e.id < s.nextId && e.doc >= 1) && ProofLib.DistinctBy(s.entries, (e: SelectedDocument) => e.id))
{
  EntryCounts(s.entries);
}

lemma EntryOfFacts(entries: seq<SelectedDocument>, id: int)
  requires ProofLib.DistinctBy(entries, (e: SelectedDocument) => e.id)
  ensures hasEntry(entries, id) ==> entryOf(entries, id) in entries && entryOf(entries, id).id == id
  ensures forall e :: e in entries && e.id == id ==> e == entryOf(entries, id)
{
  var p := (e: SelectedDocument) => (e.id == id);
  var f := ProofLib.Filter(p, entries);
  if hasEntry(entries, id) {
    var e :| e in entries && e.id == id;
    ProofLib.FilterMember(p, entries, e);
    assert |f| > 0;
    assert f[0] in f;
    ProofLib.FilterMember(p, entries, f[0]);
    var i :| 0 <= i < |entries| && entries[i] == f[0];
    forall o | o in entries && o.id == id
      ensures o == f[0]
    {
      var j :| 0 <= j < |entries| && entries[j] == o;
      assert i == j;
    }
  }
}

lemma GiveBackFacts(doc: int, s: DocumentGrants)
  ensures var step := giveBack(doc, s);
    step.state.entries == s.entries
    && step.state.noteKeeps == s.noteKeeps
    && step.state.nextId == s.nextId
    && (forall d :: d in step.state.granted <==> d in s.granted && !(d == doc && !holds(s.entries, doc) && !(doc in s.noteKeeps)))
    && (forall e :: e in step.out ==> e == ReleaseGrant(doc) && !holds(step.state.entries, doc) && !(doc in step.state.noteKeeps) && !(doc in step.state.granted))
    && (forall d :: d in s.granted ==> d in step.state.granted || typed0_os__android__files__documentGrants(ReleaseGrant(d)) in step.out)
{
  SetRemoveInt(s.granted, doc);
}

lemma RestartOutFold(f: (seq<GrantEffect>, SelectedDocument) -> seq<GrantEffect>, acc: seq<GrantEffect>, rest: seq<SelectedDocument>, dropped: seq<int>)
  requires forall a, e :: f(a, e) == (if ((e.doc in dropped) && !((typed0_os__android__files__documentGrants(ReleaseGrant(e.doc)) in a))) then (a + [ReleaseGrant(e.doc)]) else a)
  ensures var res := Std.Collections.Seq.FoldLeft(f, acc, rest);
    (forall x :: x in acc ==> x in res)
    && (forall x :: x in res ==> x in acc || (x.ReleaseGrant? && x.doc in dropped))
    && (forall e :: e in rest && e.doc in dropped ==> typed0_os__android__files__documentGrants(ReleaseGrant(e.doc)) in res)
  decreases |rest|
{
  if |rest| > 0 {
    var next := f(acc, rest[0]);
    RestartOutFold(f, next, rest[1..], dropped);
    var res := Std.Collections.Seq.FoldLeft(f, next, rest[1..]);
    if rest[0].doc in dropped {
      assert typed0_os__android__files__documentGrants(ReleaseGrant(rest[0].doc)) in next;
    }
    assert rest == [rest[0]] + rest[1..];
  }
}

lemma pick_ensures(s: DocumentGrants, doc: int, offered: PickerGrant, commit: RegistryCommit)
  ensures (inv(s) ==> canPick(s, doc) ==> alwaysIdsWereIssued(pick(s, doc, offered, commit).state))
  ensures (inv(s) ==> canPick(s, doc) ==> alwaysWithinCapacity(pick(s, doc, offered, commit).state))
  ensures (inv(s) ==> canPick(s, doc) ==> alwaysEveryGrantHasAHolder(pick(s, doc, offered, commit).state))
  ensures (inv(s) ==> canPick(s, doc) ==> stepReleaseOnlyAnUnheldGrant(s, "pick", pick(s, doc, offered, commit).state, pick(s, doc, offered, commit).out))
  ensures (inv(s) ==> canPick(s, doc) ==> stepGrantEndsOnlyByReleaseOrRevocation(s, "pick", pick(s, doc, offered, commit).state, pick(s, doc, offered, commit).out))
  ensures (inv(s) ==> canPick(s, doc) ==> stepRestartKeepsOnlyRetained(s, "pick", pick(s, doc, offered, commit).state))
  ensures (inv(s) ==> canPick(s, doc) ==> stepRenameIsConfirmedOnlyWhileGranted(s, "pick", pick(s, doc, offered, commit).state, pick(s, doc, offered, commit).out))
{
  if inv(s) && canPick(s, doc) {
    IdsBridge(s);
    SetAddInt(s.granted, doc);
    var taken := if offered.NoPersistableGrant? then s.granted else s.granted + ProofLib.Filter((set_x: int) => !(set_x in s.granted), [doc]);
    if commit.CommitFailed? {
      GiveBackFacts(doc, s.(granted := taken));
      IdsBridge(pick(s, doc, offered, commit).state);
    } else {
      var siblingWrite := exists e :: e in s.entries && e.doc == doc && e.retention.RetainedReadWrite?;
      var entry := SelectedDocument(s.nextId, doc, pickedRetention(offered, siblingWrite));
      var evicted := if (|s.entries| + 1) > maxSelections then (if 0 < |s.entries| then s.entries[0] else noSelection) else noSelection;
      var grown := s.entries + [entry];
      var nextEntries := admit(s.entries, entry, maxSelections);
      var mid := s.(entries := nextEntries, nextId := s.nextId + 1, granted := taken);
      assert grown[|s.entries|] == entry;
      if (|s.entries| + 1) > maxSelections {
        assert nextEntries == grown[1..];
        assert nextEntries[|s.entries| - 1] == entry;
      } else {
        assert nextEntries == grown;
      }
      assert entry in nextEntries;
      forall e | e in s.entries && e != evicted
        ensures e in nextEntries
      {
        var i :| 0 <= i < |s.entries| && s.entries[i] == e;
        if (|s.entries| + 1) > maxSelections {
          assert i > 0;
          assert grown[i] == e;
          assert nextEntries[i - 1] == e;
        } else {
          assert nextEntries[i] == e;
        }
      }
      forall a, b | 0 <= a < |grown| && 0 <= b < |grown| && a != b
        ensures grown[a].id != grown[b].id
      {
        if a < |s.entries| && b == |s.entries| {
          assert s.entries[a] in s.entries;
        } else if b < |s.entries| && a == |s.entries| {
          assert s.entries[b] in s.entries;
        }
      }
      forall i, j | 0 <= i < |nextEntries| && 0 <= j < |nextEntries| && i != j
        ensures nextEntries[i].id != nextEntries[j].id
      {
        if (|s.entries| + 1) > maxSelections {
          assert nextEntries[i] == grown[i + 1] && nextEntries[j] == grown[j + 1];
        }
      }
      GiveBackFacts(evicted.doc, mid);
      IdsBridge(pick(s, doc, offered, commit).state);
    }
  }
}

lemma lawAdmissionKeepsTheNewestWithinCapacity_ensures(entries: seq<SelectedDocument>, entry: SelectedDocument, capacity: int)
  ensures (lawAdmissionKeepsTheNewestWithinCapacity(entries, entry, capacity) == true)
{
  var local_6 := admit(entries, entry, capacity);
  if capacity >= 1 && |entries| < capacity {
    assert local_6 == entries + [entry];
    assert local_6[|entries|] == entry;
    assert entry in local_6;
  }
  if capacity >= 1 && |entries| == capacity {
    var grown := entries + [entry];
    assert local_6 == grown[1..];
    assert local_6[capacity - 1] == entry;
    assert entry in local_6;
    assert local_6[0] == grown[1];
  }
}

lemma forget_ensures(s: DocumentGrants, id: int)
  ensures (inv(s) ==> canForget(s, id) ==> alwaysIdsWereIssued(forget(s, id).state))
  ensures (inv(s) ==> canForget(s, id) ==> alwaysWithinCapacity(forget(s, id).state))
  ensures (inv(s) ==> canForget(s, id) ==> alwaysEveryGrantHasAHolder(forget(s, id).state))
  ensures (inv(s) ==> canForget(s, id) ==> stepReleaseOnlyAnUnheldGrant(s, "forget", forget(s, id).state, forget(s, id).out))
  ensures (inv(s) ==> canForget(s, id) ==> stepGrantEndsOnlyByReleaseOrRevocation(s, "forget", forget(s, id).state, forget(s, id).out))
  ensures (inv(s) ==> canForget(s, id) ==> stepRestartKeepsOnlyRetained(s, "forget", forget(s, id).state))
  ensures (inv(s) ==> canForget(s, id) ==> stepRenameIsConfirmedOnlyWhileGranted(s, "forget", forget(s, id).state, forget(s, id).out))
{
  if inv(s) && canForget(s, id) {
    IdsBridge(s);
    EntryOfFacts(s.entries, id);
    var p := (e: SelectedDocument) => (e.id != id);
    var kept := ProofLib.Filter(p, s.entries);
    ProofLib.FilterKeepsDistinctBy(p, s.entries, (e: SelectedDocument) => e.id);
    forall e | e in kept
      ensures e in s.entries && e.id != id
    {
      ProofLib.FilterMember(p, s.entries, e);
    }
    forall e | e in s.entries && e.id != id
      ensures e in kept
    {
      ProofLib.FilterMember(p, s.entries, e);
    }
    var mid := s.(entries := kept);
    GiveBackFacts(entryOf(s.entries, id).doc, mid);
    IdsBridge(forget(s, id).state);
  }
}

lemma dropNoteKeep_ensures(s: DocumentGrants, doc: int)
  ensures (inv(s) ==> canDropNoteKeep(s, doc) ==> alwaysIdsWereIssued(dropNoteKeep(s, doc).state))
  ensures (inv(s) ==> canDropNoteKeep(s, doc) ==> alwaysWithinCapacity(dropNoteKeep(s, doc).state))
  ensures (inv(s) ==> canDropNoteKeep(s, doc) ==> alwaysEveryGrantHasAHolder(dropNoteKeep(s, doc).state))
  ensures (inv(s) ==> canDropNoteKeep(s, doc) ==> stepReleaseOnlyAnUnheldGrant(s, "dropNoteKeep", dropNoteKeep(s, doc).state, dropNoteKeep(s, doc).out))
  ensures (inv(s) ==> canDropNoteKeep(s, doc) ==> stepGrantEndsOnlyByReleaseOrRevocation(s, "dropNoteKeep", dropNoteKeep(s, doc).state, dropNoteKeep(s, doc).out))
  ensures (inv(s) ==> canDropNoteKeep(s, doc) ==> stepRestartKeepsOnlyRetained(s, "dropNoteKeep", dropNoteKeep(s, doc).state))
  ensures (inv(s) ==> canDropNoteKeep(s, doc) ==> stepRenameIsConfirmedOnlyWhileGranted(s, "dropNoteKeep", dropNoteKeep(s, doc).state, dropNoteKeep(s, doc).out))
{
  if inv(s) && canDropNoteKeep(s, doc) {
    IdsBridge(s);
    SetRemoveInt(s.noteKeeps, doc);
    var mid := s.(noteKeeps := ProofLib.Filter((set_x: int) => !(set_x in [doc]), s.noteKeeps));
    GiveBackFacts(doc, mid);
    IdsBridge(dropNoteKeep(s, doc).state);
  }
}

lemma revoke_ensures(s: DocumentGrants, doc: int)
  ensures (inv(s) ==> canRevoke(s, doc) ==> alwaysIdsWereIssued(revoke(s, doc)))
  ensures (inv(s) ==> canRevoke(s, doc) ==> alwaysWithinCapacity(revoke(s, doc)))
  ensures (inv(s) ==> canRevoke(s, doc) ==> alwaysEveryGrantHasAHolder(revoke(s, doc)))
  ensures (inv(s) ==> canRevoke(s, doc) ==> stepReleaseOnlyAnUnheldGrant(s, "revoke", revoke(s, doc), []))
  ensures (inv(s) ==> canRevoke(s, doc) ==> stepGrantEndsOnlyByReleaseOrRevocation(s, "revoke", revoke(s, doc), []))
  ensures (inv(s) ==> canRevoke(s, doc) ==> stepRestartKeepsOnlyRetained(s, "revoke", revoke(s, doc)))
  ensures (inv(s) ==> canRevoke(s, doc) ==> stepRenameIsConfirmedOnlyWhileGranted(s, "revoke", revoke(s, doc), []))
{
  if inv(s) && canRevoke(s, doc) {
    SetRemoveInt(s.granted, doc);
  }
}

lemma restart_ensures(s: DocumentGrants)
  ensures (inv(s) ==> alwaysIdsWereIssued(restart(s).state))
  ensures (inv(s) ==> alwaysWithinCapacity(restart(s).state))
  ensures (inv(s) ==> alwaysEveryGrantHasAHolder(restart(s).state))
  ensures (inv(s) ==> stepReleaseOnlyAnUnheldGrant(s, "restart", restart(s).state, restart(s).out))
  ensures (inv(s) ==> stepGrantEndsOnlyByReleaseOrRevocation(s, "restart", restart(s).state, restart(s).out))
  ensures (inv(s) ==> stepRestartKeepsOnlyRetained(s, "restart", restart(s).state))
  ensures (inv(s) ==> stepRenameIsConfirmedOnlyWhileGranted(s, "restart", restart(s).state, restart(s).out))
{
  if inv(s) {
    IdsBridge(s);
    var pRet := (e: SelectedDocument) => (!e.retention.Transient?);
    var local_9 := ProofLib.Filter(pRet, s.entries);
    ProofLib.FilterKeepsDistinctBy(pRet, s.entries, (e: SelectedDocument) => e.id);
    forall e
      ensures e in local_9 <==> e in s.entries && !e.retention.Transient?
    {
      ProofLib.FilterMember(pRet, s.entries, e);
    }
    var pDrop := (d: int) => (!(holds(local_9, d)) && !((d in s.noteKeeps)));
    var local_10 := ProofLib.Filter(pDrop, s.granted);
    forall d
      ensures d in local_10 <==> d in s.granted && !holds(local_9, d) && !(d in s.noteKeeps)
    {
      ProofLib.FilterMember(pDrop, s.granted, d);
    }
    SetDiffInt(s.granted, local_10);
    var f := (acc: seq<GrantEffect>, e: SelectedDocument) => (if ((e.doc in local_10) && !((typed0_os__android__files__documentGrants(ReleaseGrant(e.doc)) in acc))) then (acc + [ReleaseGrant(e.doc)]) else acc);
    RestartOutFold(f, [], s.entries, local_10);
    IdsBridge(restart(s).state);
  }
}

lemma rename_ensures(s: DocumentGrants, id: int, renamedDoc: int, reacquire: Reacquire)
  ensures (inv(s) ==> canRename(s, id, renamedDoc) ==> alwaysIdsWereIssued(rename(s, id, renamedDoc, reacquire).state))
  ensures (inv(s) ==> canRename(s, id, renamedDoc) ==> alwaysWithinCapacity(rename(s, id, renamedDoc, reacquire).state))
  ensures (inv(s) ==> canRename(s, id, renamedDoc) ==> alwaysEveryGrantHasAHolder(rename(s, id, renamedDoc, reacquire).state))
  ensures (inv(s) ==> canRename(s, id, renamedDoc) ==> stepReleaseOnlyAnUnheldGrant(s, "rename", rename(s, id, renamedDoc, reacquire).state, rename(s, id, renamedDoc, reacquire).out))
  ensures (inv(s) ==> canRename(s, id, renamedDoc) ==> stepGrantEndsOnlyByReleaseOrRevocation(s, "rename", rename(s, id, renamedDoc, reacquire).state, rename(s, id, renamedDoc, reacquire).out))
  ensures (inv(s) ==> canRename(s, id, renamedDoc) ==> stepRestartKeepsOnlyRetained(s, "rename", rename(s, id, renamedDoc, reacquire).state))
  ensures (inv(s) ==> canRename(s, id, renamedDoc) ==> stepRenameIsConfirmedOnlyWhileGranted(s, "rename", rename(s, id, renamedDoc, reacquire).state, rename(s, id, renamedDoc, reacquire).out))
{
  if inv(s) && canRename(s, id, renamedDoc) {
    IdsBridge(s);
    EntryOfFacts(s.entries, id);
    SetAddInt(s.granted, renamedDoc);
    var local_12 := entryOf(s.entries, id);
    var local_13 := if reacquire.GrantTaken? then s.granted + ProofLib.Filter((set_x: int) => !(set_x in s.granted), [renamedDoc]) else s.granted;
    var local_14 := seq(|s.entries|, i_map requires 0 <= i_map < |s.entries| => var e := s.entries[i_map]; if e.id == id then e.(doc := renamedDoc, retention := if reacquire.GrantTaken? then e.retention else Retention.Transient) else e);
    var local_15 := renamedDoc in local_13;
    if local_15 {
      var idx :| 0 <= idx < |s.entries| && s.entries[idx] == local_12;
      assert local_14[idx].id == id && local_14[idx].doc == renamedDoc;
      assert local_14[idx] in local_14;
      forall i | 0 <= i < |local_14|
        ensures local_14[i].id == s.entries[i].id
      {}
      forall e | e in s.entries && e.id != id
        ensures e in local_14
      {
        var i :| 0 <= i < |s.entries| && s.entries[i] == e;
        assert local_14[i] == e;
      }
      forall e | e in local_14
        ensures (e.id >= 1 && e.id < s.nextId && e.doc >= 1)
      {
        var i :| 0 <= i < |local_14| && local_14[i] == e;
        assert s.entries[i] in s.entries;
      }
      EntryOfFacts(local_14, id);
      assert entryOf(local_14, id) == local_14[idx];
      assert holds(local_14, renamedDoc);
      var mid := s.(granted := local_13, entries := local_14);
      GiveBackFacts(local_12.doc, mid);
      var after := rename(s, id, renamedDoc, reacquire);
      assert after.state == giveBack(local_12.doc, mid).state;
      assert after.state.entries == local_14;
      assert hasEntry(after.state.entries, id);
      assert entryOf(after.state.entries, id).doc == renamedDoc;
      assert renamedDoc in after.state.granted;
      forall e | e in after.out && e.RenameReported?
        ensures e.id == id && e.reply.CommittedAndReadBack?
      {}
      IdsBridge(after.state);
    } else {
      var p := (e: SelectedDocument) => (e.id != id);
      var kept := ProofLib.Filter(p, s.entries);
      ProofLib.FilterKeepsDistinctBy(p, s.entries, (e: SelectedDocument) => e.id);
      forall e
        ensures e in kept <==> e in s.entries && e.id != id
      {
        ProofLib.FilterMember(p, s.entries, e);
      }
      var mid := s.(granted := local_13, entries := kept);
      GiveBackFacts(local_12.doc, mid);
      var after := rename(s, id, renamedDoc, reacquire);
      assert after.state == giveBack(local_12.doc, mid).state;
      assert after.state.entries == kept;
      assert !hasEntry(after.state.entries, id);
      forall e | e in after.out && e.RenameReported?
        ensures e.id == id && e.reply.CommittedNotReadBack?
      {}
      IdsBridge(after.state);
    }
  }
}
