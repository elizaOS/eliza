# Runtime installation identity

Before the [resident](./lifecycle.md) launches, the host gives the agent
the identity of its selected private state directory, which becomes the
runtime's instance identity. Each state directory, and so each consumer,
account or sandbox, has its own. One writer creates the identity, under a
lock on the directory, and the agent's reader only verifies what it
wrote. [Installation](../../os/update/install.md) owns the update plan and
the release identity.

## Story: Restart the agent with the same runtime identity

> As a device owner, my agent keeps the same identity across restarts,
> and damaged identity state stops the launch instead of being used.

### An existing valid identity is reused unchanged

Under the directory lock, an identity file holding a valid UUID is reused
as it is. A missing file leads to a new identity; a damaged, linked or
unreadable entry fails the launch and is left in place. Once an identity
is seen, every later observation of that directory returns the same one,
and each launch reads it again.

```quint
type ObservedUuid = { identity: str }
type IdentityPath = PathUnknown | PathMissing | PathInvalid | PathUuid(ObservedUuid)
type PathKind = UnknownEntry | AbsentEntry | InvalidEntry | UuidEntry
type IdentityPhase = InspectingPath | WritingCandidate | PublishingCandidate | SyncingDirectory | RereadingTarget | NativeIdentityReady | IdentityFailed | RuntimeIdentityReady
type InstallationIdentity = { phase: IdentityPhase, target: IdentityPath, candidate: str, publishedHere: bool, directorySynced: bool, runtimeId: str }
pure val initial: InstallationIdentity = { phase: InspectingPath, target: PathUnknown, candidate: "", publishedHere: false, directorySynced: false, runtimeId: "" }
pure def observedUuid(entry: IdentityPath): str = match entry { | PathUuid(record) => record.identity | _ => "" }
pure def pathKind(entry: IdentityPath): PathKind = match entry {
  | PathUnknown => UnknownEntry | PathMissing => AbsentEntry | PathInvalid => InvalidEntry | PathUuid(_) => UuidEntry
}
pure def samePathObservation(firstEntry: IdentityPath, secondEntry: IdentityPath): bool =
  pathKind(firstEntry) == pathKind(secondEntry) and observedUuid(firstEntry) == observedUuid(secondEntry)
pure def usableIdentity(entry: IdentityPath): bool = observedUuid(entry) != ""
pure def pathStillOwned(priorPath: IdentityPath, nextPath: IdentityPath): bool =
  pathKind(priorPath) == UnknownEntry or pathKind(priorPath) == AbsentEntry or samePathObservation(priorPath, nextPath)
pure def canInspectPath(i: InstallationIdentity): bool = i.phase == InspectingPath or i.phase == IdentityFailed
pure def inspectPath(i: InstallationIdentity, trustedLockedDirectory: bool, entry: IdentityPath, existingReadClosedCleanly: bool): InstallationIdentity =
  if (not(trustedLockedDirectory) or pathKind(entry) == UnknownEntry or not(pathStillOwned(i.target, entry)))
    { ...i, phase: IdentityFailed }
  else if (usableIdentity(entry)) { ...i, target: entry, phase: if (existingReadClosedCleanly) NativeIdentityReady else IdentityFailed }
  else if (pathKind(entry) == AbsentEntry) { ...i, target: entry, phase: WritingCandidate }
  else { ...i, target: entry, phase: IdentityFailed }
pure def canReopenIdentity(i: InstallationIdentity): bool = i.phase == RuntimeIdentityReady
pure def reopenIdentity(i: InstallationIdentity): InstallationIdentity = { ...i, phase: InspectingPath, runtimeId: "" }
pure val entryValues = Set(PathUnknown, PathMissing, PathInvalid, PathUuid({ identity: "identity-one" }), PathUuid({ identity: "identity-two" }))
pure val firstEntryValues = entryValues
pure val secondEntryValues = entryValues
pure def lawSamePathObservationKeepsExactUuid(firstEntry: IdentityPath, secondEntry: IdentityPath): bool =
  (samePathObservation(firstEntry, secondEntry) and usableIdentity(firstEntry)) implies usableIdentity(secondEntry) and observedUuid(firstEntry) == observedUuid(secondEntry)
pure def stepPublishedIdentityStaysPinned(before: InstallationIdentity, after: InstallationIdentity): bool =
  (usableIdentity(before.target) or pathKind(before.target) == InvalidEntry) implies samePathObservation(after.target, before.target)
pure def sometimesNativeRejectsMalformedTarget(i: InstallationIdentity): bool = i.phase == IdentityFailed and pathKind(i.target) == InvalidEntry
```

### A new identity is published by atomic rename and read back before use

A fresh UUID is written and synced to a private temporary file, renamed
over the missing target, the directory is synced, and the file is read
back before the identity counts. A failure before the rename publishes
nothing. A failure after it may leave the identity visible without
confirmed durability, and a later launch may reuse that visible identity.

```quint
pure def canPrepareIdentity(i: InstallationIdentity): bool = i.phase == WritingCandidate
pure def prepareIdentity(i: InstallationIdentity, freshIdentity: str, writtenAndSynced: bool): InstallationIdentity =
  if (writtenAndSynced and freshIdentity != "") { ...i, candidate: freshIdentity, phase: PublishingCandidate }
  else { ...i, phase: IdentityFailed }
pure val freshIdentityValues = Set("identity-one", "identity-two")
pure def canPublishIdentity(i: InstallationIdentity): bool = i.phase == PublishingCandidate
pure def publishIdentity(i: InstallationIdentity, atomicMoveSucceeded: bool): InstallationIdentity =
  if (atomicMoveSucceeded) { ...i, target: PathUuid({ identity: i.candidate }), candidate: "", publishedHere: true, phase: SyncingDirectory }
  else { ...i, candidate: "", phase: IdentityFailed }
pure def canSyncDirectory(i: InstallationIdentity): bool = i.phase == SyncingDirectory
pure def syncDirectory(i: InstallationIdentity, directorySyncSucceeded: bool): InstallationIdentity =
  if (directorySyncSucceeded) { ...i, directorySynced: true, phase: RereadingTarget }
  else { ...i, phase: IdentityFailed }
pure def canSettleNativeReadback(i: InstallationIdentity): bool = i.phase == RereadingTarget
pure def settleNativeReadback(i: InstallationIdentity, reread: IdentityPath, closedCleanly: bool): InstallationIdentity =
  { ...i, phase: if (closedCleanly and samePathObservation(reread, i.target)) NativeIdentityReady else IdentityFailed }
pure val rereadValues = Set(PathUnknown, PathInvalid, PathUuid({ identity: "identity-one" }), PathUuid({ identity: "identity-two" }))
pure def alwaysCandidateNeedsMissingTarget(i: InstallationIdentity): bool =
  (i.phase == PublishingCandidate) == (i.candidate != "") and
    ((i.phase == WritingCandidate or i.phase == PublishingCandidate) implies pathKind(i.target) == AbsentEntry and not(i.directorySynced))
pure def alwaysPublicationPhasesHaveIdentity(i: InstallationIdentity): bool =
  ((i.phase == NativeIdentityReady or i.phase == RuntimeIdentityReady or i.publishedHere) implies usableIdentity(i.target)) and
    ((i.phase == SyncingDirectory or i.phase == RereadingTarget or i.directorySynced) implies i.publishedHere) and
    (i.phase == SyncingDirectory implies not(i.directorySynced)) and (i.phase == RereadingTarget implies i.directorySynced)
pure def stepDurablePublicationStaysRecorded(before: InstallationIdentity, after: InstallationIdentity): bool =
  (before.publishedHere implies after.publishedHere) and (before.directorySynced implies after.directorySynced)
pure def stepRenamePrecedesDurability(before: InstallationIdentity, via: str, after: InstallationIdentity): bool =
  (via == "publishIdentity" and not(samePathObservation(after.target, before.target))) implies
    pathKind(before.target) == AbsentEntry and observedUuid(after.target) == before.candidate and not(after.directorySynced)
pure def sometimesNativeCanReuseWithoutConfirmedSync(i: InstallationIdentity): bool =
  i.phase == NativeIdentityReady and i.publishedHere and not(i.directorySynced)
pure def sometimesNewIdentityIsSyncedAndRead(i: InstallationIdentity): bool = i.phase == NativeIdentityReady and i.directorySynced
```

### The runtime is constructed only with the identity read back, never after cancellation

The agent's reader verifies that the file is the writer's: inside the
app's private storage, a regular owner-only file that is not a symbolic
link and has exactly one hard link, reached through trusted directories
and still the file it opened. The runtime is
constructed only when that verified read returns the identity the writer
settled on, and not if the launch was cancelled after the read.

```quint
type IdentityRead = { verified: bool, identity: str }
pure def canConstructAndroidRuntime(i: InstallationIdentity, reader: IdentityRead, cancelled: bool): bool =
  i.phase == NativeIdentityReady and reader.verified and reader.identity != "" and reader.identity == observedUuid(i.target) and not(cancelled)
pure def constructAndroidRuntime(i: InstallationIdentity, reader: IdentityRead, cancelled: bool): InstallationIdentity =
  { ...i, phase: RuntimeIdentityReady, runtimeId: reader.identity }
pure val readerValues = Set(
  { verified: true, identity: "identity-one" },
  { verified: true, identity: "identity-two" },
  { verified: false, identity: "identity-one" })
pure def alwaysRuntimeUsesVerifiedIdentity(i: InstallationIdentity): bool =
  if (i.phase == RuntimeIdentityReady) i.runtimeId != "" and i.runtimeId == observedUuid(i.target) else i.runtimeId == ""
pure def lawCannotConstructAfterAbort(i: InstallationIdentity, reader: IdentityRead): bool =
  not(canConstructAndroidRuntime(i, reader, true))
pure def sometimesAndroidRuntimeConstructs(i: InstallationIdentity): bool = i.phase == RuntimeIdentityReady
```
