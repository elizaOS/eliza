# Runtime capability strategy selection

The source is `packages/core/src/services/runtime-capability-service.ts:70-177` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. Strategies and fallback are runtime-replaceable references. The service owns no strategy teardown: stop does not stop strategies or alter the table.

## Story: Select the first available implementation of each capability

As a host I can replace strategies and fallback independently. Each capability getter chooses the first strategy that exposes it. Environment comes from the first strategy even if another strategy serves the capability. Availability always comes from the fallback.

### Strategy order selects each capability while fallback owns availability

```quint
type Capability = FsCapability | PtyCapability | GitCapability | ModelCapability | PluginCapability
type CapabilityStrategy = {id: int, environment: str, fs: int, pty: int, git: int, model: int, plugin: int}
type StrategyRouter = {strategies: List[CapabilityStrategy], fallback: CapabilityStrategy}
pure val emptyStrategy: CapabilityStrategy = {id: 0, environment: "unknown", fs: 0, pty: 0, git: 0, model: 0, plugin: 0}
pure val initial: StrategyRouter = {strategies: List(), fallback: emptyStrategy}
pure val strategiesValues = Set(List(), List({id: 1, environment: "local", fs: 1, pty: 0, git: 0, model: 0, plugin: 0}, {id: 2, environment: "remote", fs: 2, pty: 2, git: 2, model: 2, plugin: 2}))
pure val fallbackValues = Set(emptyStrategy, {id: 3, environment: "remote", fs: 3, pty: 3, git: 3, model: 3, plugin: 3})
pure def setStrategies(s: StrategyRouter, strategies: List[CapabilityStrategy]): StrategyRouter = { ...s, strategies: strategies }
pure def setFallback(s: StrategyRouter, fallback: CapabilityStrategy): StrategyRouter = { ...s, fallback: fallback }
pure def capabilityReference(strategy: CapabilityStrategy, capability: Capability): int = match capability { | FsCapability => strategy.fs | PtyCapability => strategy.pty | GitCapability => strategy.git | ModelCapability => strategy.model | PluginCapability => strategy.plugin }
pure def chosenReference(s: StrategyRouter, capability: Capability): int = capabilityReference(s.strategies.select(strategy => capabilityReference(strategy, capability) != 0).nthOr(0, s.fallback), capability)
pure def currentEnvironment(s: StrategyRouter): str = s.strategies.nthOr(0, s.fallback).environment
pure def availabilityOwner(s: StrategyRouter): int = s.fallback.id
pure def stopService(s: StrategyRouter): StrategyRouter = s
pure def stepSettersIndependent(before: StrategyRouter, via: str, after: StrategyRouter): bool = (via == "setStrategies" implies after.fallback == before.fallback) and (via == "setFallback" implies after.strategies == before.strategies)
pure def sometimesCapabilityDiffersFromEnvironment(s: StrategyRouter): bool = s.strategies.length() > 1 and chosenReference(s, PtyCapability) != s.strategies.nthOr(0, emptyStrategy).pty
```
