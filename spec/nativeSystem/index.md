# Native system capabilities

The package's Android system role calls use the [OS system](../os/android/system.md), [launcher](../os/android/home.md), [reset](../os/android/reset.md), and [invocation](../os/voice/invocation.md) owners. The web locale fallback offers no native role, launch, or reset effect.

## Story: Follow the device's authority for system controls

> As the device owner, I want system settings, role requests and launcher handoffs to reflect the availability and authority of the current host.

### Native availability and approval belong to the requested system surface

A role request or an opened system settings page reports a handoff. A membership observation or completed reset must come from its owner through a separate read.

```quint
type SystemOperation = CheckSystemRole | RequestSystemRole | LaunchNativeApp | ReadDeviceFacts |
  OpenSystemSettings | ChangeSystemSettings | ShowNotificationShade | ResetApplicationData
type SystemAuthority = { registered: bool, foregroundOwner: bool, capabilityAllowed: bool, confirmedReset: bool }
pure def mayUseSystemSurface(authority: SystemAuthority, op: SystemOperation): bool =
  authority.registered and authority.capabilityAllowed and
  (op == CheckSystemRole or op == ReadDeviceFacts or authority.foregroundOwner) and
  (op != ResetApplicationData or authority.confirmedReset)
pure def isSystemHandoff(op: SystemOperation): bool =
  op == RequestSystemRole or op == LaunchNativeApp or op == OpenSystemSettings or op == ShowNotificationShade
pure def lawResetNeedsOwnerConfirmation(authority: SystemAuthority): bool =
  mayUseSystemSurface(authority, ResetApplicationData) implies authority.foregroundOwner and authority.confirmedReset
pure val authorityValues = Set(
  { registered: true, foregroundOwner: true, capabilityAllowed: true, confirmedReset: true },
  { registered: true, foregroundOwner: true, capabilityAllowed: true, confirmedReset: false },
  { registered: true, foregroundOwner: false, capabilityAllowed: true, confirmedReset: true })
```
