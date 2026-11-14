# Notification recovery attempt ownership

The source is `packages/core/src/services/notification.ts` and `NotificationRecoveryOwnership` in `quint/NotificationRecovery.qnt`. Each mapped recovery record retains its own per-attempt state from [Recovery](./notificationRecovery.md). Observing a registered service can clear the runtime's map while the previous load callback is still returning. A later attempt may then become mapped, and the old callback must release only its own identity.

## Story: Retire a recovery callback without removing its replacement

### The runtime maps one recovery identity while older callbacks retain their records

```quint
import notificationRecovery as R from "./notificationRecovery"
type OwnedRecovery = { id: int, recovery: R::Recovery, returning: bool }
type Owners = { availability: R::Availability, mapped: int, nextId: int, records: List[OwnedRecovery], reply: R::RecoveryReply, lastCompleted: int }
pure val initial: Owners = { availability: R::Pending, mapped: 0, nextId: 1, records: List(), reply: R::NoRequest, lastCompleted: 0 }
pure val absent: OwnedRecovery = { id: 0, recovery: R::initial, returning: false }
pure val attemptIdValues = Set(1, 2, 3)
pure def owned(s: Owners, attemptId: int): OwnedRecovery = s.records.select(record => record.id == attemptId).nthOr(0, absent)
pure def mappedBusy(s: Owners): bool = owned(s, s.mapped).returning or owned(s, s.mapped).recovery.phase == R::Loading or owned(s, s.mapped).recovery.phase == R::FailureCleanup
pure def mappedCooling(s: Owners): bool = s.mapped != 0 and owned(s, s.mapped).recovery.remainingMs > 0
pure def setAvailability(s: Owners, availability: R::Availability): Owners = { ...s, availability: availability }
pure def request(s: Owners): Owners = {
  val mappedRecord = owned(s, s.mapped)
  val eligible = not(mappedBusy(s)) and s.availability == R::Failed and not(mappedCooling(s))
  val identity = if (s.mapped == 0) s.nextId else s.mapped
  val recovered = R::request({ ...mappedRecord.recovery, availability: R::Failed })
  val replacement = { id: identity, recovery: recovered, returning: false }
  { ...s,
    reply: if (mappedBusy(s)) R::InFlight else if (s.availability != R::Failed) R::Unavailable else if (mappedCooling(s)) R::Backoff else R::Started,
    mapped: if (eligible) identity else if (not(mappedBusy(s)) and s.availability == R::Registered) 0 else s.mapped,
    nextId: if (eligible and s.mapped == 0) s.nextId + 1 else s.nextId,
    records: if (eligible) s.records.select(record => record.id != identity).append(replacement) else s.records,
    availability: if (eligible) R::Registering else s.availability
  }
}
pure def canObserveRegistered(s: Owners): bool = s.availability == R::Registered
pure def observeRegistered(s: Owners): Owners = { ...s, mapped: 0 }
pure def canReturnLoad(s: Owners, attemptId: int): bool = owned(s, attemptId).id != 0 and owned(s, attemptId).recovery.phase == R::Loading and s.availability == R::Registered
pure def returnLoad(s: Owners, attemptId: int): Owners = { ...s, records: s.records.listMap(record => if (record.id == attemptId) { ...record, returning: true } else record) }
```

### A successful old callback clears the map only if its own identity is still mapped

```quint
pure def canSucceed(s: Owners, attemptId: int): bool = owned(s, attemptId).returning and owned(s, attemptId).recovery.phase == R::Loading
pure def succeed(s: Owners, attemptId: int): Owners = { ...s, lastCompleted: attemptId, mapped: if (s.mapped == attemptId) 0 else s.mapped, records: s.records.listMap(record => if (record.id == attemptId) { ...record, recovery: R::loaded(record.recovery), returning: false } else record) }
pure def canLoadFailed(s: Owners, attemptId: int): bool = owned(s, attemptId).id != 0 and owned(s, attemptId).recovery.phase == R::Loading and not(owned(s, attemptId).returning)
pure def loadFailed(s: Owners, attemptId: int): Owners = { ...s, records: s.records.listMap(record => if (record.id == attemptId) { ...record, recovery: R::loadFailed(record.recovery) } else record) }
pure def canFinalize(s: Owners, attemptId: int): bool = R::canFinalize(owned(s, attemptId).recovery) and owned(s, attemptId).id != 0
pure def finalize(s: Owners, attemptId: int): Owners = { ...s, records: s.records.listMap(record => if (record.id == attemptId) { ...record, recovery: R::finalize(record.recovery) } else record) }
pure def canElapse(s: Owners, attemptId: int, milliseconds: int): bool = owned(s, attemptId).id != 0 and milliseconds >= 0
pure def elapse(s: Owners, attemptId: int, milliseconds: int): Owners = { ...s, records: s.records.listMap(record => if (record.id == attemptId) { ...record, recovery: R::elapse(record.recovery, milliseconds) } else record) }
pure val millisecondsValues = Set(0, 1000, 30000)
pure def alwaysMappedIdentityExists(s: Owners): bool = s.mapped == 0 or s.records.some(record => record.id == s.mapped)
pure def alwaysRecordIdentitiesAreUnique(s: Owners): bool = s.nextId > 0 and s.records.every(record => record.id > 0 and record.id < s.nextId and s.records.select(other => other.id == record.id).length() == 1)
pure def alwaysEachRecoveryRetainsItsRules(s: Owners): bool = s.records.every(record => R::alwaysCooldownIsBounded(record.recovery) and R::alwaysLoaderOwnsRegistering(record.recovery))
pure def stepOldSuccessPreservesMappedReplacement(before: Owners, via: str, after: Owners): bool = via != "succeed" or (if (after.lastCompleted == before.mapped) after.mapped == 0 else after.mapped == before.mapped)
pure def sometimesReplacementLoadsBesideOldCallback(s: Owners): bool = s.mapped > 0 and s.records.some(record => record.id != s.mapped and record.returning) and owned(s, s.mapped).recovery.phase == R::Loading
```
