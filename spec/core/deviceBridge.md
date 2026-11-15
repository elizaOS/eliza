# Device bridge

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. The source is `packages/core/src/mobile-device-bridge-service.ts`. Core declares the bridge generically: a host plugin registers the bridge service through the ordinary service registry, paired devices connect to it declaring what they can do, and the runtime relays calls such as on-device inference to them. The registry and its lifecycle are [services](./services.md) and [service registry](./serviceRegistry.md); what a particular device implements belongs to the package that hosts it.

## Story: Generic device bridge declaration

> As a host author, I want the runtime to send a device only calls for
> capabilities that device declared, and every call still waiting on a device
> to fail when that device disconnects, so that no caller waits for ever on
> a device that left or is asked for something it cannot do.

### A call is sent only to a connected device that declared its capability

A device connects with the capabilities it declares; a second connection under the same identity is refused. A call names a device and a capability, and the bridge sends it only when that device is connected and declared that capability.

```quint
type CallPhase = CallPending | CallDone | CallFailed
type BridgeDevice = { id: str, capabilities: List[str] }
type BridgeCall = { id: int, device: str, capability: str, phase: CallPhase }
type DeviceBridge = { devices: List[BridgeDevice], primary: str, calls: List[BridgeCall] }
pure val initial: DeviceBridge = { devices: List(), primary: "", calls: List() }
pure val deviceValues = Set({ id: "device-1", capabilities: List("text", "embedding") }, { id: "device-2", capabilities: List("text") })
pure val deviceIdValues = Set("device-1", "device-2")
pure val capabilityValues = Set("text", "embedding")
pure val idValues = Set(1, 2, 3)
pure def connected(s: DeviceBridge, deviceId: str): bool = s.devices.some(d => d.id == deviceId)
pure def declares(s: DeviceBridge, deviceId: str, capability: str): bool = s.devices.some(d => d.id == deviceId and d.capabilities.includes(capability))
pure def canConnectDevice(s: DeviceBridge, device: BridgeDevice): bool = device.id != "" and not(connected(s, device.id))
pure def connectDevice(s: DeviceBridge, device: BridgeDevice): DeviceBridge =
  { ...s, devices: s.devices.append(device), primary: if (s.primary == "") device.id else s.primary }
pure def canInvoke(s: DeviceBridge, id: int, deviceId: str, capability: str): bool =
  id > 0 and not(s.calls.some(c => c.id == id)) and declares(s, deviceId, capability)
pure def invoke(s: DeviceBridge, id: int, deviceId: str, capability: str): DeviceBridge =
  { ...s, calls: s.calls.append({ id: id, device: deviceId, capability: capability, phase: CallPending }) }
pure def alwaysPendingCallsTargetADeclaredCapability(s: DeviceBridge): bool =
  s.calls.every(c => c.phase != CallPending or declares(s, c.device, c.capability))
pure def alwaysDeviceIdentitiesUnique(s: DeviceBridge): bool = s.devices.every(d => d.id != "" and s.devices.select(other => other.id == d.id).length() == 1)
pure def alwaysCallIdentitiesUnique(s: DeviceBridge): bool = s.calls.every(c => c.id > 0 and s.calls.select(other => other.id == c.id).length() == 1)
pure def sometimesCallCompleted(s: DeviceBridge): bool = s.calls.some(c => c.phase == CallDone)
```

### Disconnecting a device fails every call still waiting on it

When a device disconnects, each of its pending calls fails at once, and calls to other devices are untouched. The primary device is always a connected one, or none; when the primary leaves, the earliest remaining device takes its place.

```quint
pure def earliestDevice(devices: List[BridgeDevice]): str = devices.foldl("", (first, d) => if (first == "") d.id else first)
pure def canDisconnectDevice(s: DeviceBridge, deviceId: str): bool = connected(s, deviceId)
pure def disconnectDevice(s: DeviceBridge, deviceId: str): DeviceBridge = {
  val remaining = s.devices.select(d => d.id != deviceId)
  { devices: remaining,
    primary: if (s.primary == deviceId) earliestDevice(remaining) else s.primary,
    calls: s.calls.listMap(c => if (c.device == deviceId and c.phase == CallPending) { ...c, phase: CallFailed } else c) }
}
pure def stepDisconnectFailsPendingCalls(before: DeviceBridge, via: str, after: DeviceBridge): bool =
  before.calls.every(b => b.phase != CallPending or connected(after, b.device) or after.calls.some(a => a.id == b.id and a.phase == CallFailed))
  and (via == "disconnectDevice" implies before.calls.every(b => not(connected(after, b.device)) or after.calls.includes(b)))
pure def stepPrimaryPassesToEarliestDevice(before: DeviceBridge, after: DeviceBridge): bool =
  (before.primary != "" and not(connected(after, before.primary))) implies after.primary == earliestDevice(after.devices)
pure def alwaysPrimaryIsConnected(s: DeviceBridge): bool = (s.primary == "" or connected(s, s.primary)) and (s.devices.length() > 0 implies s.primary != "")
pure def sometimesDisconnectFailedACall(s: DeviceBridge): bool = s.calls.some(c => c.phase == CallFailed and not(connected(s, c.device)))
```

### A call settles once

A pending call completes or fails exactly once; a settled call keeps its outcome.

```quint
pure def canCompleteCall(s: DeviceBridge, id: int, ok: bool): bool = s.calls.some(c => c.id == id and c.phase == CallPending)
pure def completeCall(s: DeviceBridge, id: int, ok: bool): DeviceBridge =
  { ...s, calls: s.calls.listMap(c => if (c.id == id) { ...c, phase: if (ok) CallDone else CallFailed } else c) }
pure def stepSettledCallKeepsItsOutcome(before: DeviceBridge, after: DeviceBridge): bool =
  before.calls.every(b => b.phase == CallPending or after.calls.some(a => a == b))
```
