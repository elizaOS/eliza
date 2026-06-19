/**
 * Extra settings-group registry for groups beyond the three pinned built-ins
 * (`agent | system | security`).
 *
 * The canonical group set lives in `settings-section-meta.ts`
 * (`SETTINGS_GROUP_ORDER` / `SETTINGS_GROUP_LABEL`), which is intentionally
 * frozen — the app-core `dev-route-catalog` parity test pins it. To add a "Cloud"
 * group without mutating that pinned list, host code registers the group here at
 * boot and the Settings view reads {@link listExtraSettingsGroups} to render any
 * group a section declares that the built-in order does not already cover.
 *
 * Mirrors the section registry's global-symbol store so every bundle in the
 * process shares one group list even across module-identity splits.
 */

export interface ExtraSettingsGroupDef {
  /** Stable group id — the value a section's `group` field carries. */
  id: string;
  /** English display label rendered as the group heading. */
  label: string;
  /**
   * Sort order. Built-in groups occupy 0 (agent), 1 (system), 2 (security);
   * extra groups order relative to those (e.g. a Cloud group at order 1.5 sits
   * between System and Security).
   */
  order: number;
}

interface ExtraGroupStore {
  groups: Map<string, ExtraSettingsGroupDef>;
}

function storeKey(): symbol {
  return Symbol.for("elizaos.ui.cloud-settings-group-registry");
}

function getStore(): ExtraGroupStore {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const key = storeKey();
  const existing = globalObject[key] as ExtraGroupStore | undefined;
  if (existing) return existing;
  const created: ExtraGroupStore = {
    groups: new Map<string, ExtraSettingsGroupDef>(),
  };
  globalObject[key] = created;
  return created;
}

/** Register (or replace) an extra settings group. Last write for an id wins. */
export function registerSettingsGroup(group: ExtraSettingsGroupDef): void {
  getStore().groups.set(group.id, { ...group });
}

/** All registered extra groups, sorted by `order`. */
export function listExtraSettingsGroups(): ExtraSettingsGroupDef[] {
  return [...getStore().groups.values()].sort((a, b) => a.order - b.order);
}

/** Look up a single registered extra group by id. */
export function getExtraSettingsGroup(
  id: string,
): ExtraSettingsGroupDef | undefined {
  return getStore().groups.get(id);
}

/** The Cloud group id used by every cloud settings section in this directory. */
export const CLOUD_SETTINGS_GROUP_ID = "cloud";
