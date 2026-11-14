# Confirmation replies

This migrates `quint/ConfirmationReply.qnt` and `utils/confirmation.ts`. The implementation tokenizer must retain the source's English, Spanish, French, German, Korean, Chinese and Japanese word-boundary behavior, including scripts without spaces.

## Story: Settle an explicit confirmation from the user's reply

As a user, I want a refusal anywhere in my reply to cancel a pending destructive operation.

### A refusal overrides an initial affirmative and an unclear reply stays pending

The input adapter identifies affirmative-prefix and refusal-token evidence from the actual message. Only a pending request can consume an answer. The caller remains responsible for binding the reply to its owner and pending operation.

A clear reply and an unclear reply are distinct events. Weak fairness assumes
that the user eventually supplies a clear reply; an unlimited succession of
unclear replies or silence does not satisfy that assumption.

```quint
type ConfirmationStatus = Waiting | Confirmed | Declined
type Confirmation = { status: ConfirmationStatus, refusal: bool, affirmative: bool }
pure val initial: Confirmation = { status: Waiting, refusal: false, affirmative: false }
pure def canAnswerClear(c: Confirmation, refusal: bool, affirmative: bool): bool = c.status == Waiting and (refusal or affirmative)
pure def answerClear(c: Confirmation, refusal: bool, affirmative: bool): Confirmation = { status: if (refusal) Declined else Confirmed, refusal: refusal, affirmative: affirmative }
pure def canAnswerUnclear(c: Confirmation): bool = c.status == Waiting
pure def answerUnclear(c: Confirmation): Confirmation = c
pure def alwaysRefusalWins(c: Confirmation): bool = c.refusal implies c.status == Declined
pure def alwaysConfirmationHasEvidence(c: Confirmation): bool = c.status == Confirmed implies c.affirmative and not(c.refusal)
pure def alwaysUnclearStaysPending(c: Confirmation): bool = not(c.refusal) and not(c.affirmative) implies c.status == Waiting
pure def sometimesAffirmativeConfirmed(c: Confirmation): bool = c.status == Confirmed
pure def sometimesRefusalDeclined(c: Confirmation): bool = c.status == Declined
pure val fair_answerClear = "weak"
pure def leadsToClearReplySettles(c: Confirmation, later: Confirmation): bool = c.status == Waiting implies later.status != Waiting
```
