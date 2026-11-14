# Approval worker registration ownership

The source is `packages/core/src/services/approval.ts:154,320-326,663-743` at the pinned baseline. ApprovalService owns a set of names for workers it successfully registered through the runtime. The runtime's task-worker registry remains the sole execution owner; this set prevents redundant registration by this service. It is retained when ApprovalService stops. A new service instance starts with an empty local set.

## Story: Register each approval type once before creating its task

An admitted approval creation first ensures its named worker exists. A runtime registration exception leaves the local name unregistered and prevents task persistence. Successful repeated ensures are no-ops. A successful worker owns role-aware canExecute and executes the existing selection handler under service admission, then deletes the handled task; those permission and task outcomes remain in [Approvals](./approvals.md), [Authorization](./authorization.md) and [Scheduling](./scheduling.md).

### Successful registrations retain one name and failed registrations retain none

```quint
type ApprovalWorkers = { registered: Set[str], registrations: int, ensured: str, registrationFailed: bool }
pure val initial: ApprovalWorkers = { registered: Set(), registrations: 0, ensured: "", registrationFailed: false }
pure val nameValues = Set("permission", "tool-confirmation", "")
pure def ensureWorker(s: ApprovalWorkers, name: str, registrationSucceeds: bool): ApprovalWorkers =
  if (s.registered.contains(name)) { ...s, ensured: name, registrationFailed: false }
  else if (registrationSucceeds) { ...s, registered: s.registered.union(Set(name)), registrations: s.registrations + 1, ensured: name, registrationFailed: false }
  else { ...s, ensured: "", registrationFailed: true }
pure def taskMayPersist(s: ApprovalWorkers, name: str): bool = not(s.registrationFailed) and s.ensured == name and s.registered.contains(name)
pure def alwaysCountMatchesDistinctWorkers(s: ApprovalWorkers): bool = s.registrations == s.registered.size()
pure def lawFailedRegistrationPreventsTask(s: ApprovalWorkers, name: str): bool = not(s.registered.contains(name)) implies not(taskMayPersist(ensureWorker(s, name, false), name))
pure def lawRepeatEnsureDoesNotRegister(s: ApprovalWorkers, name: str): bool = s.registered.contains(name) implies ensureWorker(s, name, true).registrations == s.registrations
pure def stepWorkerNamesAreRetained(before: ApprovalWorkers, via: str, after: ApprovalWorkers): bool = before.registered.subseteq(after.registered)
pure def sometimesSeveralApprovalTypes(s: ApprovalWorkers): bool = s.registered.size() > 1
```
