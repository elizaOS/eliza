# Target source and interaction profile registries

`connectors/target-sources.ts` stores platform enumerators by their exact supplied platform key. `messaging/interaction-profiles.ts` stores canonical capability profiles by profile ID and rejects conflicting canonical fingerprints. They are separate registry instances with different collision policies.

## Story: Register targets and stable capability profiles

### Target sources replace in place and profile collisions preserve the incumbent

Target source registration uses exact platform strings, without implicit trimming or case folding. Replacing a key preserves its insertion position; deleting and re-registering appends it. Stop clears all target sources but does not disable subsequent registration. Profile registration canonicalizes and fingerprints before mutation, returns a fresh clone, accepts identical replay, and rejects a changed body under an existing ID. Canonical profile schema and stable serialization are explicit boundary contracts in the pinned source.

```quint
type TargetSource = { platform: str, reference: int }
type InteractionProfile = { id: str, fingerprint: str, body: str }
type ConnectorRegistries = { sources: List[TargetSource], profiles: List[InteractionProfile], profileCollision: bool, returnedReference: int }
pure val initial: ConnectorRegistries = { sources: List(), profiles: List(), profileCollision: false, returnedReference: 0 }
pure def registerSource(s: ConnectorRegistries, platform: str, reference: int): ConnectorRegistries = { ...s, sources: if (s.sources.some(source => source.platform == platform)) s.sources.listMap(source => if (source.platform == platform) { platform: platform, reference: reference } else source) else s.sources.append({ platform: platform, reference: reference }) }
pure def unregisterSource(s: ConnectorRegistries, platform: str): ConnectorRegistries = { ...s, sources: s.sources.select(source => source.platform != platform) }
pure def stopSources(s: ConnectorRegistries): ConnectorRegistries = { ...s, sources: List() }
pure def registerProfile(s: ConnectorRegistries, id: str, fingerprint: str, body: str): ConnectorRegistries = {
  val existing = s.profiles.select(profile => profile.id == id)
  val collision = existing.some(profile => profile.fingerprint != fingerprint)
  { ...s, profiles: if (existing.length() == 0) s.profiles.append({ id: id, fingerprint: fingerprint, body: body }) else s.profiles, profileCollision: collision, returnedReference: if (collision) s.returnedReference else s.returnedReference + 1 }
}
pure def alwaysRegistryKeysUnique(s: ConnectorRegistries): bool = s.sources.every(source => s.sources.select(other => other.platform == source.platform).length() == 1) and s.profiles.every(profile => s.profiles.select(other => other.id == profile.id).length() == 1)
pure def stepProfilesNeverReplace(before: ConnectorRegistries, after: ConnectorRegistries): bool = before.profiles.every(profile => after.profiles.includes(profile))
pure def stepSourceStopLeavesProfiles(before: ConnectorRegistries, via: str, after: ConnectorRegistries): bool = via == "stopSources" implies after.sources.length() == 0 and after.profiles == before.profiles
pure def sometimesProfileCollision(s: ConnectorRegistries): bool = s.profileCollision and s.profiles.length() > 0
pure val platformValues = Set("chat", "Chat", " chat ")
pure val referenceValues = Set(1, 2)
pure val idValues = Set("profile1", "profile2")
pure val fingerprintValues = Set("fingerprint1", "fingerprint2")
pure val bodyValues = Set("canonicalBody1", "canonicalBody2")
```
