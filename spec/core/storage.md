# Persistence and immutable source publication

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/database.ts`, `types/database.ts`, `types/environment.ts`, `types/memory.ts`, `database/document-source-segments.ts`, `database/world-metadata-cas.ts`, and `database/cache-cas.ts`. Concrete adapters own transactions and durable I/O. The replacement preserves batch-first CRUD for agents, entities, components, worlds, rooms, participants, relationships, memories, logs, tasks, pairing and connector accounts. Optional unsupported capabilities retain observable failure outcomes. The model below specifies publication and query consistency shared by those records.

## Story: Publish complete immutable source revisions

As a reader, I observe a head only after every referenced immutable dependency exists. A concurrent replacement cannot overwrite the revision I read. Byte, line and fragment pagination restores exact authorized source data and reauthorizes the parent on every page. Media remains content-addressed and source rows retain their references.

### A transaction stages dependencies while the visible head stays unchanged

The current revision and prior committed dependencies remain available while the next write is in flight. Missing source dependencies prevent publication. This model uses numeric revision tokens, with zero representing an absent head.

```quint
type StorePhase = Ready | Staging | Published | Conflicted | Failed
type Store = { phase: StorePhase, revision: int, observedRevision: int, stagedIds: Set[str], requiredIds: Set[str], headIds: Set[str], commits: int, durableCommits: int, authorizedRead: bool, exposedRevision: int }
pure val initial: Store = { phase: Ready, revision: 0, observedRevision: 0, stagedIds: Set(), requiredIds: Set(), headIds: Set(), commits: 0, durableCommits: 0, authorizedRead: false, exposedRevision: 0 }
pure def canBegin(s: Store, requiredIds: Set[str]): bool = s.phase != Staging
pure def begin(s: Store, requiredIds: Set[str]): Store = { ...s, phase: Staging, observedRevision: s.revision, stagedIds: Set(), requiredIds: requiredIds, authorizedRead: false, exposedRevision: 0 }
pure val requiredIdsValues = Set(Set(), Set("segment1"), Set("segment1", "segment2"), Set("segment1", "segment2", "segment3"))
pure val idValues = Set("segment1", "segment2", "segment3", "unrelated")
pure def canStage(s: Store, id: str): bool = s.phase == Staging and s.requiredIds.contains(id) and not(s.stagedIds.contains(id))
pure def stage(s: Store, id: str): Store = { ...s, stagedIds: s.stagedIds.union(Set(id)) }
pure def alwaysStagedIdentitiesMatchManifest(s: Store): bool = s.revision >= 0 and s.observedRevision >= 0 and s.stagedIds.subseteq(s.requiredIds)
```

### Publication commits the complete dependency set and head atomically

An intervening durable writer changes the revision. The modeled writer then reports conflict. Failed and conflicting writes cannot advance the visible head.

```quint
pure def canPublish(s: Store): bool = s.phase == Staging and s.observedRevision == s.revision and s.requiredIds.subseteq(s.stagedIds)
pure def publish(s: Store): Store = { ...s, phase: Published, revision: s.revision + 1, headIds: s.requiredIds, commits: s.commits + 1, durableCommits: s.durableCommits + 1, authorizedRead: false, exposedRevision: 0 }
pure def canConcurrentWrite(s: Store): bool = s.phase == Staging
pure def concurrentWrite(s: Store): Store = { ...s, revision: s.revision + 1, authorizedRead: false, exposedRevision: 0 }
pure def canConflict(s: Store): bool = s.phase == Staging and s.observedRevision != s.revision
pure def conflict(s: Store): Store = { ...s, phase: Conflicted }
pure def canRecordFailure(s: Store): bool = s.phase == Staging
pure def recordFailure(s: Store): Store = { ...s, phase: Failed }
pure def alwaysPublicationHasDurability(s: Store): bool = s.commits == s.durableCommits and s.commits >= 0
pure def stepCompleteDependenciesPrecedePublication(before: Store, via: str, after: Store): bool =
  via != "publish" or (before.requiredIds.subseteq(before.stagedIds) and before.observedRevision == before.revision and after.headIds.subseteq(before.requiredIds) and before.requiredIds.subseteq(after.headIds))
pure def stepFailedWritePreservesHead(before: Store, via: str, after: Store): bool =
  (via != "recordFailure" and via != "conflict") or (before.revision == after.revision and before.headIds.subseteq(after.headIds) and after.headIds.subseteq(before.headIds))
pure def sometimesCompletePublication(s: Store): bool = s.phase == Published and s.headIds.contains("segment1") and s.headIds.contains("segment2")
pure def sometimesConcurrentConflict(s: Store): bool = s.phase == Conflicted
```

### Every page read checks current authorization and expected revision

A stale or unauthorized request exposes no source page. Authorization evidence comes from the current storage boundary. Ordering, ranking and pagination happen only after scope filtering. Legacy context omission remains a separately authorized caller mode.

```quint
pure def read(s: Store, authorized: bool, expectedRevision: int): Store =
  if (authorized and expectedRevision == s.revision and s.revision > 0) { ...s, authorizedRead: true, exposedRevision: s.revision }
  else { ...s, authorizedRead: false, exposedRevision: 0 }
pure val expectedRevisionValues = Set(-1, 0, 1, 2, 3)
pure def alwaysExposedPageHasCurrentAuthority(s: Store): bool = s.exposedRevision > 0 implies (s.authorizedRead and s.exposedRevision == s.revision)
pure def sometimesAuthorizedPage(s: Store): bool = s.exposedRevision > 0
```

## Story: Preserve storage compatibility without hiding unsupported operations

As an adapter author, I can implement the canonical batch contract and declare atomic capabilities explicitly. Empty results remain valid successful reads. Operational failure remains typed failure. Legacy rows with missing revisions start at zero. Malformed revisions and stale whole-world writes fail before mutation. Component natural keys retain entity, type, world and source entity.

### Revisions and pagination reject invalid numeric inputs

```quint
pure def validPagination(limit: int, offset: int): bool = limit >= 0 and offset >= 0
pure def revisionMatches(stored: int, supplied: int): bool = stored >= 0 and supplied >= 0 and stored == supplied
pure def lawNegativePaginationIsRejected(offset: int): bool = not(validPagination(-1, offset))
pure def lawStaleRevisionIsRejected(stored: int, supplied: int): bool = stored != supplied implies not(revisionMatches(stored, supplied))
```

### Composite component identity keeps worlds and source entities distinct

```quint
type ComponentKey = { entityId: str, componentType: str, worldId: str, sourceEntityId: str }
pure val leftValues = Set({ entityId: "entity1", componentType: "profile", worldId: "world1", sourceEntityId: "source1" }, { entityId: "entity1", componentType: "profile", worldId: "world2", sourceEntityId: "source2" })
pure val rightValues = leftValues
pure def sameComponent(left: ComponentKey, right: ComponentKey): bool = left == right
pure def lawDifferentWorldsHaveDifferentComponents(left: ComponentKey, right: ComponentKey): bool = left.worldId != right.worldId implies not(sameComponent(left, right))
pure def lawDifferentSourcesHaveDifferentComponents(left: ComponentKey, right: ComponentKey): bool = left.sourceEntityId != right.sourceEntityId implies not(sameComponent(left, right))
```
