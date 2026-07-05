/**
 * In-process host-realm broker (#14179). An `in-process` view shares the host
 * DOM/JS realm with the shell, so without a boundary it can mutate global state
 * that belongs to the shell or bleeds into the next view: root/body classes,
 * `:root` CSS variables, `localStorage`/`sessionStorage`, and `history`
 * navigation. #14068 landed the wallpaper vector (the background broker); this
 * module completes the remaining four, driven by the SAME resolved surface
 * manifest so there is one policy source, not a parallel table.
 *
 * The broker mirrors `view-capability-broker.ts`: it reads a
 * {@link ResolvedSurfaceManifest} and gates each mutation on the grant that
 * governs it — `storage` for host-scoped persistence, `navigate` for shell
 * navigation — and scopes the DOM class/CSS-var vectors to the shell-owned
 * token set so a view's global reach never survives a navigation. A denied
 * mutation is an observable failure ({@link SurfaceRealmDeniedError}) or an
 * explicit view-namespaced scope, never a fabricated success. Default-deny: a
 * view with no grants gets the safe scope.
 *
 * Consumed by `App.tsx`, which resolves the active view's manifest and publishes
 * one {@link SurfaceRealmScope} per active view via
 * {@link setActiveSurfaceRealmScope}; the shell resets the DOM scope on view
 * teardown. Unit-tested in `surface-realm-broker.test.tsx`; proven end-to-end in
 * `App.surface-mutation-fuzz.test.tsx`.
 */

import type { ResolvedSurfaceManifest } from "@elizaos/core";
import { surfaceGrants } from "@elizaos/core";
import { THEME_CSS_VAR_MAP, THEME_FONT_CSS_VARS } from "@elizaos/shared";

/**
 * Raised when a view attempts a host-realm mutation its manifest does not grant.
 * Thrown (not swallowed) so the denial reaches the caller/agent observably — a
 * blocked write is never turned into a silent no-op that reads as success.
 */
export class SurfaceRealmDeniedError extends Error {
  constructor(
    readonly viewId: string,
    readonly vector: "storage" | "navigate",
    readonly detail: string,
  ) {
    super(`View "${viewId}" denied ${vector}: ${detail}`);
    this.name = "SurfaceRealmDeniedError";
  }
}

// ── Storage vector ───────────────────────────────────────────────────────────

/** Namespace every view-scoped storage key lives under when a view lacks `storage`. */
export const SURFACE_VIEW_STORAGE_PREFIX = "surface:view:";

// The shell persists all of its own UI state under these key namespaces
// (`packages/ui/src/state/persistence.ts`). A view path may never write them:
// even a `storage`-granted view is denied here, so a view can never overwrite
// the owner's theme, background, wallet, or server records.
const SHELL_RESERVED_STORAGE_PREFIXES = [
  "eliza:",
  "elizaos:",
  "eliza_",
] as const;

/** Whether a storage key belongs to the shell's own reserved namespace. */
export function isShellReservedStorageKey(key: string): boolean {
  return SHELL_RESERVED_STORAGE_PREFIXES.some((prefix) =>
    key.startsWith(prefix),
  );
}

/** The keyspace prefix a view without the `storage` grant is confined to. */
export function surfaceViewStoragePrefix(viewId: string): string {
  return `${SURFACE_VIEW_STORAGE_PREFIX}${viewId}:`;
}

/**
 * The storage surface handed to a view. A strict subset of the DOM `Storage`
 * interface (no index signature) so the façades below are strongly typed without
 * a cast — a view uses the methods, never bracket access.
 */
export interface ScopedStorage {
  readonly length: number;
  clear(): void;
  getItem(key: string): string | null;
  key(index: number): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

function namespacedStorage(backing: Storage, prefix: string): ScopedStorage {
  const ownedKeys = (): string[] => {
    const keys: string[] = [];
    for (let i = 0; i < backing.length; i += 1) {
      const key = backing.key(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys;
  };
  return {
    get length() {
      return ownedKeys().length;
    },
    clear() {
      for (const key of ownedKeys()) backing.removeItem(key);
    },
    getItem(key) {
      return backing.getItem(prefix + key);
    },
    key(index) {
      const key = ownedKeys()[index];
      return key === undefined ? null : key.slice(prefix.length);
    },
    removeItem(key) {
      backing.removeItem(prefix + key);
    },
    setItem(key, value) {
      backing.setItem(prefix + key, value);
    },
  };
}

function hostScopedStorage(backing: Storage, viewId: string): ScopedStorage {
  const assertWritable = (key: string): void => {
    if (isShellReservedStorageKey(key)) {
      throw new SurfaceRealmDeniedError(
        viewId,
        "storage",
        `reserved shell key "${key}" is not writable by a view`,
      );
    }
  };
  return {
    get length() {
      return backing.length;
    },
    clear() {
      // Never wipe the shell's own keys, even for a granted view: only clear
      // keys a view path was allowed to write.
      const removable: string[] = [];
      for (let i = 0; i < backing.length; i += 1) {
        const key = backing.key(i);
        if (key !== null && !isShellReservedStorageKey(key))
          removable.push(key);
      }
      for (const key of removable) backing.removeItem(key);
    },
    getItem(key) {
      return backing.getItem(key);
    },
    key(index) {
      return backing.key(index);
    },
    removeItem(key) {
      assertWritable(key);
      backing.removeItem(key);
    },
    setItem(key, value) {
      assertWritable(key);
      backing.setItem(key, value);
    },
  };
}

/**
 * The storage surface for a view, gated on its manifest. Without the `storage`
 * grant a view is confined to a view-prefixed keyspace it can never escape (its
 * writes cannot collide with the shell's keys). With the grant it uses the host
 * keyspace, but the shell's reserved keys stay off-limits — a view never
 * overwrites the owner's persisted shell state.
 */
export function brokerSurfaceStorage(
  manifest: ResolvedSurfaceManifest,
  backing: Storage,
  viewId: string,
): ScopedStorage {
  return surfaceGrants(manifest, "storage")
    ? hostScopedStorage(backing, viewId)
    : namespacedStorage(backing, surfaceViewStoragePrefix(viewId));
}

// ── Navigation vector ────────────────────────────────────────────────────────

/**
 * Wrap the shell's navigate function with the `navigate` gate. A view without
 * the grant cannot drive shell/history navigation: the wrapper throws instead of
 * calling through, so the shell route never moves out from under the user. A
 * granted view navigates normally.
 */
export function brokerSurfaceNavigate(
  manifest: ResolvedSurfaceManifest,
  viewId: string,
  navigate: (path: string) => void,
): (path: string) => void {
  return (path: string) => {
    if (!surfaceGrants(manifest, "navigate")) {
      throw new SurfaceRealmDeniedError(
        viewId,
        "navigate",
        `no "navigate" grant; blocked navigation to "${path}"`,
      );
    }
    navigate(path);
  };
}

// ── Root/body class + :root CSS-variable vector ──────────────────────────────

// The shell's own writers (`platform/init.ts`, `themes/apply-theme.ts`,
// `state/persistence.ts` accent/theme) are the only sanctioned mutators of
// root/body classes and `:root` variables. They run from a provider ABOVE
// `<App/>`, so their tokens land after the shell's per-view scope is created;
// the token allowlist below — not a mount-time snapshot — is what keeps them
// from being mistaken for a view injection and reset. A view that reaches
// `document.documentElement`/`document.body` directly writes a token that is
// neither shell-owned nor present when the view activated, so it is removed on
// teardown and cannot survive into the next view.

const SHELL_OWNED_ROOT_CLASSES: ReadonlySet<string> = new Set([
  "dark",
  "light",
]);

// Every `:root` CSS variable the shell writes. Sourced from the shell's own
// token maps so this cannot drift as the theme grows; the prefixes cover the
// dynamically-suffixed families (accent ramp, per-edge safe-area, content-pack).
const SHELL_OWNED_ROOT_VARS: ReadonlySet<string> = new Set([
  ...Object.values(THEME_CSS_VAR_MAP),
  ...Object.values(THEME_FONT_CSS_VARS),
]);
const SHELL_OWNED_ROOT_VAR_PREFIXES = [
  "--accent",
  "--primary",
  "--txt",
  "--ring",
  "--border-hover",
  "--safe-area-",
  "--keyboard-",
  "--pack-",
] as const;

function isShellOwnedRootClass(cls: string): boolean {
  return SHELL_OWNED_ROOT_CLASSES.has(cls);
}

function isShellOwnedBodyClass(cls: string): boolean {
  return cls === "native" || cls.startsWith("platform-");
}

function isShellOwnedRootVar(name: string): boolean {
  return (
    SHELL_OWNED_ROOT_VARS.has(name) ||
    SHELL_OWNED_ROOT_VAR_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function readRootVarNames(el: HTMLElement): string[] {
  const names: string[] = [];
  const { style } = el;
  for (let i = 0; i < style.length; i += 1) {
    const name = style.item(i);
    if (name.startsWith("--")) names.push(name);
  }
  return names;
}

/** The tokens removed by a host-realm reset — returned so callers can log/inspect. */
export interface HostRealmResetResult {
  rootClasses: string[];
  bodyClasses: string[];
  rootVars: string[];
}

// ── The per-view scope the shell publishes ───────────────────────────────────

/**
 * The host-realm boundary for one active in-process view, resolved from its
 * surface manifest. The shell constructs one when a view becomes active and
 * tears it down on navigation. It captures the class/var tokens present at
 * activation so shell state that legitimately changes while the view is open is
 * preserved, while anything the view injected globally is reset on teardown.
 */
export class SurfaceRealmScope {
  readonly storage: ScopedStorage;
  readonly navigate: (path: string) => void;
  private readonly rootClassBaseline: ReadonlySet<string>;
  private readonly bodyClassBaseline: ReadonlySet<string>;
  private readonly rootVarBaseline: ReadonlySet<string>;

  constructor(
    readonly manifest: ResolvedSurfaceManifest,
    readonly viewId: string,
    backing: Storage,
    navigate: (path: string) => void,
  ) {
    this.storage = brokerSurfaceStorage(manifest, backing, viewId);
    this.navigate = brokerSurfaceNavigate(manifest, viewId, navigate);
    if (typeof document === "undefined") {
      this.rootClassBaseline = new Set();
      this.bodyClassBaseline = new Set();
      this.rootVarBaseline = new Set();
    } else {
      this.rootClassBaseline = new Set(document.documentElement.classList);
      this.bodyClassBaseline = new Set(document.body.classList);
      this.rootVarBaseline = new Set(
        readRootVarNames(document.documentElement),
      );
    }
  }

  /**
   * Remove the root/body classes and `:root` variables this view added to the
   * host realm beyond the shell's own token set. Called on view teardown so a
   * view's global class/CSS-var mutation cannot leak into the next view.
   */
  resetHostRealm(): HostRealmResetResult {
    const result: HostRealmResetResult = {
      rootClasses: [],
      bodyClasses: [],
      rootVars: [],
    };
    if (typeof document === "undefined") return result;
    const root = document.documentElement;
    const { body } = document;
    for (const cls of [...root.classList]) {
      if (isShellOwnedRootClass(cls) || this.rootClassBaseline.has(cls))
        continue;
      root.classList.remove(cls);
      result.rootClasses.push(cls);
    }
    for (const cls of [...body.classList]) {
      if (isShellOwnedBodyClass(cls) || this.bodyClassBaseline.has(cls))
        continue;
      body.classList.remove(cls);
      result.bodyClasses.push(cls);
    }
    for (const name of readRootVarNames(root)) {
      if (isShellOwnedRootVar(name) || this.rootVarBaseline.has(name)) continue;
      root.style.removeProperty(name);
      result.rootVars.push(name);
    }
    return result;
  }
}

// The active scope is a process-wide singleton because the host realm is: only
// one view owns the foreground at a time. The shell publishes it here so the
// active view (and the isolation tests) reach exactly the brokered handles the
// shell resolved for the current manifest, never the raw globals.
let activeScope: SurfaceRealmScope | null = null;

/** Publish the scope for the active view. Pass `null` on teardown. */
export function setActiveSurfaceRealmScope(
  scope: SurfaceRealmScope | null,
): void {
  activeScope = scope;
}

/** The scope for the active view, or `null` when no view is mounted. */
export function getActiveSurfaceRealmScope(): SurfaceRealmScope | null {
  return activeScope;
}
