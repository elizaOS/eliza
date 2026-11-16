# Document source references and verified reopening

A note or answer can keep a link to the document it came from, and the
owner can reopen that exact document later. The device keeps a reference
to the selected file and its read grant while a saved or restorable note
still links to it. The [scan contract](./scan/review.md)
owns the separate PDF export.

## Story: Keep a source link and reopen the exact document I reviewed

> As the owner, I want a note or answer to keep a link to the document it
> came from, and opening it to show that exact document or say it changed.

### Link metadata names approved content without authorizing a read

A version-1 document link names the original SHA-256, MIME and size.
It accepts PDF, PNG, JPEG, WebP or plain text, a nonempty name no longer
than 120 UTF-16 units without path separators, C0 controls or DEL, and
an integral size from zero through 5 MiB. The normalized descriptor
drops extra properties and strips a malformed optional reference while
preserving the file identity. A device reference is derived from the
file's content URI and a browser reference from its local file ID;
neither asserts that the file still exists, and neither is the digest of
the document bytes.

The byte review checks the safe filename, extension, MIME and leading
signature or UTF-8 bytes. Text requires fatal UTF-8 decoding and no
NUL. Text need not be nonempty. Reading rejects any input beyond 5 MiB
explicitly. A device link resolves only while its content URI still has
a persisted document or covering tree read permission; a link with no
retained capability can still ask the owner to pick matching bytes.

The bridge independently rechecks hash, byte count and MIME on reopening.
The newly read display name can differ when the bytes and type match.
A changed review generation is refused before the viewer handoff, which
requires a focused window. The viewer receives a temporary read-only copy
that expires after 15 minutes, and the handoff reports dispatch, not that
the owner viewed the file.

```quint
type SourceMime = Pdf | Png | Jpeg | Webp | PlainText | Unsupported
type LinkRef = NoRef | AndroidRef | BrowserRef | MalformedRef
type SourceDescriptor = { schema: int, nameUnits: int, safeName: bool, mime: SourceMime, digest: str, hashValid: bool, bytes: int }
pure val descriptorValues = Set(
  { schema: 1, nameUnits: 10, safeName: true, mime: Pdf, digest: "approved", hashValid: true, bytes: 100 },
  { schema: 1, nameUnits: 10, safeName: true, mime: Pdf, digest: "changed", hashValid: true, bytes: 100 },
  { schema: 1, nameUnits: 5, safeName: true, mime: PlainText, digest: "empty", hashValid: true, bytes: 0 },
  { schema: 1, nameUnits: 121, safeName: true, mime: Pdf, digest: "approved", hashValid: true, bytes: 100 }
)
pure def validDescriptor(descriptor: SourceDescriptor): bool =
  descriptor.schema == 1 and descriptor.nameUnits > 0 and descriptor.nameUnits <= 120 and descriptor.safeName and
    descriptor.mime != Unsupported and descriptor.hashValid and descriptor.bytes >= 0 and descriptor.bytes <= 5242880
pure def keepsReference(descriptor: SourceDescriptor, ref: LinkRef): bool =
  validDescriptor(descriptor) and (ref == AndroidRef or ref == BrowserRef)
pure def selectedDocumentAllowed(descriptor: SourceDescriptor, extensionMatches: bool, contentMatches: bool): bool =
  validDescriptor(descriptor) and extensionMatches and contentMatches
pure def exactSourceBytes(descriptor: SourceDescriptor, mime: SourceMime, digest: str, bytes: int): bool =
  validDescriptor(descriptor) and descriptor.mime == mime and descriptor.digest == digest and descriptor.bytes == bytes
pure def allowsSourceDispatch(exactBytes: bool, contentAccepted: bool, accessible: bool, approved: bool, currentGeneration: bool, focused: bool): bool =
  exactBytes and contentAccepted and accessible and approved and currentGeneration and focused
pure def lawMalformedReferenceDoesNotSurvive(descriptor: SourceDescriptor): bool =
  not(keepsReference(descriptor, MalformedRef))
pure def lawChangedBytesCannotMatch(descriptor: SourceDescriptor, mime: SourceMime, digest: str, bytes: int): bool =
  (descriptor.mime != mime or descriptor.digest != digest or descriptor.bytes != bytes) implies not(exactSourceBytes(descriptor, mime, digest, bytes))
pure def lawLostGenerationCannotDispatch(exactBytes: bool, contentAccepted: bool, accessible: bool, approved: bool, focused: bool): bool =
  not(allowsSourceDispatch(exactBytes, contentAccepted, accessible, approved, false, focused))
pure def lawOversizedSourceCannotBeLinked(descriptor: SourceDescriptor): bool = descriptor.bytes > 5242880 implies not(validDescriptor(descriptor))
```

### Reconciliation keeps live and restorable links, picker leases and covering tree grants

The device stores each reference with its retain time, writing the time
before the mapping. A new reference can be kept only with an eligible persisted read grant,
a bounded content URI, and room in the 128-entry store. Retaining an
existing reference refreshes its time even when there is no room for a
new entry. A failed mapping commit cannot produce a retained receipt.
A stored time without a mapping is cleanup data.

Reconciliation requires the complete validated keep set of at most
20,000 identities, and fails whole if any is invalid. Notes collects the
links of saved notes and restorable Trash under its deletion lock. A reference without a keep entry survives for three
days after retain. A missing or future timestamp is seeded with now
before pruning, giving a rewound clock a full three-day hold. Only after reference removal commits can the host try to
release the exact URI grant. It rechecks all remaining references to
the URI and all picker selections. A covering tree grant must survive.
An already-revoked permission need not produce a release receipt.

```quint
type SourceStore = { picker: bool, directGrant: bool, treeGrant: bool, retained: bool, liveLink: bool, trashLink: bool, otherRef: bool, retainTime: int, clock: int }
pure val initial: SourceStore = { picker: false, directGrant: false, treeGrant: false, retained: false, liveLink: false, trashLink: false, otherRef: false, retainTime: -1, clock: 0 }
pure def canSelectSource(s: SourceStore, direct: bool, tree: bool): bool = not(s.picker) and (direct or tree)
pure def selectSource(s: SourceStore, direct: bool, tree: bool): SourceStore =
  { ...s, picker: true, directGrant: s.directGrant or direct, treeGrant: s.treeGrant or tree }
pure def canRetainSource(s: SourceStore, exactBytes: bool, hasRoom: bool): bool =
  s.picker and (s.directGrant or s.treeGrant) and exactBytes and (hasRoom or s.retained)
pure def retainSource(s: SourceStore, exactBytes: bool, hasRoom: bool, committed: bool): SourceStore =
  if (committed) { ...s, retained: true, retainTime: s.clock } else s
pure def canSetKeepFacts(s: SourceStore, savedLink: bool, restorableLink: bool, sameUriReference: bool): bool =
  s.liveLink != savedLink or s.trashLink != restorableLink or s.otherRef != sameUriReference
pure def setKeepFacts(s: SourceStore, savedLink: bool, restorableLink: bool, sameUriReference: bool): SourceStore =
  { ...s, liveLink: savedLink, trashLink: restorableLink, otherRef: sameUriReference }
pure def canForgetPicker(s: SourceStore): bool = s.picker
pure def forgetPicker(s: SourceStore): SourceStore =
  { ...s, picker: false, directGrant: s.directGrant and (s.retained or s.otherRef) }
pure def canSetSourceClock(s: SourceStore, now: int): bool = now >= 0 and now != s.clock
pure def setSourceClock(s: SourceStore, now: int): SourceStore = { ...s, clock: now }
pure def canLoseDirectGrant(s: SourceStore): bool = s.directGrant
pure def loseDirectGrant(s: SourceStore): SourceStore = { ...s, directGrant: false }
pure def elapsedHold(retainTime: int, now: int): bool = retainTime >= 0 and now - retainTime >= 259200000
pure def canReconcileSource(s: SourceStore, validKeep: bool): bool = s.retained and validKeep
pure def reconcileSource(s: SourceStore, validKeep: bool, committed: bool): SourceStore =
  if (not(committed)) s
  else if (s.retainTime < 0 or s.retainTime > s.clock) { ...s, retainTime: s.clock }
  else if (not(s.liveLink or s.trashLink) and elapsedHold(s.retainTime, s.clock))
    { ...s, retained: false, retainTime: -1, directGrant: s.directGrant and (s.picker or s.otherRef) }
  else s
pure def linkedSourceAccessible(s: SourceStore): bool = s.retained and (s.directGrant or s.treeGrant)
pure def alwaysSourceClockValid(s: SourceStore): bool = s.clock >= 0
pure def alwaysRetainTimeBounded(s: SourceStore): bool = s.retainTime >= -1 and (not(s.retained) implies s.retainTime == -1)
pure def stepLinkAndHoldProtectReference(before: SourceStore, via: str, after: SourceStore): bool =
  via == "reconcileSource" and before.retained and (before.liveLink or before.trashLink or not(elapsedHold(before.retainTime, before.clock))) implies after.retained
pure def stepForgetDoesNotDiscardRetainedGrant(before: SourceStore, via: str, after: SourceStore): bool =
  via == "forgetPicker" and (before.retained or before.otherRef) implies after.directGrant == before.directGrant
pure def stepReconcileDoesNotReleaseTree(before: SourceStore, via: str, after: SourceStore): bool =
  via == "reconcileSource" or via == "forgetPicker" implies after.treeGrant == before.treeGrant
pure def stepPickerProtectsExactGrant(before: SourceStore, via: str, after: SourceStore): bool =
  via == "reconcileSource" and before.picker implies after.directGrant == before.directGrant
pure def lawClockRewindDoesNotExpire(retainTime: int, now: int): bool =
  now < retainTime implies not(elapsedHold(retainTime, now))
pure def sometimesReopenAfterPicker(s: SourceStore): bool = not(s.picker) and linkedSourceAccessible(s)
pure def sometimesCanDropExpired(s: SourceStore): bool = s.retained and not(s.liveLink or s.trashLink) and elapsedHold(s.retainTime, s.clock)
pure val nowValues = Set(0, 1, 259200000, 259200001, 518400001)
pure val weight_selectSource = 5
pure val weight_retainSource = 6
pure val weight_setSourceClock = 4
```

### A summary link keeps the kind and authority of its source

Recording links require a nonblank safe label of at most 120 UTF-16 units,
a nonempty control-free note ID of at most 128, and a lowercase 64-digit
hex revision. The producer hashes the JSON encoding of the whole note.
The consumer rechecks the exact revision. Web links name the current
page at a safe HTTPS address of at most 4,096 units with no credentials
or control characters. The consumer rejects URLs its browser reading policy
treats as sensitive. It normalizes the URL and does not use a web link
as proof of the page's earlier bytes. A document link is still checked
by its own descriptor and fresh byte read. Browser navigation and
owner-approved sharing remain separate from this decoded link.

```quint
type SourceKind = DocumentLink | RecordingLink | WebLink
pure def sourceProvesPastBytes(kind: SourceKind, exactDigest: bool): bool = kind != WebLink and exactDigest
pure def lawWebLinkIsNotPastContentProof(exactDigest: bool): bool = not(sourceProvesPastBytes(WebLink, exactDigest))
```
