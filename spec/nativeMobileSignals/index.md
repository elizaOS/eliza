# Native mobile signals

This bridge exposes platform snapshots and subscriptions for wake, lock, power, protected data, Screen Time and optional health observations. Platform permissions and scheduling stay in the native adapters.

## Story: Observe only the mobile signals I have authorized

> As the owner, I want the runtime to stop processing retired subscriptions and never treat permission absence as a valid sample.

### A signal is published only by the current monitor and for a permitted source

Lifecycle and battery signals require the device grant. Health and Screen Time each require their own grant; protected data must be available for Health payloads. Last observation timestamps are provider values and stay distinct from the monitor generation.

```quint
type MobileSignal = DeviceWake | DeviceLock | DeviceBattery | ScreenTimeSignal | HealthSignal
type SignalGrants = { deviceAllowed: bool, screenTimeAllowed: bool, healthAllowed: bool, protectedDataAvailable: bool }
type MobileMonitor = { running: bool, generation: int }
pure val initial: MobileMonitor = { running: false, generation: 0 }
pure def canStartMonitoring(s: MobileMonitor, supported: bool): bool = not(s.running) and supported
pure def startMonitoring(s: MobileMonitor, supported: bool): MobileMonitor =
  { running: true, generation: s.generation + 1 }
pure def canStopMonitoring(s: MobileMonitor): bool = s.running
pure def stopMonitoring(s: MobileMonitor): MobileMonitor = { ...s, running: false }
pure def mayObserveSignal(s: MobileMonitor, generation: int, grants: SignalGrants, signal: MobileSignal): bool =
  s.running and generation == s.generation and
  (if (signal == HealthSignal) grants.healthAllowed and grants.protectedDataAvailable
   else if (signal == ScreenTimeSignal) grants.screenTimeAllowed
   else grants.deviceAllowed)
pure def lawRetiredMonitorCannotPublish(s: MobileMonitor, generation: int, grants: SignalGrants, signal: MobileSignal): bool =
  generation != s.generation implies not(mayObserveSignal(s, generation, grants, signal))
pure def sometimesMobileMonitorRuns(s: MobileMonitor): bool = s.running
pure val sValues = Set({ running: true, generation: 1 }, { running: true, generation: 2 }, { running: false, generation: 2 })
pure val generationValues = Set(0, 1, 2)
pure val grantsValues = Set(
  { deviceAllowed: true, screenTimeAllowed: true, healthAllowed: true, protectedDataAvailable: true },
  { deviceAllowed: true, screenTimeAllowed: false, healthAllowed: true, protectedDataAvailable: false })
```
