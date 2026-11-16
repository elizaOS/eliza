# Runtime capability strategy selection

The source is `packages/core/src/services/runtime-capability-service.ts:70-177` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. Strategies and fallback are runtime-replaceable references. The service owns no strategy teardown: stopping it neither stops strategies nor alters the table, so stop is not an event here. A strategy says which implementation backs a capability on this device; [capability routing](./capabilityRouting.md) then decides whether a request runs on the local runner those strategies serve or on a remote runner.

## Story: Select the first available implementation of each capability

> As a host, I want each capability served by the first strategy that
> exposes it, so that replacing one strategy never silently changes
> another capability.

As a host I can replace strategies and fallback independently. A capability is named by a key, such as file system, terminal, version control, model or plugin access, and its getter chooses the first strategy that exposes it; a reference of 0 means the strategy does not expose that capability. Environment comes from the first strategy even if another strategy serves the capability. Availability always comes from the fallback.

### Strategy order selects each capability while fallback owns availability

```quint
type CapabilityReference = {capability: str, reference: int}
type CapabilityStrategy = {id: int, environment: str, capabilities: List[CapabilityReference]}
type StrategyRouter = {strategies: List[CapabilityStrategy], fallback: CapabilityStrategy}
pure val emptyStrategy: CapabilityStrategy = {id: 0, environment: "unknown", capabilities: List()}
pure val initial: StrategyRouter = {strategies: List(), fallback: emptyStrategy}
pure val strategiesValues = Set(List(), List({id: 1, environment: "local", capabilities: List({capability: "fs", reference: 1})}, {id: 2, environment: "remote", capabilities: List({capability: "fs", reference: 2}, {capability: "pty", reference: 2}, {capability: "git", reference: 2})}))
pure val fallbackValues = Set(emptyStrategy, {id: 3, environment: "remote", capabilities: List({capability: "fs", reference: 3}, {capability: "pty", reference: 3}, {capability: "git", reference: 3})})
pure def setStrategies(s: StrategyRouter, strategies: List[CapabilityStrategy]): StrategyRouter = { ...s, strategies: strategies }
pure def setFallback(s: StrategyRouter, fallback: CapabilityStrategy): StrategyRouter = { ...s, fallback: fallback }
pure def capabilityReference(strategy: CapabilityStrategy, capability: str): int = strategy.capabilities.select(entry => entry.capability == capability).nthOr(0, {capability: capability, reference: 0}).reference
pure def chosenReference(s: StrategyRouter, capability: str): int = capabilityReference(s.strategies.select(strategy => capabilityReference(strategy, capability) != 0).nthOr(0, s.fallback), capability)
pure def currentEnvironment(s: StrategyRouter): str = s.strategies.nthOr(0, s.fallback).environment
pure def availabilityOwner(s: StrategyRouter): int = s.fallback.id
pure def stepSettersIndependent(before: StrategyRouter, via: str, after: StrategyRouter): bool = (via == "setStrategies" implies after.fallback == before.fallback) and (via == "setFallback" implies after.strategies == before.strategies)
pure def sometimesCapabilityDiffersFromEnvironment(s: StrategyRouter): bool = s.strategies.length() > 1 and chosenReference(s, "pty") != capabilityReference(s.strategies.nthOr(0, emptyStrategy), "pty")
```
