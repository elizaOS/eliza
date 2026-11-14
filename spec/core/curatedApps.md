# Curated app aliases across module copies

Source `catalog/apps.ts` stores runtime definitions in the shared `Symbol.for("elizaos.curated-app-registry")` store. Each loaded module copy owns its lookup map and remembers the ordered definition identities it last folded. The bundled definitions and initial keys are exact static assets in the baseline.

## Story: Resolve apps registered through a different package instance

As a host, I want another bundled copy's runtime registration to become visible before lookup.

### Slug replacement retains registration order and every module copy refreshes from the shared store

A registration replaces the matching slug in its original slot or appends a new slug. Refolding applies definitions in that order, so the last slot contributing a lookup key wins. Keys include normalized slug, canonical package name, aliases and their derived route slugs. Normalization trims and lowercases; route conversion removes the package scope and a leading app- or plugin- prefix. The lookup first tries the complete normalized input, then its route slug. The source retains old local lookup keys while refolding, so a removed alias may still resolve in a module that previously folded it. Definition identities are explicit revision inputs here.

```quint
type AppDefinition = { slug: str, keys: List[str], revision: int }
type AliasTable = { keys: Set[str], targets: str -> str }
type CuratedApps = { definitions: List[AppDefinition], version: int, instances: Set[str], localVersions: str -> int, locals: str -> AliasTable }
pure val emptyAliases: AliasTable = { keys: Set(), targets: Map() }
pure val initial: CuratedApps = { definitions: List(), version: 0, instances: Set(), localVersions: Map(), locals: Map() }
pure def localAt(a: CuratedApps, instance: str): AliasTable = if (a.instances.contains(instance)) a.locals.getOr(instance, emptyAliases) else emptyAliases
pure def addDefinitionKey(table: AliasTable, key: str, slug: str): AliasTable = { keys: table.keys.union(Set(key)), targets: table.targets.put(key, slug) }
pure def addDefinitionKeys(table: AliasTable, definition: AppDefinition): AliasTable = definition.keys.foldl(table, (accumulator, key) => addDefinitionKey(accumulator, key, definition.slug))
pure def registerApp(a: CuratedApps, slug: str, matchKeys: List[str], revision: int): CuratedApps = {
  val changed = not(a.definitions.some(definition => definition.slug == slug and definition.revision == revision))
  val replacement = { slug: slug, keys: matchKeys, revision: revision }
  { ...a, definitions: if (a.definitions.some(definition => definition.slug == slug)) a.definitions.listMap(definition => if (definition.slug == slug) replacement else definition) else a.definitions.append(replacement), version: a.version + (if (changed) 1 else 0) }
}
pure def canRefreshLookup(a: CuratedApps, instance: str): bool = not(a.instances.contains(instance)) or a.localVersions.getOr(instance, -1) != a.version
pure def refreshLookup(a: CuratedApps, instance: str): CuratedApps = { ...a, instances: a.instances.union(Set(instance)), localVersions: a.localVersions.put(instance, a.version), locals: a.locals.put(instance, a.definitions.foldl(localAt(a, instance), (table, definition) => addDefinitionKeys(table, definition))) }
pure def lookupCached(a: CuratedApps, instance: str, normalized: str, routeSlug: str): str = {
  val aliases = localAt(a, instance)
  if (normalized == "") "" else if (aliases.keys.contains(normalized)) aliases.targets.getOr(normalized, "") else aliases.targets.getOr(routeSlug, "")
}
pure def alwaysVersionsNonnegative(a: CuratedApps): bool = a.version >= 0 and a.instances.forall(instance => a.localVersions.getOr(instance, 0) <= a.version)
pure def stepLocalAliasesRetained(before: CuratedApps, after: CuratedApps): bool = before.instances.forall(instance => localAt(before, instance).keys.subseteq(localAt(after, instance).keys))
pure def sometimesTwoModuleCopies(a: CuratedApps): bool = a.instances.size() > 1
pure def sometimesRuntimeAppRegistered(a: CuratedApps): bool = a.definitions.length() > 0
pure val matchKeysValues = Set(List(), List("browser"), List("browser", "web"), List("web"))
```
