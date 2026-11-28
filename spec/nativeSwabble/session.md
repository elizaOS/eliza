# Swabble wake session lifecycle

The Swabble web and native bridge tracks an explicit wake-listening session whose lease rotates whenever recognition starts, switches audio input, or stops.

## Story: Rotate wake leases on start, audio-device switch and stop

> As the owner, I want starting, pausing, switching audio devices and stopping Swabble to rotate or clear the active lease so stale callbacks are always rejected.

### Each wake start or device switch advances the lease generation and stop clears the active lease

A fresh session starts in `WakeIdle` with `leaseEpoch = 0`, `activeLeaseId = ""`, and `deviceId = ""`. `startWake` runs from `WakeIdle` with a non-empty `leaseId` and `deviceId` when `microphoneGranted` and `ownerEnabled` are both true; it enters `WakeListening`, increments `leaseEpoch`, and records `activeLeaseId` and `deviceId`. `pauseWake` moves `WakeListening` to `WakePaused` while keeping the lease. `resumeWake` moves `WakePaused` back to `WakeListening` when `microphoneGranted` and `ownerEnabled` are true. `switchDevice` runs from `WakeListening` or `WakePaused` with a non-empty `nextLeaseId` distinct from `activeLeaseId` and a non-empty `nextDeviceId`; it increments `leaseEpoch` and replaces `activeLeaseId` and `deviceId`. `stopWake` runs from `WakeListening` or `WakePaused`, returns to `WakeIdle`, and clears `activeLeaseId`. Across every state: `leaseEpoch >= 0`, `WakeIdle` has an empty `activeLeaseId`, and `WakeListening` or `WakePaused` has a non-empty `activeLeaseId`, a non-empty `deviceId`, and a positive `leaseEpoch`.

```quint
type WakeSessionPhase = WakeIdle | WakeListening | WakePaused
type WakeSessionState = { phase: WakeSessionPhase, leaseEpoch: int, activeLeaseId: str, deviceId: str }
pure val initial: WakeSessionState = { phase: WakeIdle, leaseEpoch: 0, activeLeaseId: "", deviceId: "" }
pure val leaseIdValues = Set("lease-1", "lease-2", "")
pure val nextLeaseIdValues = Set("lease-2", "lease-3", "")
pure val deviceIdValues = Set("mic-default", "mic-usb", "")
pure val nextDeviceIdValues = Set("mic-usb", "mic-bt", "")
pure def canStartWake(s: WakeSessionState, leaseId: str, deviceId: str, microphoneGranted: bool, ownerEnabled: bool): bool =
  s.phase == WakeIdle and leaseId != "" and deviceId != "" and microphoneGranted and ownerEnabled
pure def startWake(s: WakeSessionState, leaseId: str, deviceId: str, microphoneGranted: bool, ownerEnabled: bool): WakeSessionState =
  { phase: WakeListening, leaseEpoch: s.leaseEpoch + 1, activeLeaseId: leaseId, deviceId: deviceId }
pure def canPauseWake(s: WakeSessionState): bool = s.phase == WakeListening
pure def pauseWake(s: WakeSessionState): WakeSessionState = { ...s, phase: WakePaused }
pure def canResumeWake(s: WakeSessionState, microphoneGranted: bool, ownerEnabled: bool): bool =
  s.phase == WakePaused and microphoneGranted and ownerEnabled
pure def resumeWake(s: WakeSessionState, microphoneGranted: bool, ownerEnabled: bool): WakeSessionState =
  { ...s, phase: WakeListening }
pure def canSwitchDevice(s: WakeSessionState, nextLeaseId: str, nextDeviceId: str): bool =
  (s.phase == WakeListening or s.phase == WakePaused) and nextLeaseId != "" and nextLeaseId != s.activeLeaseId and nextDeviceId != ""
pure def switchDevice(s: WakeSessionState, nextLeaseId: str, nextDeviceId: str): WakeSessionState =
  { ...s, leaseEpoch: s.leaseEpoch + 1, activeLeaseId: nextLeaseId, deviceId: nextDeviceId }
pure def canStopWake(s: WakeSessionState): bool = s.phase == WakeListening or s.phase == WakePaused
pure def stopWake(s: WakeSessionState): WakeSessionState = { ...s, phase: WakeIdle, activeLeaseId: "" }
pure def alwaysWakeSessionConsistent(s: WakeSessionState): bool =
  s.leaseEpoch >= 0 and
  (s.phase == WakeIdle implies s.activeLeaseId == "") and
  (s.phase != WakeIdle implies s.activeLeaseId != "" and s.deviceId != "" and s.leaseEpoch > 0)
pure def sometimesWakeSwitchesDevice(s: WakeSessionState): bool = s.phase == WakeListening and s.leaseEpoch >= 2
pure val eval_witness_sometimesWakeSwitchesDevice = (("startWake", "lease-1", "mic-default", true, true), "pauseWake", ("resumeWake", true, true), ("switchDevice", "lease-2", "mic-usb"))
```
