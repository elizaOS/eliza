# Account-selection bridge slots

The source is `packages/core/src/account-pool-bridge.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. Core exposes two
`globalThis`/`Symbol.for` slots so independently loaded module copies
resolve the same bridge identity. Account selection, credentials, strategy,
leases and account health are owned by the authentication provider and
retain the exact public interfaces in the baseline.

## Story: Install and clear shared account-selection contracts

As an authentication host, I install a bridge once and plugin consumers
can read it without a runtime or host-package import. Replacing or clearing
one bridge leaves the other intact. Setting the same reference is idempotent.

### Each bridge slot preserves the last installed object identity

`NoBridge` represents the getter's `null` result. An installed identity
represents the actual object reference and preserves its methods.

```quint
type BridgeReference = NoBridge | InstalledBridge({ identity: str })
type AccountBridges = { anthropic: BridgeReference, coding: BridgeReference }
pure val initial: AccountBridges = { anthropic: NoBridge, coding: NoBridge }
pure def bridgeInstalled(bridge: BridgeReference): bool = match bridge { | NoBridge => false | InstalledBridge(value) => true }
pure def setAnthropic(s: AccountBridges, bridge: BridgeReference): AccountBridges = { ...s, anthropic: bridge }
pure def setCoding(s: AccountBridges, bridge: BridgeReference): AccountBridges = { ...s, coding: bridge }
pure val bridgeValues = Set(NoBridge, InstalledBridge({ identity: "first-object" }), InstalledBridge({ identity: "second-object" }))
pure def stepIndependentBridgeSlots(before: AccountBridges, via: str, after: AccountBridges): bool = (via == "setAnthropic" implies after.coding == before.coding) and (via == "setCoding" implies after.anthropic == before.anthropic)
pure def lawAnthropicInstallationIsIdempotent(s: AccountBridges, bridge: BridgeReference): bool = setAnthropic(setAnthropic(s, bridge), bridge) == setAnthropic(s, bridge)
pure def lawCodingInstallationIsIdempotent(s: AccountBridges, bridge: BridgeReference): bool = setCoding(setCoding(s, bridge), bridge) == setCoding(s, bridge)
pure val sValues = Set(initial, { anthropic: InstalledBridge({ identity: "first-object" }), coding: InstalledBridge({ identity: "second-object" }) })
pure def sometimesBothBridgesInstalled(s: AccountBridges): bool = bridgeInstalled(s.anthropic) and bridgeInstalled(s.coding)
pure def sometimesAnthropicClearedIndependently(s: AccountBridges): bool = not(bridgeInstalled(s.anthropic)) and bridgeInstalled(s.coding)
```
