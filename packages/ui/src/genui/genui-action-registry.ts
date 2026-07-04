/**
 * Boot-time registry of the action names a generated-UI component may dispatch
 * (#12087 Item 26).
 *
 * Keyed on a global symbol, mirroring `settings-section-registry` /
 * `app-shell-registry`: each feature/plugin module contributes its allowed
 * action names/prefixes at import time, so a new action family needs no edit to
 * a shared constant in `catalog.ts`. The gate (`routeElizaGenUiAction`) reads
 * the registry, and an unregistered name still throws.
 *
 * The store self-seeds with the built-in prefixes ({@link
 * ELIZA_GENUI_ALLOWED_ACTION_PREFIXES}) so the default surface keeps working
 * with no explicit registration.
 */

import {
  ELIZA_GENUI_ALLOWED_ACTION_PREFIXES,
  isElizaGenUiActionNameAllowed,
} from "./catalog";

interface GenUiActionRegistryStore {
  /** Exact allowed action names (e.g. a plugin's `"myplugin.doThing"`). */
  names: Set<string>;
  /** Allowed action-name prefixes (e.g. `"myplugin."`). */
  prefixes: Set<string>;
}

function registryKey(): symbol {
  return Symbol.for("elizaos.ui.genui-action-registry");
}

function getStore(): GenUiActionRegistryStore {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const key = registryKey();
  const existing = globalObject[key] as GenUiActionRegistryStore | undefined;
  if (existing) return existing;
  const created: GenUiActionRegistryStore = {
    names: new Set<string>(),
    // Seed the built-in families so the default gate behavior is preserved.
    prefixes: new Set<string>(ELIZA_GENUI_ALLOWED_ACTION_PREFIXES),
  };
  globalObject[key] = created;
  return created;
}

/** Allow one exact generated-UI action name. */
export function registerElizaGenUiActionName(name: string): void {
  getStore().names.add(name);
}

/** Allow every generated-UI action name under `prefix` (e.g. `"myplugin."`). */
export function registerElizaGenUiActionPrefix(prefix: string): void {
  getStore().prefixes.add(prefix);
}

/** All currently-registered exact action names (built-ins never seed names). */
export function listElizaGenUiActionNames(): string[] {
  return [...getStore().names];
}

/** All currently-registered action prefixes (includes the built-in seeds). */
export function listElizaGenUiActionPrefixes(): string[] {
  return [...getStore().prefixes];
}

/**
 * Whether `eventName` is allowed by the registry — a registered exact name or a
 * registered prefix (built-in or plugin-contributed). This is the single gate
 * `routeElizaGenUiAction` consults; an unregistered name is rejected.
 */
export function isElizaGenUiActionAllowed(eventName: string): boolean {
  const store = getStore();
  return isElizaGenUiActionNameAllowed(
    eventName,
    [...store.prefixes],
    [...store.names],
  );
}
