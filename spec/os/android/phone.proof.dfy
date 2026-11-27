lemma SetAddStr(xs: seq<string>, x: string)
  ensures var res := xs + ProofLib.Filter((set_x: string) => !(set_x in xs), [x]);
    forall y :: y in res <==> y in xs || y == x
{
  var p := (set_x: string) => !(set_x in xs);
  ProofLib.FilterCons(p, [x]);
  ProofLib.FilterNil(p, [x][1..]);
}

lemma SetRemoveStr(xs: seq<string>, x: string)
  ensures var res := ProofLib.Filter((set_x: string) => !(set_x in [x]), xs);
    forall y :: y in res <==> y in xs && y != x
{
  var p := (set_x: string) => !(set_x in [x]);
  forall y
    ensures y in ProofLib.Filter(p, xs) <==> y in xs && y != x
  {
    ProofLib.FilterMember(p, xs, y);
  }
}

lemma addCall_ensures(s: CallService, callId: string)
  ensures (inv(s) ==> canAddCall(s, callId) ==> alwaysNoticeHasARegisteredCall(addCall(s, callId)))
  ensures (inv(s) ==> canAddCall(s, callId) ==> alwaysDestroyedServiceHasNoCalls(addCall(s, callId)))
  ensures (inv(s) ==> canAddCall(s, callId) ==> alwaysCallsWereIssued(addCall(s, callId)))
  ensures (inv(s) ==> canAddCall(s, callId) ==> alwaysEndedNoticeAwaitsItsUpdate(addCall(s, callId)))
  ensures (inv(s) ==> canAddCall(s, callId) ==> stepDisconnectedCallStaysEnded(s, addCall(s, callId)))
  ensures (inv(s) ==> canAddCall(s, callId) ==> stepRemovedCallStaysRemoved(s, addCall(s, callId)))
{
  if inv(s) && canAddCall(s, callId) {
    SetAddStr(s.issued, callId);
    SetAddStr(s.calls, callId);
    SetAddStr(s.notices, callId);
  }
}

lemma reportCallState_ensures(s: CallService, callId: string, disconnected: bool)
  ensures (inv(s) ==> canReportCallState(s, callId) ==> alwaysNoticeHasARegisteredCall(reportCallState(s, callId, disconnected)))
  ensures (inv(s) ==> canReportCallState(s, callId) ==> alwaysDestroyedServiceHasNoCalls(reportCallState(s, callId, disconnected)))
  ensures (inv(s) ==> canReportCallState(s, callId) ==> alwaysCallsWereIssued(reportCallState(s, callId, disconnected)))
  ensures (inv(s) ==> canReportCallState(s, callId) ==> alwaysEndedNoticeAwaitsItsUpdate(reportCallState(s, callId, disconnected)))
  ensures (inv(s) ==> canReportCallState(s, callId) ==> stepDisconnectedCallStaysEnded(s, reportCallState(s, callId, disconnected)))
  ensures (inv(s) ==> canReportCallState(s, callId) ==> stepRemovedCallStaysRemoved(s, reportCallState(s, callId, disconnected)))
{
  if inv(s) && canReportCallState(s, callId) {
    SetAddStr(s.ended, callId);
    SetAddStr(s.queued, callId);
  }
}

lemma deliverCallUpdate_ensures(s: CallService, callId: string)
  ensures (inv(s) ==> canDeliverCallUpdate(s, callId) ==> alwaysNoticeHasARegisteredCall(deliverCallUpdate(s, callId)))
  ensures (inv(s) ==> canDeliverCallUpdate(s, callId) ==> alwaysDestroyedServiceHasNoCalls(deliverCallUpdate(s, callId)))
  ensures (inv(s) ==> canDeliverCallUpdate(s, callId) ==> alwaysCallsWereIssued(deliverCallUpdate(s, callId)))
  ensures (inv(s) ==> canDeliverCallUpdate(s, callId) ==> alwaysEndedNoticeAwaitsItsUpdate(deliverCallUpdate(s, callId)))
  ensures (inv(s) ==> canDeliverCallUpdate(s, callId) ==> stepDisconnectedCallStaysEnded(s, deliverCallUpdate(s, callId)))
  ensures (inv(s) ==> canDeliverCallUpdate(s, callId) ==> stepRemovedCallStaysRemoved(s, deliverCallUpdate(s, callId)))
{
  if inv(s) && canDeliverCallUpdate(s, callId) {
    SetRemoveStr(s.queued, callId);
    SetRemoveStr(s.notices, callId);
    SetAddStr(s.notices, callId);
  }
}

lemma dropRetiredUpdate_ensures(s: CallService, callId: string)
  ensures (inv(s) ==> canDropRetiredUpdate(s, callId) ==> alwaysNoticeHasARegisteredCall(dropRetiredUpdate(s, callId)))
  ensures (inv(s) ==> canDropRetiredUpdate(s, callId) ==> alwaysDestroyedServiceHasNoCalls(dropRetiredUpdate(s, callId)))
  ensures (inv(s) ==> canDropRetiredUpdate(s, callId) ==> alwaysCallsWereIssued(dropRetiredUpdate(s, callId)))
  ensures (inv(s) ==> canDropRetiredUpdate(s, callId) ==> alwaysEndedNoticeAwaitsItsUpdate(dropRetiredUpdate(s, callId)))
  ensures (inv(s) ==> canDropRetiredUpdate(s, callId) ==> stepDisconnectedCallStaysEnded(s, dropRetiredUpdate(s, callId)))
  ensures (inv(s) ==> canDropRetiredUpdate(s, callId) ==> stepRemovedCallStaysRemoved(s, dropRetiredUpdate(s, callId)))
{
  if inv(s) && canDropRetiredUpdate(s, callId) {
    SetRemoveStr(s.queued, callId);
  }
}

lemma removeCall_ensures(s: CallService, callId: string)
  ensures (inv(s) ==> canRemoveCall(s, callId) ==> alwaysNoticeHasARegisteredCall(removeCall(s, callId)))
  ensures (inv(s) ==> canRemoveCall(s, callId) ==> alwaysDestroyedServiceHasNoCalls(removeCall(s, callId)))
  ensures (inv(s) ==> canRemoveCall(s, callId) ==> alwaysCallsWereIssued(removeCall(s, callId)))
  ensures (inv(s) ==> canRemoveCall(s, callId) ==> alwaysEndedNoticeAwaitsItsUpdate(removeCall(s, callId)))
  ensures (inv(s) ==> canRemoveCall(s, callId) ==> stepDisconnectedCallStaysEnded(s, removeCall(s, callId)))
  ensures (inv(s) ==> canRemoveCall(s, callId) ==> stepRemovedCallStaysRemoved(s, removeCall(s, callId)))
{
  if inv(s) && canRemoveCall(s, callId) {
    SetRemoveStr(s.calls, callId);
    SetRemoveStr(s.notices, callId);
  }
}

lemma TakeFoldSubset(xs: seq<os__android__paging_RowKey>, init: os__android__paging_PagePrefix, limit: int)
  requires init.count == |init.kept|
  ensures var f := (prefix: os__android__paging_PagePrefix, key: os__android__paging_RowKey) => (if (prefix.count < limit) then os__android__paging_PagePrefix((prefix.count + 1), (prefix.kept + [key])) else prefix);
    var res := Std.Collections.Seq.FoldLeft(f, init, xs);
    (forall k :: k in res.kept ==> k in init.kept || k in xs)
    && (limit >= init.count ==> |res.kept| <= limit)
  decreases |xs|
{
  var f := (prefix: os__android__paging_PagePrefix, key: os__android__paging_RowKey) => (if (prefix.count < limit) then os__android__paging_PagePrefix((prefix.count + 1), (prefix.kept + [key])) else prefix);
  if |xs| > 0 {
    var next := f(init, xs[0]);
    TakeFoldSubset(xs[1..], next, limit);
    assert xs == [xs[0]] + xs[1..];
  }
}

lemma lawCallLogPageStaysOnItsQuery_ensures(declared: bool, presence: os__android__bridge_PluginPresence, facts: os__android__bridge_HostFacts, request: os__android__paging_PageRequest, numberFilter: string, pageLimit: int, providerRows: seq<os__android__paging_RowKey>, fenceHolds: bool)
  ensures (lawCallLogPageStaysOnItsQuery(declared, presence, facts, request, numberFilter, pageLimit, providerRows, fenceHolds) == true)
{
  var ans := readCallLog(declared, presence, facts, request, numberFilter, pageLimit, providerRows, fenceHolds);
  if ans.CallLogPage? {
    var start := os__android__paging_startOf(request, numberFilter, true);
    var p := (key: os__android__paging_RowKey) => os__android__paging_isAfterStart(start, key);
    var e := ProofLib.Filter(p, providerRows);
    TakeFoldSubset(e, os__android__paging_PagePrefix(0, []), pageLimit);
    forall k | k in ans.rows
      ensures os__android__paging_isAfterStart(start, k) && k in providerRows
    {
      assert k in e;
      ProofLib.FilterMember(p, providerRows, k);
    }
  }
}
