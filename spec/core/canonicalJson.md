# Canonical JSON value traversal

Source `canonical-json.ts` preserves existing digest bytes while guarding reflection, recursive depth, total visits and outputCount characters. `CanonicalJsonOptions` retains caller-selected sparse-hole rendering and the typed `onUnbounded` callback. `stableJsonString` returns absence for an invisible root value, while `canonicalJsonString` renders it as null.

## Story: Hash the same snapshot safely and deterministically

> As a backup or integrity consumer, I want stable bytes from a snapshot
> without running its getters, so that the same data always hashes the
> same way.

### Every traversal reserves its work before inspecting a new container

The root reserves one visit before its value is classified or a container is entered. Every recursive value, including a scalar, must satisfy the depth limit before inspection or completion. Entering a container consumes that paid value, checks depth and ancestor identity, and opens a frame. Only then may the host observe its extent: `Reflect.ownKeys` for an object or the array's own length data descriptor, reusing an externally captured root length. The complete extent is charged before any per-slot descriptor, snapshot allocation or sorting. Symbol and non-enumerable keys and sparse array holes still consume their reserved slots. A slot that descends supplies its child's visit, so recursion does not charge it again. Credits belong to the current frame and cannot be reused after it exits.

The next-inspection value is a capability for the host adapter: no value inspection without a charged value, no extent inspection before admission, and no per-slot inspection before breadth reservation. Reflection, descriptor classification, UTF-16 key sorting, emitted bytes and typed `onUnbounded` failures remain host conformance boundaries. Output reservation remains independent of visit reservation. A repeated reference is valid after its ancestor frame exits. An ancestor reference is a cycle and produces the typed failure. This finite walk models the source's recursive stack, not a second JSON encoder.

```quint
type JsonBreadth = UnreadBreadth | ObservedBreadth({ width: int }) | ReservedBreadth({ width: int, remaining: int })
type JsonFrame = { identity: int, breadth: JsonBreadth }
type ValueCharge = NoCharge | RootCharge | ChildCharge
type JsonInspection = NoInspection | InspectValue | InspectExtent({ identity: int }) | InspectSlot({ identity: int, remaining: int })
type JsonWalk = { frames: List[JsonFrame], charge: ValueCharge, rootStarted: bool, visits: int, outputCount: int, maxVisits: int, maxOutput: int, outputBounded: bool, maxDepth: int, rejected: bool }
pure val initial: JsonWalk = { frames: List(), charge: NoCharge, rootStarted: false, visits: 0, outputCount: 0, maxVisits: 0, maxOutput: 0, outputBounded: false, maxDepth: 0, rejected: false }
pure def topFrame(j: JsonWalk): JsonFrame = j.frames.nthOr(j.frames.length() - 1, { identity: 0, breadth: UnreadBreadth })
pure def replaceTop(frame: JsonFrame, j: JsonWalk): List[JsonFrame] = j.frames.removeAt(j.frames.length() - 1).append(frame)
pure def isUnreadBreadth(breadth: JsonBreadth): bool = match breadth { | UnreadBreadth => true | _ => false }
pure def isValueInspection(inspection: JsonInspection): bool = match inspection { | InspectValue => true | _ => false }
pure def isNoInspection(inspection: JsonInspection): bool = match inspection { | NoInspection => true | _ => false }
pure def isSlotInspection(inspection: JsonInspection, identity: int, remaining: int): bool = match inspection { | InspectSlot(slot) => slot.identity == identity and slot.remaining == remaining | _ => false }
pure def breadthWidth(breadth: JsonBreadth): int = match breadth { | ObservedBreadth(b) => b.width | ReservedBreadth(b) => b.width | _ => 0 }
pure def breadthRemaining(breadth: JsonBreadth): int = match breadth { | ReservedBreadth(b) => b.remaining | _ => 0 }
pure def validBreadth(breadth: JsonBreadth, visits: int): bool = match breadth { | ObservedBreadth(b) => b.width >= 0 | ReservedBreadth(b) => b.width >= 0 and b.width <= visits and b.remaining >= 0 and b.remaining <= b.width | _ => true }
pure def nextInspection(j: JsonWalk): JsonInspection = {
  val frame = topFrame(j)
  val breadth = frame.breadth
  if (j.rejected) NoInspection else if (j.charge != NoCharge) { if (j.frames.length() <= j.maxDepth) InspectValue else NoInspection } else if (j.frames.length() == 0) NoInspection else match breadth { | UnreadBreadth => InspectExtent({ identity: frame.identity }) | ReservedBreadth(b) => if (b.remaining > 0) InspectSlot({ identity: frame.identity, remaining: b.remaining }) else NoInspection | _ => NoInspection }
}
pure def canConfigure(j: JsonWalk, maxVisits: int, maxOutput: int, outputBounded: bool, maxDepth: int): bool = not(j.rootStarted) and j.visits == 0 and j.outputCount == 0 and j.frames.length() == 0 and j.charge == NoCharge and not(j.rejected) and maxVisits >= 0 and maxOutput >= 0 and maxDepth >= 0
pure def configure(j: JsonWalk, maxVisits: int, maxOutput: int, outputBounded: bool, maxDepth: int): JsonWalk = { ...j, maxVisits: maxVisits, maxOutput: maxOutput, outputBounded: outputBounded, maxDepth: maxDepth }
pure def canStartRoot(j: JsonWalk): bool = not(j.rejected) and not(j.rootStarted) and j.visits < j.maxVisits and j.maxDepth >= 0 and j.frames.length() == 0 and j.charge == NoCharge
pure def startRoot(j: JsonWalk): JsonWalk = { ...j, rootStarted: true, visits: j.visits + 1, charge: RootCharge }
pure def canEnter(j: JsonWalk, identity: int): bool = not(j.rejected) and j.charge != NoCharge and not(j.frames.some(frame => frame.identity == identity)) and j.frames.length() <= j.maxDepth
pure def enter(j: JsonWalk, identity: int): JsonWalk = { ...j, frames: j.frames.append({ identity: identity, breadth: UnreadBreadth }), charge: NoCharge }
pure def canFinishValue(j: JsonWalk): bool = not(j.rejected) and j.charge != NoCharge and j.frames.length() <= j.maxDepth
pure def finishValue(j: JsonWalk): JsonWalk = { ...j, charge: NoCharge }
pure def canObserveExtent(j: JsonWalk, width: int): bool = not(j.rejected) and j.charge == NoCharge and j.frames.length() > 0 and isUnreadBreadth(topFrame(j).breadth) and width >= 0
pure def observeExtent(j: JsonWalk, width: int): JsonWalk = { ...j, frames: replaceTop({ identity: topFrame(j).identity, breadth: ObservedBreadth({ width: width }) }, j) }
pure def canReserveBreadth(j: JsonWalk): bool = {
  val frame = topFrame(j)
  val breadth = frame.breadth
  not(j.rejected) and j.charge == NoCharge and j.frames.length() > 0 and (match breadth { | ObservedBreadth(b) => b.width >= 0 and b.width <= j.maxVisits - j.visits | _ => false })
}
pure def reserveBreadth(j: JsonWalk): JsonWalk = {
  val width = breadthWidth(topFrame(j).breadth)
  { ...j, visits: j.visits + width, frames: replaceTop({ identity: topFrame(j).identity, breadth: ReservedBreadth({ width: width, remaining: width }) }, j) }
}
pure def canInspectSlot(j: JsonWalk, descends: bool): bool = {
  val frame = topFrame(j)
  val breadth = frame.breadth
  not(j.rejected) and j.charge == NoCharge and j.frames.length() > 0 and (match breadth { | ReservedBreadth(b) => b.remaining > 0 | _ => false })
}
pure def inspectSlot(j: JsonWalk, descends: bool): JsonWalk = {
  val frame = topFrame(j)
  val breadth = frame.breadth
  val width = breadthWidth(frame.breadth)
  val remaining = breadthRemaining(frame.breadth)
  { ...j, frames: replaceTop({ identity: frame.identity, breadth: ReservedBreadth({ width: width, remaining: remaining - 1 }) }, j), charge: if (descends) ChildCharge else NoCharge }
}
pure def canLeave(j: JsonWalk): bool = {
  val frame = topFrame(j)
  val breadth = frame.breadth
  not(j.rejected) and j.charge == NoCharge and j.frames.length() > 0 and (match breadth { | ReservedBreadth(b) => b.remaining == 0 | _ => false })
}
pure def leave(j: JsonWalk): JsonWalk = { ...j, frames: j.frames.removeAt(j.frames.length() - 1) }
pure def canReserveOutput(j: JsonWalk, outputCount: int): bool = not(j.rejected) and outputCount >= 0 and (not(j.outputBounded) or outputCount <= j.maxOutput - j.outputCount)
pure def reserveOutput(j: JsonWalk, outputCount: int): JsonWalk = { ...j, outputCount: j.outputCount + outputCount }
pure def canReject(j: JsonWalk): bool = not(j.rejected)
pure def reject(j: JsonWalk): JsonWalk = { ...j, rejected: true }
pure def alwaysTraversalWithinBudgets(j: JsonWalk): bool = j.visits >= 0 and j.visits <= j.maxVisits and j.outputCount >= 0 and (not(j.outputBounded) or j.outputCount <= j.maxOutput) and j.frames.length() <= j.maxDepth + 1
pure def alwaysChargesBelongToWalk(j: JsonWalk): bool = (j.rootStarted iff j.visits > 0) and (j.frames.length() > 0 or j.charge != NoCharge implies j.rootStarted) and (j.charge == RootCharge implies j.frames.length() == 0) and (j.charge == ChildCharge implies j.frames.length() > 0) and j.frames.every(frame => validBreadth(frame.breadth, j.visits))
pure def stepRejectedWalkRemainsRejected(before: JsonWalk, after: JsonWalk): bool = before.rejected implies after.rejected
pure def lawRootReservation(j: JsonWalk): bool = canStartRoot(j) implies startRoot(j).visits == j.visits + 1 and isValueInspection(nextInspection(startRoot(j)))
pure def lawExtentBeforeReservation(j: JsonWalk, width: int): bool = canObserveExtent(j, width) implies observeExtent(j, width).visits == j.visits and isNoInspection(nextInspection(observeExtent(j, width)))
pure def lawBreadthReservation(j: JsonWalk): bool = canReserveBreadth(j) implies reserveBreadth(j).visits == j.visits + breadthWidth(topFrame(j).breadth) and not(canReserveBreadth(reserveBreadth(j)))
pure def lawSlotConsumesOnePrepaidVisit(j: JsonWalk, descends: bool): bool = canInspectSlot(j, descends) implies inspectSlot(j, descends).visits == j.visits and breadthRemaining(topFrame(inspectSlot(j, descends)).breadth) == breadthRemaining(topFrame(j).breadth) - 1
pure def lawContainerConsumesPaidValue(j: JsonWalk, identity: int): bool = canEnter(j, identity) implies enter(j, identity).charge == NoCharge and enter(j, identity).visits == j.visits
pure def lawDescriptorCapability(j: JsonWalk, descends: bool): bool = canInspectSlot(j, descends) implies isSlotInspection(nextInspection(j), topFrame(j).identity, breadthRemaining(topFrame(j).breadth))
pure def lawZeroBudgetCannotStart(j: JsonWalk): bool = j.visits == 0 and j.maxVisits == 0 implies not(canStartRoot(j))
pure def lawScalarDepthLimit(j: JsonWalk): bool = j.frames.length() > j.maxDepth implies not(canFinishValue(j))
pure def lawCycleCannotEnter(j: JsonWalk, identity: int): bool = j.frames.some(frame => frame.identity == identity) implies not(canEnter(j, identity))
pure def sometimesContainerVisited(j: JsonWalk): bool = j.frames.length() > 0
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
