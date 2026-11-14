# Extension component registries

Actions, providers, evaluators, model handlers and event callbacks retain their existing collision and ordering policies. Sources include [runtime.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime.ts), [plugin-lifecycle.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/plugin-lifecycle.ts) and [model-dispatch.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/model-dispatch.ts). Owner zero denotes direct host registration; positive owners identify plugin registration epochs.

## Story: Register actions providers and evaluators

As a plugin author I receive deterministic first-wins behavior while an explicit host override can replace an incumbent.

### Plugin contributions cannot displace an incumbent component

A direct host override replaces the component at its existing position. The identity of a repeated reference remains idempotent.

```quint
type ComponentKind = ActionComponent | ProviderComponent | EvaluatorComponent
type ComponentRegistration = { kind: ComponentKind, name: str, reference: int, owner: int }
type ModelRegistration = { modelType: str, provider: str, reference: int, priority: int, order: int, owner: int }
type EventRegistration = { eventName: str, reference: int, owner: int }
type ExtensionRegistry = { components: List[ComponentRegistration], models: List[ModelRegistration], events: List[EventRegistration], nextOrder: int, collisionWarnings: int }
pure val initial: ExtensionRegistry = { components: List(), models: List(), events: List(), nextOrder: 1, collisionWarnings: 0 }
pure val nameValues = Set("read", "write")
pure val referenceValues = Set(1, 2, 3)
pure val ownerValues = Set(0, 1, 2)
pure val priorityValues = Set(-1, 0, 1)
pure val modelTypeValues = Set("TEXT_SMALL", "TEXT_LARGE", "TEXT_EMBEDDING")
pure val providerValues = Set("alpha", "beta")
pure val eventNameValues = Set("message", "model_registered")
pure def canRegisterComponent(s: ExtensionRegistry, kind: ComponentKind, name: str, reference: int, owner: int, allowsOverride: bool): bool = reference > 0 and owner >= 0
pure def registerComponent(s: ExtensionRegistry, kind: ComponentKind, name: str, reference: int, owner: int, allowsOverride: bool): ExtensionRegistry = {
  val incumbent = s.components.select(c => c.kind == kind and c.name == name)
  val same = incumbent.some(c => c.reference == reference)
  val replacement = {kind: kind, name: name, reference: reference, owner: owner}
  if (same) s
  else if (incumbent.length() == 0) { ...s, components: s.components.append(replacement) }
  else if (allowsOverride and owner == 0) { ...s, components: s.components.listMap(c => if (c.kind == kind and c.name == name) replacement else c) }
  else { ...s, collisionWarnings: s.collisionWarnings + 1 }
}
pure def canUnregisterComponent(s: ExtensionRegistry, kind: ComponentKind, name: str): bool = s.components.some(c => c.kind == kind and c.name == name)
pure def unregisterComponent(s: ExtensionRegistry, kind: ComponentKind, name: str): ExtensionRegistry = { ...s, components: s.components.select(c => c.kind != kind or c.name != name) }
pure def alwaysComponentNamesUnique(s: ExtensionRegistry): bool = s.components.every(c => s.components.select(other => other.kind == c.kind and other.name == c.name).length() == 1)
pure def alwaysComponentOwnershipValid(s: ExtensionRegistry): bool = s.components.every(c => c.reference > 0 and c.owner >= 0)
pure def sometimesCollisionReported(s: ExtensionRegistry): bool = s.collisionWarnings > 0
```

## Story: Select registered model handlers in order

As a caller I receive the highest-priority registered handler and stable earlier registration when priorities tie.

### Model registration preserves every handler and its provider identity

A disabled capability declines registration explicitly. Model records retain their type, provider, priority and registration order.

```quint
pure def canRegisterModel(s: ExtensionRegistry, modelType: str, provider: str, reference: int, priority: int, owner: int, capabilityEnabled: bool): bool = reference > 0 and owner >= 0
pure def registerModel(s: ExtensionRegistry, modelType: str, provider: str, reference: int, priority: int, owner: int, capabilityEnabled: bool): ExtensionRegistry =
  if (not(capabilityEnabled)) s else { ...s, models: s.models.append({modelType: modelType, provider: provider, reference: reference, priority: priority, order: s.nextOrder, owner: owner}), nextOrder: s.nextOrder + 1 }
pure val noModel: ModelRegistration = {modelType: "", provider: "", reference: 0, priority: 0, order: 0, owner: 0}
pure def preferredModel(a: ModelRegistration, b: ModelRegistration): ModelRegistration = if (a.reference == 0 or b.priority > a.priority or (b.priority == a.priority and b.order < a.order)) b else a
pure def selectedModel(s: ExtensionRegistry, modelType: str): ModelRegistration = s.models.select(m => m.modelType == modelType).foldl(noModel, (chosen, m) => preferredModel(chosen, m))
pure def alwaysModelRegistrationOrderUnique(s: ExtensionRegistry): bool = s.models.every(m => m.reference > 0 and m.owner >= 0 and m.order > 0 and m.order < s.nextOrder and s.models.select(other => other.order == m.order).length() == 1)
pure def alwaysModelSelectionPriority(s: ExtensionRegistry): bool = s.models.every(m => selectedModel(s, m.modelType).priority > m.priority or (selectedModel(s, m.modelType).priority == m.priority and selectedModel(s, m.modelType).order <= m.order))
pure def sometimesBothModelProvidersRetained(s: ExtensionRegistry): bool = s.models.some(a => s.models.some(b => a.modelType == b.modelType and a.provider != b.provider))
```

## Story: Remove only registrations owned by a plugin epoch

As a host I unload one plugin without deleting successor component or model registrations.

### Plugin cleanup removes matching epoch ownership

Direct host registrations and every other plugin epoch survive cleanup. Event callback removal by explicit reference follows the existing remove-all matching-reference behavior.

```quint
pure def canRegisterEvent(s: ExtensionRegistry, eventName: str, reference: int, owner: int): bool = reference > 0 and owner >= 0
pure def registerEvent(s: ExtensionRegistry, eventName: str, reference: int, owner: int): ExtensionRegistry = { ...s, events: s.events.append({eventName: eventName, reference: reference, owner: owner}) }
pure def canUnregisterEvent(s: ExtensionRegistry, eventName: str, reference: int): bool = reference > 0
pure def unregisterEvent(s: ExtensionRegistry, eventName: str, reference: int): ExtensionRegistry = { ...s, events: s.events.select(h => h.eventName != eventName or h.reference != reference) }
pure def canUnloadOwner(s: ExtensionRegistry, owner: int): bool = owner > 0
pure def unloadOwner(s: ExtensionRegistry, owner: int): ExtensionRegistry = { ...s, components: s.components.select(c => c.owner != owner), models: s.models.select(m => m.owner != owner), events: s.events.select(h => h.owner != owner) }
pure def sometimesHostRegistrationSurvives(s: ExtensionRegistry): bool = s.components.some(c => c.owner == 0)
pure def alwaysRegistryCountersNonnegative(s: ExtensionRegistry): bool = s.nextOrder > 0 and s.collisionWarnings >= 0
```
