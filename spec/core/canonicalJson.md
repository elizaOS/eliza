# Canonical JSON value traversal

Source `canonical-json.ts` preserves existing digest bytes while guarding reflection, recursive depth, total visits and outputCount characters. `CanonicalJsonOptions` retains caller-selected sparse-hole rendering and the typed `onUnbounded` callback. `stableJsonString` returns absence for an invisible root value, while `canonicalJsonString` renders it as null.

## Story: Hash the same snapshot safely and deterministically

As a backup or integrity consumer, I want stable bytes from a descriptor-only snapshot without executing getters or confusing a shared reference with a cycle.

### Every traversal reserves its work before inspecting a new container

The walk charges key breadth before descriptor traps, snapshot allocation or sorting. Array length is a single own data-descriptor read, and an externally captured root length is reused. A repeated reference is valid after its ancestor frame exits. An ancestor reference is a cycle and produces the typed failure. Object keys use ascending UTF-16 lexical order.

```quint
type JsonWalk = { ancestors: List[int], visits: int, outputCount: int, maxVisits: int, maxOutput: int, outputBounded: bool, maxDepth: int, rejected: bool }
pure val initial: JsonWalk = { ancestors: List(), visits: 0, outputCount: 0, maxVisits: 0, maxOutput: 0, outputBounded: false, maxDepth: 0, rejected: false }
pure def canConfigure(j: JsonWalk, maxVisits: int, maxOutput: int, outputBounded: bool, maxDepth: int): bool = j.visits == 0 and j.outputCount == 0 and j.ancestors.length() == 0 and not(j.rejected) and maxVisits >= 0 and maxOutput >= 0 and maxDepth >= 0
pure def configure(j: JsonWalk, maxVisits: int, maxOutput: int, outputBounded: bool, maxDepth: int): JsonWalk = { ...j, maxVisits: maxVisits, maxOutput: maxOutput, outputBounded: outputBounded, maxDepth: maxDepth }
pure def canReserve(j: JsonWalk, visits: int, outputCount: int): bool = not(j.rejected) and visits >= 0 and outputCount >= 0 and visits <= j.maxVisits - j.visits and (not(j.outputBounded) or outputCount <= j.maxOutput - j.outputCount)
pure def reserve(j: JsonWalk, visits: int, outputCount: int): JsonWalk = { ...j, visits: j.visits + visits, outputCount: j.outputCount + outputCount }
pure def canEnter(j: JsonWalk, identity: int): bool = not(j.rejected) and not(j.ancestors.includes(identity)) and j.ancestors.length() <= j.maxDepth
pure def enter(j: JsonWalk, identity: int): JsonWalk = { ...j, ancestors: j.ancestors.append(identity) }
pure def canLeave(j: JsonWalk): bool = not(j.rejected) and j.ancestors.length() > 0
pure def leave(j: JsonWalk): JsonWalk = { ...j, ancestors: j.ancestors.removeAt(j.ancestors.length() - 1) }
pure def canReject(j: JsonWalk): bool = not(j.rejected)
pure def reject(j: JsonWalk): JsonWalk = { ...j, rejected: true }
pure def alwaysTraversalWithinBudgets(j: JsonWalk): bool = j.visits >= 0 and j.visits <= j.maxVisits and j.outputCount >= 0 and (not(j.outputBounded) or j.outputCount <= j.maxOutput) and j.ancestors.length() <= j.maxDepth + 1
pure def stepRejectedWalkRemainsRejected(before: JsonWalk, after: JsonWalk): bool = before.rejected implies after.rejected
pure def sometimesContainerVisited(j: JsonWalk): bool = j.ancestors.length() > 0
pure def sometimesTypedRejection(j: JsonWalk): bool = j.rejected
```

### Object invisibles are omitted while array invisibles become null

Enumerable accessors are rejected. Non-enumerable properties and symbol keys are omitted. BigInt is rejected. An array hole follows the caller's historical policy, while an existing undefined, function or symbol element emits null in either policy.

```quint
type JsonProperty = DataValue | InvisibleValue | AccessorValue | NonEnumerableValue | SymbolKey | BigIntValue | SparseHole
type JsonDisposition = EmitValue | EmitNull | OmitValue | RejectValue
pure def objectDisposition(property: JsonProperty): JsonDisposition = if (property == AccessorValue or property == BigIntValue) RejectValue else if (property == InvisibleValue or property == NonEnumerableValue or property == SymbolKey or property == SparseHole) OmitValue else EmitValue
pure def arrayDisposition(property: JsonProperty, holesAsNull: bool): JsonDisposition = if (property == AccessorValue or property == BigIntValue) RejectValue else if (property == SparseHole) { if (holesAsNull) EmitNull else OmitValue } else if (property == InvisibleValue) EmitNull else EmitValue
pure def lawObjectGetterRejected(property: JsonProperty): bool = property == AccessorValue implies objectDisposition(property) == RejectValue
pure def lawInvisibleArrayIsNull(holesAsNull: bool): bool = arrayDisposition(InvisibleValue, holesAsNull) == EmitNull
pure def lawSparsePolicyPreserved(holesAsNull: bool): bool = arrayDisposition(SparseHole, holesAsNull) == (if (holesAsNull) EmitNull else OmitValue)
```
