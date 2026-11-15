# Home launcher favorites and handoff

A consumer's Home shell calls the shared `createMobileShellLauncher` and
binds it to its own product registry. The native-system client is
`plugins/plugin-native-system/src/client/launcher.ts`. The consumer's
installed favorites record, its built-in key prefix and its default
policy name are its own deployed data, as is its table of renamed product
keys. [Launcher inventory](./launcherInventory.md) owns the installed-app
read and the native launch.

## Story: Keep saved Home choices through an upgrade and launch the exact target

> As the person, I want to keep saved Home choices through an upgrade
> and launch the exact target.

### Product favorites keep their canonical identity after migration

Only a recognized version-one or version-two favorites record can be
rewritten. Each old product key in the consumer's alias table maps to its
canonical product key, both in current favorites and previous defaults.
Migration deduplicates each output in order, leaves installed component
identities untouched, and preserves unrelated fields. If neither list has
a renamed item the source returns `unchanged` without persisting a
deduplicated-only rewrite. An unreadable record is retained. A persisted
migration must read back the same serialized record. A missing or
inaccessible store may supply product defaults for rendering but does not
establish a successful save. The decoder classifies names by the actual
built-in prefix and exact registered aliases, not by visible label. The
adoption model below separates persisted status from key normalization
and the platform effect.

```quint
type SavedKey = CanonicalProductKey | LegacyProductKey | InstalledComponent | UnknownKey
pure def normalizeKey(key: SavedKey): SavedKey =
  if (key == LegacyProductKey) CanonicalProductKey else key
pure def lawMigrationIsIdempotent(key: SavedKey): bool = normalizeKey(normalizeKey(key)) == normalizeKey(key)
pure def lawMigrationPreservesInstalledTarget(key: SavedKey): bool = key == InstalledComponent implies normalizeKey(key) == key

type SavedWrite = Absent | Unreadable | Unchanged | Migrated | Failed
pure def migrationResult(existsRecord: bool, readable: bool, version: int, listsValid: bool, renamed: int, writeReadback: bool): SavedWrite =
  if (not(existsRecord)) Absent
  else if (not(readable and listsValid) or (version != 1 and version != 2)) Unreadable
  else if (renamed == 0) Unchanged else if (renamed > 0 and writeReadback) Migrated else Failed
pure def lawMigrationRequiresWriteReadback(existsRecord: bool, readable: bool, version: int, listsValid: bool, renamed: int, writeReadback: bool): bool =
  migrationResult(existsRecord, readable, version, listsValid, renamed, writeReadback) == Migrated implies
  existsRecord and readable and listsValid and (version == 1 or version == 2) and renamed > 0 and writeReadback
```

### An admitted built-in view opens inside the renderer

Home joins currently available product entries with installed launchable
components and shows them in saved order. A product favorite opened by its
registered key goes to the product view. An installed-app favorite goes
to the native bridge only if the exact component was observed. A view
deferred by product policy must not be interpreted as a native package name.
Native launcher inventory and the exact installed component DTO, favorites
order readback and live availability changes require conformance to the
shared launcher port. No bridge call is inferred from labels.

```quint
type FavoriteLaunch = OpenRenderer | OpenComponent | Blocked
pure def launchFavorite(key: SavedKey, viewAvailable: bool, componentObserved: bool): FavoriteLaunch =
  if (key == InstalledComponent) { if (componentObserved) OpenComponent else Blocked }
  else if (key == UnknownKey or not(viewAvailable)) Blocked else OpenRenderer
pure def lawProductFavoriteNeverLaunchesNative(key: SavedKey, viewAvailable: bool, componentObserved: bool): bool =
  key != InstalledComponent implies launchFavorite(key, viewAvailable, componentObserved) != OpenComponent
pure def lawDeferredProductNeverOpens(key: SavedKey, componentObserved: bool): bool =
  key != InstalledComponent implies launchFavorite(key, false, componentObserved) == Blocked
```
