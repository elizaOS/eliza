# Workflow calendar run scope

A reviewed workflow step can read the owner's calendar on the device. The
owner reviewed the range the step names, so the read must stay inside that
range even when the run is dispatched late, crosses midnight, or meets an
older device. Ported from the device-action workflow run-scope model. The
[approvals](./approvals.md) spec owns the rest of a device step's reviewed
scope; [schedule](./schedule.md) owns the occurrence that anchors the run.

## Story: A reviewed calendar read stays inside its run's scope

> As the owner, I want a workflow that reads "today's events" to read the
> day of the run I reviewed, from a device that understands that range, and
> never a range nobody reviewed.

### A relative range resolves from the run's own day and needs a device that understands it

A new relative range resolves from the persisted scheduled occurrence or
the manual run start, so a delayed dispatch keeps the run's day. It needs
device protocol five. An older run whose range was already queued under the
legacy protocol keeps that range and needs protocol four; it stays readable
on its own day and, after midnight, only during the short review carry-over. An older
run with no queued range cannot create one. A fixed range keeps its dates
and needs no newer protocol. Once resolved, the range never moves. A read
happens only while the owner and the source are still authorized and the
device still speaks the protocol the range needs.

```quint
type ScopePhase = NoProposal | Proposed | Resolved | QueuedRead | ScopeSettled
type RunScope = { phase: ScopePhase, relative: bool, anchored: bool, legacyQueued: bool, peer: int, sourceValid: bool, owner: bool, day: int, runDay: int, carryOver: bool, capturedDay: int, read: bool, authorityAtRead: bool, windowAtRead: bool, peerAtRead: int }
pure val initial: RunScope = { phase: NoProposal, relative: false, anchored: false, legacyQueued: false, peer: 0, sourceValid: false, owner: true, day: 0, runDay: 0, carryOver: false, capturedDay: -1, read: false, authorityAtRead: false, windowAtRead: false, peerAtRead: -1 }
pure def relativeProtocol(s: RunScope): int = if (s.anchored) 5 else 4
pure def scopeAdmitted(s: RunScope): bool = s.owner and s.sourceValid and (not(s.relative) or s.peer >= relativeProtocol(s))
pure def hasRange(s: RunScope): bool = not(s.relative) or s.anchored or s.legacyQueued
pure def windowCurrent(s: RunScope): bool =
  not(s.relative) or (if (s.anchored) s.capturedDay == s.runDay else s.capturedDay == s.day or (s.carryOver and s.capturedDay == s.day - 1))
pure def canProposeRead(s: RunScope, relative: bool, anchored: bool, legacyQueued: bool, peer: int): bool =
  s.phase == NoProposal and peer > 0 and (legacyQueued implies relative and not(anchored))
pure def proposeRead(s: RunScope, relative: bool, anchored: bool, legacyQueued: bool, peer: int, sourceValid: bool): RunScope =
  { ...s, phase: Proposed, relative: relative, anchored: anchored, legacyQueued: legacyQueued, peer: peer, sourceValid: sourceValid, runDay: s.day, capturedDay: if (legacyQueued) s.day else -1 }
pure def canResolveScope(s: RunScope): bool = s.phase == Proposed
pure def resolveScope(s: RunScope): RunScope =
  { ...s, phase: if (scopeAdmitted(s) and hasRange(s)) Resolved else ScopeSettled, capturedDay: if (hasRange(s)) s.runDay else -1 }
pure def canQueueRead(s: RunScope): bool = s.phase == Resolved
pure def queueRead(s: RunScope): RunScope = { ...s, phase: if (scopeAdmitted(s)) QueuedRead else ScopeSettled }
pure def canPerformRead(s: RunScope): bool = s.phase == QueuedRead
pure def performRead(s: RunScope): RunScope =
  { ...s, phase: ScopeSettled, read: scopeAdmitted(s) and windowCurrent(s), authorityAtRead: s.owner and s.sourceValid, windowAtRead: windowCurrent(s), peerAtRead: s.peer }
pure def passMidnight(s: RunScope): RunScope = { ...s, day: s.day + 1, carryOver: true }
pure def canEndCarryOver(s: RunScope): bool = s.carryOver
pure def endCarryOver(s: RunScope): RunScope = { ...s, carryOver: false }
pure def canRevokeOwner(s: RunScope): bool = s.owner
pure def revokeOwner(s: RunScope): RunScope = { ...s, owner: false }
pure def canDowngradePeer(s: RunScope): bool = s.peer > 1
pure def downgradePeer(s: RunScope): RunScope = { ...s, peer: s.peer - 1 }
pure val peerValues = Set(3, 4, 5)
pure def alwaysOnlyReviewedRead(s: RunScope): bool =
  s.read implies s.authorityAtRead and s.windowAtRead and (not(s.relative) or s.peerAtRead >= relativeProtocol(s))
pure def alwaysInvalidSourceNeverReads(s: RunScope): bool = not(s.sourceValid) implies not(s.read)
pure def stepResolutionStaysPinned(before: RunScope, after: RunScope): bool = before.capturedDay >= 0 implies after.capturedDay == before.capturedDay
pure def sometimesAnchoredReadAfterMidnight(s: RunScope): bool = s.read and s.relative and s.anchored and s.day > s.runDay
pure def sometimesFixedRangeOnOldDevice(s: RunScope): bool = s.read and not(s.relative) and s.peerAtRead == 3
pure def sometimesLegacyRangeReadInCarryOver(s: RunScope): bool = s.read and s.legacyQueued and s.day > s.runDay
pure def sometimesExpiredLegacyRangeRefused(s: RunScope): bool = s.phase == ScopeSettled and s.legacyQueued and not(s.read) and s.authorityAtRead and not(s.windowAtRead)
pure def sometimesDowngradeBlocksAnchoredRead(s: RunScope): bool = s.phase == ScopeSettled and s.anchored and s.relative and not(s.read) and s.authorityAtRead and s.peerAtRead == 4
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
