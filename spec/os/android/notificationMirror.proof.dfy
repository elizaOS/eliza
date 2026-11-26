lemma observeSignerChanged_ensures(s: MirrorState, app: string)
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> alwaysSelectionIsBounded(observeSignerChanged(s, app)))
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> alwaysRowsNeedLiveCollection(observeSignerChanged(s, app)))
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> alwaysRowHandlesAreIssued(observeSignerChanged(s, app)))
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> alwaysQueuedCallbacksAreIssued(observeSignerChanged(s, app)))
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> alwaysKeptHistoryHasConsent(observeSignerChanged(s, app)))
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> alwaysUnadmittedMirrorHasNoHandles(observeSignerChanged(s, app)))
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> stepPolicyChangeFollowsAPurge(s, observeSignerChanged(s, app)))
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> stepNewRowsGetFreshHandles(s, observeSignerChanged(s, app)))
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> stepCutGenerationDropsEveryRow(s, observeSignerChanged(s, app)))
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> stepStaleCallbackChangesNothing(s, "observeSignerChanged", observeSignerChanged(s, app)))
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> stepClearedOnlyWhenNoFileRemains(s, "observeSignerChanged", observeSignerChanged(s, app), []))
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> stepOwedDeletionBlocksHistory(s, observeSignerChanged(s, app)))
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> stepHistoryOpensUnderCurrentAuthority(s, "observeSignerChanged", observeSignerChanged(s, app), []))
  ensures (inv(s) ==> canObserveSignerChanged(s, app) ==> stepActionLeavesRowsInPlace(s, "observeSignerChanged", observeSignerChanged(s, app), []))
{
  if inv(s) && canObserveSignerChanged(s, app) {
    var keep := (set_x: string) => !((set_x in s.changedSigners));
    ProofLib.FilterCons(keep, [app]);
    ProofLib.FilterNil(keep, [app][1..]);
    var after := observeSignerChanged(s, app);
    assert after.changedSigners == s.changedSigners + ProofLib.Filter(keep, [app]);
    assert after.changedSigners == s.changedSigners + [app];
  }
}

lemma listNotice_ensures(s: MirrorState, key: string, app: string, postedAt: int, source: NoticeSource, unlocked: bool)
  ensures (inv(s) ==> alwaysSelectionIsBounded(listNotice(s, key, app, postedAt, source, unlocked)))
  ensures (inv(s) ==> alwaysRowsNeedLiveCollection(listNotice(s, key, app, postedAt, source, unlocked)))
  ensures (inv(s) ==> alwaysRowHandlesAreIssued(listNotice(s, key, app, postedAt, source, unlocked)))
  ensures (inv(s) ==> alwaysQueuedCallbacksAreIssued(listNotice(s, key, app, postedAt, source, unlocked)))
  ensures (inv(s) ==> alwaysKeptHistoryHasConsent(listNotice(s, key, app, postedAt, source, unlocked)))
  ensures (inv(s) ==> alwaysUnadmittedMirrorHasNoHandles(listNotice(s, key, app, postedAt, source, unlocked)))
  ensures (inv(s) ==> stepPolicyChangeFollowsAPurge(s, listNotice(s, key, app, postedAt, source, unlocked)))
  ensures (inv(s) ==> stepNewRowsGetFreshHandles(s, listNotice(s, key, app, postedAt, source, unlocked)))
  ensures (inv(s) ==> stepCutGenerationDropsEveryRow(s, listNotice(s, key, app, postedAt, source, unlocked)))
  ensures (inv(s) ==> stepStaleCallbackChangesNothing(s, "listNotice", listNotice(s, key, app, postedAt, source, unlocked)))
  ensures (inv(s) ==> stepClearedOnlyWhenNoFileRemains(s, "listNotice", listNotice(s, key, app, postedAt, source, unlocked), []))
  ensures (inv(s) ==> stepOwedDeletionBlocksHistory(s, listNotice(s, key, app, postedAt, source, unlocked)))
  ensures (inv(s) ==> stepHistoryOpensUnderCurrentAuthority(s, "listNotice", listNotice(s, key, app, postedAt, source, unlocked), []))
  ensures (inv(s) ==> stepActionLeavesRowsInPlace(s, "listNotice", listNotice(s, key, app, postedAt, source, unlocked), []))
{
  if inv(s) {
    var after := listNotice(s, key, app, postedAt, source, unlocked);
    if after.nextHandle != s.nextHandle {
      var entry := RowHandle(key, s.nextHandle, postedAt);
      assert after.handles == withHandle(s.handles, entry);
      MirrorUpdatedHandles(s.handles, entry);
    }
    MirrorHandleProvenance(s, after);
  }
}

lemma enqueueCallback_ensures(s: MirrorState, instance: int, key: string, app: string, postedAt: int, removal: bool)
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> alwaysSelectionIsBounded(enqueueCallback(s, instance, key, app, postedAt, removal)))
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> alwaysRowsNeedLiveCollection(enqueueCallback(s, instance, key, app, postedAt, removal)))
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> alwaysRowHandlesAreIssued(enqueueCallback(s, instance, key, app, postedAt, removal)))
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> alwaysQueuedCallbacksAreIssued(enqueueCallback(s, instance, key, app, postedAt, removal)))
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> alwaysKeptHistoryHasConsent(enqueueCallback(s, instance, key, app, postedAt, removal)))
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> alwaysUnadmittedMirrorHasNoHandles(enqueueCallback(s, instance, key, app, postedAt, removal)))
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> stepPolicyChangeFollowsAPurge(s, enqueueCallback(s, instance, key, app, postedAt, removal)))
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> stepNewRowsGetFreshHandles(s, enqueueCallback(s, instance, key, app, postedAt, removal)))
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> stepCutGenerationDropsEveryRow(s, enqueueCallback(s, instance, key, app, postedAt, removal)))
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> stepStaleCallbackChangesNothing(s, "enqueueCallback", enqueueCallback(s, instance, key, app, postedAt, removal)))
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> stepClearedOnlyWhenNoFileRemains(s, "enqueueCallback", enqueueCallback(s, instance, key, app, postedAt, removal), []))
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> stepOwedDeletionBlocksHistory(s, enqueueCallback(s, instance, key, app, postedAt, removal)))
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> stepHistoryOpensUnderCurrentAuthority(s, "enqueueCallback", enqueueCallback(s, instance, key, app, postedAt, removal), []))
  ensures (inv(s) ==> canEnqueueCallback(s, instance) ==> stepActionLeavesRowsInPlace(s, "enqueueCallback", enqueueCallback(s, instance, key, app, postedAt, removal), []))
{
  if inv(s) && canEnqueueCallback(s, instance) {
    var after := enqueueCallback(s, instance, key, app, postedAt, removal);
    var keep := (h: RowHandle) => (h.key != key);
    assert after.handles == ProofLib.Filter(keep, s.handles);
    MirrorFilterKeepsMembers(s.handles, keep);
    MirrorHandleProvenance(s, after);
  }
}

lemma disconnectListener_ensures(s: MirrorState, instance: int)
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> alwaysSelectionIsBounded(disconnectListener(s, instance)))
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> alwaysRowsNeedLiveCollection(disconnectListener(s, instance)))
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> alwaysRowHandlesAreIssued(disconnectListener(s, instance)))
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> alwaysQueuedCallbacksAreIssued(disconnectListener(s, instance)))
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> alwaysKeptHistoryHasConsent(disconnectListener(s, instance)))
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> alwaysUnadmittedMirrorHasNoHandles(disconnectListener(s, instance)))
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> stepPolicyChangeFollowsAPurge(s, disconnectListener(s, instance)))
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> stepNewRowsGetFreshHandles(s, disconnectListener(s, instance)))
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> stepCutGenerationDropsEveryRow(s, disconnectListener(s, instance)))
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> stepStaleCallbackChangesNothing(s, "disconnectListener", disconnectListener(s, instance)))
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> stepClearedOnlyWhenNoFileRemains(s, "disconnectListener", disconnectListener(s, instance), []))
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> stepOwedDeletionBlocksHistory(s, disconnectListener(s, instance)))
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> stepHistoryOpensUnderCurrentAuthority(s, "disconnectListener", disconnectListener(s, instance), []))
  ensures (inv(s) ==> canDisconnectListener(s, instance) ==> stepActionLeavesRowsInPlace(s, "disconnectListener", disconnectListener(s, instance), []))
{
  if inv(s) && canDisconnectListener(s, instance) {
    var after := disconnectListener(s, instance);
    var keep := (c: Callback) => (c.instance != instance);
    assert after.queue == ProofLib.Filter(keep, s.queue);
    MirrorFilterKeepsMembers(s.queue, keep);
    forall c | c in after.queue ensures c.generation <= after.generation && 1 <= c.instance < after.nextInstance {
      assert c in s.queue;
    }
  }
}

lemma runCallback_ensures(s: MirrorState, source: NoticeSource, unlocked: bool, appended: bool, now: int)
  ensures (inv(s) ==> canRunCallback(s) ==> alwaysSelectionIsBounded(runCallback(s, source, unlocked, appended, now)))
  ensures (inv(s) ==> canRunCallback(s) ==> alwaysRowsNeedLiveCollection(runCallback(s, source, unlocked, appended, now)))
  ensures (inv(s) ==> canRunCallback(s) ==> alwaysRowHandlesAreIssued(runCallback(s, source, unlocked, appended, now)))
  ensures (inv(s) ==> canRunCallback(s) ==> alwaysQueuedCallbacksAreIssued(runCallback(s, source, unlocked, appended, now)))
  ensures (inv(s) ==> canRunCallback(s) ==> alwaysKeptHistoryHasConsent(runCallback(s, source, unlocked, appended, now)))
  ensures (inv(s) ==> canRunCallback(s) ==> alwaysUnadmittedMirrorHasNoHandles(runCallback(s, source, unlocked, appended, now)))
  ensures (inv(s) ==> canRunCallback(s) ==> stepPolicyChangeFollowsAPurge(s, runCallback(s, source, unlocked, appended, now)))
  ensures (inv(s) ==> canRunCallback(s) ==> stepNewRowsGetFreshHandles(s, runCallback(s, source, unlocked, appended, now)))
  ensures (inv(s) ==> canRunCallback(s) ==> stepCutGenerationDropsEveryRow(s, runCallback(s, source, unlocked, appended, now)))
  ensures (inv(s) ==> canRunCallback(s) ==> stepStaleCallbackChangesNothing(s, "runCallback", runCallback(s, source, unlocked, appended, now)))
  ensures (inv(s) ==> canRunCallback(s) ==> stepClearedOnlyWhenNoFileRemains(s, "runCallback", runCallback(s, source, unlocked, appended, now), []))
  ensures (inv(s) ==> canRunCallback(s) ==> stepOwedDeletionBlocksHistory(s, runCallback(s, source, unlocked, appended, now)))
  ensures (inv(s) ==> canRunCallback(s) ==> stepHistoryOpensUnderCurrentAuthority(s, "runCallback", runCallback(s, source, unlocked, appended, now), []))
  ensures (inv(s) ==> canRunCallback(s) ==> stepActionLeavesRowsInPlace(s, "runCallback", runCallback(s, source, unlocked, appended, now), []))
{
  if inv(s) && canRunCallback(s) {
    MirrorRunCallbackHandles(s, source, unlocked, appended, now);
    var after := runCallback(s, source, unlocked, appended, now);
    var local_4 := s.queue[0];
    var keep := (h: RowHandle) => (h.key != local_4.key);
    var otherHandles := ProofLib.Filter(keep, s.handles);
    MirrorFilterKeepsMembers(s.handles, keep);
    if after.handles != s.handles && after.handles != [] && after.handles != otherHandles {
      var entry := RowHandle(local_4.key, s.nextHandle, local_4.postedAt);
      assert after.handles == withHandle(otherHandles, entry);
      MirrorUpdatedHandles(otherHandles, entry);
      forall h | h in after.handles ensures h in s.handles || (h.handle == s.nextHandle && after.nextHandle == s.nextHandle + 1) {
        if h != entry { assert h in otherHandles; }
      }
    }
    MirrorHandleProvenance(s, after);
  }
}

lemma showHistory_ensures(s: MirrorState, facts: os__android__bridge_HostFacts, now: int)
  ensures (inv(s) ==> canShowHistory(s, facts) ==> alwaysSelectionIsBounded(showHistory(s, facts, now).state))
  ensures (inv(s) ==> canShowHistory(s, facts) ==> alwaysRowsNeedLiveCollection(showHistory(s, facts, now).state))
  ensures (inv(s) ==> canShowHistory(s, facts) ==> alwaysRowHandlesAreIssued(showHistory(s, facts, now).state))
  ensures (inv(s) ==> canShowHistory(s, facts) ==> alwaysQueuedCallbacksAreIssued(showHistory(s, facts, now).state))
  ensures (inv(s) ==> canShowHistory(s, facts) ==> alwaysKeptHistoryHasConsent(showHistory(s, facts, now).state))
  ensures (inv(s) ==> canShowHistory(s, facts) ==> alwaysUnadmittedMirrorHasNoHandles(showHistory(s, facts, now).state))
  ensures (inv(s) ==> canShowHistory(s, facts) ==> stepPolicyChangeFollowsAPurge(s, showHistory(s, facts, now).state))
  ensures (inv(s) ==> canShowHistory(s, facts) ==> stepNewRowsGetFreshHandles(s, showHistory(s, facts, now).state))
  ensures (inv(s) ==> canShowHistory(s, facts) ==> stepCutGenerationDropsEveryRow(s, showHistory(s, facts, now).state))
  ensures (inv(s) ==> canShowHistory(s, facts) ==> stepStaleCallbackChangesNothing(s, "showHistory", showHistory(s, facts, now).state))
  ensures (inv(s) ==> canShowHistory(s, facts) ==> stepClearedOnlyWhenNoFileRemains(s, "showHistory", showHistory(s, facts, now).state, showHistory(s, facts, now).out))
  ensures (inv(s) ==> canShowHistory(s, facts) ==> stepOwedDeletionBlocksHistory(s, showHistory(s, facts, now).state))
  ensures (inv(s) ==> canShowHistory(s, facts) ==> stepHistoryOpensUnderCurrentAuthority(s, "showHistory", showHistory(s, facts, now).state, showHistory(s, facts, now).out))
  ensures (inv(s) ==> canShowHistory(s, facts) ==> stepActionLeavesRowsInPlace(s, "showHistory", showHistory(s, facts, now).state, showHistory(s, facts, now).out))
{
  if inv(s) && canShowHistory(s, facts) && keepsHistory(s) && isKept(s.historyFile) {
    var answer := showHistory(s, facts, now);
    var keep := (r: HistoryRecord) => (retained(r.at, now) && !((r.app in s.changedSigners)));
    var rows := ProofLib.Filter(keep, keptRows(s.historyFile));
    assert keptRows(answer.state.historyFile) == rows;
    assert answer.out == [HistoryShown(now, rows)];
    MirrorFilterKeepsMembers(keptRows(s.historyFile), keep);
    forall r | r in rows ensures r.app in s.selected && !(r.app in s.changedSigners) && retained(r.at, now) {
      assert r in keptRows(s.historyFile) && keep(r);
    }
  }
}

lemma MirrorFilterKeepsMembers<T>(items: seq<T>, keep: T -> bool)
  ensures |ProofLib.Filter(keep, items)| <= |items|
  ensures forall item :: item in ProofLib.Filter(keep, items) ==> item in items && keep(item)
  decreases |items|
{
  if |items| == 0 {
    ProofLib.FilterNil(keep, items);
  } else {
    ProofLib.FilterCons(keep, items);
    MirrorFilterKeepsMembers(items[1..], keep);
  }
  forall item | item in ProofLib.Filter(keep, items) ensures item in items && keep(item) {
    ProofLib.FilterMember(keep, items, item);
  }
}

lemma MirrorUpdatedHandles(handles: seq<RowHandle>, entry: RowHandle)
  requires |handles| <= maxActiveRows
  ensures |withHandle(handles, entry)| <= maxActiveRows
  ensures forall h :: h in withHandle(handles, entry) ==> h == entry || h in handles
{
  var h := entry;
  var keep := (x: RowHandle) => (x.key != h.key);
  var kept := ProofLib.Filter(keep, handles);
  var rows := kept + [entry];
  assert withHandle(handles, entry) == (if |rows| > maxActiveRows then rows[1..] else rows);
  MirrorFilterKeepsMembers(handles, keep);
  forall row | row in withHandle(handles, entry) ensures row == entry || row in handles {
    assert row in rows;
    if row != entry { assert row in kept; }
  }
}

lemma MirrorRunCallbackHandles(s: MirrorState, source: NoticeSource, unlocked: bool, appended: bool, now: int)
  requires canRunCallback(s)
  ensures var local_4 := s.queue[0];
    var otherHandles := ProofLib.Filter((h: RowHandle) => (h.key != local_4.key), s.handles);
    var after := runCallback(s, source, unlocked, appended, now);
    after.handles == s.handles || after.handles == [] || after.handles == otherHandles ||
      (after.nextHandle == s.nextHandle + 1 && after.handles == withHandle(otherHandles, RowHandle(local_4.key, s.nextHandle, local_4.postedAt)))
{
}

lemma MirrorHandleProvenance(before: MirrorState, after: MirrorState)
  requires alwaysRowHandlesAreIssued(before)
  requires before.nextHandle <= after.nextHandle <= before.nextHandle + 1
  requires |after.handles| <= maxActiveRows
  requires forall h :: h in after.handles ==>
    h in before.handles || (h.handle == before.nextHandle && after.nextHandle == before.nextHandle + 1)
  ensures alwaysRowHandlesAreIssued(after) && stepNewRowsGetFreshHandles(before, after)
{
}
