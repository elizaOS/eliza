# Approval follow-ups

When the owner leaves an approval open, the assistant schedules a
follow-up task that reminds them about it, and posts a prompt for it. On
each scheduler tick, a reconcile pass reads the owner's approval queue for
every follow-up before the fire pass may deliver any: a follow-up whose
approval is resolved is retired with its prompt, one whose approval is
being carried out is held, and a failed read or cleanup holds the
follow-up for the next tick. Retiring is limited per tick; a resolved
approval beyond the limit is held until a later tick retires it.

A delivery that was admitted while its approval was still pending may
finish even if the owner resolves the approval meanwhile; the follow-up
does not claim one atomic cancellation across the queue and the scheduler.
This machine follows two follow-ups, with a limit of one retirement per
tick.

## Story: Remind me about approvals I left open, and stop once I answered

> As an owner, I want a follow-up while an approval waits for me, and none
> once I have answered it.

### Each tick reconciles every follow-up against its approval before any is delivered

One read of the owner's approval queue holds every follow-up whose
approval is resolved or being carried out, and retires resolved ones with
their prompts, in order, while the tick's retirement limit allows. A
failed read or cleanup holds every follow-up until the next tick.

```quint
type ApprovalState = ApprovalPending | ApprovalProcessing | ApprovalResolved
type TickPhase = Reconciling | Firing
type Followup = { followupId: int, approval: ApprovalState, held: bool, seenResolved: bool, completed: bool, prompt: bool, sent: bool, sendsAfterSeenResolved: int }
type Followups = { followups: List[Followup], tickPhase: TickPhase, retired: int }
type RetirePass = { passed: List[Followup], used: int }
pure val retireLimit = 1
pure val fresh: Followup = { followupId: 0, approval: ApprovalPending, held: false, seenResolved: false, completed: false, prompt: true, sent: false, sendsAfterSeenResolved: 0 }
pure val initial: Followups = { followups: List({ ...fresh, followupId: 1 }, { ...fresh, followupId: 2 }), tickPhase: Reconciling, retired: 0 }
pure val idValues = Set(1, 2)
pure def followupOf(id: int, s: Followups): Followup = s.followups.select(f => f.followupId == id).nthOr(0, { ...fresh, completed: true })
pure def changeFollowup(id: int, s: Followups, f: Followup): Followups = { ...s, followups: s.followups.listMap(x => if (x.followupId == id) f else x) }
pure def reconcileOne(pass: RetirePass, f: Followup): RetirePass = {
  val resolved = f.approval == ApprovalResolved
  val retire = resolved and not(f.completed) and pass.used < retireLimit
  { passed: pass.passed.append({ ...f, seenResolved: f.seenResolved or resolved, held: resolved or f.approval == ApprovalProcessing,
      completed: f.completed or retire, prompt: f.prompt and not(retire) }),
    used: if (retire) pass.used + 1 else pass.used }
}
pure def canReconcileTick(s: Followups): bool = s.tickPhase == Reconciling
pure def reconcileTick(s: Followups): Followups = {
  val pass = s.followups.foldl({ passed: List(), used: 0 }, (acc, f) => reconcileOne(acc, f))
  { followups: pass.passed, tickPhase: Firing, retired: pass.used }
}
pure def canReconcileFails(s: Followups): bool = s.tickPhase == Reconciling
pure def reconcileFails(s: Followups): Followups = { ...s, tickPhase: Firing, followups: s.followups.listMap(f => { ...f, held: true }) }
pure def canNextTick(s: Followups): bool = s.tickPhase == Firing and s.followups.some(f => not(f.completed))
pure def nextTick(s: Followups): Followups = { tickPhase: Reconciling, retired: 0, followups: s.followups.listMap(f => { ...f, held: false }) }
pure def alwaysRetirementLimitRespected(s: Followups): bool = s.retired >= 0 and s.retired <= retireLimit
```

### A follow-up is never delivered after its tick saw the approval resolved

The fire pass delivers only follow-ups the reconcile pass did not hold. An
approval being carried out holds its follow-up without retiring it, so a
failed execution that returns the approval to pending lets the follow-up
resume.

```quint
pure def canDeliverFollowup(s: Followups, id: int): bool =
  s.tickPhase == Firing and not(followupOf(id, s).held) and not(followupOf(id, s).completed)
pure def deliverFollowup(s: Followups, id: int): Followups = {
  val f = followupOf(id, s)
  changeFollowup(id, s, { ...f, sent: true, sendsAfterSeenResolved: if (f.seenResolved) f.sendsAfterSeenResolved + 1 else f.sendsAfterSeenResolved })
}
pure def alwaysResolvedApprovalStopsDelivery(s: Followups): bool = s.followups.every(f => f.sendsAfterSeenResolved == 0)
pure def alwaysSeenResolvedIsHeldWhileFiring(s: Followups): bool =
  s.tickPhase == Firing implies s.followups.every(f => (f.seenResolved and not(f.completed)) implies f.held)
```

### The owner works on an approval from the queue

The owner may start carrying out a pending approval, which may fail and
return it to pending, or resolve it.

```quint
pure def canStartApproval(s: Followups, id: int): bool = followupOf(id, s).approval == ApprovalPending and not(followupOf(id, s).completed)
pure def startApproval(s: Followups, id: int): Followups = changeFollowup(id, s, { ...followupOf(id, s), approval: ApprovalProcessing })
pure def canApprovalPreflightFails(s: Followups, id: int): bool = followupOf(id, s).approval == ApprovalProcessing
pure def approvalPreflightFails(s: Followups, id: int): Followups = changeFollowup(id, s, { ...followupOf(id, s), approval: ApprovalPending })
pure def canResolveApproval(s: Followups, id: int): bool = followupOf(id, s).approval != ApprovalResolved and not(followupOf(id, s).completed)
pure def resolveApproval(s: Followups, id: int): Followups = changeFollowup(id, s, { ...followupOf(id, s), approval: ApprovalResolved })
```

### A follow-up keeps its prompt exactly until it is retired

```quint
pure def alwaysPromptMatchesRetirement(s: Followups): bool = s.followups.every(f => f.prompt == not(f.completed))
pure def alwaysOnlyResolvedApprovalsRetire(s: Followups): bool = s.followups.every(f => f.completed implies f.approval == ApprovalResolved)
```

### Every resolved approval's follow-up is retired

Reads and cleanups eventually succeed, and ticks keep coming, so even
beyond the per-tick limit every resolved follow-up is retired.

```quint
pure val fair_reconcileTick = "strong"
pure val fair_nextTick = "weak"
pure def leadsToResolvedFollowupRetires(s: Followups, later: Followups): bool =
  s.followups.every(f => f.approval == ApprovalResolved implies followupOf(f.followupId, later).completed)
```

### A follow-up can be delivered, held while its approval runs, and retired a tick late

```quint
pure def sometimesDelivered(s: Followups): bool = s.followups.some(f => f.sent and not(f.completed))
pure def sometimesHeldWhileProcessing(s: Followups): bool = s.tickPhase == Firing and s.followups.some(f => f.approval == ApprovalProcessing and f.held)
pure def sometimesBothRetired(s: Followups): bool = s.followups.every(f => f.completed)
```
