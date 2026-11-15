# Product composition

A consumer composes its product on one device profile the os package
admits: a physical phone kept on its stock factory vendor partition, or a
virtual Cuttlefish target. The [source lock](./sourceLock.md) pins the
source the profile builds from, the [launcher staging](./launcher.md)
places the consumer's home app, and the
[image capabilities](./capabilities.md) declare what the image stages.
Composition is staging output: only a boot of the built image shows that
the device honors it.

## Story: Compose a product on a supported device profile

> As a consumer, I want to compose my product on a device profile the os
> package supports, so that the image keeps the system clock and secure
> camera every device needs and my launcher never shows over the lock
> screen when I say it must not.

### A product names one admitted device profile and the source profile pinned for it

A physical profile builds from its pinned source profile, and its
platform must declare the same board API level as the stock vendor; a
virtual target builds from its own source profile. A profile the os
package does not admit, or a source profile other than the one pinned for
the device, refuses composition.

```quint
type DeviceKind = PhysicalDevice | VirtualDevice | UnknownDevice
type Composition = {
  kind: DeviceKind, sourceProfileMatches: bool, vendorApiMatches: bool,
  refuseLockScreen: bool, launcherOverKeyguard: bool, launcherHandlesSecureCapture: bool,
  clockIncluded: bool, secureCameraVerified: bool
}
type CompositionDecision = Composed | UnknownProfile | SourceProfileMismatch | VendorApiMismatch | LockScreenSurface | MissingClock | MissingSecureCamera
pure def profileDecision(c: Composition): CompositionDecision =
  if (c.kind == UnknownDevice) UnknownProfile
  else if (not(c.sourceProfileMatches)) SourceProfileMismatch
  else if (c.kind == PhysicalDevice and not(c.vendorApiMatches)) VendorApiMismatch
  else Composed
pure val composedPhone: Composition = {
  kind: PhysicalDevice, sourceProfileMatches: true, vendorApiMatches: true,
  refuseLockScreen: true, launcherOverKeyguard: false, launcherHandlesSecureCapture: false,
  clockIncluded: true, secureCameraVerified: true
}
pure val cValues = Set(composedPhone, { ...composedPhone, kind: VirtualDevice, vendorApiMatches: false },
  { ...composedPhone, kind: UnknownDevice }, { ...composedPhone, sourceProfileMatches: false },
  { ...composedPhone, vendorApiMatches: false }, { ...composedPhone, launcherOverKeyguard: true },
  { ...composedPhone, refuseLockScreen: false, launcherOverKeyguard: true }, { ...composedPhone, clockIncluded: false },
  { ...composedPhone, secureCameraVerified: false })
pure def lawPhysicalProfileKeepsTheVendorApi(c: Composition): bool =
  (profileDecision(c) == Composed and c.kind == PhysicalDevice) implies c.sourceProfileMatches and c.vendorApiMatches
pure def lawUnknownProfileNeverComposes(c: Composition): bool =
  c.kind == UnknownDevice implies profileDecision(c) == UnknownProfile
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
  not(c.refuseLockScreen) or not(c.launcherOverKeyguard or c.launcherHandlesSecureCapture)
pure def lawRefusedLockScreenKeepsLauncherOff(c: Composition): bool =
  (c.refuseLockScreen and lockScreenAdmitted(c)) implies not(c.launcherOverKeyguard) and not(c.launcherHandlesSecureCapture)
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
pure def lawComposedImageKeepsClockAndCamera(c: Composition): bool =
  composition(c) == Composed implies c.clockIncluded and c.secureCameraVerified and lockScreenAdmitted(c)
pure def lawClockRequirementIsIdempotent(clockLines: int): bool =
  requireClock(clockLines) >= 1 and requireClock(requireClock(clockLines)) == requireClock(clockLines)
```
