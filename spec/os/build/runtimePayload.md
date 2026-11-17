# Runtime payload

What an Android host ships to run the agent: the Node 26 runtime per ABI,
the agent bundle, the consumer's additions, the optional workflow worker,
and the inventory that names every one of these files. The build stages
the payload (`stageRuntimePayload`); the agent service checks it on the
device before it starts the agent. The sources are develop's
`stage-android-agent.ts`, `consumer-android-runtime.mjs`,
`android-runtime-inventory.mjs` and `stage-android-native.py`, rewritten
for Node: there is no loader, no C++ runtime library, no seccomp shim and
no gateway. The agent bundle build (its manifest gives the bundle's
profile and the worker's digest) and the launch document belong to the
agent; reading files, hashing, fetching and copying stay in the shell.

## Story: Ship the agent with a pinned Node runtime

> As a device owner, I want my agent to run on the exact Node runtime my
> build pinned, so that no other runtime runs with my data.

### A Node runtime file is used only when it matches its ABI's lock entry

`aosp/runtime/node.lock.json` names the Node version, the NDK, the API
level and, per ABI, the SHA-256 and the release asset URL. A runtime
file from local build output or fetched from the lock's URL is used only
when its version, NDK, API level and digest match the lock.

```quint
type Abi = Arm64 | X86_64
pure val allAbis = Set(Arm64, X86_64)
pure def abiDirectory(abi: Abi): str = if (abi == Arm64) "arm64-v8a" else "x86_64"
type RuntimeSource = LocalBuild | Fetched({ url: str })
type NodeLockEntry = { abi: Abi, sha256: str, url: str }
type NodeLock = { version: str, ndk: str, apiLevel: int, entries: List[NodeLockEntry] }
type RuntimeCandidate = { abi: Abi, version: str, ndk: str, apiLevel: int, sha256: str, source: RuntimeSource }
pure def sourceAllowed(source: RuntimeSource, url: str): bool = match source { | LocalBuild => true | Fetched(f) => f.url == url }
pure def entryMatches(entry: NodeLockEntry, c: RuntimeCandidate): bool = entry.abi == c.abi and entry.sha256 == c.sha256 and sourceAllowed(c.source, entry.url)
pure def runtimeAdmitted(lock: NodeLock, c: RuntimeCandidate): bool =
  c.sha256 != "" and c.version == lock.version and c.ndk == lock.ndk and c.apiLevel == lock.apiLevel and lock.entries.some(entry => entryMatches(entry, c))
pure val lockValues = Set(
  { version: "26.13.0", ndk: "r28", apiLevel: 29, entries: List({ abi: Arm64, sha256: "a1", url: "u1" }, { abi: X86_64, sha256: "x1", url: "u2" }) },
  { version: "26.13.0", ndk: "r28", apiLevel: 29, entries: List() })
pure val cValues = Set(
  { abi: Arm64, version: "26.13.0", ndk: "r28", apiLevel: 29, sha256: "a1", source: Fetched({ url: "u1" }) },
  { abi: Arm64, version: "26.13.0", ndk: "r28", apiLevel: 29, sha256: "a2", source: Fetched({ url: "u1" }) },
  { abi: Arm64, version: "26.13.0", ndk: "r28", apiLevel: 29, sha256: "a1", source: Fetched({ url: "u2" }) },
  { abi: X86_64, version: "26.13.0", ndk: "r28", apiLevel: 29, sha256: "x1", source: LocalBuild },
  { abi: X86_64, version: "26.12.0", ndk: "r28", apiLevel: 29, sha256: "x1", source: LocalBuild })
pure def lawDigestMismatchIsNeverUsed(lock: NodeLock, c: RuntimeCandidate): bool =
  lock.entries.every(entry => entry.abi != c.abi or entry.sha256 != c.sha256) implies not(runtimeAdmitted(lock, c))
pure def lawFetchedOnlyFromTheLockedUrl(lock: NodeLock, c: RuntimeCandidate): bool =
  (runtimeAdmitted(lock, c) and c.source != LocalBuild) implies lock.entries.some(entry => entry.abi == c.abi and Fetched({ url: entry.url }) == c.source)
```

### The APK carries exactly one Node runtime for each targeted ABI and none for another

The runtime is `lib/<abi>/libeliza_node.so`, extracted to the native
library directory and started from there, because app data is never
executable. It is the only native file installed executable.

```quint
pure val nodeLibraryName = "libeliza_node.so"
type FileMode = Executable | ReadOnly
pure def nativeMode(name: str): FileMode = if (name == nodeLibraryName) Executable else ReadOnly
pure def runtimeCount(runtimes: List[RuntimeCandidate], abi: Abi): int = runtimes.select(c => c.abi == abi).length()
pure def runtimeLayoutValid(targets: List[Abi], runtimes: List[RuntimeCandidate]): bool =
  targets.length() > 0 and allAbis.forall(abi => runtimeCount(runtimes, abi) == (if (targets.includes(abi)) 1 else 0))
```

## Story: Ship only the files my build listed

> As a device owner, I want every file of my agent's payload listed by
> digest, so that nothing unlisted runs on my device.

### The inventory lists every staged payload file once, by digest and size, and nothing else

`assets/agent/inventory.json` covers the Node runtimes, the agent bundle
under `assets/agent/`, the consumer's extra asset trees
(`extraAssets: [{dir, name}]`) and native libraries per ABI, and the
workflow worker. A consumer addition is admitted only through this list.

```quint
type FileKind = NodeRuntime | BundleFile | NodeAddon | ModelFile | InferenceLibrary | ConsumerAsset | ConsumerLibrary | WorkerFile
type StagedFile = { path: str, kind: FileKind, sha256: str, size: int }
type InventoryRow = { path: str, sha256: str, size: int }
pure def listedOnce(rows: List[InventoryRow], f: StagedFile): bool =
  rows.select(r => r.path == f.path).length() == 1 and rows.some(r => r.path == f.path and r.sha256 == f.sha256 and r.size == f.size)
pure def inventoryExact(files: List[StagedFile], rows: List[InventoryRow]): bool =
  files.every(f => f.sha256 != "" and f.size >= 0 and listedOnce(rows, f)) and rows.every(r => files.some(f => f.path == r.path))
```

### The bundle carries no Node-API addon and a cloud-only payload carries no model or inference library

The agent bundle is pure JavaScript and WebAssembly. The bundle manifest
says whether the agent runs local inference; without it the payload has
no file ending in one of `modelSuffixes` and no inference library. The
shell classifies each file by its path.

```quint
type Profile = CloudOnly | LocalInference
pure val modelSuffixes = List(".gguf", ".onnx", ".ort", ".tflite", ".safetensors", ".pte", ".task")
pure def contentAllowed(profile: Profile, f: StagedFile): bool =
  f.kind != NodeAddon and (profile == LocalInference or (f.kind != ModelFile and f.kind != InferenceLibrary))
```

### The workflow worker is staged only under the digest the bundle manifest pins

The workflow plugin's build makes the worker; the bundle manifest records
its `workflowWorkerSha256`. A worker without a pin, a pin without a
worker, or a different digest refuses the payload. The launch names a
staged worker as `workflowWorker {runtimeDir, executable, sha256}`; the
agent starts it as its own child, never the service.

```quint
type WorkerPin = NoWorkerPin | WorkerPinned({ pinnedSha256: str })
type WorkerArtifact = NoWorkerArtifact | WorkerBuilt({ builtSha256: str })
type WorkerStaging = WorkerAbsent | WorkerStaged({ stagedSha256: str }) | WorkerRefused
pure def workerStaging(pin: WorkerPin, artifact: WorkerArtifact): WorkerStaging = match pin {
  | NoWorkerPin => if (artifact == NoWorkerArtifact) WorkerAbsent else WorkerRefused
  | WorkerPinned(p) => match artifact {
    | WorkerBuilt(a) => if (p.pinnedSha256 != "" and a.builtSha256 == p.pinnedSha256) WorkerStaged({ stagedSha256: a.builtSha256 }) else WorkerRefused
    | NoWorkerArtifact => WorkerRefused } }
type WorkflowWorker = { runtimeDir: str, executable: str, sha256: str }
type LaunchWorker = NoLaunchWorker | NamedWorker(WorkflowWorker)
pure def launchWorker(staging: WorkerStaging, runtimeDir: str, executable: str): LaunchWorker = match staging {
  | WorkerStaged(w) => NamedWorker({ runtimeDir: runtimeDir, executable: executable, sha256: w.stagedSha256 })
  | _ => NoLaunchWorker }
pure val pinValues = Set(NoWorkerPin, WorkerPinned({ pinnedSha256: "w1" }), WorkerPinned({ pinnedSha256: "" }))
pure val artifactValues = Set(NoWorkerArtifact, WorkerBuilt({ builtSha256: "w1" }), WorkerBuilt({ builtSha256: "w2" }))
pure def lawLaunchNamesOnlyThePinnedWorker(pin: WorkerPin, artifact: WorkerArtifact, runtimeDir: str, executable: str): bool = {
  val named = launchWorker(workerStaging(pin, artifact), runtimeDir, executable)
  named == NoLaunchWorker or (pin != NoWorkerPin and named == NamedWorker({ runtimeDir: runtimeDir, executable: executable, sha256: match pin { | WorkerPinned(p) => p.pinnedSha256 | _ => "" } }))
}
```

### A payload is admitted only when every staging rule holds

The build publishes nothing for a refused payload and names the first
rule it broke.

```quint
type PayloadRefusal = RuntimeLayoutInvalid | RuntimeNotPinned | ForbiddenContent | WorkerNotPinned | InventoryInexact
type PayloadVerdict = PayloadAdmitted | PayloadRefused({ reason: PayloadRefusal })
type StagedPayload = { lock: NodeLock, targets: List[Abi], runtimes: List[RuntimeCandidate], profile: Profile, files: List[StagedFile], inventory: List[InventoryRow], workerPin: WorkerPin, workerArtifact: WorkerArtifact }
pure def workerConsistent(p: StagedPayload): bool = {
  val staging = workerStaging(p.workerPin, p.workerArtifact)
  staging != WorkerRefused and (p.files.some(f => f.kind == WorkerFile) iff staging != WorkerAbsent)
}
pure def payloadVerdict(p: StagedPayload): PayloadVerdict =
  if (not(runtimeLayoutValid(p.targets, p.runtimes))) PayloadRefused({ reason: RuntimeLayoutInvalid })
  else if (not(p.runtimes.every(c => runtimeAdmitted(p.lock, c)))) PayloadRefused({ reason: RuntimeNotPinned })
  else if (not(p.files.every(f => contentAllowed(p.profile, f)))) PayloadRefused({ reason: ForbiddenContent })
  else if (not(workerConsistent(p))) PayloadRefused({ reason: WorkerNotPinned })
  else if (not(inventoryExact(p.files, p.inventory))) PayloadRefused({ reason: InventoryInexact })
  else PayloadAdmitted
pure val pValues = Set(
  { lock: { version: "26.13.0", ndk: "r28", apiLevel: 29, entries: List({ abi: Arm64, sha256: "a1", url: "u1" }) }, targets: List(Arm64), runtimes: List({ abi: Arm64, version: "26.13.0", ndk: "r28", apiLevel: 29, sha256: "a1", source: LocalBuild }), profile: CloudOnly,
    files: List({ path: "lib/arm64-v8a/libeliza_node.so", kind: NodeRuntime, sha256: "a1", size: 9 }, { path: "assets/agent/agent.mjs", kind: BundleFile, sha256: "b1", size: 4 }), inventory: List({ path: "lib/arm64-v8a/libeliza_node.so", sha256: "a1", size: 9 }, { path: "assets/agent/agent.mjs", sha256: "b1", size: 4 }), workerPin: NoWorkerPin, workerArtifact: NoWorkerArtifact },
  { lock: { version: "26.13.0", ndk: "r28", apiLevel: 29, entries: List({ abi: Arm64, sha256: "a1", url: "u1" }) }, targets: List(Arm64), runtimes: List({ abi: Arm64, version: "26.13.0", ndk: "r28", apiLevel: 29, sha256: "a1", source: LocalBuild }), profile: CloudOnly,
    files: List({ path: "assets/agent/models/m.gguf", kind: ModelFile, sha256: "m1", size: 9 }, { path: "assets/agent/workflow-worker/w.mjs", kind: WorkerFile, sha256: "w1", size: 2 }), inventory: List({ path: "assets/agent/models/m.gguf", sha256: "m1", size: 9 }), workerPin: WorkerPinned({ pinnedSha256: "w1" }), workerArtifact: WorkerBuilt({ builtSha256: "w1" }) },
  { lock: { version: "26.13.0", ndk: "r28", apiLevel: 29, entries: List({ abi: Arm64, sha256: "a1", url: "u1" }) }, targets: List(Arm64, X86_64), runtimes: List({ abi: Arm64, version: "26.13.0", ndk: "r28", apiLevel: 29, sha256: "a2", source: Fetched({ url: "u1" }) }), profile: LocalInference,
    files: List({ path: "assets/agent/workflow-worker/w.mjs", kind: WorkerFile, sha256: "w2", size: 2 }), inventory: List(), workerPin: WorkerPinned({ pinnedSha256: "w1" }), workerArtifact: WorkerBuilt({ builtSha256: "w2" }) })
pure def lawAdmittedRuntimesAreLocked(p: StagedPayload): bool =
  payloadVerdict(p) == PayloadAdmitted implies (p.targets.every(abi => runtimeCount(p.runtimes, abi) == 1) and p.runtimes.every(c => runtimeAdmitted(p.lock, c)))
pure def lawAdmittedPayloadIsListed(p: StagedPayload): bool =
  payloadVerdict(p) == PayloadAdmitted implies p.files.every(f => p.inventory.some(r => r.path == f.path and r.sha256 == f.sha256 and r.size == f.size))
pure def lawAdmittedCloudPayloadHasNoModel(p: StagedPayload): bool =
  (payloadVerdict(p) == PayloadAdmitted and p.profile == CloudOnly) implies p.files.every(f => f.kind != ModelFile and f.kind != InferenceLibrary and f.kind != NodeAddon)
pure def lawAdmittedWorkerIsPinned(p: StagedPayload): bool =
  (payloadVerdict(p) == PayloadAdmitted and p.files.some(f => f.kind == WorkerFile)) implies workerStaging(p.workerPin, p.workerArtifact) != WorkerAbsent and workerStaging(p.workerPin, p.workerArtifact) != WorkerRefused
```

## Story: Start the agent only on an intact payload

> As a device owner, I want my agent to start only from the payload my
> build signed, so that a damaged or stale file never runs.

### Extracted assets are extracted again when the package version changes

The service records the package version code its extracted asset trees
came from. Another version code, or none, extracts them again before any
check.

```quint
type Extraction = NotExtracted | ExtractedFor({ versionCode: int })
pure def extractionCurrent(extraction: Extraction, versionCode: int): bool = match extraction {
  | ExtractedFor(e) => e.versionCode == versionCode
  | NotExtracted => false }
pure val extractionValues = Set(NotExtracted, ExtractedFor({ versionCode: 1 }), ExtractedFor({ versionCode: 2 }))
```

### The agent spawns only when every inventory digest matches on the device

The inventory is read from the signed APK's assets, not from the
extracted copy. A missing file or another digest or size fails the start
with `Failed(Payload)`; nothing is spawned.

```quint
type Observed = Missing | Present({ observedSha256: str, observedSize: int })
type DeviceFile = { path: str, sha256: str, size: int, observed: Observed }
type StartCheck = ExtractPayload | PayloadReady | PayloadFailed
pure def observedMatches(observed: Observed, expectedSha256: str, expectedSize: int): bool = match observed {
  | Present(o) => o.observedSha256 == expectedSha256 and o.observedSize == expectedSize
  | Missing => false }
pure def fileIntact(f: DeviceFile): bool = observedMatches(f.observed, f.sha256, f.size)
pure def startCheck(extraction: Extraction, versionCode: int, deviceFiles: List[DeviceFile]): StartCheck =
  if (not(extractionCurrent(extraction, versionCode))) ExtractPayload
  else if (deviceFiles.length() > 0 and deviceFiles.every(f => fileIntact(f))) PayloadReady
  else PayloadFailed
pure val versionCodeValues = Set(1, 2)
pure val deviceFilesValues = Set(
  List(),
  List({ path: "assets/agent/agent.mjs", sha256: "b1", size: 4, observed: Present({ observedSha256: "b1", observedSize: 4 }) }),
  List({ path: "assets/agent/agent.mjs", sha256: "b1", size: 4, observed: Present({ observedSha256: "b2", observedSize: 4 }) }),
  List({ path: "lib/arm64-v8a/libeliza_node.so", sha256: "a1", size: 9, observed: Missing }, { path: "assets/agent/agent.mjs", sha256: "b1", size: 4, observed: Present({ observedSha256: "b1", observedSize: 4 }) }))
pure def lawStaleExtractionNeverSpawns(extraction: Extraction, versionCode: int, deviceFiles: List[DeviceFile]): bool =
  not(extractionCurrent(extraction, versionCode)) implies startCheck(extraction, versionCode, deviceFiles) == ExtractPayload
pure def lawReadyMeansEveryFileMatches(extraction: Extraction, versionCode: int, deviceFiles: List[DeviceFile]): bool =
  startCheck(extraction, versionCode, deviceFiles) == PayloadReady implies deviceFiles.every(f => f.observed == Present({ observedSha256: f.sha256, observedSize: f.size }))
```
