# Owner-scoped connector source metadata

The process-level source registry retains owner insertion order, merges aliases, and rebuilds canonical lookup after every registration change. This state model consumes canonical lowercase trimmed tokens from the source normalization contract. Source [connectors.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/connectors.ts).

## Story: Register connector aliases without clobbering other owners

> As a connector plugin, I want my source aliases added and removed with
> my owner only, so that unloading me never erases another plugin's
> contributions.

### Owner registration merges aliases and replaces only supplied metadata fields

Owners retain insertion order. Presence flags distinguish an omitted field from an explicit undefined value that clears the owner's prior value. Owner merging then uses the last defined value across owners.

```quint
type SourceKind = UnspecifiedKind | ActiveKind | PassiveKind
type PassiveValue = UnspecifiedPassive | PassiveTrue | PassiveFalse
type SourceMetadata = { canonical: str, aliases: List[str], kind: SourceKind, passive: PassiveValue, identity: List[str], hasIdentity: bool, worldKeys: List[str], hasWorldKeys: bool }
type KindPatch = { present: bool, kind: SourceKind }
type PassivePatch = { present: bool, passive: PassiveValue }
type KeysPatch = { present: bool, defined: bool, keys: List[str] }
type SourcePatch = { canonical: str, aliases: List[str], kind: KindPatch, passive: PassivePatch, identity: KeysPatch, worldKeys: KeysPatch }
type SourceOwner = { owner: str, registrations: List[SourceMetadata] }
type AliasBinding = { alias: str, canonical: str }
type SourceRegistry = { owners: List[SourceOwner], merged: List[SourceMetadata], aliases: List[AliasBinding] }
pure val initial: SourceRegistry = { owners: List(), merged: List(), aliases: List() }
pure val ownerValues = Set("manual", "plugin-a", "plugin-b")
pure val keptKeys: KeysPatch = { present: false, defined: false, keys: List() }
pure val patchValues: Set[SourcePatch] = Set(
  { canonical: "chat", aliases: List("chat"), kind: { present: true, kind: ActiveKind }, passive: { present: false, passive: UnspecifiedPassive }, identity: { present: true, defined: true, keys: List("userId") }, worldKeys: keptKeys },
  { canonical: "mail", aliases: List("mail", "alias"), kind: { present: false, kind: UnspecifiedKind }, passive: { present: true, passive: PassiveTrue }, identity: { present: true, defined: false, keys: List() }, worldKeys: { present: true, defined: true, keys: List("guildId", "channelId") } },
  { canonical: "chat", aliases: List("alias"), kind: { present: true, kind: UnspecifiedKind }, passive: { present: false, passive: UnspecifiedPassive }, identity: keptKeys, worldKeys: keptKeys },
  { canonical: "mail", aliases: List("alias"), kind: { present: false, kind: UnspecifiedKind }, passive: { present: true, passive: PassiveFalse }, identity: { present: true, defined: true, keys: List("userId", "name") }, worldKeys: keptKeys },
  { canonical: "mail", aliases: List(), kind: { present: false, kind: UnspecifiedKind }, passive: { present: false, passive: UnspecifiedPassive }, identity: keptKeys, worldKeys: { present: true, defined: false, keys: List() } })
pure val emptyMetadata: SourceMetadata = {canonical: "", aliases: List(), kind: UnspecifiedKind, passive: UnspecifiedPassive, identity: List(), hasIdentity: false, worldKeys: List(), hasWorldKeys: false}
pure val emptyOwner: SourceOwner = {owner: "", registrations: List()}
pure def uniqueAliases(xs: List[str]): List[str] = xs.foldl(List(), (acc, alias) => if (acc.includes(alias)) acc else acc.append(alias))
pure def mergeMetadata(base: SourceMetadata, supplied: SourceMetadata): SourceMetadata = { canonical: supplied.canonical, aliases: uniqueAliases(base.aliases.concat(supplied.aliases)), kind: if (supplied.kind == UnspecifiedKind) base.kind else supplied.kind, passive: if (supplied.passive == UnspecifiedPassive) base.passive else supplied.passive, identity: if (supplied.hasIdentity) supplied.identity else base.identity, hasIdentity: base.hasIdentity or supplied.hasIdentity, worldKeys: if (supplied.hasWorldKeys) supplied.worldKeys else base.worldKeys, hasWorldKeys: base.hasWorldKeys or supplied.hasWorldKeys }
pure def mergeRegistration(entries: List[SourceMetadata], supplied: SourceMetadata): List[SourceMetadata] = if (entries.some(m => m.canonical == supplied.canonical)) entries.listMap(m => if (m.canonical == supplied.canonical) mergeMetadata(m, supplied) else m) else entries.append(supplied)
pure def mergeOwnerMetadata(entries: List[SourceMetadata], sourceOwner: SourceOwner): List[SourceMetadata] = sourceOwner.registrations.foldl(entries, (acc, registration) => mergeRegistration(acc, registration))
pure def mergedOwners(owners: List[SourceOwner]): List[SourceMetadata] = owners.foldl(List(), (acc, owner) => mergeOwnerMetadata(acc, owner))
pure def putAlias(entries: List[AliasBinding], alias: str, canonical: str): List[AliasBinding] = if (entries.some(b => b.alias == alias)) entries.listMap(b => if (b.alias == alias) {alias: alias, canonical: canonical} else b) else entries.append({alias: alias, canonical: canonical})
pure def mergeAliases(entries: List[AliasBinding], metadata: SourceMetadata): List[AliasBinding] = metadata.aliases.foldl(entries, (acc, alias) => putAlias(acc, alias, metadata.canonical))
pure def rebuiltAliases(metadata: List[SourceMetadata]): List[AliasBinding] = metadata.foldl(List(), (acc, m) => mergeAliases(acc, m))
pure def rebuildSources(owners: List[SourceOwner], s: SourceRegistry): SourceRegistry = {owners: owners, merged: mergedOwners(owners), aliases: rebuiltAliases(mergedOwners(owners))}
pure def ownerEntry(s: SourceRegistry, owner: str): SourceOwner = s.owners.select(o => o.owner == owner).nthOr(0, emptyOwner)
pure def patchedMetadata(prior: SourceMetadata, patch: SourcePatch): SourceMetadata = { canonical: patch.canonical, aliases: uniqueAliases(prior.aliases.concat(uniqueAliases(List(patch.canonical).concat(patch.aliases)))), kind: if (patch.kind.present) patch.kind.kind else prior.kind, passive: if (patch.passive.present) patch.passive.passive else prior.passive, identity: if (patch.identity.present) patch.identity.keys else prior.identity, hasIdentity: if (patch.identity.present) patch.identity.defined else prior.hasIdentity, worldKeys: if (patch.worldKeys.present) patch.worldKeys.keys else prior.worldKeys, hasWorldKeys: if (patch.worldKeys.present) patch.worldKeys.defined else prior.hasWorldKeys }
pure def canRegisterSource(s: SourceRegistry, owner: str, patch: SourcePatch): bool = owner != "" and patch.canonical != ""
pure def registerSource(s: SourceRegistry, owner: str, patch: SourcePatch): SourceRegistry = {
  val existing = ownerEntry(s, owner)
  val patched = patchedMetadata(existing.registrations.select(m => m.canonical == patch.canonical).nthOr(0, emptyMetadata), patch)
  val ownerEntries = if (existing.registrations.some(m => m.canonical == patch.canonical)) existing.registrations.listMap(m => if (m.canonical == patch.canonical) patched else m) else existing.registrations.append(patched)
  val updated = {owner: owner, registrations: ownerEntries}
  rebuildSources(if (existing.owner == "") s.owners.append(updated) else s.owners.listMap(o => if (o.owner == owner) updated else o), s)
}
pure def alwaysSourceCachesMatchOwners(s: SourceRegistry): bool = s.merged == mergedOwners(s.owners) and s.aliases == rebuiltAliases(s.merged)
pure def alwaysSourceOwnersUnique(s: SourceRegistry): bool = s.owners.every(o => s.owners.select(other => other.owner == o.owner).length() == 1)
pure def sometimesTwoOwnersContribute(s: SourceRegistry): bool = s.owners.length() > 1
```

### Removing an owner rebuilds aliases and metadata from surviving owners

An alias collision follows canonical insertion order during rebuild. Unknown tokens keep their normalized spelling.

```quint
pure def canRemoveSourceOwner(s: SourceRegistry, owner: str): bool = owner != ""
pure def removeSourceOwner(s: SourceRegistry, owner: str): SourceRegistry = rebuildSources(s.owners.select(o => o.owner != owner), s)
pure def canonicalSource(s: SourceRegistry, token: str): str = s.aliases.select(b => b.alias == token).nthOr(0, {alias: token, canonical: token}).canonical
pure def sourceMetadata(s: SourceRegistry, token: str): SourceMetadata = s.merged.select(m => m.canonical == canonicalSource(s, token)).nthOr(0, emptyMetadata)
pure def passiveSource(s: SourceRegistry, token: str): bool = sourceMetadata(s, token).passive == PassiveTrue or sourceMetadata(s, token).kind == PassiveKind
pure def aliasKeysUnique(bindings: List[AliasBinding]): bool = bindings.every(b => bindings.select(other => other.alias == b.alias).length() == 1)
pure def alwaysAliasesUnique(s: SourceRegistry): bool = aliasKeysUnique(s.aliases)
pure def sometimesAllSourceOwnersRemoved(s: SourceRegistry): bool = s.owners.length() == 0 and s.merged.length() == 0 and s.aliases.length() == 0
```
