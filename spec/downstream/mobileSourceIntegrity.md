# Android consumer source integrity

Grace uses `exportCommittedSources` and `inspectDevelopmentRuntime` from
`packages/app/scripts/lib/committed-source.mjs` at Eliza `7743504b`.
AlphaPhone uses `verifyCommittedWorkspace` from
`packages/app/scripts/lib/immutable-workspace-source.mjs` at Eliza
`c518127a`. The exact pins and consumer commits are in the
[downstream index](./index.md). [Android build custody](./mobileBuild.md)
owns APK publication after source admission.

## Story: Build from exactly the Eliza revision selected by the consumer

### A prepared Alpha workspace authenticates tracked and extra files separately

`scripts/pinned-upstream-source.ts` supplies the vendor lock and named
native Gradle outputs. `scripts/local-agent-source.ts` supplies a different
allowance for prepared runtime stamps and the mobile output. An allowance is
host configuration. Paths must be explicit workspace-relative segments with
no empty, dot or parent components. The checkout root resolves to the
directory submitted to the verifier, and HEAD equals the lowercase 40-hex
pin. The verifier reads every committed blob directly and checks its object
digest and executable bits. A tracked symlink needs the exact recorded link
target bytes. An ordinary tracked entry cannot be a symlink. Gitlinks do not
authenticate nested worktree data. A tracked diff also fails.

Enumerate untracked files including ignored files. Each must be a host-named
file, a strict descendant of an admitted generated directory, or a declared
workspace output. Workspace output rules come from the committed root
manifest, the named workspace's package manifest and its applicable Turbo
task. Only literal directory outputs with a trailing recursive suffix
contribute roots. Task logs, root dependencies, workspace dependencies and
the root Turbo cache have distinct generated locations. A directory prefix
cannot match a sibling whose name merely starts the same way. A generated
allowance cannot override the tracked-blob checks. The filesystem and Git
ports return exact sets, paths, modes, and blob digests. These laws project
the authority of those decoded observations.

```quint
type TreeEntryKind = TrackedRegular | TrackedExecutable | TrackedLink | TrackedGitlink
type CheckedFileKind = FileRegular | FileLink | FileMissing | FileOther
type ExtraFileScope = ExactHostFile | StrictGeneratedDescendant | ExactTaskLog | ExtraOutsideOutputs
pure def admitsTrackedEntry(entryKind: TreeEntryKind, fileKind: CheckedFileKind, digestExact: bool, execMask: int): bool =
  if (entryKind == TrackedGitlink) true
  else if (entryKind == TrackedLink) fileKind == FileLink and digestExact
  else fileKind == FileRegular and digestExact and (if (entryKind == TrackedExecutable) execMask == 73 else execMask == 0)
pure def admitsWorkspace(fullPin: bool, exactHead: bool, exactRoot: bool, safeAllowances: bool, validTracked: bool, cleanDiff: bool, validExtras: bool): bool =
  fullPin and exactHead and exactRoot and safeAllowances and validTracked and cleanDiff and validExtras
pure def admitsExtra(scope: ExtraFileScope): bool = scope != ExtraOutsideOutputs
pure val execMaskValues = Set(0, 1, 64, 73)
pure def lawTrackedCannotBeReplacedByLink(entryKind: TreeEntryKind, digestExact: bool, execMask: int): bool =
  (entryKind == TrackedRegular or entryKind == TrackedExecutable) implies not(admitsTrackedEntry(entryKind, FileLink, digestExact, execMask))
pure def lawExtraAllowanceCannotOverrideTrackedBytes(fullPin: bool, exactHead: bool, exactRoot: bool, safeAllowances: bool, cleanDiff: bool): bool =
  not(admitsWorkspace(fullPin, exactHead, exactRoot, safeAllowances, false, cleanDiff, true))
pure def lawGitDiffIsIndependentEvidence(fullPin: bool, exactHead: bool, exactRoot: bool, safeAllowances: bool): bool =
  not(admitsWorkspace(fullPin, exactHead, exactRoot, safeAllowances, true, false, true))
pure def lawOutsideOutputRefused(scope: ExtraFileScope): bool =
  scope == ExtraOutsideOutputs implies not(admitsExtra(scope))
```

### A Grace committed export uses the selected tree even if the checkout has edits

`apps/app/scripts/upstream-source.ts` exports explicit paths using the
reviewed commit as the Git archive input. The checkout root must match.
The path list is nonempty with no absolute path, empty segment or parent
segment. The archive reads committed bytes, including when the same paths
are locally modified. Extraction succeeds before returning the reviewed
commit receipt. Grace development inspection is different. It requires an
absolute checkout root containing the agent entrypoint and obtains the
source commit and dirty status. A supplied expected commit requires exact
HEAD and a clean tree. Without an expected commit the result can report a
dirty development checkout. Both cases require a readable runtime version
before returning inspection evidence.

```quint
type SourceResult = SourceRefused | SourceArchived | SourceCleanDev | SourceDirtyDev
pure def exportSource(rootExact: bool, fullPin: bool, explicitPaths: bool, archiveExtracted: bool): SourceResult =
  if (rootExact and fullPin and explicitPaths and archiveExtracted) SourceArchived else SourceRefused
pure def inspectSource(rootExact: bool, fullHead: bool, entrypoint: bool, hasPin: bool, samePin: bool, dirty: bool, versionRead: bool): SourceResult =
  if (rootExact and fullHead and entrypoint and versionRead and (not(hasPin) or (samePin and not(dirty))))
    (if (dirty) SourceDirtyDev else SourceCleanDev)
  else SourceRefused
pure def lawDirtyPinnedDevelopmentRefused(rootExact: bool, fullHead: bool, entrypoint: bool, samePin: bool, versionRead: bool): bool =
  inspectSource(rootExact, fullHead, entrypoint, true, samePin, true, versionRead) == SourceRefused
pure def lawFailedExtractionCannotReturnReceipt(rootExact: bool, fullPin: bool, explicitPaths: bool): bool =
  exportSource(rootExact, fullPin, explicitPaths, false) == SourceRefused
```

### A cache copy admits only the same prepared tree at the destination

Alpha's local cache shortcut accepts a full checkout with the matching
commit. Missing, mismatched or sparse caches fall back to an ordinary
checkout. A matching cache with changed tracked bytes reports failure.
The cache seed copies only committed entries, verifies the source blob and
mode at each path, and checks that HEAD and tracked status still match
after copying. It creates empty submodule directories. It does not copy
dependency outputs or nested Git metadata. Source and destination parents
must meet their respective path checks. `prepare-local-agent.ts` verifies
the prepared destination independently before staging work and after it.

This state machine describes one requested committed source, with both
cache and ordinary checkout paths. An observation of a changed source or
destination retires the earlier admission. Publication requires the latest
independent destination observation. Source byte comparison, extraction and
dependency setup remain Effect ports.

```quint
type CacheObservation = CacheUnavailable | CacheExact | CacheChanged
type SourcePhase = SourceNew | SourceSeeded | SourceCheckouts | SourcePrepared | SourceStaging | SourcePublished | SourceFailed
type PreparedSource = { phase: SourcePhase, pin: str, admittedDestination: bool, stagingChecked: bool }
pure val initial: PreparedSource = { phase: SourceNew, pin: "", admittedDestination: false, stagingChecked: false }
pure def canChooseSource(s: PreparedSource, pin: str): bool = s.phase == SourceNew and pin != ""
pure def chooseSource(s: PreparedSource, pin: str, cache: CacheObservation): PreparedSource =
  { ...s, pin: pin, phase: if (cache == CacheExact) SourceSeeded else if (cache == CacheUnavailable) SourceCheckouts else SourceFailed }
pure def canAdmitDestination(s: PreparedSource): bool = s.phase == SourceSeeded or s.phase == SourceCheckouts
pure def admitDestination(s: PreparedSource, pin: str, checked: bool): PreparedSource =
  if (checked and pin == s.pin) { ...s, phase: SourcePrepared, admittedDestination: true }
  else { ...s, phase: SourceFailed }
pure def canBeginStaging(s: PreparedSource): bool = s.phase == SourcePrepared and s.admittedDestination
pure def beginStaging(s: PreparedSource): PreparedSource = { ...s, phase: SourceStaging }
pure def canObserveStaging(s: PreparedSource): bool = s.phase == SourceStaging
pure def observeStaging(s: PreparedSource, pin: str, checked: bool): PreparedSource =
  if (checked and pin == s.pin) { ...s, phase: SourcePublished, stagingChecked: true }
  else { ...s, phase: SourceFailed, admittedDestination: false }
pure val pinValues = Set("", "approved", "other")
pure def alwaysNamedSource(s: PreparedSource): bool = (s.phase == SourceNew) == (s.pin == "")
pure def alwaysAcceptedSourceIsChecked(s: PreparedSource): bool =
  s.admittedDestination == (s.phase == SourcePrepared or s.phase == SourceStaging or s.phase == SourcePublished)
pure def alwaysPublishedSourceWasRechecked(s: PreparedSource): bool = s.stagingChecked == (s.phase == SourcePublished)
pure def stepPublishedSourceUsesSamePin(before: PreparedSource, via: str, after: PreparedSource): bool =
  (after.phase == SourcePublished and before.phase != SourcePublished) implies via == "observeStaging" and before.pin == after.pin and before.admittedDestination
pure def sometimesCacheCanSeed(s: PreparedSource): bool = s.phase == SourceSeeded
pure def sometimesMissingCacheChecksOut(s: PreparedSource): bool = s.phase == SourceCheckouts
pure def sometimesExactOutputPublished(s: PreparedSource): bool = s.phase == SourcePublished
```
