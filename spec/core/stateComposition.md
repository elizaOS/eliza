# Prompt state composition

Sources are `runtime/state-composition.ts`, `context-gates.ts`, `context-hash.ts`, `context-normalization.ts`, `context-object.ts`, `context-renderer.ts`, `provider-context.ts`, `model-input-budget.ts`, `completion-context.ts`, `session-provider.ts`, `system-prompt.ts`, `recent-errors-provider.ts` and `localized-examples-provider.ts`. Composition turns the registered providers into the ordered segments of one prompt. Shared provider work and its cancellation are [providers](./providers/index.md); which history and evidence a context selects is [context](./context.md); the context taxonomy and its role gates are [context registry](./contextRegistry.md); the serialized request a provider prepares from the result is [prepared requests](./preparedRequests.md).

## Story: Compose prompt state

> As a user, I want each prompt the agent sends to hold the providers I am
> allowed to see, in their declared order, to reuse its cache when nothing
> changed, and to preserve the full input for the provider's budget check,
> so that answers are grounded, private and keep their complete context.

### Providers compose in their declared order

A provider declares a position; the boundary supplies an order rank that preserves the source's order by position and then by name, so ranks are distinct. The registry keeps providers in rank order, and a composition lists its segments in that order.

```quint
type ProviderDecl = { name: str, rank: int, minRole: int, tokens: int }
type RankCheck = { prior: int, valid: bool }
type DispatchOutcome = NotDispatched | Dispatched | RefusedOverBudget
type Composition = { providers: List[ProviderDecl], role: int, segments: List[ProviderDecl], previous: List[ProviderDecl], compositions: int, cacheReused: bool, outcome: DispatchOutcome, estimated: int, threshold: int }
pure val initial: Composition = { providers: List(), role: 0, segments: List(), previous: List(), compositions: 0, cacheReused: false, outcome: NotDispatched, estimated: 0, threshold: 0 }
pure val providerValues = Set({ name: "time", rank: 0, minRole: 0, tokens: 1 }, { name: "facts", rank: 1, minRole: 0, tokens: 2 }, { name: "owner", rank: 2, minRole: 1, tokens: 3 })
pure def canRegisterProvider(s: Composition, provider: ProviderDecl): bool =
  provider.name != "" and provider.rank >= 0 and provider.minRole >= 0 and provider.tokens >= 0 and not(s.providers.some(p => p.name == provider.name or p.rank == provider.rank))
pure def registerProvider(s: Composition, provider: ProviderDecl): Composition =
  { ...s, providers: s.providers.select(p => p.rank < provider.rank).append(provider).concat(s.providers.select(p => p.rank > provider.rank)) }
pure def strictlyRanked(xs: List[ProviderDecl]): bool = xs.foldl({ prior: -1, valid: true }, (check, p) => { prior: p.rank, valid: check.valid and p.rank > check.prior }).valid
pure def alwaysRegistryInDeclaredOrder(s: Composition): bool = strictlyRanked(s.providers) and s.providers.every(p => p.rank >= 0)
pure def alwaysSegmentsInDeclaredOrder(s: Composition): bool = strictlyRanked(s.segments)
```

### A composition includes exactly the providers whose gate admits the caller

A provider's gate names the lowest caller role that may see it. Composing for a caller includes every registered provider that admits that role and none that does not, so owner-only state never reaches a guest's prompt and nothing admitted is skipped.

```quint
pure val roleValues = Set(0, 1)
pure def composeSegments(s: Composition, role: int): List[ProviderDecl] = s.providers.select(p => p.minRole <= role)
pure def canCompose(s: Composition, role: int): bool = role >= 0
pure def compose(s: Composition, role: int): Composition = {
  val segments = composeSegments(s, role)
  { ...s, role: role, segments: segments, previous: s.segments, compositions: s.compositions + 1, cacheReused: s.compositions > 0 and segments == s.segments, outcome: NotDispatched, estimated: 0, threshold: 0 }
}
pure def alwaysSegmentsAdmitTheCaller(s: Composition): bool = s.segments.every(p => p.minRole <= s.role)
pure def stepComposeIncludesEveryAdmittedProvider(before: Composition, via: str, after: Composition): bool =
  via == "compose" implies after.segments == composeSegments(before, after.role)
pure def sometimesGateLeavesProviderOut(s: Composition): bool = s.compositions > 0 and s.providers.some(p => not(s.segments.includes(p)))
```

### The cache key is reused exactly when the composed context is unchanged

The context hash is a stable serialization of the segments, assumed free of collisions: identical segments in identical order give the same key and any difference gives a new one. A composition therefore reuses the previous prompt cache exactly when its segments equal the previous composition's.

```quint
pure def alwaysCacheReusedIffUnchanged(s: Composition): bool = s.cacheReused iff (s.compositions > 1 and s.segments == s.previous)
pure def sometimesCacheReused(s: Composition): bool = s.cacheReused and s.segments.length() > 0
pure def sometimesContextChanged(s: Composition): bool = s.compositions > 1 and not(s.cacheReused)
```

### Dispatch records the estimate and preserves the complete request

The diagnostic threshold is the resolved context window less its output
reserve, with a minimum of one token. The estimate describes the complete
composed segments and may exceed that threshold independently of dispatch.
The provider's [prepared request guard](./preparedRequests.md) owns admission
from an exact token count when both limits were supplied. This model receives
the provider's budget decision and retains the composed segments in either
outcome.

```quint
pure val contextWindowValues = Set(1, 4, 8)
pure val reserveValues = Set(0, 2)
pure def estimate(segments: List[ProviderDecl]): int = segments.foldl(0, (total, p) => total + p.tokens)
pure def dispatchThreshold(contextWindow: int, reserve: int): int = if (contextWindow - reserve < 1) 1 else contextWindow - reserve
pure def canDispatch(s: Composition, contextWindow: int, reserve: int, providerWithinBudget: bool): bool = s.compositions > 0 and s.outcome == NotDispatched and contextWindow >= 1 and reserve >= 0
pure def dispatch(s: Composition, contextWindow: int, reserve: int, providerWithinBudget: bool): Composition = {
  val threshold = dispatchThreshold(contextWindow, reserve)
  val estimated = estimate(s.segments)
  { ...s, threshold: threshold, estimated: estimated, outcome: if (providerWithinBudget) Dispatched else RefusedOverBudget }
}
pure def alwaysDispatchDiagnosticsDescribeTheSegments(s: Composition): bool =
  s.outcome != NotDispatched implies s.threshold >= 1 and s.estimated == estimate(s.segments)
pure def stepDispatchNeverTruncates(before: Composition, via: str, after: Composition): bool = via == "dispatch" implies after.segments == before.segments
pure def sometimesDispatched(s: Composition): bool = s.outcome == Dispatched and s.segments.length() > 1
pure def sometimesEstimateDoesNotPreventDispatch(s: Composition): bool = s.outcome == Dispatched and s.estimated > s.threshold
pure def sometimesProviderRefusesWithinEstimate(s: Composition): bool = s.outcome == RefusedOverBudget and s.estimated <= s.threshold
```
