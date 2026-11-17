# Workflow worker provenance and availability

A consumer build calls the workflow package's artifact builder in the
admitted checkout, then verifies and stages the artifact it produced.
The device installs the signed package's index before enabling device
workflows. The workflow package's own
[schedule](./schedule.md) and [execution](./execution.md) contracts are
separate from installation.

## Story: Run workflows from the reviewed source and signed device assets

> As the owner, I want device workflows to run only on a worker built from the
> reviewed source and installed intact from the signed package.

### Producer, package and installed tree must each prove their own identity

The prepared source stamp and lockfile hash bind the producer. A build
observes them again after invoking the producer. Existing output is reused
only when it already matches those bytes. A foreign artifact cannot be
relabeled. The artifact directory and entries cannot be symlinks. Every
manifest member must exist and match its SHA-256, and unlisted files are
rejected. Stage a verified copy before publishing its bounded index.
The device validates the signed package's listed files and revalidates a
cached install against the current package stamp, index and installed
tree. Device enablement needs both the TypeScript and the workflow engine
compiler assets. No storage failure is a verified reuse.

```quint
type WorkerPhase = WorkerUnselected | WorkerPrepared | WorkerBuilt | WorkerPackaged | WorkerInstalled | WorkerRefused
type BuildEvidence = { sourceStamp: str, lockDigest: str, manifestDigest: str, treeMatches: bool, pathSafe: bool, requiredFiles: bool }
type DeviceEvidence = { packageStamp: str, manifestDigest: str, exactIndex: bool, filesMatch: bool, pathSafe: bool, typescriptCompiler: bool, engineCompiler: bool }
type Worker = { phase: WorkerPhase, sourceStamp: str, lockDigest: str, manifestDigest: str, packageStamp: str, enabled: bool }
pure val initial: Worker = { phase: WorkerUnselected, sourceStamp: "", lockDigest: "", manifestDigest: "", packageStamp: "", enabled: false }
pure def canSelectSource(w: Worker, sourceStamp: str, lockDigest: str): bool = w.phase == WorkerUnselected and sourceStamp != "" and lockDigest != ""
pure def selectSource(w: Worker, sourceStamp: str, lockDigest: str): Worker = { ...w, phase: WorkerPrepared, sourceStamp: sourceStamp, lockDigest: lockDigest }
pure def canObserveArtifact(w: Worker): bool = w.phase == WorkerPrepared
pure def observeArtifact(w: Worker, build: BuildEvidence): Worker =
  if (build.sourceStamp == w.sourceStamp and build.lockDigest == w.lockDigest and build.manifestDigest != "" and build.treeMatches and build.pathSafe and build.requiredFiles) { ...w, phase: WorkerBuilt, manifestDigest: build.manifestDigest }
  else { ...w, phase: WorkerRefused }
pure def canPackageArtifact(w: Worker): bool = w.phase == WorkerBuilt
pure def packageArtifact(w: Worker, packageStamp: str, observedManifest: str, copiedTreeMatches: bool): Worker =
  if (packageStamp != "" and observedManifest == w.manifestDigest and copiedTreeMatches) { ...w, phase: WorkerPackaged, packageStamp: packageStamp }
  else { ...w, phase: WorkerRefused }
pure def canInstallArtifact(w: Worker): bool = w.phase == WorkerPackaged or w.phase == WorkerInstalled
pure def installArtifact(w: Worker, device: DeviceEvidence): Worker =
  if (device.packageStamp == w.packageStamp and device.manifestDigest == w.manifestDigest and device.exactIndex and device.filesMatch and device.pathSafe) { ...w, phase: WorkerInstalled, enabled: device.typescriptCompiler and device.engineCompiler }
  else { ...w, phase: WorkerRefused, enabled: false }
pure val sourceStampValues = Set("reviewed")
pure val lockDigestValues = Set("current-lock")
pure val packageStampValues = Set("", "apk-current")
pure val observedManifestValues = Set("files", "changed")
pure val buildValues = Set(
  { sourceStamp: "reviewed", lockDigest: "current-lock", manifestDigest: "files", treeMatches: true, pathSafe: true, requiredFiles: true },
  { sourceStamp: "reviewed", lockDigest: "old-lock", manifestDigest: "files", treeMatches: true, pathSafe: true, requiredFiles: true },
  { sourceStamp: "reviewed", lockDigest: "current-lock", manifestDigest: "files", treeMatches: false, pathSafe: true, requiredFiles: true })
pure val deviceValues = Set(
  { packageStamp: "apk-current", manifestDigest: "files", exactIndex: true, filesMatch: true, pathSafe: true, typescriptCompiler: true, engineCompiler: true },
  { packageStamp: "apk-current", manifestDigest: "files", exactIndex: true, filesMatch: true, pathSafe: true, typescriptCompiler: false, engineCompiler: true },
  { packageStamp: "apk-old", manifestDigest: "files", exactIndex: true, filesMatch: true, pathSafe: true, typescriptCompiler: true, engineCompiler: true })
pure def alwaysPreparedHasIdentity(w: Worker): bool = w.phase != WorkerUnselected implies w.sourceStamp != "" and w.lockDigest != ""
pure def alwaysManifestIsVerified(w: Worker): bool = (w.phase == WorkerBuilt or w.phase == WorkerPackaged or w.phase == WorkerInstalled) implies w.manifestDigest != ""
pure def alwaysInstalledHasPackage(w: Worker): bool = (w.phase == WorkerPackaged or w.phase == WorkerInstalled) implies w.packageStamp != ""
pure def alwaysEnablementRequiresInstallation(w: Worker): bool = w.enabled implies w.phase == WorkerInstalled
pure def sometimesWorkerEnabled(w: Worker): bool = w.enabled
pure def sometimesInstalledWithoutCompiler(w: Worker): bool = w.phase == WorkerInstalled and not(w.enabled)
pure def sometimesWorkerRefused(w: Worker): bool = w.phase == WorkerRefused
```
