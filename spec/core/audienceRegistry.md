# Shared delivery audience bindings

The source is `packages/core/src/security/trusted-delivery-audience.ts:182-187,348-435,609-688,810-842`. This registry owns the process-wide attestation sequence, WeakMap binding objects and independent message suppression carriers. Each binding embeds [the audience record and lease protocol](./trustedAudience.md). Ordinary spreads copy the binding and any already-attached suppression carrier; JSON drops both. Reattestation replaces the mapped record, while an outstanding callback retains its old record. Runtime, binding, carrier and callback identities denote exact host objects, never payload labels.

## Story: Keep audience authority isolated while allowing exact in-process aliases

> As an owner, I want each message's delivery audience to keep its own
> lease even when copies of the message share it, so that one copy's
> renewal never widens what another may disclose.

### Binding objects share one global sequence and retain their own lease

Every binding and carrier has a positive unique identity. An unbound message has binding zero. A record's installed lease belongs to that record; returned callbacks retain their original record and lease through later reattestation. Only this registry allocates the process-wide attestation sequence. The component receives that sequence as an observation rather than keeping a second allocator.

```quint
import trustedAudience as A from "./trustedAudience"
type AudienceBindingRecord = {id: int, evidence: A::AudienceLease}
type AudienceMessage = {id: int, binding: int, carrier: int}
type SuppressionCarrier = {id: int, reasons: Set[str]}
type AudienceRegistry = {records: List[AudienceBindingRecord], messages: List[AudienceMessage], carriers: List[SuppressionCarrier], abortedSignals: Set[int], nextBinding: int, nextCarrier: int, attestationSequence: int, now: int}
pure val initial: AudienceRegistry = {records: List(), messages: List(), carriers: List(), abortedSignals: Set(), nextBinding: 1, nextCarrier: 1, attestationSequence: 0, now: 0}
pure val emptyBinding: AudienceBindingRecord = {id: 0, evidence: A::initial}
pure val emptyCarrier: SuppressionCarrier = {id: 0, reasons: Set()}
pure val emptyMessage: AudienceMessage = {id: 0, binding: 0, carrier: 0}
pure val byValues = A::byValues
pure val audienceValues = A::audienceValues
pure val currentAudienceValues = A::currentAudienceValues
pure val authorityValues = A::authorityValues
pure val runtimeIdValues = A::runtimeIdValues
pure val lifetimeValues = A::lifetimeValues
pure val leaseValues = A::leaseValues
pure val signalValues = A::signalValues
pure val renewalIdValues = A::renewalIdValues
pure val bindingIdValues = Set(1, 2, 3)
pure val timeValues = A::timeValues
pure val reasonValues = A::reasonValues
pure val messageIdValues = Set(1, 2, 3)
pure val copyIdValues = messageIdValues
pure def messageAt(s: AudienceRegistry, messageId: int): AudienceMessage = s.messages.select(message => message.id == messageId).nthOr(0, emptyMessage)
pure def messageBinding(s: AudienceRegistry, messageId: int): int = messageAt(s, messageId).binding
pure def bindingEvidence(s: AudienceRegistry, bindingId: int): A::AudienceLease = s.records.select(record => record.id == bindingId).nthOr(0, emptyBinding).evidence
pure def evidenceAt(s: AudienceRegistry, messageId: int): A::AudienceLease = bindingEvidence(s, messageBinding(s, messageId))
pure def replaceEvidence(evidence: A::AudienceLease, bindingId: int, s: AudienceRegistry): AudienceRegistry = { ...s, records: s.records.listMap(record => if (record.id == bindingId) { ...record, evidence: evidence } else record) }
pure def canCreateMessage(s: AudienceRegistry, messageId: int): bool = messageId > 0 and not(s.messages.some(message => message.id == messageId))
pure def createMessage(s: AudienceRegistry, messageId: int): AudienceRegistry = { ...s, messages: s.messages.append({id: messageId, binding: 0, carrier: 0}) }
pure def canSpreadMessage(s: AudienceRegistry, messageId: int, copyId: int): bool = messageAt(s, messageId).id != 0 and canCreateMessage(s, copyId)
pure def spreadMessage(s: AudienceRegistry, messageId: int, copyId: int): AudienceRegistry = { ...s, messages: s.messages.append({ ...messageAt(s, messageId), id: copyId }) }
pure def canSerializeMessage(s: AudienceRegistry, messageId: int, copyId: int): bool = canSpreadMessage(s, messageId, copyId)
pure def serializeMessage(s: AudienceRegistry, messageId: int, copyId: int): AudienceRegistry = { ...s, messages: s.messages.append({id: copyId, binding: 0, carrier: 0}) }
pure def canAttest(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, audience: A::Audience, lifetime: int): bool = messageAt(s, messageId).id != 0 and A::canAttest(evidenceAt(s, messageId), by, audience, lifetime, s.attestationSequence + 1)
pure def attest(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, audience: A::Audience, lifetime: int): AudienceRegistry = {
  val binding = if (messageBinding(s, messageId) == 0) s.nextBinding else messageBinding(s, messageId)
  val evidence = A::attest({ ...evidenceAt(s, messageId), now: s.now }, by, audience, lifetime, s.attestationSequence + 1)
  { ...s, records: if (messageBinding(s, messageId) == 0) s.records.append({id: binding, evidence: evidence}) else s.records.listMap(record => if (record.id == binding) { ...record, evidence: evidence } else record), messages: s.messages.listMap(message => if (message.id == messageId) { ...message, binding: binding } else message), nextBinding: if (messageBinding(s, messageId) == 0) s.nextBinding + 1 else s.nextBinding, attestationSequence: s.attestationSequence + 1 }
}
pure def canBeginTurn(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, runtimeId: str, signal: int): bool = A::canBeginTurn(evidenceAt(s, messageId), by, runtimeId, signal)
pure def beginTurn(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, runtimeId: str, signal: int): AudienceRegistry = replaceEvidence(A::beginTurn(evidenceAt(s, messageId), by, runtimeId, signal), messageBinding(s, messageId), s)
pure def canEndTurn(s: AudienceRegistry, by: A::AudienceCaller, bindingId: int, lease: int): bool = bindingId > 0 and A::canEndTurn(bindingEvidence(s, bindingId), by, lease)
pure def endTurn(s: AudienceRegistry, by: A::AudienceCaller, bindingId: int, lease: int): AudienceRegistry = replaceEvidence(A::endTurn(bindingEvidence(s, bindingId), by, lease), bindingId, s)
pure def signalIsAborted(s: AudienceRegistry, signal: int): bool = signal > 0 and s.abortedSignals.contains(signal)
pure def canCancel(s: AudienceRegistry, by: A::AudienceCaller, signal: int): bool = by == A::RuntimeCaller and signal > 0
pure def cancel(s: AudienceRegistry, by: A::AudienceCaller, signal: int): AudienceRegistry = { ...s, abortedSignals: s.abortedSignals.union(Set(signal)) }
pure def canSetTime(s: AudienceRegistry, by: A::AudienceCaller, time: int): bool = by == A::RuntimeCaller and time >= 0
pure def setTime(s: AudienceRegistry, by: A::AudienceCaller, time: int): AudienceRegistry = { ...s, now: time, records: s.records.listMap(record => { ...record, evidence: A::setTime(record.evidence, by, time) }) }
```

### Renewal validates the captured record after the asynchronous authority lookup

An invocation captures the binding, record, installed lease, exact audience and entry time. Overlapping calls are independent. A successful derivation consumes one global sequence even if its final lease or audience check rejects it. Completion installs that derived sequence on the captured record, not whichever record the WeakMap currently selects. Reattestation may leave a successful old result detached. A replaced or ended lease still rejects. Signal references are global opaque identities: one abort fact applies to every matching lease, including old records and independent bindings. Signal zero denotes absence and is never aborted. Captured-time expiry can already have passed when completion returns.

```quint
pure def canBeginRenewal(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, runtimeId: str, identityMatches: bool): bool = A::canBeginRenewal(evidenceAt(s, messageId), by, runtimeId, identityMatches, signalIsAborted(s, A::turnLease(evidenceAt(s, messageId), A::currentRecord(evidenceAt(s, messageId)).installedLease).signal))
pure def beginRenewal(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, runtimeId: str, identityMatches: bool): AudienceRegistry = replaceEvidence(A::beginRenewal(evidenceAt(s, messageId), by, runtimeId, identityMatches, signalIsAborted(s, A::turnLease(evidenceAt(s, messageId), A::currentRecord(evidenceAt(s, messageId)).installedLease).signal)), messageBinding(s, messageId), s)
pure def canObserveRenewalAuthority(s: AudienceRegistry, by: A::AudienceCaller, bindingId: int, renewalId: int, authority: A::AuthorityObservation): bool = bindingId > 0 and A::canObserveRenewalAuthority(bindingEvidence(s, bindingId), by, renewalId, authority, if (A::authorityDerived(authority)) s.attestationSequence + 1 else 0)
pure def observeRenewalAuthority(s: AudienceRegistry, by: A::AudienceCaller, bindingId: int, renewalId: int, authority: A::AuthorityObservation): AudienceRegistry = {
  val sequence = s.attestationSequence + (if (A::authorityDerived(authority)) 1 else 0)
  val evidence = A::observeRenewalAuthority(bindingEvidence(s, bindingId), by, renewalId, authority, if (A::authorityDerived(authority)) sequence else 0)
  { ...replaceEvidence(evidence, bindingId, s), attestationSequence: sequence }
}
pure def canFinishRenewal(s: AudienceRegistry, by: A::AudienceCaller, bindingId: int, renewalId: int): bool = bindingId > 0 and A::canFinishRenewal(bindingEvidence(s, bindingId), by, renewalId)
pure def finishRenewal(s: AudienceRegistry, by: A::AudienceCaller, bindingId: int, renewalId: int): AudienceRegistry = replaceEvidence(A::finishRenewal(bindingEvidence(s, bindingId), by, renewalId, signalIsAborted(s, A::turnLease(bindingEvidence(s, bindingId), A::renewalAt(bindingEvidence(s, bindingId), renewalId).leaseId).signal)), bindingId, s)
pure def checkDisclosure(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, runtimeId: str, internalActorTrusted: bool, currentAudience: A::Audience, lookupSucceeded: bool): AudienceRegistry = replaceEvidence(A::checkDisclosure(evidenceAt(s, messageId), by, runtimeId, internalActorTrusted, currentAudience, lookupSucceeded), messageBinding(s, messageId), s)
pure def canMarkSensitiveUsed(s: AudienceRegistry, by: A::AudienceCaller, messageId: int): bool = A::canMarkSensitiveUsed(evidenceAt(s, messageId), by)
pure def markSensitiveUsed(s: AudienceRegistry, by: A::AudienceCaller, messageId: int): AudienceRegistry = replaceEvidence(A::markSensitiveUsed(evidenceAt(s, messageId), by), messageBinding(s, messageId), s)
pure def alwaysRegistryIdentitiesAreUnique(s: AudienceRegistry): bool = s.nextBinding > 0 and s.nextCarrier > 0 and s.abortedSignals.forall(signal => signal > 0) and s.records.every(record => record.id > 0 and record.id < s.nextBinding and s.records.select(other => other.id == record.id).length() == 1) and s.carriers.every(carrier => carrier.id > 0 and carrier.id < s.nextCarrier and s.carriers.select(other => other.id == carrier.id).length() == 1) and s.messages.every(message => message.id > 0 and s.messages.select(other => other.id == message.id).length() == 1 and (message.binding == 0 or s.records.some(record => record.id == message.binding)) and (message.carrier == 0 or s.carriers.some(carrier => carrier.id == message.carrier)))
pure def alwaysGlobalAttestationSequenceDominates(s: AudienceRegistry): bool = s.attestationSequence >= 0 and s.records.every(record => record.evidence.now == s.now and record.evidence.records.every(entry => entry.evidence.sequence > 0 and entry.evidence.sequence <= s.attestationSequence) and record.evidence.renewals.every(call => call.derived.sequence == 0 or call.derived.sequence <= s.attestationSequence))
pure def alwaysEveryBindingRetainsLeaseRules(s: AudienceRegistry): bool = s.records.every(record => A::alwaysAllowedEvidenceIsFresh(record.evidence) and A::alwaysLeaseCountersAreValid(record.evidence) and A::alwaysCapturedObjectsRetained(record.evidence) and A::alwaysDerivedTimeIsCaptured(record.evidence))
pure def stepGlobalSequenceNeverDecreases(before: AudienceRegistry, via: str, after: AudienceRegistry): bool = after.attestationSequence >= before.attestationSequence
pure def sometimesAliasesShareBinding(s: AudienceRegistry): bool = s.messages.some(message => message.binding != 0 and s.messages.some(other => other.id != message.id and other.binding == message.binding))
pure def sometimesIndependentBindings(s: AudienceRegistry): bool = s.records.length() > 1
```

### Suppression aliases follow the separately attached message carrier

Recording a real withholding reason attaches a carrier if that message has none, including an unbound message. A spread made after attachment shares that Set. A spread made earlier does not gain a later attachment. Reattestation changes neither carrier identity nor reasons. Serialization carries no suppression Set.

```quint
pure def suppressionReasons(s: AudienceRegistry, messageId: int): Set[str] = s.carriers.select(carrier => carrier.id == messageAt(s, messageId).carrier).nthOr(0, emptyCarrier).reasons
pure def canRecordSuppression(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, reason: str): bool = messageAt(s, messageId).id != 0 and by == A::RuntimeCaller
pure def recordSuppression(s: AudienceRegistry, by: A::AudienceCaller, messageId: int, reason: str): AudienceRegistry = {
  val prior = messageAt(s, messageId).carrier
  val id = if (prior == 0) s.nextCarrier else prior
  { ...s, carriers: if (prior == 0) s.carriers.append({id: id, reasons: Set(reason)}) else s.carriers.listMap(carrier => if (carrier.id == id) { ...carrier, reasons: A::addSuppression(carrier.reasons, reason) } else carrier), messages: s.messages.listMap(message => if (message.id == messageId) { ...message, carrier: id } else message), nextCarrier: if (prior == 0) s.nextCarrier + 1 else s.nextCarrier }
}
pure def sometimesSharedSuppressionCarrier(s: AudienceRegistry): bool = s.messages.some(message => message.carrier != 0 and s.messages.some(other => other.id != message.id and other.carrier == message.carrier))
pure def sometimesSpreadBeforeSuppressionStaysIndependent(s: AudienceRegistry): bool = s.messages.some(message => message.carrier == 0 and s.messages.some(other => other.id != message.id and message.binding != 0 and other.binding == message.binding and other.carrier != 0))
```
