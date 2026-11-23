# Relationship graph

## Story: Resolve people and manage the graph inside my agent

> As an owner, I can open the graph, inspect relationships, and merge duplicate identities in my agent while keeping identity attribution explicit.

### Identity evidence is scoped by tenant and namespace before it can resolve a person

The boundary canonicalizes the identity in its original provider namespace. It binds the tenant through the authenticated agent and storage scope. Matching multiple distinct entity IDs leaves resolution ambiguous.

```quint
type GraphIdentity = { tenant: str, entity: str, identitySource: str, identityValue: str }
pure def findIdentity(rows: List[GraphIdentity], tenant: str, identitySource: str, identityValue: str): Set[str] =
  rows.select(row => row.tenant == tenant and row.identitySource == identitySource and row.identityValue == identityValue)
    .foldl(Set(), (ids, row) => ids.union(Set(row.entity)))
pure def identityResolved(rows: List[GraphIdentity], tenant: str, identitySource: str, identityValue: str): bool =
  tenant != "" and identitySource != "" and identityValue != "" and findIdentity(rows, tenant, identitySource, identityValue).size() == 1
pure def lawAbsentEvidenceCannotResolve(tenant: str, identitySource: str, identityValue: str): bool =
  not(identityResolved(List(), tenant, identitySource, identityValue))
```

### The two endpoints of a relationship must belong to the requested tenant

```quint
type GraphEntity = { space: str, entityId: str, entityName: str }
type GraphEdge = { edgeSpace: str, fromId: str, toId: str, relation: str }
pure def hasEntity(entities: List[GraphEntity], tenant: str, entityId: str): bool =
  entities.some(entity => entity.space == tenant and entity.entityId == entityId)
pure def relationshipVisible(edge: GraphEdge, entities: List[GraphEntity], tenant: str): bool =
  edge.edgeSpace == tenant and hasEntity(entities, tenant, edge.fromId) and hasEntity(entities, tenant, edge.toId)
pure def graphFor(edges: List[GraphEdge], entities: List[GraphEntity], tenant: str): List[GraphEdge] =
  edges.select(edge => relationshipVisible(edge, entities, tenant))
pure def lawVisibleRelationshipsStayInTenant(edges: List[GraphEdge], entities: List[GraphEntity], tenant: str): bool =
  graphFor(edges, entities, tenant).every(edge => edge.edgeSpace == tenant)
```

### Merging duplicates retargets the edges of that tenant and preserves other tenants

The store rewrites the entity, its aliases and edges in one transaction. Source IDs must be distinct from the existing target and resolve within the tenant. Retargeting policies for duplicate or self edges run inside the transaction.

```quint
pure def mayMergeEntities(entities: List[GraphEntity], tenant: str, targetId: str, sourceIds: Set[str]): bool =
  tenant != "" and sourceIds.size() > 0 and not(sourceIds.contains(targetId)) and
  hasEntity(entities, tenant, targetId) and sourceIds.forall(sourceId => hasEntity(entities, tenant, sourceId))
pure def redirectMergedEdge(edge: GraphEdge, tenant: str, targetId: str, sourceIds: Set[str]): GraphEdge =
  if (edge.edgeSpace != tenant) edge
  else { ...edge,
    fromId: if (sourceIds.contains(edge.fromId)) targetId else edge.fromId,
    toId: if (sourceIds.contains(edge.toId)) targetId else edge.toId }
pure def lawMergeCannotRetargetAnotherTenant(edge: GraphEdge, tenant: str, targetId: str, sourceIds: Set[str]): bool =
  edge.edgeSpace != tenant implies redirectMergedEdge(edge, tenant, targetId, sourceIds) == edge
pure def lawMergeCannotIncludeTheTarget(entities: List[GraphEntity], tenant: str, targetId: str, sourceIds: Set[str]): bool =
  mayMergeEntities(entities, tenant, targetId, sourceIds) implies not(sourceIds.contains(targetId))
pure val edgeValues = Set({ edgeSpace: "owner", fromId: "ada", toId: "grace", relation: "knows" }, { edgeSpace: "other", fromId: "ada", toId: "grace", relation: "follows" })
pure val edgesValues = Set(List(), List({ edgeSpace: "owner", fromId: "ada", toId: "grace", relation: "knows" }, { edgeSpace: "other", fromId: "ada", toId: "grace", relation: "follows" }))
pure val entitiesValues = Set(List(), List({ space: "owner", entityId: "ada", entityName: "Ada" }, { space: "owner", entityId: "grace", entityName: "Grace" }))
```
