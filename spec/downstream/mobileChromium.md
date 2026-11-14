# Grace Chromium binding and trust lifecycle

Grace's `LocalRuntimeService.java` starts and closes the shared
`ChromiumBrowserConnection` from its pinned
`plugins/plugin-native-browser-surface/android/src/main/java/ai/eliza/plugins/browsersurface`.
`OwnedBrowser.java` uses the same producer package and certificate
identity check for guide selection. Google sign-in additionally
requires Custom Tabs support. Grace's pin uses a service-lifetime
binding. The later Alpha vendor includes `ChromiumBindingDemand.qnt`
for per-hold binding demand. Alpha's active `AlphaBrowserPlugin`
inherits the native tab host, so that later optional binding owner
does not set the Grace rules.

## Story: Keep the trusted browser available while the resident runtime serves

### Android binds and warms only the expected package and signer

Unsupported or untrusted bind evidence leaves the connection
unavailable. A refused bind, null binding or binding death schedules
retry with delay doubling from one second to a 30-second maximum.
A security denial leaves no retry. A normal service disconnect
retains Android's binding for reconnect. A connected callback
rechecks package and certificate. A mismatched callback closes the
owner. A trusted warmup result resets retry delay even if warmup
was not accepted. Warmup never opens an activity, debugging port
or URL.

```quint
type BindResult = BindAccepted | BindRefused | BindDenied | BindUntrusted
type BrowserBinding = { bound: bool, connected: bool, closed: bool, retryPending: bool, retryDelay: int, warmed: bool }
pure val initial: BrowserBinding = {bound: false, connected: false, closed: false, retryPending: false, retryDelay: 1000, warmed: false}
pure def increaseDelay(millis: int): int = if (millis >= 15000) 30000 else millis * 2
pure def canTryBinding(b: BrowserBinding): bool = not(b.bound) and not(b.closed)
pure def tryBinding(b: BrowserBinding, bindResult: BindResult): BrowserBinding =
  if (bindResult == BindAccepted) {...b, bound: true, retryPending: false}
  else if (bindResult == BindRefused) {...b, retryPending: true, retryDelay: increaseDelay(b.retryDelay)}
  else {...b, retryPending: false}
pure def canConnected(b: BrowserBinding): bool = b.bound and not(b.closed)
pure def connected(b: BrowserBinding, identityMatches: bool, acceptedWarmup: bool): BrowserBinding =
  if (identityMatches) {...b, connected: true, retryDelay: 1000, warmed: acceptedWarmup}
  else {...b, bound: false, connected: false, closed: true, retryPending: false, warmed: false}
pure def canDisconnected(b: BrowserBinding): bool = b.bound and not(b.closed)
pure def disconnected(b: BrowserBinding): BrowserBinding = {...b, connected: false, warmed: false}
pure def canLostBinding(b: BrowserBinding): bool = b.bound and not(b.closed)
pure def lostBinding(b: BrowserBinding): BrowserBinding =
  {...b, bound: false, connected: false, warmed: false, retryPending: true, retryDelay: increaseDelay(b.retryDelay)}
pure def canCloseBinding(b: BrowserBinding): bool = not(b.closed)
pure def closeBinding(b: BrowserBinding): BrowserBinding =
  {...b, closed: true, bound: false, connected: false, warmed: false, retryPending: false}
pure def alwaysBrowserClosedReleases(b: BrowserBinding): bool =
  b.closed implies not(b.bound) and not(b.connected) and not(b.retryPending) and not(b.warmed)
pure def alwaysBrowserReadinessHasBinding(b: BrowserBinding): bool =
  (b.connected implies b.bound and not(b.closed)) and (b.warmed implies b.connected)
pure def alwaysRetryDelayBounded(b: BrowserBinding): bool = b.retryDelay >= 1000 and b.retryDelay <= 30000
pure def stepClosedBindingStaysClosed(before: BrowserBinding, after: BrowserBinding): bool = before.closed implies after.closed
pure def sometimesTrustedBrowserWarmed(b: BrowserBinding): bool = b.warmed
pure def sometimesBindRetryScheduled(b: BrowserBinding): bool = b.retryPending and b.retryDelay > 1000
```
