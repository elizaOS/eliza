# Entities components and relationship mutations

Sources are `packages/core/src/entities.ts`, `types/environment.ts`,
`runtime/data-mutations.ts` and `runtime.ts` at
`72fed7e4069ecd35d61d886ab6eec5c02c137517`. The complete entity, component,
world, room, participant and relationship declarations are in the public
surface baseline. Database adapters own their storage and transaction
semantics. Runtime mutation wrappers preserve adapter failures and
invalidate their corresponding cached reads after successful completion.

## Story: Show only components from authorized sources

As an agent, I can use components from the message author, the entity
itself, my agent identity, or a source whose current resolved role is
administrative. Cached or stored role claims alone cannot establish a
trusted source. Filtering produces a copy and retains source order.

### Component visibility uses current source identity and trusted roles

`trusted` is produced by resolving each distinct source against the current
world through the authorization module. A missing world yields an empty
trusted set. The component values and their ordering survive projection.

```quint
type EntityComponent = { id: str, entityId: str, sourceId: str, componentType: str, payload: str }
pure def componentVisible(component: EntityComponent, messageAuthor: str, entityId: str, agentId: str, trusted: Set[str]): bool =
  component.sourceId == messageAuthor or component.sourceId == entityId or component.sourceId == agentId or (component.sourceId != "" and trusted.contains(component.sourceId))
pure def visibleComponents(components: List[EntityComponent], messageAuthor: str, entityId: str, agentId: str, trusted: Set[str]): List[EntityComponent] =
  components.select(component => componentVisible(component, messageAuthor, entityId, agentId, trusted))
pure val componentValues = Set({ id: "component", entityId: "entity", sourceId: "sender", componentType: "profile", payload: "complete-data" })
pure val componentsValues = Set(List(), List({ id: "component", entityId: "entity", sourceId: "sender", componentType: "profile", payload: "complete-data" }))
pure def lawMessageAuthorComponentVisible(component: EntityComponent, entityId: str, agentId: str, trusted: Set[str]): bool =
  componentVisible(component, component.sourceId, entityId, agentId, trusted)
pure def lawVisibleComponentsRetainExactData(components: List[EntityComponent], messageAuthor: str, entityId: str, agentId: str, trusted: Set[str]): bool =
  visibleComponents(components, messageAuthor, entityId, agentId, trusted).every(component => components.includes(component))
```

## Story: Observe committed mutations through fresh runtime reads

As a caller, I receive the adapter's result or original error and subsequent
runtime reads invalidate the cache for the data that changed. Bulk memory
calls retain the source contract that callers prepare their content.
Single-memory calls perform the established secret redaction before
publication. Source evidence mutations retain the evaluator's mutation
lease, while embedding-only writes use the adapter's compare-and-swap path.

### Each mutation invalidates exactly the affected cache families

Partial memory updates and deletes invalidate every message window because
the wrapper lacks a reliable old room. Room deletion invalidates its room
read and message windows. Entity deletion also invalidates identity clusters.

```quint
type MutationKind = EntityWrite | EntityDelete | ComponentWrite | ParticipantWrite | RelationshipWrite | RoomWrite | RoomDelete | WorldRoomsDelete | MessageCreate | MessagePartialWrite | EmbeddingWrite
type CachePlan = { entities: bool, clusters: bool, rooms: bool, messages: bool, allRooms: bool, allMessages: bool }
pure def cachePlan(kind: MutationKind): CachePlan = {
  entities: kind == EntityWrite or kind == EntityDelete or kind == ComponentWrite or kind == ParticipantWrite,
  clusters: kind == EntityDelete or kind == RelationshipWrite,
  rooms: kind == RoomWrite or kind == RoomDelete or kind == WorldRoomsDelete,
  messages: kind == RoomDelete or kind == WorldRoomsDelete or kind == MessageCreate or kind == MessagePartialWrite or kind == EmbeddingWrite,
  allRooms: kind == WorldRoomsDelete,
  allMessages: kind == WorldRoomsDelete or kind == MessagePartialWrite
}
pure def lawDeletedEntityInvalidatesIdentity(kind: MutationKind): bool = kind == EntityDelete implies cachePlan(kind).entities and cachePlan(kind).clusters
pure def lawPartialMemoryInvalidatesAllWindows(kind: MutationKind): bool = kind == MessagePartialWrite implies cachePlan(kind).allMessages
pure def lawRoomDeleteInvalidatesBothReads(kind: MutationKind): bool = kind == RoomDelete implies cachePlan(kind).rooms and cachePlan(kind).messages
```

### Adapter failure cannot become a successful mutation result

One mutation call retains its ownership until adapter completion. A false
embedding compare-and-swap result returns false and causes no cache
invalidation. Void-success wrappers still invalidate on a fulfilled adapter
call. The boolean `changed` is the adapter's acknowledged mutation outcome.

```quint
type MutationPhase = Idle | Waiting | Succeeded | Failed
type Mutation = { phase: MutationPhase, kind: MutationKind, changed: bool, invalidated: bool, causeId: str }
pure val initial: Mutation = { phase: Idle, kind: EntityWrite, changed: false, invalidated: false, causeId: "" }
pure def canBeginMutation(m: Mutation, kind: MutationKind): bool = m.phase == Idle
pure def beginMutation(m: Mutation, kind: MutationKind): Mutation = { ...m, phase: Waiting, kind: kind }
pure def canCompleteMutation(m: Mutation, changed: bool): bool = m.phase == Waiting
pure def completeMutation(m: Mutation, changed: bool): Mutation = { ...m, phase: Succeeded, changed: changed, invalidated: m.kind != EmbeddingWrite or changed }
pure def canRejectMutation(m: Mutation, causeId: str): bool = m.phase == Waiting
pure def rejectMutation(m: Mutation, causeId: str): Mutation = { ...m, phase: Failed, causeId: causeId }
pure def alwaysFailureRetainsNoSuccess(m: Mutation): bool = m.phase == Failed implies not(m.changed) and not(m.invalidated)
pure def alwaysSuccessfulWriteInvalidates(m: Mutation): bool = m.phase == Succeeded implies m.invalidated == (m.kind != EmbeddingWrite or m.changed)
```

### A pending adapter call has no completed mutation result

Discovered by the proof: a state with a pending call and an already-set
success flag could make rejection retain a fabricated success. The result
and invalidation flags remain unset until adapter completion.

```quint
pure def alwaysPendingHasNoResult(m: Mutation): bool = (m.phase == Idle or m.phase == Waiting) implies not(m.changed) and not(m.invalidated)
pure def sometimesSuccessfulMutation(m: Mutation): bool = m.phase == Succeeded and m.invalidated
pure def sometimesUnchangedEmbedding(m: Mutation): bool = m.phase == Succeeded and m.kind == EmbeddingWrite and not(m.changed) and not(m.invalidated)
pure def sometimesAdapterFailure(m: Mutation): bool = m.phase == Failed
```
