# Replies about the assistant's own work

While the assistant works on a request, such as saving a reminder or
changing a to-do, the owner may hear a brief acknowledgment: a cue such as
"On it." or "One sec." that names no person, item, time or outcome. Once
the work settles the owner hears the whole answer. A reply that opens with
the words of a cue and goes on to state something, such as "One second is
a thousand milliseconds" or "Just a moment ago the timer finished", is an
answer, and is heard in full.

What a reply says the assistant did is held to what this turn's results
prove. Each result names the action that produced it, the record it
targeted, and how it ended: applied, refused by the store or provider,
ended with the provider's acceptance unknown, or only previewed. A result
tells the model what happened in its own sentence, and the model words the
reply from it: the owner never hears that sentence beside the model's
words, so a saved routine or a changed to-do is told once.

## Story: Hear a brief acknowledgment while my request is pending, and the whole answer after

> As the owner, I hear a brief acknowledgment while the assistant works on
> my request, and I still hear an answer about a duration in full.

### A cue is heard only while the work is pending, and never in place of an answer

An answer offered while the work is still pending is held back until it
settles; a cue offered once it settled is dropped.

```quint
type ReplyKind = CueReply | AnswerReply | EmptyReply
type WorkPhase = WorkPending | WorkSettled
pure def heardWhile(phase: WorkPhase, reply: ReplyKind): ReplyKind =
  if (reply == CueReply and phase == WorkPending) CueReply
  else if (reply == AnswerReply and phase == WorkSettled) AnswerReply
  else EmptyReply
pure def lawACueIsHeardOnlyWhilePending(phase: WorkPhase, reply: ReplyKind): bool =
  heardWhile(phase, reply) == CueReply implies phase == WorkPending
pure def lawASettledAnswerIsHeardWhole(reply: ReplyKind): bool =
  reply == AnswerReply implies heardWhile(WorkSettled, reply) == AnswerReply
pure def lawACueNeverEndsTheTurn(reply: ReplyKind): bool = heardWhile(WorkSettled, reply) != CueReply
```

## Story: Hear what this turn proves about my request

> As the owner, I hear that an action failed when this turn proves it
> failed, and I hear the later success when it supersedes the failure.

### A claim that something was done needs a result that applied it to that record

```quint
type ResultEnd = EndApplied | EndRefused | EndUnknown | EndPreviewed
type TurnResult = { actionName: str, target: str, ended: ResultEnd }
type ClaimKind = ClaimedDone | ClaimedNotDone
pure val noResult: TurnResult = { actionName: "", target: "", ended: EndUnknown }
pure def committedTo(results: List[TurnResult], target: str): bool =
  target != "" and results.some(r => r.target == target and r.ended == EndApplied)
```

### A claim that something was not done needs a cited result that failed and was not superseded

A failure is superseded by a later result that applied the same record,
or, for a failure that named no record, by a result of the same action
that applied. A failure whose acceptance is unknown proves neither
outcome, and a success of another record supersedes nothing.

```quint
pure def supersedes(later: TurnResult, failed: TurnResult): bool =
  later.ended == EndApplied and ((failed.target != "" and later.target == failed.target) or (failed.target == "" and later.actionName == failed.actionName))
pure def provesNotDone(results: List[TurnResult], failed: TurnResult): bool =
  (failed.ended == EndRefused or failed.ended == EndPreviewed) and not(results.some(r => supersedes(r, failed)))
pure def claimSupported(results: List[TurnResult], claim: ClaimKind, target: str, cited: int): bool =
  if (claim == ClaimedDone) committedTo(results, target)
  else cited >= 0 and cited < results.length() and provesNotDone(results, results.nthOr(cited, noResult))
pure val failedValues: Set[TurnResult] = List(
  { actionName: "SAVE", target: "r1", ended: EndRefused }, { actionName: "SAVE", target: "r1", ended: EndUnknown },
  { actionName: "SAVE", target: "", ended: EndRefused }, { actionName: "SAVE", target: "r1", ended: EndPreviewed },
  { actionName: "SAVE", target: "r1", ended: EndApplied }
).foldl(Set(), (acc, r) => acc.union(Set(r)))
pure val laterValues: Set[TurnResult] = List(
  { actionName: "SAVE", target: "r1", ended: EndApplied }, { actionName: "SAVE", target: "r2", ended: EndApplied },
  { actionName: "OTHER", target: "r2", ended: EndApplied }, { actionName: "SAVE", target: "", ended: EndApplied },
  { actionName: "SAVE", target: "r1", ended: EndRefused }
).foldl(Set(), (acc, r) => acc.union(Set(r)))
pure def lawALaterCommitToTheSameRecordSupersedesAFailure(failed: TurnResult, later: TurnResult): bool =
  supersedes(later, failed) implies not(claimSupported(List(failed, later), ClaimedNotDone, failed.target, 0))
pure def lawASuccessOfAnotherRecordSupersedesNothing(failed: TurnResult, later: TurnResult): bool =
  (failed.ended == EndRefused and failed.target != "" and later.target != failed.target) implies claimSupported(List(failed, later), ClaimedNotDone, failed.target, 0)
pure def lawAnUnknownAcceptanceProvesNeither(failed: TurnResult, later: TurnResult): bool =
  failed.ended == EndUnknown implies (not(claimSupported(List(failed), ClaimedNotDone, failed.target, 0)) and not(claimSupported(List(failed), ClaimedDone, failed.target, 0)))
pure def lawDoneIsClaimedOnlyForAnAppliedRecord(failed: TurnResult, later: TurnResult): bool =
  claimSupported(List(failed, later), ClaimedDone, later.target, 1) implies (later.target != "" and (later.ended == EndApplied or (failed.target == later.target and failed.ended == EndApplied)))
pure def lawACitationOutsideTheTurnProvesNothing(failed: TurnResult): bool =
  not(claimSupported(List(failed), ClaimedNotDone, failed.target, 1)) and not(claimSupported(List(failed), ClaimedNotDone, failed.target, -1))
```
