# Booted-image verification

Read-only checks of a booted device against what was staged: the exact
image, the launcher's bytes and its place as Home, the stock launcher kept
as a way back, the system clock's alarm handlers, a WebView provider, the
first-boot grants, the image features, the wake listener when one was
staged, the system secure camera, SELinux and verified boot. Sources:
develop's `verify-launcher-image.mjs` and the device halves of
`aosp-clock-handlers.mjs`, `sense-listener.mjs` (`verifyAospListener`) and
`secure-camera.mjs` (`verifySecureCameraImage`). The shell is
`verifyImage` in `src/image/verify-device.vibe`, exported from
`@elizaos/os/image`; the cable OTA operator uses it after an update.

The shell issues only reads over adb (`getprop`, `getenforce`, `pm`,
`cmd package`, `dumpsys`, `sha256sum`, `cat`); it installs, grants, sets
and starts nothing. It parses each capture into a `Reading`: a command that
failed, timed out, or printed nothing the parser recognises is `Unread`.
What the image was staged with comes from the staging record: the launcher
descriptor ([staging](./staging.md)), the provisioning defaults and image
features ([provisioning](./provisioning.md)) and the listener's reviewed
grants. A pass is evidence for these facts only: not that an alarm rings,
that a locked capture is isolated, that the listener hears anything, or
that a person accepted the device.

## Story: Know whether a booted image is what I staged

> As a device maintainer, I want one verdict on whether the booted device
> runs the image I staged, so that I never ship or update over an image I
> only believe is right, and never read a check I could not make as a pass.

### Each check reads Pass or Fail, and a check that could not be read is Unknown

```quint
import provisioning as Pv from "./provisioning"
type CheckOutcome = Pass | Fail | Unknown
type Reading = Unread | Read({ holds: bool })
pure val readingValues = Set(Unread, Read({ holds: true }), Read({ holds: false }))
pure def outcomeOf(reading: Reading): CheckOutcome = match reading { | Unread => Unknown | Read(r) => if (r.holds) Pass else Fail }
pure def lawUnreadIsUnknownOnly(reading: Reading): bool = (outcomeOf(reading) == Unknown) iff (reading == Unread)
```

### The checks are fixed by what was staged, and the listener's only when a listener was staged

Every image is checked for its fingerprint, the launcher's bytes, the
launcher as the resolved Home, an enabled stock launcher that remains a
Home candidate, the clock, the WebView provider, the first-boot grants, the
image feature, the secure camera, SELinux and verified boot. An image
staged with the wake listener is also checked for the listener's grants and
its SELinux domain.

```quint
type ImageCheck = Fingerprint | LauncherBytes | LauncherHome | StockLauncher | ClockHandlers | WebViewProvider | FirstBootGrants | ImageFeature | ListenerGrants | ListenerDomain | SecureCamera | SelinuxEnforcing | VerifiedBoot
pure val baseChecks: List[ImageCheck] = List(Fingerprint, LauncherBytes, LauncherHome, StockLauncher, ClockHandlers, WebViewProvider, FirstBootGrants, ImageFeature, SecureCamera, SelinuxEnforcing, VerifiedBoot)
pure def requiredChecks(listener: bool): List[ImageCheck] = if (listener) baseChecks.concat(List(ListenerGrants, ListenerDomain)) else baseChecks
pure def lawListenerChecksOnlyForAListenerImage(listener: bool): bool = requiredChecks(listener).includes(ListenerGrants) iff listener
```

### An image passes only when every required check passes, a failure outranks an unread check, and a check not reported is Unknown

```quint
type CheckResult = { check: ImageCheck, outcome: CheckOutcome }
pure def reportedAs(results: List[CheckResult], check: ImageCheck, reported: CheckOutcome): bool = results.some(r => r.check == check and r.outcome == reported)
pure def outcomeFor(results: List[CheckResult], check: ImageCheck): CheckOutcome =
  if (reportedAs(results, check, Fail)) Fail else if (reportedAs(results, check, Unknown)) Unknown else if (reportedAs(results, check, Pass)) Pass else Unknown
pure def imageVerdict(listener: bool, results: List[CheckResult]): CheckOutcome = {
  val outcomes = requiredChecks(listener).listMap(c => outcomeFor(results, c))
  if (outcomes.includes(Fail)) Fail else if (outcomes.includes(Unknown)) Unknown else Pass
}
pure val passing: CheckResult = { check: Fingerprint, outcome: Pass }
pure val resultsValues = Set(List(), requiredChecks(false).listMap(c => { check: c, outcome: Pass }), requiredChecks(true).listMap(c => { check: c, outcome: Pass }),
  requiredChecks(false).listMap(c => { check: c, outcome: Pass }).append({ check: SelinuxEnforcing, outcome: Unknown }),
  requiredChecks(false).listMap(c => { check: c, outcome: Pass }).append({ check: VerifiedBoot, outcome: Fail }))
pure val extraValues = Set(passing, { check: VerifiedBoot, outcome: Fail }, { check: ClockHandlers, outcome: Unknown }, { check: ListenerDomain, outcome: Fail })
pure def lawPassIffEveryRequiredCheckPassed(listener: bool, results: List[CheckResult]): bool =
  (imageVerdict(listener, results) == Pass) iff requiredChecks(listener).every(c => outcomeFor(results, c) == Pass)
pure def lawFailOutranksUnknown(listener: bool, results: List[CheckResult], extra: CheckResult): bool =
  (extra.outcome == Fail and requiredChecks(listener).includes(extra.check)) implies imageVerdict(listener, results.append(extra)) == Fail
pure def lawUnreportedCheckNeverPasses(listener: bool, results: List[CheckResult], check: ImageCheck): bool =
  (requiredChecks(listener).includes(check) and not(results.some(r => r.check == check))) implies imageVerdict(listener, results) != Pass
```

### Verified boot passes only when the booted state is no weaker than the image expects

Android reports `green` (locked, the manufacturer's key), `yellow` (locked,
a custom key the image enrolled), `orange` (unlocked) or `red`. An image
signed with a custom key expects `yellow`; a development image on an
unlocked device expects `orange`. A state the shell cannot parse is
`Unread`.

```quint
type BootState = Green | Yellow | Orange | Red
pure def bootStrength(boot: BootState): int = match boot { | Green => 3 | Yellow => 2 | Orange => 1 | Red => 0 }
pure def verifiedBootNotWeaker(booted: BootState, expectedBoot: BootState): bool = bootStrength(booted) >= bootStrength(expectedBoot)
pure def lawUnlockedNeverMeetsALockedImage(expectedBoot: BootState): bool = (expectedBoot == Green or expectedBoot == Yellow) implies not(verifiedBootNotWeaker(Orange, expectedBoot))
pure def lawRedNeverMeetsAnyExpectation(expectedBoot: BootState): bool = expectedBoot != Red implies not(verifiedBootNotWeaker(Red, expectedBoot))
```

### First-boot grants are exactly the descriptor's defaults and each stays revocable

The shell reads the launcher's runtime permissions for the user: the ones
granted, and the ones whose flags fix them (`SYSTEM_FIXED` or
`POLICY_FIXED`). The granted set equals the descriptor's
`defaultPermissions`, and none of them is fixed, so the person can still
revoke each.

```quint
pure def firstBootGrantsHold(expected: Set[str], granted: Set[str], fixed: Set[str]): bool =
  expected.subseteq(granted) and granted.subseteq(expected) and fixed.intersect(expected).size() == 0
pure val expectedValues = Set(Set("CAMERA"), Set("CAMERA", "RECORD_AUDIO"))
pure val grantedValues = Set(Set(), Set("CAMERA"), Set("CAMERA", "RECORD_AUDIO"), Set("CAMERA", "READ_SMS"))
pure val fixedValues = Set(Set(), Set("CAMERA"))
pure def lawExtraGrantFails(expected: Set[str], fixed: Set[str]): bool = not(firstBootGrantsHold(expected, expected.union(Set("READ_SMS")), fixed)) or expected.contains("READ_SMS")
pure def lawFixedGrantFails(expected: Set[str], granted: Set[str]): bool = expected.size() > 0 implies not(firstBootGrantsHold(expected, granted, expected))
```

### The image feature is present at the version the image surfaces need

```quint
pure def imageFeatureHolds(feature: Pv::FeatureReading): bool = Pv::imageSurfaceAvailable(Pv::SystemInstall, feature)
```

### The listener holds every reviewed privileged grant, none forbidden, and runs in its own SELinux domain

The listener is the system package `<launcher>.sense`. Its reviewed
privileged grants and its forbidden permissions are the listener staging
rules'; the shell reads the granted ones from `dumpsys package` and the
domain of its running process from `ps -Z`.

```quint
pure val listenerDomain = "eliza_sense_app"
pure def listenerGrantsHold(privileged: Set[str], forbidden: Set[str], granted: Set[str]): bool =
  privileged.subseteq(granted) and granted.intersect(forbidden).size() == 0
pure def listenerDomainHolds(domain: str): bool = domain == listenerDomain
pure val privilegedValues = Set(Set("CAPTURE_AUDIO_HOTWORD"))
pure val forbiddenValues = Set(Set("INTERNET"))
pure def lawForbiddenGrantFails(privileged: Set[str], forbidden: Set[str], granted: Set[str]): bool =
  granted.intersect(forbidden).size() > 0 implies not(listenerGrantsHold(privileged, forbidden, granted))
```

### Lock-screen capture belongs to the system secure camera, and the launcher handles neither secure action

For the user, the system camera is enabled, both secure capture actions
resolve to its secure activity, and no activity of the launcher handles
either.

```quint
pure def secureCameraHolds(cameraEnabled: bool, systemHandlesBoth: bool, launcherHandlesEither: bool): bool =
  cameraEnabled and systemHandlesBoth and not(launcherHandlesEither)
pure def lawLauncherHandlerFailsTheCamera(cameraEnabled: bool, systemHandlesBoth: bool): bool = not(secureCameraHolds(cameraEnabled, systemHandlesBoth, true))
```

### Alarms stay with the system clock: it is enabled and handles every alarm intent

The set, show, snooze and dismiss alarm intents each resolve to an
activity of the enabled system clock package.

```quint
pure val alarmIntentCount = 4
pure def clockHolds(clockEnabled: bool, handled: int): bool = clockEnabled and handled == alarmIntentCount
pure val handledValues = Set(0, 3, 4)
pure def lawEveryAlarmIntentIsNeeded(clockEnabled: bool, handled: int): bool = handled < alarmIntentCount implies not(clockHolds(clockEnabled, handled))
```
