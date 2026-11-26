# Product composition

A consumer composes its product from a descriptor it supplies over one of
the two device profiles the os package pins: a Pixel 10a (`stallion`) kept
on its stock factory vendor partition, or the Cuttlefish x86_64 phone
(`cf_x86_64_phone`). The os package names no product and ships no default
identity. The writer is `composeProduct` and `enrollUpdater` in
`src/image/compose-product.vibe`, exported from `@elizaos/os`; the
sources are develop's `pixel10a-product.ts`, `pixel10a-brand-assets.mjs`,
`cuttlefish-product.mjs`, `system-updater-staging.mjs`,
`build-bootanimation.ts` and the brand-config schema.

The shell parses the descriptor (schema 1) and checks the syntax of every
name in it (`syntaxValid`: vendor directory and product name tokens, package
and module names, model, brand and manufacturer text, release configuration,
Pixel config MIME type), counts its unset or placeholder values, lowercases
the brand into the token the [source lock](./sourceLock.md) admits, reads
which outputs already exist, and reads the product makefiles and the boot
animation archive. It verifies the checkout the request names against the
profile it names, reads whether the output lies inside that checkout, and
builds on that fresh verdict once it admitted this product, a launcher staged by
[launcher staging](./staging.md), and the clock requirement of
[image provisioning](./provisioning.md). Composition is
staging output: only a boot of the built image shows what the device does.

## Story: Compose my product from a pinned device profile

> As a product maker, I want to compose my branded image from a descriptor
> over a device profile the os package pinned, so that it serves any product
> without knowing mine, never overwrites what is there, and nothing
> half-configured or unreviewed reaches a production build.

### A product targets the Pixel 10a or the Cuttlefish x86_64 phone, from the source profile pinned for it and a source verdict that admitted it

The device profile is a variant, so Pixel-only fields (the hardware config
identity) and Cuttlefish-only fields (host packages and platform
certificate) cannot be mixed. The source verdict must come from the
profile pinned for the descriptor, a physical device's lock for a Pixel and
a virtual one for Cuttlefish, over the checkout that holds the output, and
must have admitted this brand token, the profile's lock target and the build
purpose; the source lock refuses a brand mismatch and a development-only
lock for production.

```quint
import apk.* from "./apk"
import sourceLock as V from "./sourceLock"
import staging as St from "./staging"
import provisioning as Pv from "./provisioning"
type PixelConfig = { moduleName: str, packageName: str, mimeType: str }
type HostPackage = { name: str, version: str, sha256: Digest }
type DeviceProfile = PixelProfile({ pixelConfig: PixelConfig }) | CuttlefishProfile({ hostPackages: List[HostPackage], platformCertificate: Digest })
type ListenerChoice = NoListener | WithListener({ moduleName: str, packageName: str })
type BootAnimation = StockBootAnimation | PinnedBootAnimation({ sha256: Digest })
type ProductDescriptor = { schemaVersion: int, syntaxValid: bool, placeholderFields: int, device: DeviceProfile, sourceProfile: str, vendorDirectory: str,
  productName: str, model: str, brand: str, manufacturer: str, releaseConfig: str, launcherModule: str, launcherPackage: str, listener: ListenerChoice,
  systemUpdater: bool, firstRun: bool, bootAnimation: BootAnimation }
type CompositionProblem = DescriptorInvalid | SourceProfileNotPinned | SourceNotAdmitted | LauncherDiffers | LauncherOnSystemPartition | PixelConfigCollides
  | OutputExists | BuildSettingsChanged | BootAnimationDiffers | ClockNamedTwice | UpdaterNotReviewed | PlaceholderInProduction | CuttlefishHostUnpinned
pure def isPixel(d: ProductDescriptor): bool = { val device = d.device
  match device { | PixelProfile(p) => true | CuttlefishProfile(c) => false } }
pure def pinnedSourceProfile(d: ProductDescriptor): str = if (isPixel(d)) "pixel10a" else "cuttlefish"
pure def lockTarget(d: ProductDescriptor): str = if (isPixel(d)) "stallion" else "cf_x86_64_phone"
pure def deviceName(d: ProductDescriptor): str = if (isPixel(d)) "stallion" else "vsoc_x86_64_only"
pure def refuseWhen(found: bool, problem: CompositionProblem): Set[CompositionProblem] = if (found) Set(problem) else Set()
pure def sourceAdmits(c: CompositionCall): bool = c.source.verdict == V::Match and c.outputInCheckout and
  c.source.lock.name == pinnedSourceProfile(c.descriptor) and (isPixel(c.descriptor) iff (c.source.lock.device != V::VirtualDevice)) and
  c.source.admitted.includes({ brand: c.brandToken, product: { brand: c.brandToken, target: lockTarget(c.descriptor) }, purpose: c.purpose })
pure def sourceProblems(c: CompositionCall): Set[CompositionProblem] =
  refuseWhen(c.descriptor.schemaVersion != 1 or not(c.descriptor.syntaxValid), DescriptorInvalid)
    .union(refuseWhen(c.descriptor.sourceProfile != pinnedSourceProfile(c.descriptor), SourceProfileNotPinned))
    .union(refuseWhen(not(sourceAdmits(c)), SourceNotAdmitted))
pure def lawOnlyAnAdmittedPinnedSourceComposes(c: CompositionCall): bool = compositionAdmitted(c) implies
  (c.descriptor.sourceProfile == pinnedSourceProfile(c.descriptor) and c.source.lock.name == pinnedSourceProfile(c.descriptor) and c.outputInCheckout and
    (isPixel(c.descriptor) iff (c.source.lock.device != V::VirtualDevice)) and c.source.verdict == V::Match and c.source.admitted.some(a => a.product.target == lockTarget(c.descriptor)))
pure def lawProductionNeedsAReleaseLock(c: CompositionCall): bool =
  (compositionAdmitted(c) and c.purpose == V::Production and V::alwaysProductionNeedsAReleaseLock(c.source)) implies not(c.source.lock.developmentOnly)
```

### The product's launcher is the staged launcher, and on a Pixel it stays off the system partition and apart from the hardware config identity

```quint
pure def launcherProblems(c: CompositionCall): Set[CompositionProblem] = {
  val d = c.descriptor
  val l = c.launcher
  val device = d.device
  val collides = match device {
    | PixelProfile(p) => p.pixelConfig.moduleName == d.launcherModule or p.pixelConfig.packageName == d.launcherPackage or listenerNamed(d.listener, p.pixelConfig)
    | CuttlefishProfile(x) => false }
  refuseWhen(not(St::descriptorValid(l)) or l.moduleName != d.launcherModule or l.packageName != d.launcherPackage, LauncherDiffers)
    .union(refuseWhen(isPixel(d) and l.partition == St::SystemPartition, LauncherOnSystemPartition)).union(refuseWhen(collides, PixelConfigCollides))
}
pure def listenerNamed(listener: ListenerChoice, config: PixelConfig): bool =
  match listener { | WithListener(w) => w.moduleName == config.moduleName or w.packageName == config.packageName | NoListener => false }
pure def lawPixelLauncherIsTheStagedOneOffSystem(c: CompositionCall): bool = (compositionAdmitted(c) and isPixel(c.descriptor)) implies
  (c.launcher.partition == St::ProductPartition and c.launcher.packageName == c.descriptor.launcherPackage and St::descriptorValid(c.launcher))
```

### Composition never overwrites the product list, the product makefile, the device templates, the brand assets, the record, the updater or first-run sources

The outputs are `AndroidProducts.mk`, `<product>.mk`, `stallion/` (Pixel
only; Cuttlefish inherits the stock device tree), `brand/`,
`physical-product.json`, and `system-updater/` and `first-run/` when the
descriptor includes them. Each is written once; one that exists refuses the
whole composition before anything is written.

```quint
type CompositionOutput = ProductList | ProductMakefile | DeviceTemplates | BrandAssets | CompositionRecord | SystemUpdaterSources | FirstRunSources
pure def outputsOf(d: ProductDescriptor): List[CompositionOutput] =
  List(ProductList, ProductMakefile, BrandAssets, CompositionRecord).concat(if (isPixel(d)) List(DeviceTemplates) else List())
    .concat(if (d.systemUpdater) List(SystemUpdaterSources) else List()).concat(if (d.firstRun) List(FirstRunSources) else List())
pure def lawNothingIsOverwritten(c: CompositionCall): bool = compositionAdmitted(c) implies outputsOf(c.descriptor).every(o => not(c.existing.includes(o)))
```

### The lunch choices are the product with its release configuration as userdebug and user, and production builds user

```quint
type BuildVariant = UserDebugBuild | UserBuild
type LunchChoice = { product: str, release: str, variant: BuildVariant }
pure def lunchChoices(d: ProductDescriptor): List[LunchChoice] =
  List({ product: d.productName, release: d.releaseConfig, variant: UserDebugBuild }, { product: d.productName, release: d.releaseConfig, variant: UserBuild })
pure def lunchFor(d: ProductDescriptor, purpose: V::BuildPurpose): LunchChoice =
  { product: d.productName, release: d.releaseConfig, variant: if (purpose == V::Production) UserBuild else UserDebugBuild }
pure def lawEveryBuildIsALunchChoiceAndProductionIsUser(d: ProductDescriptor, purpose: V::BuildPurpose): bool =
  lunchChoices(d).includes(lunchFor(d, purpose)) and ((lunchFor(d, purpose).variant == UserBuild) iff (purpose == V::Production))
```

### The composed product keeps the stock kernel, Virtual A/B with lz4 snapshots, enforcing SELinux with neverallows checked, and DeskClock required once

The shell reads these settings from the composed makefiles, the consumer's
included; an override of any refuses composition.

```quint
type KernelChoice = StockKernel | CustomKernel
type SnapshotCompression = Lz4Snapshots | OtherSnapshots | NoVirtualAb
type SelinuxMode = SelinuxEnforcing | SelinuxPermissive
type NeverallowCheck = NeverallowsChecked | NeverallowsIgnored
type BuildSettings = { kernel: KernelChoice, snapshots: SnapshotCompression, selinux: SelinuxMode, neverallows: NeverallowCheck }
pure val requiredSettings: BuildSettings = { kernel: StockKernel, snapshots: Lz4Snapshots, selinux: SelinuxEnforcing, neverallows: NeverallowsChecked }
pure def settingsProblems(c: CompositionCall): Set[CompositionProblem] =
  refuseWhen(c.settings != requiredSettings, BuildSettingsChanged).union(refuseWhen(Pv::clockRequirement(c.clockLines) == Pv::ClockNamedTwice, ClockNamedTwice))
pure def lawComposedProductKeepsPlatformSecurity(c: CompositionCall): bool = compositionAdmitted(c) implies
  (c.settings.selinux == SelinuxEnforcing and c.settings.neverallows == NeverallowsChecked and c.settings.kernel == StockKernel and c.settings.snapshots == Lz4Snapshots)
```

### The boot animation is the stock one, or exactly the pinned archive of stored entries with a root desc.txt and a frame in every part

A frame set is packed into an archive first; the archive's digest is what
must equal the pin.

```quint
type BootArchive = NoBootArchive | BootArchiveRead({ sha256: Digest, storedOnly: bool, descAtRoot: bool, framesInEveryPart: bool })
pure def bootAnimationAdmitted(pin: BootAnimation, archive: BootArchive): bool = match pin {
  | StockBootAnimation => archive == NoBootArchive
  | PinnedBootAnimation(p) => match archive {
      | BootArchiveRead(a) => digestsMatch(a.sha256, p.sha256) and a.storedOnly and a.descAtRoot and a.framesInEveryPart
      | NoBootArchive => false } }
pure def lawStagedBootAnimationIsThePinnedBytes(c: CompositionCall): bool = {
  val archive = c.bootArchive
  compositionAdmitted(c) implies match archive { | BootArchiveRead(a) => c.descriptor.bootAnimation == PinnedBootAnimation({ sha256: a.sha256 }) and isDigest(a.sha256) | NoBootArchive => c.descriptor.bootAnimation == StockBootAnimation }
}
```

### A production composition has no unset or placeholder field, and a production Cuttlefish product pins its host packages and platform certificate

```quint
pure def hostPinned(h: HostPackage): bool = h.name != "" and h.version != "" and isDigest(h.sha256)
pure def productionProblems(c: CompositionCall): Set[CompositionProblem] = {
  val device = c.descriptor.device
  val hostUnpinned = match device { | CuttlefishProfile(x) => x.hostPackages.length() == 0 or not(x.hostPackages.every(h => hostPinned(h))) or not(isDigest(x.platformCertificate)) | PixelProfile(p) => false }
  if (c.purpose == V::Production) refuseWhen(c.descriptor.placeholderFields > 0, PlaceholderInProduction).union(refuseWhen(hostUnpinned, CuttlefishHostUnpinned)) else Set()
}
pure def lawPlaceholderNeverReachesProduction(c: CompositionCall): bool = (c.purpose == V::Production and c.descriptor.placeholderFields > 0) implies not(compositionAdmitted(c))
```

### A composition is admitted only when no check above refuses it, and a refusal names every problem

```quint
type CompositionCall = { descriptor: ProductDescriptor, purpose: V::BuildPurpose, brandToken: str, source: V::SourceVerdict, launcher: St::LauncherDescriptor,
  existing: List[CompositionOutput], settings: BuildSettings, bootArchive: BootArchive, clockLines: int, updater: UpdaterSource, outputInCheckout: bool }
pure def compositionProblems(c: CompositionCall): Set[CompositionProblem] =
  sourceProblems(c).union(launcherProblems(c)).union(settingsProblems(c)).union(productionProblems(c))
    .union(refuseWhen(outputsOf(c.descriptor).some(o => c.existing.includes(o)), OutputExists))
    .union(refuseWhen(not(bootAnimationAdmitted(c.descriptor.bootAnimation, c.bootArchive)), BootAnimationDiffers))
    .union(refuseWhen(c.descriptor.systemUpdater and c.updater != ReviewedDisabledUpdater, UpdaterNotReviewed))
pure def compositionAdmitted(c: CompositionCall): bool = compositionProblems(c).size() == 0
pure val acmePixel: ProductDescriptor = { schemaVersion: 1, syntaxValid: true, placeholderFields: 0,
  device: PixelProfile({ pixelConfig: { moduleName: "AcmeConfig", packageName: "com.acme.config", mimeType: "vnd.android.cursor.dir/vnd.acme.flags" } }),
  sourceProfile: "pixel10a", vendorDirectory: "acme", productName: "acme_stallion", model: "Acme", brand: "Acme", manufacturer: "Acme", releaseConfig: "bp4a",
  launcherModule: "AcmeHome", launcherPackage: "com.acme.home", listener: NoListener, systemUpdater: true, firstRun: true, bootAnimation: StockBootAnimation }
pure val acmeCuttlefish: ProductDescriptor = { ...acmePixel, sourceProfile: "cuttlefish", productName: "acme_cf_x86_64_phone", systemUpdater: false, firstRun: false,
  device: CuttlefishProfile({ hostPackages: List({ name: "cuttlefish-base", version: "1.0", sha256: Sha256({ hex: "h1" }) }), platformCertificate: Sha256({ hex: "p1" }) }) }
pure val acmeSource: V::SourceVerdict = { ...V::initial, verified: 1, verdict: V::Match,
  lock: { ...V::noLock, name: "pixel10a", digest: "lockA", device: V::PhysicalDevice({ archive: "z1", archiveSize: 9, vendorApiLevel: 202604 }), developmentOnly: false, targets: List("stallion") },
  admitted: List({ brand: "acme", product: { brand: "acme", target: "stallion" }, purpose: V::Production }) }
pure val acmeCuttlefishSource: V::SourceVerdict = { ...acmeSource, lock: { ...V::noLock, name: "cuttlefish", digest: "lockV", developmentOnly: false, targets: List("cf_x86_64_phone") },
  admitted: List({ brand: "acme", product: { brand: "acme", target: "cf_x86_64_phone" }, purpose: V::Production }) }
pure val acmeLauncher: St::LauncherDescriptor = { ...St::noCall.descriptor, schemaVersion: 1, brandValid: true, moduleNameValid: true, moduleName: "AcmeHome",
  packageName: "com.acme.home", apkSha256: Sha256({ hex: "a1" }), certificate: Sha256({ hex: "c1" }) }
pure val pixelCall: CompositionCall = { descriptor: acmePixel, purpose: V::Production, brandToken: "acme", source: acmeSource, launcher: acmeLauncher,
  existing: List(), settings: requiredSettings, bootArchive: NoBootArchive, clockLines: 1, updater: ReviewedDisabledUpdater, outputInCheckout: true }
pure val cuttlefishCall: CompositionCall = { ...pixelCall, descriptor: acmeCuttlefish, source: acmeCuttlefishSource }
pure val cValues = Set(pixelCall, cuttlefishCall, { ...pixelCall, purpose: V::Development },
  { ...pixelCall, outputInCheckout: false }, { ...pixelCall, source: acmeCuttlefishSource }, { ...cuttlefishCall, source: acmeSource },
  { ...pixelCall, source: { ...acmeSource, lock: { ...acmeSource.lock, device: V::VirtualDevice } } },
  { ...pixelCall, descriptor: { ...acmePixel, placeholderFields: 1 } }, { ...pixelCall, descriptor: { ...acmeCuttlefish, sourceProfile: "pixel10a" } },
  { ...pixelCall, brandToken: "other" }, { ...pixelCall, source: { ...acmeSource, verdict: V::Mismatch } }, { ...pixelCall, launcher: { ...acmeLauncher, partition: St::SystemPartition } },
  { ...pixelCall, existing: List(ProductMakefile) }, { ...cuttlefishCall, existing: List(DeviceTemplates) },
  { ...pixelCall, settings: { ...requiredSettings, selinux: SelinuxPermissive } }, { ...pixelCall, clockLines: 2 }, { ...pixelCall, updater: EnabledUpdater },
  { ...pixelCall, descriptor: { ...acmePixel, bootAnimation: PinnedBootAnimation({ sha256: Sha256({ hex: "b1" }) }) },
    bootArchive: BootArchiveRead({ sha256: Sha256({ hex: "b1" }), storedOnly: true, descAtRoot: true, framesInEveryPart: true }) },
  { ...pixelCall, bootArchive: BootArchiveRead({ sha256: Sha256({ hex: "b1" }), storedOnly: true, descAtRoot: true, framesInEveryPart: true }) },
  { ...cuttlefishCall, descriptor: { ...acmeCuttlefish, device: CuttlefishProfile({ hostPackages: List(), platformCertificate: NotADigest }) } })
```

### The composition record binds every staged artifact to the descriptor digest and claims staging only

The record (`physical-product.json`) names the lunch choice, the purpose
and each staged artifact with the descriptor digest it was staged from. It
never claims an image built, signed, booted, qualified or accepted: a
reader refuses a record that does, and a set mixing two descriptors.

```quint
type RecordClaim = ProductStaged | ImageBuilt | ImageSigned | ReleaseQualified | DeviceAccepted
type StagedArtifact = { path: str, descriptorDigest: Digest }
pure def recordAdmitted(descriptorDigest: Digest, artifacts: List[StagedArtifact], claims: Set[RecordClaim]): bool =
  isDigest(descriptorDigest) and artifacts.every(a => digestsMatch(a.descriptorDigest, descriptorDigest)) and claims.subseteq(Set(ProductStaged)) and claims.contains(ProductStaged)
pure val artifactsValues = Set(List(), List({ path: "launcher", descriptorDigest: Sha256({ hex: "d1" }) }),
  List({ path: "launcher", descriptorDigest: Sha256({ hex: "d1" }) }, { path: "listener", descriptorDigest: Sha256({ hex: "d2" }) }), List({ path: "updater", descriptorDigest: NotADigest }))
pure val descriptorDigestValues = Set(NotADigest, Sha256({ hex: "d1" }), Sha256({ hex: "d2" }))
pure val claimsValues = Set(Set(ProductStaged), Set(ProductStaged, ImageBuilt), Set(ProductStaged, DeviceAccepted), Set())
pure def lawMixedOrUnboundArtifactsAreRefused(descriptorDigest: Digest, artifacts: List[StagedArtifact], claims: Set[RecordClaim]): bool =
  artifacts.some(a => not(digestsMatch(a.descriptorDigest, descriptorDigest))) implies not(recordAdmitted(descriptorDigest, artifacts, claims))
pure def lawRecordIsNeverBootEvidence(descriptorDigest: Digest, artifacts: List[StagedArtifact], claims: Set[RecordClaim]): bool = recordAdmitted(descriptorDigest, artifacts, claims) implies
  not(claims.contains(ImageBuilt) or claims.contains(ImageSigned) or claims.contains(ReleaseQualified) or claims.contains(DeviceAccepted))
```

## Story: Enroll my product's update channel

> As a product maker, I want my image's system updater pointed at my own
> update channel only by a reviewed enrollment I run on purpose, so that a
> staged updater is inert until then and never trusts a host or certificate
> my channel does not name.

### The shared updater is staged only from its reviewed sources, with updates disabled

The shell hashes each updater source against the reviewed inventory and
reads `os_update_enabled` from its configuration: `ChangedUpdater` when a
hash differs, `EnabledUpdater` when the source enables updates.

```quint
type UpdaterSource = ReviewedDisabledUpdater | ChangedUpdater | EnabledUpdater
pure def lawEnabledOrChangedUpdaterIsNeverStaged(c: CompositionCall): bool =
  (compositionAdmitted(c) and c.descriptor.systemUpdater) implies c.updater == ReviewedDisabledUpdater
```

### An enrollment enables updates from an HTTPS manifest on a listed host, for this product and device, under the channel's OTA certificate

Hosts are non-empty and distinct. The OTA certificate is both the one the
channel names and the one read from the consumer's public certificate.

```quint
type ManifestUrl = { scheme: str, host: str }
type Enrollment = { manifestUrl: ManifestUrl, hosts: List[str], product: str, device: str, otaCertificate: Digest }
type EnrollmentProblem = ManifestNotHttps | HostsEmptyOrRepeated | ManifestHostNotListed | ProductDiffers | DeviceDiffers | CertificateNotTheChannels
pure def enrollmentRefusal(found: bool, problem: EnrollmentProblem): Set[EnrollmentProblem] = if (found) Set(problem) else Set()
pure def enrollmentProblems(e: Enrollment, d: ProductDescriptor, channelCertificate: Digest, certificateRead: Digest): Set[EnrollmentProblem] =
  enrollmentRefusal(e.manifestUrl.scheme != "https", ManifestNotHttps).union(enrollmentRefusal(e.hosts.length() == 0 or not(St::distinctNames(e.hosts)), HostsEmptyOrRepeated))
    .union(enrollmentRefusal(not(e.hosts.includes(e.manifestUrl.host)), ManifestHostNotListed)).union(enrollmentRefusal(e.product != d.productName, ProductDiffers))
    .union(enrollmentRefusal(e.device != deviceName(d), DeviceDiffers))
    .union(enrollmentRefusal(not(digestsMatch(e.otaCertificate, channelCertificate) and digestsMatch(e.otaCertificate, certificateRead)), CertificateNotTheChannels))
pure val acmeEnrollment: Enrollment = { manifestUrl: { scheme: "https", host: "updates.acme.test" }, hosts: List("updates.acme.test"), product: "acme_stallion",
  device: "stallion", otaCertificate: Sha256({ hex: "o1" }) }
pure val eValues = Set(acmeEnrollment, { ...acmeEnrollment, manifestUrl: { scheme: "http", host: "updates.acme.test" } }, { ...acmeEnrollment, hosts: List() },
  { ...acmeEnrollment, hosts: List("cdn.acme.test") }, { ...acmeEnrollment, device: "vsoc_x86_64_only" }, { ...acmeEnrollment, otaCertificate: Sha256({ hex: "o2" }) })
pure val dValues = Set(acmePixel, acmeCuttlefish)
pure val channelCertificateValues = Set(Sha256({ hex: "o1" }), NotADigest)
pure val certificateReadValues = Set(Sha256({ hex: "o1" }), Sha256({ hex: "o2" }))
pure def lawEnrollmentTrustsOnlyTheChannel(e: Enrollment, d: ProductDescriptor, channelCertificate: Digest, certificateRead: Digest): bool =
  enrollmentProblems(e, d, channelCertificate, certificateRead).size() == 0 implies
    (e.manifestUrl.scheme == "https" and e.hosts.includes(e.manifestUrl.host) and isDigest(channelCertificate) and e.otaCertificate == channelCertificate and e.device == deviceName(d))
```

### An enrollment is written only on explicit execute, into a checkout whose updater sources and product makefile are what was reviewed, and never over an earlier one

Without execute the call only reports what it would write. With it, the
shell writes the overlay, the certificate and `enrollment.mk` once, appends
one inherit line to the product makefile whose preimage digest the operator
gave, and writes a new receipt.

```quint
type EnrollmentRun = PlanOnly | Execute
type EnrollmentCheckout = { updater: UpdaterSource, updaterInherited: bool, productMakefileMatches: bool, enrollmentExists: bool }
type EnrollmentOutcome = EnrollmentWritten | EnrollmentPlanned | EnrollmentRefused
pure def checkoutAdmitted(k: EnrollmentCheckout): bool =
  k.updater == ReviewedDisabledUpdater and k.updaterInherited and k.productMakefileMatches and not(k.enrollmentExists)
pure def enrollmentOutcome(execution: EnrollmentRun, e: Enrollment, d: ProductDescriptor, channelCertificate: Digest, certificateRead: Digest, k: EnrollmentCheckout): EnrollmentOutcome =
  if (enrollmentProblems(e, d, channelCertificate, certificateRead).size() > 0 or not(checkoutAdmitted(k))) EnrollmentRefused
  else if (execution == Execute) EnrollmentWritten else EnrollmentPlanned
pure val reviewedCheckout: EnrollmentCheckout = { updater: ReviewedDisabledUpdater, updaterInherited: true, productMakefileMatches: true, enrollmentExists: false }
pure val kValues = Set(reviewedCheckout, { ...reviewedCheckout, updater: ChangedUpdater }, { ...reviewedCheckout, updaterInherited: false },
  { ...reviewedCheckout, productMakefileMatches: false }, { ...reviewedCheckout, enrollmentExists: true })
pure def lawWrittenOnlyOnExecuteIntoTheReviewedCheckout(execution: EnrollmentRun, e: Enrollment, d: ProductDescriptor, channelCertificate: Digest, certificateRead: Digest, k: EnrollmentCheckout): bool =
  enrollmentOutcome(execution, e, d, channelCertificate, certificateRead, k) == EnrollmentWritten implies (execution == Execute and checkoutAdmitted(k))
```
