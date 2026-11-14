# Adapter registration rollback and migration ownership

Sources are `packages/core/src/runtime.ts:1924-1943,5478-5489`, `plugin-lifecycle.ts:807-826` and `provisioning.ts:33-96` at `72fed7e4069ecd35d61d886ab6eec5c02c137517`. Ordinary registration is first-wins. Plugin registration captures its previous adapter, and rollback closes or stops the currently installed replacement before restoring that captured reference. Migrations retain the exact adapter reference selected at invocation.

## Story: Preserve adapter identity through plugin failure and migrations

As a host I can register an adapter and run its declared migrations. Unsupported plugin migrations skip explicitly; a migration rejection stays a rejection. Rollback failure preserves the installed adapter instead of falsely claiming restoration.

### Registration captures object references and rollback preserves close ordering

Discovered by the proof: every nonempty captured previous or closing adapter
reference names a retained adapter object. This is what permits rollback to
restore its captured reference while preserving the known-adapter invariant.

```quint
type Adapter = {id: int, hasClose: bool, hasStop: bool, genericMigrations: bool, pluginMigrations: bool}
type AdapterCapture = {id: int, previous: int, ownsReplacement: bool, closing: int, pending: bool, restored: bool, failed: bool}
type MigrationPhase = MigrationPending | MigrationSucceeded | MigrationFailed | MigrationSkipped
type Migration = {id: int, adapter: int, phase: MigrationPhase, plugin: bool, paths: List[str], schemas: List[str], verbose: bool, force: bool, errorId: str}
type AdapterOwnership = {active: int, adapters: List[Adapter], captures: List[AdapterCapture], migrations: List[Migration]}
pure val initial: AdapterOwnership = {active: 0, adapters: List(), captures: List(), migrations: List()}
pure val adapterValues = Set({id: 1, hasClose: true, hasStop: true, genericMigrations: true, pluginMigrations: true}, {id: 2, hasClose: false, hasStop: true, genericMigrations: false, pluginMigrations: true})
pure val captureIdValues = Set(0, 1, 2)
pure val migrationIdValues = Set(1, 2)
pure val pathsValues = Set(List(), List("schema"))
pure val schemasValues = Set(List(), List("complete-plugin-schema"))
pure val errorIdValues = Set("migration-error", "close-error")
pure val noAdapter: Adapter = {id: 0, hasClose: false, hasStop: false, genericMigrations: false, pluginMigrations: false}
pure def adapterById(s: AdapterOwnership, id: int): Adapter = s.adapters.select(a => a.id == id).nthOr(0, noAdapter)
pure def canBeginCapture(s: AdapterOwnership, captureId: int): bool = captureId > 0 and not(s.captures.some(c => c.id == captureId))
pure def beginCapture(s: AdapterOwnership, captureId: int): AdapterOwnership = { ...s, captures: s.captures.append({id: captureId, previous: s.active, ownsReplacement: false, closing: 0, pending: false, restored: false, failed: false}) }
pure def canRegisterAdapter(s: AdapterOwnership, adapter: Adapter, captureId: int): bool = adapter.id > 0 and (captureId == 0 or s.captures.some(c => c.id == captureId)) and (not(s.adapters.some(a => a.id == adapter.id)) or adapterById(s, adapter.id) == adapter)
pure def registerAdapter(s: AdapterOwnership, adapter: Adapter, captureId: int): AdapterOwnership = { ...s, active: if (s.active == 0) adapter.id else s.active, adapters: if (s.adapters.some(a => a.id == adapter.id)) s.adapters else s.adapters.append(adapter), captures: s.captures.listMap(c => if (c.id == captureId and s.active == 0) { ...c, ownsReplacement: true } else c) }
pure def canBeginRollback(s: AdapterOwnership, captureId: int): bool = s.captures.some(c => c.id == captureId and c.ownsReplacement and not(c.pending) and not(c.restored) and not(c.failed))
pure def beginRollback(s: AdapterOwnership, captureId: int): AdapterOwnership = { ...s, captures: s.captures.listMap(c => if (c.id != captureId) c else { ...c, closing: if (s.active != c.previous) s.active else 0, pending: true }) }
pure def rollbackUsesClose(s: AdapterOwnership, captureId: int): bool = s.captures.some(c => c.id == captureId and adapterById(s, c.closing).hasClose)
pure def rollbackUsesStop(s: AdapterOwnership, captureId: int): bool = s.captures.some(c => c.id == captureId and not(adapterById(s, c.closing).hasClose) and adapterById(s, c.closing).hasStop)
pure def canFinishRollback(s: AdapterOwnership, captureId: int, ok: bool): bool = s.captures.some(c => c.id == captureId and c.pending and (ok or adapterById(s, c.closing).hasClose or adapterById(s, c.closing).hasStop))
pure def finishRollback(s: AdapterOwnership, captureId: int, ok: bool): AdapterOwnership = {
  val capture = s.captures.select(c => c.id == captureId).nthOr(0, {id: 0, previous: 0, ownsReplacement: false, closing: 0, pending: false, restored: false, failed: false})
  { ...s, active: if (ok) capture.previous else s.active, captures: s.captures.listMap(c => if (c.id == captureId) { ...c, pending: false, restored: ok, failed: not(ok) } else c) }
}
pure def canBeginMigration(s: AdapterOwnership, migrationId: int, plugin: bool, paths: List[str], schemas: List[str], verbose: bool, force: bool): bool = migrationId > 0 and not(s.migrations.some(m => m.id == migrationId))
pure def beginMigration(s: AdapterOwnership, migrationId: int, plugin: bool, paths: List[str], schemas: List[str], verbose: bool, force: bool): AdapterOwnership = {
  val adapter = adapterById(s, s.active)
  val skip = s.active == 0 or (if (plugin) not(adapter.pluginMigrations) or schemas.length() == 0 else not(adapter.genericMigrations))
  { ...s, migrations: s.migrations.append({id: migrationId, adapter: s.active, phase: if (s.active == 0 and not(plugin)) MigrationFailed else if (skip) MigrationSkipped else MigrationPending, plugin: plugin, paths: paths, schemas: schemas, verbose: verbose, force: force, errorId: if (s.active == 0 and not(plugin)) "missing-adapter" else ""}) }
}
pure def canFinishMigration(s: AdapterOwnership, migrationId: int, ok: bool, errorId: str): bool = s.migrations.some(m => m.id == migrationId and m.phase == MigrationPending)
pure def finishMigration(s: AdapterOwnership, migrationId: int, ok: bool, errorId: str): AdapterOwnership = { ...s, migrations: s.migrations.listMap(m => if (m.id == migrationId) { ...m, phase: if (ok) MigrationSucceeded else MigrationFailed, errorId: if (ok) "" else errorId } else m) }
pure def alwaysActiveAdapterKnown(s: AdapterOwnership): bool = s.active == 0 or s.adapters.some(a => a.id == s.active)
pure def alwaysCapturedAdaptersKnown(s: AdapterOwnership): bool = s.captures.every(c => (c.previous == 0 or s.adapters.some(a => a.id == c.previous)) and (c.closing == 0 or s.adapters.some(a => a.id == c.closing)))
pure def alwaysMigrationReferenceKnown(s: AdapterOwnership): bool = s.migrations.every(m => m.adapter == 0 or s.adapters.some(a => a.id == m.adapter))
pure def stepMigrationIdentityPreserved(before: AdapterOwnership, after: AdapterOwnership): bool = before.migrations.every(m => after.migrations.some(other => other.id == m.id and other.adapter == m.adapter and other.paths == m.paths and other.schemas == m.schemas))
pure def sometimesRollbackDuringMigration(s: AdapterOwnership): bool = s.captures.some(c => c.pending and s.migrations.some(m => m.phase == MigrationPending and m.adapter == c.closing))
pure def sometimesRestorePreservesInFlightMigration(s: AdapterOwnership): bool = s.captures.some(c => c.restored and s.migrations.some(m => m.phase == MigrationPending and m.adapter != s.active))
```
