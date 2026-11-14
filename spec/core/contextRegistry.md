# Atomic context taxonomy

`runtime/context-registry.ts` owns the context definition graph. The registry stores normalized IDs, parents, subcontexts and aliases in insertion order. The normalization boundary is exact: trim, lowercase, replace each whitespace/hyphen run with `_`; list normalization expands the six finance/crypto aliases in `runtime/context-normalization.ts` and removes duplicates preserving first occurrence. The graph model consumes those canonical records. Other definition properties are retained as immutable `body` data.

## Story: Register an internally consistent context graph

As a host or plugin, I can register a mutually referencing batch atomically. A duplicate ID, unknown edge or cycle rejects the whole batch and preserves all prior definitions. An idempotent batch skips existing IDs, but duplicate IDs among its new records still reject the batch.

### Graph validation precedes replacement of the live map

Parent edges point from parent to child; subcontext edges point from the definition to its subcontext. Reachability is computed by finite vertex elimination over the entire candidate graph, so a directed self-edge or any longer cycle is rejected. Empty normalized IDs follow the source behavior and are not forbidden by an invented validation rule. Empty references are ignored by graph validation as in the source's Boolean filter.

```quint
type ContextEdge = { source: str, target: str }
type ContextGate = { present: bool, roles: Set[str], anyOf: Set[str], allOf: Set[str], noneOf: Set[str], minimum: str }
type ContextDefinition = { id: str, parents: List[str], subcontexts: List[str], aliases: List[str], gate: ContextGate, body: str }
type RegistryResult = RegistryIdle | RegistryUpdated | DuplicateContext | UnknownContext | ContextCycle
type ContextRegistry = { definitions: List[ContextDefinition], resultKind: RegistryResult, added: List[str], skipped: List[str] }
pure val emptyGate: ContextGate = { present: false, roles: Set(), anyOf: Set(), allOf: Set(), noneOf: Set(), minimum: "" }
pure val initial: ContextRegistry = { definitions: List(), resultKind: RegistryIdle, added: List(), skipped: List() }
pure val noEdges: List[ContextEdge] = List()
pure def addEdge(edges: List[ContextEdge], source: str, target: str): List[ContextEdge] = if (edges.some(edge => edge.source == source and edge.target == target)) edges else edges.append({ source: source, target: target })
pure def addDefinitionEdges(edges: List[ContextEdge], definition: ContextDefinition): List[ContextEdge] = {
  val parentEdges = definition.parents.foldl(edges, (found, parent) => if (parent == "") found else addEdge(found, parent, definition.id))
  val childEdges = definition.subcontexts.foldl(noEdges, (found, child) => if (child == "") found else addEdge(found, definition.id, child))
  childEdges.foldl(parentEdges, (found, edge) => addEdge(found, edge.source, edge.target))
}
pure def graphEdges(definitions: List[ContextDefinition]): List[ContextEdge] = definitions.foldl(noEdges, (edges, definition) => addDefinitionEdges(edges, definition))
pure def throughVertex(edges: List[ContextEdge], vertex: str): List[ContextEdge] = edges.foldl(edges, (paths, left) => if (left.target != vertex) paths else edges.foldl(paths, (extended, right) => if (right.source == vertex) addEdge(extended, left.source, right.target) else extended))
pure def graphReachability(definitions: List[ContextDefinition]): List[ContextEdge] = definitions.foldl(graphEdges(definitions), (paths, definition) => throughVertex(paths, definition.id))
pure def uniqueIds(definitions: List[ContextDefinition]): bool = definitions.every(definition => definitions.select(other => other.id == definition.id).length() == 1)
pure def knownEdges(definitions: List[ContextDefinition]): bool = graphEdges(definitions).every(edge => definitions.some(definition => definition.id == edge.source) and definitions.some(definition => definition.id == edge.target))
pure def acyclic(definitions: List[ContextDefinition]): bool = graphReachability(definitions).every(edge => edge.source != edge.target)
pure def candidateDefinitions(s: ContextRegistry, incoming: List[ContextDefinition], idempotent: bool): List[ContextDefinition] = s.definitions.concat(if (idempotent) incoming.select(definition => not(s.definitions.some(prior => prior.id == definition.id))) else incoming)
pure def registerMany(s: ContextRegistry, incoming: List[ContextDefinition], idempotent: bool): ContextRegistry = {
  val candidate = candidateDefinitions(s, incoming, idempotent)
  val status = if (not(uniqueIds(candidate))) DuplicateContext else if (not(knownEdges(candidate))) UnknownContext else if (not(acyclic(candidate))) ContextCycle else RegistryUpdated
  { ...s, definitions: if (status == RegistryUpdated) candidate else s.definitions, resultKind: status, added: if (status == RegistryUpdated) incoming.select(definition => not(s.definitions.some(prior => prior.id == definition.id))).listMap(definition => definition.id) else List(), skipped: if (status == RegistryUpdated and idempotent) incoming.select(definition => s.definitions.some(prior => prior.id == definition.id)).listMap(definition => definition.id) else List() }
}
pure def alwaysValidGraph(s: ContextRegistry): bool = uniqueIds(s.definitions) and knownEdges(s.definitions) and acyclic(s.definitions)
pure def sameGate(left: ContextGate, right: ContextGate): bool = left.present == right.present and left.minimum == right.minimum and left.roles.subseteq(right.roles) and right.roles.subseteq(left.roles) and left.anyOf.subseteq(right.anyOf) and right.anyOf.subseteq(left.anyOf) and left.allOf.subseteq(right.allOf) and right.allOf.subseteq(left.allOf) and left.noneOf.subseteq(right.noneOf) and right.noneOf.subseteq(left.noneOf)
pure def sameDefinition(left: ContextDefinition, right: ContextDefinition): bool = left.id == right.id and left.parents == right.parents and left.subcontexts == right.subcontexts and left.aliases == right.aliases and left.body == right.body and sameGate(left.gate, right.gate)
pure def stepRejectedBatchPreservesRegistry(before: ContextRegistry, after: ContextRegistry): bool = after.resultKind != RegistryUpdated implies before.definitions.listMap(definition => definition.id) == after.definitions.listMap(definition => definition.id) and before.definitions.every(definition => after.definitions.some(other => sameDefinition(definition, other)))
pure def stepExistingDefinitionsNeverChange(before: ContextRegistry, after: ContextRegistry): bool = before.definitions.every(definition => after.definitions.some(other => sameDefinition(definition, other))) and before.definitions.listMap(definition => definition.id) == after.definitions.select(definition => before.definitions.some(prior => prior.id == definition.id)).listMap(definition => definition.id)
pure val incomingValues: Set[List[ContextDefinition]] = Set(List({ id: "root", parents: List(), subcontexts: List(), aliases: List(), gate: emptyGate, body: "root-data" }), List({ id: "root", parents: List(), subcontexts: List("leaf"), aliases: List(), gate: emptyGate, body: "root-data" }, { id: "leaf", parents: List("root"), subcontexts: List(), aliases: List(), gate: emptyGate, body: "leaf-data" }), List({ id: "root", parents: List("root"), subcontexts: List(), aliases: List(), gate: emptyGate, body: "cycle-data" }), List({ id: "leaf", parents: List("absent"), subcontexts: List(), aliases: List(), gate: emptyGate, body: "unknown-data" }))
pure def sometimesBatchRegistered(s: ContextRegistry): bool = s.definitions.length() > 1 and s.resultKind == RegistryUpdated
pure def sometimesCycleRejected(s: ContextRegistry): bool = s.resultKind == ContextCycle
```

### Available contexts preserve insertion order and apply every role gate clause

Role normalization trims and uppercases, with `USER` canonicalized to `MEMBER`. Unknown roles retain their normalized identity and have rank zero. `noneOf` denies before all other clauses; minimum rank, combined roles/anyOf, and allOf must each pass. An absent gate permits all callers. Aliases remain metadata and never create extra graph vertices.

```quint
pure def roleRank(role: str): int = if (role == "OWNER") 4 else if (role == "ADMIN") 3 else if (role == "MEMBER") 2 else if (role == "GUEST") 1 else 0
pure def highestRoleRank(roles: Set[str]): int = if (roles.contains("OWNER")) 4 else if (roles.contains("ADMIN")) 3 else if (roles.contains("MEMBER")) 2 else if (roles.contains("GUEST")) 1 else 0
pure def roleGateAllows(roles: Set[str], gate: ContextGate): bool = not(gate.present) or (roles.intersect(gate.noneOf).size() == 0 and (gate.minimum == "" or highestRoleRank(roles) >= roleRank(gate.minimum)) and (gate.roles.union(gate.anyOf).size() == 0 or roles.intersect(gate.roles.union(gate.anyOf)).size() > 0) and gate.allOf.subseteq(roles))
pure def availableContexts(s: ContextRegistry, roles: Set[str]): List[str] = s.definitions.select(definition => roleGateAllows(roles, definition.gate)).listMap(definition => definition.id)
pure def lawDeniedRoleCannotPass(roles: Set[str], gate: ContextGate): bool = (gate.present and roles.intersect(gate.noneOf).size() > 0) implies not(roleGateAllows(roles, gate))
pure val rolesValues = Set(Set(), Set("MEMBER"), Set("ADMIN"), Set("OWNER", "GUEST"))
pure val gateValues = Set(emptyGate, { present: true, roles: Set("OWNER"), anyOf: Set("ADMIN"), allOf: Set(), noneOf: Set("GUEST"), minimum: "ADMIN" })
```
