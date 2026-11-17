# Agent bundle

What a product ships to run the agent on a device: one ESM bundle for Node 26
(pure JavaScript and WASM), the PGlite assets beside it, a PGlite snapshot
already migrated to the bundle's schema, and a manifest. `buildAgentBundle`
of `@elizaos/agent/bundle` makes them from the product's plugins and its
product plugin; `readBundleManifest` reads the manifest back. The build
(bundler, digests, the snapshot child process) is the shell; this spec states
which builds may succeed and which manifests may be read. Staging the Node
runtime per processor type, the staged-file inventory and admitting the
bundle at start belong to os, which reads this manifest. Develop's sources
are `packages/agent/scripts/build-mobile-bundle.ts` and
`mobile-bundle-dependencies.ts`, and the Quint model `tooling-mobile-build`.

## Story: Ship one agent bundle whose contents and actions are known

> As the maker of a product built on the agent, I want one bundle with a
> manifest that names exactly the packages, plugins and actions it carries,
> so that the device runs what I built and nothing I did not ask for.

### An input ships a package only when it emitted bytes from a named package inside the source tree

Each bundler input that emitted bytes belongs to one package, whose resolved
path must lie inside the tree being built and whose `package.json` must name
it with a version; the package's row carries that manifest's SHA-256. An
input that emitted nothing contributes nothing. Any other input refuses the
build, and so does a build in which no package contributed.

```quint
type PackageIdentity = Unreadable | Identified({ name: str, version: str, manifestSha256: str })
type BundleInput = { emittedBytes: int, insideSource: bool, identity: PackageIdentity }
type PackageRow = { name: str, version: str, sha256: str }
type InputDisposition = Ignored | Contributes | RefusesBuild
pure def namedIdentity(identity: PackageIdentity): bool =
  match identity { | Identified(p) => p.name != "" and p.version != "" | Unreadable => false }
pure def inputDisposition(i: BundleInput): InputDisposition =
  if (i.emittedBytes <= 0) Ignored
  else if (not(i.insideSource) or not(namedIdentity(i.identity))) RefusesBuild
  else Contributes
pure def rowOf(i: BundleInput): PackageRow = { val identity = i.identity
  match identity { | Identified(p) => { name: p.name, version: p.version, sha256: p.manifestSha256 } | Unreadable => { name: "", version: "", sha256: "" } } }
pure def packageRows(b: Build): List[PackageRow] =
  b.inputs.foldl(List(), (rows, i) => if (inputDisposition(i) == Contributes and not(rows.includes(rowOf(i)))) rows.append(rowOf(i)) else rows)
pure def lawEscapingOrUnnamedInputRefusesTheBuild(b: Build): bool =
  b.inputs.some(i => i.emittedBytes > 0 and (not(i.insideSource) or not(namedIdentity(i.identity)))) implies buildVerdict(b) != Built
pure def lawBuiltBundleHasAPackage(b: Build): bool =
  buildVerdict(b) == Built implies packageRows(b).length() > 0
```

### An excluded package never ships

The build replaces some packages with stubs because they need a native addon
or a desktop host. When one of them still emitted bytes, the build fails.

```quint
pure def contributesExcluded(b: Build): bool =
  b.inputs.some(i => inputDisposition(i) == Contributes and b.excluded.contains(rowOf(i).name))
pure def lawExcludedPackageNeverShips(b: Build, name: str): bool =
  (buildVerdict(b) == Built and b.excluded.contains(name)) implies not(packageRows(b).some(r => r.name == name))
```

### No bundle carries a model weight file or a Node addon

```quint
type PayloadFile = { name: str, extension: str, directories: Set[str] }
pure val modelWeightExtensions = Set("gguf", "onnx", "ort", "tflite", "safetensors", "pte", "task")
pure def lawNoBuiltBundleCarriesWeightsOrAddons(b: Build): bool =
  buildVerdict(b) == Built implies b.files.every(f => not(modelWeightExtensions.contains(f.extension)) and f.extension != "node")
```

### A bundle without local inference carries no native library, local inference program or speech or model directory

The `localInference` plugin is the only way local inference reaches a
bundle; without it the bundle is cloud-only: no `.so` library, no local
inference server program, and nothing under a `tts`, `asr`, `model` or
`models` directory.

```quint
pure val localInferenceDirectories = Set("tts", "asr", "model", "models")
pure val localInferencePrograms = Set("llama-server", "llama-omnivoice-server")
pure def fileAdmitted(localInference: bool, f: PayloadFile): bool =
  not(modelWeightExtensions.contains(f.extension)) and f.extension != "node" and
  (localInference or (f.extension != "so" and not(localInferencePrograms.contains(f.name)) and f.directories.intersect(localInferenceDirectories).size() == 0))
pure def lawCloudOnlyBundleCarriesNoLocalInference(b: Build): bool =
  (buildVerdict(b) == Built and not(b.localInference)) implies
    b.files.every(f => f.extension != "so" and not(localInferencePrograms.contains(f.name)) and f.directories.intersect(localInferenceDirectories).size() == 0)
```

### A bundle is built only when the load smoke booted it and every promoted action it registered names a listed umbrella

The load smoke boots the finished bundle in memory with model backend
`none`. The actions it registered are the manifest's `actions`, each
promoted subaction with its umbrella. A smoke that did not boot, a name
registered twice, or a promoted action whose umbrella is not a listed
top-level action fails the build.

```quint
type ActionOrigin = TopLevel | PromotedFrom({ umbrella: str })
type ListedAction = { name: str, origin: ActionOrigin }
type LoadSmoke = DidNotBoot | Booted({ registered: List[ListedAction] })
pure def registeredActions(b: Build): List[ListedAction] = { val smoke = b.smoke
  match smoke { | Booted(x) => x.registered | DidNotBoot => List() } }
pure def umbrellaListed(actions: List[ListedAction], a: ListedAction): bool = { val origin = a.origin
  match origin { | PromotedFrom(p) => actions.some(u => u.name == p.umbrella and u.origin == TopLevel) | TopLevel => true } }
pure def actionsWellFormed(actions: List[ListedAction]): bool =
  actions.every(a => a.name != "" and actions.select(o => o.name == a.name).length() == 1 and umbrellaListed(actions, a))
pure def lawBuiltOnlyAfterTheSmokeBooted(b: Build): bool =
  buildVerdict(b) == Built implies (b.smoke != DidNotBoot and actionsWellFormed(registeredActions(b)))
```

### The bundled snapshot is migrated to the bundle's schema version

`storage/database.md` seeds an empty data directory from the snapshot only
at the same schema version, so a build whose snapshot stopped at another
version fails.

```quint
type Build = { inputs: List[BundleInput], excluded: Set[str], files: List[PayloadFile], localInference: bool, smoke: LoadSmoke, schemaVersion: int, snapshotSchemaVersion: int }
type BuildVerdict = Built | InputRefused | NoPackage | ExcludedPackage | ForbiddenFile | SmokeFailed | ActionsMalformed | SnapshotBehind
pure def buildVerdict(b: Build): BuildVerdict =
  if (b.inputs.some(i => inputDisposition(i) == RefusesBuild)) InputRefused
  else if (packageRows(b).length() == 0) NoPackage
  else if (contributesExcluded(b)) ExcludedPackage
  else if (not(b.files.every(f => fileAdmitted(b.localInference, f)))) ForbiddenFile
  else if (b.smoke == DidNotBoot) SmokeFailed
  else if (not(actionsWellFormed(registeredActions(b)))) ActionsMalformed
  else if (b.snapshotSchemaVersion != b.schemaVersion) SnapshotBehind
  else Built
pure def lawBuiltSnapshotMatchesTheSchema(b: Build): bool =
  buildVerdict(b) == Built implies b.snapshotSchemaVersion == b.schemaVersion
pure val goodInput: BundleInput = { emittedBytes: 8, insideSource: true, identity: Identified({ name: "core", version: "1", manifestSha256: "h1" }) }
pure val goodBuild: Build = { inputs: List(goodInput), excluded: Set("canvas"), files: List({ name: "agent.mjs", extension: "mjs", directories: Set() }), localInference: false, smoke: Booted({ registered: List({ name: "MANAGE", origin: TopLevel }, { name: "MANAGE_CREATE", origin: PromotedFrom({ umbrella: "MANAGE" }) }) }), schemaVersion: 2, snapshotSchemaVersion: 2 }
pure val bValues = Set(
  goodBuild,
  { ...goodBuild, inputs: List(goodInput, { emittedBytes: 0, insideSource: false, identity: Unreadable }) },
  { ...goodBuild, inputs: List(goodInput, { ...goodInput, insideSource: false }) },
  { ...goodBuild, inputs: List(goodInput, { ...goodInput, identity: Identified({ name: "", version: "1", manifestSha256: "h3" }) }) },
  { ...goodBuild, files: List({ name: "llama-server", extension: "", directories: Set("bin") }) },
  { ...goodBuild, inputs: List({ ...goodInput, identity: Identified({ name: "canvas", version: "2", manifestSha256: "h2" }) }) },
  { ...goodBuild, inputs: List() },
  { ...goodBuild, files: List({ name: "embed.gguf", extension: "gguf", directories: Set("models") }) },
  { ...goodBuild, files: List({ name: "libggml.so", extension: "so", directories: Set("lib") }) },
  { ...goodBuild, localInference: true, files: List({ name: "libggml.so", extension: "so", directories: Set("lib") }) },
  { ...goodBuild, smoke: DidNotBoot },
  { ...goodBuild, smoke: Booted({ registered: List({ name: "MANAGE_CREATE", origin: PromotedFrom({ umbrella: "MANAGE" }) }) }) },
  { ...goodBuild, snapshotSchemaVersion: 1 })
pure val productPluginValues = Set(NoProductPlugin, ProductPluginNamed({ name: "product" }))
pure val workflowWorkerValues = Set(NoWorker, WorkerSha256({ sha256: "w1" }))
pure val nameValues = Set("canvas", "core")
```

### A manifest is read only for the bundle bytes it was made for

`readBundleManifest` accepts schema 1 for Node 26 whose `bundleSha256`
equals the digest of the bundle bytes beside it and which lists at least one
package; a changed bundle needs a new manifest. The build writes the
manifest of a built bundle from its package rows and smoke actions, with the
workflow worker's digest when the workflow plugin's build produced one.

```quint
type ProductPluginName = NoProductPlugin | ProductPluginNamed({ name: str })
type WorkerDigest = NoWorker | WorkerSha256({ sha256: str })
type BundleManifest = { schema: int, bundleSha256: str, sourceCommit: str, node: str, schemaVersion: int, packages: List[PackageRow], plugins: List[str], productPlugin: ProductPluginName, localInference: bool, workflowWorker: WorkerDigest, actions: List[ListedAction] }
pure def manifestOf(b: Build, bundleSha256: str, sourceCommit: str, plugins: List[str], productPlugin: ProductPluginName, workflowWorker: WorkerDigest): BundleManifest =
  { schema: 1, bundleSha256: bundleSha256, sourceCommit: sourceCommit, node: "26", schemaVersion: b.schemaVersion, packages: packageRows(b), plugins: plugins, productPlugin: productPlugin, localInference: b.localInference, workflowWorker: workflowWorker, actions: registeredActions(b) }
pure def manifestReadable(m: BundleManifest, bundleBytesSha256: str): bool =
  m.schema == 1 and m.node == "26" and m.bundleSha256 != "" and m.bundleSha256 == bundleBytesSha256 and m.packages.length() > 0
pure def lawManifestForOtherBytesIsNeverRead(b: Build, bundleSha256: str, bundleBytesSha256: str, sourceCommit: str, plugins: List[str], productPlugin: ProductPluginName, workflowWorker: WorkerDigest): bool =
  bundleSha256 != bundleBytesSha256 implies not(manifestReadable(manifestOf(b, bundleSha256, sourceCommit, plugins, productPlugin, workflowWorker), bundleBytesSha256))
pure def lawBuiltBundleManifestIsReadable(b: Build, bundleSha256: str, sourceCommit: str, plugins: List[str], productPlugin: ProductPluginName, workflowWorker: WorkerDigest): bool =
  (buildVerdict(b) == Built and bundleSha256 != "") implies manifestReadable(manifestOf(b, bundleSha256, sourceCommit, plugins, productPlugin, workflowWorker), bundleSha256)
```
