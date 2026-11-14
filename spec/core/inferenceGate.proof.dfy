lemma InferenceIdentityFilters(s: InferenceGate)
  ensures alwaysInferenceIdsUnique(s) ==
    (forall r :: r in s.requests ==> r.id > 0 && |ProofLib.Filter((other: InferenceRequest) => (other.id == r.id), s.requests)| == 1)
{}

lemma InferenceHolderFilters(s: InferenceGate)
  ensures alwaysOneInferenceHolder(s) ==
    (|ProofLib.Filter((r: InferenceRequest) => isLaneHolder(r), s.requests)| == (if s.holder == 0 then 0 else 1) &&
      (forall r :: r in s.requests ==> (isLaneHolder(r) ==> r.id == s.holder)))
{}

lemma InferenceRequestProjection(s: InferenceGate, requestId: int)
  ensures inferenceRequest(s, requestId) == (var matches := ProofLib.Filter((r: InferenceRequest) => (r.id == requestId), s.requests); if |matches| > 0 then matches[0] else absentRequest)
{}

lemma InferenceRequestExact(s: InferenceGate, requestId: int)
  requires alwaysInferenceIdsUnique(s)
  ensures inferenceRequest(s, requestId).id != 0 ==> inferenceRequest(s, requestId) in s.requests && inferenceRequest(s, requestId).id == requestId
  ensures forall r :: r in s.requests && r.id == requestId ==> r == inferenceRequest(s, requestId)
{
  InferenceRequestProjection(s, requestId);
  InferenceIdentityFilters(s);
  var matches := ProofLib.Filter((r: InferenceRequest) => (r.id == requestId), s.requests);
  if |matches| > 0 {
    ProofLib.FilterMember((r: InferenceRequest) => (r.id == requestId), s.requests, matches[0]);
  }
  forall r | r in s.requests && r.id == requestId ensures r == inferenceRequest(s, requestId)
  {
    ProofLib.FilterMember((r: InferenceRequest) => (r.id == requestId), s.requests, r);
    ProofLib.FilterSamePredicate((r: InferenceRequest) => (r.id == requestId), (other: InferenceRequest) => (other.id == r.id), s.requests);
    assert |matches| == 1 && matches[0] == r;
  }
}

lemma InferenceMapKeys(s: InferenceGate, after: InferenceGate)
  requires alwaysInferenceIdsUnique(s)
  requires |s.requests| == |after.requests|
  requires forall i :: 0 <= i < |s.requests| ==>
    (s.requests[i].id == after.requests[i].id && s.requests[i].prompt == after.requests[i].prompt &&
      s.requests[i].maxTokens == after.requests[i].maxTokens && s.requests[i].label_ == after.requests[i].label_)
  ensures alwaysInferenceIdsUnique(after) && stepRequestBytesPreserved(s, after)
{
  InferenceIdentityFilters(s);
  InferenceIdentityFilters(after);
  forall r | r in after.requests
    ensures r.id > 0 && |ProofLib.Filter((other: InferenceRequest) => (other.id == r.id), after.requests)| == 1
  {
    var i :| 0 <= i < |after.requests| && after.requests[i] == r;
    assert s.requests[i] in s.requests;
    ProofLib.FilterLengthPointwise((other: InferenceRequest) => (other.id == r.id), (other: InferenceRequest) => (other.id == r.id), s.requests, after.requests);
  }
  forall r | r in s.requests
    ensures (exists other :: other in after.requests && other.id == r.id && other.prompt == r.prompt && sameTokenLimit(other.maxTokens, r.maxTokens) && other.label_ == r.label_)
  {
    var i :| 0 <= i < |s.requests| && s.requests[i] == r;
    assert after.requests[i] in after.requests;
  }
}

lemma InferenceMapHolder(s: InferenceGate, after: InferenceGate)
  requires alwaysOneInferenceHolder(s) && after.holder == s.holder
  requires |s.requests| == |after.requests|
  requires forall i :: 0 <= i < |s.requests| ==>
    (s.requests[i].id == after.requests[i].id && isLaneHolder(s.requests[i]) == isLaneHolder(after.requests[i]))
  ensures alwaysOneInferenceHolder(after)
{
  InferenceHolderFilters(s);
  InferenceHolderFilters(after);
  ProofLib.FilterLengthPointwise((r: InferenceRequest) => isLaneHolder(r), (r: InferenceRequest) => isLaneHolder(r), s.requests, after.requests);
  forall r | r in after.requests && isLaneHolder(r) ensures r.id == after.holder
  {
    var i :| 0 <= i < |after.requests| && after.requests[i] == r;
    assert s.requests[i] in s.requests;
  }
}

lemma InferenceOldHooksValid(s: InferenceGate, r: InferenceRequest)
  requires alwaysWaitingHooksOwned(s) && alwaysTimedOutOnlyBackground(s) && r in s.requests
  ensures (r.timer ==> r.priority.Background? && r.phase.QueuedInference?) &&
    (r.listener <==> r.hasSignal && r.phase.QueuedInference?) &&
    (r.phase.InferenceTimedOut? <==> !r.timeout.NoTimeout?) &&
    (r.phase.InferenceTimedOut? ==> r.priority.Background?)
{}

lemma InferenceScanBackgroundValid(xs: seq<InferenceRequest>, now: int)
  ensures (var selection := Std.Collections.Seq.FoldLeft((scan: Handoff, r: InferenceRequest) => scanBackground(scan, r, now), noHandoff, xs);
    (selection.granted != 0 ==> (exists r :: r in xs && r.id == selection.granted && r.phase.QueuedInference? && r.priority.Background? && !expired(r, now))) &&
    (forall id :: id in selection.expired ==> (exists r :: r in xs && r.id == id && r.phase.QueuedInference? && r.priority.Background? && expired(r, now))))
  decreases |xs|
{
  var fold := (scan: Handoff, r: InferenceRequest) => scanBackground(scan, r, now);
  if |xs| > 0 {
    var prefix := xs[..|xs|-1];
    var item := xs[|xs|-1];
    assert xs == prefix + [item];
    InferenceScanBackgroundValid(prefix, now);
    ProofLib.FoldLeftAppend(fold, noHandoff, prefix, item);
    var prior := Std.Collections.Seq.FoldLeft(fold, noHandoff, prefix);
    var selection := scanBackground(prior, item, now);
    if selection.granted != 0 {
      if prior.granted == 0 {
        assert selection.granted == item.id && item in xs;
      } else {
        var granted :| granted in prefix && granted.id == prior.granted && granted.phase.QueuedInference? && granted.priority.Background? && !expired(granted, now);
        assert granted in xs;
      }
    }
    forall id | id in selection.expired
      ensures (exists r :: r in xs && r.id == id && r.phase.QueuedInference? && r.priority.Background? && expired(r, now))
    {
      if id in prior.expired {
        var r :| r in prefix && r.id == id && r.phase.QueuedInference? && r.priority.Background? && expired(r, now);
        assert r in xs;
      } else {
        assert prior.granted == 0 && item.phase.QueuedInference? && item.priority.Background? && expired(item, now);
        assert selection.expired == prior.expired + [item.id];
        assert id == item.id && item in xs;
      }
    }
  }
}

lemma InferenceHandoffProjection(s: InferenceGate)
  ensures (var candidates := ProofLib.Filter((r: InferenceRequest) => (r.phase.QueuedInference? && r.priority.Interactive?), s.requests);
    handoff(s) == (if |candidates| > 0 && candidates[0].id != 0
      then noHandoff.(granted := candidates[0].id)
      else Std.Collections.Seq.FoldLeft((scan: Handoff, r: InferenceRequest) => scanBackground(scan, r, s.now), noHandoff, s.requests)))
{}

lemma InferenceHandoffValid(s: InferenceGate)
  ensures (handoff(s).granted != 0 ==> (exists r :: r in s.requests && r.id == handoff(s).granted && r.phase.QueuedInference?))
  ensures forall id :: id in handoff(s).expired ==> (exists r :: r in s.requests && r.id == id && r.phase.QueuedInference? && r.priority.Background? && expired(r, s.now))
{
  InferenceHandoffProjection(s);
  var candidates := ProofLib.Filter((r: InferenceRequest) => (r.phase.QueuedInference? && r.priority.Interactive?), s.requests);
  if |candidates| > 0 && candidates[0].id != 0 {
    ProofLib.FilterMember((r: InferenceRequest) => (r.phase.QueuedInference? && r.priority.Interactive?), s.requests, candidates[0]);
  } else {
    InferenceScanBackgroundValid(s.requests, s.now);
  }
}

lemma requestInference_ensures(s: InferenceGate, requestId: int, input: InferenceInput)
  ensures (inv(s) ==> canRequestInference(s, requestId, input) ==> alwaysOneInferenceHolder(requestInference(s, requestId, input)))
  ensures (inv(s) ==> canRequestInference(s, requestId, input) ==> alwaysInferenceIdsUnique(requestInference(s, requestId, input)))
  ensures (inv(s) ==> canRequestInference(s, requestId, input) ==> alwaysWaitingHooksOwned(requestInference(s, requestId, input)))
  ensures (inv(s) ==> canRequestInference(s, requestId, input) ==> alwaysTimedOutOnlyBackground(requestInference(s, requestId, input)))
  ensures (inv(s) ==> canRequestInference(s, requestId, input) ==> stepRequestBytesPreserved(s, requestInference(s, requestId, input)))
  ensures (inv(s) ==> canRequestInference(s, requestId, input) ==> stepRunningInferenceNotPreempted(s, "requestInference", requestInference(s, requestId, input)))
{
  if inv(s) && canRequestInference(s, requestId, input) {
    var after := requestInference(s, requestId, input);
    assert |after.requests| == |s.requests| + 1;
    var created := after.requests[|s.requests|];
    assert after.requests == s.requests + [created] && created.id == requestId;
    InferenceIdentityFilters(s);
    InferenceIdentityFilters(after);
    InferenceHolderFilters(s);
    InferenceHolderFilters(after);
    ProofLib.FilterAppend((r: InferenceRequest) => isLaneHolder(r), s.requests, created);
    forall r | r in after.requests
      ensures r.id > 0 && |ProofLib.Filter((other: InferenceRequest) => (other.id == r.id), after.requests)| == 1
    {
      ProofLib.FilterAppend((other: InferenceRequest) => (other.id == r.id), s.requests, created);
      if r == created { ProofLib.FilterNone((other: InferenceRequest) => (other.id == r.id), s.requests); }
      else { assert r in s.requests; }
    }
  }
}

lemma invokeInference_ensures(s: InferenceGate)
  ensures (inv(s) ==> canInvokeInference(s) ==> alwaysOneInferenceHolder(invokeInference(s)))
  ensures (inv(s) ==> canInvokeInference(s) ==> alwaysInferenceIdsUnique(invokeInference(s)))
  ensures (inv(s) ==> canInvokeInference(s) ==> alwaysWaitingHooksOwned(invokeInference(s)))
  ensures (inv(s) ==> canInvokeInference(s) ==> alwaysTimedOutOnlyBackground(invokeInference(s)))
  ensures (inv(s) ==> canInvokeInference(s) ==> stepRequestBytesPreserved(s, invokeInference(s)))
  ensures (inv(s) ==> canInvokeInference(s) ==> stepRunningInferenceNotPreempted(s, "invokeInference", invokeInference(s)))
{
  if inv(s) && canInvokeInference(s) {
    var after := invokeInference(s);
    InferenceRequestExact(s, s.holder);
    InferenceMapKeys(s, after);
    forall i | 0 <= i < |s.requests|
      ensures s.requests[i].id == after.requests[i].id && isLaneHolder(s.requests[i]) == isLaneHolder(after.requests[i])
    {
      var r := s.requests[i];
      assert r in s.requests;
      if r.id == s.holder {
        InferenceOldHooksValid(s, r);
      }
    }
    InferenceMapHolder(s, after);
    forall r | r in after.requests
      ensures (r.timer ==> r.priority.Background? && r.phase.QueuedInference?) &&
        (r.listener <==> r.hasSignal && r.phase.QueuedInference?) &&
        (r.phase.InferenceTimedOut? <==> !r.timeout.NoTimeout?) &&
        (r.phase.InferenceTimedOut? ==> r.priority.Background?)
    {
      var i :| 0 <= i < |after.requests| && after.requests[i] == r;
      var prior := s.requests[i];
      assert prior in s.requests;
      InferenceOldHooksValid(s, prior);
    }
  }
}

lemma fireWaitTimer_ensures(s: InferenceGate, requestId: int)
  ensures (inv(s) ==> canFireWaitTimer(s, requestId) ==> alwaysOneInferenceHolder(fireWaitTimer(s, requestId)))
  ensures (inv(s) ==> canFireWaitTimer(s, requestId) ==> alwaysInferenceIdsUnique(fireWaitTimer(s, requestId)))
  ensures (inv(s) ==> canFireWaitTimer(s, requestId) ==> alwaysWaitingHooksOwned(fireWaitTimer(s, requestId)))
  ensures (inv(s) ==> canFireWaitTimer(s, requestId) ==> alwaysTimedOutOnlyBackground(fireWaitTimer(s, requestId)))
  ensures (inv(s) ==> canFireWaitTimer(s, requestId) ==> stepRequestBytesPreserved(s, fireWaitTimer(s, requestId)))
  ensures (inv(s) ==> canFireWaitTimer(s, requestId) ==> stepRunningInferenceNotPreempted(s, "fireWaitTimer", fireWaitTimer(s, requestId)))
{
  if inv(s) && canFireWaitTimer(s, requestId) {
    var after := fireWaitTimer(s, requestId);
    InferenceRequestExact(s, requestId);
    InferenceMapKeys(s, after);
    forall i | 0 <= i < |s.requests|
      ensures s.requests[i].id == after.requests[i].id && isLaneHolder(s.requests[i]) == isLaneHolder(after.requests[i])
    {
      var r := s.requests[i];
      assert r in s.requests;
      if r.id == requestId {
        InferenceOldHooksValid(s, r);
      }
    }
    InferenceMapHolder(s, after);
    forall r | r in after.requests
      ensures (r.timer ==> r.priority.Background? && r.phase.QueuedInference?) &&
        (r.listener <==> r.hasSignal && r.phase.QueuedInference?) &&
        (r.phase.InferenceTimedOut? <==> !r.timeout.NoTimeout?) &&
        (r.phase.InferenceTimedOut? ==> r.priority.Background?)
    {
      var i :| 0 <= i < |after.requests| && after.requests[i] == r;
      var prior := s.requests[i];
      assert prior in s.requests;
      InferenceOldHooksValid(s, prior);
    }
  }
}

lemma abortInferenceSignal_ensures(s: InferenceGate, requestId: int)
  ensures (inv(s) ==> canAbortInferenceSignal(s, requestId) ==> alwaysOneInferenceHolder(abortInferenceSignal(s, requestId)))
  ensures (inv(s) ==> canAbortInferenceSignal(s, requestId) ==> alwaysInferenceIdsUnique(abortInferenceSignal(s, requestId)))
  ensures (inv(s) ==> canAbortInferenceSignal(s, requestId) ==> alwaysWaitingHooksOwned(abortInferenceSignal(s, requestId)))
  ensures (inv(s) ==> canAbortInferenceSignal(s, requestId) ==> alwaysTimedOutOnlyBackground(abortInferenceSignal(s, requestId)))
  ensures (inv(s) ==> canAbortInferenceSignal(s, requestId) ==> stepRequestBytesPreserved(s, abortInferenceSignal(s, requestId)))
  ensures (inv(s) ==> canAbortInferenceSignal(s, requestId) ==> stepRunningInferenceNotPreempted(s, "abortInferenceSignal", abortInferenceSignal(s, requestId)))
{
  if inv(s) && canAbortInferenceSignal(s, requestId) {
    var after := abortInferenceSignal(s, requestId);
    InferenceRequestExact(s, requestId);
    InferenceMapKeys(s, after);
    forall i | 0 <= i < |s.requests|
      ensures s.requests[i].id == after.requests[i].id && isLaneHolder(s.requests[i]) == isLaneHolder(after.requests[i])
    {
      var r := s.requests[i];
      assert r in s.requests;
      if r.id == requestId {
        InferenceOldHooksValid(s, r);
      }
    }
    InferenceMapHolder(s, after);
    forall r | r in after.requests
      ensures (r.timer ==> r.priority.Background? && r.phase.QueuedInference?) &&
        (r.listener <==> r.hasSignal && r.phase.QueuedInference?) &&
        (r.phase.InferenceTimedOut? <==> !r.timeout.NoTimeout?) &&
        (r.phase.InferenceTimedOut? ==> r.priority.Background?)
    {
      var i :| 0 <= i < |after.requests| && after.requests[i] == r;
      var prior := s.requests[i];
      assert prior in s.requests;
      InferenceOldHooksValid(s, prior);
    }
  }
}

lemma finishInference_ensures(s: InferenceGate, ok: bool)
  ensures (inv(s) ==> canFinishInference(s, ok) ==> alwaysOneInferenceHolder(finishInference(s, ok)))
  ensures (inv(s) ==> canFinishInference(s, ok) ==> alwaysInferenceIdsUnique(finishInference(s, ok)))
  ensures (inv(s) ==> canFinishInference(s, ok) ==> alwaysWaitingHooksOwned(finishInference(s, ok)))
  ensures (inv(s) ==> canFinishInference(s, ok) ==> alwaysTimedOutOnlyBackground(finishInference(s, ok)))
  ensures (inv(s) ==> canFinishInference(s, ok) ==> stepRequestBytesPreserved(s, finishInference(s, ok)))
  ensures (inv(s) ==> canFinishInference(s, ok) ==> stepRunningInferenceNotPreempted(s, "finishInference", finishInference(s, ok)))
{
  if inv(s) && canFinishInference(s, ok) {
    var after := finishInference(s, ok);
    var selection := handoff(s);
    InferenceHandoffValid(s);
    InferenceRequestExact(s, s.holder);
    InferenceMapKeys(s, after);
    InferenceIdentityFilters(s);
    InferenceHolderFilters(s);
    InferenceHolderFilters(after);
    forall r | r in after.requests
      ensures (isLaneHolder(r) ==> r.id == after.holder) &&
        (r.timer ==> r.priority.Background? && r.phase.QueuedInference?) &&
        (r.listener <==> r.hasSignal && r.phase.QueuedInference?) &&
        (r.phase.InferenceTimedOut? <==> !r.timeout.NoTimeout?) &&
        (r.phase.InferenceTimedOut? ==> r.priority.Background?)
    {
      var i :| 0 <= i < |after.requests| && after.requests[i] == r;
      var prior := s.requests[i];
      assert prior in s.requests;
      InferenceOldHooksValid(s, prior);
      if prior.id == selection.granted || prior.id in selection.expired {
        InferenceRequestExact(s, prior.id);
      }
    }
    if selection.granted == 0 {
      ProofLib.FilterNone((r: InferenceRequest) => isLaneHolder(r), after.requests);
    } else {
      var selected :| selected in s.requests && selected.id == selection.granted && selected.phase.QueuedInference?;
      InferenceRequestExact(s, selection.granted);
      assert selection.granted != s.holder;
      var i :| 0 <= i < |s.requests| && s.requests[i] == selected;
      var selectedAfter := after.requests[i];
      assert selectedAfter in after.requests && isLaneHolder(selectedAfter);
      forall j | 0 <= j < |after.requests| && i != j
        ensures !isLaneHolder(after.requests[j])
      {
        var item := after.requests[j];
        assert item in after.requests;
        if isLaneHolder(item) {
          ProofLib.FilterTwo((other: InferenceRequest) => (other.id == selected.id), s.requests, i, j);
          assert false;
        }
      }
      ProofLib.FilterOne((r: InferenceRequest) => isLaneHolder(r), after.requests, i);
    }
  }
}
