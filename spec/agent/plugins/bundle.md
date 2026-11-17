# Agent bundle

What a product ships to run the agent on a device: `agent.mjs`, one ESM
bundle for Node 26 (pure JavaScript and WASM), the PGlite assets beside it, a
PGlite snapshot already migrated to the bundle's schema, and a manifest.
`buildAgentBundle({plugins, productPlugin, outDir, sourceCommit})` of
`@elizaos/agent/bundle` makes them; `readBundleManifest(dir)` reads the
manifest back. The build (bundler, digests, the snapshot child process, the
load smoke) is the shell; this spec states which builds may succeed and which
manifests may be read. Staging the Node runtime per processor type, the
staged-file inventory and admitting the bundle at start belong to os, which
reads this manifest and imports this library's file rules. Develop's sources
are `packages/agent/scripts/build-mobile-bundle.ts` and
`mobile-bundle-dependencies.ts`, and the Quint model `tooling-mobile-build`.

The manifest is JSON written and read by `manifest.schema.vibe` with these
keys: `schema`, `bundleSha256`, `sourceCommit`, `node`, `schemaVersion`,
`packages: [{name, version, sha256}]`, `plugins`, `productPlugin?`,
`localInference`, `workflowWorkerSha256?` and `actions: [{name, umbrella?}]`.
The variants below model the optional keys: `NoProductPlugin` and `NoWorker`
are an absent key, `NamedProductPlugin(p)` is `productPlugin: p.name`,
`WorkerSha256(w)` is `workflowWorkerSha256: w.sha256`, `TopLevel` is
`{name}` and `PromotedFrom(u)` is `{name, umbrella: u.umbrella}`.

## Story: Ship one agent bundle whose contents and actions are known

> As the maker of a product built on the agent, I want one bundle with a
> manifest that names exactly the packages, plugins and actions it carries,
> so that the device runs what I built and nothing I did not ask for.

### A build is refused unless every input that emitted bytes comes from a named package inside the source root, and at least one did

The source root is the consumer's checkout, which holds both the vendored
agent tree and the product plugin's package. Each bundler input that emitted
bytes belongs to one package whose resolved path lies inside that root and
whose `package.json` names it with a version; the package's row carries that
`package.json`'s SHA-256. An input that emitted nothing contributes nothing.
`buildVerdict` checks this rule and each rule below in order.

```quint
import launch.* from "../host/launch"
type Build = { plugins: List[str], productPlugin: ProductPlugin, inputs: List[BundleInput], excluded: List[str], files: List[PayloadFile], smoke: LoadSmoke, workflowWorker: WorkerDigest, schemaVersion: int, snapshotSchemaVersion: int }
type BuildVerdict = Built | InputRefused | NoPackage | ExcludedPackage | ForbiddenFile | AssetMissing | SmokeFailed | PluginMissing | ActionsMalformed | SnapshotBehind
pure def buildVerdict(b: Build): BuildVerdict =
  if (b.inputs.some(i => inputDisposition(i) == RefusesBuild)) InputRefused
  else if (packageRows(b).length() == 0) NoPackage
  else if (contributesExcluded(b)) ExcludedPackage
  else if (not(b.files.every(f => fileAdmitted(carriesLocalInference(b), f)))) ForbiddenFile
  else if (not(requiredFilesPresent(b))) AssetMissing
  else if (b.smoke == DidNotBoot) SmokeFailed
  else if (not(pluginsShipped(b))) PluginMissing
  else if (not(actionsWellFormed(registeredActions(b)))) ActionsMalformed
  else if (not(snapshotCurrent(b))) SnapshotBehind
  else Built
type PackageIdentity = Unreadable | Identified({ name: str, version: str, manifestSha256: str })
type BundleInput = { emittedBytes: int, insideSource: bool, identity: PackageIdentity }
type PackageRow = { name: str, version: str, sha256: str }
type InputDisposition = Ignored | Contributes | RefusesBuild
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
  val assets = List({ name: "agent.mjs", extension: "mjs", directories: List() }, { name: "pglite.wasm", extension: "wasm", directories: List() }, { name: "pglite.data", extension: "data", directories: List() }, { name: "pglite-migrated.bin", extension: "bin", directories: List() })
  val manage = { name: "MANAGE", origin: TopLevel }
  val ok: Build = { plugins: List(), productPlugin: NamedProductPlugin({ name: "product" }), inputs: List(core, product), excluded: List("canvas"), files: assets, smoke: Booted({ loaded: List("product"), registered: List(manage, { name: "MANAGE_CREATE", origin: PromotedFrom({ umbrella: "MANAGE" }) }) }), workflowWorker: NoWorker, schemaVersion: 2, snapshotSchemaVersion: 2 }
  val local = { emittedBytes: 6, insideSource: true, identity: Identified({ name: "@elizaos/plugin-local-inference", version: "1", manifestSha256: "h4" }) }
  val workflow = { emittedBytes: 6, insideSource: true, identity: Identified({ name: "@elizaos/plugin-workflow", version: "1", manifestSha256: "h5" }) }
  Set(ok,
    { ...ok, inputs: List(core, product, { emittedBytes: 0, insideSource: false, identity: Unreadable }) },
    { ...ok, inputs: List(core, product, { ...core, insideSource: false }) },
    { ...ok, inputs: List(core, product, { ...core, identity: Unreadable }) },
    { ...ok, inputs: List(core, product, { ...core, identity: Identified({ name: "", version: "1", manifestSha256: "h3" }) }) },
    { ...ok, inputs: List(core, product, { ...core, identity: Identified({ name: "x", version: "1", manifestSha256: "" }) }) },
    { ...ok, inputs: List(core, product, { ...core, identity: Identified({ name: "canvas", version: "2", manifestSha256: "h6" }) }) },
    { ...ok, inputs: List() },
    { ...ok, inputs: List(core) },
    { ...ok, files: assets.append({ name: "embed.gguf", extension: "gguf", directories: List("models") }) },
    { ...ok, files: assets.append({ name: "addon.node", extension: "node", directories: List("lib") }) },
    { ...ok, files: assets.append({ name: "libggml.so.1", extension: "so", directories: List("lib") }) },
    { ...ok, files: assets.append({ name: "llama-server", extension: "", directories: List("bin") }) },
    { ...ok, files: assets.append({ name: "voice.json", extension: "json", directories: List("tts") }) },
    { ...ok, plugins: List("@elizaos/plugin-local-inference"), inputs: List(core, product, local), smoke: Booted({ loaded: List("@elizaos/plugin-local-inference", "product"), registered: List(manage) }), files: assets.append({ name: "libggml.so", extension: "so", directories: List("lib") }) },
    { ...ok, plugins: List("@elizaos/plugin-workflow"), inputs: List(core, product, workflow), smoke: Booted({ loaded: List("@elizaos/plugin-workflow", "product"), registered: List(manage) }), workflowWorker: WorkerSha256({ sha256: "w1" }) },
    { ...ok, plugins: List("@elizaos/plugin-workflow"), inputs: List(core, product, workflow) },
    { ...ok, files: assets.select(f => f.name != "pglite.data") },
    { ...ok, smoke: DidNotBoot },
    { ...ok, smoke: Booted({ loaded: List(), registered: List(manage) }) },
    { ...ok, smoke: Booted({ loaded: List("product"), registered: List({ name: "MANAGE_CREATE", origin: PromotedFrom({ umbrella: "MANAGE" }) }) }) },
    { ...ok, smoke: Booted({ loaded: List("product"), registered: List(manage, manage) }) },
    { ...ok, smoke: Booted({ loaded: List("product"), registered: List({ name: "", origin: TopLevel }) }) },
    { ...ok, snapshotSchemaVersion: 1 })
}
pure val nameValues = Set("canvas", "core")
```

### An excluded package never ships

The build replaces some packages with stubs because they need a native addon
or a desktop host. When one of them still emitted bytes, the build fails.

```quint
pure def contributesExcluded(b: Build): bool =
  b.inputs.some(i => inputDisposition(i) == Contributes and b.excluded.includes(rowOf(i).name))
pure def lawExcludedPackageNeverShips(b: Build, name: str): bool =
  (buildVerdict(b) == Built and b.excluded.includes(name)) implies not(packageRows(b).some(r => r.name == name))
```

### No bundle carries a model weight file or a Node addon

A file with extension `gguf`, `onnx`, `ort`, `tflite`, `safetensors`, `pte`,
`task` or `node` refuses the build. A file's extension is its lower-cased
last suffix, except that a shared library's version suffixes are skipped:
`libggml.so.1.2` has extension `so`. This list is the one definition; os
imports it for its cloud-only payload check.

```quint
type PayloadFile = { name: str, extension: str, directories: List[str] }
pure val modelWeightExtensions = Set("gguf", "onnx", "ort", "tflite", "safetensors", "pte", "task")
```

### A bundle without the local inference plugin carries no shared library, local inference program or speech or model directory

Local inference reaches a bundle only through `@elizaos/plugin-local-inference`
in `plugins`; without it the bundle is cloud-only: no `.so` library, no
`llama-server` or `llama-omnivoice-server`, and nothing under a `tts`, `asr`,
`model` or `models` directory. The manifest's `localInference` says which.

```quint
pure val localInferencePlugin = "@elizaos/plugin-local-inference"
pure val localInferenceDirectories = Set("tts", "asr", "model", "models")
pure val localInferencePrograms = Set("llama-server", "llama-omnivoice-server")
pure def carriesLocalInference(b: Build): bool = b.plugins.includes(localInferencePlugin)
pure def fileAdmitted(localInference: bool, f: PayloadFile): bool =
  not(modelWeightExtensions.contains(f.extension)) and f.extension != "node" and
  (localInference or (f.extension != "so" and not(localInferencePrograms.contains(f.name)) and not(f.directories.some(d => localInferenceDirectories.contains(d)))))
```

### A built bundle carries its entry file, the PGlite assets and the migrated snapshot

```quint
pure val requiredFiles = Set("agent.mjs", "pglite.wasm", "pglite.data", "pglite-migrated.bin")
pure def requiredFilesPresent(b: Build): bool =
  requiredFiles.forall(n => b.files.some(f => f.name == n and f.directories == List()))
```

### A bundle is built only when every listed plugin and the product plugin ship as packages and the load smoke loaded them

The load smoke boots the finished bundle in memory with model backend `none`
and loads every listed plugin, the agent's built-in modules and the product
plugin, so its registered actions are every action a launch can register.

```quint
pure def bundledPlugins(b: Build): List[str] = { val product = b.productPlugin
  match product { | NamedProductPlugin(p) => b.plugins.append(p.name) | NoProductPlugin => b.plugins } }
pure def loadedPlugins(b: Build): List[str] = { val smoke = b.smoke
  match smoke { | Booted(x) => x.loaded | DidNotBoot => List() } }
pure def pluginsShipped(b: Build): bool =
  bundledPlugins(b).every(n => packageRows(b).some(r => r.name == n) and loadedPlugins(b).includes(n))
```

### A bundle is built only when its load smoke booted and registered each action once under a non-empty name, each promoted action under a listed top-level umbrella

The registered actions are the manifest's `actions`.

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

### A bundle is built only when its snapshot is migrated to the bundle's schema version

`storage/database.md` seeds an empty data directory from the snapshot only
at the same schema version.

```quint
pure def snapshotCurrent(b: Build): bool = b.snapshotSchemaVersion == b.schemaVersion
```

### A built bundle's manifest is readable for its own bytes

The build writes the manifest from the build: its package rows, plugins,
product plugin and smoke actions. When `@elizaos/plugin-workflow` is listed,
the build reads the worker's SHA-256 from that plugin's build output and
writes it as `workflowWorkerSha256`.

```quint
type WorkerDigest = NoWorker | WorkerSha256({ sha256: str })
type BundleManifest = { schema: int, bundleSha256: str, sourceCommit: str, node: str, schemaVersion: int, packages: List[PackageRow], plugins: List[str], productPlugin: ProductPlugin, localInference: bool, workflowWorker: WorkerDigest, actions: List[ListedAction] }
pure val workflowPlugin = "@elizaos/plugin-workflow"
pure def manifestOf(b: Build, bundleSha256: str, sourceCommit: str): BundleManifest = {
  val worker = if (b.plugins.includes(workflowPlugin)) b.workflowWorker else NoWorker
  { schema: 1, bundleSha256: bundleSha256, sourceCommit: sourceCommit, node: "26", schemaVersion: b.schemaVersion, packages: packageRows(b), plugins: b.plugins, productPlugin: b.productPlugin, localInference: carriesLocalInference(b), workflowWorker: worker, actions: registeredActions(b) }
}
pure def lawBuiltBundleManifestIsReadable(b: Build, bundleSha256: str, sourceCommit: str): bool =
  (buildVerdict(b) == Built and bundleSha256 != "") implies manifestReadable(manifestOf(b, bundleSha256, sourceCommit), bundleSha256)
```

### A manifest is never read for other bundle bytes

`readBundleManifest` accepts schema 1 for Node 26 whose `bundleSha256`
equals the digest of the bundle bytes beside it, which lists at least one
package and no package row twice, and whose actions are well formed; a
changed bundle needs a new manifest.

```quint
pure def manifestReadable(m: BundleManifest, bundleBytesSha256: str): bool =
  m.schema == 1 and m.node == "26" and m.bundleSha256 != "" and m.bundleSha256 == bundleBytesSha256 and
  m.packages.length() > 0 and m.packages.every(r => m.packages.select(o => o == r).length() == 1) and actionsWellFormed(m.actions)
```
