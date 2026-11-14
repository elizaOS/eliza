# Trusted delivery audience and turn leases

The source is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`, `packages/core/src/security/trusted-delivery-audience.ts`. The `RuntimeCaller` sender is supplied by the owning trusted runtime boundary and is excluded from decoded event payloads. HTTP and model inputs use `ExternalCaller`; they cannot attest audiences, acquire leases or renew authority. A private symbol identifies a WeakMap record bound to the owning runtime. Ordinary in-process message spreads retain it, serialized messages cannot. The record owns the attestation sequence, exact audience and renewable turn lease. Reference-counted internal actors are modeled separately below.

## Story: Renew audience evidence only for the same active turn

As an owner, I disclose private data only into a verified destination with the current actor, agent, owner and participant census. An expired attestation can renew during its active uncancelled turn after fresh authority checks. Renewal preserves exact audience identity and rejects replaced leases or changed membership.

### Attestation binds an exact runtime and audience

```quint
type AudienceCaller = RuntimeCaller | ExternalCaller
type AudienceKind = Direct | VoicePrivate | ApiPrivate | InternalAgent | External
type Audience = { runtime: str, actor: str, agent: str, room: str, owner: str, kind: AudienceKind, canonicalRoom: bool, authenticatedOwnerApi: bool, participants: Set[str] }
type AudienceLease = { attached: bool, audience: Audience, issuedAt: int, expiresAt: int, now: int, sequence: int, currentLease: int, nextLease: int, leaseActive: bool, cancelled: bool, renewing: bool, capturedLease: int, capturedSequence: int, sensitiveUsed: bool, allowed: bool, suppressions: Set[str] }
pure val noAudience: Audience = { runtime: "", actor: "", agent: "", room: "", owner: "", kind: External, canonicalRoom: false, authenticatedOwnerApi: false, participants: Set() }
pure val initial: AudienceLease = { attached: false, audience: noAudience, issuedAt: 0, expiresAt: 0, now: 0, sequence: 0, currentLease: 0, nextLease: 1, leaseActive: false, cancelled: false, renewing: false, capturedLease: 0, capturedSequence: 0, sensitiveUsed: false, allowed: false, suppressions: Set() }
pure val audienceValues = Set({ runtime: "runtime1", actor: "owner", agent: "agent", room: "room", owner: "owner", kind: Direct, canonicalRoom: true, authenticatedOwnerApi: false, participants: Set("owner", "agent") }, { runtime: "runtime1", actor: "owner", agent: "agent", room: "room", owner: "owner", kind: Direct, canonicalRoom: true, authenticatedOwnerApi: false, participants: Set("owner", "agent", "guest") })
pure val byValues = Set(RuntimeCaller, ExternalCaller)
pure val runtimeIdValues = Set("runtime1", "runtime2")
pure val leaseValues = Set(1, 2, 3)
pure val lifetimeValues = Set(1000, 300000)
pure def sameAudience(left: Audience, right: Audience): bool = left.runtime == right.runtime and left.actor == right.actor and left.agent == right.agent and left.room == right.room and left.owner == right.owner and left.kind == right.kind and left.canonicalRoom == right.canonicalRoom and left.authenticatedOwnerApi == right.authenticatedOwnerApi and left.participants.subseteq(right.participants) and right.participants.subseteq(left.participants)
pure val leftValues = audienceValues
pure val rightValues = audienceValues
pure def canAttest(s: AudienceLease, by: AudienceCaller, audience: Audience, lifetime: int): bool = by == RuntimeCaller and audience.runtime != "" and lifetime > 0
pure def attest(s: AudienceLease, by: AudienceCaller, audience: Audience, lifetime: int): AudienceLease = { ...s, attached: true, audience: audience, sequence: s.sequence + 1, issuedAt: s.now, expiresAt: s.now + lifetime, leaseActive: false, currentLease: 0, sensitiveUsed: s.attached and s.audience.runtime == audience.runtime and s.sensitiveUsed, allowed: false }
pure def canBeginTurn(s: AudienceLease, by: AudienceCaller, runtimeId: str): bool = by == RuntimeCaller and s.attached and s.audience.runtime == runtimeId and s.expiresAt > s.now and s.issuedAt <= s.now + 5000
pure def beginTurn(s: AudienceLease, by: AudienceCaller, runtimeId: str): AudienceLease = { ...s, currentLease: s.nextLease, nextLease: s.nextLease + 1, leaseActive: true, cancelled: false }
pure def canEndTurn(s: AudienceLease, by: AudienceCaller): bool = by == RuntimeCaller
pure def endTurn(s: AudienceLease, by: AudienceCaller, lease: int): AudienceLease = if (lease == s.currentLease) { ...s, leaseActive: false, allowed: false } else s
pure def canCancel(s: AudienceLease, by: AudienceCaller): bool = by == RuntimeCaller
pure def cancel(s: AudienceLease, by: AudienceCaller): AudienceLease = { ...s, cancelled: true, allowed: false }
pure def canSetTime(s: AudienceLease, by: AudienceCaller, time: int): bool = by == RuntimeCaller and time >= 0
pure def setTime(s: AudienceLease, by: AudienceCaller, time: int): AudienceLease = { ...s, now: time, allowed: false }
pure val timeValues = Set(0, 1001, 300001)
```

### Renewal rechecks lease identity and audience after the authority await

```quint
pure def canBeginRenewal(s: AudienceLease, by: AudienceCaller, runtimeId: str): bool = by == RuntimeCaller and s.attached and s.audience.runtime == runtimeId and s.leaseActive and not(s.cancelled) and not(s.renewing) and s.now >= s.expiresAt
pure def beginRenewal(s: AudienceLease, by: AudienceCaller, runtimeId: str): AudienceLease = { ...s, renewing: true, capturedLease: s.currentLease, capturedSequence: s.sequence }
pure def canFinishRenewal(s: AudienceLease, by: AudienceCaller, audience: Audience, verified: bool, lifetime: int): bool = by == RuntimeCaller and s.renewing and lifetime > 0
pure def finishRenewal(s: AudienceLease, by: AudienceCaller, audience: Audience, verified: bool, lifetime: int): AudienceLease =
  if (verified and s.leaseActive and not(s.cancelled) and s.currentLease == s.capturedLease and s.sequence == s.capturedSequence and sameAudience(s.audience, audience)) { ...s, renewing: false, sequence: s.sequence + 1, issuedAt: s.now, expiresAt: s.now + lifetime, allowed: false }
  else { ...s, renewing: false }
pure def privateAudience(audience: Audience, internalActorTrusted: bool): bool =
  if (audience.kind == InternalAgent) audience.canonicalRoom and (audience.actor == audience.agent or audience.actor == audience.owner or internalActorTrusted) and audience.participants.contains(audience.actor) and audience.participants.contains(audience.agent)
  else audience.owner != "" and audience.actor == audience.owner and audience.actor != audience.agent and audience.participants.size() == 2 and audience.participants.contains(audience.actor) and audience.participants.contains(audience.agent) and (((audience.kind == Direct or audience.kind == VoicePrivate) and audience.canonicalRoom) or (audience.kind == ApiPrivate and audience.authenticatedOwnerApi))
pure def checkDisclosure(s: AudienceLease, by: AudienceCaller, runtimeId: str, internalActorTrusted: bool, currentAudience: Audience, lookupSucceeded: bool): AudienceLease = { ...s, allowed: by == RuntimeCaller and s.attached and s.audience.runtime == runtimeId and s.expiresAt > s.now and s.issuedAt <= s.now + 5000 and lookupSucceeded and sameAudience(s.audience, currentAudience) and privateAudience(s.audience, internalActorTrusted) }
pure val currentAudienceValues = audienceValues
pure def alwaysAllowedEvidenceIsFresh(s: AudienceLease): bool = s.allowed implies (s.attached and s.expiresAt > s.now and s.issuedAt <= s.now + 5000)
pure def alwaysLeaseCountersAreValid(s: AudienceLease): bool = s.nextLease > s.currentLease and s.currentLease >= 0 and s.sequence >= 0
pure def sometimesRenewedTurn(s: AudienceLease): bool = s.sequence > 1 and s.leaseActive and s.expiresAt > s.now
```

### Sensitive-use and suppression evidence stays attached to the exact turn

A successful authorization records that the turn consumed private information. Actual withholding sites record denial reasons as a set so later context contains the complete suppression notice. Re-attestation by the same runtime retains the sensitive-use marker.

```quint
pure def canMarkSensitiveUsed(s: AudienceLease, by: AudienceCaller): bool = by == RuntimeCaller and s.allowed
pure def markSensitiveUsed(s: AudienceLease, by: AudienceCaller): AudienceLease = { ...s, sensitiveUsed: true }
pure def canRecordSuppression(s: AudienceLease, by: AudienceCaller): bool = by == RuntimeCaller
pure def recordSuppression(s: AudienceLease, by: AudienceCaller, reason: str): AudienceLease = { ...s, suppressions: s.suppressions.union(Set(reason)) }
pure val reasonValues = Set("missing_attestation", "audience_changed", "runtime_mismatch")
pure def sometimesSensitiveUseRecorded(s: AudienceLease): bool = s.sensitiveUsed
```

### External event payloads cannot mint an attestation

```quint
pure def lawExternalCannotAttest(s: AudienceLease, audience: Audience, lifetime: int): bool = not(canAttest(s, ExternalCaller, audience, lifetime))
pure def lawExternalCannotRenew(s: AudienceLease, runtimeId: str): bool = not(canBeginRenewal(s, ExternalCaller, runtimeId))
```
