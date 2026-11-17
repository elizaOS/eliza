lemma FollowupOfIn(id: int, s: Followups)
  ensures followupOf(id, s) in s.followups || followupOf(id, s) == fresh_.(completed := true)
{
  var found := ProofLib.Filter((f: Followup) => (f.followupId == id), s.followups);
  ProofLib.FilterSubset((f: Followup) => (f.followupId == id), s.followups);
  assert followupOf(id, s) == (if 0 < |found| then found[0] else fresh_.(completed := true));
  if 0 < |found| {
    assert found[0] in s.followups;
  }
}

lemma ChangeKeeps(id: int, s: Followups, g: Followup)
  requires inv(s)
  requires g.sendsAfterSeenResolved == 0 && g.prompt == !g.completed && (g.completed ==> g.approval.ApprovalResolved?) && (g.seenResolved ==> g.approval.ApprovalResolved?)
  requires s.tickPhase.Firing? && g.seenResolved && !g.completed ==> g.held
  ensures inv(changeFollowup(id, s, g))
{
  var after := changeFollowup(id, s, g);
  forall x | x in after.followups ensures x == g || x in s.followups {
    var i :| 0 <= i < |after.followups| && after.followups[i] == x;
  }
}

lemma ReconcileFold(xs: seq<Followup>)
  requires forall x :: x in xs ==> x.sendsAfterSeenResolved == 0 && x.prompt == !x.completed && (x.completed ==> x.approval.ApprovalResolved?) && (x.seenResolved ==> x.approval.ApprovalResolved?)
  ensures 0 <= Std.Collections.Seq.FoldLeft((acc: RetirePass, f: Followup) => reconcileOne(acc, f), RetirePass([], 0), xs).used <= retireLimit
  ensures forall y :: y in Std.Collections.Seq.FoldLeft((acc: RetirePass, f: Followup) => reconcileOne(acc, f), RetirePass([], 0), xs).passed ==>
    y.sendsAfterSeenResolved == 0 && y.prompt == !y.completed && (y.completed ==> y.approval.ApprovalResolved?) && (y.seenResolved ==> y.approval.ApprovalResolved?) && (y.seenResolved && !y.completed ==> y.held)
  decreases |xs|
{
  if |xs| > 0 {
    var front := xs[..|xs| - 1];
    assert xs == front + [xs[|xs| - 1]];
    ProofLib.FoldLeftAppend((acc: RetirePass, f: Followup) => reconcileOne(acc, f), RetirePass([], 0), front, xs[|xs| - 1]);
    ReconcileFold(front);
  }
}

lemma reconcileTick_ensures(s: Followups)
  ensures (inv(s) ==> canReconcileTick(s) ==> alwaysRetirementLimitRespected(reconcileTick(s)))
  ensures (inv(s) ==> canReconcileTick(s) ==> alwaysResolvedApprovalStopsDelivery(reconcileTick(s)))
  ensures (inv(s) ==> canReconcileTick(s) ==> alwaysSeenResolvedIsHeldWhileFiring(reconcileTick(s)))
  ensures (inv(s) ==> canReconcileTick(s) ==> alwaysSeenResolvedStaysResolved(reconcileTick(s)))
  ensures (inv(s) ==> canReconcileTick(s) ==> alwaysPromptMatchesRetirement(reconcileTick(s)))
  ensures (inv(s) ==> canReconcileTick(s) ==> alwaysOnlyResolvedApprovalsRetire(reconcileTick(s)))
{
  if inv(s) && canReconcileTick(s) {
    ReconcileFold(s.followups);
  }
}

lemma deliverFollowup_ensures(s: Followups, id: int)
  ensures (inv(s) ==> canDeliverFollowup(s, id) ==> alwaysRetirementLimitRespected(deliverFollowup(s, id)))
  ensures (inv(s) ==> canDeliverFollowup(s, id) ==> alwaysResolvedApprovalStopsDelivery(deliverFollowup(s, id)))
  ensures (inv(s) ==> canDeliverFollowup(s, id) ==> alwaysSeenResolvedIsHeldWhileFiring(deliverFollowup(s, id)))
  ensures (inv(s) ==> canDeliverFollowup(s, id) ==> alwaysSeenResolvedStaysResolved(deliverFollowup(s, id)))
  ensures (inv(s) ==> canDeliverFollowup(s, id) ==> alwaysPromptMatchesRetirement(deliverFollowup(s, id)))
  ensures (inv(s) ==> canDeliverFollowup(s, id) ==> alwaysOnlyResolvedApprovalsRetire(deliverFollowup(s, id)))
{
  if inv(s) && canDeliverFollowup(s, id) {
    FollowupOfIn(id, s);
    var f := followupOf(id, s);
    ChangeKeeps(id, s, f.(sent := true, sendsAfterSeenResolved := (if f.seenResolved then (f.sendsAfterSeenResolved + 1) else f.sendsAfterSeenResolved)));
  }
}

lemma startApproval_ensures(s: Followups, id: int)
  ensures (inv(s) ==> canStartApproval(s, id) ==> alwaysRetirementLimitRespected(startApproval(s, id)))
  ensures (inv(s) ==> canStartApproval(s, id) ==> alwaysResolvedApprovalStopsDelivery(startApproval(s, id)))
  ensures (inv(s) ==> canStartApproval(s, id) ==> alwaysSeenResolvedIsHeldWhileFiring(startApproval(s, id)))
  ensures (inv(s) ==> canStartApproval(s, id) ==> alwaysSeenResolvedStaysResolved(startApproval(s, id)))
  ensures (inv(s) ==> canStartApproval(s, id) ==> alwaysPromptMatchesRetirement(startApproval(s, id)))
  ensures (inv(s) ==> canStartApproval(s, id) ==> alwaysOnlyResolvedApprovalsRetire(startApproval(s, id)))
{
  if inv(s) && canStartApproval(s, id) {
    FollowupOfIn(id, s);
    ChangeKeeps(id, s, followupOf(id, s).(approval := ApprovalState.ApprovalProcessing));
  }
}

lemma approvalPreflightFails_ensures(s: Followups, id: int)
  ensures (inv(s) ==> canApprovalPreflightFails(s, id) ==> alwaysRetirementLimitRespected(approvalPreflightFails(s, id)))
  ensures (inv(s) ==> canApprovalPreflightFails(s, id) ==> alwaysResolvedApprovalStopsDelivery(approvalPreflightFails(s, id)))
  ensures (inv(s) ==> canApprovalPreflightFails(s, id) ==> alwaysSeenResolvedIsHeldWhileFiring(approvalPreflightFails(s, id)))
  ensures (inv(s) ==> canApprovalPreflightFails(s, id) ==> alwaysSeenResolvedStaysResolved(approvalPreflightFails(s, id)))
  ensures (inv(s) ==> canApprovalPreflightFails(s, id) ==> alwaysPromptMatchesRetirement(approvalPreflightFails(s, id)))
  ensures (inv(s) ==> canApprovalPreflightFails(s, id) ==> alwaysOnlyResolvedApprovalsRetire(approvalPreflightFails(s, id)))
{
  if inv(s) && canApprovalPreflightFails(s, id) {
    FollowupOfIn(id, s);
    ChangeKeeps(id, s, followupOf(id, s).(approval := ApprovalState.ApprovalPending));
  }
}

lemma resolveApproval_ensures(s: Followups, id: int)
  ensures (inv(s) ==> canResolveApproval(s, id) ==> alwaysRetirementLimitRespected(resolveApproval(s, id)))
  ensures (inv(s) ==> canResolveApproval(s, id) ==> alwaysResolvedApprovalStopsDelivery(resolveApproval(s, id)))
  ensures (inv(s) ==> canResolveApproval(s, id) ==> alwaysSeenResolvedIsHeldWhileFiring(resolveApproval(s, id)))
  ensures (inv(s) ==> canResolveApproval(s, id) ==> alwaysSeenResolvedStaysResolved(resolveApproval(s, id)))
  ensures (inv(s) ==> canResolveApproval(s, id) ==> alwaysPromptMatchesRetirement(resolveApproval(s, id)))
  ensures (inv(s) ==> canResolveApproval(s, id) ==> alwaysOnlyResolvedApprovalsRetire(resolveApproval(s, id)))
{
  if inv(s) && canResolveApproval(s, id) {
    FollowupOfIn(id, s);
    ChangeKeeps(id, s, followupOf(id, s).(approval := ApprovalState.ApprovalResolved));
  }
}
