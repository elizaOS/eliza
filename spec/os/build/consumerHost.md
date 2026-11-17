# Consumer Android host

A consumer generates its Android host project from an explicit profile:
identity, selected native modules and sources, manifests, resources,
distribution variants, signing and version environment names, and build
configuration values. Every path is admitted against a named root, and
the output is an owned generated directory inside the consumer and outside
upstream source. The [consumer build](./consumerBuild.md) builds and
publishes it, and the [bridge composition](../android/bridge.md) owns the
native bridge modules it may include.

## Story: Build a branded Android host from a consumer profile

> As a consumer, I want to generate my Android host from a profile that
> says everything explicitly, so that no source is read from outside the
> roots I name, no release is published with a partial signing setup, and
> a host without on-device inference never carries it.

### Every module source resolves under exactly one declared root

A source names one of the declared roots: the consumer, upstream, or a
dependency root when one is given. The resolved path must stay inside
that root, and the generated output must be inside the consumer root,
not the consumer root itself, and outside upstream. Native module names
are distinct and never `app`.

```quint
type SourceRoot = ConsumerRoot | UpstreamRoot | DependencyRoot | UndeclaredRoot
pure def sourceAdmitted(root: SourceRoot, dependencyDeclared: bool, staysInside: bool): bool =
  staysInside and (root == ConsumerRoot or root == UpstreamRoot or (root == DependencyRoot and dependencyDeclared))
pure def outputAdmitted(insideConsumer: bool, isConsumerRoot: bool, insideUpstream: bool, symlinkAncestor: bool): bool =
  insideConsumer and not(isConsumerRoot) and not(insideUpstream) and not(symlinkAncestor)
pure def distinctNames(names: List[str]): bool = names.every(n => names.select(m => m == n).length() == 1)
pure def moduleNamesAdmitted(names: List[str]): bool = not(names.includes("app")) and distinctNames(names)
pure val namesValues = Set(List(), List("agent", "voice"), List("agent", "agent"), List("app"))
pure def lawUndeclaredRootRefused(dependencyDeclared: bool, staysInside: bool): bool =
  not(sourceAdmitted(UndeclaredRoot, dependencyDeclared, staysInside)) and not(sourceAdmitted(DependencyRoot, false, staysInside))
pure def lawEscapingSourceRefused(root: SourceRoot, dependencyDeclared: bool): bool = not(sourceAdmitted(root, dependencyDeclared, false))
pure def lawOutputNeverInUpstream(insideConsumer: bool, isConsumerRoot: bool, symlinkAncestor: bool): bool =
  not(outputAdmitted(insideConsumer, isConsumerRoot, true, symlinkAncestor))
```

### The host identity, version and SDK levels are admitted before generation

The application identity is a dotted lowercase package name, the version
code is a positive integer no larger than 2,100,000,000, and the SDK
levels satisfy minimum ≤ target ≤ compile, each positive.

```quint
pure def identityAdmitted(validPackage: bool, versionCode: int, minSdk: int, targetSdk: int, compileSdk: int): bool =
  validPackage and versionCode > 0 and versionCode <= 2100000000 and minSdk > 0 and minSdk <= targetSdk and targetSdk <= compileSdk
pure val versionCodeValues = Set(0, 1, 2100000000, 2100000001)
pure val minSdkValues = Set(0, 26, 34)
pure val targetSdkValues = Set(26, 34, 35)
pure val compileSdkValues = Set(34, 35)
```

### Distribution variants are explicit, distinct and never a build type

The profile lists at least one distribution variant. Variant names are
distinct and are never `debug`, `release` or `test`. Each variant's
manifest and build configuration fields apply only to that variant.

```quint
pure def variantsAdmitted(variants: List[str]): bool =
  variants.length() > 0 and distinctNames(variants) and
  not(variants.includes("debug") or variants.includes("release") or variants.includes("test"))
pure val variantsValues = Set(List(), List("store"), List("store", "sideload"), List("store", "store"), List("release"))
```

### A release APK is signed only when every named signing variable is set, and a partial set is refused

The profile names the release signing inputs as four distinct environment
variable names, or none: store file, store password, key alias and key
password. The names are data, never values, and a refusal names only the
missing variables. With none of the four variables set, the build produces
an unsigned release. With all four set, it signs the release. With some
but not all set, the build is refused before any release is produced, so
a partial signing setup never yields an unsigned release by accident.

```quint
type ReleaseSigning = SignedRelease | UnsignedRelease | SigningRefused
pure def signingNamesAdmitted(names: List[str]): bool =
  names.length() == 0 or
  (names.length() == 4 and not(names.includes("")) and distinctNames(names))
pure def releaseSigning(names: List[str], variablesSet: int): ReleaseSigning =
  if (not(signingNamesAdmitted(names))) SigningRefused
  else if (names.length() == 4 and variablesSet == 4) SignedRelease
  else if (names.length() == 4 and variablesSet > 0) SigningRefused
  else UnsignedRelease
pure val signingNamesValues = Set(List(), List("STORE", "STORE_PASS", "KEY", "KEY_PASS"), List("STORE", "STORE"), List("STORE", "STORE", "KEY", "KEY_PASS"))
pure val variablesSetValues = Set(0, 1, 3, 4)
pure def lawSignedReleaseNeedsEverySigningVariable(signingNames: List[str], variablesSet: int): bool =
  releaseSigning(signingNames, variablesSet) == SignedRelease implies signingNames.length() == 4 and variablesSet == 4
pure def lawPartialSigningIsRefused(signingNames: List[str], variablesSet: int): bool =
  (signingNames.length() == 4 and variablesSet > 0 and variablesSet < 4) implies releaseSigning(signingNames, variablesSet) == SigningRefused
pure def lawNoSigningVariableIsUnsigned(signingNames: List[str]): bool =
  signingNamesAdmitted(signingNames) implies releaseSigning(signingNames, 0) == UnsignedRelease
```

### A build with every signing variable set fails when a release comes out unsigned

When every named signing variable is set, each variant's release must
come out signed; an unsigned release then fails the build instead of
being published under the unsigned name. Without signing variables an
unsigned release is published under the unsigned name.

```quint
type ReleasePublication = PublishSignedRelease | PublishUnsignedRelease | ReleaseBuildFails
pure def releasePublication(signing: ReleaseSigning, outputSigned: bool): ReleasePublication =
  if (signing == SigningRefused) ReleaseBuildFails
  else if (signing == SignedRelease) (if (outputSigned) PublishSignedRelease else ReleaseBuildFails)
  else (if (outputSigned) ReleaseBuildFails else PublishUnsignedRelease)
pure def lawCompleteSigningNeverPublishesUnsigned(outputSigned: bool): bool =
  releasePublication(SignedRelease, outputSigned) != PublishUnsignedRelease and
  (not(outputSigned) implies releasePublication(SignedRelease, outputSigned) == ReleaseBuildFails)
pure def lawRefusedSigningPublishesNothing(outputSigned: bool): bool =
  releasePublication(SigningRefused, outputSigned) == ReleaseBuildFails
```

### The profile schema and the Gradle toolchain are pinned

A profile states schema version 1; any other version is refused. The
generated project uses the reviewed toolchain record: the Gradle version
with its distribution digest, the wrapper's digest, and the Android
Gradle plugin, Kotlin and Java versions. The Gradle wrapper copied from
upstream must match the reviewed wrapper digest, or generation is
refused. Shared AndroidX libraries a profile names without a version take
the toolchain record's version.

```quint
pure def profileSchemaAdmitted(schema: int): bool = schema == 1
pure def toolchainAdmitted(wrapperDigestMatches: bool, distributionDigestPinned: bool): bool =
  wrapperDigestMatches and distributionDigestPinned
pure val schemaValues = Set(0, 1, 2)
pure def lawOnlySchemaOneIsAdmitted(schema: int): bool = profileSchemaAdmitted(schema) implies schema == 1
pure def lawChangedWrapperIsRefused(distributionDigestPinned: bool): bool = not(toolchainAdmitted(false, distributionDigestPinned))
```

### A host without the local-inference module carries no on-device model or inference library

A profile that selects no local-inference module produces APKs with no
on-device model or local inference: no model file (`.gguf`, `.onnx`,
`.ort`, `.tflite`, `.safetensors`, `.pte` or `.task`), no native library
named for a local inference engine, no local model server executable, and
no speech or model directory among the assets outside the web interface's
own public assets. An APK carrying any of them is refused before it is
published.

```quint
type PayloadEntry = OrdinaryEntry | ModelFile | InferenceLibrary | ModelServer | ModelAssetDirectory
pure def inferencePayload(entry: PayloadEntry): bool = entry != OrdinaryEntry
pure def hostPayloadAdmitted(localInferenceSelected: bool, entries: Set[PayloadEntry]): bool =
  localInferenceSelected or entries.forall(e => not(inferencePayload(e)))
pure val entriesValues = Set(Set(), Set(OrdinaryEntry), Set(OrdinaryEntry, ModelFile), Set(InferenceLibrary), Set(ModelServer), Set(ModelAssetDirectory))
pure def lawCloudOnlyHostCarriesNoInference(entries: Set[PayloadEntry]): bool =
  hostPayloadAdmitted(false, entries) implies entries.forall(e => e == OrdinaryEntry)
```

### The published manifest lists every APK of this build with its digest and one signer

The build's verification manifest has exactly one row for each selected
variant's APK, each with a SHA-256 digest, each produced by this
invocation, and all signed by the same verified signer.

```quint
type ApkRow = { variant: str, apkDigest: str, signer: str, fresh: bool }
pure def publishedManifestAdmitted(variants: List[str], rows: List[ApkRow]): bool =
  variants.length() > 0 and rows.length() == variants.length() and
  variants.foldl(true, (ok, v) => ok and rows.select(r => r.variant == v).length() == 1) and
  rows.foldl(true, (ok, r) => ok and r.apkDigest != "" and r.fresh and r.signer != "" and rows.select(q => q.signer != r.signer).length() == 0)
pure val rowsValues = Set(List(), List({ variant: "store", apkDigest: "a1", signer: "s1", fresh: true }),
  List({ variant: "store", apkDigest: "a1", signer: "s1", fresh: true }, { variant: "sideload", apkDigest: "a2", signer: "s2", fresh: true }),
  List({ variant: "store", apkDigest: "a1", signer: "s1", fresh: true }, { variant: "sideload", apkDigest: "a2", signer: "s1", fresh: true }),
  List({ variant: "store", apkDigest: "", signer: "s1", fresh: false }))
pure def lawMixedSignersAreRefused(variants: List[str], rows: List[ApkRow]): bool =
  rows.some(r => rows.some(q => q.signer != r.signer)) implies not(publishedManifestAdmitted(variants, rows))
```
