# Connector operation queues

`connectors/account-manager.ts` serializes complete facade operations per manager and complete OAuth callbacks per `(runtime.agentId ?? "standalone", normalized provider)` key. Distinct runtime objects with the same agent id intentionally share the callback queue. These are promise-tail ownership rules, not database locks.

## Story: Preserve callback and migration order after rejection

### Each scope runs one operation in admission order and removes only its own tail

Invocation appends a unique ticket. A callback rejection settles that ticket and releases its successor. Callback queue cleanup removes the map entry only if its completing tail is still current. A stale completion cannot delete a newer tail. Facade operations include backend selection, migration, and invocation in one queued callback. External operations must eventually settle for the explicit fairness assumption to hold.
Discovered by simulation: scheduler progress must select the actual oldest
eligible or running ticket from retained state. Fairness over a finite set of
sample ticket numbers otherwise lets a newly allocated ticket stall forever.
Explicit ticket operations still admit every allowed cross-scope interleaving.
Allocated tickets remain positive, unique and below the next serial number;
a settled entry cannot still be running. These source allocation facts also
exclude duplicate-ticket states from the preservation proof.

```quint
type QueueScope = { owner: str, provider: str }
type QueueEntry = { scope: QueueScope, ticket: int, running: bool, complete: bool, failed: bool }
type QueueTail = { scope: QueueScope, ticket: int }
type ConnectorQueues = { serial: int, entries: List[QueueEntry], tails: List[QueueTail] }
pure val emptyScope: QueueScope = { owner: "", provider: "" }
pure val initial: ConnectorQueues = { serial: 1, entries: List(), tails: List() }
pure def admit(s: ConnectorQueues, scope: QueueScope): ConnectorQueues = { serial: s.serial + 1, entries: s.entries.append({ scope: scope, ticket: s.serial, running: false, complete: false, failed: false }), tails: s.tails.select(queuedTail => queuedTail.scope != scope).append({ scope: scope, ticket: s.serial }) }
pure def canBegin(s: ConnectorQueues, ticket: int): bool = s.entries.some(entry => entry.ticket == ticket and not(entry.running) and not(entry.complete) and s.entries.every(prior => prior.scope != entry.scope or prior.ticket >= entry.ticket or prior.complete))
pure def begin(s: ConnectorQueues, ticket: int): ConnectorQueues = { ...s, entries: s.entries.listMap(entry => if (entry.ticket == ticket) { ...entry, running: true } else entry) }
pure def canFinish(s: ConnectorQueues, ticket: int): bool = s.entries.some(entry => entry.ticket == ticket and entry.running and not(entry.complete))
pure def finish(s: ConnectorQueues, ticket: int, success: bool): ConnectorQueues = { ...s, entries: s.entries.listMap(entry => if (entry.ticket == ticket) { ...entry, running: false, complete: true, failed: not(success) } else entry) }
pure val noQueueEntry: QueueEntry = { scope: emptyScope, ticket: 0, running: false, complete: true, failed: false }
pure def firstEligible(s: ConnectorQueues): int = s.entries.select(entry => canBegin(s, entry.ticket)).nthOr(0, noQueueEntry).ticket
pure def firstRunning(s: ConnectorQueues): int = s.entries.select(entry => canFinish(s, entry.ticket)).nthOr(0, noQueueEntry).ticket
pure def canBeginNext(s: ConnectorQueues): bool = s.entries.some(entry => canBegin(s, entry.ticket))
pure def beginNext(s: ConnectorQueues): ConnectorQueues = begin(s, firstEligible(s))
pure def canFinishNext(s: ConnectorQueues): bool = s.entries.some(entry => canFinish(s, entry.ticket))
pure def finishNext(s: ConnectorQueues, success: bool): ConnectorQueues = finish(s, firstRunning(s), success)
pure def canCleanup(s: ConnectorQueues, ticket: int): bool = s.entries.some(entry => entry.ticket == ticket and entry.complete)
pure def cleanup(s: ConnectorQueues, ticket: int): ConnectorQueues = { ...s, tails: s.tails.select(queuedTail => queuedTail.ticket != ticket) }
pure def alwaysOneRunningPerScope(s: ConnectorQueues): bool = s.entries.every(entry => not(entry.running) or s.entries.select(other => other.scope == entry.scope and other.running).length() == 1)
pure def alwaysAllocatedTickets(s: ConnectorQueues): bool = s.serial >= 1 and s.entries.every(entry => entry.ticket > 0 and entry.ticket < s.serial and s.entries.select(other => other.ticket == entry.ticket).length() == 1)
pure def alwaysCompletedEntrySettled(s: ConnectorQueues): bool = s.entries.every(entry => not(entry.complete) or not(entry.running))
pure def alwaysStartedAfterPredecessors(s: ConnectorQueues): bool = s.entries.every(entry => not(entry.running) or s.entries.every(prior => prior.scope != entry.scope or prior.ticket >= entry.ticket or prior.complete))
pure def stepCleanupKeepsUnsettledTails(before: ConnectorQueues, via: str, after: ConnectorQueues): bool = via == "cleanup" implies before.tails.every(queuedTail => before.entries.some(entry => entry.ticket == queuedTail.ticket and entry.complete) or after.tails.includes(queuedTail))
pure def sometimesRejectedCallbackReleasesSuccessor(s: ConnectorQueues): bool = s.entries.some(prior => prior.failed and s.entries.some(successor => successor.scope == prior.scope and successor.ticket > prior.ticket and successor.running))
pure val scopeValues = Set({ owner: "agent1", provider: "one" }, { owner: "agent1", provider: "two" }, { owner: "agent2", provider: "one" })
pure val ticketValues = Set(1, 2, 3, 4)
pure val fair_beginNext = "weak"
pure val fair_finishNext = "weak"
pure def leadsToAdmittedCompletes(s: ConnectorQueues, later: ConnectorQueues): bool = s.entries.every(entry => later.entries.some(done => done.ticket == entry.ticket and done.complete))
```
