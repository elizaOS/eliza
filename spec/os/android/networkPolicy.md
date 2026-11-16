# Network policy for large downloads

`plugin-native-network-policy` reports whether the active link is metered
(`getMeteredHint` on Android, from `NET_CAPABILITY_NOT_METERED`, never
inferred from cellular alone). The shared network policy of
`plugin-native-inference/model-catalog/network-policy` classifies the link
and decides, before any network use, whether a large download such as a
model or voice update may start by itself or must ask the person first.
The owner's preferences are the toggles the policy reads; the cellular
toggle is the owner's alone.

## Story: Let large downloads start by themselves only on a link I allowed

> As the owner, I want large downloads to start on their own only on a
> network I allowed, outside quiet hours, and to be asked otherwise.

### The policy decides before the network is used, and an unknown or metered link always asks unless allowed

The link is classified from the platform's report: Wi-Fi and Ethernet are
metered or unmetered by the metered flag, and unknown when the flag is
missing; cellular is cellular; no connection is unknown. Unmetered
Ethernet may start by itself. Unmetered Wi-Fi, metered links and
cellular start by themselves only when the owner allowed that kind of
link, and an unknown link never does. Inside a quiet-hours window
nothing starts by itself. A headless runtime never starts by itself; it
only downloads on an explicit request. When the decision is to ask, the
reason says which dialog to show, and the download waits for the answer.

```quint
type ConnectionType = WifiConnection | EthernetConnection | CellularConnection | NoConnection
type MeteredFlag = MeteredYes | MeteredNo | MeteredUnknown
type NetworkClass = WifiUnmetered | WifiMetered | EthernetUnmetered | EthernetMetered | CellularLink | UnknownLink
type PolicyReason = AutoAllowed | MeteredAsk | CellularAsk | HeadlessExplicitOnly
type PolicyPreferences = { onWifi: bool, onCellular: bool, onMetered: bool }
type PolicyDecision = { networkClass: NetworkClass, allow: bool, reason: PolicyReason }
pure def classifyNetwork(connection: ConnectionType, metered: MeteredFlag): NetworkClass =
  if (connection == CellularConnection) CellularLink
  else if (connection == WifiConnection) (if (metered == MeteredYes) WifiMetered else if (metered == MeteredNo) WifiUnmetered else UnknownLink)
  else if (connection == EthernetConnection) (if (metered == MeteredYes) EthernetMetered else if (metered == MeteredNo) EthernetUnmetered else UnknownLink)
  else UnknownLink
pure def classAllowed(networkClass: NetworkClass, prefs: PolicyPreferences): bool =
  if (networkClass == EthernetUnmetered) true
  else if (networkClass == WifiUnmetered) prefs.onWifi
  else if (networkClass == WifiMetered or networkClass == EthernetMetered) prefs.onMetered
  else if (networkClass == CellularLink) prefs.onCellular
  else false
pure def applyNetworkPolicy(networkClass: NetworkClass, prefs: PolicyPreferences, quietHours: bool, headless: bool): PolicyDecision =
  if (headless) { networkClass: networkClass, allow: false, reason: HeadlessExplicitOnly }
  else if (classAllowed(networkClass, prefs) and not(quietHours)) { networkClass: networkClass, allow: true, reason: AutoAllowed }
  else { networkClass: networkClass, allow: false, reason: if (networkClass == CellularLink) CellularAsk else MeteredAsk }
pure def mayStartDownload(decision: PolicyDecision, ownerConfirmed: bool): bool = decision.allow or (decision.reason != HeadlessExplicitOnly and ownerConfirmed)
pure val defaultPreferences: PolicyPreferences = { onWifi: true, onCellular: false, onMetered: false }
pure val prefsValues = Set(defaultPreferences, { onWifi: true, onCellular: true, onMetered: true }, { onWifi: false, onCellular: false, onMetered: false })
pure def lawUnknownLinkAlwaysAsks(prefs: PolicyPreferences, quietHours: bool, headless: bool): bool =
  not(applyNetworkPolicy(UnknownLink, prefs, quietHours, headless).allow)
pure def lawCellularNeedsOwnerToggle(prefs: PolicyPreferences, quietHours: bool, headless: bool): bool =
  applyNetworkPolicy(CellularLink, prefs, quietHours, headless).allow implies prefs.onCellular
pure def lawQuietHoursNeverAutoStart(networkClass: NetworkClass, prefs: PolicyPreferences, headless: bool): bool =
  not(applyNetworkPolicy(networkClass, prefs, true, headless).allow)
pure def lawHeadlessIsExplicitOnly(networkClass: NetworkClass, prefs: PolicyPreferences, quietHours: bool, ownerConfirmed: bool): bool =
  not(mayStartDownload(applyNetworkPolicy(networkClass, prefs, quietHours, true), ownerConfirmed))
pure def lawMeteredFlagNotCellularDecidesWifi(metered: MeteredFlag): bool =
  classifyNetwork(WifiConnection, metered) != CellularLink
```

### A quiet-hours window holds its start and not its end, and may cross midnight

A window is a start and end minute of the local day. It includes its start
and excludes its end; a window whose end is earlier than its start crosses
midnight, and a window whose start equals its end is empty. Any window
that holds the current minute is quiet hours.

```quint
type QuietWindow = { startMinute: int, endMinute: int }
pure def inQuietWindow(window: QuietWindow, minute: int): bool =
  if (window.startMinute == window.endMinute) false
  else if (window.startMinute < window.endMinute) minute >= window.startMinute and minute < window.endMinute
  else minute >= window.startMinute or minute < window.endMinute
pure def inQuietHours(windows: List[QuietWindow], minute: int): bool = windows.some(w => inQuietWindow(w, minute))
pure val windowValues = Set({ startMinute: 1320, endMinute: 480 }, { startMinute: 60, endMinute: 120 }, { startMinute: 600, endMinute: 600 })
pure val minuteValues = Set(0, 60, 119, 120, 479, 480, 1319, 1320, 1439)
pure val windowsValues = Set(List(), List({ startMinute: 1320, endMinute: 480 }))
pure def lawWindowHoldsStartNotEnd(window: QuietWindow): bool =
  window.startMinute != window.endMinute implies inQuietWindow(window, window.startMinute) and not(inQuietWindow(window, window.endMinute))
pure def lawEmptyWindowIsNeverQuiet(minute: int): bool = not(inQuietWindow({ startMinute: 600, endMinute: 600 }, minute))
pure def lawNoWindowsNoQuietHours(minute: int): bool = not(inQuietHours(List(), minute))
```
