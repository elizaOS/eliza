# Reply, ignore and choose

Every turn ends in one core action chosen by the planner: REPLY sends a
message, IGNORE and NONE send nothing (IGNORE also stops following the
thread), and CHOOSE_OPTION answers a choice the agent offered earlier. A
turn takes exactly one of them. A choice is answered only by the person it
was offered to, only with one of its offered options, and only once.
Cancelling a choice that guards an approval is in
[choice cancellation](./choiceCancellation.md); the kernel's planning and execution
of other actions is in [action planning](../../core/actionPlanning.md).

## Story: End each turn with one core action

> As someone talking to the agent, each message I send gets one decision:
> a reply, or a deliberate silence, never two replies and never a reply
> after the agent decided to stay quiet.

### A turn takes exactly one core action

```quint
type CoreAction = Undecided | Reply | Ignore | NoAction | ChooseOption
type Turn = { decision: CoreAction, replies: int, following: bool, choiceOpen: bool, choiceFor: int, options: Set[str], chosen: str, turns: int }
pure val initial: Turn = { decision: Undecided, replies: 0, following: true, choiceOpen: false, choiceFor: 0, options: Set(), chosen: "", turns: 0 }
pure val decisionValues = Set(Reply, Ignore, NoAction)
pure def canDecide(t: Turn, decision: CoreAction): bool = t.decision == Undecided and decision != Undecided and decision != ChooseOption
pure def decide(t: Turn, decision: CoreAction): Turn = { ...t, decision: decision, following: decision != Ignore }
pure def canNextTurn(t: Turn): bool = t.decision != Undecided
pure def nextTurn(t: Turn): Turn = { ...t, decision: Undecided, replies: 0, turns: t.turns + 1 }
pure def stepDecisionIsFinalForTheTurn(before: Turn, via: str, after: Turn): bool =
  (before.decision != Undecided and via != "nextTurn") implies after.decision == before.decision
```

### REPLY sends at most one message, and IGNORE and NONE send none

```quint
pure def canSendReply(t: Turn): bool = t.decision == Reply and t.replies == 0
pure def sendReply(t: Turn): Turn = { ...t, replies: t.replies + 1 }
pure def alwaysRepliesMatchDecision(t: Turn): bool = t.replies >= 0 and t.replies <= 1 and (t.replies > 0 implies t.decision == Reply)
pure def sometimesReplied(t: Turn): bool = t.replies == 1
pure def sometimesIgnoredAndUnfollowed(t: Turn): bool = t.decision == Ignore and not(t.following)
```

## Story: Answer a choice the agent offered

> As the person the agent asked to choose, only my answer counts, it must
> be one of the options I was given, and I can answer only once.

### A choice is answered only by the person it was offered to, with one of its options, once

```quint
pure val optionsValues = Set(Set("yes", "no"), Set("abort", "continue"))
pure val personValues = Set(1, 2)
pure val optionValues = Set("yes", "abort", "maybe")
pure def canOfferChoice(t: Turn, person: int, options: Set[str]): bool = not(t.choiceOpen) and person > 0 and options.size() > 0
pure def offerChoice(t: Turn, person: int, options: Set[str]): Turn = { ...t, choiceOpen: true, choiceFor: person, options: options, chosen: "" }
pure def canChooseOption(t: Turn, person: int, option: str): bool =
  t.decision == Undecided and t.choiceOpen and person == t.choiceFor and t.options.contains(option)
pure def chooseOption(t: Turn, person: int, option: str): Turn = { ...t, decision: ChooseOption, choiceOpen: false, chosen: option }
pure def alwaysChosenOptionWasOffered(t: Turn): bool = t.chosen == "" or t.options.contains(t.chosen)
pure def stepChoiceAnsweredOnce(before: Turn, after: Turn): bool =
  (after.chosen != "" and before.chosen != "" and not(after.choiceOpen) and not(before.choiceOpen)) implies after.chosen == before.chosen
pure def sometimesChoiceAnswered(t: Turn): bool = t.decision == ChooseOption and t.chosen != ""
```
