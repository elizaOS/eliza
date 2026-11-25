# Runtime registries

The registries of one runtime instance, each with its own collision and ordering policy: actions, providers, evaluators, model handlers and event callbacks; localized example factories and direct action routes; task workers, search categories and resolved model providers. Owner zero is direct host registration; positive owners are plugin [registration epochs](./pluginServices.md). Sources: `runtime.ts`, `plugin-lifecycle.ts`, `runtime/model-dispatch.ts`, `runtime/localized-examples-provider.ts`, `runtime/direct-action-routing.ts`.

## Story: Register actions providers and evaluators

> As a plugin author, I want deterministic first-wins registration that only
> an explicit host override can replace, so that my contributions are not
> displaced by accident.

### Plugin contributions cannot displace an incumbent component

A direct host override replaces the component at its existing position. The identity of a repeated reference remains idempotent.

```quint
type ComponentKind = ActionComponent | ProviderComponent | EvaluatorComponent
type ComponentRegistration = { kind: ComponentKind, name: str, reference: int, owner: int }
type ModelRegistration = { modelType: str, provider: str, reference: int, priority: int, order: int, owner: int }
type EventRegistration = { eventName: str, reference: int, owner: int }
type LocalizedProvider = {runtime: int, reference: int}
type DirectRoute = {runtime: int, id: str, reference: int, actionNames: List[str], replacementNames: List[str], requiredTags: List[str], contexts: List[str], hasWholeRequest: bool, invalidates: List[str], domainOnly: bool, unavailableCode: str, unavailableReply: str}
type Worker = {name: str, reference: int}
type SearchCategory = {key: str, category: str, label: str, active: bool, contexts: List[str], filters: List[str], capabilities: List[str], payload: str}
type ResolvedProvider = {modelType: str, name: str}
type RuntimeRegistries = { components: List[ComponentRegistration], models: List[ModelRegistration], events: List[EventRegistration], nextOrder: int, collisionWarnings: int, localized: List[LocalizedProvider], direct: List[DirectRoute], workers: List[Worker], categories: List[SearchCategory], providers: List[ResolvedProvider], promptHooks: int, taskWakeRevision: int }
pure val initial: RuntimeRegistries = { components: List(), models: List(), events: List(), nextOrder: 1, collisionWarnings: 0, localized: List(), direct: List(), workers: List(), categories: List(), providers: List(), promptHooks: 0, taskWakeRevision: 0 }
pure val nameValues = Set("read", "write")
pure val referenceValues = Set(0, 1, 2, 3)
pure val ownerValues = Set(0, 1, 2)
pure val priorityValues = Set(-1, 0, 1)
pure val modelTypeValues = Set("TEXT_SMALL", "TEXT_LARGE", "TEXT_EMBEDDING")
pure val providerValues = Set("p1", "p2")
pure val eventNameValues = Set("message", "model_registered")
pure def canRegisterComponent(s: RuntimeRegistries, kind: ComponentKind, name: str, reference: int, owner: int, allowsOverride: bool): bool = reference > 0 and owner >= 0
pure def registerComponent(s: RuntimeRegistries, kind: ComponentKind, name: str, reference: int, owner: int, allowsOverride: bool): RuntimeRegistries = {
  val incumbent = s.components.select(c => c.kind == kind and c.name == name)
  val same = incumbent.some(c => c.reference == reference)
  val replacement = {kind: kind, name: name, reference: reference, owner: owner}
  if (same) s
  else if (incumbent.length() == 0) { ...s, components: s.components.append(replacement) }
  else if (allowsOverride and owner == 0) { ...s, components: s.components.listMap(c => if (c.kind == kind and c.name == name) replacement else c) }
  else { ...s, collisionWarnings: s.collisionWarnings + 1 }
}
pure def canUnregisterComponent(s: RuntimeRegistries, kind: ComponentKind, name: str): bool = s.components.some(c => c.kind == kind and c.name == name)
pure def unregisterComponent(s: RuntimeRegistries, kind: ComponentKind, name: str): RuntimeRegistries = { ...s, components: s.components.select(c => c.kind != kind or c.name != name) }
pure def alwaysComponentNamesUnique(s: RuntimeRegistries): bool = s.components.every(c => s.components.select(other => other.kind == c.kind and other.name == c.name).length() == 1)
pure def alwaysComponentOwnershipValid(s: RuntimeRegistries): bool = s.components.every(c => c.reference > 0 and c.owner >= 0)
pure def sometimesCollisionReported(s: RuntimeRegistries): bool = s.collisionWarnings > 0
```

## Story: Select registered model handlers in order

> As a caller, I want the highest-priority registered model handler, with
> the earlier registration winning ties, so that model selection is stable.

### Model registration preserves every handler and its provider identity

A disabled capability declines registration explicitly. Model records retain their type, provider, priority and registration order.

```quint
pure def canRegisterModel(s: RuntimeRegistries, modelType: str, provider: str, reference: int, priority: int, owner: int, capabilityEnabled: bool): bool = reference > 0 and owner >= 0
pure def registerModel(s: RuntimeRegistries, modelType: str, provider: str, reference: int, priority: int, owner: int, capabilityEnabled: bool): RuntimeRegistries =
  if (not(capabilityEnabled)) s else { ...s, models: s.models.append({modelType: modelType, provider: provider, reference: reference, priority: priority, order: s.nextOrder, owner: owner}), nextOrder: s.nextOrder + 1 }
pure val noModel: ModelRegistration = {modelType: "", provider: "", reference: 0, priority: 0, order: 0, owner: 0}
pure def preferredModel(a: ModelRegistration, b: ModelRegistration): ModelRegistration = if (a.reference == 0 or b.priority > a.priority or (b.priority == a.priority and b.order < a.order)) b else a
pure def selectedModel(s: RuntimeRegistries, modelType: str): ModelRegistration = s.models.select(m => m.modelType == modelType).foldl(noModel, (chosen, m) => preferredModel(chosen, m))
pure def alwaysModelRegistrationOrderUnique(s: RuntimeRegistries): bool = s.models.every(m => m.reference > 0 and m.owner >= 0 and m.order > 0 and m.order < s.nextOrder and s.models.select(other => other.order == m.order).length() == 1)
pure def alwaysModelSelectionPriority(s: RuntimeRegistries): bool = s.models.every(m => selectedModel(s, m.modelType).priority > m.priority or (selectedModel(s, m.modelType).priority == m.priority and selectedModel(s, m.modelType).order <= m.order))
pure def sometimesBothModelProvidersRetained(s: RuntimeRegistries): bool = s.models.some(a => s.models.some(b => a.modelType == b.modelType and a.provider != b.provider))
```

## Story: Remove only registrations owned by a plugin epoch

> As a host, I want to unload one plugin without deleting a successor's
> components or model handlers, so that a reload keeps the new
> registrations.

### Plugin cleanup removes matching epoch ownership

Direct host registrations and every other plugin epoch survive cleanup. Event callback removal by explicit reference follows the existing remove-all matching-reference behavior.

```quint
pure def canRegisterEvent(s: RuntimeRegistries, eventName: str, reference: int, owner: int): bool = reference > 0 and owner >= 0
pure def registerEvent(s: RuntimeRegistries, eventName: str, reference: int, owner: int): RuntimeRegistries = { ...s, events: s.events.append({eventName: eventName, reference: reference, owner: owner}) }
pure def canUnregisterEvent(s: RuntimeRegistries, eventName: str, reference: int): bool = reference > 0
pure def unregisterEvent(s: RuntimeRegistries, eventName: str, reference: int): RuntimeRegistries = { ...s, events: s.events.select(h => h.eventName != eventName or h.reference != reference) }
pure def canUnloadOwner(s: RuntimeRegistries, owner: int): bool = owner > 0
pure def unloadOwner(s: RuntimeRegistries, owner: int): RuntimeRegistries = { ...s, components: s.components.select(c => c.owner != owner), models: s.models.select(m => m.owner != owner), events: s.events.select(h => h.owner != owner) }
pure def sometimesHostRegistrationSurvives(s: RuntimeRegistries): bool = s.components.some(c => c.owner == 0)
pure def alwaysRegistryCountersNonnegative(s: RuntimeRegistries): bool = s.nextOrder > 0 and s.collisionWarnings >= 0
```

## Story: Supply runtime-specific routing extensions

> As a host, I want to replace the localized provider and upsert direct
> routes, so that each runtime's routing stays its own.

A runtime keeps no registry of candidate backstops that add actions from the
person's words: the model chooses each call.

### Each routing registry follows its source identity and ordering policy

Localized providers use last registration for a runtime. Direct route IDs replace at their original position.

```quint
pure val runtimeIdValues = Set(1, 2)
pure val routeValues = Set({runtime: 1, id: "owner-route", reference: 1, actionNames: List("READ"), replacementNames: List(), requiredTags: List("read"), contexts: List("files"), hasWholeRequest: false, invalidates: List(), domainOnly: false, unavailableCode: "", unavailableReply: ""}, {runtime: 2, id: "owner-route", reference: 2, actionNames: List("WRITE"), replacementNames: List("CODE"), requiredTags: List("write"), contexts: List("files"), hasWholeRequest: true, invalidates: List("folder"), domainOnly: true, unavailableCode: "UNAVAILABLE", unavailableReply: "The file action is unavailable."})
pure def canRegisterLocalized(s: RuntimeRegistries, runtimeId: int, reference: int): bool = runtimeId > 0 and reference > 0
pure def registerLocalized(s: RuntimeRegistries, runtimeId: int, reference: int): RuntimeRegistries = { ...s, localized: if (s.localized.some(p => p.runtime == runtimeId)) s.localized.listMap(p => if (p.runtime == runtimeId) {runtime: runtimeId, reference: reference} else p) else s.localized.append({runtime: runtimeId, reference: reference}) }
pure def localizedProvider(s: RuntimeRegistries, runtimeId: int): int = s.localized.select(p => p.runtime == runtimeId).nthOr(0, {runtime: runtimeId, reference: 0}).reference
pure def canRegisterDirectRoute(s: RuntimeRegistries, route: DirectRoute): bool = route.runtime > 0 and route.reference > 0
pure def registerDirectRoute(s: RuntimeRegistries, route: DirectRoute): RuntimeRegistries = { ...s, direct: if (s.direct.some(r => r.runtime == route.runtime and r.id == route.id)) s.direct.listMap(r => if (r.runtime == route.runtime and r.id == route.id) route else r) else s.direct.append(route) }
pure def canResetDirectRoutes(s: RuntimeRegistries, runtimeId: int): bool = runtimeId > 0
pure def resetDirectRoutes(s: RuntimeRegistries, runtimeId: int): RuntimeRegistries = { ...s, direct: s.direct.select(r => r.runtime != runtimeId) }
pure def directRoutes(s: RuntimeRegistries, runtimeId: int): List[DirectRoute] = s.direct.select(r => r.runtime == runtimeId)
pure def alwaysLocalizedSlotUnique(s: RuntimeRegistries): bool = s.localized.every(p => s.localized.select(other => other.runtime == p.runtime).length() == 1)
pure def alwaysDirectIdsUniquePerRuntime(s: RuntimeRegistries): bool = s.direct.every(r => s.direct.select(other => other.runtime == r.runtime and other.id == r.id).length() == 1)
pure def sometimesTwoRuntimeProviders(s: RuntimeRegistries): bool = s.localized.some(a => s.localized.some(b => a.runtime != b.runtime and a.reference != b.reference))
```

## Story: Replace runtime extensions without inventing providers

> As a host, I want to replace a named task worker, register a normalized
> search category, install or clear the prompt-optimization hooks and
> observe only a real provider name from successful model resolution, so
> that runtime extensions never invent providers.

### Each extension registry preserves its own normalization and replacement policy

Task workers, search categories and prompt-optimization hooks have distinct replacement policies. Task workers use exact names and registration wakes the local scheduler even for replacement. Search-category keys are trimmed lowercase; category and label are trimmed and nonempty. Search registration clones contexts, filters/options and capabilities. Model provider notes ignore absent or blank names but preserve the original accepted spelling. Prompt hook null clears that slot. Search display collation is a locale-aware adapter contract; eligibility and returned content are modeled here.

```quint
pure val workerNameValues = Set("task", " TASK ")
pure val categoryValues = Set({key: "files", category: "Files", label: "Files", active: true, contexts: List("chat"), filters: List("type"), capabilities: List("search"), payload: "complete registration"}, {key: "files", category: "Files", label: "Files", active: false, contexts: List(), filters: List(), capabilities: List(), payload: "disabled"})
pure val keyValues = Set("files", "missing")
pure val contextsValues = Set(List(), List("chat"), List("memory"))
pure val providerNameValues = Set("", "real-provider", " provider ")
pure def canRegisterWorker(s: RuntimeRegistries, workerName: str, reference: int): bool = reference > 0
pure def registerWorker(s: RuntimeRegistries, workerName: str, reference: int): RuntimeRegistries = { ...s, workers: if (s.workers.some(w => w.name == workerName)) s.workers.listMap(w => if (w.name == workerName) {name: workerName, reference: reference} else w) else s.workers.append({name: workerName, reference: reference}), taskWakeRevision: s.taskWakeRevision + 1 }
pure def unregisterWorker(s: RuntimeRegistries, workerName: str): RuntimeRegistries = { ...s, workers: s.workers.select(w => w.name != workerName) }
pure def canRegisterCategory(s: RuntimeRegistries, category: SearchCategory): bool = category.key != "" and category.category != "" and category.label != ""
pure def registerCategory(s: RuntimeRegistries, category: SearchCategory): RuntimeRegistries = { ...s, categories: if (s.categories.some(c => c.key == category.key)) s.categories.listMap(c => if (c.key == category.key) category else c) else s.categories.append(category) }
pure def visibleCategories(s: RuntimeRegistries, contexts: List[str], includeDisabled: bool): List[SearchCategory] = s.categories.select(c => (includeDisabled or c.active) and (contexts.length() == 0 or c.contexts.length() == 0 or c.contexts.some(context => contexts.includes(context))))
pure def lookupStatus(s: RuntimeRegistries, key: str, includeDisabled: bool): str = if (not(s.categories.some(c => c.key == key))) "SEARCH_CATEGORY_NOT_FOUND" else if (not(includeDisabled) and s.categories.some(c => c.key == key and not(c.active))) "SEARCH_CATEGORY_DISABLED" else "found"
pure def canSetPromptHooks(s: RuntimeRegistries, reference: int): bool = reference >= 0
pure def setPromptHooks(s: RuntimeRegistries, reference: int): RuntimeRegistries = { ...s, promptHooks: reference }
pure def canNoteResolvedProvider(s: RuntimeRegistries, modelType: str, providerName: str, nonblank: bool): bool = not(nonblank) or providerName != ""
pure def noteResolvedProvider(s: RuntimeRegistries, modelType: str, providerName: str, nonblank: bool): RuntimeRegistries = if (not(nonblank)) s else { ...s, providers: s.providers.select(p => p.modelType != modelType).append({modelType: modelType, name: providerName}) }
pure def alwaysUniqueKeys(s: RuntimeRegistries): bool = s.workers.every(w => s.workers.select(other => other.name == w.name).length() == 1) and s.categories.every(c => s.categories.select(other => other.key == c.key).length() == 1) and s.providers.every(p => s.providers.select(other => other.modelType == p.modelType).length() == 1)
pure def stepRegisterWorkerWakesScheduler(before: RuntimeRegistries, via: str, after: RuntimeRegistries): bool = via == "registerWorker" implies after.taskWakeRevision == before.taskWakeRevision + 1
pure def stepCategoryIsolation(before: RuntimeRegistries, via: str, after: RuntimeRegistries): bool = via == "registerCategory" implies after.workers == before.workers and after.providers == before.providers
pure def sometimesIndependentExtensions(s: RuntimeRegistries): bool = s.workers.length() > 0 and s.categories.length() > 0 and s.promptHooks > 0 and s.providers.length() > 0
```
