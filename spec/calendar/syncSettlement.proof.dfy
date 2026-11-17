lemma AddOne(xs: seq<int>, v: int)
  ensures forall x :: x in xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [v]) <==> x in xs || x == v
{
  forall x
    ensures x in xs + ProofLib.Filter((set_x: int) => !((set_x in xs)), [v]) <==> x in xs || x == v
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in xs)), [v], x);
  }
}

lemma DropOne(xs: seq<int>, v: int)
  ensures forall x :: x in ProofLib.Filter((set_x: int) => !((set_x in [v])), xs) <==> x in xs && x != v
{
  forall x
    ensures x in ProofLib.Filter((set_x: int) => !((set_x in [v])), xs) <==> x in xs && x != v
  {
    ProofLib.FilterMember((set_x: int) => !((set_x in [v])), xs, x);
  }
}

lemma WatchFilters(s: SyncSettlement, attempt: int)
  ensures claimAttempt(s).watch.claimed == s.watch.claimed + ProofLib.Filter((set_x: int) => !((set_x in s.watch.claimed)), [s.watch.nextAttempt])
  ensures claimAttempt(s).watch.inFlight == s.watch.inFlight + ProofLib.Filter((set_x: int) => !((set_x in s.watch.inFlight)), [s.watch.nextAttempt])
  ensures failAttempt(s, attempt).watch.inFlight == ProofLib.Filter((set_x: int) => !((set_x in [attempt])), s.watch.inFlight)
  ensures settleAttempt(s, attempt).watch.inFlight == ProofLib.Filter((set_x: int) => !((set_x in [attempt])), s.watch.inFlight)
  ensures failAttempt(s, attempt).watch.recorded == (if ((s.watch.lease == attempt) && s.watch.channel.ChannelActive?) then s.watch.recorded + ProofLib.Filter((set_x: int) => !((set_x in s.watch.recorded)), [attempt]) else s.watch.recorded)
  ensures failAttempt(s, attempt).watch.ignored == (if ((s.watch.lease == attempt) && s.watch.channel.ChannelActive?) then s.watch.ignored else s.watch.ignored + ProofLib.Filter((set_x: int) => !((set_x in s.watch.ignored)), [attempt]))
  ensures settleAttempt(s, attempt).watch.recorded == (if (s.watch.lease == attempt) then s.watch.recorded + ProofLib.Filter((set_x: int) => !((set_x in s.watch.recorded)), [attempt]) else s.watch.recorded)
  ensures settleAttempt(s, attempt).watch.ignored == (if (s.watch.lease == attempt) then s.watch.ignored else s.watch.ignored + ProofLib.Filter((set_x: int) => !((set_x in s.watch.ignored)), [attempt]))
{
}

lemma WatchMembers(s: SyncSettlement, attempt: int)
  ensures forall x :: x in s.watch.claimed + ProofLib.Filter((set_x: int) => !((set_x in s.watch.claimed)), [s.watch.nextAttempt]) <==> x in s.watch.claimed || x == s.watch.nextAttempt
  ensures forall x :: x in s.watch.inFlight + ProofLib.Filter((set_x: int) => !((set_x in s.watch.inFlight)), [s.watch.nextAttempt]) <==> x in s.watch.inFlight || x == s.watch.nextAttempt
  ensures forall x :: x in ProofLib.Filter((set_x: int) => !((set_x in [attempt])), s.watch.inFlight) <==> x in s.watch.inFlight && x != attempt
  ensures forall x :: x in s.watch.recorded + ProofLib.Filter((set_x: int) => !((set_x in s.watch.recorded)), [attempt]) <==> x in s.watch.recorded || x == attempt
  ensures forall x :: x in s.watch.ignored + ProofLib.Filter((set_x: int) => !((set_x in s.watch.ignored)), [attempt]) <==> x in s.watch.ignored || x == attempt
{
  WatchFilters(s, attempt);
  AddOne(s.watch.claimed, s.watch.nextAttempt);
  AddOne(s.watch.inFlight, s.watch.nextAttempt);
  DropOne(s.watch.inFlight, attempt);
  AddOne(s.watch.recorded, attempt);
  AddOne(s.watch.ignored, attempt);
}

lemma ForegroundFilters(s: SyncSettlement, g: int, result: OptInResult)
  ensures readOptIn(s).foreground.pending == s.foreground.pending + ProofLib.Filter((set_x: int) => !((set_x in s.foreground.pending)), [s.foreground.generation])
  ensures readOptIn(s).foreground.issued == s.foreground.issued + ProofLib.Filter((set_x: int) => !((set_x in s.foreground.issued)), [s.foreground.generation])
  ensures returnOptIn(s, g, result).foreground.pending == ProofLib.Filter((set_x: int) => !((set_x in [g])), s.foreground.pending)
  ensures returnOptIn(s, g, result).foreground.admitted == (if ((foregroundCurrent(s.foreground, g) && result.OptInEnabled?) && (s.foreground.running == 0)) then s.foreground.admitted + ProofLib.Filter((set_x: int) => !((set_x in s.foreground.admitted)), [g]) else s.foreground.admitted)
  ensures returnOptIn(s, g, result).foreground.refused == (if ((foregroundCurrent(s.foreground, g) && result.OptInEnabled?) && (s.foreground.running == 0)) then s.foreground.refused else s.foreground.refused + ProofLib.Filter((set_x: int) => !((set_x in s.foreground.refused)), [g]))
  ensures retired(s.foreground) == (if (s.foreground.running == 0) then s.foreground.cancelled else (s.foreground.cancelled + ProofLib.Filter((set_x: int) => !((set_x in s.foreground.cancelled)), [s.foreground.running])))
{
}

lemma ForegroundMembers(s: SyncSettlement, g: int, result: OptInResult)
  ensures forall x :: x in readOptIn(s).foreground.pending <==> x in s.foreground.pending || x == s.foreground.generation
  ensures forall x :: x in readOptIn(s).foreground.issued <==> x in s.foreground.issued || x == s.foreground.generation
  ensures forall x :: x in returnOptIn(s, g, result).foreground.pending <==> x in s.foreground.pending && x != g
  ensures forall x :: x in returnOptIn(s, g, result).foreground.admitted <==> x in s.foreground.admitted || (x == g && foregroundCurrent(s.foreground, g) && result.OptInEnabled? && s.foreground.running == 0)
  ensures forall x :: x in returnOptIn(s, g, result).foreground.refused <==> x in s.foreground.refused || (x == g && !(foregroundCurrent(s.foreground, g) && result.OptInEnabled? && s.foreground.running == 0))
  ensures s.foreground.running in retired(s.foreground) || s.foreground.running == 0
{
  ForegroundFilters(s, g, result);
  AddOne(s.foreground.pending, s.foreground.generation);
  AddOne(s.foreground.issued, s.foreground.generation);
  DropOne(s.foreground.pending, g);
  AddOne(s.foreground.admitted, g);
  AddOne(s.foreground.refused, g);
  AddOne(s.foreground.cancelled, s.foreground.running);
}

lemma claimAttempt_ensures(s: SyncSettlement)
  ensures (inv(s) ==> canClaimAttempt(s) ==> alwaysExactAttemptAccounting(claimAttempt(s)))
  ensures (inv(s) ==> canClaimAttempt(s) ==> alwaysAttemptsNumberedBelowTheNext(claimAttempt(s)))
  ensures (inv(s) ==> canClaimAttempt(s) ==> alwaysStoppedClearsPending(claimAttempt(s)))
  ensures (inv(s) ==> canClaimAttempt(s) ==> alwaysErrorRequiresLeasedFailure(claimAttempt(s)))
  ensures (inv(s) ==> canClaimAttempt(s) ==> alwaysReadHasOneOutcome(claimAttempt(s)))
  ensures (inv(s) ==> canClaimAttempt(s) ==> alwaysRetiredRunningPassIsCancelled(claimAttempt(s)))
  ensures (inv(s) ==> canClaimAttempt(s) ==> stepSupersededFailurePreservesChannel(s, "claimAttempt", claimAttempt(s)))
  ensures (inv(s) ==> canClaimAttempt(s) ==> stepSupersededSuccessPreservesChannel(s, "claimAttempt", claimAttempt(s)))
  ensures (inv(s) ==> canClaimAttempt(s) ==> stepStaleReadChangesNothingVisible(s, "claimAttempt", claimAttempt(s)))
{
  if inv(s) && canClaimAttempt(s) {
    WatchFilters(s, 0);
    WatchMembers(s, 0);
  }
}

lemma failAttempt_ensures(s: SyncSettlement, attempt: int)
  ensures (inv(s) ==> canFailAttempt(s, attempt) ==> alwaysExactAttemptAccounting(failAttempt(s, attempt)))
  ensures (inv(s) ==> canFailAttempt(s, attempt) ==> alwaysAttemptsNumberedBelowTheNext(failAttempt(s, attempt)))
  ensures (inv(s) ==> canFailAttempt(s, attempt) ==> alwaysStoppedClearsPending(failAttempt(s, attempt)))
  ensures (inv(s) ==> canFailAttempt(s, attempt) ==> alwaysErrorRequiresLeasedFailure(failAttempt(s, attempt)))
  ensures (inv(s) ==> canFailAttempt(s, attempt) ==> alwaysReadHasOneOutcome(failAttempt(s, attempt)))
  ensures (inv(s) ==> canFailAttempt(s, attempt) ==> alwaysRetiredRunningPassIsCancelled(failAttempt(s, attempt)))
  ensures (inv(s) ==> canFailAttempt(s, attempt) ==> stepSupersededFailurePreservesChannel(s, "failAttempt", failAttempt(s, attempt)))
  ensures (inv(s) ==> canFailAttempt(s, attempt) ==> stepSupersededSuccessPreservesChannel(s, "failAttempt", failAttempt(s, attempt)))
  ensures (inv(s) ==> canFailAttempt(s, attempt) ==> stepStaleReadChangesNothingVisible(s, "failAttempt", failAttempt(s, attempt)))
{
  if inv(s) && canFailAttempt(s, attempt) {
    WatchFilters(s, attempt);
    WatchMembers(s, attempt);
    if (s.watch.lease == attempt) && s.watch.channel.ChannelActive? {
      assert attempt in failAttempt(s, attempt).watch.recorded;
    }
  }
}

lemma settleAttempt_ensures(s: SyncSettlement, attempt: int)
  ensures (inv(s) ==> canSettleAttempt(s, attempt) ==> alwaysExactAttemptAccounting(settleAttempt(s, attempt)))
  ensures (inv(s) ==> canSettleAttempt(s, attempt) ==> alwaysAttemptsNumberedBelowTheNext(settleAttempt(s, attempt)))
  ensures (inv(s) ==> canSettleAttempt(s, attempt) ==> alwaysStoppedClearsPending(settleAttempt(s, attempt)))
  ensures (inv(s) ==> canSettleAttempt(s, attempt) ==> alwaysErrorRequiresLeasedFailure(settleAttempt(s, attempt)))
  ensures (inv(s) ==> canSettleAttempt(s, attempt) ==> alwaysReadHasOneOutcome(settleAttempt(s, attempt)))
  ensures (inv(s) ==> canSettleAttempt(s, attempt) ==> alwaysRetiredRunningPassIsCancelled(settleAttempt(s, attempt)))
  ensures (inv(s) ==> canSettleAttempt(s, attempt) ==> stepSupersededFailurePreservesChannel(s, "settleAttempt", settleAttempt(s, attempt)))
  ensures (inv(s) ==> canSettleAttempt(s, attempt) ==> stepSupersededSuccessPreservesChannel(s, "settleAttempt", settleAttempt(s, attempt)))
  ensures (inv(s) ==> canSettleAttempt(s, attempt) ==> stepStaleReadChangesNothingVisible(s, "settleAttempt", settleAttempt(s, attempt)))
{
  if inv(s) && canSettleAttempt(s, attempt) {
    WatchFilters(s, attempt);
    WatchMembers(s, attempt);
  }
}

lemma readOptIn_ensures(s: SyncSettlement)
  ensures (inv(s) ==> canReadOptIn(s) ==> alwaysExactAttemptAccounting(readOptIn(s)))
  ensures (inv(s) ==> canReadOptIn(s) ==> alwaysAttemptsNumberedBelowTheNext(readOptIn(s)))
  ensures (inv(s) ==> canReadOptIn(s) ==> alwaysStoppedClearsPending(readOptIn(s)))
  ensures (inv(s) ==> canReadOptIn(s) ==> alwaysErrorRequiresLeasedFailure(readOptIn(s)))
  ensures (inv(s) ==> canReadOptIn(s) ==> alwaysReadHasOneOutcome(readOptIn(s)))
  ensures (inv(s) ==> canReadOptIn(s) ==> alwaysRetiredRunningPassIsCancelled(readOptIn(s)))
  ensures (inv(s) ==> canReadOptIn(s) ==> stepSupersededFailurePreservesChannel(s, "readOptIn", readOptIn(s)))
  ensures (inv(s) ==> canReadOptIn(s) ==> stepSupersededSuccessPreservesChannel(s, "readOptIn", readOptIn(s)))
  ensures (inv(s) ==> canReadOptIn(s) ==> stepStaleReadChangesNothingVisible(s, "readOptIn", readOptIn(s)))
{
  if inv(s) && canReadOptIn(s) {
    ForegroundMembers(s, 0, OptInResult.OptInEnabled);
  }
}

lemma returnOptIn_ensures(s: SyncSettlement, g: int, result: OptInResult)
  ensures (inv(s) ==> canReturnOptIn(s, g, result) ==> alwaysExactAttemptAccounting(returnOptIn(s, g, result)))
  ensures (inv(s) ==> canReturnOptIn(s, g, result) ==> alwaysAttemptsNumberedBelowTheNext(returnOptIn(s, g, result)))
  ensures (inv(s) ==> canReturnOptIn(s, g, result) ==> alwaysStoppedClearsPending(returnOptIn(s, g, result)))
  ensures (inv(s) ==> canReturnOptIn(s, g, result) ==> alwaysErrorRequiresLeasedFailure(returnOptIn(s, g, result)))
  ensures (inv(s) ==> canReturnOptIn(s, g, result) ==> alwaysReadHasOneOutcome(returnOptIn(s, g, result)))
  ensures (inv(s) ==> canReturnOptIn(s, g, result) ==> alwaysRetiredRunningPassIsCancelled(returnOptIn(s, g, result)))
  ensures (inv(s) ==> canReturnOptIn(s, g, result) ==> stepSupersededFailurePreservesChannel(s, "returnOptIn", returnOptIn(s, g, result)))
  ensures (inv(s) ==> canReturnOptIn(s, g, result) ==> stepSupersededSuccessPreservesChannel(s, "returnOptIn", returnOptIn(s, g, result)))
  ensures (inv(s) ==> canReturnOptIn(s, g, result) ==> stepStaleReadChangesNothingVisible(s, "returnOptIn", returnOptIn(s, g, result)))
{
  if inv(s) && canReturnOptIn(s, g, result) {
    ForegroundMembers(s, g, result);
  }
}

lemma stopForeground_ensures(s: SyncSettlement)
  ensures (inv(s) ==> canStopForeground(s) ==> alwaysExactAttemptAccounting(stopForeground(s)))
  ensures (inv(s) ==> canStopForeground(s) ==> alwaysAttemptsNumberedBelowTheNext(stopForeground(s)))
  ensures (inv(s) ==> canStopForeground(s) ==> alwaysStoppedClearsPending(stopForeground(s)))
  ensures (inv(s) ==> canStopForeground(s) ==> alwaysErrorRequiresLeasedFailure(stopForeground(s)))
  ensures (inv(s) ==> canStopForeground(s) ==> alwaysReadHasOneOutcome(stopForeground(s)))
  ensures (inv(s) ==> canStopForeground(s) ==> alwaysRetiredRunningPassIsCancelled(stopForeground(s)))
  ensures (inv(s) ==> canStopForeground(s) ==> stepSupersededFailurePreservesChannel(s, "stopForeground", stopForeground(s)))
  ensures (inv(s) ==> canStopForeground(s) ==> stepSupersededSuccessPreservesChannel(s, "stopForeground", stopForeground(s)))
  ensures (inv(s) ==> canStopForeground(s) ==> stepStaleReadChangesNothingVisible(s, "stopForeground", stopForeground(s)))
{
  ForegroundMembers(s, 0, OptInResult.OptInEnabled);
}

lemma hideForeground_ensures(s: SyncSettlement)
  ensures (inv(s) ==> canHideForeground(s) ==> alwaysExactAttemptAccounting(hideForeground(s)))
  ensures (inv(s) ==> canHideForeground(s) ==> alwaysAttemptsNumberedBelowTheNext(hideForeground(s)))
  ensures (inv(s) ==> canHideForeground(s) ==> alwaysStoppedClearsPending(hideForeground(s)))
  ensures (inv(s) ==> canHideForeground(s) ==> alwaysErrorRequiresLeasedFailure(hideForeground(s)))
  ensures (inv(s) ==> canHideForeground(s) ==> alwaysReadHasOneOutcome(hideForeground(s)))
  ensures (inv(s) ==> canHideForeground(s) ==> alwaysRetiredRunningPassIsCancelled(hideForeground(s)))
  ensures (inv(s) ==> canHideForeground(s) ==> stepSupersededFailurePreservesChannel(s, "hideForeground", hideForeground(s)))
  ensures (inv(s) ==> canHideForeground(s) ==> stepSupersededSuccessPreservesChannel(s, "hideForeground", hideForeground(s)))
  ensures (inv(s) ==> canHideForeground(s) ==> stepStaleReadChangesNothingVisible(s, "hideForeground", hideForeground(s)))
{
  ForegroundMembers(s, 0, OptInResult.OptInEnabled);
}
