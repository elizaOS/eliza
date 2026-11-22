lemma lawThirdUncleanExitWithinTheWindowTrips_ensures(now: int)
  ensures (lawThirdUncleanExitWithinTheWindowTrips(now) == true)
{
  ProofLib.FilterNil((t: int) => ((t <= now) && ((now - t) < crashWindowMs)), []);
  ProofLib.FilterAppend((t: int) => ((t <= now) && ((now - t) < crashWindowMs)), [], now);
  ProofLib.FilterAppend((t: int) => ((t <= now) && ((now - t) < crashWindowMs)), [now], now);
  assert exitsAfter([], true, now) == [now];
  assert exitsAfter([now], true, now) == [now, now];
  assert exitsAfter([now, now], true, now) == [now, now, now];
}

lemma lawOldAndFutureExitsNoLongerCount_ensures(now: int)
  ensures (lawOldAndFutureExitsNoLongerCount(now) == true)
{
  var exits := [now - crashWindowMs, now + 1];
  var inWindow := (t: int) => ((t <= now) && ((now - t) < crashWindowMs));
  assert forall i :: 0 <= i < |exits| ==> !inWindow(exits[i]);
  ProofLib.FilterNone(inWindow, exits);
  assert ProofLib.Filter(inWindow, exits) == [];
  assert exitsAfter(exits, false, now) == ProofLib.Filter(inWindow, exits);
}

lemma CaptureThenCrash(now: int, s: ListenerService)
  requires s.device == readyDevice && s.lease == os__voice__indicatorLease_initial
  requires !s.processConsent && !s.tripped && !s.capturing && s.delivered == s.queued
  requires s.enabled || s.recentExits == []
  ensures capturingCrash(now, s).admitted
  ensures capturingCrash(now, s).after.enabled && !capturingCrash(now, s).after.processConsent
  ensures !capturingCrash(now, s).after.capturing
  ensures capturingCrash(now, s).after.device == readyDevice
  ensures capturingCrash(now, s).after.lease == os__voice__indicatorLease_initial
  ensures capturingCrash(now, s).after.delivered == capturingCrash(now, s).after.queued
  ensures capturingCrash(now, s).after.recentExits == exitsAfter(s.recentExits, true, now)
  ensures capturingCrash(now, s).after.tripped == (|capturingCrash(now, s).after.recentExits| >= crashLimit)
  ensures capturingCrash(now, s).after.tripped ==> decide(capturingCrash(now, s).after).StoppedAfterErrors?
{
  var consent := turnOn(s, Caller.Owner, admittedGrant);
  assert canTurnOn(s, Caller.Owner, admittedGrant) && consent.recentExits == s.recentExits;
  assert !consent.indicatorLost && !consent.capturing;
  var acquired := acquireLease(consent, Caller.SystemUiLease, os__voice__indicatorLease_admittedListener, true);
  assert canAcquireLease(consent, Caller.SystemUiLease, os__voice__indicatorLease_admittedListener);
  assert canRenewLease(acquired, Caller.SystemUiLease, os__voice__indicatorLease_admittedListener);
  var visible := renewLease(acquired, Caller.SystemUiLease, os__voice__indicatorLease_admittedListener, os__voice__indicatorLease_visibleRecording, true);
  assert decide(visible).Listening? && canRequestStart(visible);
  var requested := requestStart(visible);
  assert canDeliverStart(requested);
  var live := deliverStart(requested, false).state;
  assert live.capturing && live.device.recordAudio && live.recentExits == s.recentExits;
  assert live.queued == live.delivered;
  var ended := restartProcess(live, ProcessEnd.Crash, now);
  assert decide(ended) == (if ended.tripped then ListenerState.StoppedAfterErrors else ListenerState.Off);
  assert capturingCrash(now, s) == CrashCycle(true, ended);
}

lemma lawThreeCapturingCrashesReachTheStop_ensures(now: int)
  ensures (lawThreeCapturingCrashesReachTheStop(now) == true)
{
  var firstDevice := observeDevice(initial, readyDevice);
  CaptureThenCrash(now, firstDevice);
  ProofLib.FilterNil((t: int) => ((t <= now) && ((now - t) < crashWindowMs)), []);
  var first := capturingCrash(now, firstDevice);
  assert first.after.recentExits == [now] && !first.after.tripped;

  var next := now + 1000;
  CaptureThenCrash(next, first.after);
  ProofLib.FilterNil((t: int) => ((t <= next) && ((next - t) < crashWindowMs)), []);
  ProofLib.FilterAppend((t: int) => ((t <= next) && ((next - t) < crashWindowMs)), [], now);
  var second := capturingCrash(next, first.after);
  assert second.after.recentExits == [now, next] && !second.after.tripped;

  CaptureThenCrash(next, second.after);
  ProofLib.FilterAppend((t: int) => ((t <= next) && ((next - t) < crashWindowMs)), [now], next);
  var third := capturingCrash(next, second.after);
  assert third.after.recentExits == [now, next, next] && third.after.tripped;
}
