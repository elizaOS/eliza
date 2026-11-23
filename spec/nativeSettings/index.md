# Native settings

The Device Settings overlay consumes [system roles and settings](../os/android/system.md). Its own contract normalizes the owner's chosen controls and distinguishes a settings screen handoff from a provider write.

## Story: Adjust the device settings from the local overlay

> As the owner, I want brightness and volume to remain inside the supported range and protected changes to use Android's own settings surface.

### A setting write is admitted by its current capability and valid level

```quint
type SettingsControl = BrightnessControl | MediaVolumeControl | RingVolumeControl | AlarmVolumeControl
type ControlLimit = { maxLevel: int, canWrite: bool }
type SettingsOutcome = SettingApplied | SettingsOpened | SettingDenied | SettingUnconfirmed
pure def settingsLevelAllowed(limit: ControlLimit, chosenLevel: int): bool =
  limit.canWrite and limit.maxLevel > 0 and chosenLevel >= 0 and chosenLevel <= limit.maxLevel
pure def settingsOutcome(limit: ControlLimit, chosenLevel: int, readbackMatches: bool, openedNativeSettings: bool): SettingsOutcome =
  if (openedNativeSettings) SettingsOpened else
  if (not(settingsLevelAllowed(limit, chosenLevel))) SettingDenied else
  if (readbackMatches) SettingApplied else SettingUnconfirmed
pure def lawSettingsHandoffIsNotApplied(limit: ControlLimit, chosenLevel: int, readbackMatches: bool): bool =
  settingsOutcome(limit, chosenLevel, readbackMatches, true) == SettingsOpened
pure val limitValues = Set(
  { maxLevel: 255, canWrite: true },
  { maxLevel: 15, canWrite: true },
  { maxLevel: 255, canWrite: false },
  { maxLevel: 0, canWrite: false })
pure val chosenLevelValues = Set(-1, 0, 15, 255, 256)
```
