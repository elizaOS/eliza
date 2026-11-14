lemma invoke_ensures(q: SerialQueue, callId: string)
  ensures (inv(q) ==> canInvoke(q, callId) ==> alwaysQueueAccountsForInvocations(invoke(q, callId)))
  ensures (inv(q) ==> canInvoke(q, callId) ==> alwaysOneCallbackRuns(invoke(q, callId)))
  ensures (inv(q) ==> canInvoke(q, callId) ==> alwaysCallIdentitiesUnique(invoke(q, callId)))
  ensures (inv(q) ==> canInvoke(q, callId) ==> alwaysUnfinishedHasProgress(invoke(q, callId)))
{
  if inv(q) && canInvoke(q, callId) {
    var after := invoke(q, callId);
    forall id | id in after.calls ensures id != "" && |ProofLib.Filter((other: string) => other == id, after.calls)| == 1 {
      var p := (other: string) => other == id;
      ProofLib.FilterAppend(p, q.calls, callId);
      if id == callId {
        assert forall i :: 0 <= i < |q.calls| ==> q.calls[i] != id;
        ProofLib.FilterNone(p, q.calls);
      } else {
        assert id in q.calls;
      }
    }
  }
}
