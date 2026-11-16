# Trusted delivery audience and turn leases

The source is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`, `packages/core/src/security/trusted-delivery-audience.ts`. The trusted runtime supplies `RuntimeCaller` separately from decoded payloads. HTTP and model inputs cannot attest audiences, acquire leases or renew authority. This component owns one binding's retained record, lease and asynchronous renewal identities. The [shared registry](./audienceRegistry.md) owns message aliases, the process-wide attestation sequence and independent suppression carriers. Numeric identities denote exact source objects, not payload labels. Returned-call history is a verification observation, not an added runtime registry.

## Story: Renew audience evidence only for the same active turn

As an owner, I disclose private data only into a verified destination with the current actor, agent, owner and participant census. An expired attestation can renew during its active uncancelled turn after fresh authority checks. Renewal preserves exact audience identity and rejects a replaced or ended lease. Concurrent calls can capture the same lease, and each keeps its original record through reattestation.

### Attestation binds an exact runtime and audience

Reattestation installs a fresh record with no inherited lease. It retains the old record while a callback or release closure can still reference it. Sensitive-use history is copied only when the preceding record belongs to the same runtime. A new turn installs one fresh lease on its record; releasing an older lease never removes a newer one. The audience retains all ten source destination kinds and exactly one of the three source provenance variants; private-disclosure classification derives from that provenance. Renewal compares the exact kind and provenance even when both destinations deny private disclosure.

```quint
type AudienceCaller = RuntimeCaller | ExternalCaller
type AudienceKind = Direct | Group | Channel | Public | ApiPrivate | ApiExternal | VoicePrivate | VoiceShared | InternalAgent | Unknown
type AudienceProvenance = CanonicalRoom | AuthenticatedOwnerApi | ServiceGateway
type Audience = { runtime: str, actor: str, agent: str, room: str, owner: str, kind: AudienceKind, provenance: AudienceProvenance, participants: Set[str] }
type AudienceEvidence = { audience: Audience, sequence: int, issuedAt: int, expiresAt: int }
type AudienceRecord = {id: int, evidence: AudienceEvidence, installedLease: int, sensitiveUsed: bool}
type AudienceTurnLease = {id: int, recordId: int, active: bool, signal: int}
type RenewalPhase = AwaitingAuthority | AuthorityReady | RenewalReturned
type AuthorityObservation = VerifiedAudience({audience: Audience}) | VerificationUnavailable | PrincipalRevoked | AudienceLookupFailed
type RenewalResult = RenewalPending | RenewalSucceeded | RenewalNoActiveTurn | RenewalTurnCancelled | RenewalAudienceChanged | RenewalVerificationUnavailable | RenewalPrincipalRevoked | RenewalLookupFailed
type AudienceRenewal = {id: int, recordId: int, leaseId: int, captured: AudienceEvidence, capturedNow: int, phase: RenewalPhase, authority: AuthorityObservation, derived: AudienceEvidence, resultKind: RenewalResult, returnedAt: int}
type AudienceLease = {records: List[AudienceRecord], leases: List[AudienceTurnLease], renewals: List[AudienceRenewal], boundRecord: int, nextRecord: int, nextLease: int, nextRenewal: int, now: int, allowed: bool}
pure val noAudience: Audience = { runtime: "", actor: "", agent: "", room: "", owner: "", kind: Unknown, provenance: ServiceGateway, participants: Set() }
pure val emptyEvidence: AudienceEvidence = {audience: noAudience, sequence: 0, issuedAt: 0, expiresAt: 0}
pure val noRecord: AudienceRecord = {id: 0, evidence: emptyEvidence, installedLease: 0, sensitiveUsed: false}
pure val noLease: AudienceTurnLease = {id: 0, recordId: 0, active: false, signal: 0}
pure val noRenewal: AudienceRenewal = {id: 0, recordId: 0, leaseId: 0, captured: emptyEvidence, capturedNow: 0, phase: RenewalReturned, authority: VerificationUnavailable, derived: emptyEvidence, resultKind: RenewalNoActiveTurn, returnedAt: 0}
pure val initial: AudienceLease = {records: List(), leases: List(), renewals: List(), boundRecord: 0, nextRecord: 1, nextLease: 1, nextRenewal: 1, now: 0, allowed: false}
pure val renewalLifetime = 300000
pure val audienceValues = Set({ runtime: "runtime1", actor: "owner", agent: "agent", room: "room", owner: "owner", kind: Direct, provenance: CanonicalRoom, participants: Set("owner", "agent") }, { runtime: "runtime1", actor: "owner", agent: "agent", room: "room", owner: "owner", kind: Direct, provenance: CanonicalRoom, participants: Set("owner", "agent", "guest") })
pure val byValues = Set(RuntimeCaller, ExternalCaller)
pure val runtimeIdValues = Set("runtime1", "runtime2")
pure val leaseValues = Set(1, 2, 3)
pure val signalValues = Set(0, 1, 2)
pure val renewalIdValues = Set(1, 2, 3, 4)
pure val sequenceValues = Set(1, 2, 3, 4, 5, 6)
pure val lifetimeValues = Set(1000, 300000)
pure val timeValues = Set(0, 1001, 300001, 301002)
pure val currentAudienceValues = audienceValues
pure val authorityValues = audienceValues.map(audience => VerifiedAudience({audience: audience})).union(Set(VerificationUnavailable, PrincipalRevoked, AudienceLookupFailed))
pure def recordAt(s: AudienceLease, recordId: int): AudienceRecord = s.records.select(record => record.id == recordId).nthOr(0, noRecord)
pure def currentRecord(s: AudienceLease): AudienceRecord = recordAt(s, s.boundRecord)
pure def turnLease(s: AudienceLease, lease: int): AudienceTurnLease = s.leases.select(entry => entry.id == lease).nthOr(0, noLease)
pure def renewalAt(s: AudienceLease, renewalId: int): AudienceRenewal = s.renewals.select(call => call.id == renewalId).nthOr(0, noRenewal)
pure def sameAudience(left: Audience, right: Audience): bool = left.runtime == right.runtime and left.actor == right.actor and left.agent == right.agent and left.room == right.room and left.owner == right.owner and left.kind == right.kind and left.provenance == right.provenance and left.participants.subseteq(right.participants) and right.participants.subseteq(left.participants)
pure def sameEvidence(left: AudienceEvidence, right: AudienceEvidence): bool = sameAudience(left.audience, right.audience) and left.sequence == right.sequence and left.issuedAt == right.issuedAt and left.expiresAt == right.expiresAt
pure def canAttest(s: AudienceLease, by: AudienceCaller, audience: Audience, lifetime: int, sequence: int): bool = by == RuntimeCaller and audience.runtime != "" and lifetime > 0 and sequence > 0
pure def attest(s: AudienceLease, by: AudienceCaller, audience: Audience, lifetime: int, sequence: int): AudienceLease = {
  val prior = currentRecord(s)
  val fresh: AudienceRecord = {id: s.nextRecord, evidence: {audience: audience, sequence: sequence, issuedAt: s.now, expiresAt: s.now + lifetime}, installedLease: 0, sensitiveUsed: prior.id != 0 and prior.evidence.audience.runtime == audience.runtime and prior.sensitiveUsed}
  { ...s, records: s.records.append(fresh), boundRecord: s.nextRecord, nextRecord: s.nextRecord + 1, allowed: false }
}
pure def canBeginTurn(s: AudienceLease, by: AudienceCaller, runtimeId: str, signal: int): bool = {
  val record = currentRecord(s)
  by == RuntimeCaller and signal >= 0 and record.id != 0 and record.evidence.audience.runtime == runtimeId and record.evidence.expiresAt > s.now and record.evidence.issuedAt <= s.now + 5000
}
pure def beginTurn(s: AudienceLease, by: AudienceCaller, runtimeId: str, signal: int): AudienceLease = {
  val lease: AudienceTurnLease = {id: s.nextLease, recordId: s.boundRecord, active: true, signal: signal}
  { ...s, leases: s.leases.append(lease), records: s.records.listMap(record => if (record.id == s.boundRecord) { ...record, installedLease: s.nextLease } else record), nextLease: s.nextLease + 1 }
}
pure def canEndTurn(s: AudienceLease, by: AudienceCaller, lease: int): bool = by == RuntimeCaller and turnLease(s, lease).id != 0
pure def endTurn(s: AudienceLease, by: AudienceCaller, lease: int): AudienceLease = {
  val captured = turnLease(s, lease)
  { ...s, leases: s.leases.listMap(entry => if (entry.id == lease) { ...entry, active: false } else entry), records: s.records.listMap(record => if (record.id == captured.recordId and record.installedLease == lease) { ...record, installedLease: 0 } else record), allowed: false }
}
pure def canSetTime(s: AudienceLease, by: AudienceCaller, time: int): bool = by == RuntimeCaller and time >= 0
pure def setTime(s: AudienceLease, by: AudienceCaller, time: int): AudienceLease = { ...s, now: time, allowed: false }
```

### Renewal rechecks lease identity and audience after the authority await

Every expired call captures its exact record, installed lease, audience and invocation time. There is no single-flight latch and no post-await audience-sequence fence in the pinned source. A derived audience consumes the registry's global sequence before final checks, including when those checks reject it. Renewal uses the fixed five-minute default TTL and the captured invocation time, not the clock when the await returns. A successful result can therefore already be expired; disclosure still checks the current clock.

Final checks address the captured record. Ending or replacing that record's lease, cancellation, or changed audience rejects the call. Reattestation instead replaces the WeakMap's mapped record: an old call can still succeed on its retained old record without changing the newly mapped evidence. Overlapping calls on one lease can both succeed; their completion order determines the last write to that record.

The adapter supplies the source's actor, room and agent preflight result as `identityMatches`. Each lease retains its exact signal reference, with zero denoting no signal. The component receives a live `signalAborted` observation; the shared registry owns the sticky signal facts, so all leases with the same signal observe its abort together. Beginning a turn may install an already-aborted signal, as the source does; renewal admission and final checks then refuse it. Authority failures retain their source classification. Their original thrown cause and reporting stay at the host boundary.

```quint
pure def canBeginRenewal(s: AudienceLease, by: AudienceCaller, runtimeId: str, identityMatches: bool, signalAborted: bool): bool = {
  val record = currentRecord(s)
  val lease = turnLease(s, record.installedLease)
  by == RuntimeCaller and record.id != 0 and record.evidence.audience.runtime == runtimeId and lease.id != 0 and lease.active and not(signalAborted) and identityMatches and s.now >= record.evidence.expiresAt
}
pure def beginRenewal(s: AudienceLease, by: AudienceCaller, runtimeId: str, identityMatches: bool, signalAborted: bool): AudienceLease = {
  val record = currentRecord(s)
  val call: AudienceRenewal = {id: s.nextRenewal, recordId: record.id, leaseId: record.installedLease, captured: record.evidence, capturedNow: s.now, phase: AwaitingAuthority, authority: VerificationUnavailable, derived: emptyEvidence, resultKind: RenewalPending, returnedAt: 0}
  { ...s, renewals: s.renewals.append(call), nextRenewal: s.nextRenewal + 1 }
}
pure def authorityDerived(authority: AuthorityObservation): bool = match authority { | VerifiedAudience(_) => true | _ => false }
pure def canObserveRenewalAuthority(s: AudienceLease, by: AudienceCaller, renewalId: int, authority: AuthorityObservation, sequence: int): bool = by == RuntimeCaller and renewalAt(s, renewalId).id != 0 and renewalAt(s, renewalId).phase == AwaitingAuthority and (if (authorityDerived(authority)) sequence > 0 else sequence == 0)
pure def observeRenewalAuthority(s: AudienceLease, by: AudienceCaller, renewalId: int, authority: AuthorityObservation, sequence: int): AudienceLease = {
  val call = renewalAt(s, renewalId)
  val derived = match authority { | VerifiedAudience(verified) => {audience: verified.audience, sequence: sequence, issuedAt: call.capturedNow, expiresAt: call.capturedNow + renewalLifetime} | _ => emptyEvidence }
  { ...s, renewals: s.renewals.listMap(entry => if (entry.id == renewalId) { ...entry, phase: AuthorityReady, authority: authority, derived: derived } else entry) }
}
pure def renewalResult(s: AudienceLease, call: AudienceRenewal, signalAborted: bool): RenewalResult = {
  val lease = turnLease(s, call.leaseId)
  val record = recordAt(s, call.recordId)
  val authority = call.authority
  match authority {
    | VerificationUnavailable => RenewalVerificationUnavailable
    | PrincipalRevoked => RenewalPrincipalRevoked
    | AudienceLookupFailed => RenewalLookupFailed
    | VerifiedAudience(_) => if (not(lease.active) or record.installedLease != call.leaseId) RenewalNoActiveTurn else if (signalAborted) RenewalTurnCancelled else if (not(sameAudience(call.captured.audience, call.derived.audience))) RenewalAudienceChanged else RenewalSucceeded
  }
}
pure def canFinishRenewal(s: AudienceLease, by: AudienceCaller, renewalId: int): bool = by == RuntimeCaller and renewalAt(s, renewalId).id != 0 and renewalAt(s, renewalId).phase == AuthorityReady
pure def finishRenewal(s: AudienceLease, by: AudienceCaller, renewalId: int, signalAborted: bool): AudienceLease = {
  val call = renewalAt(s, renewalId)
  val result = renewalResult(s, call, signalAborted)
  { ...s, records: if (result == RenewalSucceeded) s.records.listMap(record => if (record.id == call.recordId) { ...record, evidence: call.derived } else record) else s.records, renewals: s.renewals.listMap(entry => if (entry.id == renewalId) { ...entry, phase: RenewalReturned, resultKind: result, returnedAt: s.now } else entry), allowed: false }
}
pure def privateAudience(audience: Audience, internalActorTrusted: bool): bool =
  if (audience.kind == InternalAgent) audience.provenance == CanonicalRoom and (audience.actor == audience.agent or audience.actor == audience.owner or internalActorTrusted) and audience.participants.contains(audience.actor) and audience.participants.contains(audience.agent)
  else audience.owner != "" and audience.actor == audience.owner and audience.actor != audience.agent and audience.participants.size() == 2 and audience.participants.contains(audience.actor) and audience.participants.contains(audience.agent) and (((audience.kind == Direct or audience.kind == VoicePrivate) and audience.provenance == CanonicalRoom) or (audience.kind == ApiPrivate and audience.provenance == AuthenticatedOwnerApi))
pure def checkDisclosure(s: AudienceLease, by: AudienceCaller, runtimeId: str, internalActorTrusted: bool, currentAudience: Audience, lookupSucceeded: bool): AudienceLease = {
  val record = currentRecord(s)
  { ...s, allowed: by == RuntimeCaller and record.id != 0 and record.evidence.audience.runtime == runtimeId and record.evidence.expiresAt > s.now and record.evidence.issuedAt <= s.now + 5000 and lookupSucceeded and sameAudience(record.evidence.audience, currentAudience) and privateAudience(record.evidence.audience, internalActorTrusted) }
}
pure def alwaysAllowedEvidenceIsFresh(s: AudienceLease): bool = s.allowed implies (currentRecord(s).id != 0 and currentRecord(s).evidence.expiresAt > s.now and currentRecord(s).evidence.issuedAt <= s.now + 5000)
pure def alwaysLeaseCountersAreValid(s: AudienceLease): bool = s.nextRecord > 0 and s.nextLease > 0 and s.nextRenewal > 0 and (s.boundRecord == 0 or s.records.some(record => record.id == s.boundRecord)) and s.records.every(record => record.id > 0 and record.id < s.nextRecord and record.evidence.sequence > 0 and s.records.select(other => other.id == record.id).length() == 1) and s.leases.every(lease => lease.id > 0 and lease.id < s.nextLease and lease.signal >= 0 and s.leases.select(other => other.id == lease.id).length() == 1) and s.renewals.every(call => call.id > 0 and call.id < s.nextRenewal and s.renewals.select(other => other.id == call.id).length() == 1)
pure def alwaysCapturedObjectsRetained(s: AudienceLease): bool = s.leases.every(lease => s.records.some(record => record.id == lease.recordId)) and s.records.every(record => record.installedLease == 0 or s.leases.some(lease => lease.id == record.installedLease and lease.recordId == record.id)) and s.renewals.every(call => s.records.some(record => record.id == call.recordId) and s.leases.some(lease => lease.id == call.leaseId and lease.recordId == call.recordId) and call.captured.sequence > 0)
pure def alwaysDerivedTimeIsCaptured(s: AudienceLease): bool = s.renewals.every(call => if (call.phase != AwaitingAuthority and authorityDerived(call.authority)) call.derived.sequence > 0 and call.derived.issuedAt == call.capturedNow and call.derived.expiresAt == call.capturedNow + renewalLifetime else sameEvidence(call.derived, emptyEvidence))
pure def sometimesRenewedTurn(s: AudienceLease): bool = s.renewals.some(call => call.resultKind == RenewalSucceeded) and currentRecord(s).evidence.expiresAt > s.now
pure def sometimesOverlappingRenewalsSucceed(s: AudienceLease): bool = s.renewals.some(left => left.resultKind == RenewalSucceeded and s.renewals.some(right => right.id != left.id and right.leaseId == left.leaseId and right.resultKind == RenewalSucceeded))
pure def sometimesDetachedRenewalSucceeds(s: AudienceLease): bool = s.renewals.some(call => call.resultKind == RenewalSucceeded and call.recordId != s.boundRecord)
pure def sometimesRenewalReturnsExpired(s: AudienceLease): bool = s.renewals.some(call => call.resultKind == RenewalSucceeded and call.derived.expiresAt <= call.returnedAt)
```

### Sensitive-use and suppression evidence stays attached to the exact turn

Sensitive-use belongs to the selected record and survives renewal of that record. Reattestation copies it only from the same runtime. Suppression reasons belong to a separate lazily attached message carrier, including messages without an audience binding. A spread shares the carrier only if it already existed when copied; JSON loses it. The shared registry owns those carrier identities and uses this monotone set operation.

```quint
pure def canMarkSensitiveUsed(s: AudienceLease, by: AudienceCaller): bool = by == RuntimeCaller and s.allowed
pure def markSensitiveUsed(s: AudienceLease, by: AudienceCaller): AudienceLease = { ...s, records: s.records.listMap(record => if (record.id == s.boundRecord) { ...record, sensitiveUsed: true } else record) }
pure def addSuppression(reasons: Set[str], reason: str): Set[str] = reasons.union(Set(reason))
pure def lawSuppressionKeepsReasons(reasons: Set[str], reason: str): bool = reasons.subseteq(addSuppression(reasons, reason)) and addSuppression(reasons, reason).contains(reason)
pure val reasonValues = Set("missing_attestation", "audience_changed", "runtime_mismatch")
pure def sometimesSensitiveUseRecorded(s: AudienceLease): bool = s.records.some(record => record.sensitiveUsed)
```

### External event payloads cannot mint an attestation

```quint
pure def lawExternalCannotAttest(s: AudienceLease, audience: Audience, lifetime: int): bool = not(canAttest(s, ExternalCaller, audience, lifetime, 1))
pure def lawExternalCannotRenew(s: AudienceLease, runtimeId: str): bool = not(canBeginRenewal(s, ExternalCaller, runtimeId, true, false))
```
