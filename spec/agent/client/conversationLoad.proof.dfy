lemma FenceKept(c: ConversationLoad, after: ConversationLoad)
  requires alwaysFenceNamesALiveRequest(c)
  requires after.nextRequest == c.nextRequest && |after.requests| == |c.requests|
  requires forall i :: 0 <= i < |c.requests| ==> after.requests[i].id == c.requests[i].id
  requires after.fence == c.fence || after.fence == 0
  ensures alwaysFenceNamesALiveRequest(after)
{
  forall r | r in after.requests ensures r.id > 0 && r.id < after.nextRequest {
    var i :| 0 <= i < |after.requests| && after.requests[i] == r;
    assert c.requests[i] in c.requests;
  }
  if after.fence != 0 {
    var r :| r in c.requests && r.id == c.fence;
    var i :| 0 <= i < |c.requests| && c.requests[i] == r;
    assert after.requests[i] in after.requests;
  }
}

lemma finalizeLoad_ensures(c: ConversationLoad, id: int)
  ensures (inv(c) ==> canFinalizeLoad(c, id) ==> alwaysFenceNamesALiveRequest(finalizeLoad(c, id)))
  ensures (inv(c) ==> canFinalizeLoad(c, id) ==> alwaysCallsAreIssued(finalizeLoad(c, id)))
  ensures (inv(c) ==> canFinalizeLoad(c, id) ==> stepOnlyCurrentLoadPublishes(c, finalizeLoad(c, id)))
  ensures (inv(c) ==> canFinalizeLoad(c, id) ==> stepFallbackOnlyFromCurrentLoad(c, "finalizeLoad", finalizeLoad(c, id)))
  ensures (inv(c) ==> canFinalizeLoad(c, id) ==> stepLeavingSavesDraft(c, "finalizeLoad", finalizeLoad(c, id)))
  ensures (inv(c) ==> canFinalizeLoad(c, id) ==> stepOutdatedSelectionChangesNothing(c, "finalizeLoad", finalizeLoad(c, id)))
  ensures (inv(c) ==> canFinalizeLoad(c, id) ==> stepFailedSelectionReturnsToPrevious(c, "finalizeLoad", finalizeLoad(c, id)))
{
  if inv(c) && canFinalizeLoad(c, id) {
    var after := finalizeLoad(c, id);
    var keep := (r: LoadRequest) => (r.id != id);
    assert after.requests == ProofLib.Filter(keep, c.requests);
    forall r | r in after.requests ensures r.id > 0 && r.id < after.nextRequest {
      ProofLib.FilterMember(keep, c.requests, r);
    }
    if after.fence != 0 {
      var r :| r in c.requests && r.id == c.fence;
      ProofLib.FilterMember(keep, c.requests, r);
    }
  }
}

lemma loadReply_ensures(c: ConversationLoad, id: int, loadOutcome: LoadOutcome)
  ensures (inv(c) ==> canLoadReply(c, id) ==> alwaysFenceNamesALiveRequest(loadReply(c, id, loadOutcome)))
  ensures (inv(c) ==> canLoadReply(c, id) ==> alwaysCallsAreIssued(loadReply(c, id, loadOutcome)))
  ensures (inv(c) ==> canLoadReply(c, id) ==> stepOnlyCurrentLoadPublishes(c, loadReply(c, id, loadOutcome)))
  ensures (inv(c) ==> canLoadReply(c, id) ==> stepFallbackOnlyFromCurrentLoad(c, "loadReply", loadReply(c, id, loadOutcome)))
  ensures (inv(c) ==> canLoadReply(c, id) ==> stepLeavingSavesDraft(c, "loadReply", loadReply(c, id, loadOutcome)))
  ensures (inv(c) ==> canLoadReply(c, id) ==> stepOutdatedSelectionChangesNothing(c, "loadReply", loadReply(c, id, loadOutcome)))
  ensures (inv(c) ==> canLoadReply(c, id) ==> stepFailedSelectionReturnsToPrevious(c, "loadReply", loadReply(c, id, loadOutcome)))
{
  if inv(c) && canLoadReply(c, id) {
    FenceKept(c, loadReply(c, id, loadOutcome));
  }
}

lemma finishAround_ensures(c: ConversationLoad, id: int)
  ensures (inv(c) ==> canFinishAround(c, id) ==> alwaysFenceNamesALiveRequest(finishAround(c, id)))
  ensures (inv(c) ==> canFinishAround(c, id) ==> alwaysCallsAreIssued(finishAround(c, id)))
  ensures (inv(c) ==> canFinishAround(c, id) ==> stepOnlyCurrentLoadPublishes(c, finishAround(c, id)))
  ensures (inv(c) ==> canFinishAround(c, id) ==> stepFallbackOnlyFromCurrentLoad(c, "finishAround", finishAround(c, id)))
  ensures (inv(c) ==> canFinishAround(c, id) ==> stepLeavingSavesDraft(c, "finishAround", finishAround(c, id)))
  ensures (inv(c) ==> canFinishAround(c, id) ==> stepOutdatedSelectionChangesNothing(c, "finishAround", finishAround(c, id)))
  ensures (inv(c) ==> canFinishAround(c, id) ==> stepFailedSelectionReturnsToPrevious(c, "finishAround", finishAround(c, id)))
{
  if inv(c) && canFinishAround(c, id) {
    FenceKept(c, finishAround(c, id));
  }
}

lemma listReply_ensures(c: ConversationLoad, id: int, fallback: int)
  ensures (inv(c) ==> canListReply(c, id) ==> alwaysFenceNamesALiveRequest(listReply(c, id, fallback)))
  ensures (inv(c) ==> canListReply(c, id) ==> alwaysCallsAreIssued(listReply(c, id, fallback)))
  ensures (inv(c) ==> canListReply(c, id) ==> stepOnlyCurrentLoadPublishes(c, listReply(c, id, fallback)))
  ensures (inv(c) ==> canListReply(c, id) ==> stepFallbackOnlyFromCurrentLoad(c, "listReply", listReply(c, id, fallback)))
  ensures (inv(c) ==> canListReply(c, id) ==> stepLeavingSavesDraft(c, "listReply", listReply(c, id, fallback)))
  ensures (inv(c) ==> canListReply(c, id) ==> stepOutdatedSelectionChangesNothing(c, "listReply", listReply(c, id, fallback)))
  ensures (inv(c) ==> canListReply(c, id) ==> stepFailedSelectionReturnsToPrevious(c, "listReply", listReply(c, id, fallback)))
{
  if inv(c) && canListReply(c, id) {
    FenceKept(c, listReply(c, id, fallback));
    if loadCurrent(c, id) {
      var found := ProofLib.Filter((r: LoadRequest) => (r.id == id), c.requests);
      assert requestOf(c, id) == (if 0 < |found| then found[0] else noRequest);
      ProofLib.FilterMember((r: LoadRequest) => (r.id == id), c.requests, found[0]);
      assert found[0] in c.requests && found[0].phase.LoadList? && loadCurrent(c, found[0].id);
    }
  }
}

lemma chooseConversation_ensures(c: ConversationLoad, target: int)
  ensures (inv(c) ==> canChooseConversation(c, target) ==> alwaysFenceNamesALiveRequest(chooseConversation(c, target)))
  ensures (inv(c) ==> canChooseConversation(c, target) ==> alwaysCallsAreIssued(chooseConversation(c, target)))
  ensures (inv(c) ==> canChooseConversation(c, target) ==> stepOnlyCurrentLoadPublishes(c, chooseConversation(c, target)))
  ensures (inv(c) ==> canChooseConversation(c, target) ==> stepFallbackOnlyFromCurrentLoad(c, "chooseConversation", chooseConversation(c, target)))
  ensures (inv(c) ==> canChooseConversation(c, target) ==> stepLeavingSavesDraft(c, "chooseConversation", chooseConversation(c, target)))
  ensures (inv(c) ==> canChooseConversation(c, target) ==> stepOutdatedSelectionChangesNothing(c, "chooseConversation", chooseConversation(c, target)))
  ensures (inv(c) ==> canChooseConversation(c, target) ==> stepFailedSelectionReturnsToPrevious(c, "chooseConversation", chooseConversation(c, target)))
{
  if inv(c) && canChooseConversation(c, target) {
    var after := chooseConversation(c, target);
    if !(target == c.active && c.loaded == c.active) {
      var call := SelectionCall(c.nextCall, (c.selectionEpoch + 1), target, c.active, true);
      assert after.calls == c.calls + [call] && after.nextCall == c.nextCall + 1 && after.selectionEpoch == c.selectionEpoch + 1;
      forall k | k in after.calls ensures k.callId > 0 && k.callId < after.nextCall && k.epoch <= after.selectionEpoch && k.waiting {
        if k != call {
          assert k in c.calls;
        }
      }
    }
  }
}

lemma selectionReply_ensures(c: ConversationLoad, callId: int, selectionResult: SelectionResult)
  ensures (inv(c) ==> canSelectionReply(c, callId) ==> alwaysFenceNamesALiveRequest(selectionReply(c, callId, selectionResult)))
  ensures (inv(c) ==> canSelectionReply(c, callId) ==> alwaysCallsAreIssued(selectionReply(c, callId, selectionResult)))
  ensures (inv(c) ==> canSelectionReply(c, callId) ==> stepOnlyCurrentLoadPublishes(c, selectionReply(c, callId, selectionResult)))
  ensures (inv(c) ==> canSelectionReply(c, callId) ==> stepFallbackOnlyFromCurrentLoad(c, "selectionReply", selectionReply(c, callId, selectionResult)))
  ensures (inv(c) ==> canSelectionReply(c, callId) ==> stepLeavingSavesDraft(c, "selectionReply", selectionReply(c, callId, selectionResult)))
  ensures (inv(c) ==> canSelectionReply(c, callId) ==> stepOutdatedSelectionChangesNothing(c, "selectionReply", selectionReply(c, callId, selectionResult)))
  ensures (inv(c) ==> canSelectionReply(c, callId) ==> stepFailedSelectionReturnsToPrevious(c, "selectionReply", selectionReply(c, callId, selectionResult)))
{
  if inv(c) && canSelectionReply(c, callId) {
    var after := selectionReply(c, callId, selectionResult);
    var keep := (k: SelectionCall) => (k.callId != callId);
    assert after.calls == ProofLib.Filter(keep, c.calls);
    forall k | k in after.calls ensures k.callId > 0 && k.callId < after.nextCall && k.epoch <= after.selectionEpoch && k.waiting {
      ProofLib.FilterMember(keep, c.calls, k);
    }
  }
}
