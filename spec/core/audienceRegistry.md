# Shared delivery audience bindings

The source is `packages/core/src/security/trusted-delivery-audience.ts:182-187,348-435,609-692`. The process-wide attestation sequence and WeakMap of binding objects are owned here. Each binding embeds [the audience lease protocol](./trustedAudience.md). Ordinary message spreads share the exact binding object; serialization drops it. Reattesting any alias replaces that shared record and discards its old lease. Runtime object identities are explicit opaque IDs supplied by the installed host, never user-provided labels.

## Story: Keep audience authority isolated while allowing exact in-process aliases

### Binding objects share one global sequence and retain their own lease

```quint
import trustedAudience as A from "./trustedAudience"
type AudienceBindingRecord = { id: int, evidence: A::AudienceLease }
type AudienceMessage = { id: int, binding: int }
type AudienceRegistry = { records: List[AudienceBindingRecord], messages: List[AudienceMessage], nextBinding: int, attestationSequence: int, now: int }
pure val initial: AudienceRegistry = { records: List(), messages: List(), nextBinding: 1, attestationSequence: 0, now: 0 }
pure val emptyBinding: AudienceBindingRecord = { id: 0, evidence: A::initial }
pure val byValues = A::byValues
pure val audienceValues = A::audienceValues
pure val currentAudienceValues = A::currentAudienceValues
pure val runtimeIdValues = A::runtimeIdValues
pure val lifetimeValues = A::lifetimeValues
pure val leaseValues = A::leaseValues
pure val timeValues = A::timeValues
pure val reasonValues = A::reasonValues
pure val messageIdValues = Set(1, 2, 3)
pure val copyIdValues = messageIdValues
pure def messageBinding(s: AudienceRegistry, messageId: int): int = s.messages.select(message => message.id == messageId).nthOr(0, { id: 0, binding: 0 }).binding
pure def evidenceAt(s: AudienceRegistry, messageId: int): A::AudienceLease = s.records.select(record => record.id == messageBinding(s, messageId)).nthOr(0, emptyBinding).evidence
pure def replaceEvidence(evidence: A::AudienceLease, messageId: int, s: AudienceRegistry): AudienceRegistry = { ...s, records: s.records.listMap(record => if (record.id == messageBinding(s, messageId)) { ...record, evidence: evidence } else record) }
pure def canCreateMessage(s: AudienceRegistry, messageId: int): bool = messageId > 0 and not(s.messages.some(message => message.id == messageId))
pure def createMessage(s: AudienceRegistry, messageId: int): AudienceRegistry = { ...s, messages: s.messages.append({ id: messageId, binding: 0 }) }
pure def canSpreadMessage(s: AudienceRegistry, messageId: int, copyId: int): bool = s.messages.some(message => message.id == messageId) and canCreateMessage(s, copyId)
pure def spreadMessage(s: AudienceRegistry, messageId: int, copyId: int): AudienceRegistry = { ...s, messages: s.messages.append({ id: copyId, binding: messageBinding(s, messageId) }) }
pure def canSerializeMessage(s: AudienceRegistry, messageId: int, copyId: int): bool = canSpreadMessage(s, messageId, copyId)
pure def serializeMessage(s: AudienceRegistry, messageId: int, copyId: int): AudienceRegistry = { ...s, messages: s.messages.append({ id: copyId, binding: 0 }) }
pure def canAttest(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, audience: A::Audience, lifetime: int): bool = s.messages.some(message => message.id == messageId) and A::canAttest(evidenceAt(s, messageId), by, audience, lifetime)
pure def attest(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, audience: A::Audience, lifetime: int): AudienceRegistry = {
  val binding = if (messageBinding(s, messageId) == 0) s.nextBinding else messageBinding(s, messageId)
  val evidence = { ...A::attest({ ...evidenceAt(s, messageId), now: s.now }, by, audience, lifetime), sequence: s.attestationSequence + 1 }
  { ...s, records: if (messageBinding(s, messageId) == 0) s.records.append({ id: binding, evidence: evidence }) else s.records.listMap(record => if (record.id == binding) { ...record, evidence: evidence } else record), messages: s.messages.listMap(message => if (message.id == messageId) { ...message, binding: binding } else message), nextBinding: if (messageBinding(s, messageId) == 0) s.nextBinding + 1 else s.nextBinding, attestationSequence: s.attestationSequence + 1 }
}
pure def canBeginTurn(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, runtimeId: str): bool = A::canBeginTurn(evidenceAt(s, messageId), by, runtimeId)
pure def beginTurn(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, runtimeId: str): AudienceRegistry = replaceEvidence(A::beginTurn(evidenceAt(s, messageId), by, runtimeId), messageId, s)
pure def canEndTurn(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, lease: int): bool = messageBinding(s, messageId) != 0 and A::canEndTurn(evidenceAt(s, messageId), by)
pure def endTurn(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, lease: int): AudienceRegistry = replaceEvidence(A::endTurn(evidenceAt(s, messageId), by, lease), messageId, s)
pure def canCancel(s: AudienceRegistry, by: A::AudienceCaller, messageId: int): bool = messageBinding(s, messageId) != 0 and A::canCancel(evidenceAt(s, messageId), by)
pure def cancel(s: AudienceRegistry, by: A::AudienceCaller, messageId: int): AudienceRegistry = replaceEvidence(A::cancel(evidenceAt(s, messageId), by), messageId, s)
pure def canSetTime(s: AudienceRegistry, by: A::AudienceCaller, time: int): bool = by == A::RuntimeCaller and time >= 0
pure def setTime(s: AudienceRegistry, by: A::AudienceCaller, time: int): AudienceRegistry = { ...s, now: time, records: s.records.listMap(record => { ...record, evidence: A::setTime(record.evidence, by, time) }) }
```

### Renewal validates the shared record after the asynchronous authority lookup

A successful derivation consumes one global sequence even if the renewed audience is rejected by the final identity check. Successful installation uses that sequence. Reattestation invalidates an outstanding renewal through its captured sequence; replacing a turn invalidates it through its lease identity.

```quint
pure def canBeginRenewal(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, runtimeId: str): bool = A::canBeginRenewal(evidenceAt(s, messageId), by, runtimeId)
pure def beginRenewal(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, runtimeId: str): AudienceRegistry = replaceEvidence(A::beginRenewal(evidenceAt(s, messageId), by, runtimeId), messageId, s)
pure def canFinishRenewal(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, audience: A::Audience, minted: bool, lifetime: int): bool = A::canFinishRenewal(evidenceAt(s, messageId), by, audience, minted, lifetime)
pure def finishRenewal(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, audience: A::Audience, minted: bool, lifetime: int): AudienceRegistry = {
  val before = evidenceAt(s, messageId)
  val renewed = A::finishRenewal(before, by, audience, minted, lifetime)
  val sequence = s.attestationSequence + (if (minted) 1 else 0)
  val evidence = if (renewed.sequence != before.sequence) { ...renewed, sequence: sequence } else renewed
  { ...replaceEvidence(evidence, messageId, s), attestationSequence: sequence }
}
pure def checkDisclosure(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, runtimeId: str, internalActorTrusted: bool, currentAudience: A::Audience, lookupSucceeded: bool): AudienceRegistry = replaceEvidence(A::checkDisclosure(evidenceAt(s, messageId), by, runtimeId, internalActorTrusted, currentAudience, lookupSucceeded), messageId, s)
pure def canMarkSensitiveUsed(s: AudienceRegistry, by: A::AudienceCaller, messageId: int): bool = A::canMarkSensitiveUsed(evidenceAt(s, messageId), by)
pure def markSensitiveUsed(s: AudienceRegistry, by: A::AudienceCaller, messageId: int): AudienceRegistry = replaceEvidence(A::markSensitiveUsed(evidenceAt(s, messageId), by), messageId, s)
pure def canRecordSuppression(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, reason: str): bool = messageBinding(s, messageId) != 0 and A::canRecordSuppression(evidenceAt(s, messageId), by)
pure def recordSuppression(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, reason: str): AudienceRegistry = replaceEvidence(A::recordSuppression(evidenceAt(s, messageId), by, reason), messageId, s)
pure def alwaysRegistryIdentitiesAreUnique(s: AudienceRegistry): bool = s.records.every(record => record.id > 0 and record.id < s.nextBinding and s.records.select(other => other.id == record.id).length() == 1) and s.messages.every(message => message.id > 0 and s.messages.select(other => other.id == message.id).length() == 1 and (message.binding == 0 or s.records.some(record => record.id == message.binding)))
pure def alwaysGlobalAttestationSequenceDominates(s: AudienceRegistry): bool = s.attestationSequence >= 0 and s.records.every(record => record.evidence.sequence > 0 and record.evidence.sequence <= s.attestationSequence and record.evidence.now == s.now)
pure def alwaysEveryBindingRetainsLeaseRules(s: AudienceRegistry): bool = s.records.every(record => A::alwaysAllowedEvidenceIsFresh(record.evidence) and A::alwaysLeaseCountersAreValid(record.evidence))
pure def stepGlobalSequenceNeverDecreases(before: AudienceRegistry, via: str, after: AudienceRegistry): bool = after.attestationSequence >= before.attestationSequence
pure def sometimesAliasesShareBinding(s: AudienceRegistry): bool = s.messages.some(message => message.binding != 0 and s.messages.some(other => other.id != message.id and other.binding == message.binding))
pure def sometimesIndependentBindings(s: AudienceRegistry): bool = s.records.length() > 1
```
