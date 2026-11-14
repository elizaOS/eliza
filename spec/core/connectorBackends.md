# Connector facade and backend identity

`connectors/account-manager.ts` retains one storage facade per manager and resolves its backend on every operation. These identities are process-local object references; the empty reference denotes absence. Record data and transfer outcomes are owned by [storage](./connectorStorage.md) and [migration](./connectorMigration.md).

## Story: Keep a stable facade while durable storage becomes available

### Backend replacement preserves facade identity and memoizes each current adapter

An explicit override wins over a compatible registered storage service, which wins over a compatible database adapter, which wins over the lazily allocated fallback. Replacing the current database adapter allocates a fresh wrapper; returning to an older adapter allocates another wrapper. The source keeps only the current wrapper. The fallback and warning latch survive later durable operations. Configuration references are inputs, not newly owned storage.

```quint
type BackendReference = { identity: int, adapter: int }
type BackendCache = { serial: int, facade: int, fallback: int, database: BackendReference, explicit: int, selected: int, warnedFallback: bool }
pure val initial: BackendCache = { serial: 1, facade: 0, fallback: 0, database: { identity: 0, adapter: 0 }, explicit: 0, selected: 0, warnedFallback: false }
pure def getFacade(s: BackendCache): BackendCache = if (s.facade != 0) s else { ...s, facade: s.serial, serial: s.serial + 1 }
pure def setExplicit(s: BackendCache, reference: int): BackendCache = { ...s, explicit: reference }
pure def canResolve(s: BackendCache, service: int, adapter: int): bool = service >= 0 and adapter >= 0
pure def resolve(s: BackendCache, service: int, adapter: int, hasRuntime: bool): BackendCache = {
  val reuseDatabase = s.database.adapter == adapter
  val reuseFallback = s.fallback != 0
  if (s.explicit != 0) { ...s, selected: s.explicit }
  else if (service != 0) { ...s, selected: service }
  else if (adapter != 0) { ...s, database: if (reuseDatabase) s.database else { identity: s.serial, adapter: adapter }, selected: if (reuseDatabase) s.database.identity else s.serial, serial: if (reuseDatabase) s.serial else s.serial + 1 }
  else { ...s, fallback: if (reuseFallback) s.fallback else s.serial, selected: if (reuseFallback) s.fallback else s.serial, serial: if (reuseFallback) s.serial else s.serial + 1, warnedFallback: s.warnedFallback or hasRuntime }
}
pure def alwaysAllocatedIdentitiesAreValid(s: BackendCache): bool = s.serial > 0 and s.facade >= 0 and s.facade < s.serial and s.fallback >= 0 and s.fallback < s.serial and s.database.identity >= 0 and s.database.identity < s.serial
pure def stepFacadeNeverChanges(before: BackendCache, after: BackendCache): bool = before.facade == 0 or before.facade == after.facade
pure def stepFallbackNeverChanges(before: BackendCache, after: BackendCache): bool = before.fallback == 0 or before.fallback == after.fallback
pure def stepWarningIsSticky(before: BackendCache, after: BackendCache): bool = not(before.warnedFallback) or after.warnedFallback
pure def sometimesDatabaseSelected(s: BackendCache): bool = s.database.identity > 0 and s.selected == s.database.identity
pure val serviceValues = Set(0, 10)
pure val adapterValues = Set(0, 20, 21)
pure val referenceValues = Set(0, 30)
```
