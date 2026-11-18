# Canonical JSON value traversal

Source `canonical-json.ts` preserves existing digest bytes while guarding reflection, recursive depth, total visits and outputCount characters. `CanonicalJsonOptions` retains caller-selected sparse-hole rendering and the typed `onUnbounded` callback. `stableJsonString` returns absence for an invisible root value, while `canonicalJsonString` renders it as null.

## Story: Hash the same snapshot safely and deterministically

> As a backup or integrity consumer, I want stable bytes from a snapshot
> without running its getters, so that the same data always hashes the
> same way.

### Every traversal reserves its work before inspecting a new container

The root reserves one visit before its value is classified or a container is entered, so a zero visit budget cannot start a walk, and no visit is charged before the root starts. Every value, including a scalar, must satisfy the depth limit before inspection or completion. Entering a container consumes that paid visit, checks depth and ancestor identity, and opens a frame whose extent is not yet read. Only then may the host observe the extent: `Reflect.ownKeys` for an object, or the array's own length data descriptor, read once, reusing an externally captured root length. The caller must take that captured length from `readCanonicalArrayLength` on the same array, so it is a non-negative safe integer like a length the walk reads itself; the source does not check it again, and the model admits only a width of zero or more. The walk charges the complete extent before any per-slot descriptor trap, snapshot allocation or sorting. Symbol and non-enumerable keys and sparse array holes still consume their reserved slots. A slot that descends supplies its child's visit, so recursion does not charge it again. Credits belong to the current frame: a frame is left only when all its slots are consumed, and its credits cannot be reused after it exits.

The next inspection is a capability for the host: no value inspection without a charged value, no extent inspection before the container is entered, and no per-slot inspection before the breadth reservation. A slot step stands for one slot's descriptor read together with its child walk. For an array, the host takes each slot step at that slot's descriptor read, so the read and the child walk alternate. For an object, the host reads every own string key's descriptor, and may reject an accessor, while the frame still holds its whole reservation and no child is charged; it then sorts the snapshot, takes one slot step for each child as that child is walked in sorted order, and consumes the slots of the skipped symbol, non-enumerable and invisible keys after the last child. Reflection, descriptor classification, emitted bytes and typed `onUnbounded` failures remain host conformance boundaries. Output reservation remains independent of visit reservation. A repeated reference is valid after its ancestor frame exits. An ancestor reference is a cycle and produces the typed failure. Object keys use ascending UTF-16 lexical order.

```quint
type JsonBreadth = UnreadBreadth | ObservedBreadth({ width: int }) | ReservedBreadth({ width: int, remaining: int })
type ValueCharge = NoCharge | RootCharge | ChildCharge
type JsonInspection = NoInspection | InspectValue | InspectExtent({ identity: int }) | InspectSlot({ identity: int, remaining: int })
type JsonWalk = { ancestors: List[int], breadths: List[JsonBreadth], charge: ValueCharge, rootStarted: bool, visits: int, outputCount: int, maxVisits: int, maxOutput: int, outputBounded: bool, maxDepth: int, rejected: bool }
pure val initial: JsonWalk = { ancestors: List(), breadths: List(), charge: NoCharge, rootStarted: false, visits: 0, outputCount: 0, maxVisits: 0, maxOutput: 0, outputBounded: false, maxDepth: 0, rejected: false }
pure def topBreadth(j: JsonWalk): JsonBreadth = j.breadths.nthOr(j.breadths.length() - 1, UnreadBreadth)
pure def topIdentity(j: JsonWalk): int = j.ancestors.nthOr(j.ancestors.length() - 1, 0)
pure def replaceTopBreadth(breadth: JsonBreadth, j: JsonWalk): List[JsonBreadth] = j.breadths.removeAt(j.breadths.length() - 1).append(breadth)
pure def isUnreadBreadth(breadth: JsonBreadth): bool = match breadth { | UnreadBreadth => true | _ => false }
pure def isValueInspection(inspection: JsonInspection): bool = match inspection { | InspectValue => true | _ => false }
pure def isNoInspection(inspection: JsonInspection): bool = match inspection { | NoInspection => true | _ => false }
pure def isExtentInspection(inspection: JsonInspection, identity: int): bool = match inspection { | InspectExtent(extent) => extent.identity == identity | _ => false }
pure def isSlotInspection(inspection: JsonInspection, identity: int, remaining: int): bool = match inspection { | InspectSlot(slot) => slot.identity == identity and slot.remaining == remaining | _ => false }
pure def breadthWidth(breadth: JsonBreadth): int = match breadth { | ObservedBreadth(b) => b.width | ReservedBreadth(b) => b.width | _ => 0 }
pure def breadthRemaining(breadth: JsonBreadth): int = match breadth { | ReservedBreadth(b) => b.remaining | _ => 0 }
pure def validBreadth(breadth: JsonBreadth, visits: int): bool = match breadth { | ObservedBreadth(b) => b.width >= 0 | ReservedBreadth(b) => b.width >= 0 and b.width <= visits and b.remaining >= 0 and b.remaining <= b.width | _ => true }
pure def nextInspection(j: JsonWalk): JsonInspection = {
  val breadth = topBreadth(j)
  if (j.rejected) NoInspection else if (j.charge != NoCharge) { if (j.ancestors.length() <= j.maxDepth) InspectValue else NoInspection } else if (j.breadths.length() == 0) NoInspection else match breadth { | UnreadBreadth => InspectExtent({ identity: topIdentity(j) }) | ReservedBreadth(b) => if (b.remaining > 0) InspectSlot({ identity: topIdentity(j), remaining: b.remaining }) else NoInspection | _ => NoInspection }
}
pure def canConfigure(j: JsonWalk, maxVisits: int, maxOutput: int, outputBounded: bool, maxDepth: int): bool = not(j.rootStarted) and j.charge == NoCharge and j.breadths.length() == 0 and j.visits == 0 and j.outputCount == 0 and j.ancestors.length() == 0 and not(j.rejected) and maxVisits >= 0 and maxOutput >= 0 and maxDepth >= 0
pure def configure(j: JsonWalk, maxVisits: int, maxOutput: int, outputBounded: bool, maxDepth: int): JsonWalk = { ...j, maxVisits: maxVisits, maxOutput: maxOutput, outputBounded: outputBounded, maxDepth: maxDepth }
pure def canReserve(j: JsonWalk, visits: int, outputCount: int): bool = not(j.rejected) and visits >= 0 and outputCount >= 0 and visits <= j.maxVisits - j.visits and (not(j.outputBounded) or outputCount <= j.maxOutput - j.outputCount) and (visits == 0 or j.rootStarted)
pure def reserve(j: JsonWalk, visits: int, outputCount: int): JsonWalk = { ...j, visits: j.visits + visits, outputCount: j.outputCount + outputCount }
pure def canStartRoot(j: JsonWalk): bool = not(j.rejected) and not(j.rootStarted) and j.visits < j.maxVisits and j.maxDepth >= 0 and j.ancestors.length() == 0 and j.breadths.length() == 0 and j.charge == NoCharge
pure def startRoot(j: JsonWalk): JsonWalk = { ...j, rootStarted: true, visits: j.visits + 1, charge: RootCharge }
pure def canEnter(j: JsonWalk, identity: int): bool = not(j.rejected) and j.charge != NoCharge and not(j.ancestors.includes(identity)) and j.ancestors.length() <= j.maxDepth
pure def enter(j: JsonWalk, identity: int): JsonWalk = { ...j, ancestors: j.ancestors.append(identity), breadths: j.breadths.append(UnreadBreadth), charge: NoCharge }
pure def canFinishValue(j: JsonWalk): bool = not(j.rejected) and j.charge != NoCharge and j.ancestors.length() <= j.maxDepth
pure def finishValue(j: JsonWalk): JsonWalk = { ...j, charge: NoCharge }
pure def canObserveExtent(j: JsonWalk, width: int): bool = not(j.rejected) and j.charge == NoCharge and j.breadths.length() > 0 and isUnreadBreadth(topBreadth(j)) and width >= 0
pure def observeExtent(j: JsonWalk, width: int): JsonWalk = { ...j, breadths: replaceTopBreadth(ObservedBreadth({ width: width }), j) }
pure def canReserveBreadth(j: JsonWalk): bool = {
  val breadth = topBreadth(j)
  not(j.rejected) and j.charge == NoCharge and j.breadths.length() > 0 and (match breadth { | ObservedBreadth(b) => b.width >= 0 and b.width <= j.maxVisits - j.visits | _ => false })
}
pure def reserveBreadth(j: JsonWalk): JsonWalk = {
  val width = breadthWidth(topBreadth(j))
  { ...j, visits: j.visits + width, breadths: replaceTopBreadth(ReservedBreadth({ width: width, remaining: width }), j) }
}
pure def canInspectSlot(j: JsonWalk, descends: bool): bool = {
  val breadth = topBreadth(j)
  not(j.rejected) and j.charge == NoCharge and j.breadths.length() > 0 and (match breadth { | ReservedBreadth(b) => b.remaining > 0 | _ => false })
}
pure def inspectSlot(j: JsonWalk, descends: bool): JsonWalk = {
  val breadth = topBreadth(j)
  { ...j, breadths: replaceTopBreadth(ReservedBreadth({ width: breadthWidth(breadth), remaining: breadthRemaining(breadth) - 1 }), j), charge: if (descends) ChildCharge else NoCharge }
}
pure def canLeave(j: JsonWalk): bool = {
  val breadth = topBreadth(j)
  not(j.rejected) and j.ancestors.length() > 0 and j.charge == NoCharge and j.breadths.length() > 0 and (match breadth { | ReservedBreadth(b) => b.remaining == 0 | _ => false })
}
pure def leave(j: JsonWalk): JsonWalk = { ...j, ancestors: j.ancestors.removeAt(j.ancestors.length() - 1), breadths: j.breadths.removeAt(j.breadths.length() - 1) }
pure def canReject(j: JsonWalk): bool = not(j.rejected)
pure def reject(j: JsonWalk): JsonWalk = { ...j, rejected: true }
pure def alwaysTraversalWithinBudgets(j: JsonWalk): bool = j.visits >= 0 and j.visits <= j.maxVisits and j.outputCount >= 0 and (not(j.outputBounded) or j.outputCount <= j.maxOutput) and j.ancestors.length() <= j.maxDepth + 1
pure def alwaysChargesBelongToWalk(j: JsonWalk): bool = j.breadths.length() == j.ancestors.length() and (j.rootStarted iff j.visits > 0) and (j.ancestors.length() > 0 or j.charge != NoCharge implies j.rootStarted) and (j.charge == RootCharge implies j.ancestors.length() == 0) and (j.charge == ChildCharge implies j.ancestors.length() > 0) and j.breadths.every(breadth => validBreadth(breadth, j.visits))
pure def stepRejectedWalkRemainsRejected(before: JsonWalk, after: JsonWalk): bool = before.rejected implies after.rejected
pure def lawRootReservation(j: JsonWalk): bool = canStartRoot(j) implies startRoot(j).visits == j.visits + 1 and isValueInspection(nextInspection(startRoot(j)))
pure def lawZeroBudgetCannotStart(j: JsonWalk): bool = j.visits == 0 and j.maxVisits == 0 implies not(canStartRoot(j))
pure def lawScalarDepthLimit(j: JsonWalk): bool = j.ancestors.length() > j.maxDepth implies not(canFinishValue(j)) and not(isValueInspection(nextInspection(j)))
pure def lawContainerConsumesPaidValue(j: JsonWalk, identity: int): bool = canEnter(j, identity) implies enter(j, identity).charge == NoCharge and enter(j, identity).visits == j.visits and isExtentInspection(nextInspection(enter(j, identity)), identity)
pure def lawExtentBeforeReservation(j: JsonWalk, width: int): bool = canObserveExtent(j, width) implies observeExtent(j, width).visits == j.visits and isNoInspection(nextInspection(observeExtent(j, width)))
pure def lawBreadthReservation(j: JsonWalk): bool = canReserveBreadth(j) implies reserveBreadth(j).visits == j.visits + breadthWidth(topBreadth(j)) and not(canReserveBreadth(reserveBreadth(j)))
pure def lawDescriptorCapability(j: JsonWalk, descends: bool): bool = canInspectSlot(j, descends) implies isSlotInspection(nextInspection(j), topIdentity(j), breadthRemaining(topBreadth(j)))
pure def lawSlotConsumesOnePrepaidVisit(j: JsonWalk, descends: bool): bool = canInspectSlot(j, descends) implies inspectSlot(j, descends).visits == j.visits and breadthRemaining(topBreadth(inspectSlot(j, descends))) == breadthRemaining(topBreadth(j)) - 1 and (inspectSlot(j, descends).charge == ChildCharge iff descends)
pure def sometimesContainerVisited(j: JsonWalk): bool = j.ancestors.length() > 0
pure def sometimesBreadthReserved(j: JsonWalk): bool = canInspectSlot(j, false)
pure def sometimesPrepaidChild(j: JsonWalk): bool = j.charge == ChildCharge
pure def sometimesTypedRejection(j: JsonWalk): bool = j.rejected
pure val widthValues = Set(0, 1, 2, 3)
pure val maxVisitsValues = Set(0, 1, 3, 6)
pure val maxDepthValues = Set(0, 1, 2)
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
