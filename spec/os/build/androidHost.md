# Android host profile

A consumer generates its Android host project from an identity and a
schema-2 profile (`generateAndroidHost`, from `@elizaos/os`) that
names everything the Gradle project is made of. The
[runtime payload](./runtimePayload.md) is what an agent host ships; the
[Android build](./androidBuild.md) builds and publishes the project.
The shell (`src/build/android-host.vibe`) decodes the JSON, tests each name
against its pattern (the `…Valid` facts) and splits each path, after it
resolves links, into segments; a path with a backslash or a NUL is
`NotAPath`. The generator writes only what the admitted profile says.

## Story: Generate my app's Android host from data

> As a consumer, I want my Android host generated from a profile that says
> everything explicitly, so that no source is read from outside the roots I
> name, no os module adds what I did not ask for, and no release is
> published with a partial signing setup.

### A profile is schema 2 with no companion, a version code from 1 to 2,100,000,000, and SDK levels from 29 that never decrease from minimum to target to compile

Schema 1 is read only through the map of the second story. The agent
service runs exactly one Node child, so a companion entry is refused. The
application id is a dotted package name, the version a plain label.

```quint
pure val maxVersionCode = 2100000000
pure val minSdkFloor = 29
pure def identityAdmitted(appIdValid: bool, appNameValid: bool, versionValid: bool, versionCode: int): bool =
  appIdValid and appNameValid and versionValid and versionCode > 0 and versionCode <= maxVersionCode
pure def sdkAdmitted(minSdk: int, targetSdk: int, compileSdk: int): bool = minSdk >= minSdkFloor and minSdk <= targetSdk and targetSdk <= compileSdk
```

### Flavors are at least one, distinct, and never a build type or a fixed source set

```quint
pure def distinctNames(names: List[str]): bool = names.every(n => names.select(m => m == n).length() == 1)
pure val fixedSourceSets = List("main", "androidTest", "debug", "release")
pure def flavorsAdmitted(flavors: List[str], flavorNamesValid: bool): bool =
  flavors.length() > 0 and flavorNamesValid and distinctNames(flavors) and not(flavors.some(f => fixedSourceSets.includes(f) or f == "test"))
```

### Build configuration fields of one group are distinct Java constants whose values fit their types

The profile, each flavor and each build type has its own group. An `int`
fits a Java `int`; a value of another type than its field's is refused.

```quint
type FieldValue = BooleanValue | IntValue({ number: int }) | StringValue | MismatchedValue
type BuildConfigField = { constant: str, constantValid: bool, javaValue: FieldValue }
pure def valueFits(javaValue: FieldValue): bool = match javaValue {
  | IntValue(i) => i.number >= -2147483648 and i.number <= 2147483647
  | MismatchedValue => false
  | _ => true }
pure def buildConfigAdmitted(group: List[BuildConfigField]): bool =
  group.every(f => f.constantValid and valueFits(f.javaValue)) and distinctNames(group.listMap(f => f.constant))
```

### Resource shrinking and proguard files need release minification, and ABI filters are distinct supported ABIs

```quint
pure val androidAbis = List("arm64-v8a", "armeabi-v7a", "x86", "x86_64")
pure def buildTypeAdmitted(releaseMinify: bool, shrinkResources: bool, proguardFiles: int, abis: List[str]): bool =
  (releaseMinify or (not(shrinkResources) and proguardFiles == 0)) and distinctNames(abis) and abis.every(a => androidAbis.includes(a))
```

### Version override and release signing each name all of their distinct environment variables or none

Names, never values: two for the version override, four for signing
(store file, store password, key alias, key password). A partial signing
set has its own refusal, which names the missing variables.

```quint
type EnvironmentNames = { names: List[str], namesValid: bool }
type NamedSet = NoneNamed | AllNamed | PartlyNamed | BadlyNamed
pure val versionOverrideCount = 2
pure val signingNameCount = 4
pure def namedSet(env: EnvironmentNames, wanted: int): NamedSet =
  if (env.names.length() == 0) NoneNamed
  else if (env.names.length() < wanted) PartlyNamed
  else if (env.names.length() == wanted and env.namesValid and distinctNames(env.names)) AllNamed
  else BadlyNamed
```

### A source lies under exactly one declared root, the innermost one that contains it, and never escapes it

The roots are the consumer, the os package and an optional dependency
root, and they may nest (os vendored inside the consumer). A reference
names the consumer or the dependency root; os sources come only through
`osModules`. A path has no empty, `.` or `..` segment; the root itself is
admitted only where a directory is wanted.

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
pure def pathAdmitted(path: SourcePath, wanted: SourceWanted): bool = match path {
  | RootItself => wanted == WantsDirectory
  | Below(b) => explicitPath(b.segments)
  | NotAPath => false }
pure def belowSegments(path: SourcePath): List[str] = match path { | Below(b) => b.segments | _ => List() }
pure def rootSegments(roots: HostRoots, root: SourceRoot): List[str] = if (root == DependencyRoot) roots.dependencies else roots.consumer
pure def sourceAdmitted(roots: HostRoots, ref: SourceRef): bool = {
  val own = rootSegments(roots, ref.root)
  val place = own.concat(belowSegments(ref.path))
  val declared = List(roots.consumer, roots.os).concat(if (roots.dependenciesDeclared) List(roots.dependencies) else List())
  (ref.root == ConsumerRoot or (ref.root == DependencyRoot and roots.dependenciesDeclared)) and pathAdmitted(ref.path, ref.wanted) and
  declared.every(other => not(hasPrefix(place, other)) or hasPrefix(own, other))
}
pure val rootsValues = Set(
  { consumer: List("work", "app"), os: List("work", "app", "vendor", "os"), dependencies: List("work", "app", "node_modules"), dependenciesDeclared: true },
  { consumer: List("work", "app"), os: List("work", "eliza", "os"), dependencies: List(), dependenciesDeclared: false })
pure val pathValues = Set(RootItself, NotAPath, Below({ segments: List("android", "java") }), Below({ segments: List("vendor", "os", "android") }),
  Below({ segments: List("..", "other") }), Below({ segments: List() }))
pure def lawOnlyDeclaredRootsAreRead(roots: HostRoots, path: SourcePath, wanted: SourceWanted): bool =
  not(sourceAdmitted(roots, { root: UndeclaredRoot, path: path, wanted: wanted })) and
  (not(roots.dependenciesDeclared) implies not(sourceAdmitted(roots, { root: DependencyRoot, path: path, wanted: wanted })))
pure def lawConsumerSourceNeverReachesIntoOs(roots: HostRoots, path: SourcePath, wanted: SourceWanted): bool =
  (sourceAdmitted(roots, { root: ConsumerRoot, path: path, wanted: wanted }) and not(hasPrefix(roots.consumer, roots.os)))
    implies (pathAdmitted(path, wanted) and not(hasPrefix(roots.consumer.concat(belowSegments(path)), roots.os)))
```

### The output is a directory strictly inside the consumer and outside the os package

```quint
pure def outputAdmitted(roots: HostRoots, output: List[str]): bool =
  explicitPath(roots.consumer) and explicitPath(roots.os) and (not(roots.dependenciesDeclared) or explicitPath(roots.dependencies)) and
  explicitPath(output) and hasPrefix(output, roots.consumer) and output.length() > roots.consumer.length() and not(hasPrefix(output, roots.os))
```

### Every source directory and generated source belongs to a declared source set

A source set is `main`, `androidTest`, `debug`, `release` or a flavor, and
holds `java`, `kotlin`, `assets`, `res` or `jniLibs`. A generated source is
produced by an admission command below the build directory's `generated`.

```quint
pure val sourceKinds = List("java", "kotlin", "assets", "res", "jniLibs")
type SourceSetUse = { sourceSet: str, sourceKind: str, generatedPath: List[str] }
pure def sourceSetUseAdmitted(flavors: List[str], u: SourceSetUse): bool =
  (fixedSourceSets.includes(u.sourceSet) or flavors.includes(u.sourceSet)) and sourceKinds.includes(u.sourceKind) and
  (u.generatedPath.length() == 0 or (explicitPath(u.generatedPath) and u.generatedPath.length() > 1 and u.generatedPath.nthOr(0, "") == "generated"))
```

### An os module comes from the closed list once, whole or as a subset of its main or androidTest sources, with the os modules it needs

Without `src/main` sources the module is the Gradle project
`:eliza-<module>` (its `src/androidTest` sources join the app's
instrumentation tests); with them only those sources are compiled into the
app. `agent-service` and `app-update` share `runtime-files`, so an updater
builds without the agent service. `sign-in` uses the agent service and
secure store. `voice-io` needs `sign-in`. `local-inference`, the native
speech, embedding and engine bindings over the consumer's pinned
`libelizainference` build and the speech bridges a consumer subclasses,
serves the agent service's inference host and runs on `voice-io`, so it
needs `agent-service` and `voice-io`. `cloud-speech` is the cloud speech
bridge alone, for a host that speaks and listens only through the cloud: it
compiles local inference's `SpeechStreamBridgePlugin` and `CloudSpeechWire`
over `voice-io`, with no inference engine, native library or model, so it
needs only `voice-io`; such a host takes the bridge from it and does not
enable local inference's own speech bridges.

```quint
pure val osModuleNames = List("agent-service", "runtime-files", "sign-in", "secure-store", "system", "camera", "browser-surface", "calendar", "contacts", "reminders",
  "action-journal", "notifications", "messages", "phone", "passwords", "media", "filesystem", "location", "wifi", "network-policy", "voice-io", "local-inference", "cloud-speech", "app-update")
type OsModuleEntry = { osModule: str, sources: List[List[str]] }
pure def builtAsProject(entry: OsModuleEntry): bool = not(entry.sources.some(s => s.nthOr(1, "") == "main"))
pure def moduleNeeds(osModule: str): List[str] =
  if (osModule == "agent-service" or osModule == "app-update") List("runtime-files")
  else if (osModule == "sign-in") List("agent-service", "secure-store")
  else if (osModule == "voice-io") List("sign-in")
  else if (osModule == "local-inference") List("agent-service", "voice-io")
  else if (osModule == "cloud-speech") List("voice-io") else List()
pure def osModulesAdmitted(entries: List[OsModuleEntry]): bool = {
  val selected = entries.listMap(e => e.osModule)
  distinctNames(selected) and selected.every(m => moduleNeeds(m).every(n => selected.includes(n))) and
  entries.every(e => osModuleNames.includes(e.osModule) and e.sources.every(s => e.sources.select(t => t == s).length() == 1) and
    e.sources.every(s => explicitPath(s) and s.length() > 2 and s.nthOr(0, "") == "src" and (s.nthOr(1, "") == "main" or s.nthOr(1, "") == "androidTest")))
}
```

### Gradle project names are distinct and never app, and a Maven dependency takes its version only from a toolchain version key

The project names are the consumer's own Gradle modules and the
`eliza-<module>` projects. A dependency names a configuration, a
`group:artifact` and a key of `toolchain.json`'s `versions`.

```quint
pure def projectsAdmitted(projects: List[str], projectNamesValid: bool): bool = projectNamesValid and distinctNames(projects) and not(projects.includes("app"))
type MavenDependency = { configuration: str, artifactValid: bool, versionKey: str }
pure def dependencyAdmitted(toolchainKeys: List[str], d: MavenDependency): bool =
  List("implementation", "androidTestImplementation", "testImplementation").includes(d.configuration) and d.artifactValid and toolchainKeys.includes(d.versionKey)
```

### Asset names, uncompressed extensions and admission task names are plain and distinct, and agent is never an asset name

`agent` is the agent data directory. An app script is a `.gradle` file. An
admission command is a named argv with no empty argument, run without a
shell before `preBuild` in order; `preBuild` is the generator's own task.

```quint
type AdmissionCommand = { task: str, taskValid: bool, argv: List[str] }
pure def extrasAdmitted(assetNames: List[str], noCompress: List[str], namesValid: bool, commands: List[AdmissionCommand]): bool =
  namesValid and distinctNames(assetNames) and not(assetNames.includes("agent")) and distinctNames(noCompress) and
  commands.every(c => c.taskValid and c.task != "preBuild" and c.argv.length() > 0 and not(c.argv.includes(""))) and distinctNames(commands.listMap(c => c.task))
```

### The agent entry, its notification and its launch hook need the agent service module and extracted 16 KiB aligned native libraries

`agent {host, character, policy}` names the agent data files, copied into
`assets/agent/`; the consumer's service subclass is declared `specialUse`
with `FOREGROUND_SERVICE_SPECIAL_USE`. `agentService.notification
{smallIcon, color, channel, strings, stopAction}` and
`agentService.launchHook {class, method}` name resources and a static
method. The service starts `libeliza_node.so` from the native library
directory, so `agent-service` needs `nativeLibraries: "extract-16k"`.

```quint
type NativeLibraries = DefaultPackaging | Extract16k
type AgentEntry = NoAgent | AgentDeclared({ notificationValid: bool, hookValid: bool })
pure def agentEntryAdmitted(agent: AgentEntry, selected: List[str]): bool = match agent {
  | AgentDeclared(a) => a.notificationValid and a.hookValid and selected.includes("agent-service")
  | NoAgent => true }
pure def agentAdmitted(agent: AgentEntry, packaging: NativeLibraries, selected: List[str]): bool =
  (not(selected.includes("agent-service")) or packaging == Extract16k) and agentEntryAdmitted(agent, selected)
```

### An os module adds no permission or exported component the profile did not request

The generator merges each os module's manifest and marks every permission
or exported component the profile's manifests do not request with
`tools:node="remove"`.

```quint
pure def mergedNodes(requested: List[str], contributed: List[str]): List[str] = contributed.select(c => requested.includes(c))
```

### A profile is admitted only when every rule holds, and a refusal names the first one broken

`ProfileMalformed` is the decoder's refusal: the JSON has another shape.

```quint
type HostRefusal = ProfileMalformed | FieldDropped | UpstreamUnmapped | SchemaUnsupported | CompanionDeclared | IdentityInvalid | SdkInvalid | FlavorsInvalid |
  BuildConfigInvalid | BuildTypesInvalid | VersionOverrideInvalid | SigningPartial | SigningInvalid | OutputMisplaced | SourceRefused | SourceSetInvalid |
  OsModulesInvalid | ProjectsInvalid | DependencyNotPinned | ExtrasInvalid | AgentInvalid
type HostVerdict = HostAdmitted | HostRefused({ refusal: HostRefusal })
type HostFacts = { schema: int, companionDeclared: bool, appIdValid: bool, appNameValid: bool, versionValid: bool, versionCode: int, minSdk: int, targetSdk: int, compileSdk: int,
  flavors: List[str], flavorNamesValid: bool, fieldGroups: List[List[BuildConfigField]], releaseMinify: bool, shrinkResources: bool, proguardFiles: int, abis: List[str],
  versionOverride: EnvironmentNames, signing: EnvironmentNames, roots: HostRoots, output: List[str], sources: List[SourceRef], uses: List[SourceSetUse], osModules: List[OsModuleEntry],
  projects: List[str], projectNamesValid: bool, toolchainKeys: List[str], dependencies: List[MavenDependency], assetNames: List[str], noCompress: List[str], namesValid: bool,
  commands: List[AdmissionCommand], packaging: NativeLibraries, agent: AgentEntry }
pure def hostVerdict(f: HostFacts): HostVerdict = {
  val signing = namedSet(f.signing, signingNameCount)
  val overrideSet = namedSet(f.versionOverride, versionOverrideCount)
  if (f.schema != 2) HostRefused({ refusal: SchemaUnsupported })
  else if (f.companionDeclared) HostRefused({ refusal: CompanionDeclared })
  else if (not(identityAdmitted(f.appIdValid, f.appNameValid, f.versionValid, f.versionCode))) HostRefused({ refusal: IdentityInvalid })
  else if (not(sdkAdmitted(f.minSdk, f.targetSdk, f.compileSdk))) HostRefused({ refusal: SdkInvalid })
  else if (not(flavorsAdmitted(f.flavors, f.flavorNamesValid))) HostRefused({ refusal: FlavorsInvalid })
  else if (not(f.fieldGroups.every(g => buildConfigAdmitted(g)))) HostRefused({ refusal: BuildConfigInvalid })
  else if (not(buildTypeAdmitted(f.releaseMinify, f.shrinkResources, f.proguardFiles, f.abis))) HostRefused({ refusal: BuildTypesInvalid })
  else if (overrideSet == PartlyNamed or overrideSet == BadlyNamed) HostRefused({ refusal: VersionOverrideInvalid })
  else if (signing == PartlyNamed) HostRefused({ refusal: SigningPartial })
  else if (signing == BadlyNamed) HostRefused({ refusal: SigningInvalid })
  else if (not(outputAdmitted(f.roots, f.output))) HostRefused({ refusal: OutputMisplaced })
  else if (not(f.sources.every(r => sourceAdmitted(f.roots, r)))) HostRefused({ refusal: SourceRefused })
  else if (not(f.uses.every(u => sourceSetUseAdmitted(f.flavors, u)))) HostRefused({ refusal: SourceSetInvalid })
  else if (not(osModulesAdmitted(f.osModules))) HostRefused({ refusal: OsModulesInvalid })
  else if (not(projectsAdmitted(f.projects, f.projectNamesValid))) HostRefused({ refusal: ProjectsInvalid })
  else if (not(f.dependencies.every(d => dependencyAdmitted(f.toolchainKeys, d)))) HostRefused({ refusal: DependencyNotPinned })
  else if (not(extrasAdmitted(f.assetNames, f.noCompress, f.namesValid, f.commands))) HostRefused({ refusal: ExtrasInvalid })
  else if (not(agentAdmitted(f.agent, f.packaging, f.osModules.listMap(e => e.osModule)))) HostRefused({ refusal: AgentInvalid })
  else HostAdmitted
}
```

## Story: Keep my schema-1 profile readable through one fixed map

> As a consumer, I want my schema-1 profile read through one fixed map, so
> that I move to schema 2 when I choose and never build from a field that
> lost its meaning.

### A schema-1 field without a successor is refused when it is set, and an upstream source becomes the os module its path lies in

`embeddedAgent` becomes `agent`, `residentHost.{notification,environmentHook}`
become `agentService.{notification,launchHook}`, and `settingsAdmission`
commands run first among the admission commands.
`residentHost.{classes,sockets,helpers}` left with the second process,
the payload inventory covers `preserveRuntimeBytes` and `generationInputs`,
and a versioned coordinate has no toolchain key: setting one is
`FieldDropped`. An `upstream` path maps through a prefix table, first match
first: a module that kept its layout keeps the rest as a `sources` entry, a
rewritten one is selected whole, no match is `UpstreamUnmapped`.

```quint
pure val schemaOneDropped = List("residentHost.classes", "residentHost.sockets", "residentHost.helpers", "preserveRuntimeBytes", "generationInputs", "testMocks", "dependencies.coordinate")
type ModuleRoot = { prefix: List[str], movedTo: str, keepsPath: bool }
type UpstreamSource = InOsModule({ movedTo: str, rest: List[str] }) | NoOsModule
type SuffixScan = { index: int, kept: List[str] }
pure def schemaOneRefusal(fieldsSet: List[str], table: List[ModuleRoot], upstream: List[List[str]]): HostVerdict =
  if (fieldsSet.some(f => schemaOneDropped.includes(f))) HostRefused({ refusal: FieldDropped })
  else if (upstream.some(s => table.every(r => not(hasPrefix(s, r.prefix))))) HostRefused({ refusal: UpstreamUnmapped })
  else HostAdmitted
pure def upstreamSource(table: List[ModuleRoot], segments: List[str]): UpstreamSource = {
  val hits = table.select(r => hasPrefix(segments, r.prefix))
  val hit = hits.nthOr(0, { prefix: List(), movedTo: "", keepsPath: false })
  val rest = segments.foldl({ index: 0, kept: List() }, (scan, part) => { index: scan.index + 1, kept: if (scan.index < hit.prefix.length()) scan.kept else scan.kept.append(part) }).kept
  if (hits.length() == 0) NoOsModule else InOsModule({ movedTo: hit.movedTo, rest: if (hit.keepsPath) rest else List() })
}
pure val tableValues = Set(List(), List({ prefix: List("plugins", "wifi", "android"), movedTo: "wifi", keepsPath: true }, { prefix: List("plugins", "agent", "android"), movedTo: "agent-service", keepsPath: false }))
pure val segmentsValues = Set(List(), List("plugins", "wifi", "android", "src", "main", "WiFi.kt"), List("plugins", "agent", "android", "src"), List("packages", "app"))
pure def lawMappedSourceKeepsItsPathBelowTheModule(table: List[ModuleRoot], segments: List[str]): bool = {
  val mapped = upstreamSource(table, segments)
  match mapped {
    | InOsModule(m) => table.some(r => r.movedTo == m.movedTo and hasPrefix(segments, r.prefix) and (m.rest.length() == 0 or r.prefix.concat(m.rest) == segments))
    | NoOsModule => table.every(r => not(hasPrefix(segments, r.prefix))) }
}
```

## Story: Build my release only with the toolchain and signing I pinned

> As a consumer, I want the generated project built with one reviewed
> toolchain and signed exactly as my profile says, so that a changed
> wrapper, a half-configured key or an unexpected payload never reaches a
> published APK.

### The generated project uses the pinned Gradle, Android Gradle plugin, Kotlin and Java, with the wrapper the record names

`android/host-templates/toolchain.json` records these, the Gradle
distribution and wrapper digests, and the library versions a dependency
may name.

```quint
import apk as A from "../image/apk"
type ToolchainPins = { gradle: str, gradleDigest: A::Digest, wrapperDigest: A::Digest, androidGradlePlugin: str, kotlin: str, java: int }
pure def toolchainAdmitted(pins: ToolchainPins, observedWrapper: A::Digest, observedJava: int): bool =
  pins.gradle != "" and pins.androidGradlePlugin != "" and pins.kotlin != "" and A::isDigest(pins.gradleDigest) and
  A::digestsMatch(pins.wrapperDigest, observedWrapper) and pins.java == observedJava
pure val pinsValues = Set(
  { gradle: "8", gradleDigest: A::Sha256({ hex: "a1" }), wrapperDigest: A::Sha256({ hex: "c1" }), androidGradlePlugin: "8", kotlin: "2", java: 21 },
  { gradle: "8", gradleDigest: A::NotADigest, wrapperDigest: A::NotADigest, androidGradlePlugin: "8", kotlin: "2", java: 21 })
pure val observedWrapperValues = Set(A::Sha256({ hex: "c1" }), A::Sha256({ hex: "a1" }), A::NotADigest)
pure val observedJavaValues = Set(17, 21)
pure def lawPlaceholderWrapperIsNeverAdmitted(pins: ToolchainPins, observedJava: int): bool =
  not(toolchainAdmitted({ ...pins, wrapperDigest: A::NotADigest }, A::NotADigest, observedJava))
```

### A release is published signed only when every signing variable is set and the output is signed, and unsigned only when none is set and the output is unsigned

With some of the four variables set the build fails before any release is
produced; a build that should sign and comes out unsigned fails.

```quint
type ReleasePublication = PublishSignedRelease | PublishUnsignedRelease | ReleaseBuildFails
pure def releasePublication(setup: NamedSet, variablesSet: int, outputSigned: bool): ReleasePublication =
  if (variablesSet == 0) (if (outputSigned) ReleaseBuildFails else PublishUnsignedRelease)
  else if (setup == AllNamed and variablesSet == signingNameCount and outputSigned) PublishSignedRelease
  else ReleaseBuildFails
pure val setupValues = Set(NoneNamed, AllNamed, PartlyNamed, BadlyNamed)
pure val variablesSetValues = Set(0, 1, 3, 4)
pure def lawPartialSigningNeverPublishes(setup: NamedSet, variablesSet: int, outputSigned: bool): bool =
  (variablesSet > 0 and variablesSet < signingNameCount) implies releasePublication(setup, variablesSet, outputSigned) == ReleaseBuildFails
pure def lawSignedReleaseNeedsCompleteSigning(setup: NamedSet, variablesSet: int, outputSigned: bool): bool =
  releasePublication(setup, variablesSet, outputSigned) == PublishSignedRelease implies (setup == AllNamed and variablesSet == signingNameCount and outputSigned)
```

### A host without local inference carries no model, inference library, model server or model directory

The agent bundle's manifest says whether the agent runs local inference; an
APK that breaks this is refused before it is published.

```quint
type PayloadEntry = OrdinaryEntry | ModelEntry | InferenceLibraryEntry | ModelServerEntry | ModelDirectoryEntry
pure def hostPayloadAdmitted(localInference: bool, payload: Set[PayloadEntry]): bool = localInference or payload.forall(e => e == OrdinaryEntry)
```

### The APK manifest lists each flavor's own published APK of this build once, fresh, with its digest and one shared signer unless the release is unsigned

A row names the APK this run publishes for its own flavor: the release APK
in a release build, the debug APK otherwise. A row is fresh when the APK's
bytes and signer are the ones it states. An unsigned release has no signer,
so each of its rows states none.

```quint
type ApkBuild = DebugApk | ReleaseApk
type PublishedSet = DebugSet | SignedReleaseSet | UnsignedReleaseSet
type PublishedApk = { flavor: str, fileFlavor: str, build: ApkBuild, apk: A::Digest, signer: A::Digest, fresh: bool }
pure def publishedBuild(kind: PublishedSet): ApkBuild = if (kind == DebugSet) DebugApk else ReleaseApk
pure def rowSigned(kind: PublishedSet, rows: List[PublishedApk], r: PublishedApk): bool =
  if (kind == UnsignedReleaseSet) r.signer == A::NotADigest else (A::isDigest(r.signer) and rows.every(q => A::digestsMatch(q.signer, r.signer)))
pure def publishedManifestAdmitted(flavors: List[str], kind: PublishedSet, rows: List[PublishedApk]): bool =
  flavors.length() > 0 and rows.length() == flavors.length() and flavors.every(f => rows.select(r => r.flavor == f).length() == 1) and
  rows.every(r => r.fileFlavor == r.flavor and r.build == publishedBuild(kind) and A::isDigest(r.apk) and r.fresh and rowSigned(kind, rows, r))
```
