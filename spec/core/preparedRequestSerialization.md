# Prepared request serializer boundary

The provider guard in `packages/core/src/runtime/prepared-model-request.ts`
chooses one serializer, validates a projected JSON graph and captures its
actual serialization before the first transport attempt.

## Story: Prepare a request without silently losing model input

As a provider I want an invalid projection or wire serializer to fail
before token counting, allowance reservation or transport.

### Exactly one provider serializer determines the request body

The caller chooses either the projection or the raw-wire serializer.
A raw-wire return must be a string, including the empty string. A graph root
of undefined has no JSON representation. A serializer failure leaves no
admitted body. A successful observation retains the complete serialized
UTF-16 sequence for the retry guard. JavaScript
stringification, provider callback invocation and reflection remain at the
adapter boundary.

```quint
import unicode as U from "./unicode"
type SerializerChoice = ProjectionSerializer | RawWireSerializer | MissingSerializer | ConflictingSerializers
type SerializedObservation = SerializedText({codeUnits: List[int]}) | NonStringWireReturn | JsonRootMissing | SerializationThrew
type BodyAdmission = AdmittedBody({codeUnits: List[int]}) | InvalidBody
pure def serializerChoice(hasProjection: bool, hasWire: bool): SerializerChoice =
  if (hasProjection and hasWire) ConflictingSerializers
  else if (hasProjection) ProjectionSerializer
  else if (hasWire) RawWireSerializer
  else MissingSerializer
pure val serializerValues = Set(ProjectionSerializer, RawWireSerializer, MissingSerializer, ConflictingSerializers)
pure val sampleBody: SerializedObservation = SerializedText({codeUnits: List(123, 125)})
pure val observedValues = Set(sampleBody, NonStringWireReturn, JsonRootMissing, SerializationThrew)
pure def admittedSerialization(serializer: SerializerChoice, observed: SerializedObservation): BodyAdmission =
  if (serializer == MissingSerializer or serializer == ConflictingSerializers) InvalidBody
  else match observed {
    | SerializedText(text) => if (U::validCodeUnits(text.codeUnits)) AdmittedBody({codeUnits: text.codeUnits}) else InvalidBody
    | _ => InvalidBody
  }
pure def lawMissingSerializerHasNoBody(observed: SerializedObservation): bool =
  admittedSerialization(serializerChoice(false, false), observed) == InvalidBody
pure def lawConflictingSerializersHaveNoBody(observed: SerializedObservation): bool =
  admittedSerialization(serializerChoice(true, true), observed) == InvalidBody
pure def lawNonStringWireHasNoBody(serializer: SerializerChoice): bool =
  admittedSerialization(serializer, NonStringWireReturn) == InvalidBody
pure def lawUndefinedRootHasNoBody(serializer: SerializerChoice): bool =
  admittedSerialization(serializer, JsonRootMissing) == InvalidBody
```

### The validation walk refuses cycles and unsupported visited values

An active ancestor reference is a cycle. A shared reference may be visited
again after its first frame leaves the stack. Validation rejects nonfinite
numbers, non-JSON primitive types and nonplain objects other than arrays.
Enumerable own object keys require data descriptors. Array slots follow
JavaScript indexed reads. Undefined and sparse array slots pass validation
and use JavaScript's JSON rendering rules. The walk abstracts the traversal
observations supplied by the adapter. It preserves exact ancestor identity.

```quint
type GraphValue = PrimitiveValue | UndefinedValue | NonFiniteNumber | NonJsonPrimitive | OpaqueObject | ContainerValue({identity: int})
type GraphObservation = VisitValue({visited: GraphValue}) | LeaveContainer({identity: int}) | ObjectPropertyWithoutData
type Validation = {ancestors: List[int], valid: bool}
pure val initial: Validation = {ancestors: List(), valid: true}
pure val recordOne: GraphValue = ContainerValue({identity: 1})
pure val recordTwo: GraphValue = ContainerValue({identity: 2})
pure val observeOne: GraphObservation = VisitValue({visited: recordOne})
pure val observeTwo: GraphObservation = VisitValue({visited: recordTwo})
pure val leaveOne: GraphObservation = LeaveContainer({identity: 1})
pure val leaveTwo: GraphObservation = LeaveContainer({identity: 2})
pure val observationValues = Set(observeOne, observeTwo, leaveOne, leaveTwo, ObjectPropertyWithoutData, VisitValue({visited: NonFiniteNumber}), VisitValue({visited: UndefinedValue}), VisitValue({visited: PrimitiveValue}), VisitValue({visited: NonJsonPrimitive}), VisitValue({visited: OpaqueObject}))
pure def visitGraph(value: GraphValue, walk: Validation): Validation =
  match value {
    | ContainerValue(data) =>
      if (data.identity <= 0 or walk.ancestors.includes(data.identity)) { ...walk, valid: false }
      else { ...walk, ancestors: walk.ancestors.append(data.identity) }
    | PrimitiveValue => walk
    | UndefinedValue => walk
    | _ => { ...walk, valid: false }
  }
pure def canObserveGraph(walk: Validation): bool = walk.valid
pure def observeGraph(walk: Validation, observation: GraphObservation): Validation =
  match observation {
    | VisitValue(observed) => visitGraph(observed.visited, walk)
    | LeaveContainer(data) =>
      if (walk.ancestors.nthOr(walk.ancestors.length() - 1, 0) == data.identity and data.identity > 0)
        { ...walk, ancestors: walk.ancestors.removeAt(walk.ancestors.length() - 1) }
      else { ...walk, valid: false }
    | ObjectPropertyWithoutData => { ...walk, valid: false }
  }
pure def stepFailedValidationIsTerminal(before: Validation, after: Validation): bool =
  not(before.valid) implies not(after.valid)
pure def sometimesContainerOpen(walk: Validation): bool = walk.ancestors.length() > 0 and walk.valid
pure def sometimesInvalidGraph(walk: Validation): bool = not(walk.valid)
pure def lawActiveAncestorRefuses(walk: Validation, identity: int): bool =
  walk.ancestors.includes(identity) implies not(visitGraph(ContainerValue({identity: identity}), walk).valid)
```

### A projected body requires a finished valid walk

The graph serializer can hand its complete body to the retry guard only
after the last validated container leaves the walk. Invalid or unfinished
walks have no admitted body. A raw-wire observation takes the separate
string-return path and does not traverse a JSON graph.

```quint
pure def finishSerialization(walk: Validation, serializer: SerializerChoice, observed: SerializedObservation): BodyAdmission =
  if (serializer == ProjectionSerializer and (not(walk.valid) or walk.ancestors.length() != 0)) InvalidBody
  else admittedSerialization(serializer, observed)
pure def lawUnfinishedProjectionHasNoBody(walk: Validation, observed: SerializedObservation): bool =
  (not(walk.valid) or walk.ancestors.length() != 0) implies finishSerialization(walk, ProjectionSerializer, observed) == InvalidBody
```
