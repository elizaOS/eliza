# Provider keys and concurrent execution domains

The source is `packages/core/src/runtime/state-composition.ts:250-357` and `provider-execution.ts:120-166` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. The logical coalescing key retains every source dimension before string serialization. The actual source joins fields with NUL separators and encodes the sorted provider list with JSON; the new boundary must preserve these logical dimensions without delimiter ambiguity.

## Story: Share exactly equivalent provider requests

As a caller I share a pending execution only for the same message, room, selected provider set, provider name, disclosure audience and complete/deferred reference mode. Explicit refresh and missing message identity always create independent work. The runtime instance owns the pool, so keys never cross runtimes.

### Structural key equality includes every coalescing dimension

Public providers use a public audience marker. Owner-exclusive providers retain the attestation ID, provenance and audience kind, or the explicit unattested marker. The selection is a duplicate-free set of provider names; source serialization sorts that set, so input ordering does not distinguish equivalent selections.

```quint
import providers as P from "./providers"
type ProviderAudience = PublicAudience | UnattestedAudience | AttestedAudience({attestationId: str, provenance: str, kind: str})
pure val publicAudience: ProviderAudience = PublicAudience
pure val unattestedAudience: ProviderAudience = UnattestedAudience
type ProviderKey = {messageId: str, roomId: str, selectedProviders: Set[str], providerName: str, audience: ProviderAudience, referenceDeferred: bool}
type ProviderDomain = {id: int, key: ProviderKey, keyed: bool, unit: P::ProviderState}
type PendingProviderCleanup = {domain: int, work: int}
type ProviderExecutions = {pendingCleanup: List[PendingProviderCleanup], domains: List[ProviderDomain], usedCallers: Set[int], nextDomain: int, stopped: bool}
pure val initial: ProviderExecutions = {pendingCleanup: List(), domains: List(), usedCallers: Set(), nextDomain: 1, stopped: false}
pure val keyValues = Set({messageId: "message-a", roomId: "room-a", selectedProviders: Set("profile", "facts"), providerName: "facts", audience: publicAudience, referenceDeferred: false}, {messageId: "message-a", roomId: "room-b", selectedProviders: Set("facts"), providerName: "facts", audience: AttestedAudience({attestationId: "attestation", provenance: "host", kind: "direct"}), referenceDeferred: false}, {messageId: "", roomId: "room-a", selectedProviders: Set("facts"), providerName: "facts", audience: unattestedAudience, referenceDeferred: true})
pure val firstValues = keyValues
pure val secondValues = keyValues
pure val audienceValues = Set(publicAudience, unattestedAudience, AttestedAudience({attestationId: "attestation", provenance: "host", kind: "direct"}))
pure val callerValues = P::callerValues
pure val domainIdValues = Set(1, 2, 3)
pure val workIdValues = P::workIdValues
pure def sameProviderAudience(audience: ProviderAudience, peerAudience: ProviderAudience): bool = match audience {
  | PublicAudience => match peerAudience { | PublicAudience => true | _ => false }
  | UnattestedAudience => match peerAudience { | UnattestedAudience => true | _ => false }
  | AttestedAudience(a) => match peerAudience { | AttestedAudience(b) => a.attestationId == b.attestationId and a.provenance == b.provenance and a.kind == b.kind | _ => false }
}
pure val peerAudienceValues = audienceValues
pure def sameProviderKey(first: ProviderKey, second: ProviderKey): bool = first.messageId == second.messageId and first.roomId == second.roomId and first.selectedProviders.subseteq(second.selectedProviders) and second.selectedProviders.subseteq(first.selectedProviders) and first.providerName == second.providerName and sameProviderAudience(first.audience, second.audience) and first.referenceDeferred == second.referenceDeferred
pure def eligibleForCoalescing(key: ProviderKey, refresh: bool): bool = key.messageId != "" and not(refresh)
pure def existingDomain(s: ProviderExecutions, key: ProviderKey): int = s.domains.select(d => d.keyed and sameProviderKey(d.key, key)).nthOr(0, {id: 0, key: key, keyed: false, unit: P::initial}).id
pure val absentDomain: ProviderDomain = {id: 0, key: {messageId: "", roomId: "", selectedProviders: Set(), providerName: "", audience: publicAudience, referenceDeferred: false}, keyed: false, unit: P::initial}
pure def providerDomain(s: ProviderExecutions, domainId: int): ProviderDomain = s.domains.select(d => d.id == domainId).nthOr(0, absentDomain)
pure def domainUnit(s: ProviderExecutions, domainId: int): P::ProviderState = providerDomain(s, domainId).unit
pure def canAttachProvider(s: ProviderExecutions, caller: int, key: ProviderKey, refresh: bool): bool = not(s.stopped) and caller > 0 and not(s.usedCallers.contains(caller))
pure def attachProvider(s: ProviderExecutions, caller: int, key: ProviderKey, refresh: bool): ProviderExecutions = {
  val keyed = eligibleForCoalescing(key, refresh)
  val existing = if (keyed) existingDomain(s, key) else 0
  { ...s, nextDomain: s.nextDomain + (if (existing == 0) 1 else 0), usedCallers: s.usedCallers.union(Set(caller)), domains: if (existing == 0) s.domains.append({id: s.nextDomain, key: key, keyed: keyed, unit: P::attach(P::initial, caller, keyed)}) else s.domains.listMap(d => if (d.id == existing) { ...d, unit: P::attach(d.unit, caller, true) } else d) }
}
pure def lawDifferentRoomNeverCoalesces(first: ProviderKey, second: ProviderKey): bool = first.roomId != second.roomId implies not(sameProviderKey(first, second))
pure def lawDifferentAudienceNeverCoalesces(first: ProviderKey, second: ProviderKey): bool = not(sameProviderAudience(first.audience, second.audience)) implies not(sameProviderKey(first, second))
pure def lawDifferentBodyModeNeverCoalesces(first: ProviderKey, second: ProviderKey): bool = first.referenceDeferred != second.referenceDeferred implies not(sameProviderKey(first, second))
pure def alwaysKeyedDomainsUnique(s: ProviderExecutions): bool = s.domains.every(d => not(d.keyed) or s.domains.select(other => other.keyed and sameProviderKey(d.key, other.key)).length() == 1)
pure def alwaysDomainIdentity(s: ProviderExecutions): bool = s.nextDomain > 0 and s.domains.every(d => d.id > 0 and d.id < s.nextDomain and s.domains.select(other => other.id == d.id).length() == 1)
```

### Work cancellation and cleanup use the exact captured execution identity

Each domain imports the complete safety invariant of the execution owner, including its last-waiter eviction and pre-invocation abort check. Discovered by the proof. Domain identity allocation stays positive even before the first domain exists. A stale cleanup cannot remove a replacement under the same key. Stopping aborts keyed and unkeyed work and clears both active ownership and coalescing entries.

Discovered by the proof. Each attachment records its caller identity in the runtime's admission set.
Child domains share the runtime stop boundary. These relations let coalescing
admission use the same child attachment guard for every retained domain.

```quint
pure def canInvokeProvider(s: ProviderExecutions, domainId: int, workId: int): bool = P::canInvokeWork(domainUnit(s, domainId), workId)
pure def invokeProvider(s: ProviderExecutions, domainId: int, workId: int): ProviderExecutions = { ...s, domains: s.domains.listMap(d => if (d.id == domainId) { ...d, unit: P::invokeWork(d.unit, workId) } else d) }
pure def canAbortCaller(s: ProviderExecutions, domainId: int, caller: int): bool = P::canAbortCaller(domainUnit(s, domainId), caller)
pure def abortCaller(s: ProviderExecutions, domainId: int, caller: int): ProviderExecutions = { ...s, domains: s.domains.listMap(d => if (d.id == domainId) { ...d, unit: P::abortCaller(d.unit, caller) } else d) }
pure def canDetachCaller(s: ProviderExecutions, domainId: int, caller: int): bool = P::canDetachCancelled(domainUnit(s, domainId), caller)
pure def detachCaller(s: ProviderExecutions, domainId: int, caller: int): ProviderExecutions = { ...s, domains: s.domains.listMap(d => if (d.id == domainId) { ...d, unit: P::detachCancelled(d.unit, caller) } else d) }
pure def canSettleProvider(s: ProviderExecutions, domainId: int, workId: int): bool = P::canSettleWork(domainUnit(s, domainId), workId)
pure def settleProvider(s: ProviderExecutions, domainId: int, workId: int): ProviderExecutions = { ...s, pendingCleanup: s.pendingCleanup.append({domain: domainId, work: workId}), domains: s.domains.listMap(d => if (d.id == domainId) { ...d, unit: P::settleWork(d.unit, workId) } else d) }
pure def canCleanProvider(s: ProviderExecutions, domainId: int, workId: int): bool = P::canCleanWork(domainUnit(s, domainId), workId)
pure def cleanProvider(s: ProviderExecutions, domainId: int, workId: int): ProviderExecutions = { ...s, pendingCleanup: s.pendingCleanup.select(p => p.domain != domainId or p.work != workId), domains: s.domains.listMap(d => if (d.id == domainId) { ...d, unit: P::cleanWork(d.unit, workId) } else d) }
pure def canReceiveProvider(s: ProviderExecutions, domainId: int, caller: int): bool = P::canReceiveResult(domainUnit(s, domainId), caller)
pure def receiveProvider(s: ProviderExecutions, domainId: int, caller: int): ProviderExecutions = { ...s, domains: s.domains.listMap(d => if (d.id == domainId) { ...d, unit: P::receiveResult(d.unit, caller) } else d) }
pure def canStopProviders(s: ProviderExecutions): bool = not(s.stopped)
pure def stopProviders(s: ProviderExecutions): ProviderExecutions = { ...s, stopped: true, domains: s.domains.listMap(d => { ...d, unit: P::stopProviders(d.unit) }) }
pure def alwaysEveryDomainValid(s: ProviderExecutions): bool = s.domains.every(d => P::alwaysExecutionIdentitiesUnique(d.unit) and P::alwaysCallersOwnExistingWork(d.unit) and P::alwaysKeyedWorkCanBeJoined(d.unit) and P::alwaysUnwantedWorkAborted(d.unit) and P::alwaysWaiterAbortHasNoCallers(d.unit) and P::alwaysStopReachesEveryExecution(d.unit) and P::alwaysCleanedWorkIsInactive(d.unit) and P::alwaysCreatedWorkHasStarted(d.unit) and P::alwaysProviderDeadlockFree(d.unit))
pure def alwaysDomainCallerAndStopRegistered(s: ProviderExecutions): bool = s.domains.every(d => d.unit.stopping == s.stopped and d.unit.callers.every(c => s.usedCallers.contains(c.id)) and d.unit.abortedCallers.subseteq(s.usedCallers))
pure def alwaysStoppedDomainsStopped(s: ProviderExecutions): bool = s.stopped implies s.domains.every(d => d.unit.stopping and d.unit.keyedId == 0 and d.unit.works.every(w => not(w.active)))
pure def sometimesDistinctKeysRunning(s: ProviderExecutions): bool = s.domains.some(a => s.domains.some(b => a.id != b.id and not(sameProviderKey(a.key, b.key)) and a.unit.callers.length() > 0 and b.unit.callers.length() > 0))
pure def sometimesAbortedBeforeInvocation(s: ProviderExecutions): bool = s.domains.some(d => d.unit.works.some(w => w.cause != P::NoAbort and not(w.invoked)))
```


### Settled work releases every captured caller across key domains

A work promise queues its creator cleanup exactly once when it settles. The cleanup witness consumes the oldest queued cleanup with its exact domain and work IDs. Each called promise also has its own release callback. The scheduler witness visits eligible domains in rotation and consumes one eligible attachment in the selected domain. An attached caller that has become ready retains its place ahead of later attachments. Explicit provider result and cancellation callbacks remain available for their exact eligible identities. Shared work cleanup and runtime stop remain separate events.

The execution owner currently projects promise outcome to its settlement
phase. Source refinement still needs the original result or rejection value,
the race between provider work and execution abort, and the separate observed
native promise if it finishes after that race. An already-aborted caller
also installs result observers before its immediate synchronous detach.

```quint
pure def nextProviderCleanup(s: ProviderExecutions): PendingProviderCleanup = s.pendingCleanup.nthOr(0, {domain: 0, work: 0})
pure def canRunNextProviderCleanup(s: ProviderExecutions): bool = s.pendingCleanup.length() > 0 and canCleanProvider(s, nextProviderCleanup(s).domain, nextProviderCleanup(s).work)
pure def runNextProviderCleanup(s: ProviderExecutions): ProviderExecutions = cleanProvider(s, nextProviderCleanup(s).domain, nextProviderCleanup(s).work)
pure def alwaysSettledWorkOwnsCleanup(s: ProviderExecutions): bool =
  s.pendingCleanup.every(p => canCleanProvider(s, p.domain, p.work) and s.pendingCleanup.select(other => other.domain == p.domain and other.work == p.work).length() == 1) and
  s.domains.every(d => d.unit.works.every(w => w.phase == P::WorkSettled implies s.pendingCleanup.some(p => p.domain == d.id and p.work == w.id)))
pure val fair_runNextProviderCleanup = "weak"
pure def nextCallbackDomain(s: ProviderExecutions): int = s.domains.select(d => P::canRunNextCallback(d.unit)).listMap(d => d.id).nthOr(0, 0)
pure def canRunNextProviderCallback(s: ProviderExecutions): bool = nextCallbackDomain(s) > 0 and P::canRunNextCallback(domainUnit(s, nextCallbackDomain(s)))
pure def runNextProviderCallback(s: ProviderExecutions): ProviderExecutions = {
  val domainId = nextCallbackDomain(s)
  val retained = s.domains.select(d => d.id != domainId)
  val selected = s.domains.select(d => d.id == domainId).listMap(d => { ...d, unit: P::runNextCallback(d.unit) })
  { ...s, domains: retained.concat(selected) }
}
pure val fair_runNextProviderCallback = "weak"
pure def leadsToReadyDomainCallersLeave(s: ProviderExecutions, later: ProviderExecutions): bool =
  s.domains.every(d => d.unit.callers.every(c => (P::canDetachCancelled(d.unit, c.id) or P::canCleanWork(d.unit, c.workId) or P::canReceiveResult(d.unit, c.id)) implies not(domainUnit(later, d.id).callers.some(other => other.id == c.id and other.workId == c.workId))))
```
