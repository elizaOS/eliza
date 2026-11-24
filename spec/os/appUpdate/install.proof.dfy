// A step that announces only releases, keeps the hold or clears it, and announces a release exactly when it clears a
// hold it had, announces its holds.
lemma InsHolds(j: Journal, via: string, r: JournalStep)
  requires forall e :: e in r.out ==> e.Release?
  requires r.state.hold.Unheld? || r.state.hold == j.hold
  requires r.state.hold.Unheld? && !j.hold.Unheld? ==> |r.out| > 0
  requires |r.out| > 0 ==> r.state.hold.Unheld? && !j.hold.Unheld?
  ensures stepHoldsAreAnnounced(j, via, r.state, r.out)
{
  if |r.out| > 0 {
    assert r.out[0] in r.out && isRelease(r.out[0]);
  }
  assert forall e :: e in r.out ==> !isHold(e);
}

// Adding a value once keeps what the list held, holds the value, and holds nothing else.
lemma InsAdd(q: seq<int>, c: int)
  ensures c in q + Std.Collections.Seq.Filter((set_x: int) => !((set_x in q)), [c])
  ensures forall x :: x in q ==> x in q + Std.Collections.Seq.Filter((set_x: int) => !((set_x in q)), [c])
  ensures forall x :: x in q + Std.Collections.Seq.Filter((set_x: int) => !((set_x in q)), [c]) ==> x in q || x == c
{
  reveal Std.Collections.Seq.Filter();
  assert [c][1..] == [];
}

// A release of a candidate that is not quarantined stays within the budget, and quarantines it when it spends it.
lemma InsRelease(j: Journal)
  requires inv(j) && !j.phase.Idle? && !(j.plan.candidate in j.quarantine)
  ensures alwaysRetryBudget(afterRelease(releaseCount(j), j))
  ensures alwaysQuarantinedPlanNamesItsCandidate(afterRelease(releaseCount(j), j))
{
  InsAdd(j.quarantine, j.plan.candidate);
  assert validPlan(j.plan);
  if j.releasedCandidate == j.plan.candidate {
    assert j.releases < installBudget;
  }
}

lemma dropPlan_ensures(j: Journal, planId: int)
  ensures (inv(j) ==> canDropPlan(j, planId) ==> alwaysPlanOutsideIdle(dropPlan(j, planId).state))
  ensures (inv(j) ==> canDropPlan(j, planId) ==> alwaysAwaitingIsHeld(dropPlan(j, planId).state))
  ensures (inv(j) ==> canDropPlan(j, planId) ==> alwaysHoldOnlyForAnOpenAttempt(dropPlan(j, planId).state))
  ensures (inv(j) ==> canDropPlan(j, planId) ==> alwaysUnknownOutcomeIsNotRecovery(dropPlan(j, planId).state))
  ensures (inv(j) ==> canDropPlan(j, planId) ==> alwaysOpenCandidateIsNotQuarantined(dropPlan(j, planId).state))
  ensures (inv(j) ==> canDropPlan(j, planId) ==> alwaysRetryBudget(dropPlan(j, planId).state))
  ensures (inv(j) ==> canDropPlan(j, planId) ==> alwaysQuarantinedPlanNamesItsCandidate(dropPlan(j, planId).state))
  ensures (inv(j) ==> canDropPlan(j, planId) ==> alwaysRecoveryFollowsQuarantinedCandidate(dropPlan(j, planId).state))
  ensures (inv(j) ==> canDropPlan(j, planId) ==> alwaysRecoveryPhasesMatchTheAttempt(dropPlan(j, planId).state))
  ensures (inv(j) ==> canDropPlan(j, planId) ==> alwaysSupportNamesItsReason(dropPlan(j, planId).state))
  ensures (inv(j) ==> canDropPlan(j, planId) ==> stepHoldsAreAnnounced(j, "dropPlan", dropPlan(j, planId).state, dropPlan(j, planId).out))
  ensures (inv(j) ==> canDropPlan(j, planId) ==> stepRejectionIsDurable(j, dropPlan(j, planId).state))
  ensures (inv(j) ==> canDropPlan(j, planId) ==> stepQuarantineIsPermanent(j, dropPlan(j, planId).state))
  ensures (inv(j) ==> canDropPlan(j, planId) ==> stepGenerationNeverGoesBack(j, dropPlan(j, planId).state))
{
  if inv(j) && canDropPlan(j, planId) {
    InsHolds(j, "dropPlan", dropPlan(j, planId));
  }
}

lemma changeChannel_ensures(j: Journal)
  ensures (inv(j) ==> alwaysPlanOutsideIdle(changeChannel(j).state))
  ensures (inv(j) ==> alwaysAwaitingIsHeld(changeChannel(j).state))
  ensures (inv(j) ==> alwaysHoldOnlyForAnOpenAttempt(changeChannel(j).state))
  ensures (inv(j) ==> alwaysUnknownOutcomeIsNotRecovery(changeChannel(j).state))
  ensures (inv(j) ==> alwaysOpenCandidateIsNotQuarantined(changeChannel(j).state))
  ensures (inv(j) ==> alwaysRetryBudget(changeChannel(j).state))
  ensures (inv(j) ==> alwaysQuarantinedPlanNamesItsCandidate(changeChannel(j).state))
  ensures (inv(j) ==> alwaysRecoveryFollowsQuarantinedCandidate(changeChannel(j).state))
  ensures (inv(j) ==> alwaysRecoveryPhasesMatchTheAttempt(changeChannel(j).state))
  ensures (inv(j) ==> alwaysSupportNamesItsReason(changeChannel(j).state))
  ensures (inv(j) ==> stepHoldsAreAnnounced(j, "changeChannel", changeChannel(j).state, changeChannel(j).out))
  ensures (inv(j) ==> stepRejectionIsDurable(j, changeChannel(j).state))
  ensures (inv(j) ==> stepQuarantineIsPermanent(j, changeChannel(j).state))
  ensures (inv(j) ==> stepGenerationNeverGoesBack(j, changeChannel(j).state))
{
  if inv(j) {
    InsHolds(j, "changeChannel", changeChannel(j));
  }
}

lemma requestHold_ensures(j: Journal)
  ensures (inv(j) ==> canRequestHold(j) ==> alwaysPlanOutsideIdle(requestHold(j).state))
  ensures (inv(j) ==> canRequestHold(j) ==> alwaysAwaitingIsHeld(requestHold(j).state))
  ensures (inv(j) ==> canRequestHold(j) ==> alwaysHoldOnlyForAnOpenAttempt(requestHold(j).state))
  ensures (inv(j) ==> canRequestHold(j) ==> alwaysUnknownOutcomeIsNotRecovery(requestHold(j).state))
  ensures (inv(j) ==> canRequestHold(j) ==> alwaysOpenCandidateIsNotQuarantined(requestHold(j).state))
  ensures (inv(j) ==> canRequestHold(j) ==> alwaysRetryBudget(requestHold(j).state))
  ensures (inv(j) ==> canRequestHold(j) ==> alwaysQuarantinedPlanNamesItsCandidate(requestHold(j).state))
  ensures (inv(j) ==> canRequestHold(j) ==> alwaysRecoveryFollowsQuarantinedCandidate(requestHold(j).state))
  ensures (inv(j) ==> canRequestHold(j) ==> alwaysRecoveryPhasesMatchTheAttempt(requestHold(j).state))
  ensures (inv(j) ==> canRequestHold(j) ==> alwaysSupportNamesItsReason(requestHold(j).state))
  ensures (inv(j) ==> canRequestHold(j) ==> stepHoldsAreAnnounced(j, "requestHold", requestHold(j).state, requestHold(j).out))
  ensures (inv(j) ==> canRequestHold(j) ==> stepRejectionIsDurable(j, requestHold(j).state))
  ensures (inv(j) ==> canRequestHold(j) ==> stepQuarantineIsPermanent(j, requestHold(j).state))
  ensures (inv(j) ==> canRequestHold(j) ==> stepGenerationNeverGoesBack(j, requestHold(j).state))
{
  if inv(j) && canRequestHold(j) {
    var r := requestHold(j);
    assert r.out[0] in r.out && isHold(r.out[0]);
    assert forall e :: e in r.out ==> !isRelease(e);
  }
}

lemma releaseUnhandedHold_ensures(j: Journal)
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> alwaysPlanOutsideIdle(releaseUnhandedHold(j).state))
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> alwaysAwaitingIsHeld(releaseUnhandedHold(j).state))
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> alwaysHoldOnlyForAnOpenAttempt(releaseUnhandedHold(j).state))
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> alwaysUnknownOutcomeIsNotRecovery(releaseUnhandedHold(j).state))
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> alwaysOpenCandidateIsNotQuarantined(releaseUnhandedHold(j).state))
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> alwaysRetryBudget(releaseUnhandedHold(j).state))
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> alwaysQuarantinedPlanNamesItsCandidate(releaseUnhandedHold(j).state))
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> alwaysRecoveryFollowsQuarantinedCandidate(releaseUnhandedHold(j).state))
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> alwaysRecoveryPhasesMatchTheAttempt(releaseUnhandedHold(j).state))
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> alwaysSupportNamesItsReason(releaseUnhandedHold(j).state))
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> stepHoldsAreAnnounced(j, "releaseUnhandedHold", releaseUnhandedHold(j).state, releaseUnhandedHold(j).out))
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> stepRejectionIsDurable(j, releaseUnhandedHold(j).state))
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> stepQuarantineIsPermanent(j, releaseUnhandedHold(j).state))
  ensures (inv(j) ==> canReleaseUnhandedHold(j) ==> stepGenerationNeverGoesBack(j, releaseUnhandedHold(j).state))
{
  if inv(j) && canReleaseUnhandedHold(j) {
    InsHolds(j, "releaseUnhandedHold", releaseUnhandedHold(j));
  }
}

lemma observeInstall_ensures(j: Journal, readback: Readback)
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> alwaysPlanOutsideIdle(observeInstall(j, readback).state))
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> alwaysAwaitingIsHeld(observeInstall(j, readback).state))
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> alwaysHoldOnlyForAnOpenAttempt(observeInstall(j, readback).state))
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> alwaysUnknownOutcomeIsNotRecovery(observeInstall(j, readback).state))
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> alwaysOpenCandidateIsNotQuarantined(observeInstall(j, readback).state))
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> alwaysRetryBudget(observeInstall(j, readback).state))
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> alwaysQuarantinedPlanNamesItsCandidate(observeInstall(j, readback).state))
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> alwaysRecoveryFollowsQuarantinedCandidate(observeInstall(j, readback).state))
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> alwaysRecoveryPhasesMatchTheAttempt(observeInstall(j, readback).state))
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> alwaysSupportNamesItsReason(observeInstall(j, readback).state))
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> stepHoldsAreAnnounced(j, "observeInstall", observeInstall(j, readback).state, observeInstall(j, readback).out))
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> stepRejectionIsDurable(j, observeInstall(j, readback).state))
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> stepQuarantineIsPermanent(j, observeInstall(j, readback).state))
  ensures (inv(j) ==> canObserveInstall(j, readback) ==> stepGenerationNeverGoesBack(j, observeInstall(j, readback).state))
{
  if inv(j) && canObserveInstall(j, readback) {
    var r := observeInstall(j, readback);
    InsHolds(j, "observeInstall", r);
    InsAdd(j.quarantine, j.plan.candidate);
    if !j.recoveryAttempted {
      assert !(j.plan.candidate in j.quarantine);
      InsRelease(j);
    }
  }
}

lemma abandonUnknown_ensures(j: Journal)
  ensures (inv(j) ==> canAbandonUnknown(j) ==> alwaysPlanOutsideIdle(abandonUnknown(j).state))
  ensures (inv(j) ==> canAbandonUnknown(j) ==> alwaysAwaitingIsHeld(abandonUnknown(j).state))
  ensures (inv(j) ==> canAbandonUnknown(j) ==> alwaysHoldOnlyForAnOpenAttempt(abandonUnknown(j).state))
  ensures (inv(j) ==> canAbandonUnknown(j) ==> alwaysUnknownOutcomeIsNotRecovery(abandonUnknown(j).state))
  ensures (inv(j) ==> canAbandonUnknown(j) ==> alwaysOpenCandidateIsNotQuarantined(abandonUnknown(j).state))
  ensures (inv(j) ==> canAbandonUnknown(j) ==> alwaysRetryBudget(abandonUnknown(j).state))
  ensures (inv(j) ==> canAbandonUnknown(j) ==> alwaysQuarantinedPlanNamesItsCandidate(abandonUnknown(j).state))
  ensures (inv(j) ==> canAbandonUnknown(j) ==> alwaysRecoveryFollowsQuarantinedCandidate(abandonUnknown(j).state))
  ensures (inv(j) ==> canAbandonUnknown(j) ==> alwaysRecoveryPhasesMatchTheAttempt(abandonUnknown(j).state))
  ensures (inv(j) ==> canAbandonUnknown(j) ==> alwaysSupportNamesItsReason(abandonUnknown(j).state))
  ensures (inv(j) ==> canAbandonUnknown(j) ==> stepHoldsAreAnnounced(j, "abandonUnknown", abandonUnknown(j).state, abandonUnknown(j).out))
  ensures (inv(j) ==> canAbandonUnknown(j) ==> stepRejectionIsDurable(j, abandonUnknown(j).state))
  ensures (inv(j) ==> canAbandonUnknown(j) ==> stepQuarantineIsPermanent(j, abandonUnknown(j).state))
  ensures (inv(j) ==> canAbandonUnknown(j) ==> stepGenerationNeverGoesBack(j, abandonUnknown(j).state))
{
  if inv(j) && canAbandonUnknown(j) {
    InsHolds(j, "abandonUnknown", abandonUnknown(j));
    assert awaitsReadback(j) && !j.recoveryAttempted;
    InsRelease(j);
  }
}

lemma observeHealth_ensures(j: Journal, evidence: HealthEvidence)
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> alwaysPlanOutsideIdle(observeHealth(j, evidence)))
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> alwaysAwaitingIsHeld(observeHealth(j, evidence)))
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> alwaysHoldOnlyForAnOpenAttempt(observeHealth(j, evidence)))
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> alwaysUnknownOutcomeIsNotRecovery(observeHealth(j, evidence)))
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> alwaysOpenCandidateIsNotQuarantined(observeHealth(j, evidence)))
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> alwaysRetryBudget(observeHealth(j, evidence)))
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> alwaysQuarantinedPlanNamesItsCandidate(observeHealth(j, evidence)))
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> alwaysRecoveryFollowsQuarantinedCandidate(observeHealth(j, evidence)))
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> alwaysRecoveryPhasesMatchTheAttempt(observeHealth(j, evidence)))
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> alwaysSupportNamesItsReason(observeHealth(j, evidence)))
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> stepHoldsAreAnnounced(j, "observeHealth", observeHealth(j, evidence), []))
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> stepRejectionIsDurable(j, observeHealth(j, evidence)))
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> stepQuarantineIsPermanent(j, observeHealth(j, evidence)))
  ensures (inv(j) ==> canObserveHealth(j, evidence) ==> stepGenerationNeverGoesBack(j, observeHealth(j, evidence)))
{
  if inv(j) && canObserveHealth(j, evidence) {
    var q := j.quarantine + Std.Collections.Seq.Filter((set_x: int) => !((set_x in j.quarantine)), [j.plan.candidate]);
    InsAdd(j.quarantine, j.plan.candidate);
    InsAdd(q, j.plan.recovery);
  }
}

lemma denyRecovery_ensures(j: Journal)
  ensures (inv(j) ==> canDenyRecovery(j) ==> alwaysPlanOutsideIdle(denyRecovery(j).state))
  ensures (inv(j) ==> canDenyRecovery(j) ==> alwaysAwaitingIsHeld(denyRecovery(j).state))
  ensures (inv(j) ==> canDenyRecovery(j) ==> alwaysHoldOnlyForAnOpenAttempt(denyRecovery(j).state))
  ensures (inv(j) ==> canDenyRecovery(j) ==> alwaysUnknownOutcomeIsNotRecovery(denyRecovery(j).state))
  ensures (inv(j) ==> canDenyRecovery(j) ==> alwaysOpenCandidateIsNotQuarantined(denyRecovery(j).state))
  ensures (inv(j) ==> canDenyRecovery(j) ==> alwaysRetryBudget(denyRecovery(j).state))
  ensures (inv(j) ==> canDenyRecovery(j) ==> alwaysQuarantinedPlanNamesItsCandidate(denyRecovery(j).state))
  ensures (inv(j) ==> canDenyRecovery(j) ==> alwaysRecoveryFollowsQuarantinedCandidate(denyRecovery(j).state))
  ensures (inv(j) ==> canDenyRecovery(j) ==> alwaysRecoveryPhasesMatchTheAttempt(denyRecovery(j).state))
  ensures (inv(j) ==> canDenyRecovery(j) ==> alwaysSupportNamesItsReason(denyRecovery(j).state))
  ensures (inv(j) ==> canDenyRecovery(j) ==> stepHoldsAreAnnounced(j, "denyRecovery", denyRecovery(j).state, denyRecovery(j).out))
  ensures (inv(j) ==> canDenyRecovery(j) ==> stepRejectionIsDurable(j, denyRecovery(j).state))
  ensures (inv(j) ==> canDenyRecovery(j) ==> stepQuarantineIsPermanent(j, denyRecovery(j).state))
  ensures (inv(j) ==> canDenyRecovery(j) ==> stepGenerationNeverGoesBack(j, denyRecovery(j).state))
{
  if inv(j) && canDenyRecovery(j) {
    InsHolds(j, "denyRecovery", denyRecovery(j));
  }
}
