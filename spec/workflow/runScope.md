# Workflow calendar run scope

A reviewed workflow step can read the owner's calendar on the device. The
owner reviewed the range the step names, so the read stays inside that
range even when the run is dispatched late or crosses midnight. The
[approvals](./approvals.md) spec owns the rest of a device step's reviewed
scope; [schedule](./schedule.md) owns the occurrence that anchors the run.

## Story: A reviewed calendar read stays inside its run's scope

> As the owner, I want a workflow that reads "today's events" to read the
> day of the run I reviewed, from a device that understands that range, and
> never a range nobody reviewed.

### A relative range resolves from the run's own day and needs a device that understands it

A relative range such as "today" resolves from the persisted scheduled
occurrence or the manual run start, so a delayed dispatch or a run that
crosses midnight keeps the run's day. It needs a device that speaks the
relative-range protocol. A fixed range keeps its dates and needs no newer
protocol. Once resolved, the range never moves. A read happens only while
the owner and the source are still authorized and the device still speaks
the protocol the range needs.

```quint
type ScopePhase = NoProposal | Proposed | Resolved | QueuedRead | ScopeSettled
type RunScope = { phase: ScopePhase, relative: bool, peer: int, sourceValid: bool, owner: bool, day: int, runDay: int, capturedDay: int, read: bool, authorityAtRead: bool, peerAtRead: int }
pure val initial: RunScope = { phase: NoProposal, relative: false, peer: 0, sourceValid: false, owner: true, day: 0, runDay: 0, capturedDay: -1, read: false, authorityAtRead: false, peerAtRead: -1 }
pure val relativeRangeProtocol: int = 5
pure def peerUnderstands(relative: bool, peer: int): bool = not(relative) or peer >= relativeRangeProtocol
pure def scopeAdmitted(s: RunScope): bool = s.owner and s.sourceValid and peerUnderstands(s.relative, s.peer)
pure def canProposeRead(s: RunScope, peer: int): bool = s.phase == NoProposal and peer > 0
pure def proposeRead(s: RunScope, relative: bool, peer: int, sourceValid: bool): RunScope =
  { ...s, phase: Proposed, relative: relative, peer: peer, sourceValid: sourceValid, runDay: s.day }
pure def canResolveScope(s: RunScope): bool = s.phase == Proposed
pure def resolveScope(s: RunScope): RunScope =
  { ...s, phase: if (scopeAdmitted(s)) Resolved else ScopeSettled, capturedDay: s.runDay }
pure def canQueueRead(s: RunScope): bool = s.phase == Resolved
pure def queueRead(s: RunScope): RunScope = { ...s, phase: if (scopeAdmitted(s)) QueuedRead else ScopeSettled }
pure def canPerformRead(s: RunScope): bool = s.phase == QueuedRead
pure def performRead(s: RunScope): RunScope =
  { ...s, phase: ScopeSettled, read: scopeAdmitted(s), authorityAtRead: s.owner and s.sourceValid, peerAtRead: s.peer }
pure def passMidnight(s: RunScope): RunScope = { ...s, day: s.day + 1 }
pure def canRevokeOwner(s: RunScope): bool = s.owner
pure def revokeOwner(s: RunScope): RunScope = { ...s, owner: false }
pure def canDowngradePeer(s: RunScope): bool = s.peer > 1
pure def downgradePeer(s: RunScope): RunScope = { ...s, peer: s.peer - 1 }
pure val peerValues = Set(3, 4, 5)
pure def alwaysOnlyReviewedRead(s: RunScope): bool =
  s.read implies s.authorityAtRead and s.capturedDay == s.runDay and peerUnderstands(s.relative, s.peerAtRead)
pure def alwaysInvalidSourceNeverReads(s: RunScope): bool = not(s.sourceValid) implies not(s.read)
pure def stepResolutionStaysPinned(before: RunScope, after: RunScope): bool = before.capturedDay >= 0 implies after.capturedDay == before.capturedDay
pure def sometimesRelativeReadAfterMidnight(s: RunScope): bool = s.read and s.relative and s.day > s.runDay
pure def sometimesFixedRangeOnOldDevice(s: RunScope): bool = s.read and not(s.relative) and s.peerAtRead == 3
pure def sometimesDowngradeBlocksRelativeRead(s: RunScope): bool = s.phase == ScopeSettled and s.relative and not(s.read) and s.authorityAtRead and s.peerAtRead == 4
```

### A proposed read always settles

Resolution, queueing and the read are the host's own steps; none waits on
the owner. Every proposed read therefore ends settled, read or refused.

```quint
pure val fair_resolveScope = "weak"
pure val fair_queueRead = "weak"
pure val fair_performRead = "weak"
pure def leadsToScopeSettles(s: RunScope, later: RunScope): bool =
  (s.phase == Proposed or s.phase == Resolved or s.phase == QueuedRead) implies later.phase == ScopeSettled
```
