# Android runtime installation identity

Grace `48b43b9c` calls Eliza `7743504b` through `LocalRuntimeService.java`
in `apps/app/native/java/technology/graceful/grace`. It selects the state
subdirectory by `TaskDataKeys.slot` for the effective launch credential,
including the local slot, and calls the public
`plugins/plugin-native-agent/android/src/main/java/ai/eliza/plugins/agent/runtime/RuntimeInstallationIdentity.java`
before spawning the resident process. AlphaPhone `8d44dfe5` projects Eliza
`c518127a`'s `packages/app/platforms/android/app/src/main/java/ai/elizaos/app/RuntimeInstallationIdentity.java`
through `resident-host-sources.mjs`. The projected `ElizaAgentService.java`
checks canonical app-data containment and calls it before process launch.
Its exception leaves the service `extract-failed`. Grace aborts that launch.
The two Java copies differ in package and visibility and use the same
publication and readback policy. The selected state directory is the unit
of identity. Separate product, account state directory or sandbox owners
have independent identities. This identity becomes `AgentRuntime.runtimeInstanceId`.
[Startup](./mobileStartup.md) owns readiness of the paired processes.
[Installation](./mobileInstall.md) owns the OTA plan and release identity.

## Story: Restart the installed agent with the same runtime identity

As an Android host, I can reuse the identity of the selected private
state directory across launches and discover corrupt state before the
agent starts using it.

### Lock the selected directory and reuse only a valid existing identity

The Java port checks a real, non-symlink selected directory within the
host's private storage. The check of app-data containment is in Alpha's
caller. Grace builds the slot path under its private runtime root.
A process-local synchronized call and a process-shared file lock on
`.runtime-installation-id.lock` serialize publication and readback. The
lock is opened for write and creation without following a symlink, with
`0600` permissions when created. One transition below selects one locked
observation. `PathMissing` requires an absent directory entry as seen
without following links. A dangling symlink, non-regular file, malformed
UUID or failed read causes a launch error. A malformed or linked entry
stays in place. Existing text is trimmed and parsed as a UUID with version
nibble `1` through `8`, variant nibble `8`, `9`, `a` or `b`, and case-insensitive
hex digits. Tokens in the model are the lowercase equality identities of
those strings. The native class reads the original casing and its callers
use only successful completion. All filesystem evidence comes from the
Effect port. One machine covers the same trusted directory across retries
while the directory entry remains under those cooperating writers.
An absent observation can become a visible UUID on a later lock
acquisition if another launcher published between the two attempts.
Once a launcher observes the installed UUID, reopening that selected
state directory must return the same identity. A subsequent launch
discards its prior runtime construction receipt and reads the file again.

```quint
type IdentityPath = PathUnknown | PathMissing | PathInvalid | PathUuid({ identity: str })
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
pure def lawUnknownPathCannotYieldIdentity(entry: IdentityPath): bool =
  pathKind(entry) != UuidEntry implies not(usableIdentity(entry))
pure def lawSamePathObservationKeepsExactUuid(firstEntry: IdentityPath, secondEntry: IdentityPath): bool =
  (samePathObservation(firstEntry, secondEntry) and usableIdentity(firstEntry)) implies usableIdentity(secondEntry) and observedUuid(firstEntry) == observedUuid(secondEntry)
```

### A saved candidate is published once and requires qualified readback

Under the same lock, choose a random version 4 UUID and write it plus a
newline to an exclusive `.runtime-installation-id.*.tmp` file with `0600`
permissions. Fully write and sync the file before atomically moving the
candidate to `runtime-installation-id`. Atomic move failure leaves the
selected destination absent under the cooperating-writer assumption. Sync
the directory after the move and read the resulting file before reporting
success. The source removes its own temporary path in `finally` and can
still throw during cleanup or resource close. Failure before the move does
not publish a target. Failure afterward can leave the UUID visible even
when directory durability was unconfirmed. A later locked read of that
same visible entry may succeed without resyncing the directory, matching
the existing-entry path. The durability flag records only a confirmed
sync from this machine. A device power loss can change a directory whose
sync was unconfirmed. The next boot then starts from a fresh observed
filesystem. Nothing in an unconfirmed publication promises that the file
survives such a loss. No raw account key or credential enters the model.

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
pure def stepPublishedIdentityStaysPinned(before: InstallationIdentity, after: InstallationIdentity): bool =
  (usableIdentity(before.target) or pathKind(before.target) == InvalidEntry) implies samePathObservation(after.target, before.target)
pure def stepDurablePublicationStaysRecorded(before: InstallationIdentity, after: InstallationIdentity): bool =
  (before.publishedHere implies after.publishedHere) and (before.directorySynced implies after.directorySynced)
pure def stepRenamePrecedesDurability(before: InstallationIdentity, via: str, after: InstallationIdentity): bool =
  (via == "publishIdentity" and not(samePathObservation(after.target, before.target))) implies
    pathKind(before.target) == AbsentEntry and observedUuid(after.target) == before.candidate and not(after.directorySynced)
pure def sometimesNativeCanReuseWithoutConfirmedSync(i: InstallationIdentity): bool =
  i.phase == NativeIdentityReady and i.publishedHere and not(i.directorySynced)
pure def sometimesNativeRejectsMalformedTarget(i: InstallationIdentity): bool = i.phase == IdentityFailed and pathKind(i.target) == InvalidEntry
pure def sometimesNewIdentityIsSyncedAndRead(i: InstallationIdentity): bool = i.phase == NativeIdentityReady and i.directorySynced
```

## Story: Construct the agent only after the Android identity checks complete

### The agent reader verifies sandbox ownership and checks cancellation after identity I/O

The common pinned reader `packages/agent/src/runtime/runtime-installation-id.ts`
uses the Android platform indicator and absolute `ELIZA_ANDROID_APP_DATA_DIR`
provided by the native launchers. It checks lexical and resolved sandbox
containment. An Android-owned alias such as `/data/user/0` is admissible
with lexical and resolved ownership evidence. File and controlling
directory descriptors must still match the observed device and inode.
The target must be a regular non-symlink file owned by the runtime UID
when that UID is available, with exactly one link. The reader uses a
no-follow open. A non-`0600` file can still qualify only after changing
its mode and syncing it, then checking that the path and descriptor are
still the same regular, owned, single-link `0600` file. The UUID is
validated and normalized before construction. Failed identity I/O,
directory or target revalidation, or an abort after the read prevents
this invocation from constructing a runtime. In these product launches
the native producer has already published or read a UUID. The generic
agent loader's missing-file creation branch, desktop trust and Windows
credential storage have separate platform owners. The guard's comparison
of normalized identities expresses the cooperating-writer boundary, since
the pinned caller does not pass the Java return value into the agent.

```quint
type AndroidIdentityRead = { insideAppData: bool, trustedDirectoryChain: bool, regularNoFollowOwner: bool, oneLink: bool, privateAndSyncedIfChanged: bool, finalPathMatchesDescriptor: bool, identity: str }
pure def verifiedAndroidRead(reader: AndroidIdentityRead): bool =
  reader.insideAppData and reader.trustedDirectoryChain and reader.regularNoFollowOwner and reader.oneLink and
    reader.privateAndSyncedIfChanged and reader.finalPathMatchesDescriptor and reader.identity != ""
pure def canConstructAndroidRuntime(i: InstallationIdentity, reader: AndroidIdentityRead, cancelled: bool): bool =
  i.phase == NativeIdentityReady and verifiedAndroidRead(reader) and reader.identity == observedUuid(i.target) and not(cancelled)
pure def constructAndroidRuntime(i: InstallationIdentity, reader: AndroidIdentityRead, cancelled: bool): InstallationIdentity =
  { ...i, phase: RuntimeIdentityReady, runtimeId: reader.identity }
pure val readerValues = Set(
  { insideAppData: true, trustedDirectoryChain: true, regularNoFollowOwner: true, oneLink: true, privateAndSyncedIfChanged: true, finalPathMatchesDescriptor: true, identity: "identity-one" },
  { insideAppData: true, trustedDirectoryChain: true, regularNoFollowOwner: true, oneLink: true, privateAndSyncedIfChanged: true, finalPathMatchesDescriptor: true, identity: "identity-two" },
  { insideAppData: true, trustedDirectoryChain: true, regularNoFollowOwner: true, oneLink: true, privateAndSyncedIfChanged: true, finalPathMatchesDescriptor: false, identity: "identity-one" },
  { insideAppData: false, trustedDirectoryChain: true, regularNoFollowOwner: true, oneLink: true, privateAndSyncedIfChanged: true, finalPathMatchesDescriptor: true, identity: "identity-one" })
pure def alwaysRuntimeUsesVerifiedIdentity(i: InstallationIdentity): bool =
  if (i.phase == RuntimeIdentityReady) i.runtimeId != "" and i.runtimeId == observedUuid(i.target) else i.runtimeId == ""
pure def lawReaderRequiresStableOwnedPath(reader: AndroidIdentityRead): bool =
  verifiedAndroidRead(reader) implies reader.insideAppData and reader.trustedDirectoryChain and reader.regularNoFollowOwner and
    reader.oneLink and reader.privateAndSyncedIfChanged and reader.finalPathMatchesDescriptor
pure def lawCannotConstructAfterAbort(i: InstallationIdentity, reader: AndroidIdentityRead): bool =
  not(canConstructAndroidRuntime(i, reader, true))
pure def sometimesAndroidRuntimeConstructs(i: InstallationIdentity): bool = i.phase == RuntimeIdentityReady
```
