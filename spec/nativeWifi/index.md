# Native Wi-Fi

[OS Wi-Fi](../os/android/wifi.md) owns scans, approval, link verification and credentials. The overlay presents network controls through that API and uses the connection reports without owning a second connection state.

## Story: See whether I joined the network I chose

> As the owner, I want the Wi-Fi screen to distinguish approval, verified connection, captive portal and inability to confirm.

### A confirmed join names the same network and Android's observed link

The native Internet panel is a handoff, and a passphrase remains in the device's own prompt. Qualified links report a portal separately. A read of another network provides no outcome for the request.

```quint
type WifiRead = WifiNoAnswer | WifiLink({ networkId: str, validated: bool, portal: bool }) | WifiDisconnected
type WifiJoinReport = WifiApprovalPending | WifiJoined | WifiNeedsPortal | WifiJoinUnverified | WifiNotJoined
pure def wifiJoinReport(requestedNetworkId: str, awaitingApproval: bool, observed: WifiRead): WifiJoinReport =
  if (awaitingApproval) WifiApprovalPending else match observed {
    | WifiNoAnswer => WifiJoinUnverified
    | WifiDisconnected => WifiNotJoined
    | WifiLink(link) =>
      if (requestedNetworkId == "" or requestedNetworkId != link.networkId) WifiJoinUnverified else
      if (link.portal) WifiNeedsPortal else if (link.validated) WifiJoined else WifiJoinUnverified
  }
pure def lawOtherNetworkDoesNotConfirm(requestedNetworkId: str, observedNetworkId: str, validated: bool, portal: bool): bool =
  requestedNetworkId != observedNetworkId implies
  wifiJoinReport(requestedNetworkId, false, WifiLink({ networkId: observedNetworkId, validated: validated, portal: portal })) == WifiJoinUnverified
```
