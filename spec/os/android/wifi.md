# Android Wi-Fi

What the Wi-Fi bridge (`ElizaWiFi`) may claim when it lists the networks
around the device, joins the one the owner chose, disconnects, opens
Android's Internet panel and reads connectivity. Admission is the
[bridge](./bridge.md)'s `admitCall`: a build that does not manage its own
Wi-Fi does not register the plugin, and a host that turns the bridge off
counts as not registered, so every method, the permission probes included,
is refused. The Internet panel, device facts and the evidence a join is
settled by are [system](./system.md)'s. The bridge never removes a saved
network: the owner forgets one in Android's Internet panel.

## Story: Find the networks around a device that manages its own Wi-Fi

> As an owner, I want to see the networks around my device, so that I can
> pick one to join.

### A scan reports networks, or none, only when the bridge is registered, precise location is granted and Location is on

The grant is reading Wi-Fi state and precise location, asked together; the
feature is Android's Wi-Fi service. With Location off Android returns no
results, which is not the same as no networks nearby. Results that Android
refuses to hand over (the grant was withdrawn during the scan) ask for the
grant again.

```quint
import bridge.* from "./bridge"
import system.* from "./system"
import receipts as R from "../../core/receipts"
type ScanReply = NetworksOffered | NoNetworksNearby | ScanBridgeUnavailable | ScanNeedsLocationPermission | LocationIsOff
pure val scanCall: BridgeCall = { need: Anytime, needsGrant: true, needsFeature: true }
pure def scanReply(presence: PluginPresence, facts: HostFacts, locationOn: bool, resultsReadable: bool, offeredCount: int): ScanReply = {
  val admission = admitCall(presence, scanCall, facts)
  if (admission == PermissionRequired) ScanNeedsLocationPermission
  else if (admission != CallAdmitted) ScanBridgeUnavailable
  else if (not(locationOn)) LocationIsOff
  else if (not(resultsReadable)) ScanNeedsLocationPermission
  else if (offeredCount > 0) NetworksOffered else NoNetworksNearby
}
pure def lawAnAnsweredScanHadEveryCondition(presence: PluginPresence, facts: HostFacts, locationOn: bool, resultsReadable: bool, offeredCount: int): bool = {
  val reply = scanReply(presence, facts, locationOn, resultsReadable, offeredCount)
  (reply == NetworksOffered or reply == NoNetworksNearby) iff
    (admitCall(presence, scanCall, facts) == CallAdmitted and locationOn and resultsReadable)
}
```

### A scan offers one row per disclosed network name, the strongest usable one

A hidden network has no name and is never offered. Asked for joinable
networks only, the scan leaves out enterprise (EAP) and WEP networks, which
only Android's settings can join. A WPA2/WPA3 transition network is WPA2 and
the open side of an Enhanced Open transition network is open. The shell sorts
the offers strongest first and applies a positive limit.

```quint
type WifiSecurity = WifiOpen | WifiOwe | WifiWpa2 | WifiWpa3 | WifiEap | WifiWep
type ScanRow = { network: str, strength: int, security: WifiSecurity }
pure def keyless(security: WifiSecurity): bool = security == WifiOpen or security == WifiOwe
pure def joinable(security: WifiSecurity): bool = security != WifiEap and security != WifiWep
pure def usableRow(row: ScanRow, joinableOnly: bool): bool = row.network != "" and (joinable(row.security) or not(joinableOnly))
pure def keepStrongest(best: List[ScanRow], row: ScanRow): List[ScanRow] =
  if (best.some(b => b.network == row.network)) best.listMap(b => if (b.network == row.network and row.strength > b.strength) row else b)
  else best.append(row)
pure def offeredRows(rows: List[ScanRow], joinableOnly: bool): List[ScanRow] = rows.select(r => usableRow(r, joinableOnly)).foldl(List(), keepStrongest)
pure val rowsValues = Set(
  List(),
  List({ network: "home", strength: 2, security: WifiWpa2 }, { network: "home", strength: 5, security: WifiWpa3 }),
  List({ network: "office", strength: 4, security: WifiEap }, { network: "", strength: 6, security: WifiOpen }, { network: "cafe", strength: 1, security: WifiOwe }),
  List({ network: "home", strength: 3, security: WifiWpa2 }, { network: "cafe", strength: 3, security: WifiOpen }, { network: "home", strength: 3, security: WifiOpen })
)
pure def lawOffersAreUsableDistinctAndFromTheScan(rows: List[ScanRow], joinableOnly: bool): bool = {
  val offered = offeredRows(rows, joinableOnly)
  offered.every(o => usableRow(o, joinableOnly) and rows.includes(o) and offered.select(p => p.network == o.network).length() == 1)
}
pure def lawEveryUsableNameIsOfferedAtItsStrongest(rows: List[ScanRow], joinableOnly: bool): bool = {
  val offered = offeredRows(rows, joinableOnly)
  rows.every(r => usableRow(r, joinableOnly) implies offered.some(o => o.network == r.network and o.strength >= r.strength))
}
```

## Story: Join the network I chose through Android's approval

> As an owner, I want the network I chose saved through Android's own
> approval, and to be told only what Android confirmed about that network,
> so that a wrong password or a sign-in page is never reported as online.

### A join asks Android to save only a valid request, and its passphrase never enters the join

One request at a time; a new one replaces an answered one. The name is
trimmed and has 1 to 32 UTF-8 bytes. Open and Enhanced Open take no
passphrase, WPA2 takes 8 to 63 printable ASCII characters and WPA3 1 to 63;
with no security named, a passphrase means WPA2 and none means open. The
passphrase goes from the masked field to Android's "Save this network?"
dialog and is removed from the saved bridge call; the join keeps only whether
there was one. The dialog needs Android 11 or later (the call's feature).
Android's answer is saved (success, already saved or no per-network code),
declined (the owner closed the dialog) or not saved (any other code).

```quint
type SecurityAsk = NamedSecurity({ named: WifiSecurity }) | ByPassphrase
type JoinAsk = { network: str, nameBytes: int, securityAsk: SecurityAsk, passphraseLength: int, printable: bool }
type SaveAnswer = SaveAccepted | SaveDeclined | SaveNotDone
type JoinStatus = Connected | CaptivePortal | Declined | Unverified | NotConnected | WrongPassword
type JoinRefusal = JoinUnsupported | JoinInvalid | JoinNotSaved
type JoinPhase = JoinIdle | AwaitingApproval | Watching | JoinAnswered({ status: JoinStatus }) | JoinRefused({ refusal: JoinRefusal })
type WifiJoin = { phase: JoinPhase, network: str, secured: bool, sawWithheld: bool }
pure val initial: WifiJoin = { phase: JoinIdle, network: "", secured: false, sawWithheld: false }
pure val joinCall: BridgeCall = { need: Anytime, needsGrant: false, needsFeature: true }
pure def joinSecurity(joinAsk: JoinAsk): WifiSecurity = {
  val securityAsk = joinAsk.securityAsk
  match securityAsk { | NamedSecurity(x) => x.named | _ => if (joinAsk.passphraseLength > 0) WifiWpa2 else WifiOpen }
}
pure def passphraseFits(security: WifiSecurity, characters: int, printable: bool): bool =
  if (keyless(security)) characters == 0
  else if (security == WifiWpa2) printable and characters >= 8 and characters <= 63
  else if (security == WifiWpa3) printable and characters >= 1 and characters <= 63
  else false
pure def joinAskValid(joinAsk: JoinAsk): bool =
  joinAsk.network != "" and joinAsk.nameBytes >= 1 and joinAsk.nameBytes <= 32 and passphraseFits(joinSecurity(joinAsk), joinAsk.passphraseLength, joinAsk.printable)
pure def waitsOnAndroid(phase: JoinPhase): bool = phase == AwaitingApproval or phase == Watching
pure def canRequestJoin(s: WifiJoin): bool = not(waitsOnAndroid(s.phase))
pure def requestJoin(s: WifiJoin, presence: PluginPresence, facts: HostFacts, joinAsk: JoinAsk): WifiJoin =
  if (admitCall(presence, joinCall, facts) != CallAdmitted) { ...initial, phase: JoinRefused({ refusal: JoinUnsupported }) }
  else if (not(joinAskValid(joinAsk))) { ...initial, phase: JoinRefused({ refusal: JoinInvalid }) }
  else { phase: AwaitingApproval, network: joinAsk.network, secured: joinAsk.passphraseLength > 0, sawWithheld: false }
pure def canAnswerSave(s: WifiJoin): bool = s.phase == AwaitingApproval
pure def answerSave(s: WifiJoin, saveAnswer: SaveAnswer): WifiJoin =
  if (saveAnswer == SaveAccepted) { ...s, phase: Watching }
  else if (saveAnswer == SaveDeclined) { ...s, phase: JoinAnswered({ status: Declined }) }
  else { ...s, phase: JoinRefused({ refusal: JoinNotSaved }) }
pure val joinAskValues = Set(
  { network: "home", nameBytes: 4, securityAsk: NamedSecurity({ named: WifiWpa2 }), passphraseLength: 12, printable: true },
  { network: "home", nameBytes: 4, securityAsk: ByPassphrase, passphraseLength: 0, printable: true },
  { network: "home", nameBytes: 4, securityAsk: NamedSecurity({ named: WifiOpen }), passphraseLength: 8, printable: true },
  { network: "home", nameBytes: 4, securityAsk: NamedSecurity({ named: WifiEap }), passphraseLength: 8, printable: true },
  { network: "cafe", nameBytes: 33, securityAsk: ByPassphrase, passphraseLength: 9, printable: true }
)
pure def lawAValidJoinIsJoinableAndKeylessMeansNoPassphrase(joinAsk: JoinAsk): bool =
  joinAskValid(joinAsk) implies (joinable(joinSecurity(joinAsk)) and (keyless(joinSecurity(joinAsk)) iff joinAsk.passphraseLength == 0))
pure def alwaysAnAskedJoinNamesItsNetwork(s: WifiJoin): bool = {
  val phase = s.phase
  match phase {
    | JoinIdle => s.network == ""
    | JoinRefused(x) => x.refusal == JoinNotSaved implies s.network != ""
    | _ => s.network != ""
  }
}
pure def sometimesDeclined(s: WifiJoin): bool = s.phase == JoinAnswered({ status: Declined })
pure def sometimesRefusedAsInvalid(s: WifiJoin): bool = s.phase == JoinRefused({ refusal: JoinInvalid })
pure def sometimesRefusedAsUnsupported(s: WifiJoin): bool = s.phase == JoinRefused({ refusal: JoinUnsupported })
pure def sometimesNotSaved(s: WifiJoin): bool = s.phase == JoinRefused({ refusal: JoinNotSaved })
```

### Only a report of the requested network itself confirms the join or a sign-in portal

After Android saved the network the bridge watches Wi-Fi reports that are
validated or behind a captive portal; a report that is both counts as
validated. Each report carries the name of that network itself (from its own
capabilities on Android 12 and later, otherwise only while it is the sole
Wi-Fi network), or no name when Android withholds it. A different name, such
as the network the device was already on, is ignored. A working network with
a withheld name never confirms the join.

```quint
type NetworkReport = { reportedName: str, validated: bool, captive: bool }
pure def joinEvidence(requested: str, seen: NetworkReport): WifiJoinEvidence =
  if (not(seen.validated or seen.captive)) WifiNotObserved
  else if (seen.reportedName == "") WithheldWifiValidated
  else if (requested == "" or seen.reportedName != requested) OtherWifi
  else if (seen.validated) NamedWifiValidated else NamedWifiPortal
pure def confirmsJoin(evidence: WifiJoinEvidence): bool = approvedWifiJoinConnected(true, evidence) or approvedWifiJoinNeedsPortal(true, evidence)
pure def canObserveNetwork(s: WifiJoin): bool = s.phase == Watching
pure def observeNetwork(s: WifiJoin, seen: NetworkReport): WifiJoin = {
  val evidence = joinEvidence(s.network, seen)
  if (approvedWifiJoinConnected(true, evidence)) { ...s, phase: JoinAnswered({ status: Connected }) }
  else if (approvedWifiJoinNeedsPortal(true, evidence)) { ...s, phase: JoinAnswered({ status: CaptivePortal }) }
  else { ...s, sawWithheld: s.sawWithheld or evidence == WithheldWifiValidated }
}
pure val seenValues = Set(
  { reportedName: "home", validated: true, captive: false }, { reportedName: "home", validated: false, captive: true },
  { reportedName: "home", validated: false, captive: false }, { reportedName: "cafe", validated: true, captive: false },
  { reportedName: "", validated: true, captive: false }
)
pure def lawOnlyTheRequestedNameConfirms(requested: str, seen: NetworkReport): bool =
  confirmsJoin(joinEvidence(requested, seen)) implies (requested != "" and seen.reportedName == requested and (seen.validated or seen.captive))
pure def confirmed(phase: JoinPhase): bool = phase == JoinAnswered({ status: Connected }) or phase == JoinAnswered({ status: CaptivePortal })
pure def stepOnlyANetworkReportConfirms(before: WifiJoin, via: str, after: WifiJoin): bool =
  (confirmed(after.phase) and not(confirmed(before.phase))) implies via == "observeNetwork"
pure def sometimesConnected(s: WifiJoin): bool = s.phase == JoinAnswered({ status: Connected })
pure def sometimesCaptivePortal(s: WifiJoin): bool = s.phase == JoinAnswered({ status: CaptivePortal })
```

### Without a confirmation in 30 seconds the join is unverified or not connected, and a wrong password needs a passphrase

At the deadline the join is `Unverified` when a working network with a
withheld name was reported, so it may be the requested one, and
`NotConnected` otherwise. Android's authentication failure names no network,
so it answers `WrongPassword` only for a join that carried a passphrase and is
ignored otherwise; not every Android build sends it. An answer is final: only
a new request starts another join.

```quint
pure def canReachDeadline(s: WifiJoin): bool = s.phase == Watching
pure def reachDeadline(s: WifiJoin): WifiJoin = { ...s, phase: JoinAnswered({ status: if (s.sawWithheld) Unverified else NotConnected }) }
pure def canObserveAuthFailure(s: WifiJoin): bool = s.phase == Watching
pure def observeAuthFailure(s: WifiJoin): WifiJoin = if (s.secured) { ...s, phase: JoinAnswered({ status: WrongPassword }) } else s
pure def alwaysTheDeadlineReportsWhatWasSeen(s: WifiJoin): bool =
  (s.phase == JoinAnswered({ status: Unverified }) implies s.sawWithheld) and (s.phase == JoinAnswered({ status: NotConnected }) implies not(s.sawWithheld))
pure def alwaysWrongPasswordNeedsAPassphrase(s: WifiJoin): bool = s.phase == JoinAnswered({ status: WrongPassword }) implies s.secured
pure def stepAnAnswerIsFinal(before: WifiJoin, via: str, after: WifiJoin): bool =
  not(waitsOnAndroid(before.phase) or before.phase == JoinIdle or via == "requestJoin") implies after == before
pure def sometimesUnverified(s: WifiJoin): bool = s.phase == JoinAnswered({ status: Unverified })
pure def sometimesNotConnected(s: WifiJoin): bool = s.phase == JoinAnswered({ status: NotConnected })
pure def sometimesWrongPassword(s: WifiJoin): bool = s.phase == JoinAnswered({ status: WrongPassword })
```

## Story: Disconnect, or go to Android's Internet panel

> As an owner, I want Disconnect and the Internet panel to tell me only that
> Android took the request, so that a network is never shown as gone, joined
> or forgotten when Android did not report it.

### Disconnect and the Internet panel report only that Android took the request

Disconnect needs the change-Wi-Fi-state grant and the Wi-Fi service and is
accepted only when Android accepted it; whether the device went offline is
the next connectivity read's to say. The Internet panel needs Android 10 or
later and opens over the app; it is a handoff, so `Opened` never commits a
receipt, and the app reads connectivity again when the owner returns.

```quint
type DisconnectReply = DisconnectAccepted | DisconnectNotAccepted | DisconnectRefused
pure val disconnectCall: BridgeCall = { need: Anytime, needsGrant: true, needsFeature: true }
pure val internetPanelCall: BridgeCall = { need: Anytime, needsGrant: false, needsFeature: true }
pure def disconnectReply(presence: PluginPresence, facts: HostFacts, androidAccepted: bool): DisconnectReply =
  if (admitCall(presence, disconnectCall, facts) != CallAdmitted) DisconnectRefused else if (androidAccepted) DisconnectAccepted else DisconnectNotAccepted
pure def internetPanel(presence: PluginPresence, facts: HostFacts, panelStarted: bool): HandoffOutcome =
  if (admitCall(presence, internetPanelCall, facts) == CallAdmitted and panelStarted) Opened else Refused
pure def lawDisconnectAndPanelNeedAdmissionAndAndroid(presence: PluginPresence, facts: HostFacts, androidTook: bool): bool =
  (disconnectReply(presence, facts, androidTook) == DisconnectAccepted implies (androidTook and facts.granted and facts.featurePresent and presence == PluginRegistered))
    and (internetPanel(presence, facts, androidTook) == Opened implies (androidTook and facts.featurePresent and presence == PluginRegistered))
    and not(R::committedReceipt(receiptOfHandoff(internetPanel(presence, facts, androidTook))))
```

## Story: See whether the device is online or behind a sign-in page

> As an owner, I want the Internet status to say online only when Android
> says the active network offers Internet, and to say when a sign-in page is
> in the way.

### A connectivity read reports Android's own flags for the active network, and an unanswered read is unknown

Validated and captive portal count only on a network that offers Internet.
The name is the active Wi-Fi network's, or none when the network is not
Wi-Fi or Android withholds it, so a read with no name never confirms a join.
A read never joins, saves or changes a network.

```quint
type ConnectivityRead = { answered: bool, offersInternet: bool, androidValidated: bool, androidCaptive: bool, onWifi: bool, nameDisclosed: bool, activeName: str }
type ConnectivityReport = ConnectivityUnknown | ConnectivityKnown({ online: bool, validated: bool, captivePortal: bool, wifiName: str })
pure def connectivityReport(androidRead: ConnectivityRead): ConnectivityReport =
  if (not(androidRead.answered)) ConnectivityUnknown
  else ConnectivityKnown({ online: androidRead.offersInternet, validated: androidRead.offersInternet and androidRead.androidValidated,
    captivePortal: androidRead.offersInternet and androidRead.androidCaptive, wifiName: if (androidRead.onWifi and androidRead.nameDisclosed) androidRead.activeName else "" })
pure def onlineFact(report: ConnectivityReport): SwitchFact = match report { | ConnectivityKnown(x) => if (x.online) FactOn else FactOff | _ => FactUnknown }
pure def reportedNetwork(report: ConnectivityReport): NetworkReport = match report {
  | ConnectivityKnown(x) => { reportedName: x.wifiName, validated: x.validated, captive: x.captivePortal }
  | _ => { reportedName: "", validated: false, captive: false }
}
pure val androidReadValues = Set(
  { answered: true, offersInternet: true, androidValidated: true, androidCaptive: false, onWifi: true, nameDisclosed: true, activeName: "home" },
  { answered: true, offersInternet: true, androidValidated: false, androidCaptive: true, onWifi: true, nameDisclosed: false, activeName: "home" },
  { answered: true, offersInternet: true, androidValidated: true, androidCaptive: false, onWifi: false, nameDisclosed: true, activeName: "home" },
  { answered: true, offersInternet: false, androidValidated: true, androidCaptive: true, onWifi: true, nameDisclosed: true, activeName: "home" },
  { answered: false, offersInternet: true, androidValidated: true, androidCaptive: false, onWifi: true, nameDisclosed: true, activeName: "home" }
)
pure def lawConnectivityIsWhatAndroidAnswered(androidRead: ConnectivityRead, requested: str): bool = {
  val seen = reportedNetwork(connectivityReport(androidRead))
  (onlineFact(connectivityReport(androidRead)) == FactOff iff (androidRead.answered and not(androidRead.offersInternet)))
    and (seen.validated implies (androidRead.answered and androidRead.offersInternet and androidRead.androidValidated))
    and (seen.captive implies (androidRead.answered and androidRead.offersInternet and androidRead.androidCaptive))
    and (not(androidRead.onWifi and androidRead.nameDisclosed) implies not(confirmsJoin(joinEvidence(requested, seen))))
}
```
