# Grace Wi-Fi discovery and approved join

Grace's `apps/app/contracts/native-bridge.ts` imports the exact `WiFiPlugin`
type from `plugins/plugin-native-wifi/src/definitions.ts`. Its `DeviceWifi`
overlay extends Eliza `WiFiPlugin.kt` with the launcher build gate.
`apps/app/native/android/host.json` stages the plugin, state reader,
connection option builder and approved join tracker from the Grace pin.
`apps/app/src/services/wifi-native.ts` projects those native results into
`WifiService`. The renderer consumes them from onboarding and Internet
Settings. AlphaPhone uses its [system settings handoff](./alpha/system.md)
for Wi-Fi and does not register this plugin at its pin.

## Story: Find networks from a tablet that can manage Wi-Fi

### Build ownership and Android permission evidence control discovery

Grace's launcher and AOSP builds run the Wi-Fi setup steps. Standalone and
web skip them. A launcher can still need the system settings route.
The in-app adapter caches the capability probe and needs Android, the
registered `DeviceWifi` plugin and an explicit `approvedJoin: true`.
The pinned native probe supplies that bit from the launcher gate, Android
API 30 or newer and `WifiManager` availability. The native gate returns
`DISABLED` for every bridge method on standalone, including permission
probes. The scan needs radio enabled, permission to read Wi-Fi, precise
location permission and the system Location switch on. The location
permission request groups precise and approximate permissions and is only
offered on a promptable alias. Mere approximate permission cannot qualify
the native read. A permission or Location refusal uses the system route.

```quint
type LocationAccess = LocationGranted | LocationPromptable | LocationDenied
type WifiBuild = { android: bool, launcher: bool, bridge: bool, sdk: int, manager: bool }
type ScanFacts = { radio: bool, wifiReadPermission: bool, preciseLocation: bool, locationOn: bool }
type ScanRead = ScanRows | ScanNoNetworks | ScanMalformed | ScanLocationRefused | ScanReadFailed
type ScanResult = NetworkOffers | NoNetworkOffers | UnsupportedScan | FailedScan
pure def managesWifi(build: WifiBuild): bool = build.android and build.launcher
pure def wifiApiEnabled(build: WifiBuild): bool = managesWifi(build) and build.bridge
pure def approvedJoinSupported(build: WifiBuild): bool = wifiApiEnabled(build) and build.sdk >= 30 and build.manager
pure def internetPanelSupported(build: WifiBuild): bool = wifiApiEnabled(build) and build.sdk >= 29
pure def mayPromptLocation(build: WifiBuild, permission: LocationAccess): bool = approvedJoinSupported(build) and permission == LocationPromptable
pure def scanResult(build: WifiBuild, facts: ScanFacts, observed: ScanRead): ScanResult =
  if (not(approvedJoinSupported(build)) or not(facts.radio and facts.preciseLocation and facts.locationOn) or observed == ScanLocationRefused) UnsupportedScan
  else if (not(facts.wifiReadPermission) or observed == ScanMalformed or observed == ScanReadFailed) FailedScan
  else if (observed == ScanRows) NetworkOffers else NoNetworkOffers
pure val buildValues = Set(
  { android: true, launcher: true, bridge: true, sdk: 30, manager: true },
  { android: true, launcher: true, bridge: true, sdk: 29, manager: true },
  { android: true, launcher: false, bridge: true, sdk: 36, manager: true },
  { android: true, launcher: true, bridge: false, sdk: 36, manager: true },
  { android: false, launcher: false, bridge: false, sdk: 0, manager: false }
)
pure val factsValues = Set(
  { radio: true, wifiReadPermission: true, preciseLocation: true, locationOn: true },
  { radio: true, wifiReadPermission: true, preciseLocation: false, locationOn: true },
  { radio: true, wifiReadPermission: false, preciseLocation: true, locationOn: true },
  { radio: true, wifiReadPermission: true, preciseLocation: true, locationOn: false },
  { radio: false, wifiReadPermission: true, preciseLocation: true, locationOn: true }
)
pure def lawOrdinaryAppSkipsDeviceWifi(build: WifiBuild): bool = not(managesWifi(build)) implies not(approvedJoinSupported(build) or internetPanelSupported(build))
pure def lawRefusedLocationDoesNotPrompt(build: WifiBuild): bool = not(mayPromptLocation(build, LocationDenied))
pure def lawUnqualifiedScanCannotOffer(build: WifiBuild, facts: ScanFacts, observed: ScanRead): bool =
  (not(approvedJoinSupported(build)) or not(facts.radio and facts.preciseLocation and facts.locationOn)) implies scanResult(build, facts, observed) == UnsupportedScan
```

### A discovery result offers the strongest usable row per disclosed network name

The Android callback handles a started scan, its deadline or a throttled
scan once. Native defaults are a 30,000 ms cache window and a scan wait of
10,000 ms, bounded to 30,000 ms. Grace requests `maxAge: 0` and
`joinable: true`. Throttling can still cause Android to use cached rows.
Native sorts strongest first, drops hidden names, filters when asked for
joinable networks, de-duplicates by exact SSID and then applies any
positive limit. WPA2/WPA3 transition is `wpa2`. Enhanced Open transition
is `open`. Enhanced Open without the transition is `owe`. EAP and WEP
are available through the system route. Grace rechecks recognized
security and nonblank SSID, remembers the first admitted security per
name from the latest returned array and publishes only network names and
the optional password-free subset. A valid empty array has a distinct
outcome from refused permission or malformed results. Sorting and
delivering the one decoded row per name are native and renderer port facts.

```quint
type WifiSecurity = WifiOpen | WifiOwe | WifiWpa2 | WifiWpa3 | WifiEap | WifiWep | WifiUnrecognized
type ScanRow = { name: str, disclosed: bool, nonblank: bool, security: WifiSecurity }
pure def keyless(security: WifiSecurity): bool = security == WifiOpen or security == WifiOwe
pure def joinable(security: WifiSecurity): bool = keyless(security) or security == WifiWpa2 or security == WifiWpa3
pure def mayOffer(row: ScanRow): bool = row.name != "" and row.disclosed and row.nonblank and joinable(row.security)
pure def noPasswordOffer(row: ScanRow): bool = mayOffer(row) and keyless(row.security)
pure val rowValues = Set(
  { name: "home", disclosed: true, nonblank: true, security: WifiWpa2 },
  { name: "guest", disclosed: true, nonblank: true, security: WifiOwe },
  { name: "office", disclosed: true, nonblank: true, security: WifiEap },
  { name: "", disclosed: false, nonblank: false, security: WifiOpen },
  { name: "  ", disclosed: true, nonblank: false, security: WifiOpen }
)
pure def lawOfferedNetworkIsVisibleAndJoinable(row: ScanRow): bool = mayOffer(row) implies row.disclosed and row.nonblank and joinable(row.security)
pure def lawOpenOfferBelongsToTheList(row: ScanRow): bool = noPasswordOffer(row) implies mayOffer(row) and keyless(row.security)
```

## Story: Save the chosen network and confirm where the tablet connected

### One owner-selected request hands its password to Android and awaits the user's approval

`addNetworkWithApproval` validates the trimmed SSID at one to 32 UTF-8
bytes. Explicit open and OWE take no password. WPA2 accepts eight to 63
printable ASCII characters, WPA3 one to 63. With security omitted, presence
of a password selects WPA2 and absence selects open. Grace uses the last
offered security for the chosen name where available and omits the
password entirely for keyless offers. The active masked field hands the
secret directly to the bridge on Send. The native bridge removes it from
the saved callback payload before `ACTION_WIFI_ADD_NETWORKS`; a boolean
records whether there was a password. Android receives the suggestion as
a typed OS handoff. The secret never enters state, replay, transcript or
setup persistence. Discarding a renderer turn does not cancel a system
approval already opened. An attempt models one native call; duplicate or
foreign replies cannot reopen its terminal outcome.
Discovered by the proof: a new call starts with no prior result, evidence,
unidentified observation or turn acknowledgement.

The native activity result can decline, reject, or start a Wi-Fi watch.
`RESULT_OK` with a missing per-network code, success code or already
exists code starts that watch. Another returned code rejects the call.
Missing activity or old API use the unsupported system fallback. Native
API 29 and newer `connectToNetwork` submits a suggestion, whose accepted
request cannot stand for a connected result. Grace uses the separate
approved path. Below API 29 the direct method uses legacy configuration.

```quint
type JoinOptions = { ssid: str, ssidBytes: int, security: WifiSecurity, securitySupplied: bool, passwordBytes: int, printable: bool }
type DialogAnswer = DialogAccepted | DialogAlreadyExists | DialogNoCode | DialogDeclined | DialogRejected | DialogUnavailable
type JoinPhase = JoinIdle | JoinApproval | JoinWatching | JoinConfirming | JoinFinished
type JoinResult = NoJoinResult | Joined | Captive | WrongPassword | JoinFailed | JoinUnsupported
type JoinEvidence = NoEvidence | ExactValidated | ExactCaptive
type WifiJoin = { phase: JoinPhase, ssid: str, secured: bool, unidentified: bool, evidence: JoinEvidence, result: JoinResult, connected: bool, ownsTurn: bool, answeredTurn: bool }
pure val initial: WifiJoin = { phase: JoinIdle, ssid: "", secured: false, unidentified: false, evidence: NoEvidence, result: NoJoinResult, connected: false, ownsTurn: false, answeredTurn: false }
pure def effectiveSecurity(options: JoinOptions): WifiSecurity =
  if (options.securitySupplied) options.security else if (options.passwordBytes > 0) WifiWpa2 else WifiOpen
pure def admittedOptions(options: JoinOptions): bool = {
  val mode = effectiveSecurity(options)
  options.ssid != "" and options.ssidBytes >= 1 and options.ssidBytes <= 32 and
  (if (keyless(mode)) options.passwordBytes == 0
   else if (mode == WifiWpa2) options.printable and options.passwordBytes >= 8 and options.passwordBytes <= 63
   else mode == WifiWpa3 and options.printable and options.passwordBytes >= 1 and options.passwordBytes <= 63)
}
pure def canRequestJoin(s: WifiJoin, build: WifiBuild, options: JoinOptions): bool =
  s.phase == JoinIdle and approvedJoinSupported(build) and admittedOptions(options)
pure def requestJoin(s: WifiJoin, build: WifiBuild, options: JoinOptions): WifiJoin =
  { ...initial, phase: JoinApproval, ssid: options.ssid, secured: options.passwordBytes > 0, ownsTurn: true }
pure def finishJoin(result: JoinResult, evidence: JoinEvidence, s: WifiJoin): WifiJoin =
  { ...s, phase: JoinFinished, result: result, evidence: evidence, connected: result == Joined, answeredTurn: s.ownsTurn }
pure def canReadDialog(s: WifiJoin): bool = s.phase == JoinApproval
pure def readDialog(s: WifiJoin, dialog: DialogAnswer): WifiJoin =
  if (dialog == DialogAccepted or dialog == DialogAlreadyExists or dialog == DialogNoCode) { ...s, phase: JoinWatching }
  else finishJoin(if (dialog == DialogUnavailable) JoinUnsupported else JoinFailed, NoEvidence, s)
pure def canRetireJoinTurn(s: WifiJoin): bool = s.ownsTurn
pure def retireJoinTurn(s: WifiJoin): WifiJoin = { ...s, ownsTurn: false, answeredTurn: false }
pure val optionsValues = Set(
  { ssid: "home", ssidBytes: 4, security: WifiWpa2, securitySupplied: true, passwordBytes: 12, printable: true },
  { ssid: "home", ssidBytes: 4, security: WifiOpen, securitySupplied: true, passwordBytes: 0, printable: true },
  { ssid: "home", ssidBytes: 4, security: WifiOpen, securitySupplied: true, passwordBytes: 8, printable: true },
  { ssid: "home", ssidBytes: 4, security: WifiWpa3, securitySupplied: true, passwordBytes: 1, printable: true },
  { ssid: "long", ssidBytes: 33, security: WifiWpa2, securitySupplied: true, passwordBytes: 8, printable: true }
)
pure val weight_requestJoin = 10
pure val weight_readDialog = 8
pure def lawKeylessCannotCarryPassword(options: JoinOptions): bool =
  (admittedOptions(options) and keyless(effectiveSecurity(options))) implies options.passwordBytes == 0
pure def alwaysInFlightJoinHasTarget(s: WifiJoin): bool = (s.phase != JoinIdle) implies s.ssid != ""
pure def alwaysReplyOwnsTurn(s: WifiJoin): bool = s.answeredTurn implies s.ownsTurn and s.phase == JoinFinished
```

### Only the requested network's observation confirms the join or sign-in portal

Android API 31 and newer binds the network name to the event's own
capabilities, with location info if disclosed. On older Android that
network has to be the sole Wi-Fi network both before and after reading
the name from `WifiManager.connectionInfo`. The selected SSID must
exactly equal this name. Other networks cannot confirm it. A working Wi-Fi
network whose name is unavailable marks an unidentified observation.
If the matching network is both validated and captive, the native tracker
prefers validated. The authentication broadcast cannot name the network.
It can yield `wrongPassword` only for a secured attempt while waiting.
After 30 seconds, no match yields `unverified` if a working unnamed
network was reported, otherwise `notConnected`. Grace maps `notConnected`
to failed. For `unverified` it does one fresh status read and requires
the same SSID, `online: true` and explicit validation or captive evidence.
Otherwise the outcome is unsupported and passes control to Android
Settings. A resolved or rejected watch has a single result and releases
its native callback, auth receiver, timeout and saved call.

```quint
type WifiObservation = { ssid: str, online: bool, validated: bool, captive: bool }
pure def exactWifiEvidence(requested: str, sample: WifiObservation): JoinEvidence =
  if (requested == "" or sample.ssid != requested or not(sample.online)) NoEvidence
  else if (sample.validated) ExactValidated else if (sample.captive) ExactCaptive else NoEvidence
pure def resultFromEvidence(evidence: JoinEvidence): JoinResult =
  if (evidence == ExactValidated) Joined else if (evidence == ExactCaptive) Captive else JoinUnsupported
pure def canReadWifiNetwork(s: WifiJoin): bool = s.phase == JoinWatching
pure def readWifiNetwork(s: WifiJoin, sample: WifiObservation): WifiJoin = {
  val evidence = exactWifiEvidence(s.ssid, sample)
  if (evidence != NoEvidence) finishJoin(resultFromEvidence(evidence), evidence, s)
  else { ...s, unidentified: s.unidentified or (sample.ssid == "" and sample.online and (sample.validated or sample.captive)) }
}
pure def canObserveAuthFailure(s: WifiJoin): bool = s.phase == JoinWatching and s.secured
pure def observeAuthFailure(s: WifiJoin): WifiJoin = finishJoin(WrongPassword, NoEvidence, s)
pure def canReachWatchDeadline(s: WifiJoin): bool = s.phase == JoinWatching
pure def reachWatchDeadline(s: WifiJoin): WifiJoin =
  if (s.unidentified) { ...s, phase: JoinConfirming } else finishJoin(JoinFailed, NoEvidence, s)
pure def canReadWifiConfirmation(s: WifiJoin): bool = s.phase == JoinConfirming
pure def readWifiConfirmation(s: WifiJoin, sample: WifiObservation): WifiJoin = {
  val evidence = exactWifiEvidence(s.ssid, sample)
  finishJoin(resultFromEvidence(evidence), evidence, s)
}
pure val sampleValues = Set(
  { ssid: "home", online: true, validated: true, captive: false },
  { ssid: "home", online: true, validated: false, captive: true },
  { ssid: "other", online: true, validated: true, captive: false },
  { ssid: "", online: true, validated: true, captive: false },
  { ssid: "home", online: false, validated: true, captive: false },
  { ssid: "home", online: true, validated: false, captive: false }
)
pure val weight_readWifiNetwork = 9
pure val weight_reachWatchDeadline = 4
pure val weight_readWifiConfirmation = 6
pure def lawOtherNetworkCannotConfirm(requested: str, sample: WifiObservation): bool =
  (requested != sample.ssid or sample.ssid == "") implies exactWifiEvidence(requested, sample) == NoEvidence
pure def alwaysConnectedHasValidatedIdentity(s: WifiJoin): bool = s.connected == (s.result == Joined) and (s.result == Joined) == (s.evidence == ExactValidated)
pure def alwaysCaptiveHasMatchingEvidence(s: WifiJoin): bool = (s.result == Captive) == (s.evidence == ExactCaptive)
pure def alwaysWrongPasswordNeedsSecuredAttempt(s: WifiJoin): bool = (s.result == WrongPassword) implies s.secured
pure def stepSettledJoinDoesNotReopen(before: WifiJoin, after: WifiJoin): bool =
  (before.phase == JoinFinished) implies after.phase == JoinFinished and after.result == before.result and after.evidence == before.evidence
pure def sometimesWifiJoined(s: WifiJoin): bool = s.result == Joined and s.answeredTurn
pure def sometimesWifiCaptive(s: WifiJoin): bool = s.result == Captive
pure def sometimesUnidentifiedNeedsFreshStatus(s: WifiJoin): bool = s.phase == JoinConfirming
pure def sometimesRetiredJoinStillUpdatesDevice(s: WifiJoin): bool = s.connected and not(s.answeredTurn)
```

### A stale successful join can update tablet connectivity without answering a newer question

Grace's `shared/verified/setup-turn.ts` matches an operation and turn
token for open-network sends or the uniquely allocated password attempt
for masked-field sends. An unmatched successful join can set the general
online status after Stop or a newer attempt. Other stale results do not
answer the question or update connectivity. A captive result from the
current attempt parks the account step and routes to Android Wi-Fi
settings. That route opens the narrow Android Internet panel if present,
then falls back to general network settings. When the status API is
missing or malformed, Grace uses the browser reachability flag with no
SSID and no validation or captive fields. The legacy renderer grants
that fallback ordinary online display when `online` is true. A native
report with explicit `validated: false` or a captive portal is pending
or captive, and the named join confirmation above always requires
positive native evidence. A tab coming back from Android settings reads
status again. It does not infer success from opening the system panel.

```quint
type TurnResultUse = AnswerTurn | UpdateOnlineOnly | IgnoreJoinResult
type ConnectivityDisplay = WifiOffline | WifiChecking | WifiSignIn | WifiOnline
pure def useJoinResult(turnMatches: bool, result: JoinResult): TurnResultUse =
  if (turnMatches) AnswerTurn else if (result == Joined) UpdateOnlineOnly else IgnoreJoinResult
pure def wifiDisplay(online: bool, validationReported: bool, validated: bool, captive: bool): ConnectivityDisplay =
  if (not(online)) WifiOffline else if (captive) WifiSignIn else if (validationReported and not(validated)) WifiChecking else WifiOnline
pure def lawStaleResultsNeverAnswerJoin(result: JoinResult): bool = useJoinResult(false, result) != AnswerTurn
pure def lawCaptiveStatusNeverShowsOnline(online: bool, validationReported: bool, validated: bool): bool = wifiDisplay(online, validationReported, validated, true) != WifiOnline
```
