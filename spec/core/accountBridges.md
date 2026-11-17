# Account-selection bridge slots

The source is `packages/core/src/account-pool-bridge.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. Core exposes two
`globalThis`/`Symbol.for` slots so independently loaded module copies
resolve the same bridge identity. Account selection, credentials, strategy,
leases and account health are owned by the authentication provider and
retain the exact public interfaces in the baseline.

## Story: Install and clear shared account-selection contracts

> As an authentication host, I want to install one account-selection
> bridge that every plugin reads, so that plugins agree on which account
> is selected.

As an authentication host, I install a bridge once and plugin consumers
can read it without a runtime or host-package import. There is one slot for
the model provider's account pool and one for the coding agent's account
pool. Replacing or clearing one bridge leaves the other intact. Setting the
same reference is idempotent.

### Each bridge slot preserves the last installed object identity

`NoBridge` represents the getter's `null` result. An installed identity
represents the actual object reference and preserves its methods.

```quint
type BridgeObject = { identity: str }
type BridgeReference = NoBridge | InstalledBridge(BridgeObject)
type BridgeSlot = ModelPoolSlot | CodingPoolSlot
type AccountBridges = { modelPool: BridgeReference, codingPool: BridgeReference }
pure val initial: AccountBridges = { modelPool: NoBridge, codingPool: NoBridge }
pure def bridgeInstalled(bridge: BridgeReference): bool = match bridge { | NoBridge => false | InstalledBridge(value) => true }
pure def setBridge(s: AccountBridges, slot: BridgeSlot, bridge: BridgeReference): AccountBridges = match slot { | ModelPoolSlot => { ...s, modelPool: bridge } | CodingPoolSlot => { ...s, codingPool: bridge } }
pure val bridgeValues = Set(NoBridge, InstalledBridge({ identity: "first-object" }), InstalledBridge({ identity: "second-object" }))
pure def stepIndependentBridgeSlots(before: AccountBridges, after: AccountBridges): bool = after.modelPool == before.modelPool or after.codingPool == before.codingPool
pure def lawSettingOneSlotLeavesTheOther(s: AccountBridges, bridge: BridgeReference): bool = setBridge(s, ModelPoolSlot, bridge).codingPool == s.codingPool and setBridge(s, CodingPoolSlot, bridge).modelPool == s.modelPool
pure def lawInstallationIsIdempotent(s: AccountBridges, slot: BridgeSlot, bridge: BridgeReference): bool = setBridge(setBridge(s, slot, bridge), slot, bridge) == setBridge(s, slot, bridge)
pure val sValues = Set(initial, { modelPool: InstalledBridge({ identity: "first-object" }), codingPool: InstalledBridge({ identity: "second-object" }) })
pure def sometimesBothBridgesInstalled(s: AccountBridges): bool = bridgeInstalled(s.modelPool) and bridgeInstalled(s.codingPool)
pure def sometimesModelPoolClearedIndependently(s: AccountBridges): bool = not(bridgeInstalled(s.modelPool)) and bridgeInstalled(s.codingPool)
```
