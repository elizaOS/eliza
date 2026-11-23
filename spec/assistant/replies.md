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
ended with the provider's acceptance unknown, or only previewed.

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
import receipts as R from "../core/receipts"
type ResultEnd = EndApplied | EndRefused | EndUnknown | EndPreviewed
type TurnResult = { target: str, ended: ResultEnd, evidence: R::EffectIdentity }
type ClaimKind = ClaimedDone | ClaimedNotDone
pure val noResult: TurnResult = { target: "", ended: EndUnknown, evidence: R::noEffectIdentity }
pure def committedTo(results: List[TurnResult], target: str): bool =
  target != "" and results.some(r => r.target == target and r.ended == EndApplied)
```

### A claim that something was not done needs a cited result that failed and was not superseded

An active committed receipt supersedes a failure when it proves the
same receipt, effect or retry as defined by [receipt identity](../core/receipts.md).
A receiptless failure reports only that attempt. Unknown acceptance
proves neither outcome. A result that contains several receipts keeps
their evidence separate and uses the original result's citation number.

```quint
pure def supersedes(later: TurnResult, failed: TurnResult): bool =
  later.ended == EndApplied and R::sameEffectEvidence(failed.evidence, later.evidence)
pure def provesNotDone(results: List[TurnResult], failed: TurnResult): bool =
  (failed.ended == EndRefused or failed.ended == EndPreviewed) and not(results.some(r => supersedes(r, failed)))
pure def claimSupported(results: List[TurnResult], claim: ClaimKind, target: str, cited: int): bool = {
  val selected = results.nthOr(cited, noResult)
  if (claim == ClaimedDone) committedTo(results, target)
  else cited >= 0 and cited < results.length() and (target == "" or selected.target == target) and provesNotDone(results, selected)
}
pure val failedValues = Set(
  { target: "r1", ended: EndRefused, evidence: R::exampleIdentity },
  { target: "r1", ended: EndUnknown, evidence: R::exampleIdentity },
  { target: "", ended: EndRefused, evidence: R::noEffectIdentity },
  { target: "r1", ended: EndPreviewed, evidence: R::exampleIdentity },
  { target: "r1", ended: EndApplied, evidence: R::exampleIdentity }
)
pure val laterValues = Set(
  { target: "r1", ended: EndApplied, evidence: R::exampleIdentity },
  { target: "r2", ended: EndApplied, evidence: { ...R::exampleIdentity, receiptId: "r2", resourceId: "n2", retryKey: "" } },
  { target: "r2", ended: EndApplied, evidence: { ...R::exampleIdentity, receiptId: "r2", resourceId: "n2" } },
  { target: "", ended: EndApplied, evidence: R::noEffectIdentity }
)
pure def lawALaterCommitToTheSameRecordSupersedesAFailure(failed: TurnResult, later: TurnResult): bool =
  supersedes(later, failed) implies not(claimSupported(List(failed, later), ClaimedNotDone, failed.target, 0))
pure def lawASuccessOfAnotherRecordSupersedesNothing(failed: TurnResult, later: TurnResult): bool =
  (failed.ended == EndRefused and not(R::sameEffectEvidence(failed.evidence, later.evidence))) implies claimSupported(List(failed, later), ClaimedNotDone, failed.target, 0)
pure def lawAnUnknownAcceptanceProvesNeither(failed: TurnResult, later: TurnResult): bool =
  failed.ended == EndUnknown implies (not(claimSupported(List(failed), ClaimedNotDone, failed.target, 0)) and not(claimSupported(List(failed), ClaimedDone, failed.target, 0)))
pure def lawDoneIsClaimedOnlyForAnAppliedRecord(failed: TurnResult, later: TurnResult): bool =
  claimSupported(List(failed, later), ClaimedDone, later.target, 1) implies (later.target != "" and (later.ended == EndApplied or (failed.target == later.target and failed.ended == EndApplied)))
pure def lawACitationOutsideTheTurnProvesNothing(failed: TurnResult): bool =
  not(claimSupported(List(failed), ClaimedNotDone, failed.target, 1)) and not(claimSupported(List(failed), ClaimedNotDone, failed.target, -1))
```
