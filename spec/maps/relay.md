# Maps navigation relay delivery

The agent asks the phone to select a place, plan a route, reroute or stop
through a relay the phone opens for its authenticated turn. The relay's
admission rule and command budget are in [Maps navigation](./navigation.md);
this spec covers how a command reaches the phone when a delivery is lost.

## Story: Navigate again when the phone never received my request

> As the owner, I want a navigation request the phone never received to
> reach it again, and a request the phone already acted on never to run
> twice.

### A queued command waits for the phone's current offer and survives a new offer it never reached

One command is outstanding per relay. The agent queues it only while the
phone holds an open offer and no other command is outstanding. A command
nobody received stays queued when the phone opens a new offer, such as
after a reload, and is delivered to that offer. A command delivered to an
offer is abandoned when that offer is replaced: the phone that held it may
have acted, and its successor cannot know.

```quint
type RelayPhase = NoCommand | Queued | Leased | Answered | Abandoned
type MapsRelay = { offer: int, phase: RelayPhase, command: int, leasedTo: int, deliveries: int, executions: int, phoneSeen: int, receipts: int }
pure val initial: MapsRelay = { offer: 0, phase: NoCommand, command: 0, leasedTo: 0, deliveries: 0, executions: 0, phoneSeen: 0, receipts: 0 }
pure val maxDeliveries = 3
pure def outstanding(s: MapsRelay): bool = s.phase == Queued or s.phase == Leased
pure def canOpenOffer(s: MapsRelay, offer: int): bool = offer > s.offer
pure def openOffer(s: MapsRelay, offer: int): MapsRelay =
  { ...s, offer: offer, phoneSeen: 0, phase: if (s.phase == Leased) Abandoned else s.phase, leasedTo: if (s.phase == Leased) s.leasedTo else 0 }
pure def canQueueCommand(s: MapsRelay): bool = s.offer > 0 and not(outstanding(s))
pure def queueCommand(s: MapsRelay): MapsRelay =
  { ...s, phase: Queued, command: s.command + 1, leasedTo: 0, deliveries: 0, executions: 0, receipts: 0 }
pure def canDeliverCommand(s: MapsRelay): bool = s.phase == Queued and s.offer > 0
pure def deliverCommand(s: MapsRelay): MapsRelay = { ...s, phase: Leased, leasedTo: s.offer, deliveries: s.deliveries + 1 }
pure def canAbandonCommand(s: MapsRelay): bool = outstanding(s)
pure def abandonCommand(s: MapsRelay): MapsRelay = { ...s, phase: Abandoned }
pure val offerValues = Set(1, 2, 3, 4)
pure val weight_deliverCommand = 4
pure def alwaysLeaseBelongsToTheCurrentOffer(s: MapsRelay): bool =
  (s.phase == Leased implies s.leasedTo == s.offer and s.offer > 0) and (s.phase == Queued implies s.leasedTo == 0 and s.deliveries == 0)
pure def stepDeliveredCommandNeverMovesOffer(before: MapsRelay, via: str, after: MapsRelay): bool =
  (before.phase == Leased and after.phase == Leased) implies after.leasedTo == before.leasedTo
pure def sometimesQueuedAcrossOffers(s: MapsRelay): bool = s.phase == Leased and s.offer > 1 and s.deliveries == 1
```

### A lapsed lease redelivers the same command a bounded number of times, and the phone runs it at most once

A delivery leases the command to the offer. When no receipt arrives within
the lease, the next poll of the same offer delivers the same command again,
at most `maxDeliveries` times in all; after that it waits for its receipt
or its expiry. The phone runs a command only the first time it sees its
identity in its current offer, so a redelivery never repeats a device
action. One receipt is accepted for the one run, from the offer the command
is leased to.

```quint
pure def canRedeliverCommand(s: MapsRelay): bool = s.phase == Leased and s.deliveries < maxDeliveries
pure def redeliverCommand(s: MapsRelay): MapsRelay = { ...s, deliveries: s.deliveries + 1 }
pure def canPhoneRuns(s: MapsRelay): bool = s.phase == Leased and s.leasedTo == s.offer
pure def phoneRuns(s: MapsRelay): MapsRelay =
  if (s.phoneSeen == s.command) s else { ...s, executions: s.executions + 1, phoneSeen: s.command }
pure def canReceiptArrives(s: MapsRelay): bool = s.phase == Leased and s.phoneSeen == s.command and s.receipts == 0
pure def receiptArrives(s: MapsRelay): MapsRelay = { ...s, phase: Answered, receipts: s.receipts + 1 }
pure val weight_phoneRuns = 3
pure val weight_receiptArrives = 3
pure def alwaysRunsAtMostOnce(s: MapsRelay): bool =
  s.executions >= 0 and s.executions <= 1 and s.receipts >= 0 and s.receipts <= 1 and s.phoneSeen >= 0 and s.phoneSeen <= s.command and
  (s.phase == Queued implies s.executions == 0 and s.phoneSeen != s.command) and
  (s.phase == Leased implies (s.executions == 1 iff s.phoneSeen == s.command)) and
  (s.phase == Answered implies s.executions == 1 and s.receipts == 1)
pure def alwaysDeliveriesAreBounded(s: MapsRelay): bool = s.deliveries >= 0 and s.deliveries <= maxDeliveries
pure def stepRedeliveryNeverRunsTwice(before: MapsRelay, via: str, after: MapsRelay): bool =
  after.command == before.command implies after.executions <= 1
pure def sometimesRedeliveredThenAnswered(s: MapsRelay): bool = s.phase == Answered and s.deliveries > 1
```
