# Android selected document grants and lifecycle

AlphaPhone `8d44dfe5` calls Eliza `c518127a` through `DailyAppsPlugin.java`,
`AlphaFilesPlugin.java` and `SelectedDocumentAccess.java`. The latter
binds the device-local `selected-documents` registry to
`plugins/plugin-native-media/android/src/main/java/ai/eliza/plugins/media/SelectedDocuments.java`
and uses `SelectedDocumentCalls.java` for its selected-document bridge.
Alpha's Mail and Notes source paths use the same registry. Grace
`48b43b9c` stages an older `SelectedDocuments` from Eliza `7743504b`,
with no product bridge call at that pin. [Notes source references](./alpha/sourceReferences.md)
owns retained note links and verified reopening; its keep callback is an
input here. This contract owns the live selection and Android grant.
PDF rendering, attachment bytes and chooser presentation remain
separately owned effects.

## Story: Reopen only a document I selected while its grant still exists

### The native picker is the authority and only retained selections survive restart

`ACTION_OPEN_DOCUMENT` returns a content URI from Android. The picker
only takes persistable permission when it received both the persistable
and read flags, with write included only when offered. A host Files
selection may enter with zero persisted flags and rely on a currently
held access path. Bridge reads and writes use the opaque selection ID.
The display result may include the URI. One process-wide registry serializes selection writes and
forgets. An Activity recreation does not reset that registry. A process
restart loads only valid persisted entries, capped at the first 32
stored rows. A malformed entry cannot establish permission; production
restore still rechecks the Android grant for each loaded row. The
registry only stores retained entries in its preferences. Transient
selections therefore disappear on process restart.

After acquiring a current retained selection, resolve rechecks exact
persisted read permission for its URI. A covering tree grant does
not restore that exact picker grant. If revoked, forget the selection
and report unavailable. Restore checks retained IDs newest first; it
skips a revoked grant or security-denied descriptor after forgetting
that ID, and reports a different provider failure instead of falling
back to an older document. A transient resolve can return its recorded
URI while visible, while the actual provider operation must still have
access. The late result handler in Files releases only the selection
from the retired renderer visit. Changing views or returning later
cannot revive it. Document hidden alone does not retire an active
native selection.

The model follows one selected ID and tracks sibling locks on its exact
URI as observations from the serialized process registry. The pure
registry rule describes its capacity and commit order. All consent,
Android permissions and provider checks are Effect port observations.

```quint
type GrantFlags = { read: bool, write: bool }
type SelectionStorage = TransientSelection | PersistedSelection
type RestoreDecision = SkipRevoked | ProviderUnavailable | ResumeSelection
type PickerInput = { nativeResult: bool, contentUri: bool, persistable: bool, offeredRead: bool, offeredWrite: bool }
pure def pickerFlags(picker: PickerInput): GrantFlags = {
  val read = picker.nativeResult and picker.contentUri and picker.persistable and picker.offeredRead
  { read: read, write: read and picker.offeredWrite }
}
pure def selectionStorage(flags: GrantFlags): SelectionStorage = if (flags.read) PersistedSelection else TransientSelection
pure def resolveSelection(knownId: bool, storage: SelectionStorage, persistedRead: bool): bool =
  knownId and (storage == TransientSelection or persistedRead)
pure def restoreDecision(persistedRead: bool, securityDenied: bool, providerFailed: bool): RestoreDecision =
  if (not(persistedRead) or securityDenied) SkipRevoked else if (providerFailed) ProviderUnavailable else ResumeSelection
pure def acceptsPickerResult(visit: int, activeVisit: int, alreadySettled: bool): bool =
  activeVisit > 0 and visit == activeVisit and not(alreadySettled)
pure val pickerValues = Set({ nativeResult: true, contentUri: true, persistable: true, offeredRead: true, offeredWrite: true },
  { nativeResult: true, contentUri: true, persistable: false, offeredRead: true, offeredWrite: true },
  { nativeResult: true, contentUri: true, persistable: true, offeredRead: false, offeredWrite: true })
pure val flagsValues = Set({ read: false, write: false }, { read: true, write: false }, { read: true, write: true })
pure def lawWriteRequiresAnOfferedReadAndWrite(picker: PickerInput): bool =
  pickerFlags(picker).write implies pickerFlags(picker).read and picker.offeredRead and picker.offeredWrite
pure def lawPersistedResolveNeedsExactGrant(knownId: bool, persistedRead: bool): bool =
  resolveSelection(knownId, PersistedSelection, persistedRead) implies persistedRead
pure def lawStalePickerCannotPublish(visit: int, activeVisit: int, alreadySettled: bool): bool =
  visit != activeVisit implies not(acceptsPickerResult(visit, activeVisit, alreadySettled))
```

### Forgetting removes only the exact unreferenced persisted grant after the registry commit

An authorization writes the inserted ID before evicting the oldest
when the registry exceeds 32. The oldest is the first selected ID,
including transient ones. Another selected ID with the exact same URI
and retained flags contributes those flags to a new retained ID. A
new transient ID never gains retained flags through this union. A
failed insertion rolls back its own mapping before making an exact
grant release attempt. A failed eviction can leave the new mapping
and more than 32 entries until a later successful cleanup or restart.
It must not report a successful selection. Loading after restart
visits at most the first 32 persisted array entries before filtering.

Forget removes the exact mapping and flags, commits preferences and
then attempts release and preview deletion. If the registry commit
fails, the mapping and flags are put back and the grant is left alone.
Another selected ID for the same URI or a retained note source stops
the release. Covering tree access is unaffected. A provider rejection
of exact release may mean it already revoked permission. Missing
access is observed on the next resolve. In this projection a failed
release leaves the grant unconfirmed until an exact platform read.
Eviction invokes the same forget mechanics. The held-URI selection
and the exact retained grant can therefore differ. Temporary viewer
output cleanup is a shell effect after a successful forget.

```quint
type Selection = { live: bool, persisted: bool, exactGrant: bool, coveringTree: bool, otherSelection: bool, noteReference: bool }
pure val initial: Selection = { live: false, persisted: false, exactGrant: false, coveringTree: false, otherSelection: false, noteReference: false }
pure def mergeFlags(acquired: GrantFlags, priorFlags: GrantFlags): GrantFlags =
  if (not(acquired.read)) acquired else { read: true, write: acquired.write or priorFlags.write }
pure def needsOldestEviction(afterInsertCount: int): bool = afterInsertCount > 32
pure def authorizesReceipt(insertCommitted: bool, afterInsertCount: int, evictionCommitted: bool): bool =
  insertCommitted and (not(needsOldestEviction(afterInsertCount)) or evictionCommitted)
pure def mayReleaseGrant(otherSelection: bool, noteReference: bool, exactGrant: bool): bool =
  exactGrant and not(otherSelection or noteReference)
pure def canRecordSelection(s: Selection, grantRetained: bool, registerCommitted: bool): bool = not(s.live) and registerCommitted
pure def recordSelection(s: Selection, grantRetained: bool, registerCommitted: bool): Selection =
  { ...s, live: true, persisted: grantRetained, exactGrant: s.exactGrant or grantRetained }
pure def canUpdateProtection(s: Selection, sibling: bool, referenced: bool, covered: bool): bool =
  s.otherSelection != sibling or s.noteReference != referenced or s.coveringTree != covered
pure def updateProtection(s: Selection, sibling: bool, referenced: bool, covered: bool): Selection =
  { ...s, otherSelection: sibling, noteReference: referenced, coveringTree: covered }
pure def canForgetSelection(s: Selection): bool = s.live
pure def forgetSelection(s: Selection, deletionCommitted: bool, releaseConfirmed: bool): Selection =
  if (not(deletionCommitted)) s
  else { ...s, live: false, persisted: false,
    exactGrant: s.exactGrant and not(s.persisted and releaseConfirmed and mayReleaseGrant(s.otherSelection, s.noteReference, s.exactGrant)) }
pure def canReleaseOrphan(s: Selection): bool = not(s.live) and mayReleaseGrant(s.otherSelection, s.noteReference, s.exactGrant)
pure def releaseOrphan(s: Selection, releaseConfirmed: bool): Selection = { ...s, exactGrant: s.exactGrant and not(releaseConfirmed) }
pure def canObserveRevokedGrant(s: Selection): bool = s.exactGrant
pure def observeRevokedGrant(s: Selection): Selection = { ...s, exactGrant: false }
pure def canRestartRegistry(s: Selection): bool = s.live
pure def restartRegistry(s: Selection): Selection = { ...s, live: s.persisted }
pure def selectedAccess(s: Selection): bool = s.live and (not(s.persisted) or s.exactGrant)
pure val afterInsertCountValues = Set(1, 32, 33)
pure val acquiredValues = Set({ read: false, write: false }, { read: true, write: false }, { read: true, write: true })
pure val priorFlagsValues = acquiredValues
pure def alwaysPersistedEntryHasAnId(s: Selection): bool = s.persisted implies s.live
pure def stepRemovalKeepsCoveringTree(before: Selection, via: str, after: Selection): bool =
  via == "forgetSelection" or via == "releaseOrphan" implies after.coveringTree == before.coveringTree
pure def stepProtectedGrantIsNeverReleased(before: Selection, via: str, after: Selection): bool =
  (via == "forgetSelection" or via == "releaseOrphan") and (before.otherSelection or before.noteReference) implies
    after.exactGrant == before.exactGrant
pure def lawFailedEvictionCannotAcknowledge(insertCommitted: bool, afterInsertCount: int): bool =
  needsOldestEviction(afterInsertCount) implies not(authorizesReceipt(insertCommitted, afterInsertCount, false))
pure def lawUnionCannotPersistATransientSelection(acquired: GrantFlags, priorFlags: GrantFlags): bool =
  not(acquired.read) implies selectionStorage(mergeFlags(acquired, priorFlags)) == TransientSelection
pure def sometimesAnotherReferenceKeepsGrant(s: Selection): bool = not(s.live) and s.noteReference and s.exactGrant
pure def sometimesRevokedSelectionNoLongerResolves(s: Selection): bool = s.persisted and not(selectedAccess(s))
pure def stepExactOrphanReleaseRequiresLastReference(before: Selection, via: str, after: Selection): bool =
  via == "releaseOrphan" and before.exactGrant and not(after.exactGrant) implies not(before.live or before.otherSelection or before.noteReference)
```

## Story: Rename only my selected file and ask me to reselect if durable access is lost

### A rename binds the same capability to the provider's returned URI only when access allows it

Rename needs a live resolved selection, a provider-advertised rename
flag, a retained write flag on this ID and current Android write access.
The requested name is trimmed when sent. It must be nonempty after
trim, neither dot name, no slash, backslash or ISO control, and at most
255 original UTF-16 units. The provider can refuse or return no URI.
A returned URI updates the held selection under the same ID. The
store requests the original flags for that URI, dropping retained
flags if Android refuses. A replacement URI can release the old exact
grant only if no other selection or note source names it. The same
URI can also lose its grant during rename. The bridge then forgets
its selection and returns `renamed-reselect` only if forget succeeds.
An exact persisted read grant on that returned URI permits a selected
result after saving preferences and successful descriptor readback.
If reacquisition refused but Android still reports an exact persisted
read grant, the same ID is returned as transient and is omitted from
persistence. A failure after the provider altered the file leaves its
outcome uncertain and asks for refresh or reselect before retrying.

```quint
type RenameEvidence = { knownAndReadable: bool, validName: bool, providerSupports: bool, retainedWrite: bool, currentWrite: bool }
type RenameReadback = { providerReturned: bool, exactRead: bool, originalFlagsTaken: bool, registryCommitted: bool, descriptorRead: bool }
type RenameResult = RenameUnavailable | RenameInvalid | RenameUnsupported | RenameUnconfirmed | RenameReselect | RenameSelected | RenameTransient
pure def renameAdmits(evidence: RenameEvidence): bool =
  evidence.knownAndReadable and evidence.validName and evidence.providerSupports and evidence.retainedWrite and evidence.currentWrite
pure def renameResult(evidence: RenameEvidence, readback: RenameReadback): RenameResult =
  if (not(evidence.knownAndReadable)) RenameUnavailable
  else if (not(evidence.validName)) RenameInvalid
  else if (not(renameAdmits(evidence))) RenameUnsupported
  else if (not(readback.providerReturned and readback.registryCommitted)) RenameUnconfirmed
  else if (not(readback.exactRead)) RenameReselect
  else if (not(readback.descriptorRead)) RenameUnconfirmed
  else if (readback.originalFlagsTaken) RenameSelected else RenameTransient
pure val evidenceValues = Set({ knownAndReadable: true, validName: true, providerSupports: true, retainedWrite: true, currentWrite: true },
  { knownAndReadable: true, validName: true, providerSupports: true, retainedWrite: false, currentWrite: true })
pure val readbackValues = Set({ providerReturned: true, exactRead: true, originalFlagsTaken: true, registryCommitted: true, descriptorRead: true },
  { providerReturned: true, exactRead: true, originalFlagsTaken: false, registryCommitted: true, descriptorRead: true },
  { providerReturned: true, exactRead: false, originalFlagsTaken: false, registryCommitted: true, descriptorRead: false },
  { providerReturned: true, exactRead: true, originalFlagsTaken: true, registryCommitted: false, descriptorRead: false })
pure def lawRenameSelectedNeedsExactGrantAndFreshDescriptor(evidence: RenameEvidence, readback: RenameReadback): bool =
  (renameResult(evidence, readback) == RenameSelected or renameResult(evidence, readback) == RenameTransient) implies
    renameAdmits(evidence) and readback.exactRead and readback.registryCommitted and readback.descriptorRead
pure def lawRenameTransientDoesNotInventRetainedGrant(evidence: RenameEvidence, readback: RenameReadback): bool =
  renameResult(evidence, readback) == RenameTransient implies not(readback.originalFlagsTaken)
```
