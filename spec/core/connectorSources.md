# Owner-scoped connector source metadata

The process-level source registry retains owner insertion order, merges aliases, and rebuilds canonical lookup after every registration change. This state model consumes canonical lowercase trimmed tokens from the source normalization contract. Source [connectors.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/connectors.ts).

## Story: Register connector aliases without clobbering other owners

As a connector plugin I contribute source aliases and metadata, and unloading my owner restores the remaining contributions.

### Owner registration merges aliases and replaces only supplied metadata fields

Owners retain insertion order. Presence flags distinguish an omitted field from an explicit undefined value that clears the owner's prior value. Owner merging then uses the last defined value across owners.

```quint
type SourceKind = UnspecifiedKind | ActiveKind | PassiveKind
type PassiveValue = UnspecifiedPassive | PassiveTrue | PassiveFalse
type SourceMetadata = { canonical: str, aliases: List[str], kind: SourceKind, passive: PassiveValue, identity: List[str], hasIdentity: bool, worldKeys: List[str], hasWorldKeys: bool }
type SourceOwner = { owner: str, registrations: List[SourceMetadata] }
type AliasBinding = { alias: str, canonical: str }
type SourceRegistry = { owners: List[SourceOwner], merged: List[SourceMetadata], aliases: List[AliasBinding] }
pure val initial: SourceRegistry = { owners: List(), merged: List(), aliases: List() }
pure val canonicalValues = Set("chat", "mail")
pure val ownerValues = Set("manual", "plugin-a", "plugin-b")
pure val aliasesValues = Set(List("chat"), List("alias"), List("mail", "alias"))
pure val identityValues = Set(List(), List("userId"), List("userId", "name"))
pure val worldKeysValues = Set(List(), List("guildId", "channelId"))
pure val emptyMetadata: SourceMetadata = {canonical: "", aliases: List(), kind: UnspecifiedKind, passive: UnspecifiedPassive, identity: List(), hasIdentity: false, worldKeys: List(), hasWorldKeys: false}
pure val emptyOwner: SourceOwner = {owner: "", registrations: List()}
pure def concatAliases(left: List[str], right: List[str]): List[str] = right.foldl(left, (acc, alias) => acc.append(alias))
pure def uniqueAliases(xs: List[str]): List[str] = xs.foldl(List(), (acc, alias) => if (acc.includes(alias)) acc else acc.append(alias))
pure def mergeMetadata(base: SourceMetadata, supplied: SourceMetadata): SourceMetadata = { canonical: supplied.canonical, aliases: uniqueAliases(concatAliases(base.aliases, supplied.aliases)), kind: if (supplied.kind == UnspecifiedKind) base.kind else supplied.kind, passive: if (supplied.passive == UnspecifiedPassive) base.passive else supplied.passive, identity: if (supplied.hasIdentity) supplied.identity else base.identity, hasIdentity: base.hasIdentity or supplied.hasIdentity, worldKeys: if (supplied.hasWorldKeys) supplied.worldKeys else base.worldKeys, hasWorldKeys: base.hasWorldKeys or supplied.hasWorldKeys }
pure def mergeRegistration(entries: List[SourceMetadata], supplied: SourceMetadata): List[SourceMetadata] = if (entries.some(m => m.canonical == supplied.canonical)) entries.listMap(m => if (m.canonical == supplied.canonical) mergeMetadata(m, supplied) else m) else entries.append(supplied)
pure def mergeOwnerMetadata(entries: List[SourceMetadata], sourceOwner: SourceOwner): List[SourceMetadata] = sourceOwner.registrations.foldl(entries, (acc, registration) => mergeRegistration(acc, registration))
pure def mergedOwners(owners: List[SourceOwner]): List[SourceMetadata] = owners.foldl(List(), (acc, owner) => mergeOwnerMetadata(acc, owner))
pure def putAlias(entries: List[AliasBinding], alias: str, canonical: str): List[AliasBinding] = if (entries.some(b => b.alias == alias)) entries.listMap(b => if (b.alias == alias) {alias: alias, canonical: canonical} else b) else entries.append({alias: alias, canonical: canonical})
pure def mergeAliases(entries: List[AliasBinding], metadata: SourceMetadata): List[AliasBinding] = metadata.aliases.foldl(entries, (acc, alias) => putAlias(acc, alias, metadata.canonical))
pure def rebuiltAliases(metadata: List[SourceMetadata]): List[AliasBinding] = metadata.foldl(List(), (acc, m) => mergeAliases(acc, m))
pure def rebuildSources(owners: List[SourceOwner], s: SourceRegistry): SourceRegistry = {owners: owners, merged: mergedOwners(owners), aliases: rebuiltAliases(mergedOwners(owners))}
pure def ownerEntry(s: SourceRegistry, owner: str): SourceOwner = s.owners.select(o => o.owner == owner).nthOr(0, emptyOwner)
pure def canRegisterSource(s: SourceRegistry, owner: str, canonical: str, aliases: List[str], kind: SourceKind, passive: PassiveValue, identity: List[str], hasIdentity: bool, worldKeys: List[str], hasWorldKeys: bool, kindPresent: bool, passivePresent: bool, identityPresent: bool, worldKeysPresent: bool): bool = owner != "" and canonical != ""
pure def registerSource(s: SourceRegistry, owner: str, canonical: str, aliases: List[str], kind: SourceKind, passive: PassiveValue, identity: List[str], hasIdentity: bool, worldKeys: List[str], hasWorldKeys: bool, kindPresent: bool, passivePresent: bool, identityPresent: bool, worldKeysPresent: bool): SourceRegistry = {
  val supplied = {canonical: canonical, aliases: uniqueAliases(List(canonical).concat(aliases)), kind: kind, passive: passive, identity: identity, hasIdentity: hasIdentity, worldKeys: worldKeys, hasWorldKeys: hasWorldKeys}
  val existing = ownerEntry(s, owner)
  val prior = existing.registrations.select(m => m.canonical == canonical).nthOr(0, emptyMetadata)
  val patched = {canonical: canonical, aliases: uniqueAliases(concatAliases(prior.aliases, supplied.aliases)), kind: if (kindPresent) kind else prior.kind, passive: if (passivePresent) passive else prior.passive, identity: if (identityPresent) identity else prior.identity, hasIdentity: if (identityPresent) hasIdentity else prior.hasIdentity, worldKeys: if (worldKeysPresent) worldKeys else prior.worldKeys, hasWorldKeys: if (worldKeysPresent) hasWorldKeys else prior.hasWorldKeys}
  val ownerEntries = if (existing.registrations.some(m => m.canonical == canonical)) existing.registrations.listMap(m => if (m.canonical == canonical) patched else m) else existing.registrations.append(patched)
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
