# Runtime extension registries

Sources are `packages/core/src/runtime.ts:2199-2207,3875-3892,5321-5397` and `runtime/model-dispatch.ts:399-421` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. Worker, search-category and prompt-optimization registrations have distinct replacement policies. These objects are owned by one runtime instance.

## Story: Replace runtime extensions without inventing providers

As a host I can replace a named task worker, register a normalized search category, install or clear prompt hooks, and observe only a real provider name from successful model resolution.

### Each registry preserves its own normalization and replacement policy

Task workers use exact names and registration wakes the local scheduler even for replacement. Search-category keys are trimmed lowercase; category and label are trimmed and nonempty. Search registration clones contexts, filters/options and capabilities. Model provider notes ignore absent or blank names but preserve the original accepted spelling. Prompt hook null clears that slot. Search display collation is a locale-aware adapter contract; eligibility and returned content are modeled here.

```quint
type Worker = {name: str, reference: int}
type SearchCategory = {key: str, category: str, label: str, active: bool, contexts: List[str], filters: List[str], capabilities: List[str], payload: str}
type ResolvedProvider = {modelType: str, name: str}
type RuntimeExtensions = {workers: List[Worker], categories: List[SearchCategory], promptHooks: int, providers: List[ResolvedProvider], taskWakeRevision: int}
pure val initial: RuntimeExtensions = {workers: List(), categories: List(), promptHooks: 0, providers: List(), taskWakeRevision: 0}
pure val nameValues = Set("task", " TASK ")
pure val referenceValues = Set(0, 1, 2)
pure val hooksValues = referenceValues
pure val categoryValues = Set({key: "files", category: "Files", label: "Files", active: true, contexts: List("chat"), filters: List("type"), capabilities: List("search"), payload: "complete registration"}, {key: "files", category: "Files", label: "Files", active: false, contexts: List(), filters: List(), capabilities: List(), payload: "disabled"})
pure val keyValues = Set("files", "missing")
pure val contextsValues = Set(List(), List("chat"), List("memory"))
pure val modelTypeValues = Set("TEXT_LARGE", "TEXT_SMALL")
pure val providerValues = Set("", "real-provider", " provider ")
pure def canRegisterWorker(s: RuntimeExtensions, name: str, reference: int): bool = reference > 0
pure def registerWorker(s: RuntimeExtensions, name: str, reference: int): RuntimeExtensions = { ...s, workers: if (s.workers.some(w => w.name == name)) s.workers.listMap(w => if (w.name == name) {name: name, reference: reference} else w) else s.workers.append({name: name, reference: reference}), taskWakeRevision: s.taskWakeRevision + 1 }
pure def unregisterWorker(s: RuntimeExtensions, name: str): RuntimeExtensions = { ...s, workers: s.workers.select(w => w.name != name) }
pure def canRegisterCategory(s: RuntimeExtensions, category: SearchCategory): bool = category.key != "" and category.category != "" and category.label != ""
pure def registerCategory(s: RuntimeExtensions, category: SearchCategory): RuntimeExtensions = { ...s, categories: if (s.categories.some(c => c.key == category.key)) s.categories.listMap(c => if (c.key == category.key) category else c) else s.categories.append(category) }
pure def visibleCategories(s: RuntimeExtensions, contexts: List[str], includeDisabled: bool): List[SearchCategory] = s.categories.select(c => (includeDisabled or c.active) and (contexts.length() == 0 or c.contexts.length() == 0 or c.contexts.some(context => contexts.includes(context))))
pure def lookupStatus(s: RuntimeExtensions, key: str, includeDisabled: bool): str = if (not(s.categories.some(c => c.key == key))) "SEARCH_CATEGORY_NOT_FOUND" else if (not(includeDisabled) and s.categories.some(c => c.key == key and not(c.active))) "SEARCH_CATEGORY_DISABLED" else "found"
pure def canSetPromptHooks(s: RuntimeExtensions, hooks: int): bool = hooks >= 0
pure def setPromptHooks(s: RuntimeExtensions, hooks: int): RuntimeExtensions = { ...s, promptHooks: hooks }
pure def canNoteResolvedProvider(s: RuntimeExtensions, modelType: str, provider: str, nonblank: bool): bool = not(nonblank) or provider != ""
pure def noteResolvedProvider(s: RuntimeExtensions, modelType: str, provider: str, nonblank: bool): RuntimeExtensions = if (not(nonblank)) s else { ...s, providers: s.providers.select(p => p.modelType != modelType).append({modelType: modelType, name: provider}) }
pure def alwaysUniqueKeys(s: RuntimeExtensions): bool = s.workers.every(w => s.workers.select(other => other.name == w.name).length() == 1) and s.categories.every(c => s.categories.select(other => other.key == c.key).length() == 1) and s.providers.every(p => s.providers.select(other => other.modelType == p.modelType).length() == 1)
pure def stepRegisterWorkerWakesScheduler(before: RuntimeExtensions, via: str, after: RuntimeExtensions): bool = via == "registerWorker" implies after.taskWakeRevision == before.taskWakeRevision + 1
pure def stepCategoryIsolation(before: RuntimeExtensions, via: str, after: RuntimeExtensions): bool = via == "registerCategory" implies after.workers == before.workers and after.providers == before.providers
pure def sometimesIndependentExtensions(s: RuntimeExtensions): bool = s.workers.length() > 0 and s.categories.length() > 0 and s.promptHooks > 0 and s.providers.length() > 0
```
