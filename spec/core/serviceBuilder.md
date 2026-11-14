# Service builder snapshots

`packages/core/src/services.ts:29-118` at `72fed7e4069ecd35d61d886ab6eec5c02c137517` stores description, start and stop closures in a mutable builder. Each build captures the current values in a new constructor. Its static serviceType and start properties are immutable and enumerable.

## Story: Build independent service classes from a mutable builder

As a plugin author I can change the builder and build again without altering an earlier constructor. A constructor without a start closure rejects when started; an absent stop closure fulfills without work.

### Building captures all current closures and description

```quint
type BuiltService = {id: int, serviceType: str, description: str, startRef: int, stopRef: int}
type ServiceBuilder = {created: bool, serviceType: str, description: str, startRef: int, stopRef: int, nextId: int, built: List[BuiltService]}
pure val initial: ServiceBuilder = {created: false, serviceType: "", description: "", startRef: 0, stopRef: 0, nextId: 1, built: List()}
pure val serviceTypeValues = Set("messages", "storage")
pure val descriptionValues = Set("", "first", "second")
pure val referenceValues = Set(1, 2)
pure def canCreateBuilder(s: ServiceBuilder, serviceType: str): bool = not(s.created)
pure def createBuilder(s: ServiceBuilder, serviceType: str): ServiceBuilder = { ...s, created: true, serviceType: serviceType }
pure def canWithDescription(s: ServiceBuilder, description: str): bool = s.created
pure def withDescription(s: ServiceBuilder, description: str): ServiceBuilder = { ...s, description: description }
pure def canWithStart(s: ServiceBuilder, reference: int): bool = s.created and reference > 0
pure def withStart(s: ServiceBuilder, reference: int): ServiceBuilder = { ...s, startRef: reference }
pure def canWithStop(s: ServiceBuilder, reference: int): bool = s.created and reference > 0
pure def withStop(s: ServiceBuilder, reference: int): ServiceBuilder = { ...s, stopRef: reference }
pure def canBuild(s: ServiceBuilder): bool = s.created
pure def build(s: ServiceBuilder): ServiceBuilder = { ...s, built: s.built.append({id: s.nextId, serviceType: s.serviceType, description: s.description, startRef: s.startRef, stopRef: s.stopRef}), nextId: s.nextId + 1 }
pure def startDisposition(service: BuiltService): str = if (service.startRef == 0) "missing-start-error" else "invoke-captured-start"
pure def stopDisposition(service: BuiltService): str = if (service.stopRef == 0) "fulfilled-without-hook" else "await-captured-stop"
pure def stepBuiltClassesStayFixed(before: ServiceBuilder, after: ServiceBuilder): bool = before.built.every(service => after.built.includes(service))
pure def alwaysClassIdsUnique(s: ServiceBuilder): bool = s.built.every(service => service.id > 0 and service.id < s.nextId and s.built.select(other => other.id == service.id).length() == 1)
pure def sometimesDistinctBuildSnapshots(s: ServiceBuilder): bool = s.built.some(first => s.built.some(second => first.id != second.id and (first.startRef != second.startRef or first.stopRef != second.stopRef or first.description != second.description)))
```
