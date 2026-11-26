lemma EvalFold15<A, T>(f: (A, T) -> A, a0: A, s: seq<T>)
  requires |s| == 15
  ensures Std.Collections.Seq.FoldLeft(f, a0, s) ==
    f(f(f(f(f(f(f(f(f(f(f(f(f(f(f(a0, s[0]), s[1]), s[2]), s[3]), s[4]), s[5]), s[6]), s[7]), s[8]), s[9]), s[10]), s[11]), s[12]), s[13]), s[14])
{
  var a1 := f(a0, s[0]);
  var a2 := f(a1, s[1]);
  var a3 := f(a2, s[2]);
  var a4 := f(a3, s[3]);
  var a5 := f(a4, s[4]);
  var a6 := f(a5, s[5]);
  var a7 := f(a6, s[6]);
  var a8 := f(a7, s[7]);
  var a9 := f(a8, s[8]);
  var a10 := f(a9, s[9]);
  var a11 := f(a10, s[10]);
  var a12 := f(a11, s[11]);
  var a13 := f(a12, s[12]);
  var a14 := f(a13, s[13]);
  var a15 := f(a14, s[14]);
  assert s[1..][1..] == s[2..];
  assert s[2..][1..] == s[3..];
  assert s[3..][1..] == s[4..];
  assert s[4..][1..] == s[5..];
  assert s[5..][1..] == s[6..];
  assert s[6..][1..] == s[7..];
  assert s[7..][1..] == s[8..];
  assert s[8..][1..] == s[9..];
  assert s[9..][1..] == s[10..];
  assert s[10..][1..] == s[11..];
  assert s[11..][1..] == s[12..];
  assert s[12..][1..] == s[13..];
  assert s[13..][1..] == s[14..];
  assert s[14..][1..] == [];
  assert Std.Collections.Seq.FoldLeft(f, a14, s[14..]) == a15;
  assert Std.Collections.Seq.FoldLeft(f, a13, s[13..]) == a15;
  assert Std.Collections.Seq.FoldLeft(f, a12, s[12..]) == a15;
  assert Std.Collections.Seq.FoldLeft(f, a11, s[11..]) == a15;
  assert Std.Collections.Seq.FoldLeft(f, a10, s[10..]) == a15;
  assert Std.Collections.Seq.FoldLeft(f, a9, s[9..]) == a15;
  assert Std.Collections.Seq.FoldLeft(f, a8, s[8..]) == a15;
  assert Std.Collections.Seq.FoldLeft(f, a7, s[7..]) == a15;
  assert Std.Collections.Seq.FoldLeft(f, a6, s[6..]) == a15;
  assert Std.Collections.Seq.FoldLeft(f, a5, s[5..]) == a15;
  assert Std.Collections.Seq.FoldLeft(f, a4, s[4..]) == a15;
  assert Std.Collections.Seq.FoldLeft(f, a3, s[3..]) == a15;
  assert Std.Collections.Seq.FoldLeft(f, a2, s[2..]) == a15;
  assert Std.Collections.Seq.FoldLeft(f, a1, s[1..]) == a15;
}

lemma SignalRankOne(g: Signal)
  ensures signalRank(g) == (match g
    case Charging => 0
    case Battery => 1
    case Thermal => 2
    case Idle => 3
    case Call => 4
    case Media => 5
    case Camera => 6
    case Recording => 7
    case Cast => 8
    case Navigation => 9
    case CriticalTask => 10
    case Comfort => 11
    case Alarm => 12
    case RebootRoute => 13
    case Connectivity => 14)
{
  EvalFold15((n: int, x: Signal) => (if (n >= 100) then n else (if (x == g) then (n + 100) else (n + 1))), 0, gateOrder);
}

lemma SignalRanks()
  ensures signalRank(Signal.Charging) == 0
  ensures signalRank(Signal.Battery) == 1
  ensures signalRank(Signal.Thermal) == 2
  ensures signalRank(Signal.Idle) == 3
  ensures signalRank(Signal.Call) == 4
  ensures signalRank(Signal.Media) == 5
  ensures signalRank(Signal.Camera) == 6
  ensures signalRank(Signal.Recording) == 7
  ensures signalRank(Signal.Cast) == 8
  ensures signalRank(Signal.Navigation) == 9
  ensures signalRank(Signal.CriticalTask) == 10
  ensures signalRank(Signal.Comfort) == 11
  ensures signalRank(Signal.Alarm) == 12
  ensures signalRank(Signal.RebootRoute) == 13
  ensures signalRank(Signal.Connectivity) == 14
{
  SignalRankOne(Signal.Charging);
  SignalRankOne(Signal.Battery);
  SignalRankOne(Signal.Thermal);
  SignalRankOne(Signal.Idle);
  SignalRankOne(Signal.Call);
  SignalRankOne(Signal.Media);
  SignalRankOne(Signal.Camera);
  SignalRankOne(Signal.Recording);
  SignalRankOne(Signal.Cast);
  SignalRankOne(Signal.Navigation);
  SignalRankOne(Signal.CriticalTask);
  SignalRankOne(Signal.Comfort);
  SignalRankOne(Signal.Alarm);
  SignalRankOne(Signal.RebootRoute);
  SignalRankOne(Signal.Connectivity);
}

lemma FoldLeftConcat<A, T>(f: (A, T) -> A, acc: A, a: seq<T>, b: seq<T>)
  ensures Std.Collections.Seq.FoldLeft(f, acc, a + b) == Std.Collections.Seq.FoldLeft(f, Std.Collections.Seq.FoldLeft(f, acc, a), b)
  decreases |a|
{
  if |a| == 0 {
    assert a + b == b;
  } else {
    assert (a + b)[0] == a[0];
    assert (a + b)[1..] == a[1..] + b;
    FoldLeftConcat(f, f(acc, a[0]), a[1..], b);
  }
}

lemma StepRank(f: (int, Blocker) -> int, acc: int, piece: seq<Blocker>, r: int)
  requires forall prev, b :: f(prev, b) == (if prev < blockerRank(b) then blockerRank(b) else 99)
  requires acc < r && r < 99
  requires |piece| == 0 || (|piece| == 1 && blockerRank(piece[0]) == r)
  ensures Std.Collections.Seq.FoldLeft(f, acc, piece) <= r
{
  if |piece| == 1 {
    assert piece[1..] == [];
  }
}

lemma DeviceBlockersFoldBound(f: (int, Blocker) -> int, acc: int, s: Signals, minimumBattery: int)
  requires forall prev, b :: f(prev, b) == (if prev < blockerRank(b) then blockerRank(b) else 99)
  requires acc < 2
  ensures Std.Collections.Seq.FoldLeft(f, acc, deviceBlockers(s, minimumBattery)) <= 12
{
  SignalRanks();
  var p0 := gaugeBlocks((!s.charging.FlagUnknown?), s.charging.FlagSet?, Signal.Charging);
  var p1 := gaugeBlocks(gaugeWithin(s.battery, 0, 100), (gaugeValue(s.battery) >= minimumBattery), Signal.Battery);
  var p2 := gaugeBlocks(gaugeWithin(s.thermal, 0, thermalCeiling), (gaugeValue(s.thermal) <= maxThermal), Signal.Thermal);
  var p3 := gaugeBlocks(((!s.idle.GaugeUnknown?) && (gaugeValue(s.idle) >= 0)), (gaugeValue(s.idle) >= idleMinutes), Signal.Idle);
  var p4 := flagBlocks(s.call, Signal.Call);
  var p5 := flagBlocks(s.media, Signal.Media);
  var p6 := flagBlocks(s.camera, Signal.Camera);
  var p7 := flagBlocks(s.recording, Signal.Recording);
  var p8 := flagBlocks(s.cast, Signal.Cast);
  var p9 := flagBlocks(s.navigation, Signal.Navigation);
  var p10 := flagBlocks(s.criticalTask, Signal.CriticalTask);
  var c1 := p0 + p1;
  var c2 := c1 + p2;
  var c3 := c2 + p3;
  var c4 := c3 + p4;
  var c5 := c4 + p5;
  var c6 := c5 + p6;
  var c7 := c6 + p7;
  var c8 := c7 + p8;
  var c9 := c8 + p9;
  var c10 := c9 + p10;
  assert deviceBlockers(s, minimumBattery) == c10;
  StepRank(f, acc, p0, 2);
  var a0 := Std.Collections.Seq.FoldLeft(f, acc, p0);
  FoldLeftConcat(f, acc, p0, p1);
  StepRank(f, a0, p1, 3);
  var a1 := Std.Collections.Seq.FoldLeft(f, acc, c1);
  FoldLeftConcat(f, acc, c1, p2);
  StepRank(f, a1, p2, 4);
  var a2 := Std.Collections.Seq.FoldLeft(f, acc, c2);
  FoldLeftConcat(f, acc, c2, p3);
  StepRank(f, a2, p3, 5);
  var a3 := Std.Collections.Seq.FoldLeft(f, acc, c3);
  FoldLeftConcat(f, acc, c3, p4);
  StepRank(f, a3, p4, 6);
  var a4 := Std.Collections.Seq.FoldLeft(f, acc, c4);
  FoldLeftConcat(f, acc, c4, p5);
  StepRank(f, a4, p5, 7);
  var a5 := Std.Collections.Seq.FoldLeft(f, acc, c5);
  FoldLeftConcat(f, acc, c5, p6);
  StepRank(f, a5, p6, 8);
  var a6 := Std.Collections.Seq.FoldLeft(f, acc, c6);
  FoldLeftConcat(f, acc, c6, p7);
  StepRank(f, a6, p7, 9);
  var a7 := Std.Collections.Seq.FoldLeft(f, acc, c7);
  FoldLeftConcat(f, acc, c7, p8);
  StepRank(f, a7, p8, 10);
  var a8 := Std.Collections.Seq.FoldLeft(f, acc, c8);
  FoldLeftConcat(f, acc, c8, p9);
  StepRank(f, a8, p9, 11);
  var a9 := Std.Collections.Seq.FoldLeft(f, acc, c9);
  FoldLeftConcat(f, acc, c9, p10);
  StepRank(f, a9, p10, 12);
}

lemma ActivationGateFoldBound(f: (int, Blocker) -> int, acc: int, s: Signals, window: ComfortWindow)
  requires forall prev, b :: f(prev, b) == (if prev < blockerRank(b) then blockerRank(b) else 99)
  requires acc < 2
  ensures Std.Collections.Seq.FoldLeft(f, acc, activationGate(s, window)) <= 13
{
  SignalRanks();
  var dev := deviceBlockers(s, activationMinBattery);
  var c := if window.WindowClosed? then [SignalUnmet(Signal.Comfort)] else [];
  DeviceBlockersFoldBound(f, acc, s, activationMinBattery);
  FoldLeftConcat(f, acc, dev, c);
  var a := Std.Collections.Seq.FoldLeft(f, acc, dev);
  StepRank(f, a, c, 13);
}

lemma RebootGateFoldBound(f: (int, Blocker) -> int, acc: int, s: Signals, qualifiedRoute: bool)
  requires forall prev, b :: f(prev, b) == (if prev < blockerRank(b) then blockerRank(b) else 99)
  requires acc < 2
  ensures Std.Collections.Seq.FoldLeft(f, acc, rebootGate(s, qualifiedRoute)) <= 15
{
  SignalRanks();
  var dev := deviceBlockers(s, rebootMinBattery);
  var al := alarmBlocks(s.nextAlarm);
  var rr := gaugeBlocks(true, qualifiedRoute, Signal.RebootRoute);
  DeviceBlockersFoldBound(f, acc, s, rebootMinBattery);
  FoldLeftConcat(f, acc, dev, al);
  var a := Std.Collections.Seq.FoldLeft(f, acc, dev);
  StepRank(f, a, al, 14);
  var b := Std.Collections.Seq.FoldLeft(f, acc, dev + al);
  FoldLeftConcat(f, acc, dev + al, rr);
  StepRank(f, b, rr, 15);
}

lemma DownloadGateFoldBound(f: (int, Blocker) -> int, acc: int, n: NetworkKind)
  requires forall prev, b :: f(prev, b) == (if prev < blockerRank(b) then blockerRank(b) else 99)
  requires acc < 16
  ensures Std.Collections.Seq.FoldLeft(f, acc, downloadGate(n)) <= 16
{
  SignalRanks();
  StepRank(f, acc, downloadGate(n), 16);
}

lemma lawGatesListBlockersInOrder_ensures(signals: Signals, window: ComfortWindow, qualifiedRoute: bool)
  ensures (lawGatesListBlockersInOrder(signals, window, qualifiedRoute) == true)
{
  var f := (previous: int, b: Blocker) => (if (previous < blockerRank(b)) then blockerRank(b) else 99);
  ActivationGateFoldBound(f, -1, signals, window);
  RebootGateFoldBound(f, -1, signals, qualifiedRoute);
  DownloadGateFoldBound(f, -1, signals.network);
}

lemma NonNegDivMonotone(x: int, y: int)
  requires 0 <= x <= y
  ensures x / dayMinutes <= y / dayMinutes
{
}

lemma FloorDivMonotone(a: int, b: int)
  requires a <= b
  ensures floorDiv(a, dayMinutes) <= floorDiv(b, dayMinutes)
{
  if a >= 0 {
    NonNegDivMonotone(a, b);
  } else if b >= 0 {
    assert -a + dayMinutes - 1 >= dayMinutes;
    assert ((-a) + dayMinutes - 1) / dayMinutes >= 1;
    assert floorDiv(a, dayMinutes) <= -1;
    assert floorDiv(b, dayMinutes) >= 0;
  } else {
    NonNegDivMonotone(-b + dayMinutes - 1, -a + dayMinutes - 1);
  }
}

lemma WindowsEndedNonNeg(since: int, until: int)
  ensures windowsEnded(since, until) >= 0
{
  if until > since {
    FloorDivMonotone(since - windowEnd, until - windowEnd);
  }
}

lemma DecisionBlockersInOrder(known: bool, signedNow: int, signals: Signals, w: ComfortWindow)
  ensures inOrder(((if known then [] else [Blocker.PendingUnknown]) + (if signedNow > 0 then [] else [Blocker.SignedTimeUnavailable])) + activationGate(signals, w))
  ensures inOrder((if signedNow > 0 then [] else [Blocker.SignedTimeUnavailable]) + downloadGate(signals.network))
  ensures inOrder([Blocker.PendingUnknown])
  ensures inOrder([Blocker.ActivationNotEnabled])
  ensures inOrder([])
{
  SignalRanks();
  var f := (previous: int, b: Blocker) => (if (previous < blockerRank(b)) then blockerRank(b) else 99);
  var b0 := if known then [] else [Blocker.PendingUnknown];
  var b1 := if signedNow > 0 then [] else [Blocker.SignedTimeUnavailable];
  var g := activationGate(signals, w);
  StepRank(f, -1, b0, 0);
  var a0 := Std.Collections.Seq.FoldLeft(f, -1, b0);
  FoldLeftConcat(f, -1, b0, b1);
  StepRank(f, a0, b1, 1);
  var a1 := Std.Collections.Seq.FoldLeft(f, -1, b0 + b1);
  FoldLeftConcat(f, -1, b0 + b1, g);
  ActivationGateFoldBound(f, a1, signals, w);
  StepRank(f, -1, b1, 1);
  var d1 := Std.Collections.Seq.FoldLeft(f, -1, b1);
  FoldLeftConcat(f, -1, b1, downloadGate(signals.network));
  DownloadGateFoldBound(f, d1, signals.network);
  StepRank(f, -1, [Blocker.PendingUnknown], 0);
  StepRank(f, -1, [Blocker.ActivationNotEnabled], 17);
}

lemma runJob_ensures(l: Ledger, job: Job, signedLower: int, wall: int, signals: Signals, found: DiscoveryResult, pending: PendingReading, activated: ActivationResult, jitter: int, ending: RunEnd)
  ensures (inv(l) ==> canRunJob(l, wall, jitter) ==> alwaysMissedWindowsBelongToAPendingPlan(runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).state))
  ensures (inv(l) ==> canRunJob(l, wall, jitter) ==> alwaysAgesAreSignedTime(runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).state))
  ensures (inv(l) ==> canRunJob(l, wall, jitter) ==> alwaysAlertNamesItsReasons(runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).state))
  ensures (inv(l) ==> canRunJob(l, wall, jitter) ==> stepDiscoveryEverySixHours(l, runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).state, runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).out))
  ensures (inv(l) ==> canRunJob(l, wall, jitter) ==> stepChecksNeedSignedTime(l, runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).state, runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).out))
  ensures (inv(l) ==> canRunJob(l, wall, jitter) ==> stepDownloadsOnlyWhenAllowed(l, runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).state, runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).out))
  ensures (inv(l) ==> canRunJob(l, wall, jitter) ==> stepDecisionsListBlockersInOrder(l, runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).state, runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).out))
  ensures (inv(l) ==> canRunJob(l, wall, jitter) ==> stepMissedWindowsNeverUncount(l, runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).state))
  ensures (inv(l) ==> canRunJob(l, wall, jitter) ==> stepActivatesOnlyWhenEveryGateHolds(l, runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).state, runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).out))
  ensures (inv(l) ==> canRunJob(l, wall, jitter) ==> stepUnsavedRunKeepsTheLedgerAndAlerts(l, runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).state, runJob(l, job, signedLower, wall, signals, found, pending, activated, jitter, ending).out))
{
  if inv(l) && canRunJob(l, wall, jitter) {
    var signedNow := if signedLower > 0 then signedLower else 0;
    var cancelled := ending.Cancelled?;
    var l0 := signedSeen(signedNow, l);
    var p1 := if job.DiscoveryJob? then discoveryPart(signedNow, found, jitter, cancelled, l0) else (if job.DownloadJob? then downloadPart(signedNow, signals.network, found, cancelled, l0) else partsOf(Outcome.NoPendingActivation, l0));
    var l1 := pendingSeen(pending, signedNow, wall, p1.ledger);
    WindowsEndedNonNeg(larger(l1.pendingSinceWall, l1.windowsThroughWall), wall);
    var l2 := windowsCounted(wall, l1);
    var w := comfortWindow(wall, l2.missedWindows);
    DecisionBlockersInOrder(pendingKnown(pending), signedNow, signals, w);
  }
}
