/**
 * Owns app-shell page registration and the generated in-process agent-bridge
 * inventory shared with overlay-app renderers. Plugins contribute metadata;
 * the shell derives stable bridge owners from the live registry snapshots and
 * rejects ambiguous handler ids before mounting either surface family.
 */
import type {
  AppShellBackgroundPolicy,
  SurfaceManifest,
  ViewHeaderPolicy,
  ViewKind,
} from "@elizaos/core";
import {
  getAllOverlayApps,
  type OverlayApp,
  packageNameToAppRouteSlug,
} from "@elizaos/shared";
import type { ComponentType } from "react";
import { getUiRegistryStore } from "./registry-host";

export type AppShellPageLoader = () => Promise<{
  default: ComponentType<Record<string, unknown>>;
  cleanup?: () => void | Promise<void>;
}>;

export type AppShellPageAvailability = "always" | "managed-cloud";

/**
 * A page contributed at runtime by a plugin or host app. Mirrors the fields
 * on `PluginAppNavTab` from `@elizaos/core`, plus either a resolved React
 * component or a lazy loader the shell mounts on demand.
 */
export interface AppShellPageRegistration {
  /** Stable id, scoped to the owning plugin (e.g. `"wallet.inventory"`). */
  id: string;
  /** Owning plugin id. */
  pluginId: string;
  /** Display label in the tab bar / nav. */
  label: string;
  /** Lucide icon name. */
  icon?: string;
  /** Route path the tab links to. */
  path: string;
  /**
   * Optional additional route patterns owned by this page. A `:segment`
   * consumes one path segment and a terminal `*` consumes the remainder. This
   * lets one host page own a nested family such as `/cloud/*` while its
   * navigation link remains the concrete `/cloud` root.
   */
  pathPatterns?: readonly string[];
  /**
   * Runtime availability enforced by the app router and every registry-backed
   * discovery surface. Defaults to `always`.
   */
  availability?: AppShellPageAvailability;
  /**
   * Optional shell tab id this route activates. Defaults to `id`; use this for
   * plugin pages that are mounted under an existing built-in tab.
   */
  tabAffinity?: string;
  /** Sort priority within the nav (lower = first). Default 100. */
  order?: number;
  /**
   * When true, only visible when Developer Mode is enabled in Settings.
   * Equivalent to `viewKind: "developer"`.
   */
  developerOnly?: boolean;
  /**
   * Four-tier visibility category. Supersedes `developerOnly` when set.
   * See {@link ViewKind}.
   */
  viewKind?: ViewKind;
  /** Optional named group the tab belongs to. */
  group?: string;
  /**
   * When true, the shell mounts this page edge-to-edge with no host
   * top-bar/chrome — for views that own their full window, e.g. the
   * orchestrator workbench.
   */
  fullBleed?: boolean;
  /**
   * Declared surface contract for this page (#13452) — background/header/
   * isolation/lifecycle policy and capability grants. The single source of truth
   * the shell derives surface decisions from; the standalone `backgroundPolicy`
   * / `headerPolicy` below are the legacy fallback used only when the matching
   * manifest field is absent. `surface.background: "shared"` paints the wallpaper
   * only when `surface.capabilities` also grants `wallpaper`.
   */
  surface?: SurfaceManifest;
  /**
   * Screen background policy for this page. Defaults to `"opaque"`. Superseded
   * by `surface.background` when a manifest is declared.
   */
  backgroundPolicy?: AppShellBackgroundPolicy;
  /**
   * Top-bar framing policy (#13586). Defaults to `"normal"`; the shell enforces
   * the shared `ViewHeader` on every `normal` page. `fullscreen`/`modal`/
   * `immersive` opt a page out of the uniform top bar. Superseded by
   * `surface.header` when a manifest is declared.
   */
  headerPolicy?: ViewHeaderPolicy;
  /**
   * The React component the shell mounts when this page is active.
   * Prefer `loader` for heavy pages so boot only pays metadata cost.
   */
  Component?: ComponentType<unknown>;
  /** Lazy page loader. The shell wraps it in React.lazy + Suspense. */
  loader?: AppShellPageLoader;
}

interface AppShellPageRegistryStore {
  entries: Map<string, AppShellPageRegistration>;
  listeners: Set<() => void>;
  version: number;
}

const APP_SHELL_PAGE_REGISTRY_STORE = "app-shell-pages";

function getRegistryStore(): AppShellPageRegistryStore {
  return getUiRegistryStore(APP_SHELL_PAGE_REGISTRY_STORE, () => ({
    entries: new Map<string, AppShellPageRegistration>(),
    listeners: new Set<() => void>(),
    version: 0,
  }));
}

export function registerAppShellPage(
  registration: AppShellPageRegistration,
): void {
  const store = getRegistryStore();
  store.entries.set(registration.id, registration);
  store.version += 1;
  for (const listener of store.listeners) listener();
}

export function listAppShellPages(): AppShellPageRegistration[] {
  return [...getRegistryStore().entries.values()];
}

function normalizedRouteSegments(path: string): string[] {
  return path
    .split(/[?#]/, 1)[0]
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
}

/** Pure exact/pattern matcher shared by navigation and the shell renderer. */
export function appShellPageMatchesPath(
  page: AppShellPageRegistration,
  navigationPath: string,
): boolean {
  const candidate = normalizedRouteSegments(navigationPath);
  const patterns = [page.path, ...(page.pathPatterns ?? [])];
  return patterns.some((pattern) => {
    const expected = normalizedRouteSegments(pattern);
    for (let index = 0; index < expected.length; index += 1) {
      const segment = expected[index];
      if (segment === "*") return index === expected.length - 1;
      if (candidate[index] === undefined) return false;
      if (!segment.startsWith(":") && segment !== candidate[index]) {
        return false;
      }
    }
    return candidate.length === expected.length;
  });
}

/** Pure runtime gate shared by routing, launcher, palette, and slash choices. */
export function appShellPageIsAvailable(
  page: AppShellPageRegistration,
  runtime: { managedCloud: boolean },
): boolean {
  return page.availability !== "managed-cloud" || runtime.managedCloud;
}

export function subscribeAppShellPages(listener: () => void): () => void {
  const store = getRegistryStore();
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

export function getAppShellPageRegistrySnapshot(): number {
  return getRegistryStore().version;
}

export type RegisteredAgentSurfaceKind = "app-shell" | "overlay";

export interface RegisteredAgentSurfaceDescriptor {
  kind: RegisteredAgentSurfaceKind;
  viewId: string;
  ownerId: string;
  path: string;
}

function requireStableAgentViewId(
  value: string,
  kind: RegisteredAgentSurfaceKind,
  ownerId: string,
): string {
  const viewId = value.trim();
  if (viewId.length === 0) {
    throw new Error(
      `Registered ${kind} surface "${ownerId}" resolved an empty agent view id`,
    );
  }
  return viewId;
}

function overlayAgentViewId(appName: string): string {
  const packageSlug = packageNameToAppRouteSlug(appName);
  if (packageSlug) return packageSlug;
  return appName
    .replace(/^@[^/]+\//, "")
    .replace(/^(app|plugin)-/, "")
    .replace(/[^a-z0-9-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/** The bridge descriptor generated for one app-shell page registration. */
export function appShellAgentSurfaceDescriptor(
  page: AppShellPageRegistration,
): RegisteredAgentSurfaceDescriptor {
  return {
    kind: "app-shell",
    viewId: requireStableAgentViewId(page.id, "app-shell", page.pluginId),
    ownerId: page.pluginId,
    path: page.path,
  };
}

/** The bridge descriptor generated for one overlay-app registration. */
export function overlayAgentSurfaceDescriptor(
  app: OverlayApp,
): RegisteredAgentSurfaceDescriptor {
  const viewId = requireStableAgentViewId(
    overlayAgentViewId(app.name),
    "overlay",
    app.name,
  );
  return {
    kind: "overlay",
    viewId,
    ownerId: app.name,
    path: `/apps/${viewId}`,
  };
}

/**
 * Build the exhaustive in-process bridge inventory from registry snapshots.
 * Duplicate identities fail closed: two mounted surfaces cannot safely share
 * one `viewType:viewId` interact-handler key.
 */
export function buildRegisteredAgentSurfaceInventory(
  appShellPages: readonly AppShellPageRegistration[],
  overlayApps: readonly OverlayApp[],
): RegisteredAgentSurfaceDescriptor[] {
  const descriptors = [
    ...appShellPages.map(appShellAgentSurfaceDescriptor),
    ...overlayApps.map(overlayAgentSurfaceDescriptor),
  ];
  const ownersByViewId = new Map<string, RegisteredAgentSurfaceDescriptor>();
  for (const descriptor of descriptors) {
    const existing = ownersByViewId.get(descriptor.viewId);
    if (existing) {
      throw new Error(
        `Agent surface view id "${descriptor.viewId}" is registered by both ` +
          `${existing.kind}:${existing.ownerId} and ${descriptor.kind}:${descriptor.ownerId}`,
      );
    }
    ownersByViewId.set(descriptor.viewId, descriptor);
  }
  return descriptors.sort((left, right) =>
    left.viewId.localeCompare(right.viewId),
  );
}

/** The current exhaustive bridge inventory, generated from both registries. */
export function listRegisteredAgentSurfaceInventory(): RegisteredAgentSurfaceDescriptor[] {
  return buildRegisteredAgentSurfaceInventory(
    listAppShellPages(),
    getAllOverlayApps(),
  );
}

/**
 * Resolve a renderer's descriptor through the exhaustive live inventory. This
 * makes duplicate-id validation part of the mount path, not a test-only audit.
 */
export function requireRegisteredAgentSurface(
  expected: RegisteredAgentSurfaceDescriptor,
): RegisteredAgentSurfaceDescriptor {
  const descriptor = listRegisteredAgentSurfaceInventory().find(
    (candidate) =>
      candidate.kind === expected.kind &&
      candidate.viewId === expected.viewId &&
      candidate.ownerId === expected.ownerId,
  );
  if (!descriptor) {
    throw new Error(
      `Agent surface ${expected.kind}:${expected.viewId} is not present in the live registry inventory`,
    );
  }
  return descriptor;
}

/**
 * A thunk that resolves a host-provided module for view bundles. View bundles
 * are built with `@elizaos/ui`, `react`, etc. left external; at runtime the
 * shell resolves each external specifier to the host's own singleton through
 * this importer so the view shares the host realm.
 */
export type HostExternalImporter = () => Promise<Record<string, unknown>>;

function hostExternalImporterRegistryKey(): symbol {
  return Symbol.for("elizaos.app-core.host-external-importer-registry");
}

function getHostExternalImporterStore(): Map<string, HostExternalImporter> {
  const globalObject = globalThis as Record<PropertyKey, unknown>;
  const registryKey = hostExternalImporterRegistryKey();
  const existing = globalObject[registryKey] as
    | Map<string, HostExternalImporter>
    | undefined;
  if (existing) return existing;
  const created = new Map<string, HostExternalImporter>();
  globalObject[registryKey] = created;
  return created;
}

/**
 * Contribute a host-external importer for a view-bundle specifier the framework
 * trunk map in `DynamicViewLoader` does not own. This is the extension point
 * that keeps plugin-specific specifiers (e.g. `@elizaos/plugin-browser`) out of
 * the shared UI trunk: a plugin app-shell bundle or a build-variant entrypoint
 * registers its own specifiers, and `DynamicViewLoader` consults this registry
 * after its framework map. Backed by a global-symbol store so a single registry
 * is shared even if `@elizaos/ui` is instantiated in more than one chunk.
 */
export function registerHostExternalImporter(
  specifier: string,
  importer: HostExternalImporter,
): void {
  getHostExternalImporterStore().set(specifier, importer);
}

/** Resolve a registered host-external importer, or `undefined` if none. */
export function resolveRegisteredHostExternalImporter(
  specifier: string,
): HostExternalImporter | undefined {
  return getHostExternalImporterStore().get(specifier);
}

/** The specifiers contributed through {@link registerHostExternalImporter}. */
export function registeredHostExternalSpecifiers(): string[] {
  return [...getHostExternalImporterStore().keys()];
}
