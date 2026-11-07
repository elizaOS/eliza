/**
 * The one migration of a product's older view ids in its installed launcher
 * favorites: `<prefix><legacy id>` becomes `<prefix><canonical id>`. It runs
 * before the launcher reads the list and is idempotent, so a downgrade and
 * upgrade still converge. Nothing else in the stored record changes.
 */
import type { MobileProductRegistration } from "./product-registration";

export type LauncherViewIdMigration =
  | { status: "absent" | "unchanged" | "unreadable" }
  | { status: "migrated"; renamed: number }
  | { status: "failed"; message: string };

const isKeyList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((key) => typeof key === "string");

export function migrateLauncherViewIds(
  storage: Pick<Storage, "getItem" | "setItem">,
  registration: MobileProductRegistration,
): LauncherViewIdMigration {
  const { launcherFavorites, launcherBuiltinPrefix: prefix } =
    registration.storage;
  const legacy = registration.views.legacyIds;
  let raw: string | null;
  try {
    raw = storage.getItem(launcherFavorites);
  } catch (error) {
    return { status: "failed", message: String(error) };
  }
  if (raw === null) return { status: "absent" };
  let saved: Record<string, unknown>;
  try {
    saved = JSON.parse(raw);
  } catch {
    return { status: "unreadable" };
  }
  // Only the launcher's own record versions are rewritten.
  if (
    !saved ||
    typeof saved !== "object" ||
    Array.isArray(saved) ||
    (saved.version !== 1 && saved.version !== 2) ||
    !isKeyList(saved.keys) ||
    (saved.previousDefaults !== undefined && !isKeyList(saved.previousDefaults))
  )
    return { status: "unreadable" };
  let renamed = 0;
  const rename = (keys: string[]) => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const key of keys) {
      const id = key.startsWith(prefix) ? key.slice(prefix.length) : null;
      const next =
        id !== null && Object.hasOwn(legacy, id)
          ? `${prefix}${legacy[id]}`
          : key;
      if (next !== key) renamed++;
      if (!seen.has(next)) out.push(next);
      seen.add(next);
    }
    return out;
  };
  const next: Record<string, unknown> = { ...saved, keys: rename(saved.keys) };
  if (isKeyList(saved.previousDefaults))
    next.previousDefaults = rename(saved.previousDefaults);
  if (!renamed) return { status: "unchanged" };
  const value = JSON.stringify(next);
  try {
    storage.setItem(launcherFavorites, value);
    if (storage.getItem(launcherFavorites) !== value)
      return { status: "failed", message: "Favorites write was not confirmed" };
  } catch (error) {
    return { status: "failed", message: String(error) };
  }
  return { status: "migrated", renamed };
}
