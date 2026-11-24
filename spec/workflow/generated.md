# Generated workflow code

An untyped definition ([lifecycle](./lifecycle.md)) holds workflow code the
agent generated: one TypeScript module whose default export takes the
engine's context. The workflow worker ([worker provenance](./worker.md))
checks it with the staged TypeScript compiler against the engine's
declarations, publishes the compiled source ([source
publication](./sourcePublication.md)) and runs the verified bytes in a
bounded WebAssembly JavaScript guest. Each start gets fresh guest memory.
The guest receives JSON data and calls the journaled context. The worker
keeps filesystem, network and process capabilities outside the guest.
[Admission](./admission.md)
binds each run to the exact reviewed version and
[execution](./execution.md) owns the worker slot and wakeups.

## Story: Turn on generated code only after I review exactly what it does

> As the owner, I want workflow code the agent wrote to run on a schedule
> only after the compiler accepted it and I reviewed those exact bytes, so
> that a later edit never runs unseen.

### Activation needs a passing check and a review of the current source digest

The check refuses imports other than the engine's types, dynamic module
loading, reference and suppression directives, host globals and type
errors, and never runs the draft. A save records the compiler revision
and the digests of the source and of the compiled module. An edit clears
the review and turns the definition off. The owner reviews one source
digest at one version; turning a definition on needs that review to name
the current digest and version and the check to have passed with the
current compiler. Turning it off needs neither.

```quint
type GeneratedReview = { checked: bool, compilerCurrent: bool, sourceDigest: str, reviewedDigest: str, version: int, reviewedVersion: int }
pure def generatedActivationAdmitted(review: GeneratedReview, enable: bool): bool =
  not(enable) or (review.checked and review.compilerCurrent and review.reviewedDigest != "" and review.reviewedDigest == review.sourceDigest and review.reviewedVersion == review.version)
pure val reviewValues = Set(
  { checked: true, compilerCurrent: true, sourceDigest: "s1", reviewedDigest: "s1", version: 2, reviewedVersion: 2 },
  { checked: true, compilerCurrent: true, sourceDigest: "s2", reviewedDigest: "s1", version: 3, reviewedVersion: 2 },
  { checked: false, compilerCurrent: true, sourceDigest: "s1", reviewedDigest: "s1", version: 2, reviewedVersion: 2 },
  { checked: true, compilerCurrent: false, sourceDigest: "s1", reviewedDigest: "s1", version: 2, reviewedVersion: 2 })
pure val enableValues = Set(true, false)
pure def lawUnreviewedCodeNeverTurnsOn(review: GeneratedReview, enable: bool): bool =
  (enable and generatedActivationAdmitted(review, enable)) implies (review.checked and review.reviewedDigest == review.sourceDigest and review.reviewedVersion == review.version)
pure def lawTurningOffNeedsNoReview(review: GeneratedReview): bool = generatedActivationAdmitted(review, false)
```

### A draft the check refuses is repaired once before it is refused

A draft the agent writes is checked before it is offered or saved. When
the check refuses it, the agent asks the model once more, with the
rejected draft and the compiler's diagnostics given as data, and checks
that answer. A second refusal is final: the draft is returned with its
diagnostics and nothing is saved, so a draft is never repaired in a loop.
A draft that passes is offered as written.

```quint
type DraftStep = OfferDraft | RepairDraft | RefuseDraft
pure def draftStep(checkPassed: bool, repairs: int): DraftStep =
  if (checkPassed) OfferDraft else if (repairs < 1) RepairDraft else RefuseDraft
pure val repairsValues = Set(0, 1, 2)
pure def lawAPassingDraftIsOfferedAsWritten(repairs: int): bool = draftStep(true, repairs) == OfferDraft
pure def lawADraftIsRepairedAtMostOnce(repairs: int): bool = draftStep(false, repairs) == RepairDraft iff repairs < 1
```

## Story: Resume generated code after a wait without repeating what it already did

> As the owner, I want a generated workflow that waits for my approval, a
> signal or a timer to continue where it stopped, never running a step or an
> effect twice and never inventing a result it did not receive.

### Each call is journaled once, replays its recorded result, and diverges when its arguments change

The engine reruns the code from the start after every wait. Each context
call names an id; the journal keeps one entry per id with the digest of its
arguments. A call already in the journal returns its recorded result; the
same id with other arguments ends the run as diverged. A step's result is
checkpointed before the code continues.

```quint
type CallKind = StepCall | EffectCall | ApprovalCall | SignalCall | TimerCall
type Wait = NoWait | WaitApproval({ call: str }) | WaitSignal({ call: str, signal: str }) | WaitTimer({ call: str, due: int })
type GeneratedPhase = Replaying | Waiting | Settled | Diverged | EffectUnknown
type JournalEntry = { call: str, digest: str, kind: CallKind }
type GeneratedRun = { phase: GeneratedPhase, journal: List[JournalEntry], pending: str, pendingDigest: str, effectsSent: int, wait: Wait }
pure val initial: GeneratedRun = { phase: Replaying, journal: List(), pending: "", pendingDigest: "", effectsSent: 0, wait: NoWait }
pure def journaled(r: GeneratedRun, call: str): bool = r.journal.select(e => e.call == call).length() > 0
pure def entryOf(r: GeneratedRun, call: str): JournalEntry = r.journal.select(e => e.call == call).nthOr(0, { call: "", digest: "", kind: StepCall })
pure def canCheckpointStep(r: GeneratedRun, call: str, digest: str): bool = r.phase == Replaying and r.pending == "" and call != "" and not(journaled(r, call))
pure def checkpointStep(r: GeneratedRun, call: str, digest: str): GeneratedRun = { ...r, journal: r.journal.append({ call: call, digest: digest, kind: StepCall }) }
pure def canReplayCall(r: GeneratedRun, call: str, digest: str): bool = r.phase == Replaying and journaled(r, call)
pure def replayCall(r: GeneratedRun, call: str, digest: str): GeneratedRun = if (entryOf(r, call).digest == digest) r else { ...r, phase: Diverged }
pure val callValues = Set("count", "draft", "review", "ready", "pause")
pure val digestValues = Set("d1", "d2")
```

### An effect is dispatched at most once, and an effect whose receipt is lost is never sent again

An effect, such as a model draft, is recorded as pending before it is
dispatched and journaled with its receipt when the reply arrives. After a
restart, a pending effect is read back: a found receipt is journaled, and
otherwise the run ends with an unknown effect outcome instead of sending
the effect again.

```quint
pure def canDispatchEffect(r: GeneratedRun, call: str, digest: str): bool = r.phase == Replaying and r.pending == "" and call != "" and not(journaled(r, call))
pure def dispatchEffect(r: GeneratedRun, call: str, digest: str): GeneratedRun = { ...r, pending: call, pendingDigest: digest, effectsSent: r.effectsSent + 1 }
pure def canCommitEffect(r: GeneratedRun): bool = r.phase == Replaying and r.pending != ""
pure def commitEffect(r: GeneratedRun): GeneratedRun = { ...r, journal: r.journal.append({ call: r.pending, digest: r.pendingDigest, kind: EffectCall }), pending: "", pendingDigest: "" }
pure def canRecoverEffect(r: GeneratedRun, receiptFound: bool): bool = r.phase == Replaying and r.pending != ""
pure def recoverEffect(r: GeneratedRun, receiptFound: bool): GeneratedRun = if (receiptFound) commitEffect(r) else { ...r, phase: EffectUnknown }
pure def alwaysCallsJournaledOnce(r: GeneratedRun): bool = r.journal.every(e => r.journal.select(o => o.call == e.call).length() == 1) and not(r.pending != "" and journaled(r, r.pending))
pure def alwaysEffectsAtMostOnce(r: GeneratedRun): bool = r.effectsSent == r.journal.select(e => e.kind == EffectCall).length() + (if (r.pending != "") 1 else 0)
pure def sometimesEffectUnknown(r: GeneratedRun): bool = r.phase == EffectUnknown and r.effectsSent == 1
```

### A wait parks the run until its own approval, signal or timer resolves it

The code parks on an approval, a named signal or a timer. Only the wait the
run is parked on resumes it, and its result is journaled before the code
runs again. A settled, diverged or effect-unknown run never changes again.

```quint
pure def waitCall(w: Wait): str = match w { | WaitApproval(a) => a.call | WaitSignal(s) => s.call | WaitTimer(t) => t.call | NoWait => "" }
pure def waitKind(w: Wait): CallKind = match w { | WaitApproval(a) => ApprovalCall | WaitSignal(s) => SignalCall | WaitTimer(t) => TimerCall | NoWait => StepCall }
pure def canPark(r: GeneratedRun, wait: Wait): bool = r.phase == Replaying and r.pending == "" and waitCall(wait) != "" and not(journaled(r, waitCall(wait)))
pure def park(r: GeneratedRun, wait: Wait): GeneratedRun = { ...r, phase: Waiting, wait: wait }
pure def canResumeWait(r: GeneratedRun, call: str, digest: str): bool = r.phase == Waiting and call != "" and call == waitCall(r.wait)
pure def resumeWait(r: GeneratedRun, call: str, digest: str): GeneratedRun = { ...r, phase: Replaying, wait: NoWait, journal: r.journal.append({ call: call, digest: digest, kind: waitKind(r.wait) }) }
pure def canSettleRun(r: GeneratedRun): bool = r.phase == Replaying and r.pending == ""
pure def settleRun(r: GeneratedRun): GeneratedRun = { ...r, phase: Settled }
pure val waitValues = Set(WaitApproval({ call: "review" }), WaitSignal({ call: "ready", signal: "go" }), WaitTimer({ call: "pause", due: 1000 }), NoWait)
pure def alwaysWaitingHasOneWait(r: GeneratedRun): bool = (r.phase == Waiting) == (r.wait != NoWait) and (r.phase == Waiting implies not(journaled(r, waitCall(r.wait))))
pure def stepEndedRunStaysEnded(before: GeneratedRun, after: GeneratedRun): bool =
  (before.phase == Settled or before.phase == Diverged or before.phase == EffectUnknown) implies after == before
pure def sometimesResumedAfterSignal(r: GeneratedRun): bool = r.phase == Settled and r.journal.select(e => e.kind == SignalCall).length() > 0 and r.effectsSent == 1
pure def sometimesDiverged(r: GeneratedRun): bool = r.phase == Diverged
pure val eval_witness_sometimesResumedAfterSignal = (("dispatchEffect", "count", "d1"), "commitEffect", ("park", WaitSignal({ call: "ready", signal: "go" })), ("resumeWait", "ready", "d1"), "settleRun")
```
