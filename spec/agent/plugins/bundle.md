# Agent bundle

What a product ships to run the agent on a device: `agent.mjs`, one ESM
bundle for Node 26 (pure JavaScript and WASM), the PGlite assets beside it, a
PGlite snapshot already migrated to the bundle's schema, and `manifest.json`.
`buildAgentBundle({plugins, productPlugin, outDir, sourceCommit, sourceRoot})`
of `@elizaos/agent/bundle` makes them; `readBundleManifest(dir)` reads the
manifest back. The build itself (bundler, digests, snapshot, load smoke) is
the shell; this spec states which builds may succeed and which manifests may
be read. In the manifest, `NoProductPlugin` and `NoWorker` are an absent key,
`NamedProductPlugin(p)` is `productPlugin: p.name`, `WorkerSha256(w)` is
`workflowWorkerSha256: w.sha256`, `TopLevel` is `{name}` and
`PromotedFrom(u)` is `{name, umbrella: u.umbrella}`.

## Story: Ship one agent bundle whose contents and actions are known

> As the maker of a product built on the agent, I want one bundle with a
> manifest that names exactly the packages, plugins and actions it carries,
> so that the device runs what I built and nothing I did not ask for.

### A build is refused unless every input that emitted bytes comes from a named package inside the source root, at least one did, and the entry imports nothing but Node built-ins

The source root (`sourceRoot`, default the working directory) is the
consumer's checkout, which holds the vendored agent tree and the product
plugin's package. Each bundler input that emitted bytes belongs to one
package whose resolved path lies inside that root and whose `package.json`
names it with a version; the package's row carries that `package.json`'s
SHA-256. An input that emitted nothing contributes nothing. An import left
outside the bundle that is not a `node:` built-in refuses the build, since
the device has no `node_modules`. The listed plugins name each plugin once,
never the product plugin (as the launch requires). `buildVerdict` checks the
rules in order; only `Built` replaces `outDir`, whole, by core
[atomic publication](../../core/atomicPublication.md), and any other verdict
leaves `outDir` as it was.

```quint
import launch.* from "../host/launch"
type ExternalImport = NodeBuiltin | Unbundled({ specifier: str })
type Build = { plugins: List[str], productPlugin: ProductPlugin, inputs: List[BundleInput], externals: List[ExternalImport], files: List[PayloadFile], smoke: LoadSmoke, workflowWorker: WorkerDigest, schemaVersion: int, snapshotSchemaVersion: int }
type BuildVerdict = Built | InputsMalformed | InputRefused | NoPackage | ExcludedPackage | ForbiddenFile | AssetMissing | SmokeFailed | PluginMissing | WorkerMissing | ActionsMalformed | SnapshotMismatch
pure def buildVerdict(b: Build): BuildVerdict =
  if (not(pluginsWellFormed(b.plugins, b.productPlugin))) InputsMalformed
  else if (b.inputs.some(i => inputDisposition(i) == RefusesBuild) or b.externals.some(e => e != NodeBuiltin)) InputRefused
  else if (packageRows(b).length() == 0) NoPackage
  else if (contributesExcluded(b)) ExcludedPackage
  else if (not(b.files.every(f => fileAdmitted(carriesLocalInference(b), f)))) ForbiddenFile
  else if (not(requiredFilesPresent(b))) AssetMissing
  else if (b.smoke == DidNotBoot) SmokeFailed
  else if (not(pluginsShipped(b))) PluginMissing
  else if (b.plugins.includes(workflowPlugin) != workerPinned(b.workflowWorker)) WorkerMissing
  else if (not(actionsWellFormed(registeredActions(b)))) ActionsMalformed
  else if (not(snapshotCurrent(b))) SnapshotMismatch
  else Built
type PackageIdentity = Unreadable | Identified({ name: str, version: str, manifestSha256: str })
type BundleInput = { emittedBytes: int, insideSource: bool, identity: PackageIdentity }
type PackageRow = { name: str, version: str, sha256: str }
type InputDisposition = Ignored | Contributes | RefusesBuild
pure def pluginsWellFormed(plugins: List[str], product: ProductPlugin): bool =
  not(plugins.includes("")) and plugins.every(n => plugins.select(m => m == n).length() == 1) and productPluginAdmitted(product, plugins)
pure def namedIdentity(identity: PackageIdentity): bool =
  match identity { | Identified(p) => p.name != "" and p.version != "" and p.manifestSha256 != "" | Unreadable => false }
pure def inputDisposition(i: BundleInput): InputDisposition =
  if (i.emittedBytes <= 0) Ignored
  else if (not(i.insideSource) or not(namedIdentity(i.identity))) RefusesBuild
  else Contributes
pure def rowOf(i: BundleInput): PackageRow = { val identity = i.identity
  match identity { | Identified(p) => { name: p.name, version: p.version, sha256: p.manifestSha256 } | Unreadable => { name: "", version: "", sha256: "" } } }
pure def packageRows(b: Build): List[PackageRow] =
  b.inputs.foldl(List(), (rows, i) => if (inputDisposition(i) == Contributes and not(rows.includes(rowOf(i)))) rows.append(rowOf(i)) else rows)
pure val bValues = {
  val core = { emittedBytes: 8, insideSource: true, identity: Identified({ name: "core", version: "1", manifestSha256: "h1" }) }
  val product = { emittedBytes: 4, insideSource: true, identity: Identified({ name: "product", version: "1", manifestSha256: "h2" }) }
  val local = { emittedBytes: 6, insideSource: true, identity: Identified({ name: "@elizaos/plugin-local-inference", version: "1", manifestSha256: "h4" }) }
  val workflow = { emittedBytes: 6, insideSource: true, identity: Identified({ name: "@elizaos/plugin-workflow", version: "1", manifestSha256: "h5" }) }
  val assets = List({ name: "agent.mjs", extension: "mjs", directories: List() }, { name: "pglite.wasm", extension: "wasm", directories: List() }, { name: "initdb.wasm", extension: "wasm", directories: List() }, { name: "pglite.data", extension: "data", directories: List() }, { name: "pglite-migrated.bin", extension: "bin", directories: List() })
  val localAssets = assets.append({ name: "vector.tar.gz", extension: "gz", directories: List() }).append({ name: "libggml.so.1", extension: "so", directories: List("lib") })
  val manage = { name: "MANAGE", origin: TopLevel }
  val ok: Build = { plugins: List(), productPlugin: NamedProductPlugin({ name: "product" }), inputs: List(core, product), externals: List(NodeBuiltin), files: assets, smoke: Booted({ loaded: List("product"), registered: List(manage, { name: "MANAGE_CREATE", origin: PromotedFrom({ umbrella: "MANAGE" }) }) }), workflowWorker: NoWorker, schemaVersion: 2, snapshotSchemaVersion: 2 }
  val localOk: Build = { ...ok, plugins: List("@elizaos/plugin-local-inference"), inputs: List(core, product, local), files: localAssets, smoke: Booted({ loaded: List("@elizaos/plugin-local-inference", "product"), registered: List(manage) }) }
  val workflowSmoke = Booted({ loaded: List("@elizaos/plugin-workflow", "product"), registered: List(manage) })
  Set(ok, localOk,
    { ...ok, plugins: List("@elizaos/plugin-workflow"), inputs: List(core, product, workflow), smoke: workflowSmoke, workflowWorker: WorkerSha256({ sha256: "w1" }) },
    { ...ok, inputs: List(core, product, { emittedBytes: 0, insideSource: false, identity: Unreadable }) },
    { ...ok, plugins: List("product") },
    { ...ok, inputs: List(core, product, { ...core, insideSource: false }) },
    { ...ok, externals: List(NodeBuiltin, Unbundled({ specifier: "sharp" })) },
    { ...ok, inputs: List() },
    { ...ok, inputs: List(core, product, { ...core, identity: Identified({ name: "canvas", version: "2", manifestSha256: "h6" }) }) },
    { ...ok, files: assets.append({ name: "llama-kernel-diagnostic.mjs", extension: "mjs", directories: List() }) },
    { ...localOk, files: localAssets.append({ name: "embed.gguf", extension: "gguf", directories: List("models") }) },
    { ...localOk, files: assets },
    { ...ok, smoke: DidNotBoot },
    { ...ok, smoke: Booted({ loaded: List(), registered: List(manage) }) },
    { ...ok, plugins: List("@elizaos/plugin-workflow"), inputs: List(core, product, workflow), smoke: workflowSmoke },
    { ...ok, workflowWorker: WorkerSha256({ sha256: "w1" }) },
    { ...ok, smoke: Booted({ loaded: List("product"), registered: List({ name: "MANAGE_CREATE", origin: PromotedFrom({ umbrella: "MANAGE" }) }) }) },
    { ...ok, snapshotSchemaVersion: 1 })
}
```

### An excluded package never ships

The build stubs packages that need a native addon or a desktop host. When
one of them still emitted bytes, the build fails, so no package row names it.

```quint
pure val excludedPackages = Set("canvas", "sharp", "node-llama-cpp", "@node-llama-cpp/linux-arm64", "@node-llama-cpp/linux-x64", "llama-cpp-capacitor", "pty-manager", "@node-rs/argon2", "fsevents", "zlib-sync", "@napi-rs/keyring", "@snazzah/davey", "puppeteer-core")
pure val nameValues = Set("canvas", "core")
pure def contributesExcluded(b: Build): bool =
  b.inputs.some(i => inputDisposition(i) == Contributes and excludedPackages.contains(rowOf(i).name))
pure def lawExcludedPackageNeverShips(b: Build, name: str): bool =
  (buildVerdict(b) == Built and excludedPackages.contains(name)) implies not(packageRows(b).some(r => r.name == name))
```

### No bundle carries a model weight file or a Node addon

A file with extension `gguf`, `onnx`, `ort`, `tflite`, `safetensors`, `pte`,
`task` or `node` refuses the build. The shell derives a file's extension,
since Quint has no string splitting: its lower-cased last suffix, except
that a shared library's version suffixes are skipped (`libggml.so.1.2` has
extension `so`). os's cloud-only payload check must import this list
rather than keep its own.

```quint
type PayloadFile = { name: str, extension: str, directories: List[str] }
pure val modelWeightExtensions = Set("gguf", "onnx", "ort", "tflite", "safetensors", "pte", "task")
pure val addonExtension = "node"
pure def payloadFileAllowed(f: PayloadFile): bool = not(modelWeightExtensions.contains(f.extension)) and f.extension != addonExtension
```

### A bundle without the local inference plugin carries only its required files and manifest, all at its root

Local inference reaches a bundle only through
`@elizaos/plugin-local-inference` in `plugins`, and the manifest's
`localInference` says which. A cloud-only bundle's payload is closed: every
file is a required file or `manifest.json`, at the root, and none is a
shared library; so it has no local-inference script or program and nothing
under a `tts`, `asr`, `model` or `models` directory. A local-inference
bundle may also carry the plugin's libraries, programs and voice data.

```quint
pure val localInferencePlugin = "@elizaos/plugin-local-inference"
pure val manifestFile = "manifest.json"
pure val sharedLibraryExtension = "so"
pure val localInferenceDirectories = Set("tts", "asr", "model", "models")
pure val localInferencePrograms = Set("llama-server", "llama-omnivoice-server")
pure def carriesLocalInference(b: Build): bool = b.plugins.includes(localInferencePlugin)
pure def fileAdmitted(localInference: bool, f: PayloadFile): bool =
  payloadFileAllowed(f) and (localInference or
    (f.directories == List() and f.extension != sharedLibraryExtension and requiredFiles(false).union(Set(manifestFile)).contains(f.name)))
pure def lawCloudOnlyBundleCarriesNoLocalInference(b: Build): bool =
  (buildVerdict(b) == Built and not(carriesLocalInference(b))) implies b.files.every(f =>
    f.extension != sharedLibraryExtension and not(localInferencePrograms.contains(f.name)) and not(f.directories.some(d => localInferenceDirectories.contains(d))))
```

### A built bundle carries its entry file, the PGlite assets, the migrated snapshot and, with local inference, the vector extension

pgvector loads only with local embeddings, which come only through the
local inference plugin, so only that bundle needs `vector.tar.gz`.

```quint
pure val baseFiles = Set("agent.mjs", "pglite.wasm", "initdb.wasm", "pglite.data", "pglite-migrated.bin")
pure def requiredFiles(localInference: bool): Set[str] = if (localInference) baseFiles.union(Set("vector.tar.gz")) else baseFiles
pure def requiredFilesPresent(b: Build): bool =
  requiredFiles(carriesLocalInference(b)).forall(n => b.files.some(f => f.name == n and f.directories == List()))
```

### A bundle is built only when every listed plugin and the product plugin ship as packages and the load smoke loaded them

The load smoke boots the finished bundle in memory with model backend
`none` and loads every listed plugin, the agent's own modules and the
product plugin, so its registry holds every action a launch can register.

```quint
pure def bundledPlugins(b: Build): List[str] = { val product = b.productPlugin
  match product { | NamedProductPlugin(p) => b.plugins.append(p.name) | NoProductPlugin => b.plugins } }
pure def loadedPlugins(b: Build): List[str] = { val smoke = b.smoke
  match smoke { | Booted(x) => x.loaded | DidNotBoot => List() } }
pure def pluginsShipped(b: Build): bool =
  bundledPlugins(b).every(n => packageRows(b).some(r => r.name == n) and loadedPlugins(b).includes(n))
```

### A build pins the workflow worker's digest exactly when it carries the workflow plugin

The build reads the worker's SHA-256 from the workflow plugin's build
output; os stages the worker only under that pin.

```quint
type WorkerDigest = NoWorker | WorkerSha256({ sha256: str })
pure val workflowPlugin = "@elizaos/plugin-workflow"
pure def workerPinned(w: WorkerDigest): bool = match w { | WorkerSha256(x) => x.sha256 != "" | NoWorker => false }
```

### A bundle is built only when its load smoke registered each action once under a non-empty name, each promoted action under a listed top-level umbrella

The smoke reads the runtime's action registry in its own process call (not
`/api/status`): each registered action, and each subaction an umbrella
promotes with that umbrella's name. These are the manifest's `actions`.

```quint
type ActionOrigin = TopLevel | PromotedFrom({ umbrella: str })
type ListedAction = { name: str, origin: ActionOrigin }
type LoadSmoke = DidNotBoot | Booted({ loaded: List[str], registered: List[ListedAction] })
pure def registeredActions(b: Build): List[ListedAction] = { val smoke = b.smoke
  match smoke { | Booted(x) => x.registered | DidNotBoot => List() } }
pure def umbrellaListed(actions: List[ListedAction], a: ListedAction): bool = { val origin = a.origin
  match origin { | PromotedFrom(p) => actions.some(u => u.name == p.umbrella and u.origin == TopLevel) | TopLevel => true } }
pure def actionsWellFormed(actions: List[ListedAction]): bool =
  actions.every(a => a.name != "" and actions.select(o => o.name == a.name).length() == 1 and umbrellaListed(actions, a))
```

### A bundle is built only when its snapshot is migrated to the bundle's positive schema version

`storage/database.md` seeds an empty data directory from the snapshot only
at the same schema version.

```quint
pure def snapshotCurrent(b: Build): bool = b.schemaVersion > 0 and b.snapshotSchemaVersion == b.schemaVersion
```

### A manifest is read only for its own bundle bytes and only when it is one a build could write

`readBundleManifest` reads `manifest.json` and accepts schema 1 for Node 26
with a source commit and a positive schema version, whose `bundleSha256`
equals the digest of the `agent.mjs` beside it, which lists at least one
package and no row twice, whose plugins are well formed, whose
`localInference` holds exactly when it lists the local inference plugin,
which pins a worker exactly when it lists the workflow plugin, and whose
actions are well formed. A changed bundle needs a new manifest. The schema
decides digest and commit shapes. The build writes the manifest from the
build, so every built bundle's manifest is readable.

```quint
type BundleManifest = { schema: int, bundleSha256: str, sourceCommit: str, node: str, schemaVersion: int, packages: List[PackageRow], plugins: List[str], productPlugin: ProductPlugin, localInference: bool, workflowWorker: WorkerDigest, actions: List[ListedAction] }
pure def manifestOf(b: Build, bundleSha256: str, sourceCommit: str): BundleManifest =
  { schema: 1, bundleSha256: bundleSha256, sourceCommit: sourceCommit, node: "26", schemaVersion: b.schemaVersion, packages: packageRows(b), plugins: b.plugins, productPlugin: b.productPlugin, localInference: carriesLocalInference(b), workflowWorker: b.workflowWorker, actions: registeredActions(b) }
pure def manifestReadable(m: BundleManifest, bundleBytesSha256: str): bool =
  m.schema == 1 and m.node == "26" and m.sourceCommit != "" and m.schemaVersion > 0 and m.bundleSha256 != "" and m.bundleSha256 == bundleBytesSha256 and
  m.packages.length() > 0 and m.packages.every(r => m.packages.select(o => o == r).length() == 1) and pluginsWellFormed(m.plugins, m.productPlugin) and
  m.localInference == m.plugins.includes(localInferencePlugin) and workerPinned(m.workflowWorker) == m.plugins.includes(workflowPlugin) and actionsWellFormed(m.actions)
pure def lawBuiltBundleManifestIsReadable(b: Build, bundleSha256: str, sourceCommit: str): bool =
  (buildVerdict(b) == Built and bundleSha256 != "" and sourceCommit != "") implies manifestReadable(manifestOf(b, bundleSha256, sourceCommit), bundleSha256)
```
