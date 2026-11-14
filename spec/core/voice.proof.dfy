lemma VoiceFilters(v: VoiceToken)
  ensures alwaysListenerIdentity(v) == (forall listener :: listener in v.listeners ==> |ProofLib.Filter((other: VoiceListener) => (other == listener), v.listeners)| == 1 && (listener.internal || listener.id > 0))
  ensures alwaysCallIdentity(v) == (v.nextCall > 0 && (forall callback :: callback in v.calls ==> callback.id > 0 && callback.id < v.nextCall && |ProofLib.Filter((other: VoiceCall) => (other.id == callback.id), v.calls)| == 1) && (forall callId :: callId in v.stack ==> exists callback :: callback in v.calls && callback.id == callId && !callback.complete))
  ensures alwaysStackIdentity(v) == (forall callId :: callId in v.stack ==> |ProofLib.Filter((other: int) => (other == callId), v.stack)| == 1)
  ensures alwaysHandleIdentity(v) == (v.nextHandle > 0 && forall handle :: handle in v.handles ==> handle.id > 0 && handle.id < v.nextHandle && handle.listener > 0 && |ProofLib.Filter((other: VoiceDisposer) => (other.id == handle.id), v.handles)| == 1)
{}

lemma VoiceCallLookup(v: VoiceToken, callback: VoiceCall)
  requires alwaysCallIdentity(v)
  requires callback in v.calls
  ensures callAt(v, callback.id) == callback
{
  VoiceFilters(v);
  var matches := ProofLib.Filter((other: VoiceCall) => (other.id == callback.id), v.calls);
  ProofLib.FilterMember((other: VoiceCall) => (other.id == callback.id), v.calls, callback);
  assert |matches| == 1;
  assert matches[0] == callback;
}

lemma VoiceTop(v: VoiceToken)
  requires inv(v)
  requires |v.stack| > 0
  ensures topCall(v).id == v.stack[|v.stack| - 1]
  ensures topCall(v) in v.calls && !topCall(v).complete
{
  VoiceFilters(v);
  var id := v.stack[|v.stack| - 1];
  assert id in v.stack;
  assert exists callback :: callback in v.calls && callback.id == id && !callback.complete;
  var callback :| callback in v.calls && callback.id == id && !callback.complete;
  VoiceCallLookup(v, callback);
}

lemma VoiceInvoke(v: VoiceToken, listener: VoiceListener, handle: int)
  requires inv(v)
  requires !v.phase.Unconstructed?
  ensures inv(invokeListener(listener, handle, v))
{
  var after := invokeListener(listener, handle, v);
  var added := VoiceCall(v.nextCall, listener, handle, v.signalAborted, false, false);
  VoiceFilters(v);
  VoiceFilters(after);
  VoiceCallsDistinct(v.calls);
  forall callback | callback in v.calls ensures callback.id != added.id {}
  ProofLib.DistinctByConcat(v.calls, [added], (callback: VoiceCall) => callback.id);
  VoiceCallsDistinct(after.calls);
  VoiceStackDistinct(v.stack);
  forall callId | callId in v.stack ensures callId != v.nextCall {
    var callback :| callback in v.calls && callback.id == callId && !callback.complete;
  }
  ProofLib.DistinctByConcat(v.stack, [v.nextCall], (callId: int) => callId);
  VoiceStackDistinct(after.stack);
  forall callId | callId in after.stack
    ensures exists callback :: callback in after.calls && callback.id == callId && !callback.complete
  {
    if callId == v.nextCall {
      assert added in after.calls;
    } else {
      var callback :| callback in v.calls && callback.id == callId && !callback.complete;
      assert callback in after.calls;
    }
  }
}

lemma VoiceAddListener(v: VoiceToken, listener: VoiceListener)
  requires inv(v)
  requires listener.internal || listener.id > 0
  ensures alwaysListenerIdentity(v.(listeners := addListener(v, listener)))
{
  VoiceFilters(v);
  VoiceListenersDistinct(v.listeners);
  var after := v.(listeners := addListener(v, listener));
  if !(listener in v.listeners) {
    ProofLib.DistinctByConcat(v.listeners, [listener], (entry: VoiceListener) => entry);
  }
  VoiceListenersDistinct(after.listeners);
  VoiceFilters(after);
}

lemma VoiceAppendHandle(v: VoiceToken, listenerId: int, removes: bool, returned: bool)
  requires inv(v)
  requires !v.phase.Unconstructed?
  requires listenerId > 0
  ensures inv(v.(handles := v.handles + [VoiceDisposer(v.nextHandle, listenerId, removes, returned)], nextHandle := v.nextHandle + 1))
{
  var after := v.(handles := v.handles + [VoiceDisposer(v.nextHandle, listenerId, removes, returned)], nextHandle := v.nextHandle + 1);
  VoiceFilters(v);
  VoiceFilters(after);
  VoiceHandlesDistinct(v.handles);
  forall entry | entry in v.handles ensures entry.id != v.nextHandle {}
  ProofLib.DistinctByConcat(v.handles, [VoiceDisposer(v.nextHandle, listenerId, removes, returned)], (handle: VoiceDisposer) => handle.id);
  VoiceHandlesDistinct(after.handles);
}

lemma VoiceCallsDistinct(xs: seq<VoiceCall>)
  ensures (forall callback :: callback in xs ==> |ProofLib.Filter((other: VoiceCall) => (other.id == callback.id), xs)| == 1) <==> ProofLib.DistinctBy(xs, (callback: VoiceCall) => callback.id)
{
  if forall callback :: callback in xs ==> |ProofLib.Filter((other: VoiceCall) => (other.id == callback.id), xs)| == 1 {
    forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
      ensures xs[i].id != xs[j].id
    {
      ProofLib.FilterCountOneIffUnique((other: VoiceCall) => (other.id == xs[i].id), xs, (callback: VoiceCall) => callback.id, i);
    }
  } else if ProofLib.DistinctBy(xs, (callback: VoiceCall) => callback.id) {
    forall callback | callback in xs ensures |ProofLib.Filter((other: VoiceCall) => (other.id == callback.id), xs)| == 1 {
      var i :| 0 <= i < |xs| && xs[i] == callback;
      ProofLib.FilterOne((other: VoiceCall) => (other.id == callback.id), xs, i);
    }
  }
}

lemma VoiceHandlesDistinct(xs: seq<VoiceDisposer>)
  ensures (forall handle :: handle in xs ==> |ProofLib.Filter((other: VoiceDisposer) => (other.id == handle.id), xs)| == 1) <==> ProofLib.DistinctBy(xs, (handle: VoiceDisposer) => handle.id)
{
  if forall handle :: handle in xs ==> |ProofLib.Filter((other: VoiceDisposer) => (other.id == handle.id), xs)| == 1 {
    forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
      ensures xs[i].id != xs[j].id
    {
      ProofLib.FilterCountOneIffUnique((other: VoiceDisposer) => (other.id == xs[i].id), xs, (handle: VoiceDisposer) => handle.id, i);
    }
  } else if ProofLib.DistinctBy(xs, (handle: VoiceDisposer) => handle.id) {
    forall handle | handle in xs ensures |ProofLib.Filter((other: VoiceDisposer) => (other.id == handle.id), xs)| == 1 {
      var i :| 0 <= i < |xs| && xs[i] == handle;
      ProofLib.FilterOne((other: VoiceDisposer) => (other.id == handle.id), xs, i);
    }
  }
}

lemma VoiceListenersDistinct(xs: seq<VoiceListener>)
  ensures (forall entry :: entry in xs ==> |ProofLib.Filter((other: VoiceListener) => (other == entry), xs)| == 1) <==> ProofLib.DistinctBy(xs, (entry: VoiceListener) => entry)
{
  if forall entry :: entry in xs ==> |ProofLib.Filter((other: VoiceListener) => (other == entry), xs)| == 1 {
    forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
      ensures xs[i] != xs[j]
    {
      assert xs[i] in xs;
      assert |ProofLib.Filter((other: VoiceListener) => (other == xs[i]), xs)| == 1;
      if xs[i] == xs[j] {
        ProofLib.FilterTwo((other: VoiceListener) => (other == xs[i]), xs, i, j);
        assert false;
      }
    }
  } else if ProofLib.DistinctBy(xs, (entry: VoiceListener) => entry) {
    forall entry | entry in xs ensures |ProofLib.Filter((other: VoiceListener) => (other == entry), xs)| == 1 {
      var i :| 0 <= i < |xs| && xs[i] == entry;
      ProofLib.FilterOne((other: VoiceListener) => (other == entry), xs, i);
    }
  }
}

lemma VoiceStackDistinct(xs: seq<int>)
  ensures (forall callId :: callId in xs ==> |ProofLib.Filter((other: int) => (other == callId), xs)| == 1) <==> ProofLib.DistinctBy(xs, (callId: int) => callId)
{
  if forall callId :: callId in xs ==> |ProofLib.Filter((other: int) => (other == callId), xs)| == 1 {
    forall i, j | 0 <= i < |xs| && 0 <= j < |xs| && i != j
      ensures xs[i] != xs[j]
    {
      assert xs[i] in xs;
      assert |ProofLib.Filter((other: int) => (other == xs[i]), xs)| == 1;
      if xs[i] == xs[j] {
        ProofLib.FilterTwo((other: int) => (other == xs[i]), xs, i, j);
        assert false;
      }
    }
  } else if ProofLib.DistinctBy(xs, (callId: int) => callId) {
    forall callId | callId in xs ensures |ProofLib.Filter((other: int) => (other == callId), xs)| == 1 {
      var i :| 0 <= i < |xs| && xs[i] == callId;
      ProofLib.FilterOne((other: int) => (other == callId), xs, i);
    }
  }
}

lemma VoiceDisposeFilter(v: VoiceToken, handleId: int, listenerId: int)
  requires listenerId == (if 0 < |ProofLib.Filter((handle: VoiceDisposer) => (handle.id == handleId), v.handles)| then ProofLib.Filter((handle: VoiceDisposer) => (handle.id == handleId), v.handles)[0] else VoiceDisposer(0, 0, false, false)).listener
  ensures disposeListener(v, handleId).listeners == (if (exists handle :: handle in v.handles && handle.id == handleId && handle.removes) then ProofLib.Filter((listener: VoiceListener) => (listener.internal || (listener.id != listenerId)), v.listeners) else v.listeners)
{}

lemma subscribe_ensures(v: VoiceToken, listenerId: int)
  ensures (inv(v) ==> canSubscribe(v, listenerId) ==> alwaysDoneReleasesResources(subscribe(v, listenerId)))
  ensures (inv(v) ==> canSubscribe(v, listenerId) ==> alwaysUnlinkedBeforeFanout(subscribe(v, listenerId)))
  ensures (inv(v) ==> canSubscribe(v, listenerId) ==> alwaysListenerIdentity(subscribe(v, listenerId)))
  ensures (inv(v) ==> canSubscribe(v, listenerId) ==> alwaysCallIdentity(subscribe(v, listenerId)))
  ensures (inv(v) ==> canSubscribe(v, listenerId) ==> alwaysStackIdentity(subscribe(v, listenerId)))
  ensures (inv(v) ==> canSubscribe(v, listenerId) ==> alwaysUnconstructedEmpty(subscribe(v, listenerId)))
  ensures (inv(v) ==> canSubscribe(v, listenerId) ==> alwaysHandleIdentity(subscribe(v, listenerId)))
  ensures (inv(v) ==> canSubscribe(v, listenerId) ==> alwaysFirstReasonOwnsSignal(subscribe(v, listenerId)))
  ensures (inv(v) ==> canSubscribe(v, listenerId) ==> alwaysSnapshotFollowsUnlink(subscribe(v, listenerId)))
  ensures (inv(v) ==> canSubscribe(v, listenerId) ==> alwaysSignalFollowsClear(subscribe(v, listenerId)))
  ensures (inv(v) ==> canSubscribe(v, listenerId) ==> stepFirstReasonWins(v, subscribe(v, listenerId)))
  ensures (inv(v) ==> canSubscribe(v, listenerId) ==> stepSignalNeverReopens(v, subscribe(v, listenerId)))
{
  if inv(v) && canSubscribe(v, listenerId) {
    var listener := VoiceListener(listenerId, false);
    var prepared := v.(handles := v.handles + [VoiceDisposer(v.nextHandle, listenerId, v.reason.Active?, v.reason.Active?)], nextHandle := v.nextHandle + 1);
    VoiceAppendHandle(v, listenerId, v.reason.Active?, v.reason.Active?);
    if v.reason.Active? {
      VoiceAddListener(prepared, listener);
    } else {
      VoiceInvoke(prepared, listener, v.nextHandle);
    }
  }
}

lemma subscribeCleanup_ensures(v: VoiceToken)
  ensures (inv(v) ==> canSubscribeCleanup(v) ==> alwaysDoneReleasesResources(subscribeCleanup(v)))
  ensures (inv(v) ==> canSubscribeCleanup(v) ==> alwaysUnlinkedBeforeFanout(subscribeCleanup(v)))
  ensures (inv(v) ==> canSubscribeCleanup(v) ==> alwaysListenerIdentity(subscribeCleanup(v)))
  ensures (inv(v) ==> canSubscribeCleanup(v) ==> alwaysCallIdentity(subscribeCleanup(v)))
  ensures (inv(v) ==> canSubscribeCleanup(v) ==> alwaysStackIdentity(subscribeCleanup(v)))
  ensures (inv(v) ==> canSubscribeCleanup(v) ==> alwaysUnconstructedEmpty(subscribeCleanup(v)))
  ensures (inv(v) ==> canSubscribeCleanup(v) ==> alwaysHandleIdentity(subscribeCleanup(v)))
  ensures (inv(v) ==> canSubscribeCleanup(v) ==> alwaysFirstReasonOwnsSignal(subscribeCleanup(v)))
  ensures (inv(v) ==> canSubscribeCleanup(v) ==> alwaysSnapshotFollowsUnlink(subscribeCleanup(v)))
  ensures (inv(v) ==> canSubscribeCleanup(v) ==> alwaysSignalFollowsClear(subscribeCleanup(v)))
  ensures (inv(v) ==> canSubscribeCleanup(v) ==> stepFirstReasonWins(v, subscribeCleanup(v)))
  ensures (inv(v) ==> canSubscribeCleanup(v) ==> stepSignalNeverReopens(v, subscribeCleanup(v)))
{
  if inv(v) && canSubscribeCleanup(v) {
    if v.reason.Active? {
      VoiceAddListener(v, emptyListener);
    } else {
      VoiceInvoke(v, emptyListener, 0);
    }
  }
}

lemma deliverNext_ensures(v: VoiceToken)
  ensures (inv(v) ==> canDeliverNext(v) ==> alwaysDoneReleasesResources(deliverNext(v)))
  ensures (inv(v) ==> canDeliverNext(v) ==> alwaysUnlinkedBeforeFanout(deliverNext(v)))
  ensures (inv(v) ==> canDeliverNext(v) ==> alwaysListenerIdentity(deliverNext(v)))
  ensures (inv(v) ==> canDeliverNext(v) ==> alwaysCallIdentity(deliverNext(v)))
  ensures (inv(v) ==> canDeliverNext(v) ==> alwaysStackIdentity(deliverNext(v)))
  ensures (inv(v) ==> canDeliverNext(v) ==> alwaysUnconstructedEmpty(deliverNext(v)))
  ensures (inv(v) ==> canDeliverNext(v) ==> alwaysHandleIdentity(deliverNext(v)))
  ensures (inv(v) ==> canDeliverNext(v) ==> alwaysFirstReasonOwnsSignal(deliverNext(v)))
  ensures (inv(v) ==> canDeliverNext(v) ==> alwaysSnapshotFollowsUnlink(deliverNext(v)))
  ensures (inv(v) ==> canDeliverNext(v) ==> alwaysSignalFollowsClear(deliverNext(v)))
  ensures (inv(v) ==> canDeliverNext(v) ==> stepFirstReasonWins(v, deliverNext(v)))
  ensures (inv(v) ==> canDeliverNext(v) ==> stepSignalNeverReopens(v, deliverNext(v)))
{
  if inv(v) && canDeliverNext(v) {
    VoiceInvoke(v, v.pending[0], 0);
  }
}

lemma disposeListener_ensures(v: VoiceToken, handleId: int)
  ensures (inv(v) ==> canDisposeListener(v, handleId) ==> alwaysDoneReleasesResources(disposeListener(v, handleId)))
  ensures (inv(v) ==> canDisposeListener(v, handleId) ==> alwaysUnlinkedBeforeFanout(disposeListener(v, handleId)))
  ensures (inv(v) ==> canDisposeListener(v, handleId) ==> alwaysListenerIdentity(disposeListener(v, handleId)))
  ensures (inv(v) ==> canDisposeListener(v, handleId) ==> alwaysCallIdentity(disposeListener(v, handleId)))
  ensures (inv(v) ==> canDisposeListener(v, handleId) ==> alwaysStackIdentity(disposeListener(v, handleId)))
  ensures (inv(v) ==> canDisposeListener(v, handleId) ==> alwaysUnconstructedEmpty(disposeListener(v, handleId)))
  ensures (inv(v) ==> canDisposeListener(v, handleId) ==> alwaysHandleIdentity(disposeListener(v, handleId)))
  ensures (inv(v) ==> canDisposeListener(v, handleId) ==> alwaysFirstReasonOwnsSignal(disposeListener(v, handleId)))
  ensures (inv(v) ==> canDisposeListener(v, handleId) ==> alwaysSnapshotFollowsUnlink(disposeListener(v, handleId)))
  ensures (inv(v) ==> canDisposeListener(v, handleId) ==> alwaysSignalFollowsClear(disposeListener(v, handleId)))
  ensures (inv(v) ==> canDisposeListener(v, handleId) ==> stepFirstReasonWins(v, disposeListener(v, handleId)))
  ensures (inv(v) ==> canDisposeListener(v, handleId) ==> stepSignalNeverReopens(v, disposeListener(v, handleId)))
{
  if inv(v) && canDisposeListener(v, handleId) {
    var after := disposeListener(v, handleId);
    var selected := (if 0 < |ProofLib.Filter((handle: VoiceDisposer) => (handle.id == handleId), v.handles)| then ProofLib.Filter((handle: VoiceDisposer) => (handle.id == handleId), v.handles)[0] else VoiceDisposer(0, 0, false, false)).listener;
    VoiceDisposeFilter(v, handleId, selected);
    VoiceFilters(v);
    VoiceListenersDistinct(v.listeners);
    if exists handle :: handle in v.handles && handle.id == handleId && handle.removes {
      ProofLib.FilterKeepsDistinctBy((listener: VoiceListener) => (listener.internal || (listener.id != selected)), v.listeners, (entry: VoiceListener) => entry);
      forall listener | listener in after.listeners
        ensures listener.internal || listener.id > 0
      {
        ProofLib.FilterMember((listener: VoiceListener) => (listener.internal || (listener.id != selected)), v.listeners, listener);
      }
    }
    VoiceListenersDistinct(after.listeners);
    VoiceFilters(after);
  }
}

lemma finishCallback_ensures(v: VoiceToken, successful: bool)
  ensures (inv(v) ==> canFinishCallback(v, successful) ==> alwaysDoneReleasesResources(finishCallback(v, successful)))
  ensures (inv(v) ==> canFinishCallback(v, successful) ==> alwaysUnlinkedBeforeFanout(finishCallback(v, successful)))
  ensures (inv(v) ==> canFinishCallback(v, successful) ==> alwaysListenerIdentity(finishCallback(v, successful)))
  ensures (inv(v) ==> canFinishCallback(v, successful) ==> alwaysCallIdentity(finishCallback(v, successful)))
  ensures (inv(v) ==> canFinishCallback(v, successful) ==> alwaysStackIdentity(finishCallback(v, successful)))
  ensures (inv(v) ==> canFinishCallback(v, successful) ==> alwaysUnconstructedEmpty(finishCallback(v, successful)))
  ensures (inv(v) ==> canFinishCallback(v, successful) ==> alwaysHandleIdentity(finishCallback(v, successful)))
  ensures (inv(v) ==> canFinishCallback(v, successful) ==> alwaysFirstReasonOwnsSignal(finishCallback(v, successful)))
  ensures (inv(v) ==> canFinishCallback(v, successful) ==> alwaysSnapshotFollowsUnlink(finishCallback(v, successful)))
  ensures (inv(v) ==> canFinishCallback(v, successful) ==> alwaysSignalFollowsClear(finishCallback(v, successful)))
  ensures (inv(v) ==> canFinishCallback(v, successful) ==> stepFirstReasonWins(v, finishCallback(v, successful)))
  ensures (inv(v) ==> canFinishCallback(v, successful) ==> stepSignalNeverReopens(v, finishCallback(v, successful)))
{
  if inv(v) && canFinishCallback(v, successful) {
    var after := finishCallback(v, successful);
    VoiceFilters(v);
    VoiceFilters(after);
    VoiceTop(v);
    VoiceCallsDistinct(v.calls);
    VoiceHandlesDistinct(v.handles);
    VoiceStackDistinct(v.stack);
    assert after.stack == v.stack[..|v.stack| - 1];
    forall i, j | 0 <= i < |after.calls| && 0 <= j < |after.calls| && i != j
      ensures after.calls[i].id != after.calls[j].id
    {}
    assert ProofLib.DistinctBy(after.calls, (callback: VoiceCall) => callback.id);
    VoiceCallsDistinct(after.calls);
    forall i, j | 0 <= i < |after.handles| && 0 <= j < |after.handles| && i != j
      ensures after.handles[i].id != after.handles[j].id
    {}
    assert ProofLib.DistinctBy(after.handles, (handle: VoiceDisposer) => handle.id);
    VoiceHandlesDistinct(after.handles);
    forall i, j | 0 <= i < |after.stack| && 0 <= j < |after.stack| && i != j
      ensures after.stack[i] != after.stack[j]
    {}
    assert ProofLib.DistinctBy(after.stack, (callId: int) => callId);
    VoiceStackDistinct(after.stack);
    forall callId | callId in after.stack
      ensures exists callback :: callback in after.calls && callback.id == callId && !callback.complete
    {
      var i :| 0 <= i < |after.stack| && after.stack[i] == callId;
      assert 0 <= i < |v.stack| - 1;
      assert v.stack[i] == callId;
      assert callId in v.stack;
      assert v.stack[i] != v.stack[|v.stack| - 1];
      assert callId != topCall(v).id;
      var callback :| callback in v.calls && callback.id == callId && !callback.complete;
      var j :| 0 <= j < |v.calls| && v.calls[j] == callback;
      assert after.calls[j] == callback;
      assert callback in after.calls;
    }
  }
}
