lemma DeviceIdsDistinct(xs: seq<Device>)
  ensures (forall d :: d in xs ==> |ProofLib.Filter((o: Device) => (o.id == d.id), xs)| == 1) <==> (forall i, j :: 0 <= i < |xs| && 0 <= j < |xs| && i != j ==> xs[i].id != xs[j].id)
{
  forall i | 0 <= i < |xs|
    ensures |ProofLib.Filter((o: Device) => (o.id == xs[i].id), xs)| == 1 <==> forall j :: 0 <= j < |xs| && j != i ==> xs[j].id != xs[i].id
  {
    ProofLib.FilterCountOneIffUnique((o: Device) => (o.id == xs[i].id), xs, (o: Device) => o.id, i);
  }
  if forall i, j :: 0 <= i < |xs| && 0 <= j < |xs| && i != j ==> xs[i].id != xs[j].id {
    forall d | d in xs
      ensures |ProofLib.Filter((o: Device) => (o.id == d.id), xs)| == 1
    {
      var i :| 0 <= i < |xs| && xs[i] == d;
    }
  } else {
    var i, j :| 0 <= i < |xs| && 0 <= j < |xs| && i != j && xs[i].id == xs[j].id;
    assert xs[i] in xs;
  }
}

lemma DeviceIdsKept(s: StateMigration, after: StateMigration)
  requires alwaysDeviceIdsUnique(s)
  requires |after.devices| == |s.devices| && forall i :: 0 <= i < |s.devices| ==> after.devices[i].id == s.devices[i].id
  ensures alwaysDeviceIdsUnique(after)
  ensures forall i, j :: 0 <= i < |s.devices| && 0 <= j < |s.devices| && i != j ==> s.devices[i].id != s.devices[j].id
{
  DeviceIdsDistinct(s.devices);
  DeviceIdsDistinct(after.devices);
}

lemma deviceStartsV4_ensures(s: StateMigration, device: int)
  ensures (inv(s) ==> canDeviceStartsV4(s, device) ==> alwaysColumnsMatchTheService(deviceStartsV4(s, device)))
  ensures (inv(s) ==> canDeviceStartsV4(s, device) ==> alwaysAcceptedTokensMatchTheirPhase(deviceStartsV4(s, device)))
  ensures (inv(s) ==> canDeviceStartsV4(s, device) ==> alwaysV4DeviceHoldsNoLegacyState(deviceStartsV4(s, device)))
  ensures (inv(s) ==> canDeviceStartsV4(s, device) ==> alwaysAuthSessionNeedsTheCutover(deviceStartsV4(s, device)))
  ensures (inv(s) ==> canDeviceStartsV4(s, device) ==> alwaysDeviceIdsUnique(deviceStartsV4(s, device)))
  ensures (inv(s) ==> canDeviceStartsV4(s, device) ==> alwaysV3NamesFindNothingInV4(deviceStartsV4(s, device)))
  ensures (inv(s) ==> canDeviceStartsV4(s, device) ==> stepMappingsNeverChange(s, deviceStartsV4(s, device)))
{
  if inv(s) && canDeviceStartsV4(s, device) {
    DeviceIdsKept(s, deviceStartsV4(s, device));
  }
}

lemma deviceSignsIn_ensures(s: StateMigration, device: int)
  ensures (inv(s) ==> canDeviceSignsIn(s, device) ==> alwaysColumnsMatchTheService(deviceSignsIn(s, device)))
  ensures (inv(s) ==> canDeviceSignsIn(s, device) ==> alwaysAcceptedTokensMatchTheirPhase(deviceSignsIn(s, device)))
  ensures (inv(s) ==> canDeviceSignsIn(s, device) ==> alwaysV4DeviceHoldsNoLegacyState(deviceSignsIn(s, device)))
  ensures (inv(s) ==> canDeviceSignsIn(s, device) ==> alwaysAuthSessionNeedsTheCutover(deviceSignsIn(s, device)))
  ensures (inv(s) ==> canDeviceSignsIn(s, device) ==> alwaysDeviceIdsUnique(deviceSignsIn(s, device)))
  ensures (inv(s) ==> canDeviceSignsIn(s, device) ==> alwaysV3NamesFindNothingInV4(deviceSignsIn(s, device)))
  ensures (inv(s) ==> canDeviceSignsIn(s, device) ==> stepMappingsNeverChange(s, deviceSignsIn(s, device)))
{
  if inv(s) && canDeviceSignsIn(s, device) {
    var after := deviceSignsIn(s, device);
    DeviceIdsKept(s, after);
    var signed :| signed in s.devices && signed.id == device && signed.version == 4;
    var k :| 0 <= k < |s.devices| && s.devices[k] == signed;
    forall i | 0 <= i < |after.devices| && after.devices[i].session.AuthSession?
      ensures after.devices[i].version == 4 && after.server.ServingV4?
    {
      if s.devices[i].id != device {
        assert s.devices[i] in s.devices;
      }
    }
  }
}

lemma initialHolds_ensures()
  ensures inv(initialHolds())
{
  DeviceIdsDistinct(initialHolds().devices);
}
