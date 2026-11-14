# Host-bound ingress persistence snapshots

Source `runtime/message-content-storage.ts` uses a WeakMap keyed by the routed message object. A host binding records a structured clone of the persisted Memory. Metadata supplied by a caller does not create a binding. Body and attachment redaction, segmented content projection and exact stored-segment validation remain the storage boundary described below.

## Story: Preserve a durable original through prompt-only augmentation

As a host, I want routing or prompt augmentation to retain the exact persisted original while rejecting an identity mismatch.

### Binding requires matching message agent room and entity identity

A persisted snapshot is keyed by object identity. Binding requires a present message id and exact message, agent, room and entity ids. A later change to any of these identities makes snapshot retrieval fail with `MESSAGE_CONTENT_PUBLICATION_CONFLICT`. Mutating prompt-only content leaves the cloned original unchanged. Inheritance copies a trusted binding only when the source object has one and the augmented object's identity still matches it.

```quint
type MessageIdentity = { messageId: str, agentId: str, roomId: str, entityId: str }
type MessageObject = { reference: str, identity: MessageIdentity, content: str }
type SnapshotRead = NoSnapshot | SnapshotFound({ identity: MessageIdentity, content: str }) | SnapshotConflict
type IngressSnapshots = { objects: List[MessageObject], bindings: List[MessageObject], lastRead: SnapshotRead }
pure val emptyIdentity: MessageIdentity = { messageId: "", agentId: "", roomId: "", entityId: "" }
pure val emptyObject: MessageObject = { reference: "", identity: emptyIdentity, content: "" }
pure val emptyBinding: MessageObject = { reference: "", identity: emptyIdentity, content: "" }
pure val initial: IngressSnapshots = { objects: List(), bindings: List(), lastRead: NoSnapshot }
pure def objectAt(s: IngressSnapshots, reference: str): MessageObject = s.objects.select(entry => entry.reference == reference).nthOr(0, emptyObject)
pure def bindingAt(s: IngressSnapshots, reference: str): MessageObject = s.bindings.select(entry => entry.reference == reference).nthOr(0, emptyBinding)
pure def installObject(s: IngressSnapshots, reference: str, identity: MessageIdentity, content: str): IngressSnapshots = { ...s, objects: if (s.objects.some(entry => entry.reference == reference)) s.objects.listMap(entry => if (entry.reference == reference) { reference: reference, identity: identity, content: content } else entry) else s.objects.append({ reference: reference, identity: identity, content: content }) }
pure def canBindSnapshot(s: IngressSnapshots, reference: str, identity: MessageIdentity): bool = reference != "" and s.objects.some(entry => entry.reference == reference) and identity.messageId != "" and objectAt(s, reference).identity == identity
pure def bindSnapshot(s: IngressSnapshots, reference: str, identity: MessageIdentity, content: str): IngressSnapshots = { ...s, bindings: s.bindings.select(entry => entry.reference != reference).append({ reference: reference, identity: identity, content: content }) }
pure def canInheritSnapshot(s: IngressSnapshots, sourceReference: str, targetReference: str): bool = s.bindings.some(entry => entry.reference == sourceReference) and canBindSnapshot(s, targetReference, bindingAt(s, sourceReference).identity)
pure def inheritSnapshot(s: IngressSnapshots, sourceReference: str, targetReference: str): IngressSnapshots = bindSnapshot(s, targetReference, bindingAt(s, sourceReference).identity, bindingAt(s, sourceReference).content)
pure def readSnapshot(s: IngressSnapshots, reference: str): IngressSnapshots = { ...s, lastRead: if (not(s.bindings.some(entry => entry.reference == reference))) NoSnapshot else if (objectAt(s, reference).identity != bindingAt(s, reference).identity) SnapshotConflict else SnapshotFound({ identity: bindingAt(s, reference).identity, content: bindingAt(s, reference).content }) }
pure def alwaysOneObjectAndBindingPerReference(s: IngressSnapshots): bool = s.objects.every(entry => s.objects.select(other => other.reference == entry.reference).length() == 1) and s.bindings.every(entry => s.bindings.select(other => other.reference == entry.reference).length() == 1)
pure def stepPromptMutationLeavesSnapshot(before: IngressSnapshots, via: str, after: IngressSnapshots): bool = via == "installObject" implies before.bindings == after.bindings
pure def sometimesSnapshotReturned(s: IngressSnapshots): bool = { val observation = s.lastRead
  match observation { SnapshotFound(data) => true | _ => false } }
pure def sometimesIdentityConflict(s: IngressSnapshots): bool = { val observation = s.lastRead
  match observation { SnapshotConflict => true | _ => false } }
pure val identityValues = Set({ messageId: "m1", agentId: "a1", roomId: "r1", entityId: "e1" }, { messageId: "m1", agentId: "a1", roomId: "r2", entityId: "e1" }, { messageId: "", agentId: "a1", roomId: "r1", entityId: "e1" })
```

### Reuse requires exact redacted content and every projected stored segment

An existing same-id row is reusable only when agent, room and entity match, and its content equals the raw, body-redacted or fully attachment-redacted candidate. A projected parent additionally requires all expected segment rows with exact identity, content and metadata, excluding only first-publication timestamps. A concurrent publication conflict triggers reread and the same comparison. Other errors retain their original failure. Without atomic segment support, oversized content fails before generic publication.

```quint
pure def reusableIngress(identityMatches: bool, exactContent: bool, projectedParentMatches: bool, allSegmentsMatch: bool): bool = identityMatches and (exactContent or (projectedParentMatches and allSegmentsMatch))
pure def publicationSupported(oversized: bool, atomicSegments: bool): bool = not(oversized) or atomicSegments
pure def lawIncompleteSegmentsCannotProveReuse(identityMatches: bool): bool = not(reusableIngress(identityMatches, false, true, false))
pure def lawConflictingIdentityCannotBeReused(exactContent: bool, projectedParentMatches: bool, allSegmentsMatch: bool): bool = not(reusableIngress(false, exactContent, projectedParentMatches, allSegmentsMatch))
pure def lawOversizedPublicationNeedsAtomicSegments(oversized: bool): bool = oversized implies not(publicationSupported(oversized, false))
```
