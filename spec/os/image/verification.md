# Booted-image verification

Read-only checks of a booted device against what was staged: the exact
image, the launcher's bytes and its place as Home, the stock launcher kept
as a way back, the system clock's alarm handlers, a WebView provider, the
first-boot grants, the wake listener when one was staged, the system secure
camera, SELinux and verified boot. Sources: develop's
`verify-launcher-image.mjs` and the device halves of
`aosp-clock-handlers.mjs`, `sense-listener.mjs` (`verifyAospListener`) and
`secure-camera.mjs` (`verifySecureCameraImage`). The shell is `verifyImage`
in `src/image/verify-device.vibe`, exported from `@elizaos/os/image`; the
cable update operator ([operator](../update/operator.md)) uses it after an
update.

The shell issues only reads over adb (`getprop`, `getenforce`, `pm`,
`cmd package`, `cmd role`, `cmd overlay lookup`, `dumpsys`, `ps -Z`,
`sha256sum`, `cat`); it installs, grants, sets and starts nothing. It
parses each capture into an `ImageObservation`: a command that failed,
timed out, or printed nothing its parser recognises is that field's unread
variant. The expectation comes from the staging record: the launcher
descriptor ([staging](./staging.md)), the provisioning rules
([provisioning](./provisioning.md)) and the listener rules
([listener](./listener.md)). A pass is evidence for these facts only: not
that an alarm rings, that a locked capture is isolated, that the listener
hears anything, or that a person accepted the device.

## Story: Know whether a booted image is what I staged

> As a device maintainer, I want one verdict on whether the booted device
> runs the image I staged, so that I never ship or update over an image I
> only believe is right, and never read a check I could not make as a pass.

### Each check reads Pass or Fail, and a check that could not be read is Unknown

`Reading` is a yes-or-no fact the shell read: the device finished booting
and nothing changed during the run (boot identity, user, fingerprint,
launcher path and bytes, Home and SELinux read again at the end equal the
first reading), Home resolves to exactly the launcher's Home activity, an
enabled system launcher other than the setup fallback remains a Home
candidate, and a WebView provider is current.

```quint
import apk.* from "./apk"
import provisioning as Pv from "./provisioning"
import listener as L from "./listener"
type CheckOutcome = Pass | Fail | Unknown
type Reading = Unread | Read({ holds: bool })
pure def outcomeOf(reading: Reading): CheckOutcome = match reading { | Unread => Unknown | Read(r) => if (r.holds) Pass else Fail }
pure val readingValues = Set(Unread, Read({ holds: true }), Read({ holds: false }))
pure def outcomeIf(read: bool, holds: bool): CheckOutcome = if (not(read)) Unknown else if (holds) Pass else Fail
pure def lawUnreadIsUnknownOnly(reading: Reading): bool = (outcomeOf(reading) == Unknown) iff (reading == Unread)
```

### Verified boot passes only when the booted state is no weaker than the image expects

Android reports `green` (locked, the manufacturer's key), `yellow` (locked,
a custom key the image enrolled), `orange` (unlocked) or `red`. An image
signed with a custom key expects at least `yellow`. A target without
verified boot, such as a virtual device, expects nothing and the check is
not required.

```quint
type BootState = Green | Yellow | Orange | Red
type BootExpectation = BootUnchecked | BootAtLeast({ minimum: BootState })
pure def bootStrength(booted: BootState): int = match booted { | Green => 3 | Yellow => 2 | Orange => 1 | Red => 0 }
pure def verifiedBootNotWeaker(booted: BootState, minimum: BootState): bool = bootStrength(booted) >= bootStrength(minimum)
pure val bootedValues = Set(Green, Yellow, Orange, Red)
pure val minimumValues = bootedValues
pure def lawUnlockedNeverMeetsALockedImage(minimum: BootState): bool = (minimum == Green or minimum == Yellow) implies not(verifiedBootNotWeaker(Orange, minimum))
pure def lawRedNeverMeetsAnyExpectation(minimum: BootState): bool = minimum != Red implies not(verifiedBootNotWeaker(Red, minimum))
```

### First-boot grants are exactly the descriptor's defaults, each granted by default and none fixed

The shell reads the launcher's granted runtime permissions for the user
with their flags. Each of the descriptor's `defaultPermissions` is granted
by default; any other grant is one Android makes itself for compatibility,
carrying that flag; and no grant is fixed (`FIXED`, `SYSTEM_FIXED` or
`POLICY_FIXED`), so the person can revoke each.

```quint
type GrantOrigin = GrantedByDefault | CompatibilityGrant | OtherGrant
type RuntimeGrant = { permission: str, origin: GrantOrigin, fixed: bool }
pure val compatibilityGrants: List[str] = List("android.permission.ACCESS_LOCAL_NETWORK")
pure def grantAllowed(defaults: List[str], grant: RuntimeGrant): bool =
  not(grant.fixed) and (defaults.includes(grant.permission) or (grant.origin == CompatibilityGrant and compatibilityGrants.includes(grant.permission)))
pure def firstBootGrantsHold(defaults: List[str], granted: List[RuntimeGrant]): bool =
  defaults.every(p => granted.some(g => g.permission == p and g.origin == GrantedByDefault and not(g.fixed))) and granted.every(g => grantAllowed(defaults, g))
pure val audioGrant: RuntimeGrant = { permission: "android.permission.RECORD_AUDIO", origin: GrantedByDefault, fixed: false }
pure val defaultsValues = Set(List("android.permission.RECORD_AUDIO"), List())
pure val grantedValues = Set(List(audioGrant), List(), List({ ...audioGrant, fixed: true }), List(audioGrant, { ...audioGrant, permission: "android.permission.READ_SMS" }),
  List(audioGrant, { permission: "android.permission.ACCESS_LOCAL_NETWORK", origin: CompatibilityGrant, fixed: false }))
pure def lawUnexpectedGrantFails(defaults: List[str], granted: List[RuntimeGrant]): bool =
  granted.some(g => not(defaults.includes(g.permission)) and g.origin != CompatibilityGrant) implies not(firstBootGrantsHold(defaults, granted))
pure def lawFixedGrantFails(defaults: List[str], granted: List[RuntimeGrant]): bool =
  granted.some(g => g.fixed) implies not(firstBootGrantsHold(defaults, granted))
```

### Alarms stay with the system clock: it is enabled and handles every alarm action

```quint
pure val clockAlarmActions: List[str] = List("SET_ALARM", "SHOW_ALARMS", "SNOOZE_ALARM", "DISMISS_ALARM")
type ClockReading = ClockUnread | ClockRead({ clockEnabled: bool, handledActions: List[str] })
pure def clockHolds(clock: ClockReading): bool = match clock {
  | ClockRead(c) => c.clockEnabled and clockAlarmActions.every(a => c.handledActions.includes(a))
  | _ => false
}
```

### Lock-screen capture belongs to the system secure camera, and the launcher handles neither secure action

For the user, the enabled system camera (`Pv::secureCameraPackage`)
resolves both secure capture actions to its secure activity, the power
gesture is enabled and opens it, and no activity of the launcher handles
either action.

```quint
pure val secureCaptureActions: List[str] = List("STILL_IMAGE_CAMERA_SECURE", "IMAGE_CAPTURE_SECURE")
type CameraReading = CameraUnread | CameraRead({ systemHandles: List[str], launcherHandles: List[str], gestureOpensCamera: bool })
pure def secureCameraHolds(camera: CameraReading): bool = match camera {
  | CameraRead(c) => secureCaptureActions.every(a => c.systemHandles.includes(a)) and c.launcherHandles.length() == 0 and c.gestureOpensCamera
  | _ => false
}
```

### A staged listener is a privileged system package with every reviewed privileged grant, none forbidden, the indicator kept, in its own domain

The listener is the system package `<launcher>.sense`. The shell reads its
grants from `dumpsys package`, the holders of the indicator-exempt roles
and the microphone indicator flag, and the SELinux domain of its running
process from `ps -Z`.

```quint
type ListenerReading = ListenerUnread | ListenerRead({ privilegedSystemPackage: bool, granted: List[str], indicatorKept: bool, domain: str })
pure def listenerGrantsHold(listener: ListenerReading): bool = match listener {
  | ListenerRead(l) => l.privilegedSystemPackage and l.indicatorKept and L::listenerPrivilegedPermissions.every(p => l.granted.includes(p))
      and not(l.granted.some(p => L::listenerForbiddenPermissions.includes(p)))
  | _ => false
}
pure def listenerDomainHolds(listener: ListenerReading): bool = match listener { | ListenerRead(l) => l.domain == L::listenerSelinuxDomain | _ => false }
```

### The checks are fixed by what was staged: the listener's only for a listener image, verified boot only where the target has it

```quint
type ImageCheck = Fingerprint | LauncherBytes | LauncherHome | StockLauncher | ClockHandlers | WebViewProvider | FirstBootGrants
  | SecureCamera | SameBootThroughout | SelinuxEnforcing | VerifiedBoot | ListenerGrants | ListenerDomain
type ImageExpectation = { fingerprint: str, launcherApk: Digest, defaultPermissions: List[str], listener: bool, boot: BootExpectation }
pure val baseChecks: List[ImageCheck] = List(Fingerprint, LauncherBytes, LauncherHome, StockLauncher, ClockHandlers, WebViewProvider, FirstBootGrants,
  SecureCamera, SameBootThroughout, SelinuxEnforcing)
pure def requiredChecks(expectation: ImageExpectation): List[ImageCheck] = {
  val withBoot = if (expectation.boot == BootUnchecked) baseChecks else baseChecks.append(VerifiedBoot)
  if (expectation.listener) withBoot.concat(List(ListenerGrants, ListenerDomain)) else withBoot
}
```

### An image passes only when every required check passes, and a failure outranks an unread check

The launcher check passes only for the staged APK at its system path,
installed whole and not replaced by a data APK, with the staged digest.

```quint
type FingerprintReading = FingerprintUnread | FingerprintRead({ fingerprint: str })
type LauncherInstall = LauncherUnread | NotTheSystemApk | SystemApk({ sha256: Digest })
type SelinuxReading = SelinuxUnread | Enforcing | Permissive
type BootReading = BootUnread | BootRead({ booted: BootState })
type GrantsReading = GrantsUnread | GrantsRead({ granted: List[RuntimeGrant] })
type ImageObservation = { fingerprint: FingerprintReading, launcher: LauncherInstall, home: Reading, stockHome: Reading, clock: ClockReading,
  webView: Reading, grants: GrantsReading, camera: CameraReading, sameBoot: Reading, selinux: SelinuxReading, verifiedBoot: BootReading,
  listener: ListenerReading }
type CheckResult = { check: ImageCheck, outcome: CheckOutcome }
pure def bootHolds(bootExpectation: BootExpectation, booted: BootState): bool = match bootExpectation { | BootAtLeast(b) => verifiedBootNotWeaker(booted, b.minimum) | _ => true }
pure def fingerprintOutcome(stagedFingerprint: str, fingerprint: FingerprintReading): CheckOutcome =
  match fingerprint { | FingerprintRead(f) => outcomeIf(true, f.fingerprint == stagedFingerprint) | _ => Unknown }
pure def launcherOutcome(stagedDigest: Digest, launcher: LauncherInstall): CheckOutcome =
  match launcher { | SystemApk(a) => outcomeIf(true, digestsMatch(a.sha256, stagedDigest)) | NotTheSystemApk => Fail | _ => Unknown }
pure def grantsOutcome(defaults: List[str], grants: GrantsReading): CheckOutcome =
  match grants { | GrantsRead(g) => outcomeIf(true, firstBootGrantsHold(defaults, g.granted)) | _ => Unknown }
pure def bootOutcome(bootExpectation: BootExpectation, verifiedBoot: BootReading): CheckOutcome =
  match verifiedBoot { | BootRead(b) => outcomeIf(true, bootHolds(bootExpectation, b.booted)) | _ => Unknown }
pure def checkOutcome(expectation: ImageExpectation, observation: ImageObservation, check: ImageCheck): CheckOutcome = match check {
  | Fingerprint => fingerprintOutcome(expectation.fingerprint, observation.fingerprint)
  | LauncherBytes => launcherOutcome(expectation.launcherApk, observation.launcher)
  | LauncherHome => outcomeOf(observation.home)
  | StockLauncher => outcomeOf(observation.stockHome)
  | ClockHandlers => outcomeIf(observation.clock != ClockUnread, clockHolds(observation.clock))
  | WebViewProvider => outcomeOf(observation.webView)
  | FirstBootGrants => grantsOutcome(expectation.defaultPermissions, observation.grants)
  | SecureCamera => outcomeIf(observation.camera != CameraUnread, secureCameraHolds(observation.camera))
  | SameBootThroughout => outcomeOf(observation.sameBoot)
  | SelinuxEnforcing => outcomeIf(observation.selinux != SelinuxUnread, observation.selinux == Enforcing)
  | VerifiedBoot => bootOutcome(expectation.boot, observation.verifiedBoot)
  | ListenerGrants => outcomeIf(observation.listener != ListenerUnread, listenerGrantsHold(observation.listener))
  | ListenerDomain => outcomeIf(observation.listener != ListenerUnread, listenerDomainHolds(observation.listener))
}
pure def imageReport(expectation: ImageExpectation, observation: ImageObservation): List[CheckResult] =
  requiredChecks(expectation).listMap(c => { check: c, outcome: checkOutcome(expectation, observation, c) })
pure def imageVerdict(expectation: ImageExpectation, observation: ImageObservation): CheckOutcome = {
  val outcomes = requiredChecks(expectation).listMap(c => checkOutcome(expectation, observation, c))
  if (outcomes.includes(Fail)) Fail else if (outcomes.includes(Unknown)) Unknown else Pass
}
pure def lawFailureOutranksUnknown(expectation: ImageExpectation, observation: ImageObservation): bool =
  requiredChecks(expectation).some(c => checkOutcome(expectation, observation, c) == Fail) iff imageVerdict(expectation, observation) == Fail
```

### A passing image is enforcing SELinux, boots no weaker than expected, and runs the staged launcher bytes

```quint
pure def lawPassIsEnforcingAndNoWeaker(expectation: ImageExpectation, observation: ImageObservation): bool =
  imageVerdict(expectation, observation) == Pass implies (observation.selinux == Enforcing
    and (expectation.boot == BootUnchecked or bootOutcome(expectation.boot, observation.verifiedBoot) == Pass))
pure def lawPassRunsTheStagedLauncher(expectation: ImageExpectation, observation: ImageObservation): bool =
  imageVerdict(expectation, observation) == Pass implies launcherOutcome(expectation.launcherApk, observation.launcher) == Pass
pure def lawUnreadSelinuxNeverPasses(expectation: ImageExpectation, observation: ImageObservation): bool =
  observation.selinux == SelinuxUnread implies imageVerdict(expectation, observation) != Pass
pure def lawUnreadListenerNeverPassesAListenerImage(expectation: ImageExpectation, observation: ImageObservation): bool =
  (expectation.listener and observation.listener == ListenerUnread) implies imageVerdict(expectation, observation) != Pass
```

### The image as staged passes, with and without a listener, on a locked or a virtual target

```quint
pure val stagedApk: Digest = Sha256({ hex: "a1" })
pure val stagedImage: ImageExpectation = { fingerprint: "vendor/product:16/BP1A/1:user/release-keys", launcherApk: stagedApk,
  defaultPermissions: List("android.permission.RECORD_AUDIO"), listener: false, boot: BootAtLeast({ minimum: Yellow }) }
pure val stagedListener: ListenerReading = ListenerRead({ privilegedSystemPackage: true, indicatorKept: true, domain: L::listenerSelinuxDomain,
  granted: L::listenerPrivilegedPermissions.concat(List("android.permission.RECORD_AUDIO")) })
pure val bootedAsStaged: ImageObservation = { fingerprint: FingerprintRead({ fingerprint: stagedImage.fingerprint }), launcher: SystemApk({ sha256: stagedApk }),
  home: Read({ holds: true }), stockHome: Read({ holds: true }), clock: ClockRead({ clockEnabled: true, handledActions: clockAlarmActions }),
  webView: Read({ holds: true }), grants: GrantsRead({ granted: List(audioGrant) }), sameBoot: Read({ holds: true }), selinux: Enforcing,
  camera: CameraRead({ systemHandles: secureCaptureActions, launcherHandles: List(), gestureOpensCamera: true }),
  verifiedBoot: BootRead({ booted: Yellow }), listener: stagedListener }
pure val expectationValues = Set(stagedImage, { ...stagedImage, listener: true }, { ...stagedImage, boot: BootUnchecked },
  { ...stagedImage, boot: BootAtLeast({ minimum: Green }) })
pure val observationValues = Set(bootedAsStaged, { ...bootedAsStaged, selinux: Permissive }, { ...bootedAsStaged, selinux: SelinuxUnread },
  { ...bootedAsStaged, verifiedBoot: BootRead({ booted: Orange }) }, { ...bootedAsStaged, verifiedBoot: BootUnread },
  { ...bootedAsStaged, launcher: NotTheSystemApk }, { ...bootedAsStaged, launcher: SystemApk({ sha256: NotADigest }) },
  { ...bootedAsStaged, listener: ListenerUnread }, { ...bootedAsStaged, listener: ListenerRead({ privilegedSystemPackage: true, indicatorKept: true,
    domain: "untrusted_app", granted: L::listenerPrivilegedPermissions }) },
  { ...bootedAsStaged, clock: ClockRead({ clockEnabled: true, handledActions: List("SET_ALARM") }), selinux: SelinuxUnread },
  { ...bootedAsStaged, camera: CameraRead({ systemHandles: secureCaptureActions, launcherHandles: List("IMAGE_CAPTURE_SECURE"), gestureOpensCamera: true }) })
pure def lawTheStagedImagePasses(expectation: ImageExpectation): bool =
  (expectation.boot != BootAtLeast({ minimum: Green })) implies imageVerdict(expectation, bootedAsStaged) == Pass
```
