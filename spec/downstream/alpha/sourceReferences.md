# Alpha document source references and verified reopening

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` imports
Eliza `c518127a025ab173874af9c7d304f26b25213b0d` source validators from
`plugins/plugin-files/src/documents/source-links.ts`. The active Notes
and selected-file review adapters use `AlphaMailAttachments`, which binds
the pinned native-media `SourceReferenceStore`, `SelectedDocuments` and
`DocumentBytes`. Browser Files binds the corresponding browser attachment
review. The dialog checks the live note, selected source and review identity.
The [scan contract](../mobileDocumentScan.md) owns the separate PDF export.

## Story: Keep a source link and reopen the exact document I reviewed

### Link metadata names approved content without authorizing a read

A version-1 document link names the original SHA-256, MIME and size.
It accepts PDF, PNG, JPEG, WebP or plain text, a nonempty name no longer
than 120 UTF-16 units without path separators, C0 controls or DEL, and
an integral size from zero through 5 MiB. The normalized descriptor
drops extra properties and strips a malformed optional reference while
preserving the file identity. The admitted reference strings are
`a1:` plus 64 lowercase hex digits, and `b1:` plus 36 lowercase hex or
hyphen characters. The second pattern is lexical and does not assert
that the browser file still exists. The native key is derived from the
UTF-8 content URI, so its digest is separate from the digest of the
document bytes.

The byte review checks the safe filename, extension, MIME and leading
signature or UTF-8 bytes. Text requires fatal UTF-8 decoding and no
NUL. Text need not be nonempty. The browser also requires canonical
base64 and imposes a 7 MiB bound on the encoded string. Native streaming
reads the full selected content and rejects any input beyond 5 MiB.
A compatible limit failure is explicit. A retained browser link
reselects its local Files ID and forgets the temporary selection after
it settles. A native link resolves only when the mapped content URI
still has persisted document or covering tree read permission. A
linked source with no retained capability can still ask the user to
pick matching bytes.

The bridge independently rechecks hash, byte count and MIME on reopening.
The newly read display name can differ when the bytes and type match.
The producer rejects generation drift before the viewer handoff and
requires a focused window at native dispatch. The native viewer receives
a temporary read-only copy, with expiry after 15 minutes and cancellation
or destruction cleanup. It reports dispatch rather than whether the
person viewed the file. The browser keeps its renderer dialog and blob
under its lifecycle fence. The model takes already-validated name, MIME,
hash and encoding facts from platform decoders. It does not parse their
bytes or grant access itself.

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

Android stores references in `note-source-references` and retain times
in `note-source-reference-times`. It writes the time before the mapping.
A new reference can be kept only with an eligible persisted read grant,
a bounded content URI, and room in the 128-entry store. Retaining an
existing reference refreshes its time even when there is no room for a
new entry. A failed mapping commit cannot produce a retained receipt.
A stored time without a mapping is cleanup data.

Reconciliation requires the complete validated keep set. The Alpha
bridge allows at most 20,000 input identities and the whole command
fails if any identity is invalid. The Notes adapter collects deduplicated
valid `a1:` links from saved notes and restorable Trash under its
deletion lock. A reference without a keep entry survives for three
days after retain. A missing or future timestamp is seeded with now
before pruning, giving an old-format or rewound clock a full grace
period. Only after reference removal commits can the host try to
release the exact URI grant. It rechecks all remaining references to
the URI and all picker selections. A covering tree grant must survive.
An already-revoked permission need not produce a release receipt.

The reducer models one reference with another same-URI reference as
an observed fact, one picker lease, and separate direct and covering
grants. Its serialized events refine one reconciliation pass. The
pinned bridge workers serialize per instance. Cross-instance retain
and reconcile ordering and persistence failures between preferences
and the resolver still need host evidence. Pure policy and renderer
tests cannot establish actual Android permission behavior.

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
pure def elapsedGrace(retainTime: int, now: int): bool = retainTime >= 0 and now - retainTime >= 259200000
pure def canReconcileSource(s: SourceStore, validKeep: bool): bool = s.retained and validKeep
pure def reconcileSource(s: SourceStore, validKeep: bool, committed: bool): SourceStore =
  if (not(committed)) s
  else if (s.retainTime < 0 or s.retainTime > s.clock) { ...s, retainTime: s.clock }
  else if (not(s.liveLink or s.trashLink) and elapsedGrace(s.retainTime, s.clock))
    { ...s, retained: false, retainTime: -1, directGrant: s.directGrant and (s.picker or s.otherRef) }
  else s
pure def linkedSourceAccessible(s: SourceStore): bool = s.retained and (s.directGrant or s.treeGrant)
pure def alwaysSourceClockValid(s: SourceStore): bool = s.clock >= 0
pure def alwaysRetainTimeBounded(s: SourceStore): bool = s.retainTime >= -1 and (not(s.retained) implies s.retainTime == -1)
pure def stepLinkAndGraceProtectReference(before: SourceStore, via: str, after: SourceStore): bool =
  via == "reconcileSource" and before.retained and (before.liveLink or before.trashLink or not(elapsedGrace(before.retainTime, before.clock))) implies after.retained
pure def stepForgetDoesNotDiscardRetainedGrant(before: SourceStore, via: str, after: SourceStore): bool =
  via == "forgetPicker" and (before.retained or before.otherRef) implies after.directGrant == before.directGrant
pure def stepReconcileDoesNotReleaseTree(before: SourceStore, via: str, after: SourceStore): bool =
  via == "reconcileSource" or via == "forgetPicker" implies after.treeGrant == before.treeGrant
pure def stepPickerProtectsExactGrant(before: SourceStore, via: str, after: SourceStore): bool =
  via == "reconcileSource" and before.picker implies after.directGrant == before.directGrant
pure def lawClockRewindDoesNotExpire(retainTime: int, now: int): bool =
  now < retainTime implies not(elapsedGrace(retainTime, now))
pure def sometimesReopenAfterPicker(s: SourceStore): bool = not(s.picker) and linkedSourceAccessible(s)
pure def sometimesCanDropExpired(s: SourceStore): bool = s.retained and not(s.liveLink or s.trashLink) and elapsedGrace(s.retainTime, s.clock)
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
or control characters. Alpha rejects URLs its browser reading policy
treats as sensitive. It normalizes the URL and does not use a web link
as proof of the page's earlier bytes. A document link is still checked
by its own descriptor and fresh byte read. Browser navigation and
owner-approved sharing remain separate from this decoded link.

```quint
type SourceKind = DocumentLink | RecordingLink | WebLink
pure def sourceProvesPastBytes(kind: SourceKind, exactDigest: bool): bool = kind != WebLink and exactDigest
pure def lawWebLinkIsNotPastContentProof(exactDigest: bool): bool = not(sourceProvesPastBytes(WebLink, exactDigest))
```
