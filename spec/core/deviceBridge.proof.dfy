lemma BridgeFilters(s: DeviceBridge, deviceId: string)
  ensures alwaysDeviceIdentitiesUnique(s) == !((exists d :: d in s.devices && !(((d.id != "") && (|ProofLib.Filter((other: BridgeDevice) => (other.id == d.id), s.devices)| == 1)))))
  ensures alwaysCallIdentitiesUnique(s) == !((exists c :: c in s.calls && !(((c.id > 0) && (|ProofLib.Filter((other: BridgeCall) => (other.id == c.id), s.calls)| == 1)))))
  ensures disconnectDevice(s, deviceId).devices == ProofLib.Filter((d: BridgeDevice) => (d.id != deviceId), s.devices)
{
}

lemma SameCallIds(xs: seq<BridgeCall>, ys: seq<BridgeCall>)
  requires |xs| == |ys| && forall i :: 0 <= i < |xs| ==> xs[i].id == ys[i].id
  requires !((exists c :: c in xs && !(((c.id > 0) && (|ProofLib.Filter((other: BridgeCall) => (other.id == c.id), xs)| == 1)))))
  ensures !((exists c :: c in ys && !(((c.id > 0) && (|ProofLib.Filter((other: BridgeCall) => (other.id == c.id), ys)| == 1)))))
{
  forall c | c in ys
    ensures c.id > 0 && |ProofLib.Filter((other: BridgeCall) => (other.id == c.id), ys)| == 1
  {
    var k :| 0 <= k < |ys| && ys[k] == c;
    var b := xs[k];
    assert b in xs;
    ProofLib.FilterLengthPointwise((other: BridgeCall) => (other.id == b.id), (other: BridgeCall) => (other.id == c.id), xs, ys);
  }
}

lemma OneCallPerId(calls: seq<BridgeCall>, b: BridgeCall, c: BridgeCall)
  requires b in calls && c in calls && b.id == c.id
  requires |ProofLib.Filter((other: BridgeCall) => (other.id == c.id), calls)| == 1
  ensures b == c
{
  var i :| 0 <= i < |calls| && calls[i] == b;
  var j :| 0 <= j < |calls| && calls[j] == c;
  if i != j {
    ProofLib.FilterTwo((other: BridgeCall) => (other.id == c.id), calls, i, j);
  }
}

lemma EarliestKept(first: string, xs: seq<BridgeDevice>)
  requires first != ""
  ensures Std.Collections.Seq.FoldLeft((first: string, d: BridgeDevice) => (if (first == "") then d.id else first), first, xs) == first
  decreases |xs|
{
  if |xs| > 0 {
    EarliestKept(first, xs[1..]);
  }
}

lemma EarliestIsFirst(xs: seq<BridgeDevice>)
  requires forall d :: d in xs ==> d.id != ""
  ensures earliestDevice(xs) == (if |xs| == 0 then "" else xs[0].id)
{
  if |xs| > 0 {
    EarliestKept(xs[0].id, xs[1..]);
  }
}

lemma connectDevice_ensures(s: DeviceBridge, device: BridgeDevice)
  ensures (inv(s) ==> canConnectDevice(s, device) ==> alwaysPendingCallsTargetADeclaredCapability(connectDevice(s, device)))
  ensures (inv(s) ==> canConnectDevice(s, device) ==> alwaysDeviceIdentitiesUnique(connectDevice(s, device)))
  ensures (inv(s) ==> canConnectDevice(s, device) ==> alwaysCallIdentitiesUnique(connectDevice(s, device)))
  ensures (inv(s) ==> canConnectDevice(s, device) ==> alwaysPrimaryIsConnected(connectDevice(s, device)))
  ensures (inv(s) ==> canConnectDevice(s, device) ==> stepDisconnectFailsPendingCalls(s, "connectDevice", connectDevice(s, device)))
  ensures (inv(s) ==> canConnectDevice(s, device) ==> stepPrimaryPassesToEarliestDevice(s, connectDevice(s, device)))
  ensures (inv(s) ==> canConnectDevice(s, device) ==> stepSettledCallKeepsItsOutcome(s, connectDevice(s, device)))
{
  if inv(s) && canConnectDevice(s, device) {
    var after := connectDevice(s, device);
    BridgeFilters(s, "");
    BridgeFilters(after, "");
    forall d | d in after.devices
      ensures d.id != "" && |ProofLib.Filter((other: BridgeDevice) => (other.id == d.id), after.devices)| == 1
    {
      ProofLib.FilterAppend((other: BridgeDevice) => (other.id == d.id), s.devices, device);
      if d == device {
        ProofLib.FilterNone((other: BridgeDevice) => (other.id == d.id), s.devices);
      }
    }
    assert connected(after, device.id);
  }
}

lemma invoke_ensures(s: DeviceBridge, id: int, deviceId: string, capability: string)
  ensures (inv(s) ==> canInvoke(s, id, deviceId, capability) ==> alwaysPendingCallsTargetADeclaredCapability(invoke(s, id, deviceId, capability)))
  ensures (inv(s) ==> canInvoke(s, id, deviceId, capability) ==> alwaysDeviceIdentitiesUnique(invoke(s, id, deviceId, capability)))
  ensures (inv(s) ==> canInvoke(s, id, deviceId, capability) ==> alwaysCallIdentitiesUnique(invoke(s, id, deviceId, capability)))
  ensures (inv(s) ==> canInvoke(s, id, deviceId, capability) ==> alwaysPrimaryIsConnected(invoke(s, id, deviceId, capability)))
  ensures (inv(s) ==> canInvoke(s, id, deviceId, capability) ==> stepDisconnectFailsPendingCalls(s, "invoke", invoke(s, id, deviceId, capability)))
  ensures (inv(s) ==> canInvoke(s, id, deviceId, capability) ==> stepPrimaryPassesToEarliestDevice(s, invoke(s, id, deviceId, capability)))
  ensures (inv(s) ==> canInvoke(s, id, deviceId, capability) ==> stepSettledCallKeepsItsOutcome(s, invoke(s, id, deviceId, capability)))
{
  if inv(s) && canInvoke(s, id, deviceId, capability) {
    var after := invoke(s, id, deviceId, capability);
    var call := BridgeCall(id, deviceId, capability, CallPhase.CallPending);
    BridgeFilters(s, "");
    BridgeFilters(after, "");
    forall c | c in after.calls
      ensures c.id > 0 && |ProofLib.Filter((other: BridgeCall) => (other.id == c.id), after.calls)| == 1
    {
      ProofLib.FilterAppend((other: BridgeCall) => (other.id == c.id), s.calls, call);
      if c == call {
        ProofLib.FilterNone((other: BridgeCall) => (other.id == c.id), s.calls);
      }
    }
    forall b | b in s.calls
      ensures b in after.calls
    {
    }
  }
}

lemma disconnectDevice_ensures(s: DeviceBridge, deviceId: string)
  ensures (inv(s) ==> canDisconnectDevice(s, deviceId) ==> alwaysPendingCallsTargetADeclaredCapability(disconnectDevice(s, deviceId)))
  ensures (inv(s) ==> canDisconnectDevice(s, deviceId) ==> alwaysDeviceIdentitiesUnique(disconnectDevice(s, deviceId)))
  ensures (inv(s) ==> canDisconnectDevice(s, deviceId) ==> alwaysCallIdentitiesUnique(disconnectDevice(s, deviceId)))
  ensures (inv(s) ==> canDisconnectDevice(s, deviceId) ==> alwaysPrimaryIsConnected(disconnectDevice(s, deviceId)))
  ensures (inv(s) ==> canDisconnectDevice(s, deviceId) ==> stepDisconnectFailsPendingCalls(s, "disconnectDevice", disconnectDevice(s, deviceId)))
  ensures (inv(s) ==> canDisconnectDevice(s, deviceId) ==> stepPrimaryPassesToEarliestDevice(s, disconnectDevice(s, deviceId)))
  ensures (inv(s) ==> canDisconnectDevice(s, deviceId) ==> stepSettledCallKeepsItsOutcome(s, disconnectDevice(s, deviceId)))
{
  if inv(s) && canDisconnectDevice(s, deviceId) {
    var after := disconnectDevice(s, deviceId);
    BridgeFilters(s, deviceId);
    BridgeFilters(after, deviceId);
    forall d | d in after.devices
      ensures d in s.devices && d.id != deviceId
    {
      ProofLib.FilterMember((d: BridgeDevice) => (d.id != deviceId), s.devices, d);
    }
    forall d | d in s.devices && d.id != deviceId
      ensures d in after.devices
    {
      ProofLib.FilterMember((d: BridgeDevice) => (d.id != deviceId), s.devices, d);
    }
    forall d | d in after.devices
      ensures d.id != "" && |ProofLib.Filter((other: BridgeDevice) => (other.id == d.id), after.devices)| == 1
    {
      ProofLib.FilterOfFilterShorter((d: BridgeDevice) => (d.id != deviceId), (other: BridgeDevice) => (other.id == d.id), s.devices);
      ProofLib.FilterNone((other: BridgeDevice) => (other.id == d.id), after.devices);
    }
    SameCallIds(s.calls, after.calls);
    forall c | c in after.calls && c.phase.CallPending?
      ensures declares(after, c.device, c.capability)
    {
      var k :| 0 <= k < |after.calls| && after.calls[k] == c;
      assert s.calls[k] in s.calls;
      var d :| d in s.devices && d.id == c.device && c.capability in d.capabilities;
      assert d in after.devices;
    }
    EarliestIsFirst(after.devices);
    if s.primary != deviceId && s.primary != "" {
      var d :| d in s.devices && d.id == s.primary;
      assert d in after.devices;
    }
    if |after.devices| > 0 {
      assert after.devices[0] in after.devices;
    }
    forall b | b in s.calls
      ensures (!b.phase.CallPending? || connected(after, b.device) || (exists a :: a in after.calls && a.id == b.id && a.phase.CallFailed?))
      ensures (!connected(after, b.device) || b in after.calls)
      ensures (b.phase.CallPending? || b in after.calls)
    {
      var k :| 0 <= k < |s.calls| && s.calls[k] == b;
      assert after.calls[k] in after.calls;
      if b.device != deviceId && b.phase.CallPending? {
        var d :| d in s.devices && d.id == b.device && b.capability in d.capabilities;
        assert d in after.devices;
      }
    }
  }
}

lemma completeCall_ensures(s: DeviceBridge, id: int, ok: bool)
  ensures (inv(s) ==> canCompleteCall(s, id, ok) ==> alwaysPendingCallsTargetADeclaredCapability(completeCall(s, id, ok)))
  ensures (inv(s) ==> canCompleteCall(s, id, ok) ==> alwaysDeviceIdentitiesUnique(completeCall(s, id, ok)))
  ensures (inv(s) ==> canCompleteCall(s, id, ok) ==> alwaysCallIdentitiesUnique(completeCall(s, id, ok)))
  ensures (inv(s) ==> canCompleteCall(s, id, ok) ==> alwaysPrimaryIsConnected(completeCall(s, id, ok)))
  ensures (inv(s) ==> canCompleteCall(s, id, ok) ==> stepDisconnectFailsPendingCalls(s, "completeCall", completeCall(s, id, ok)))
  ensures (inv(s) ==> canCompleteCall(s, id, ok) ==> stepPrimaryPassesToEarliestDevice(s, completeCall(s, id, ok)))
  ensures (inv(s) ==> canCompleteCall(s, id, ok) ==> stepSettledCallKeepsItsOutcome(s, completeCall(s, id, ok)))
{
  if inv(s) && canCompleteCall(s, id, ok) {
    var after := completeCall(s, id, ok);
    BridgeFilters(s, "");
    BridgeFilters(after, "");
    SameCallIds(s.calls, after.calls);
    var c :| c in s.calls && c.id == id && c.phase.CallPending?;
    forall b | b in s.calls && !b.phase.CallPending?
      ensures b in after.calls
    {
      var k :| 0 <= k < |s.calls| && s.calls[k] == b;
      if b.id == id {
        OneCallPerId(s.calls, b, c);
      }
      assert after.calls[k] == b;
    }
    forall a | a in after.calls && a.phase.CallPending?
      ensures declares(after, a.device, a.capability)
    {
      var k :| 0 <= k < |after.calls| && after.calls[k] == a;
      assert s.calls[k] in s.calls;
    }
  }
}
