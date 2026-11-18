# Android host profile

A consumer generates its Android host project from data: an identity and a
profile (`generateAndroidHost`, exported from `@elizaos/os/build`). The
profile is schema 2. It names everything the Gradle project is made of: SDK
levels, distribution variants, manifests, source sets, the os modules it
builds, its own Gradle modules, Maven dependencies, assets, pre-build
commands, signing and version environment names, the agent's data files and
the agent service's notification and launch hook. The
release story below describes how the generated project is built and signed,
the [runtime payload](./runtimePayload.md) is what an agent host
ships, and the [bridge vocabulary](../android/bridge.md) names what the os
modules provide. The sources are develop's `consumer-host.mjs` and the
`embeddedAgent` entry of the pinned integration branch.

The shell (`src/build/android-host-profile.vibe`) decodes the JSON, tests
each name against its pattern, splits each path on `/` into segments and
passes the facts below; a path with a backslash or a NUL is `NotAPath`. The
generator resolves links before it splits a path it found on disk. The
admitted profile carries everything the generator writes, so the generator
decides nothing again.

## Story: Generate my app's Android host from data

> As a consumer, I want my Android host generated from a profile that says
> everything explicitly, so that no source is read from outside the roots I
> name, no os module adds what I did not ask for, and no release is
> published with a partial signing setup.

### A profile states schema 2 and has no companion entry

Schema 1 is read only through the map of the second story; any other
schema is refused. The agent service runs exactly one Node child, so a
profile that names a companion is refused.

```quint
type ProfileSchema = SchemaTwo | SchemaOne | SchemaUnknown
pure def profileSchema(schema: int): ProfileSchema = if (schema == 2) SchemaTwo else if (schema == 1) SchemaOne else SchemaUnknown
pure val schemaValues = Set(0, 1, 2, 3)
```

### The identity is a package name, a label, a plain version and a bounded version code

The application id is a dotted lowercase package name, the name is a
visible label, the version is a plain release label of at most 64
characters, and the version code is positive and at most 2,100,000,000.

```quint
pure val maxVersionCode = 2100000000
pure def identityAdmitted(appIdValid: bool, appNameValid: bool, versionValid: bool, versionCode: int): bool =
  appIdValid and appNameValid and versionValid and versionCode > 0 and versionCode <= maxVersionCode
pure val versionCodeValues = Set(0, 1, 2100000000, 2100000001)
```

### The SDK levels start at 29 and never decrease from minimum to target to compile

```quint
pure val minSdkFloor = 29
pure def sdkAdmitted(minSdk: int, targetSdk: int, compileSdk: int): bool = minSdk >= minSdkFloor and minSdk <= targetSdk and targetSdk <= compileSdk
pure val minSdkValues = Set(28, 29, 36)
pure val targetSdkValues = Set(29, 35, 36)
pure val compileSdkValues = Set(35, 36)
```

### Distribution variants are explicit, distinct and never a build type or a fixed source set

The profile lists at least one flavor. A flavor's manifest and build
configuration fields apply to that flavor only.

```quint
pure def distinctNames(names: List[str]): bool = names.every(n => names.select(m => m == n).length() == 1)
pure val fixedSourceSets = List("main", "androidTest", "debug", "release")
pure val reservedFlavorNames = List("main", "androidTest", "debug", "release", "test")
pure def flavorsAdmitted(flavors: List[str], flavorNamesValid: bool): bool =
  flavors.length() > 0 and flavorNamesValid and distinctNames(flavors) and not(flavors.some(f => reservedFlavorNames.includes(f)))
pure val flavorsValues = Set(List(), List("store"), List("store", "sideload"), List("store", "store"), List("release"))
```

### Build configuration fields are distinct Java constants whose values fit their types

A field is `boolean`, `int` or `String`. An `int` fits a Java `int`. The
fields of the profile, of each flavor and of each build type are separate
groups.

```quint
pure val javaIntMin = -2147483648
pure val javaIntMax = 2147483647
type FieldValue = BooleanValue | IntValue({ number: int }) | StringValue | MismatchedValue
type BuildConfigField = { constant: str, constantValid: bool, javaValue: FieldValue }
pure def valueFits(javaValue: FieldValue): bool = match javaValue {
  | IntValue(i) => i.number >= javaIntMin and i.number <= javaIntMax
  | MismatchedValue => false
  | _ => true }
pure def buildConfigAdmitted(constants: List[BuildConfigField]): bool =
  constants.every(f => f.constantValid and valueFits(f.javaValue)) and distinctNames(constants.listMap(f => f.constant))
```

### Release minification is explicit, and shrinking or proguard rules need it

`releaseMinify` and `kotlin` are booleans. Resource shrinking and proguard
files are admitted only with release minification. A build type's ABI
filters are distinct supported ABIs.

```quint
pure val androidAbis = List("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
pure def abiFiltersAdmitted(abis: List[str]): bool = distinctNames(abis) and abis.every(a => androidAbis.includes(a))
pure def releaseTypeAdmitted(releaseMinify: bool, shrinkResources: bool, proguardFiles: int): bool =
  releaseMinify or (not(shrinkResources) and proguardFiles == 0)
pure val proguardFilesValues = Set(0, 1)
pure def lawShrinkingNeedsMinification(shrinkResources: bool, proguardFiles: int): bool =
  releaseTypeAdmitted(false, shrinkResources, proguardFiles) implies (not(shrinkResources) and proguardFiles == 0)
```

### A version override names both environment variables or none

The names are data, never values: `versionCode` and `versionName`, two
distinct environment variable names.

```quint
type EnvironmentNames = { names: List[str], namesValid: bool }
pure val versionOverrideNames = 2
pure def environmentNamesAdmitted(env: EnvironmentNames, wanted: int): bool =
  env.names.length() == 0 or (env.names.length() == wanted and env.namesValid and distinctNames(env.names))
```

### Release signing names all four environment variables or none, and a partial set is refused

The profile names the store file, store password, key alias and key
password as four distinct environment variable names, or none. A profile
that names some of them is refused, and the refusal names the missing ones.

```quint
type SigningSetup = NoSigning | CompleteSigning | PartialSigning | MalformedSigning
pure val signingNameCount = 4
pure def signingSetup(env: EnvironmentNames): SigningSetup =
  if (env.names.length() == 0) NoSigning
  else if (env.names.length() < signingNameCount) PartialSigning
  else if (env.names.length() == signingNameCount and env.namesValid and distinctNames(env.names)) CompleteSigning
  else MalformedSigning
pure val envValues = Set(
  { names: List(), namesValid: true },
  { names: List("STORE", "STORE_PASS"), namesValid: true },
  { names: List("STORE", "STORE_PASS", "KEY", "KEY_PASS"), namesValid: true },
  { names: List("STORE", "STORE", "KEY", "KEY_PASS"), namesValid: true },
  { names: List("STORE", "STORE_PASS", "KEY", "key pass"), namesValid: false })
pure def lawPartialSigningIsNeverComplete(env: EnvironmentNames): bool =
  (env.names.length() > 0 and env.names.length() < signingNameCount) implies signingSetup(env) == PartialSigning
```

### Every source lies under exactly one root and never escapes it

The roots are the consumer, the os package and, when given, a dependency
root. A reference names the consumer or the dependency root; os sources
come only through `osModules`. A path is a list of segments with no empty,
`.` or `..` segment; the root itself is admitted only where a directory is
wanted. Roots may nest (the os package is often vendored inside the
consumer), so a source belongs to the innermost root that contains it, and
a reference is admitted only when it names that root.

```quint
type SourceRoot = ConsumerRoot | DependencyRoot | UndeclaredRoot
type SourcePath = RootItself | Below({ segments: List[str] }) | NotAPath
type SourceWanted = WantsFile | WantsDirectory
type HostRoots = { consumer: List[str], os: List[str], dependencies: List[str], dependenciesDeclared: bool }
type SourceRef = { root: SourceRoot, path: SourcePath, wanted: SourceWanted }
type PrefixScan = { at: int, matches: bool }
pure def explicitPath(segments: List[str]): bool = segments.length() > 0 and segments.every(x => x != "" and x != "." and x != "..")
pure def hasPrefix(segments: List[str], prefix: List[str]): bool =
  prefix.length() <= segments.length() and prefix.foldl({ at: 0, matches: true }, (scan, part) => { at: scan.at + 1, matches: scan.matches and segments.nthOr(scan.at, "") == part }).matches
pure def belowSegments(path: SourcePath): List[str] = match path { | Below(b) => b.segments | _ => List() }
pure def pathAdmitted(path: SourcePath, wanted: SourceWanted): bool = match path {
  | RootItself => wanted == WantsDirectory
  | Below(b) => explicitPath(b.segments)
  | NotAPath => false }
pure def rootDeclared(roots: HostRoots, root: SourceRoot): bool = root == ConsumerRoot or (root == DependencyRoot and roots.dependenciesDeclared)
pure def rootSegments(roots: HostRoots, root: SourceRoot): List[str] = if (root == DependencyRoot) roots.dependencies else roots.consumer
pure def declaredRoots(roots: HostRoots): List[List[str]] = List(roots.consumer, roots.os).concat(if (roots.dependenciesDeclared) List(roots.dependencies) else List())
pure def innermostRoot(roots: HostRoots, own: List[str], place: List[str]): bool =
  declaredRoots(roots).every(other => not(hasPrefix(place, other)) or hasPrefix(own, other))
pure def sourceAdmitted(roots: HostRoots, ref: SourceRef): bool =
  rootDeclared(roots, ref.root) and pathAdmitted(ref.path, ref.wanted) and
  innermostRoot(roots, rootSegments(roots, ref.root), rootSegments(roots, ref.root).concat(belowSegments(ref.path)))
pure val rootsValues = Set(
  { consumer: List("work", "app"), os: List("work", "app", "vendor", "os"), dependencies: List("work", "app", "node_modules"), dependenciesDeclared: true },
  { consumer: List("work", "app"), os: List("work", "eliza", "os"), dependencies: List(), dependenciesDeclared: false })
pure val pathValues = Set(RootItself, NotAPath, Below({ segments: List("android", "java") }), Below({ segments: List("vendor", "os", "android") }), Below({ segments: List("..", "other") }), Below({ segments: List() }))
pure def lawUndeclaredRootIsRefused(roots: HostRoots, path: SourcePath, wanted: SourceWanted): bool =
  not(sourceAdmitted(roots, { root: UndeclaredRoot, path: path, wanted: wanted })) and
  (not(roots.dependenciesDeclared) implies not(sourceAdmitted(roots, { root: DependencyRoot, path: path, wanted: wanted })))
pure def lawEscapingPathIsRefused(roots: HostRoots, root: SourceRoot, wanted: SourceWanted): bool =
  not(sourceAdmitted(roots, { root: root, path: NotAPath, wanted: wanted })) and not(sourceAdmitted(roots, { root: root, path: Below({ segments: List() }), wanted: wanted }))
```

### The output is a directory inside the consumer and outside the os package

The roots and the output are absolute paths. The output is never the
consumer root itself.

```quint
pure def rootsAdmitted(roots: HostRoots): bool =
  explicitPath(roots.consumer) and explicitPath(roots.os) and (not(roots.dependenciesDeclared) or explicitPath(roots.dependencies))
pure def outputAdmitted(roots: HostRoots, output: List[str]): bool =
  explicitPath(output) and hasPrefix(output, roots.consumer) and output.length() > roots.consumer.length() and not(hasPrefix(output, roots.os))
pure val outputValues = Set(List("work", "app", "android"), List("work", "app"), List("work", "app", "vendor", "os", "out"), List("elsewhere"), List("work", "app", "..", "x"))
pure def lawOutputIsNeverInsideOs(roots: HostRoots, output: List[str]): bool =
  outputAdmitted(roots, output) implies (not(hasPrefix(output, roots.os)) and output != roots.consumer)
```

### Every manifest and source directory belongs to a declared source set

The source sets are `main`, `androidTest`, `debug`, `release` and each
flavor. A source set holds `java`, `kotlin`, `assets`, `res` or `jniLibs`
directories. A generated source is a directory an admission command
produces below the build directory's `generated` directory.

```quint
pure val sourceKinds = List("java", "kotlin", "assets", "res", "jniLibs")
type SourceSetUse = { sourceSet: str, sourceKind: str }
type GeneratedSource = { generatedSet: str, generatedKind: str, buildPath: List[str] }
pure def sourceSetDeclared(flavors: List[str], sourceSet: str): bool = fixedSourceSets.includes(sourceSet) or flavors.includes(sourceSet)
pure def sourceSetsAdmitted(flavors: List[str], uses: List[SourceSetUse]): bool =
  uses.every(u => sourceSetDeclared(flavors, u.sourceSet) and sourceKinds.includes(u.sourceKind))
pure def generatedSourcesAdmitted(flavors: List[str], generated: List[GeneratedSource]): bool =
  generated.every(g => sourceSetDeclared(flavors, g.generatedSet) and sourceKinds.includes(g.generatedKind) and
    explicitPath(g.buildPath) and g.buildPath.length() > 1 and g.buildPath.nthOr(0, "") == "generated")
```

### An os module comes from the closed list, whole or as a subset of its sources

Each entry names a module once. Without `sources` the module is built as
the Gradle project `:eliza-<module>`. A source is a path below the
module's `src/main` or `src/androidTest`. An entry with a `src/main` source
compiles only the listed sources into the app; an entry with only
`src/androidTest` sources builds the project and adds those contracts to
the app's instrumentation tests. The listener app `sense` is its own app,
not a module.

```quint
pure val osModuleNames = List("agent-service", "runtime-files", "sign-in", "secure-store", "system", "camera", "browser-surface", "calendar", "contacts", "reminders",
  "action-journal", "notifications", "messages", "phone", "passwords", "media", "filesystem", "location", "wifi", "voice-io", "app-update")
type OsModuleEntry = { osModule: str, sources: List[List[str]] }
pure def moduleSourceAdmitted(segments: List[str]): bool =
  explicitPath(segments) and segments.length() > 2 and segments.nthOr(0, "") == "src" and (segments.nthOr(1, "") == "main" or segments.nthOr(1, "") == "androidTest")
pure def builtAsProject(entry: OsModuleEntry): bool = not(entry.sources.some(s => s.nthOr(1, "") == "main"))
pure def selectedModules(entries: List[OsModuleEntry]): List[str] = entries.listMap(e => e.osModule)
pure def osModulesAdmitted(entries: List[OsModuleEntry]): bool =
  distinctNames(selectedModules(entries)) and
  entries.every(e => osModuleNames.includes(e.osModule) and e.sources.every(s => moduleSourceAdmitted(s) and e.sources.select(t => t == s).length() == 1))
pure val entryValues = Set(
  { osModule: "wifi", sources: List() },
  { osModule: "calendar", sources: List(List("src", "main", "java", "Calendar.java")) },
  { osModule: "system", sources: List(List("src", "androidTest", "java", "SystemTest.java")) })
pure def lawMainSubsetIsNeverAProject(entry: OsModuleEntry): bool =
  entry.sources.some(s => s.nthOr(1, "") == "main") implies not(builtAsProject(entry))
```

### A selected os module's own os modules are selected with it

The profile names them explicitly. `agent-service` and `app-update` share
`runtime-files`, so the updater app builds without the agent service;
`voice-io` reads the credential through `sign-in`.

```quint
pure def moduleNeeds(osModule: str): List[str] =
  if (osModule == "agent-service" or osModule == "app-update") List("runtime-files")
  else if (osModule == "voice-io") List("sign-in")
  else List()
pure def modulesClosed(selected: List[str]): bool = selected.every(m => moduleNeeds(m).every(n => selected.includes(n)))
pure val neededValues = Set("runtime-files", "agent-service", "sign-in")
pure def lawAppUpdateNeverNeedsTheAgentService(needed: str): bool = moduleNeeds("app-update").includes(needed) implies needed == "runtime-files"
```

### Gradle project names are distinct and never the app module

The consumer's own Gradle modules come from the consumer or the dependency
root. Their names and the `eliza-<module>` names of the os modules built as
projects are distinct, and none is `app`.

```quint
pure def projectsAdmitted(projects: List[str], projectNamesValid: bool): bool =
  projectNamesValid and distinctNames(projects) and not(projects.includes("app"))
pure val projectsValues = Set(List(), List("capacitor-android", "eliza-wifi"), List("eliza-wifi", "eliza-wifi"), List("app"))
```

### A Maven dependency takes its version only from a toolchain version key

A dependency names a configuration, a `group:artifact` and a key of
`toolchain.json`'s `versions`. A coordinate with its own version is
refused.

```quint
pure val dependencyConfigurations = List("implementation", "androidTestImplementation", "testImplementation")
type MavenDependency = { configuration: str, artifactValid: bool, versionKey: str }
pure def dependenciesAdmitted(toolchainKeys: List[str], dependencies: List[MavenDependency]): bool =
  dependencies.every(d => dependencyConfigurations.includes(d.configuration) and d.artifactValid and toolchainKeys.includes(d.versionKey))
```

### Asset files, app scripts and uncompressed extensions are plain and distinct

An asset file is copied under a plain distinct name; `agent` is the agent
data directory and never an asset name. An app script is a `.gradle` file.
`androidResources.noCompress` lists plain distinct extensions. Manifest
placeholders are string values under plain names.

```quint
pure val agentAssetDirectory = "agent"
pure def assetsAdmitted(assetNames: List[str], assetNamesValid: bool, scriptsAreGradle: bool, noCompress: List[str], noCompressValid: bool, placeholdersValid: bool): bool =
  assetNamesValid and distinctNames(assetNames) and not(assetNames.includes(agentAssetDirectory)) and scriptsAreGradle and
  noCompressValid and distinctNames(noCompress) and placeholdersValid
```

### An admission command is a named argv that runs before the build, in order

Each command has a distinct Gradle task name, a non-empty argv with no
empty argument and a working directory under a root. It runs without a
shell, before `preBuild`. `preBuild` and names that start with `eliza` are
the generator's own.

```quint
type AdmissionCommand = { task: str, taskValid: bool, argv: List[str] }
pure def admissionAdmitted(commands: List[AdmissionCommand]): bool =
  commands.every(c => c.taskValid and c.task != "preBuild" and c.argv.length() > 0 and not(c.argv.includes(""))) and
  distinctNames(commands.listMap(c => c.task))
```

### The agent service needs extracted 16 KiB aligned native libraries

`nativeLibraries: "extract-16k"` extracts the libraries on install and
stores them 16 KiB aligned. The agent service starts `libeliza_node.so`
from the native library directory, so a profile that selects
`agent-service` must ask for it.

```quint
type NativeLibraries = DefaultPackaging | Extract16k
pure def nativeLibrariesAdmitted(packaging: NativeLibraries, selected: List[str]): bool =
  not(selected.includes("agent-service")) or packaging == Extract16k
pure val selectedValues = Set(List(), List("wifi"), List("agent-service", "runtime-files"), List("app-update", "runtime-files"))
pure def lawAgentServiceIsAlwaysExtracted(packaging: NativeLibraries, selected: List[str]): bool =
  (nativeLibrariesAdmitted(packaging, selected) and selected.includes("agent-service")) implies packaging == Extract16k
```

### The agent entry and the agent service settings need the agent service module

`agent {host, character, policy}` names the three agent data files; the
generator copies them into `assets/agent/` and declares the consumer's
service subclass of `ai.eliza.os.agent.AgentService` with the `specialUse`
foreground type and `FOREGROUND_SERVICE_SPECIAL_USE`. The agent service
admits their content. `agentService.notification {smallIcon, color,
channel, strings, stopAction}` names resources and a channel label;
`agentService.launchHook {class, method}` names a static method of a host
class. An agent entry also needs the staged runtime payload.

```quint
type ServiceNotification = NoNotification | NotificationDeclared({ smallIconValid: bool, colorValid: bool, channelValid: bool, stringsValid: bool })
type ServiceHook = NoHook | HookDeclared({ classValid: bool, methodValid: bool })
pure def notificationAdmitted(notification: ServiceNotification): bool = match notification {
  | NotificationDeclared(n) => n.smallIconValid and n.colorValid and n.channelValid and n.stringsValid
  | NoNotification => true }
pure def hookAdmitted(hook: ServiceHook): bool = match hook {
  | HookDeclared(h) => h.classValid and h.methodValid
  | NoHook => true }
pure def agentAdmitted(agentDeclared: bool, notification: ServiceNotification, hook: ServiceHook, selected: List[str]): bool =
  notificationAdmitted(notification) and hookAdmitted(hook) and
  ((not(agentDeclared) and notification == NoNotification and hook == NoHook) or selected.includes("agent-service"))
pure def agentPayloadAdmitted(agentDeclared: bool, runtimeStaged: bool): bool = not(agentDeclared) or runtimeStaged
pure val notificationValues = Set(NoNotification, NotificationDeclared({ smallIconValid: true, colorValid: true, channelValid: true, stringsValid: true }),
  NotificationDeclared({ smallIconValid: true, colorValid: false, channelValid: true, stringsValid: true }))
pure val hookValues = Set(NoHook, HookDeclared({ classValid: true, methodValid: true }), HookDeclared({ classValid: true, methodValid: false }))
pure def lawAgentNeedsTheAgentService(notification: ServiceNotification, hook: ServiceHook, selected: List[str]): bool =
  agentAdmitted(true, notification, hook, selected) implies selected.includes("agent-service")
```

### An os module adds no permission or exported component the profile did not request

The profile's own manifests say which permissions and exported components
the app has. The generator merges every os module's manifest and marks each
permission and exported component that the profile did not request with
`tools:node="remove"`.

```quint
type MergeAction = KeepNode | RemoveNode
pure def mergeAction(requested: List[str], contributed: str): MergeAction = if (requested.includes(contributed)) KeepNode else RemoveNode
pure def lawUnrequestedContributionIsRemoved(requested: List[str], contributed: str): bool =
  mergeAction(requested, contributed) == KeepNode implies requested.includes(contributed)
```

### A profile is admitted only when every rule holds, and a refusal names the first one broken

`ProfileMalformed`, `FieldDropped` and `UpstreamUnmapped` are the reader's
refusals: the JSON has another shape, or a schema-1 field or source has no
successor.

```quint
type HostRefusal = ProfileMalformed | FieldDropped | UpstreamUnmapped | SchemaUnsupported | CompanionDeclared | IdentityInvalid | SdkInvalid | FlavorsInvalid |
  BuildConfigInvalid | BuildTypesInvalid | VersionOverrideInvalid | SigningPartial | SigningInvalid | RootsInvalid | OutputMisplaced | SourceRefused |
  SourceSetInvalid | OsModulesInvalid | OsModulesNotClosed | ProjectsInvalid | DependencyNotPinned | AssetsInvalid | AdmissionInvalid | NativeLibrariesInvalid | AgentInvalid
type HostVerdict = HostAdmitted | HostRefused({ refusal: HostRefusal })
type HostFacts = { schema: int, companionDeclared: bool, appIdValid: bool, appNameValid: bool, versionValid: bool, versionCode: int, minSdk: int, targetSdk: int, compileSdk: int,
  flavors: List[str], flavorNamesValid: bool, fieldGroups: List[List[BuildConfigField]], releaseMinify: bool, shrinkResources: bool, proguardFiles: int, abiGroups: List[List[str]],
  versionOverride: EnvironmentNames, signing: EnvironmentNames, roots: HostRoots, output: List[str], sources: List[SourceRef], uses: List[SourceSetUse], generated: List[GeneratedSource],
  osModules: List[OsModuleEntry], projects: List[str], projectNamesValid: bool, toolchainKeys: List[str], dependencies: List[MavenDependency],
  assetNames: List[str], assetNamesValid: bool, scriptsAreGradle: bool, noCompress: List[str], noCompressValid: bool, placeholdersValid: bool,
  commands: List[AdmissionCommand], packaging: NativeLibraries, agentDeclared: bool, notification: ServiceNotification, hook: ServiceHook }
pure def hostVerdict(facts: HostFacts): HostVerdict = {
  val selected = selectedModules(facts.osModules)
  val signing = signingSetup(facts.signing)
  if (profileSchema(facts.schema) != SchemaTwo) HostRefused({ refusal: SchemaUnsupported })
  else if (facts.companionDeclared) HostRefused({ refusal: CompanionDeclared })
  else if (not(identityAdmitted(facts.appIdValid, facts.appNameValid, facts.versionValid, facts.versionCode))) HostRefused({ refusal: IdentityInvalid })
  else if (not(sdkAdmitted(facts.minSdk, facts.targetSdk, facts.compileSdk))) HostRefused({ refusal: SdkInvalid })
  else if (not(flavorsAdmitted(facts.flavors, facts.flavorNamesValid))) HostRefused({ refusal: FlavorsInvalid })
  else if (not(facts.fieldGroups.every(g => buildConfigAdmitted(g)))) HostRefused({ refusal: BuildConfigInvalid })
  else if (not(releaseTypeAdmitted(facts.releaseMinify, facts.shrinkResources, facts.proguardFiles) and facts.abiGroups.every(g => abiFiltersAdmitted(g)))) HostRefused({ refusal: BuildTypesInvalid })
  else if (not(environmentNamesAdmitted(facts.versionOverride, versionOverrideNames))) HostRefused({ refusal: VersionOverrideInvalid })
  else if (signing == PartialSigning) HostRefused({ refusal: SigningPartial })
  else if (signing == MalformedSigning) HostRefused({ refusal: SigningInvalid })
  else if (not(rootsAdmitted(facts.roots))) HostRefused({ refusal: RootsInvalid })
  else if (not(outputAdmitted(facts.roots, facts.output))) HostRefused({ refusal: OutputMisplaced })
  else if (not(facts.sources.every(r => sourceAdmitted(facts.roots, r)))) HostRefused({ refusal: SourceRefused })
  else if (not(sourceSetsAdmitted(facts.flavors, facts.uses) and generatedSourcesAdmitted(facts.flavors, facts.generated))) HostRefused({ refusal: SourceSetInvalid })
  else if (not(osModulesAdmitted(facts.osModules))) HostRefused({ refusal: OsModulesInvalid })
  else if (not(modulesClosed(selected))) HostRefused({ refusal: OsModulesNotClosed })
  else if (not(projectsAdmitted(facts.projects, facts.projectNamesValid))) HostRefused({ refusal: ProjectsInvalid })
  else if (not(dependenciesAdmitted(facts.toolchainKeys, facts.dependencies))) HostRefused({ refusal: DependencyNotPinned })
  else if (not(assetsAdmitted(facts.assetNames, facts.assetNamesValid, facts.scriptsAreGradle, facts.noCompress, facts.noCompressValid, facts.placeholdersValid))) HostRefused({ refusal: AssetsInvalid })
  else if (not(admissionAdmitted(facts.commands))) HostRefused({ refusal: AdmissionInvalid })
  else if (not(nativeLibrariesAdmitted(facts.packaging, selected))) HostRefused({ refusal: NativeLibrariesInvalid })
  else if (not(agentAdmitted(facts.agentDeclared, facts.notification, facts.hook, selected))) HostRefused({ refusal: AgentInvalid })
  else HostAdmitted
}
pure val factsValues = {
  val roots = { consumer: List("work", "app"), os: List("work", "app", "vendor", "os"), dependencies: List("work", "app", "node_modules"), dependenciesDeclared: true }
  val base = { schema: 2, companionDeclared: false, appIdValid: true, appNameValid: true, versionValid: true, versionCode: 7, minSdk: 29, targetSdk: 36, compileSdk: 36,
    flavors: List("launcher"), flavorNamesValid: true, fieldGroups: List(List({ constant: "IS_LAUNCHER", constantValid: true, javaValue: BooleanValue })),
    releaseMinify: true, shrinkResources: true, proguardFiles: 1, abiGroups: List(List("arm64-v8a")),
    versionOverride: { names: List("CODE", "NAME"), namesValid: true }, signing: { names: List("STORE", "STORE_PASS", "KEY", "KEY_PASS"), namesValid: true },
    roots: roots, output: List("work", "app", "android"), sources: List({ root: ConsumerRoot, path: Below({ segments: List("android", "AndroidManifest.xml") }), wanted: WantsFile }),
    uses: List({ sourceSet: "main", sourceKind: "java" }), generated: List({ generatedSet: "main", generatedKind: "java", buildPath: List("generated", "agent", "java") }),
    osModules: List({ osModule: "agent-service", sources: List() }, { osModule: "runtime-files", sources: List() }), projects: List("capacitor-android", "eliza-agent-service", "eliza-runtime-files"),
    projectNamesValid: true, toolchainKeys: List("androidxAppCompatVersion"), dependencies: List({ configuration: "implementation", artifactValid: true, versionKey: "androidxAppCompatVersion" }),
    assetNames: List("routes.json"), assetNamesValid: true, scriptsAreGradle: true, noCompress: List("gguf"), noCompressValid: true, placeholdersValid: true,
    commands: List({ task: "verifyDeployment", taskValid: true, argv: List("node", "check.mjs") }), packaging: Extract16k, agentDeclared: true,
    notification: NotificationDeclared({ smallIconValid: true, colorValid: true, channelValid: true, stringsValid: true }), hook: HookDeclared({ classValid: true, methodValid: true }) }
  List(base, { ...base, schema: 1 }, { ...base, companionDeclared: true }, { ...base, versionCode: 2100000001 }, { ...base, minSdk: 28 }, { ...base, flavors: List("release") },
    { ...base, signing: { names: List("STORE"), namesValid: true } }, { ...base, output: List("work", "app", "vendor", "os", "out") },
    { ...base, sources: List({ root: ConsumerRoot, path: Below({ segments: List("vendor", "os", "android", "wifi") }), wanted: WantsDirectory }) },
    { ...base, osModules: List({ osModule: "agent-service", sources: List() }) }, { ...base, osModules: List({ osModule: "sense", sources: List() }) },
    { ...base, dependencies: List({ configuration: "implementation", artifactValid: true, versionKey: "1.7.1" }) }, { ...base, packaging: DefaultPackaging },
    { ...base, osModules: List(), agentDeclared: false, notification: NoNotification, hook: NoHook, packaging: DefaultPackaging }).foldl(Set(), (acc, f) => acc.union(Set(f)))
}
pure def lawAdmittedHostKeepsEveryRule(facts: HostFacts): bool =
  hostVerdict(facts) == HostAdmitted implies (
    facts.schema == 2 and not(facts.companionDeclared) and identityAdmitted(facts.appIdValid, facts.appNameValid, facts.versionValid, facts.versionCode) and
    sdkAdmitted(facts.minSdk, facts.targetSdk, facts.compileSdk) and flavorsAdmitted(facts.flavors, facts.flavorNamesValid) and
    outputAdmitted(facts.roots, facts.output) and facts.sources.every(r => sourceAdmitted(facts.roots, r)) and osModulesAdmitted(facts.osModules) and
    modulesClosed(selectedModules(facts.osModules)) and dependenciesAdmitted(facts.toolchainKeys, facts.dependencies) and
    nativeLibrariesAdmitted(facts.packaging, selectedModules(facts.osModules)) and signingSetup(facts.signing) != PartialSigning)
```

## Story: Keep my schema-1 profile readable through one fixed map

> As a consumer, I want my schema-1 profile read through one fixed map, so
> that I move to schema 2 when I choose and never build from a field that
> lost its meaning.

### A schema-1 field that has no successor is refused when it is set

`embeddedAgent` becomes `agent`. `residentHost.notification` becomes
`agentService.notification` (`primaryAction` `stop` or `none` becomes
`stopAction`, `channelLabel` becomes `channel`), and
`residentHost.environmentHook` becomes `agentService.launchHook`. The
lifecycle hooks have no profile field: a consumer overrides `onReady` in
its service subclass. `residentHost.classes`, `residentHost.sockets` and
`residentHost.helpers` are gone with the second process,
`preserveRuntimeBytes` and `generationInputs` are covered by the payload
inventory, and a dependency with its own version has no toolchain key; a
profile that sets one of them is refused by name.

```quint
pure val schemaOneDropped = List("residentHost.classes", "residentHost.sockets", "residentHost.helpers", "preserveRuntimeBytes", "generationInputs", "testMocks", "dependencies.coordinate")
pure def schemaOneFieldsAdmitted(fieldsSet: List[str]): bool = not(fieldsSet.some(f => schemaOneDropped.includes(f)))
pure val fieldsSetValues = Set(List(), List("embeddedAgent"), List("embeddedAgent", "generationInputs"), List("residentHost.sockets"))
pure val droppedValues = Set("embeddedAgent", "generationInputs", "residentHost.sockets")
pure def lawDroppedFieldIsRefused(fieldsSet: List[str], dropped: str): bool =
  (fieldsSet.includes(dropped) and schemaOneDropped.includes(dropped)) implies not(schemaOneFieldsAdmitted(fieldsSet))
```

### A schema-1 upstream source becomes the os module its path lies in

A module root, a source directory or a source file under the `upstream`
root maps through a table of path prefixes, first match first. A module
that kept its layout keeps the rest of the path as a `sources` entry; a
rewritten module is selected whole. A path under no prefix is refused.

```quint
type ModuleRoot = { prefix: List[str], movedTo: str, keepsPath: bool }
type UpstreamSource = InOsModule({ movedTo: str, rest: List[str] }) | NoOsModule
type SuffixScan = { index: int, kept: List[str] }
pure def dropFirst(segments: List[str], count: int): List[str] =
  segments.foldl({ index: 0, kept: List() }, (scan, part) => { index: scan.index + 1, kept: if (scan.index < count) scan.kept else scan.kept.append(part) }).kept
pure def upstreamSource(table: List[ModuleRoot], segments: List[str]): UpstreamSource = {
  val hits = table.select(r => hasPrefix(segments, r.prefix))
  val hit = hits.nthOr(0, { prefix: List(), movedTo: "", keepsPath: false })
  if (hits.length() == 0) NoOsModule
  else InOsModule({ movedTo: hit.movedTo, rest: if (hit.keepsPath) dropFirst(segments, hit.prefix.length()) else List() })
}
pure val tableValues = Set(List(), List({ prefix: List("plugins", "plugin-native-wifi", "android"), movedTo: "wifi", keepsPath: true }, { prefix: List("plugins", "plugin-native-agent", "android"), movedTo: "agent-service", keepsPath: false }))
pure val segmentsValues = Set(List(), List("plugins", "plugin-native-wifi", "android"), List("plugins", "plugin-native-wifi", "android", "src", "main", "java", "WiFi.kt"), List("plugins", "plugin-native-agent", "android", "src"), List("packages", "app"))
pure def lawSourceUnderNoPrefixHasNoModule(table: List[ModuleRoot], segments: List[str]): bool =
  table.select(r => hasPrefix(segments, r.prefix)).length() == 0 implies upstreamSource(table, segments) == NoOsModule
```

### Schema-1 settings admission runs first among the admission commands

`settingsAdmission` folds into `admission`: its commands keep their order
and run before the profile's named commands.

```quint
pure def foldedAdmission(settings: List[AdmissionCommand], named: List[AdmissionCommand]): List[AdmissionCommand] = settings.concat(named)
pure val settingsValues = Set(List(), List({ task: "settingsAdmission1", taskValid: true, argv: List("node", "identity.mjs") }))
pure val namedValues = Set(List(), List({ task: "verifyDeployment", taskValid: true, argv: List("node", "check.mjs") }))
pure def lawFoldedAdmissionKeepsEveryCommand(settings: List[AdmissionCommand], named: List[AdmissionCommand]): bool =
  foldedAdmission(settings, named).length() == settings.length() + named.length()
```

## Story: Build my release only with the toolchain and signing I pinned

> As a consumer, I want the generated project built with one reviewed
> toolchain and signed exactly as my profile says, so that a changed
> wrapper, a half-configured key or an unexpected payload never reaches a
> published APK.

### The generated project uses the pinned Gradle, Android Gradle plugin, Kotlin and Java

`android/host-templates/toolchain.json` is the reviewed record: the Gradle
version with its distribution digest, the wrapper's digest, the Android
Gradle plugin, Kotlin and Java versions, and the shared library versions a
dependency may name. The copied wrapper must match its digest and the
build's Java must be the record's, or generation is refused.

```quint
import apk as A from "../image/apk"
type ToolchainPins = { gradle: str, gradleDigest: A::Digest, wrapperDigest: A::Digest, androidGradlePlugin: str, kotlin: str, java: int }
pure def toolchainAdmitted(pins: ToolchainPins, observedWrapper: A::Digest, observedJava: int): bool =
  pins.gradle != "" and pins.androidGradlePlugin != "" and pins.kotlin != "" and A::isDigest(pins.gradleDigest) and
  A::digestsMatch(pins.wrapperDigest, observedWrapper) and pins.java == observedJava
pure val pinsValues = Set(
  { gradle: "8", gradleDigest: A::Sha256({ hex: "a1" }), wrapperDigest: A::Sha256({ hex: "c1" }), androidGradlePlugin: "8", kotlin: "2", java: 21 },
  { gradle: "8", gradleDigest: A::NotADigest, wrapperDigest: A::Sha256({ hex: "c1" }), androidGradlePlugin: "8", kotlin: "2", java: 21 })
pure val observedWrapperValues = Set(A::Sha256({ hex: "c1" }), A::Sha256({ hex: "a1" }), A::NotADigest)
pure val observedJavaValues = Set(17, 21)
pure def lawChangedWrapperIsRefused(pins: ToolchainPins, observedWrapper: A::Digest, observedJava: int): bool =
  toolchainAdmitted(pins, observedWrapper, observedJava) implies (pins.wrapperDigest == observedWrapper and pins.java == observedJava)
```

### A release is signed only when every named signing variable is set

With none of the four variables set the build produces an unsigned
release. With all four set it signs the release. With some set the build
is refused before any release is produced.

```quint
type ReleaseSigning = SignedRelease | UnsignedRelease | SigningRefused
pure def releaseSigning(setup: SigningSetup, variablesSet: int): ReleaseSigning =
  if (setup == NoSigning) (if (variablesSet == 0) UnsignedRelease else SigningRefused)
  else if (setup != CompleteSigning) SigningRefused
  else if (variablesSet == signingNameCount) SignedRelease
  else if (variablesSet == 0) UnsignedRelease
  else SigningRefused
pure val variablesSetValues = Set(0, 1, 3, 4)
pure def lawSignedReleaseNeedsEverySigningVariable(setup: SigningSetup, variablesSet: int): bool =
  releaseSigning(setup, variablesSet) == SignedRelease implies (setup == CompleteSigning and variablesSet == signingNameCount)
pure def lawPartialVariablesAreRefused(setup: SigningSetup, variablesSet: int): bool =
  (variablesSet > 0 and variablesSet < signingNameCount) implies releaseSigning(setup, variablesSet) == SigningRefused
```

### A build with every signing variable set fails when a release comes out unsigned

An unsigned release is published only under the unsigned name and only
when no signing variable is set.

```quint
type ReleasePublication = PublishSignedRelease | PublishUnsignedRelease | ReleaseBuildFails
pure def releasePublication(signing: ReleaseSigning, outputSigned: bool): ReleasePublication =
  if (signing == SigningRefused) ReleaseBuildFails
  else if (signing == SignedRelease) (if (outputSigned) PublishSignedRelease else ReleaseBuildFails)
  else (if (outputSigned) ReleaseBuildFails else PublishUnsignedRelease)
pure def lawCompleteSigningNeverPublishesUnsigned(outputSigned: bool): bool =
  releasePublication(SignedRelease, outputSigned) != PublishUnsignedRelease and releasePublication(SigningRefused, outputSigned) == ReleaseBuildFails
```

### A host without local inference carries no on-device model or inference library

The agent bundle's manifest says whether the agent runs local inference.
Without it an APK has no model file, no inference library, no local model
server and no model directory among its assets, or it is refused before it
is published.

```quint
type PayloadEntry = OrdinaryEntry | ModelEntry | InferenceLibraryEntry | ModelServerEntry | ModelDirectoryEntry
pure def hostPayloadAdmitted(localInference: bool, entries: Set[PayloadEntry]): bool = localInference or entries.forall(e => e == OrdinaryEntry)
pure val entriesValues = Set(Set(), Set(OrdinaryEntry), Set(OrdinaryEntry, ModelEntry), Set(InferenceLibraryEntry), Set(ModelServerEntry), Set(ModelDirectoryEntry))
pure def lawCloudOnlyHostCarriesNoInference(entries: Set[PayloadEntry]): bool =
  hostPayloadAdmitted(false, entries) implies entries.forall(e => e == OrdinaryEntry)
```

### The APK manifest lists every flavor's APK of this build with its digest and one signer

```quint
type PublishedApk = { flavor: str, apk: A::Digest, signer: A::Digest, fresh: bool }
pure def publishedManifestAdmitted(flavors: List[str], rows: List[PublishedApk]): bool =
  flavors.length() > 0 and rows.length() == flavors.length() and
  flavors.every(f => rows.select(r => r.flavor == f).length() == 1) and
  rows.every(r => A::isDigest(r.apk) and r.fresh and A::isDigest(r.signer) and rows.every(q => q.signer == r.signer))
```
