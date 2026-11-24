# Android network cost

What the network policy bridge (`ElizaNetworkPolicy`) may claim about the
cost of the device's active network. A large download, such as a voice
model update, asks it whether the link is metered before it starts.
Admission is the [bridge](./bridge.md)'s `admitCall`: a host that does not
register the plugin, or turns it off, answers nothing, and every reply is
then unknown. The bridge only reads: it never changes a network, a data
saver setting or a download. Online state and the Wi-Fi name are
[Wi-Fi](./wifi.md)'s.

## Story: Download a large file only on a link I do not pay for

> As an owner, I want a large download to start by itself only on a link
> Android says is not metered, and to be asked first on any other, so that
> an update never spends my mobile data without my say.

### A metered hint is Android's own flag for the active network, and anything Android did not answer is unknown

The hint is `NET_CAPABILITY_NOT_METERED` of the active network, inverted:
cellular is not taken for metered, nor Wi-Fi for unmetered, since a hotspot
or a corporate plan can be either. No connectivity service, no active
network, unreadable capabilities, a missing network-state grant, a bridge
that is not registered or turned off, and a reply that does not parse are
all unknown, which a download takes as "ask first".

```quint
import bridge.* from "./bridge"
type MeteredHint = LinkMetered | LinkUnmetered | LinkCostUnknown
type CostRead = { answered: bool, activeNetwork: bool, capabilitiesRead: bool, notMetered: bool }
pure val costCall: BridgeCall = { need: Anytime, needsGrant: false, needsFeature: false }
pure def meteredHint(presence: PluginPresence, facts: HostFacts, androidCost: CostRead): MeteredHint =
  if (admitCall(presence, costCall, facts) != CallAdmitted) LinkCostUnknown
  else if (not(androidCost.answered and androidCost.activeNetwork and androidCost.capabilitiesRead)) LinkCostUnknown
  else if (androidCost.notMetered) LinkUnmetered
  else LinkMetered
pure def costAnswered(androidCost: CostRead): bool = androidCost.answered and androidCost.activeNetwork and androidCost.capabilitiesRead
pure val androidCostValues = Set(
  { answered: true, activeNetwork: true, capabilitiesRead: true, notMetered: true },
  { answered: true, activeNetwork: true, capabilitiesRead: true, notMetered: false },
  { answered: true, activeNetwork: true, capabilitiesRead: false, notMetered: true },
  { answered: true, activeNetwork: false, capabilitiesRead: true, notMetered: true },
  { answered: false, activeNetwork: true, capabilitiesRead: true, notMetered: true }
)
pure def lawMeteredHintIsWhatAndroidAnswered(presence: PluginPresence, facts: HostFacts, androidCost: CostRead): bool = {
  val hint = meteredHint(presence, facts, androidCost)
  val admitted = presence == PluginRegistered and costAnswered(androidCost)
  (hint == LinkUnmetered iff (admitted and androidCost.notMetered))
    and (hint == LinkMetered iff (admitted and not(androidCost.notMetered)))
}
```

### A download is authorized only on a validated Internet link that Android says is not metered

The agent's own download admission reads one capability snapshot of the
active network. No active network is no connection. A link without
Internet, or one Android has not validated, such as a sign-in portal, is
of unknown type and cost, whatever its transport. Otherwise the type is
the transport Android reports, Wi-Fi first, then Ethernet, then cellular, and unknown for any other,
and the cost is the metered hint of that same snapshot. A missing grant
is unknown.

```quint
type LinkType = LinkWifi | LinkEthernet | LinkCellular | LinkNone | LinkTypeUnknown
type LinkSnapshot = { granted: bool, activeNetwork: bool, capabilitiesRead: bool, internet: bool, validated: bool, wifi: bool, ethernet: bool, cellular: bool, notMetered: bool }
type LinkState = { linkType: LinkType, cost: MeteredHint }
pure def linkState(snapshot: LinkSnapshot): LinkState =
  if (not(snapshot.granted)) { linkType: LinkTypeUnknown, cost: LinkCostUnknown }
  else if (not(snapshot.activeNetwork)) { linkType: LinkNone, cost: LinkCostUnknown }
  else if (not(snapshot.capabilitiesRead and snapshot.internet and snapshot.validated)) { linkType: LinkTypeUnknown, cost: LinkCostUnknown }
  else {
    linkType: if (snapshot.wifi) LinkWifi else if (snapshot.ethernet) LinkEthernet else if (snapshot.cellular) LinkCellular else LinkTypeUnknown,
    cost: if (snapshot.notMetered) LinkUnmetered else LinkMetered
  }
pure def downloadAuthorized(link: LinkState): bool = link.cost == LinkUnmetered
pure val snapshotValues = Set(
  { granted: true, activeNetwork: true, capabilitiesRead: true, internet: true, validated: true, wifi: true, ethernet: false, cellular: false, notMetered: true },
  { granted: true, activeNetwork: true, capabilitiesRead: true, internet: true, validated: true, wifi: true, ethernet: false, cellular: false, notMetered: false },
  { granted: true, activeNetwork: true, capabilitiesRead: true, internet: true, validated: true, wifi: false, ethernet: false, cellular: true, notMetered: true },
  { granted: true, activeNetwork: true, capabilitiesRead: true, internet: true, validated: false, wifi: true, ethernet: false, cellular: false, notMetered: true },
  { granted: true, activeNetwork: false, capabilitiesRead: true, internet: true, validated: true, wifi: true, ethernet: false, cellular: false, notMetered: true },
  { granted: false, activeNetwork: true, capabilitiesRead: true, internet: true, validated: true, wifi: true, ethernet: false, cellular: false, notMetered: true }
)
pure def lawDownloadNeedsAValidatedUnmeteredLink(snapshot: LinkSnapshot): bool =
  downloadAuthorized(linkState(snapshot)) iff
    (snapshot.granted and snapshot.activeNetwork and snapshot.capabilitiesRead and snapshot.internet and snapshot.validated and snapshot.notMetered)
pure def lawTransportNeverDecidesCost(snapshot: LinkSnapshot): bool =
  linkState({ ...snapshot, wifi: not(snapshot.wifi), cellular: not(snapshot.cellular) }).cost == linkState(snapshot).cost
```
