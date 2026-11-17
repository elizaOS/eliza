# Product composition

A consumer composes its product from a descriptor it supplies over one
device profile the os package admits: a physical phone kept on its stock
factory vendor partition, or a virtual Cuttlefish target. The os package
names no product. The [source lock](./sourceLock.md) verifies the source
the profile builds from, the [launcher staging](./launcher.md) places the
consumer's home app, and the [image capabilities](./capabilities.md)
declare what the image stages. Composition is staging output: only a boot
of the built image shows that the device honors it.

## Story: Compose a product on a supported device profile

> As a consumer, I want to build my branded Android image by handing the
> os package a descriptor of my product, so that it serves any product
> without knowing mine, every image keeps the system clock and secure
> camera, and nothing unreviewed or half-configured reaches production.

### A product names one admitted device profile, the source profile pinned for it, and a verified source lock

The descriptor names the consumer's vendor directory, product name,
launcher package, wake listener package, whether the system updater is
included, whether lock-screen surfaces are refused, and the device and
source profiles it builds on. The os package supplies the device profiles
and the source profile pinned for each; the source profile of a physical
device pins its factory archive and vendor board API level, so its lock
verdict covers them. A profile the os package does not admit, a source
profile other than the one pinned for the device, or a source lock that
has not matched refuses composition.

```quint
import sourceLock as Lock from "./sourceLock"
type DeviceKind = PhysicalDevice | VirtualDevice | UnknownDevice
type DeviceProfile = { name: str, kind: DeviceKind, pinnedSource: str }
type ProductDescriptor = {
  vendorDirectory: str, productName: str, launcherPackage: str, listenerPackage: str,
  systemUpdater: bool, refuseLockScreen: bool, deviceProfile: str, sourceProfile: str
}
type Composition = {
  descriptor: ProductDescriptor, profile: DeviceProfile, lock: Lock::LockVerdict,
  launcherOverKeyguard: bool, launcherHandlesSecureCapture: bool, clockIncluded: bool, secureCameraVerified: bool
}
type CompositionDecision = Composed | UnknownProfile | SourceProfileMismatch | SourceUnverified | LockScreenSurface | MissingClock | MissingSecureCamera
pure def profileDecision(c: Composition): CompositionDecision =
  if (c.profile.kind == UnknownDevice or c.descriptor.deviceProfile != c.profile.name) UnknownProfile
  else if (c.descriptor.sourceProfile == "" or c.descriptor.sourceProfile != c.profile.pinnedSource) SourceProfileMismatch
  else if (c.lock != Lock::LockMatched) SourceUnverified
  else Composed
pure val exampleDescriptor: ProductDescriptor = {
  vendorDirectory: "vendor/acme", productName: "acme_phone", launcherPackage: "com.acme.home",
  listenerPackage: "com.acme.listener", systemUpdater: false, refuseLockScreen: true, deviceProfile: "phone", sourceProfile: "phone-source"
}
pure val phoneProfile: DeviceProfile = { name: "phone", kind: PhysicalDevice, pinnedSource: "phone-source" }
pure val composedPhone: Composition = {
  descriptor: exampleDescriptor, profile: phoneProfile, lock: Lock::LockMatched,
  launcherOverKeyguard: false, launcherHandlesSecureCapture: false, clockIncluded: true, secureCameraVerified: true
}
pure val cValues = Set(composedPhone,
  { ...composedPhone, profile: { name: "phone", kind: VirtualDevice, pinnedSource: "phone-source" } },
  { ...composedPhone, profile: { ...phoneProfile, kind: UnknownDevice } },
  { ...composedPhone, descriptor: { ...exampleDescriptor, deviceProfile: "other" } },
  { ...composedPhone, descriptor: { ...exampleDescriptor, sourceProfile: "" } },
  { ...composedPhone, lock: Lock::LockMismatched },
  { ...composedPhone, descriptor: { ...exampleDescriptor, productName: "UNSET" } },
  { ...composedPhone, launcherOverKeyguard: true },
  { ...composedPhone, descriptor: { ...exampleDescriptor, refuseLockScreen: false }, launcherOverKeyguard: true },
  { ...composedPhone, clockIncluded: false },
  { ...composedPhone, secureCameraVerified: false })
pure def lawUnadmittedProfileNeverComposes(c: Composition): bool =
  (c.profile.kind == UnknownDevice or c.descriptor.deviceProfile != c.profile.name) implies profileDecision(c) == UnknownProfile
```

### A launcher shows nothing over the lock screen when the descriptor refuses lock-screen surfaces

Capture over the lock screen belongs to the system camera's secure
activity and the standard power-button gesture. A descriptor that refuses
lock-screen surfaces admits a launcher only when its manifest declares no
activity shown over the keyguard and no secure-capture handler. A
consumer with its own lock-screen surface, such as an alarm, leaves the
refusal off.

```quint
pure def lockScreenAdmitted(c: Composition): bool =
  not(c.descriptor.refuseLockScreen) or not(c.launcherOverKeyguard or c.launcherHandlesSecureCapture)
```

### The system clock and the verified secure camera are present before composition

Every image keeps the system clock app for alarms and timers, and stages
the system camera's secure capture from its reviewed source. Adding the
clock to the product makefile leaves exactly the requirement it had if it
was already present. A composition missing either is refused, whatever
the launcher offers.

```quint
pure def composition(c: Composition): CompositionDecision =
  if (profileDecision(c) != Composed) profileDecision(c)
  else if (not(lockScreenAdmitted(c))) LockScreenSurface
  else if (not(c.clockIncluded)) MissingClock
  else if (not(c.secureCameraVerified)) MissingSecureCamera
  else Composed
pure def requireClock(clockLines: int): int = if (clockLines >= 1) clockLines else 1
pure val clockLinesValues = Set(0, 1, 2)
pure def lawClockRequirementIsIdempotent(clockLines: int): bool =
  requireClock(clockLines) >= 1 and requireClock(requireClock(clockLines)) == requireClock(clockLines)
```

### Production staging refuses an unset or placeholder identity field

An empty value or the literal placeholder `UNSET` in any identity field of
the descriptor refuses production staging. A development build may stage
a descriptor with placeholders; a production one never does.

```quint
pure def placeholder(value: str): bool = value == "" or value == "UNSET"
pure def identityComplete(d: ProductDescriptor): bool =
  not(placeholder(d.vendorDirectory)) and not(placeholder(d.productName)) and not(placeholder(d.launcherPackage)) and
  not(placeholder(d.listenerPackage)) and not(placeholder(d.deviceProfile)) and not(placeholder(d.sourceProfile))
pure def productionStagingAdmitted(c: Composition): bool = identityComplete(c.descriptor) and composition(c) == Composed
pure def lawPlaceholderNeverReachesProduction(c: Composition): bool =
  placeholder(c.descriptor.productName) implies not(productionStagingAdmitted(c))
```

### Every staged artifact is bound to the descriptor digest

Each artifact staged for a product records the digest of the descriptor
it was staged from. A staging set mixing artifacts of two descriptors, or
holding one with no descriptor digest, is refused.

```quint
type StagedArtifact = { path: str, descriptorDigest: str }
pure def stagedForDescriptor(digest: str, artifacts: List[StagedArtifact]): bool =
  digest != "" and artifacts.every(a => a.descriptorDigest == digest)
pure val artifactsValues = Set(List(), List({ path: "launcher", descriptorDigest: "d1" }),
  List({ path: "launcher", descriptorDigest: "d1" }, { path: "listener", descriptorDigest: "d2" }),
  List({ path: "updater", descriptorDigest: "" }))
pure val digestValues = Set("", "d1", "d2")
pure def lawMixedOrUnboundArtifactsAreRefused(digest: str, artifacts: List[StagedArtifact]): bool =
  (digest == "" or artifacts.some(a => a.descriptorDigest != digest or a.descriptorDigest == "")) implies
    not(stagedForDescriptor(digest, artifacts))
```

### An APK's native libraries enter the image only from an admitted APK built at a reviewed commit

Native payloads are admitted only for an APK whose digest and signer were
already admitted. The admission contract is generated from a full 40-hex
reviewed source commit, and the runtime pins it names are read from that
exact commit, never from the bytes of a working checkout. Every native
library must be stored uncompressed, be a little-endian 64-bit ELF for the
target's ABI, and at least one must be present; the libraries keep the
launcher's privileged or ordinary placement, and on a Soong-only product
the native installation patch must match its reviewed digest and the
source lock it was reviewed against.

```quint
pure def nativePayloadAdmitted(apkAdmitted: bool, reviewedCommit: bool, pinsFromCommit: bool, librariesPresent: bool, librariesUncompressed: bool,
  librariesMatchAbi: bool, placementMatchesLauncher: bool, soongOnly: bool, soongPatchReviewed: bool): bool =
  apkAdmitted and reviewedCommit and pinsFromCommit and librariesPresent and librariesUncompressed and librariesMatchAbi and
  placementMatchesLauncher and (soongPatchReviewed or not(soongOnly))
pure def lawNativePayloadNeedsAdmittedApk(reviewedCommit: bool, pinsFromCommit: bool, librariesPresent: bool, librariesUncompressed: bool,
  librariesMatchAbi: bool, placementMatchesLauncher: bool, soongOnly: bool, soongPatchReviewed: bool): bool =
  not(nativePayloadAdmitted(false, reviewedCommit, pinsFromCommit, librariesPresent, librariesUncompressed, librariesMatchAbi, placementMatchesLauncher, soongOnly, soongPatchReviewed))
pure def lawCheckoutBytesNeverPinNatives(apkAdmitted: bool, reviewedCommit: bool, librariesPresent: bool, librariesUncompressed: bool,
  librariesMatchAbi: bool, placementMatchesLauncher: bool, soongOnly: bool, soongPatchReviewed: bool): bool =
  not(nativePayloadAdmitted(apkAdmitted, reviewedCommit, false, librariesPresent, librariesUncompressed, librariesMatchAbi, placementMatchesLauncher, soongOnly, soongPatchReviewed))
pure def lawSoongOnlyProductNeedsReviewedPatch(apkAdmitted: bool, reviewedCommit: bool, pinsFromCommit: bool, librariesPresent: bool,
  librariesUncompressed: bool, librariesMatchAbi: bool, placementMatchesLauncher: bool): bool =
  not(nativePayloadAdmitted(apkAdmitted, reviewedCommit, pinsFromCommit, librariesPresent, librariesUncompressed, librariesMatchAbi, placementMatchesLauncher, true, false))
pure def lawEmptyNativePayloadIsRefused(apkAdmitted: bool, reviewedCommit: bool, pinsFromCommit: bool, librariesUncompressed: bool,
  librariesMatchAbi: bool, placementMatchesLauncher: bool, soongOnly: bool, soongPatchReviewed: bool): bool =
  not(nativePayloadAdmitted(apkAdmitted, reviewedCommit, pinsFromCommit, false, librariesUncompressed, librariesMatchAbi, placementMatchesLauncher, soongOnly, soongPatchReviewed))
```

### A physical device's platform declares the vendor partition's board API level

A product kept on the stock factory vendor partition builds with a
release configuration that declares exactly one board API level, equal to
the vendor interface level the factory vendor manifest declares. A
mismatch is corrected in the release configuration, never by rewriting
the vendor manifest, and refuses composition until it is.

```quint
pure def boardApiAdmitted(declarations: int, releaseLevel: int, vendorLevel: int): bool =
  declarations == 1 and releaseLevel > 0 and releaseLevel == vendorLevel
pure val declarationsValues = Set(0, 1, 2)
pure val releaseLevelValues = Set(0, 1, 2)
pure val vendorLevelValues = Set(1, 2)
pure def lawBoardApiMismatchIsRefused(declarations: int, releaseLevel: int, vendorLevel: int): bool =
  releaseLevel != vendorLevel implies not(boardApiAdmitted(declarations, releaseLevel, vendorLevel))
```
