# Read state of loaded messages

Marking a loaded message read or unread goes through the reviewed
[managed operation](../cloud/services/google/mailOperations.md) of its
grant: the server reviews the exact message at the history it was loaded
at, and one dispatch follows. The label change is idempotent, so it does
not take the durable review slot of [drafts](./drafts.md). Each accepted
request dispatches at most once. This machine is one mailbox view's record of the
changes it has in flight and the ones whose outcome it never saw.

## Story: Change a message's read state once, and never repeat a change I did not ask for

> As the owner, I want opening a message to mark it read at most once, and
> my own read or unread choice to be tried again only when I ask.

### One change per message is in flight, and an unconfirmed automatic change is not sent again

A change is keyed by the grant and the message. While a change for that
key is in flight, another is refused as busy and nothing is sent. An
automatic mark-read, sent when a message is opened, is skipped when an
earlier change for that message ended unconfirmed or failed; only the
owner's explicit change may try again. A confirmed change clears the
message's unconfirmed mark; an unconfirmed or failed one sets it, since a
failure may still have reached Gmail. Switching account or Cloud session
forgets every key.

```quint
type ChangeDecision = ChangeBusy | ChangeSkipped | ChangeSent
type ChangeSettle = ChangeConfirmed | ChangeUnconfirmed | ChangeFailed
type ReadStateView = { inFlight: Set[str], unconfirmed: Set[str], sent: int }
pure val initial: ReadStateView = { inFlight: Set(), unconfirmed: Set(), sent: 0 }
pure val keyValues = Set("grant-a/m1", "grant-a/m2", "grant-b/m1")
pure def changeDecision(inFlight: Set[str], unconfirmed: Set[str], key: str, explicit: bool): ChangeDecision =
  if (inFlight.contains(key)) ChangeBusy else if (not(explicit) and unconfirmed.contains(key)) ChangeSkipped else ChangeSent
pure def canBeginChange(s: ReadStateView, key: str, explicit: bool): bool =
  changeDecision(s.inFlight, s.unconfirmed, key, explicit) == ChangeSent
pure def beginChange(s: ReadStateView, key: str, explicit: bool): ReadStateView =
  { ...s, inFlight: s.inFlight.union(Set(key)), sent: s.sent + 1 }
pure def canSettleChange(s: ReadStateView, key: str): bool = s.inFlight.contains(key)
pure def settleChange(s: ReadStateView, key: str, settlement: ChangeSettle): ReadStateView =
  { ...s, inFlight: s.inFlight.exclude(Set(key)),
    unconfirmed: if (settlement == ChangeConfirmed) s.unconfirmed.exclude(Set(key)) else s.unconfirmed.union(Set(key)) }
pure def forgetKeys(s: ReadStateView): ReadStateView = { ...initial, sent: s.sent }
pure val inFlightValues = Set(Set(), Set("grant-a/m1"), Set("grant-a/m1", "grant-b/m1"))
pure val unconfirmedValues = inFlightValues
pure def lawBusyMessageSendsNothing(inFlight: Set[str], unconfirmed: Set[str], key: str, explicit: bool): bool =
  inFlight.contains(key) implies changeDecision(inFlight, unconfirmed, key, explicit) == ChangeBusy
pure def lawAutomaticChangeIsNotRepeated(inFlight: Set[str], unconfirmed: Set[str], key: str): bool =
  unconfirmed.contains(key) implies changeDecision(inFlight, unconfirmed, key, false) != ChangeSent
pure def lawExplicitChangeMayRetry(unconfirmed: Set[str], key: str): bool =
  changeDecision(Set(), unconfirmed, key, true) == ChangeSent
pure def stepEachSendIsCounted(before: ReadStateView, via: str, after: ReadStateView): bool =
  (via == "beginChange" implies after.sent == before.sent + 1) and (via != "beginChange" implies after.sent == before.sent)
pure def alwaysSentCountsAreWhole(s: ReadStateView): bool = s.sent >= 0
pure def sometimesChangeInFlight(s: ReadStateView): bool = s.inFlight.size() > 0
pure def sometimesUnconfirmedChange(s: ReadStateView): bool = s.unconfirmed.size() > 0 and s.inFlight.size() == 0
```
