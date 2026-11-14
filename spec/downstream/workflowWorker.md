# Workflow worker provenance and availability

AlphaPhone builds through `scripts/prepared-workflow-worker.ts`, calling
Eliza's `packages/scripts/plugins/plugin-workflow/build-workflow-artifact.ts`
in the admitted checkout. It verifies and stages through
`scripts/workflow-worker-artifact.ts`. Android's `WorkflowWorkerAssets.java`
installs the signed APK's index before enabling mobile workflows. AlphaPhone
models both boundaries in `PreparedWorkflowWorker.qnt` and
`WorkflowWorkerStaging.qnt`. The upstream workflow plugin's own schedule
and execution contracts are separate from installation.

## Story: Run workflows from the reviewed source and signed device assets

### Producer, package and installed tree must each prove their own identity

The prepared source stamp and lockfile hash bind the producer. A build
observes them again after invoking the producer. Existing output is reused
only when it already matches those bytes. A foreign artifact cannot be
relabeled. The artifact directory and entries cannot be symlinks. Every
manifest member must exist and match its SHA-256, and unlisted files are
rejected. Stage a verified copy before publishing its bounded index.
Android validates the signed APK's listed files and revalidates a cached
install against the current package stamp, index and installed tree.
Device enablement needs both TypeScript and smthrs compiler assets.
The model receives structured digest and file-inspection observations
from separate filesystem and APK ports. No storage failure is a verified
reuse. This state models admission for a single installation candidate.

```quint
type WorkerPhase = WorkerUnselected | WorkerPrepared | WorkerBuilt | WorkerPackaged | WorkerInstalled | WorkerRefused
type BuildEvidence = { sourceStamp: str, lockDigest: str, manifestDigest: str, treeMatches: bool, pathSafe: bool, requiredFiles: bool }
type DeviceEvidence = { packageStamp: str, manifestDigest: str, exactIndex: bool, filesMatch: bool, pathSafe: bool, typescriptCompiler: bool, smthrsCompiler: bool }
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
  if (device.packageStamp == w.packageStamp and device.manifestDigest == w.manifestDigest and device.exactIndex and device.filesMatch and device.pathSafe) { ...w, phase: WorkerInstalled, enabled: device.typescriptCompiler and device.smthrsCompiler }
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
  { packageStamp: "apk-current", manifestDigest: "files", exactIndex: true, filesMatch: true, pathSafe: true, typescriptCompiler: true, smthrsCompiler: true },
  { packageStamp: "apk-current", manifestDigest: "files", exactIndex: true, filesMatch: true, pathSafe: true, typescriptCompiler: false, smthrsCompiler: true },
  { packageStamp: "apk-old", manifestDigest: "files", exactIndex: true, filesMatch: true, pathSafe: true, typescriptCompiler: true, smthrsCompiler: true })
pure def alwaysPreparedHasIdentity(w: Worker): bool = w.phase != WorkerUnselected implies w.sourceStamp != "" and w.lockDigest != ""
pure def alwaysManifestIsVerified(w: Worker): bool = (w.phase == WorkerBuilt or w.phase == WorkerPackaged or w.phase == WorkerInstalled) implies w.manifestDigest != ""
pure def alwaysInstalledHasPackage(w: Worker): bool = (w.phase == WorkerPackaged or w.phase == WorkerInstalled) implies w.packageStamp != ""
pure def alwaysEnablementRequiresInstallation(w: Worker): bool = w.enabled implies w.phase == WorkerInstalled
pure def sometimesWorkerEnabled(w: Worker): bool = w.enabled
pure def sometimesInstalledWithoutCompiler(w: Worker): bool = w.phase == WorkerInstalled and not(w.enabled)
pure def sometimesWorkerRefused(w: Worker): bool = w.phase == WorkerRefused
```
