# Wi-Fi discovery, approved join and connectivity

A consumer's native bridge contract imports the `WiFiPlugin` type from
`plugins/plugin-native-wifi/src/definitions.ts`; its device Wi-Fi overlay
extends Eliza's `WiFiPlugin.kt` with the device-management build gate. The
consumer's host descriptor stages the plugin, state reader, connection
option builder and approved join tracker ([bridge composition](./bridge.md)).
A consumer that does not register this plugin hands Wi-Fi off to
[Android Settings](./system.md). Location grants are the
[location](./location.md) spec's.

## Story: Find networks from a device that can manage Wi-Fi

> As the person, I want to see the networks around a device that manages
> its own Wi-Fi, so that I can pick one to join.

### Build ownership and Android permission evidence control discovery

Only a build that manages the device's Wi-Fi runs discovery; standalone and
web builds skip it and may still use the system settings route. The adapter
caches the capability probe and needs Android, the registered `ElizaWiFi`
plugin and an explicit `approvedJoin: true`, which the native probe derives
from the build gate, Android API 30 or newer and `WifiManager`. The native gate returns
`DISABLED` for every bridge method on standalone, including permission
probes. The scan needs radio enabled, permission to read Wi-Fi, precise
location permission and the system Location switch on. The location
permission request groups precise and approximate permissions and is only
offered on a promptable alias. Mere approximate permission cannot qualify
the native read. A permission or Location refusal uses the system route.

```quint
import location.* from "./location"
type WifiBuild = { android: bool, managesDevice: bool, bridge: bool, sdk: int, manager: bool }
type ScanFacts = { radio: bool, wifiReadPermission: bool, preciseLocation: bool, locationOn: bool }
type ScanRead = ScanRows | ScanNoNetworks | ScanMalformed | ScanLocationRefused | ScanReadFailed
type ScanResult = NetworkOffers | NoNetworkOffers | UnsupportedScan | FailedScan
pure def managesWifi(build: WifiBuild): bool = build.android and build.managesDevice
pure def wifiApiEnabled(build: WifiBuild): bool = managesWifi(build) and build.bridge
pure def approvedJoinSupported(build: WifiBuild): bool = wifiApiEnabled(build) and build.sdk >= 30 and build.manager
pure def internetPanelSupported(build: WifiBuild): bool = wifiApiEnabled(build) and build.sdk >= 29
pure def mayPromptLocation(build: WifiBuild, permission: LocationGrant): bool = approvedJoinSupported(build) and permission == LocationPromptable
pure def scanResult(build: WifiBuild, scanFacts: ScanFacts, observed: ScanRead): ScanResult =
  if (not(approvedJoinSupported(build)) or not(scanFacts.radio and scanFacts.preciseLocation and scanFacts.locationOn) or observed == ScanLocationRefused) UnsupportedScan
  else if (not(scanFacts.wifiReadPermission) or observed == ScanMalformed or observed == ScanReadFailed) FailedScan
  else if (observed == ScanRows) NetworkOffers else NoNetworkOffers
pure val buildValues = Set(
  { android: true, managesDevice: true, bridge: true, sdk: 30, manager: true },
  { android: true, managesDevice: true, bridge: true, sdk: 29, manager: true },
  { android: true, managesDevice: false, bridge: true, sdk: 36, manager: true },
  { android: true, managesDevice: true, bridge: false, sdk: 36, manager: true },
  { android: false, managesDevice: false, bridge: false, sdk: 0, manager: false }
)
pure val scanFactsValues = Set(
  { radio: true, wifiReadPermission: true, preciseLocation: true, locationOn: true },
  { radio: true, wifiReadPermission: true, preciseLocation: false, locationOn: true },
  { radio: true, wifiReadPermission: false, preciseLocation: true, locationOn: true },
  { radio: true, wifiReadPermission: true, preciseLocation: true, locationOn: false },
  { radio: false, wifiReadPermission: true, preciseLocation: true, locationOn: true }
)
pure def lawOrdinaryAppSkipsDeviceWifi(build: WifiBuild): bool = not(managesWifi(build)) implies not(approvedJoinSupported(build) or internetPanelSupported(build))
pure def lawRefusedLocationDoesNotPrompt(build: WifiBuild): bool = not(mayPromptLocation(build, LocationDenied))
pure def lawUnqualifiedScanCannotOffer(build: WifiBuild, scanFacts: ScanFacts, observed: ScanRead): bool =
  (not(approvedJoinSupported(build)) or not(scanFacts.radio and scanFacts.preciseLocation and scanFacts.locationOn)) implies scanResult(build, scanFacts, observed) == UnsupportedScan
```

### The plugin registers as ElizaWiFi and its library declares exactly the Wi-Fi, network and location permissions

The JavaScript bridge and the native plugin are both registered under the
name `ElizaWiFi`. A host that subclasses the plugin to limit it declares
its own registration with that same name and the location permission
alias, because Android plugin registration is not inherited; its gate is
checked by every method, the permission methods included. The library
manifest declares reading and changing Wi-Fi state, reading and changing
network state, and precise and approximate location, which a scan asks
for together; it declares no other permission.

```quint
type WifiLibraryPermission = AccessWifiState | ChangeWifiState | AccessNetworkState | ChangeNetworkState | FineLocation | CoarseLocation | OtherPermission
pure val wifiRegistrationName = "ElizaWiFi"
pure val wifiLibraryPermissions: Set[WifiLibraryPermission] =
  Set(AccessWifiState, ChangeWifiState, AccessNetworkState, ChangeNetworkState, FineLocation, CoarseLocation)
pure def wifiRegistrationAdmitted(registeredName: str, locationAlias: bool): bool = registeredName == wifiRegistrationName and locationAlias
pure val registeredNameValues = Set("ElizaWiFi", "DeviceWifi", "")
pure def lawOnlyTheSharedNameRegisters(registeredName: str, locationAlias: bool): bool =
  wifiRegistrationAdmitted(registeredName, locationAlias) implies registeredName == "ElizaWiFi"
pure def lawLibraryDeclaresNetworkChange(declared: WifiLibraryPermission): bool =
  wifiLibraryPermissions.contains(ChangeNetworkState) and (declared == OtherPermission implies not(wifiLibraryPermissions.contains(declared)))
```

### A discovery result offers the strongest usable row per disclosed network name

The Android callback handles a started scan, its deadline or a throttled
scan once. Native defaults are a 30,000 ms cache window and a scan wait of
10,000 ms, bounded to 30,000 ms. Callers request `maxAge: 0` and
`joinable: true`. Throttling can still cause Android to use cached rows.
Native sorts strongest first, drops hidden names, filters when asked for
joinable networks, de-duplicates by exact SSID and then applies any
positive limit. WPA2/WPA3 transition is `wpa2`. Enhanced Open transition
is `open`. Enhanced Open without the transition is `owe`. EAP and WEP
are available through the system route. The caller rechecks recognized
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

## Story: Save the chosen network and confirm where the device connected

> As the person, I want the network I chose saved through Android's own
> approval and to be told only what Android confirmed about the connection,
> so that a wrong password or sign-in page is never reported as online.

### One owner-selected request hands its password to Android and awaits the user's approval

`addNetworkWithApproval` validates the trimmed SSID at one to 32 UTF-8
bytes. Explicit open and OWE take no password. WPA2 accepts eight to 63
printable ASCII characters, WPA3 one to 63. With security omitted, presence
of a password selects WPA2 and absence selects open. The caller uses the
last offered security for the chosen name and omits the password for
keyless offers. The secret goes from the masked field straight to the
bridge, which removes it from the saved callback payload before
`ACTION_WIFI_ADD_NETWORKS` and keeps only whether there was one; it never
enters state, replay, transcript or persistence. Retiring the request does
not cancel a system approval already opened. An attempt is one native
call; duplicate or foreign replies cannot reopen its terminal outcome.

The native activity result can decline, reject, or start a Wi-Fi watch.
`RESULT_OK` with a missing per-network code, success code or already
exists code starts that watch. Another returned code rejects the call.
Missing activity or old API use the unsupported system fallback. Native
API 29 and newer `connectToNetwork` submits a suggestion, whose accepted
request cannot stand for a connected result, so joins use the approved
path.

```quint
type JoinOptions = { ssid: str, ssidBytes: int, security: WifiSecurity, securitySupplied: bool, passwordBytes: int, printable: bool }
type DialogAnswer = DialogAccepted | DialogAlreadyExists | DialogNoCode | DialogDeclined | DialogRejected | DialogUnavailable
type JoinPhase = JoinIdle | JoinApproval | JoinWatching | JoinConfirming | JoinFinished
type JoinResult = NoJoinResult | Joined | Captive | WrongPassword | JoinFailed | JoinUnsupported
type JoinEvidence = NoEvidence | ExactValidated | ExactCaptive
type WifiJoin = { phase: JoinPhase, ssid: str, secured: bool, unidentified: bool, evidence: JoinEvidence, result: JoinResult, connected: bool, ownsRequest: bool, answeredRequest: bool }
pure val initial: WifiJoin = { phase: JoinIdle, ssid: "", secured: false, unidentified: false, evidence: NoEvidence, result: NoJoinResult, connected: false, ownsRequest: false, answeredRequest: false }
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
  { ...initial, phase: JoinApproval, ssid: options.ssid, secured: options.passwordBytes > 0, ownsRequest: true }
pure def finishJoin(result: JoinResult, evidence: JoinEvidence, s: WifiJoin): WifiJoin =
  { ...s, phase: JoinFinished, result: result, evidence: evidence, connected: result == Joined, answeredRequest: s.ownsRequest }
pure def canReadDialog(s: WifiJoin): bool = s.phase == JoinApproval
pure def readDialog(s: WifiJoin, dialog: DialogAnswer): WifiJoin =
  if (dialog == DialogAccepted or dialog == DialogAlreadyExists or dialog == DialogNoCode) { ...s, phase: JoinWatching }
  else finishJoin(if (dialog == DialogUnavailable) JoinUnsupported else JoinFailed, NoEvidence, s)
pure def canRetireJoinRequest(s: WifiJoin): bool = s.ownsRequest
pure def retireJoinRequest(s: WifiJoin): WifiJoin = { ...s, ownsRequest: false, answeredRequest: false }
pure val optionsValues = Set(
  { ssid: "home", ssidBytes: 4, security: WifiWpa2, securitySupplied: true, passwordBytes: 12, printable: true },
  { ssid: "home", ssidBytes: 4, security: WifiOpen, securitySupplied: true, passwordBytes: 0, printable: true },
  { ssid: "home", ssidBytes: 4, security: WifiOpen, securitySupplied: true, passwordBytes: 8, printable: true },
  { ssid: "home", ssidBytes: 4, security: WifiWpa3, securitySupplied: true, passwordBytes: 1, printable: true },
  { ssid: "long", ssidBytes: 33, security: WifiWpa2, securitySupplied: true, passwordBytes: 8, printable: true }
)
pure def lawKeylessCannotCarryPassword(options: JoinOptions): bool =
  (admittedOptions(options) and keyless(effectiveSecurity(options))) implies options.passwordBytes == 0
pure def alwaysInFlightJoinHasTarget(s: WifiJoin): bool = (s.phase != JoinIdle) implies s.ssid != ""
pure def alwaysReplyOwnsRequest(s: WifiJoin): bool = s.answeredRequest implies s.ownsRequest and s.phase == JoinFinished
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
network was reported, otherwise `notConnected`, which is a failure. For `unverified` it does one fresh status read and requires
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
pure def lawOtherNetworkCannotConfirm(requested: str, sample: WifiObservation): bool =
  (requested != sample.ssid or sample.ssid == "") implies exactWifiEvidence(requested, sample) == NoEvidence
pure def alwaysConnectedHasValidatedIdentity(s: WifiJoin): bool = s.connected == (s.result == Joined) and (s.result == Joined) == (s.evidence == ExactValidated)
pure def alwaysCaptiveHasMatchingEvidence(s: WifiJoin): bool = (s.result == Captive) == (s.evidence == ExactCaptive)
pure def alwaysWrongPasswordNeedsSecuredAttempt(s: WifiJoin): bool = (s.result == WrongPassword) implies s.secured
pure def stepSettledJoinDoesNotReopen(before: WifiJoin, after: WifiJoin): bool =
  (before.phase == JoinFinished) implies after.phase == JoinFinished and after.result == before.result and after.evidence == before.evidence
pure def sometimesWifiJoined(s: WifiJoin): bool = s.result == Joined and s.answeredRequest
pure def sometimesWifiCaptive(s: WifiJoin): bool = s.result == Captive
pure def sometimesUnidentifiedNeedsFreshStatus(s: WifiJoin): bool = s.phase == JoinConfirming
pure def sometimesRetiredJoinStillUpdatesDevice(s: WifiJoin): bool = s.connected and not(s.answeredRequest)
```

### A join result answers only the request that started it

A result answers the request that started it, matched by its own request
identity. After that request is retired or replaced, a successful join still
marks the device online but answers nothing, and any other stale result is
ignored. A captive result routes to Android's Internet panel, or general
network settings without it. Returning from Android settings reads status
again rather than inferring success from opening the panel. A report with
explicit `validated: false` shows checking, and a captive portal shows
sign-in.

```quint
type JoinResultUse = AnswerRequest | UpdateOnlineOnly | IgnoreJoinResult
type ConnectivityDisplay = WifiOffline | WifiChecking | WifiSignIn | WifiOnline
pure def useJoinResult(requestMatches: bool, result: JoinResult): JoinResultUse =
  if (requestMatches) AnswerRequest else if (result == Joined) UpdateOnlineOnly else IgnoreJoinResult
pure def wifiDisplay(online: bool, validationReported: bool, validated: bool, captive: bool): ConnectivityDisplay =
  if (not(online)) WifiOffline else if (captive) WifiSignIn else if (validationReported and not(validated)) WifiChecking else WifiOnline
pure def lawStaleResultsNeverAnswerJoin(result: JoinResult): bool = useJoinResult(false, result) != AnswerRequest
pure def lawCaptiveStatusNeverShowsOnline(online: bool, validationReported: bool, validated: bool): bool = wifiDisplay(online, validationReported, validated, true) != WifiOnline
```

## Story: See whether the device is online, checking or behind a sign-in page

> As the person, I want the Internet status to say online only when
> Android confirmed the active network reaches the Internet, and to say
> when a sign-in page is in the way.

### A connectivity read reports Android's own validation and captive-portal flags for the active network

`getConnectivity` reads the active network once. It reports online when
the network offers Internet access, validated only when Android confirmed
it reaches the Internet, and the captive-portal flag when a sign-in page
is in the way. The name is the active Wi-Fi network's SSID, or none when
the network is not Wi-Fi or Android hides the name. A read never joins,
saves or changes a network, and an unnamed result can never confirm a
requested join.

```quint
type ConnectivityRead = { offersInternet: bool, androidValidated: bool, androidCaptive: bool, wifi: bool, nameDisclosed: bool, name: str }
pure def connectivityObservation(read: ConnectivityRead): WifiObservation =
  { ssid: if (read.wifi and read.nameDisclosed) read.name else "", online: read.offersInternet,
    validated: read.offersInternet and read.androidValidated, captive: read.offersInternet and read.androidCaptive }
pure val readValues = Set(
  { offersInternet: true, androidValidated: true, androidCaptive: false, wifi: true, nameDisclosed: true, name: "home" },
  { offersInternet: true, androidValidated: false, androidCaptive: true, wifi: true, nameDisclosed: false, name: "home" },
  { offersInternet: true, androidValidated: true, androidCaptive: false, wifi: false, nameDisclosed: true, name: "cell" },
  { offersInternet: false, androidValidated: true, androidCaptive: false, wifi: true, nameDisclosed: true, name: "home" }
)
pure def lawValidatedNeedsAndroidConfirmation(read: ConnectivityRead): bool =
  connectivityObservation(read).validated implies read.offersInternet and read.androidValidated
pure def lawHiddenNameNeverConfirmsJoin(read: ConnectivityRead, requested: str): bool =
  not(read.wifi and read.nameDisclosed) implies exactWifiEvidence(requested, connectivityObservation(read)) == NoEvidence
pure def lawCaptiveReadNeverShowsOnline(read: ConnectivityRead): bool =
  read.offersInternet and read.androidCaptive implies wifiDisplay(true, true, connectivityObservation(read).validated, connectivityObservation(read).captive) != WifiOnline
```

## Story: Disconnect from or forget a network through Android

> As the person, I want Disconnect and Forget to do what Android lets the
> app do and to tell me only what Android confirmed, so that a network is
> never shown as gone when it is not.

### Disconnect reports only Android's answer, and forgetting a network is Android Settings' job

Disconnect needs the bridge's gate, the change-Wi-Fi-state permission and
the Wi-Fi service; it answers success only when Android accepted the
disconnect, and says nothing about connectivity, which a fresh status
read reports. The bridge never removes a saved network itself: Forget
opens Android's Wi-Fi settings, which are unavailable when no settings
page starts, and what was forgotten is read back from status.

```quint
type DisconnectAnswer = DisconnectRefused | DisconnectUnavailable | DisconnectAccepted | DisconnectNotAccepted
type ForgetOutcome = ForgetOpenedSettings | ForgetUnavailable | ForgetRemovedNetwork
pure def disconnectAnswer(gateAdmits: bool, changePermission: bool, managerPresent: bool, androidAccepted: bool): DisconnectAnswer =
  if (not(gateAdmits and changePermission)) DisconnectRefused
  else if (not(managerPresent)) DisconnectUnavailable
  else if (androidAccepted) DisconnectAccepted else DisconnectNotAccepted
pure def forgetOutcome(settingsStarted: bool): ForgetOutcome = if (settingsStarted) ForgetOpenedSettings else ForgetUnavailable
pure def lawDisconnectSuccessIsAndroidsAnswer(gateAdmits: bool, changePermission: bool, managerPresent: bool, androidAccepted: bool): bool =
  disconnectAnswer(gateAdmits, changePermission, managerPresent, androidAccepted) == DisconnectAccepted implies
    gateAdmits and changePermission and managerPresent and androidAccepted
pure def lawForgetNeverClaimsRemoval(settingsStarted: bool): bool = forgetOutcome(settingsStarted) != ForgetRemovedNetwork
```
