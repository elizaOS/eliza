# Runtime routing extension registries

Localized example factories, direct action routes and candidate backstops are isolated by runtime instance. Sources include [localized-examples-provider.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/localized-examples-provider.ts), [direct-action-routing.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/direct-action-routing.ts) and [candidate-action-backstop.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/candidate-action-backstop.ts).

## Story: Supply runtime-specific routing extensions

As a host I replace the localized provider and upsert direct routes while preserving append-only backstop registration.

### Each registry follows its source identity and ordering policy

Localized providers use last registration for a runtime. Direct route IDs replace at their original position. Backstops append every registration, including repeated references.

```quint
type LocalizedProvider = {runtime: int, reference: int}
type DirectRoute = {runtime: int, id: str, reference: int, actionNames: List[str], replacementNames: List[str], requiredTags: List[str], contexts: List[str], hasWholeRequest: bool, invalidates: List[str], domainOnly: bool, unavailableCode: str, unavailableReply: str}
type BackstopRule = {runtime: int, reference: int, actionNames: List[str]}
type RoutingRegistries = {localized: List[LocalizedProvider], direct: List[DirectRoute], backstops: List[BackstopRule]}
pure val initial: RoutingRegistries = {localized: List(), direct: List(), backstops: List()}
pure val runtimeIdValues = Set(1, 2)
pure val referenceValues = Set(1, 2, 3)
pure val routeValues = Set({runtime: 1, id: "owner-route", reference: 1, actionNames: List("READ"), replacementNames: List(), requiredTags: List("read"), contexts: List("files"), hasWholeRequest: false, invalidates: List(), domainOnly: false, unavailableCode: "", unavailableReply: ""}, {runtime: 2, id: "owner-route", reference: 2, actionNames: List("WRITE"), replacementNames: List("CODE"), requiredTags: List("write"), contexts: List("files"), hasWholeRequest: true, invalidates: List("folder"), domainOnly: true, unavailableCode: "UNAVAILABLE", unavailableReply: "The file action is unavailable."})
pure val actionNamesValues = Set(List(), List("READ"), List("WRITE"))
pure def canRegisterLocalized(s: RoutingRegistries, runtimeId: int, reference: int): bool = runtimeId > 0 and reference > 0
pure def registerLocalized(s: RoutingRegistries, runtimeId: int, reference: int): RoutingRegistries = { ...s, localized: if (s.localized.some(p => p.runtime == runtimeId)) s.localized.listMap(p => if (p.runtime == runtimeId) {runtime: runtimeId, reference: reference} else p) else s.localized.append({runtime: runtimeId, reference: reference}) }
pure def localizedProvider(s: RoutingRegistries, runtimeId: int): int = s.localized.select(p => p.runtime == runtimeId).nthOr(0, {runtime: runtimeId, reference: 0}).reference
pure def canRegisterDirectRoute(s: RoutingRegistries, route: DirectRoute): bool = route.runtime > 0 and route.reference > 0
pure def registerDirectRoute(s: RoutingRegistries, route: DirectRoute): RoutingRegistries = { ...s, direct: if (s.direct.some(r => r.runtime == route.runtime and r.id == route.id)) s.direct.listMap(r => if (r.runtime == route.runtime and r.id == route.id) route else r) else s.direct.append(route) }
pure def canResetDirectRoutes(s: RoutingRegistries, runtimeId: int): bool = runtimeId > 0
pure def resetDirectRoutes(s: RoutingRegistries, runtimeId: int): RoutingRegistries = { ...s, direct: s.direct.select(r => r.runtime != runtimeId) }
pure def canRegisterBackstop(s: RoutingRegistries, runtimeId: int, reference: int, actionNames: List[str]): bool = runtimeId > 0 and reference > 0
pure def registerBackstop(s: RoutingRegistries, runtimeId: int, reference: int, actionNames: List[str]): RoutingRegistries = { ...s, backstops: s.backstops.append({runtime: runtimeId, reference: reference, actionNames: actionNames}) }
pure def directRoutes(s: RoutingRegistries, runtimeId: int): List[DirectRoute] = s.direct.select(r => r.runtime == runtimeId)
pure def candidateBackstops(s: RoutingRegistries, runtimeId: int): List[BackstopRule] = s.backstops.select(r => r.runtime == runtimeId)
pure def alwaysLocalizedSlotUnique(s: RoutingRegistries): bool = s.localized.every(p => s.localized.select(other => other.runtime == p.runtime).length() == 1)
pure def alwaysDirectIdsUniquePerRuntime(s: RoutingRegistries): bool = s.direct.every(r => s.direct.select(other => other.runtime == r.runtime and other.id == r.id).length() == 1)
pure def sometimesBackstopDuplicateRetained(s: RoutingRegistries): bool = s.backstops.some(b => s.backstops.select(other => other.runtime == b.runtime and other.reference == b.reference).length() > 1)
pure def sometimesTwoRuntimeProviders(s: RoutingRegistries): bool = s.localized.some(a => s.localized.some(b => a.runtime != b.runtime and a.reference != b.reference))
```
