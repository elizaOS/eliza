# Maps cards in chat

## Story: See the map result and hear the rest of the answer

> As the owner, I want a map card I can use alongside the answer to my
> question, including information that the card does not show.

### A successful Maps result with a valid card supplies verified reply text

When Maps produces a schema-valid card for a successful action, the
exact text with the card and provider attribution is verified copy for
the owner. The owner's [reply composer](../agent/conversation/planning.md)
keeps the card outside code fences and keeps distinct grounded prose.
A location request or other Maps refusal keeps its existing outcome and
copy. A result without a valid card gains no verified copy from this
rule. The card is presentation and does not authorize any phone action.

```quint
pure def cardCopyAdmitted(succeeded: bool, validCard: bool): bool = succeeded and validCard
pure def lawValidCardsFollowActionOutcome(succeeded: bool): bool = cardCopyAdmitted(succeeded, true) == succeeded
pure def lawFailedActionsNeverGainVerifiedCardCopy(validCard: bool): bool = not(cardCopyAdmitted(false, validCard))
pure def lawInvalidCardsNeverGainVerifiedCopy(succeeded: bool): bool = not(cardCopyAdmitted(succeeded, false))
```
