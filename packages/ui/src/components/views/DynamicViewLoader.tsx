/**
 * DynamicViewLoader — loads a view bundle from a remote URL at runtime.
 *
 * Each view lives behind a React.lazy boundary so it is only fetched when
 * first navigated to, and an ErrorBoundary wrapper prevents a failing view
 * from crashing the shell.
 *
 * Loaded modules are cached by bundleUrl so re-mounting does not re-fetch.
 *
 * On iOS App Store and Google Play builds, dynamic remote JS loading is
 * prohibited by platform policy. The loader detects this and renders a
 * static fallback instead of attempting to import the bundle.
 *
 * When a view module exports an `interact(capability, params)` function, the
 * loader registers it with view-interact-registry so the agent can invoke
 * capabilities via POST /api/views/:id/interact → WS → here → WS result.
 * Standard capabilities (get-text, get-state, refresh, focus-element,
 * click-element, fill-input) are handled by the loader itself even when the
 * module has no interact export.
 */

import {
  HOST_EXTERNAL_RUNTIME_PARAM,
  HOST_EXTERNAL_SPECIFIERS_PARAM,
  type HostExternalBundleFactory,
  type HostModuleImporter,
  resolveAppBranding,
} from "@elizaos/shared";
import {
  type ComponentType,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import * as AgentSurfaceHost from "../../agent-surface";
import {
  AgentElementOverlay,
  AgentSurfaceElementReporter,
  AgentSurfaceProvider,
  getViewRegistry,
  handleAgentSurfaceCapability,
  isAgentSurfaceCapability,
  isSensitiveAgentElement,
  SENSITIVE_AGENT_ELEMENT_REASON,
  type ViewAgentRegistry,
} from "../../agent-surface";
import { client } from "../../api/index.ts";
import {
  type HostExternalImporter,
  registeredHostExternalSpecifiers,
  resolveRegisteredHostExternalImporter,
} from "../../app-shell-registry";
import {
  type EvictReason,
  emitModuleCacheTelemetry,
  type ModuleCacheTelemetryEvent,
} from "../../cache-telemetry";
import { APP_PAUSE_EVENT } from "../../events";
import { isDynamicViewLoadingAllowed } from "../../platform/platform-guards";
import { SpatialSurface } from "../../spatial/index.ts";
import {
  useAppSelector,
  useAppSelectorShallow,
} from "../../state/app-store.ts";
import {
  HEAP_PRESSURE_EVENT,
  isUnderMemoryPressure,
  planModuleCacheEvictions,
} from "../../state/bounded-view-lru";
import { installHeapPressureMonitor } from "../../state/heap-pressure-monitor";
import { useApp } from "../../state/useApp.ts";
import { registerDetailExtension } from "../apps/extensions/registry.ts";
import {
  formatDetailTimestamp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
} from "../apps/extensions/surface.helpers.ts";
import {
  SurfaceBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
} from "../apps/extensions/surface.tsx";
import { registerOverlayApp } from "../apps/overlay-app-registry.ts";
import { PagePanel } from "../composites/page-panel/index.ts";
import { Button } from "../ui/button.tsx";
import { ErrorBoundary } from "../ui/error-boundary";
import { Input } from "../ui/input.tsx";
import { Spinner } from "../ui/spinner.tsx";
import {
  navigateToViews,
  ViewErrorState,
  ViewLoadingSkeleton,
  ViewRestrictedState,
} from "./ViewStatusStates";
import { registerViewInteractHandler } from "./view-interact-registry";

interface ViewBundleModule {
  component: ComponentType<Record<string, unknown>>;
  interact?: (
    capability: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
  cleanup?: () => void | Promise<void>;
}

interface ViewBundleCacheEntry {
  key: string;
  promise: Promise<ViewBundleModule>;
  module: ViewBundleModule | null;
  refCount: number;
  lastUsedAt: number;
  cleanupScheduled: boolean;
  retentionTimer: ReturnType<typeof setTimeout> | null;
}

// Browser ESM modules cannot be forcibly unloaded once imported, but the shell
// can stop retaining the resolved module object and call the view's exported
// cleanup hook. Keep a tiny LRU of recently used views so quick tab switches are
// instant, then drop idle/heavy views automatically.
const bundleModuleCache = new Map<string, ViewBundleCacheEntry>();
const DEFAULT_BUNDLE_CACHE_TTL_MS = 5 * 60_000;
const LOW_MEMORY_BUNDLE_CACHE_TTL_MS = 60_000;
const DEFAULT_BUNDLE_CACHE_MAX_ENTRIES = 6;
const LOW_MEMORY_BUNDLE_CACHE_MAX_ENTRIES = 2;

let bundleCacheLifecycleInstalled = false;
let pruneBundleCacheOnPressure: (() => void) | null = null;
let pruneBundleCacheOnHeapPressure: (() => void) | null = null;
let pruneBundleCacheOnVisibilityHidden: (() => void) | null = null;
let pruneBundleCacheOnAppPause: (() => void) | null = null;

function bundleCacheStats(): {
  activeCount: number;
  idleCount: number;
  cacheSize: number;
} {
  let activeCount = 0;
  let idleCount = 0;
  for (const entry of bundleModuleCache.values()) {
    if (entry.refCount > 0) {
      activeCount += 1;
    } else {
      idleCount += 1;
    }
  }
  return { activeCount, idleCount, cacheSize: bundleModuleCache.size };
}

function emitBundleTelemetry(
  action: ModuleCacheTelemetryEvent["action"],
  patch: { key?: string; reason?: EvictReason } = {},
): void {
  emitModuleCacheTelemetry({
    source: "dynamic-view",
    action,
    ...patch,
    ...bundleCacheStats(),
  });
}

function getBundleCacheMaxEntries(): number {
  if (isUnderMemoryPressure()) {
    return LOW_MEMORY_BUNDLE_CACHE_MAX_ENTRIES;
  }
  return DEFAULT_BUNDLE_CACHE_MAX_ENTRIES;
}

function getBundleCacheTtlMs(): number {
  if (isUnderMemoryPressure()) return LOW_MEMORY_BUNDLE_CACHE_TTL_MS;
  return DEFAULT_BUNDLE_CACHE_TTL_MS;
}

function scheduleIdleWork(work: () => void): void {
  if (typeof window === "undefined") {
    work();
    return;
  }
  const w = window as Window & {
    requestIdleCallback?: (
      cb: () => void,
      options?: { timeout?: number },
    ) => number;
  };
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(work, { timeout: 2_000 });
    return;
  }
  window.setTimeout(work, 250);
}

function runBundleCleanup(cleanup: ViewBundleModule["cleanup"]): void {
  if (!cleanup) return;
  void Promise.resolve()
    .then(() => cleanup())
    .catch(() => {
      // View cleanup must never crash the host shell.
    });
}

function cleanupBundleEntry(
  entry: ViewBundleCacheEntry,
  reason: EvictReason,
): void {
  if (entry.refCount > 0) return;
  if (entry.cleanupScheduled) return;
  entry.cleanupScheduled = true;
  if (bundleModuleCache.get(entry.key) === entry) {
    bundleModuleCache.delete(entry.key);
  }
  if (entry.retentionTimer) {
    clearTimeout(entry.retentionTimer);
    entry.retentionTimer = null;
  }
  const cleanup = entry.module?.cleanup;
  entry.module = null;
  emitBundleTelemetry("evict", { key: entry.key, reason });
  runBundleCleanup(cleanup);
  if (cleanup) emitBundleTelemetry("cleanup", { key: entry.key, reason });
}

function armBundleEntryRetentionTimer(entry: ViewBundleCacheEntry): void {
  if (typeof window === "undefined") return;
  if (entry.retentionTimer) {
    clearTimeout(entry.retentionTimer);
  }
  entry.retentionTimer = setTimeout(() => {
    entry.retentionTimer = null;
    scheduleIdleWork(() => pruneBundleModuleCache());
  }, getBundleCacheTtlMs() + 50);
}

function pruneBundleModuleCache(
  options: { force?: boolean; reason?: EvictReason } = {},
): void {
  const ttlReason =
    options.reason ?? (options.force ? "memorypressure" : "ttl");
  const lruReason = options.reason ?? "lru";
  const plan = planModuleCacheEvictions([...bundleModuleCache.values()], {
    now: Date.now(),
    ttlMs: options.force ? 0 : getBundleCacheTtlMs(),
    maxEntries: options.force ? 0 : getBundleCacheMaxEntries(),
    force: options.force ?? false,
    totalSize: bundleModuleCache.size,
  });
  for (const { entry, phase } of plan) {
    cleanupBundleEntry(entry, phase === "ttl" ? ttlReason : lruReason);
  }
}

function installBundleCacheLifecycle(): void {
  if (bundleCacheLifecycleInstalled || typeof window === "undefined") return;
  bundleCacheLifecycleInstalled = true;
  installHeapPressureMonitor();
  pruneBundleCacheOnPressure = () => {
    scheduleIdleWork(() =>
      pruneBundleModuleCache({ force: true, reason: "memorypressure" }),
    );
  };
  // Real heap-driven eviction (#10196): the shared heap-pressure monitor
  // (installHeapPressureMonitor) dispatches this when live usedJSHeapSize
  // crosses HEAP_PRESSURE_RATIO. Unlike the never-fired `memorypressure`
  // window event, this actually feeds live heap into the cache.
  pruneBundleCacheOnHeapPressure = () => {
    scheduleIdleWork(() =>
      pruneBundleModuleCache({ force: true, reason: "heap-pressure" }),
    );
  };
  pruneBundleCacheOnVisibilityHidden = () => {
    if (document.visibilityState === "hidden") {
      scheduleIdleWork(() =>
        pruneBundleModuleCache({ reason: "visibility-hidden" }),
      );
    }
  };
  pruneBundleCacheOnAppPause = () => {
    scheduleIdleWork(() =>
      pruneBundleModuleCache({ force: true, reason: "app-pause" }),
    );
  };
  window.addEventListener("memorypressure", pruneBundleCacheOnPressure);
  document.addEventListener(
    HEAP_PRESSURE_EVENT,
    pruneBundleCacheOnHeapPressure,
  );
  document.addEventListener(
    "visibilitychange",
    pruneBundleCacheOnVisibilityHidden,
  );
  document.addEventListener(APP_PAUSE_EVENT, pruneBundleCacheOnAppPause);
}

export function __resetDynamicViewLoaderCacheForTests(): void {
  for (const entry of bundleModuleCache.values()) {
    if (entry.retentionTimer) {
      clearTimeout(entry.retentionTimer);
      entry.retentionTimer = null;
    }
    const cleanup = entry.module?.cleanup;
    entry.module = null;
    runBundleCleanup(cleanup);
  }
  bundleModuleCache.clear();
  if (typeof window !== "undefined" && pruneBundleCacheOnPressure) {
    window.removeEventListener("memorypressure", pruneBundleCacheOnPressure);
  }
  if (typeof document !== "undefined" && pruneBundleCacheOnHeapPressure) {
    document.removeEventListener(
      HEAP_PRESSURE_EVENT,
      pruneBundleCacheOnHeapPressure,
    );
  }
  if (typeof document !== "undefined" && pruneBundleCacheOnVisibilityHidden) {
    document.removeEventListener(
      "visibilitychange",
      pruneBundleCacheOnVisibilityHidden,
    );
  }
  if (typeof document !== "undefined" && pruneBundleCacheOnAppPause) {
    document.removeEventListener(APP_PAUSE_EVENT, pruneBundleCacheOnAppPause);
  }
  pruneBundleCacheOnPressure = null;
  pruneBundleCacheOnHeapPressure = null;
  pruneBundleCacheOnVisibilityHidden = null;
  pruneBundleCacheOnAppPause = null;
  bundleCacheLifecycleInstalled = false;
}

function isReactComponentExport(
  value: unknown,
): value is ComponentType<Record<string, unknown>> {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

function importHostExternal(
  specifier: string,
): Promise<Record<string, unknown>> {
  return import(/* @vite-ignore */ specifier) as Promise<
    Record<string, unknown>
  >;
}

const APP_CORE_VIEW_COMPAT: Record<string, unknown> = {
  client,
  resolveAppBranding,
  Button,
  Input,
  Spinner,
  PagePanel,
  registerDetailExtension,
  registerOverlayApp,
  useApp,
  useAppSelector,
  useAppSelectorShallow,
  SurfaceBadge,
  SurfaceCard,
  SurfaceEmptyState,
  SurfaceGrid,
  SurfaceSection,
  formatDetailTimestamp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
};

async function importAppCoreViewCompat(): Promise<Record<string, unknown>> {
  return APP_CORE_VIEW_COMPAT;
}

async function importUiComponentsCompat(): Promise<Record<string, unknown>> {
  return import("../index.ts");
}

async function importUiRootCompat(): Promise<Record<string, unknown>> {
  return import("../../index.ts");
}

// Framework + host modules the shell always provides to every view bundle:
// react, three, `@elizaos/ui/*`, the `@elizaos/app-core` view compat surface,
// `@elizaos/shared`, and the native capacitor bridges. This map is
// FRAMEWORK-ONLY — it must never list a plugin-specific specifier. A plugin (or
// a build-variant entrypoint) contributes its own specifiers through
// `registerHostExternalImporter` so adding a host-external plugin never edits
// this shared UI module.
const HOST_EXTERNAL_IMPORTERS: Record<string, HostExternalImporter> = {
  "@elizaos/app-core": importAppCoreViewCompat,
  "@elizaos/app-core/browser": importAppCoreViewCompat,
  "@elizaos/app-core/ui-compat": importAppCoreViewCompat,
  "@elizaos/capacitor-contacts": () =>
    importHostExternal("@elizaos/capacitor-contacts"),
  "@elizaos/capacitor-messages": () =>
    importHostExternal("@elizaos/capacitor-messages"),
  "@elizaos/capacitor-mobile-signals": () =>
    importHostExternal("@elizaos/capacitor-mobile-signals"),
  "@elizaos/capacitor-phone": () =>
    importHostExternal("@elizaos/capacitor-phone"),
  "@elizaos/capacitor-system": () =>
    importHostExternal("@elizaos/capacitor-system"),
  "@elizaos/shared": () => importHostExternal("@elizaos/shared"),
  "@elizaos/ui": importUiRootCompat,
  "@elizaos/ui/agent-surface": async () => AgentSurfaceHost,
  "@elizaos/ui/app-navigate-view": () => import("../../app-navigate-view.ts"),
  "@elizaos/ui/api": () => import("../../api/index.ts"),
  "@elizaos/ui/bridge": () => import("../../bridge/index.ts"),
  "@elizaos/ui/components": importUiComponentsCompat,
  "@elizaos/ui/config": () => import("../../config/index.ts"),
  "@elizaos/ui/events": () => import("../../events/index.ts"),
  "@elizaos/ui/hooks": () => import("../../hooks/index.ts"),
  "@elizaos/ui/layouts": () => import("../../layouts/index.ts"),
  "@elizaos/ui/platform": () => import("../../platform/index.ts"),
  "@elizaos/ui/platform/ios-runtime": () =>
    import("../../platform/ios-runtime.ts"),
  "@elizaos/ui/spatial": () => import("../../spatial/index.ts"),
  "@elizaos/ui/spatial/tui": () => import("../../spatial/tui/index.ts"),
  "@elizaos/ui/state": () => import("../../state/index.ts"),
  "@elizaos/ui/state/useApp": () => import("../../state/useApp.ts"),
  "@elizaos/ui/utils": () => import("../../utils/index.ts"),
  "@elizaos/ui/components/composites/page-panel": () =>
    import("../composites/page-panel/index.ts"),
  "@elizaos/ui/components/composites/sidebar/sidebar-content": () =>
    import("../composites/sidebar/sidebar-content.tsx"),
  "@elizaos/ui/components/composites/sidebar/sidebar-panel": () =>
    import("../composites/sidebar/sidebar-panel.tsx"),
  "@elizaos/ui/components/composites/sidebar/sidebar-scroll-region": () =>
    import("../composites/sidebar/sidebar-scroll-region.tsx"),
  "@elizaos/ui/components/pages/MemoryDetailPanel": () =>
    import("../pages/MemoryDetailPanel.tsx"),
  "@elizaos/ui/components/pages/vector-browser-utils": () =>
    import("../pages/vector-browser-utils.ts"),
  "@elizaos/ui/components/shared/AppPageSidebar": () =>
    import("../shared/AppPageSidebar.tsx"),
  "@elizaos/ui/components/views/TerminalPluginView": () =>
    import("./TerminalPluginView.tsx"),
  "@elizaos/ui/components/ui/button": () => import("../ui/button.tsx"),
  "@elizaos/ui/components/ui/input": () => import("../ui/input.tsx"),
  "@elizaos/ui/components/ui/select": () => import("../ui/select.tsx"),
  "@elizaos/ui/components/ui/settings-controls": () =>
    import("../ui/settings-controls.tsx"),
  "@elizaos/ui/components/ui/spinner": () => import("../ui/spinner.tsx"),
  "@elizaos/ui/components/ui/skeleton-layouts": () =>
    import("../ui/skeleton-layouts.tsx"),
  "@elizaos/ui/components/ui/tabs": () => import("../ui/tabs.tsx"),
  "@elizaos/ui/components/ui/textarea": () => import("../ui/textarea.tsx"),
  "@elizaos/ui/components/ui/tooltip-extended": () =>
    import("../ui/tooltip-extended.tsx"),
  "lucide-react": () => import("lucide-react"),
  "@pixiv/three-vrm": () => import("@pixiv/three-vrm"),
  "@pixiv/three-vrm/nodes": () => import("@pixiv/three-vrm/nodes"),
  react: () => import("react"),
  "react/jsx-dev-runtime": async () => {
    const devRuntime = await import("react/jsx-dev-runtime");
    if (typeof devRuntime.jsxDEV === "function") {
      return devRuntime;
    }
    const runtime = await import("react/jsx-runtime");
    return { ...runtime, jsxDEV: runtime.jsx };
  },
  "react/jsx-runtime": () => import("react/jsx-runtime"),
  three: () => import("three"),
  "three/tsl": () => import("three/tsl"),
  "three/webgpu": () => import("three/webgpu"),
  "three/examples/jsm/controls/OrbitControls.js": () =>
    import("three/examples/jsm/controls/OrbitControls.js"),
  "three/examples/jsm/libs/meshopt_decoder.module.js": () =>
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
  "three/examples/jsm/loaders/DRACOLoader.js": () =>
    import("three/examples/jsm/loaders/DRACOLoader.js"),
  "three/examples/jsm/loaders/FBXLoader.js": () =>
    import("three/examples/jsm/loaders/FBXLoader.js"),
  "three/examples/jsm/loaders/GLTFLoader.js": () =>
    import("three/examples/jsm/loaders/GLTFLoader.js"),
};

/**
 * Resolve a view-bundle external specifier to its importer: the framework trunk
 * map first, then the specifiers plugins/build variants contributed through
 * `registerHostExternalImporter`.
 */
function resolveHostExternalImporter(
  specifier: string,
): HostExternalImporter | undefined {
  return (
    HOST_EXTERNAL_IMPORTERS[specifier] ??
    resolveRegisteredHostExternalImporter(specifier)
  );
}

/**
 * Every specifier the shell can rewrite for a view bundle — the framework trunk
 * map plus the registered extension specifiers. Computed per bundle load so a
 * plugin registered after this module evaluated is still honored.
 */
function hostExternalSpecifiers(): string[] {
  return [
    ...Object.keys(HOST_EXTERNAL_IMPORTERS),
    ...registeredHostExternalSpecifiers(),
  ];
}

declare global {
  interface Window {
    __ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__?: (
      bundleUrl: string,
    ) => Promise<Record<string, unknown>>;
  }
}

/**
 * Resolve one host-external specifier to the host shell's live singleton (the
 * framework trunk map first, then registered plugin/build-variant specifiers).
 * Passed to a served view bundle's factory (its default export) as the {@link
 * HostModuleImporter} it resolves its externals through — no `globalThis` bridge.
 * Exported so tests can exercise the resolver the factory receives.
 */
export const hostImport: HostModuleImporter = async (specifier) => {
  const importer = resolveHostExternalImporter(specifier);
  if (!importer) {
    throw new Error(
      `DynamicViewLoader: unsupported host external "${specifier}"`,
    );
  }
  return importer();
};

/**
 * A served view bundle's default export is a `HostExternalBundleFactory`: call
 * it with {@link hostImport} to get the view's export namespace. Test/dev bundle
 * modules injected through `__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__` already return
 * a namespace directly, so a non-function default passes through unchanged.
 */
async function resolveBundleNamespace(
  mod: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const factory = mod.default;
  if (typeof factory !== "function") return mod;
  return (factory as HostExternalBundleFactory)(hostImport);
}

/** Dev-mode polling interval in ms. Not used in production builds. */
const DEV_POLL_INTERVAL_MS = 2000;

/**
 * A view bundle is executed as an ES module in the host realm (it receives the
 * host React singleton, the API client, and the native bridges via the
 * host-external map), so it runs with full app privilege. Only ever import a
 * bundle served by THIS origin: a cross-origin `bundleUrl` (which an untrusted
 * remote-plugin descriptor can announce) would be arbitrary attacker code
 * executing against the user's authenticated session. Every shipped view is
 * same-origin (`/api/views/<id>/bundle.js`); a future remote/CDN bundle must add
 * Subresource-Integrity before this gate can be relaxed.
 */
export function isSameOriginBundleUrl(bundleUrl: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    return (
      new URL(bundleUrl, window.location.href).origin === window.location.origin
    );
  } catch {
    return false;
  }
}

async function importViewBundle(
  bundleUrl: string,
): Promise<Record<string, unknown>> {
  if (
    (import.meta.env.DEV ||
      import.meta.env.MODE === "test" ||
      process.env.NODE_ENV === "test") &&
    typeof window !== "undefined" &&
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__
  ) {
    return window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__(bundleUrl);
  }

  if (!isSameOriginBundleUrl(bundleUrl)) {
    throw new Error(
      `DynamicViewLoader: refusing to import a cross-origin view bundle (${bundleUrl}). View bundles must be served same-origin from /api/views/.`,
    );
  }

  const hostExternalUrl = buildHostExternalBundleUrl(bundleUrl);
  if (hostExternalUrl) {
    return resolveBundleNamespace(
      await import(/* @vite-ignore */ hostExternalUrl),
    );
  }

  try {
    return await import(/* @vite-ignore */ bundleUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("Failed to resolve module specifier")) {
      throw err;
    }
  }

  const rewrittenUrl = buildHostExternalBundleUrl(bundleUrl);
  if (!rewrittenUrl) {
    throw new Error(
      `DynamicViewLoader: bundle at ${bundleUrl} could not use host externals`,
    );
  }
  return resolveBundleNamespace(await import(/* @vite-ignore */ rewrittenUrl));
}

function buildHostExternalBundleUrl(bundleUrl: string): string | null {
  if (typeof window === "undefined") return null;
  const rewrittenUrl = new URL(bundleUrl, window.location.href);
  if (rewrittenUrl.origin !== window.location.origin) return null;
  if (!rewrittenUrl.pathname.startsWith("/api/views/")) return null;
  rewrittenUrl.searchParams.set(HOST_EXTERNAL_RUNTIME_PARAM, "1");
  rewrittenUrl.searchParams.set(
    HOST_EXTERNAL_SPECIFIERS_PARAM,
    hostExternalSpecifiers().join(","),
  );
  return rewrittenUrl.href;
}

function ensureBundleModuleEntry(
  bundleUrl: string,
  componentExport: string,
): ViewBundleCacheEntry {
  const cacheKey = `${bundleUrl}::${componentExport}`;
  const cached = bundleModuleCache.get(cacheKey);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return cached;
  }

  let entry: ViewBundleCacheEntry;
  const promise = importViewBundle(bundleUrl).then(
    (mod: Record<string, unknown>) => {
      const exported = mod[componentExport] ?? mod.default;
      if (!isReactComponentExport(exported)) {
        throw new Error(
          `DynamicViewLoader: bundle at ${bundleUrl} did not export a React component as "${componentExport}"`,
        );
      }
      const interact =
        typeof mod.interact === "function"
          ? (mod.interact as ViewBundleModule["interact"])
          : undefined;
      const cleanup =
        typeof mod.cleanup === "function" ? mod.cleanup : undefined;
      const module = {
        component: exported as ComponentType<Record<string, unknown>>,
        interact,
        cleanup: cleanup as ViewBundleModule["cleanup"],
      };
      entry.module = module;
      entry.lastUsedAt = Date.now();
      emitBundleTelemetry("load", { key: cacheKey });
      if (
        entry.cleanupScheduled ||
        (bundleModuleCache.get(cacheKey) !== entry && entry.refCount === 0)
      ) {
        const cleanup = entry.module.cleanup;
        entry.module = null;
        runBundleCleanup(cleanup);
        if (cleanup) emitBundleTelemetry("cleanup", { key: cacheKey });
        return module;
      }
      if (entry.refCount === 0) {
        armBundleEntryRetentionTimer(entry);
        scheduleIdleWork(() => pruneBundleModuleCache());
      }
      return module;
    },
    (error) => {
      if (bundleModuleCache.get(cacheKey) === entry) {
        bundleModuleCache.delete(cacheKey);
      }
      emitBundleTelemetry("load-error", { key: cacheKey });
      throw error;
    },
  );

  entry = {
    key: cacheKey,
    promise,
    module: null,
    refCount: 0,
    lastUsedAt: Date.now(),
    cleanupScheduled: false,
    retentionTimer: null,
  };
  bundleModuleCache.set(cacheKey, entry);
  return entry;
}

function acquireBundleModule(
  bundleUrl: string,
  componentExport: string,
): {
  cacheKey: string;
  promise: Promise<ViewBundleModule>;
  release: () => void;
} {
  installBundleCacheLifecycle();
  const entry = ensureBundleModuleEntry(bundleUrl, componentExport);
  entry.refCount += 1;
  entry.lastUsedAt = Date.now();
  if (entry.retentionTimer) {
    clearTimeout(entry.retentionTimer);
    entry.retentionTimer = null;
  }

  let released = false;
  return {
    cacheKey: entry.key,
    promise: entry.promise,
    release: () => {
      if (released) return;
      released = true;
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsedAt = Date.now();
      emitBundleTelemetry("release", { key: entry.key });
      if (entry.refCount === 0) {
        if (bundleModuleCache.get(entry.key) === entry) {
          armBundleEntryRetentionTimer(entry);
          scheduleIdleWork(() => pruneBundleModuleCache());
        } else {
          cleanupBundleEntry(entry, "invalidate");
        }
      }
    },
  };
}

function invalidateBundleModule(cacheKey: string): void {
  const entry = bundleModuleCache.get(cacheKey);
  if (!entry) return;
  bundleModuleCache.delete(cacheKey);
  if (entry.refCount === 0) {
    cleanupBundleEntry(entry, "invalidate");
  }
}

const STANDARD_CAPABILITIES = new Set([
  "get-state",
  "refresh",
  "focus-element",
  "click-element",
  "fill-input",
  "get-text",
]);

const DOM_FILLABLE_AGENT_ROLES = new Set([
  "text-input",
  "number-input",
  "textarea",
  "select",
  "slider",
]);

const DOM_CLICKABLE_AGENT_ROLES = new Set([
  "button",
  "link",
  "toggle",
  "tab",
  "menu-item",
  "list-item",
  "card",
]);

function resolveInteractTarget(
  containerEl: HTMLElement | null,
  params: Record<string, unknown> | undefined,
): { target: HTMLElement | null; selector: string | null } {
  const selector =
    typeof params?.selector === "string" ? params.selector : null;
  const name = typeof params?.name === "string" ? params.name : null;
  const target =
    (selector && containerEl?.querySelector<HTMLElement>(selector)) ||
    (name &&
      containerEl?.querySelector<HTMLElement>(
        `[name="${CSS.escape(name)}"]`,
      )) ||
    null;
  return { target, selector: selector ?? name };
}

function setNativeInputValue(
  target: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : target instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(target, value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
}

function agentSelector(id: string): string {
  return `[data-agent-id="${CSS.escape(id)}"]`;
}

function getAgentElementById(
  containerEl: HTMLElement | null,
  id: string,
): HTMLElement | null {
  return containerEl?.querySelector<HTMLElement>(agentSelector(id)) ?? null;
}

function readElementValue(el: HTMLElement): unknown {
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      return el.checked;
    }
    return el.value;
  }
  return undefined;
}

function snapshotDomAgentElement(el: HTMLElement) {
  const rect = el.getBoundingClientRect();
  const role = el.getAttribute("data-agent-role") || "region";
  const descriptor = {
    id: el.getAttribute("data-agent-id") || "",
    label: el.getAttribute("data-agent-label") || "",
    sensitive: el.getAttribute("data-agent-sensitive") === "true",
  };
  const sensitive = isSensitiveAgentElement(descriptor, el);
  return {
    id: descriptor.id,
    role,
    label: descriptor.label,
    status: el.getAttribute("data-state") || undefined,
    ...(sensitive
      ? { sensitive: true, valueRedacted: true }
      : { value: readElementValue(el) }),
    fillable: DOM_FILLABLE_AGENT_ROLES.has(role),
    clickable: DOM_CLICKABLE_AGENT_ROLES.has(role),
    focused:
      typeof document !== "undefined" &&
      (document.activeElement === el || el.contains(document.activeElement)),
    visible: rect.width > 0 && rect.height > 0,
    bounds: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

function listDomAgentElements(containerEl: HTMLElement | null) {
  if (!containerEl) return [];
  return [...containerEl.querySelectorAll<HTMLElement>("[data-agent-id]")]
    .map(snapshotDomAgentElement)
    .filter((item) => item.id.length > 0);
}

function handleDomAgentSurfaceCapability(
  viewId: string,
  viewType: "gui" | "tui" | "xr",
  capability: string,
  params: Record<string, unknown> | undefined,
  containerEl: HTMLElement | null,
): unknown {
  switch (capability) {
    case "list-elements": {
      const role = typeof params?.role === "string" ? params.role : null;
      const elements = listDomAgentElements(containerEl);
      return role ? elements.filter((item) => item.role === role) : elements;
    }

    case "get-agent-state": {
      const elements = listDomAgentElements(containerEl);
      const focused = elements.find((item) => item.focused)?.id ?? null;
      return {
        viewId,
        viewType,
        elementCount: elements.length,
        focusedId: focused,
        elements,
        updatedAt: Date.now(),
      };
    }

    case "describe-element": {
      const id = agentIdParam(params);
      if (!id) throw new Error("describe-element requires an `id` parameter");
      const el = getAgentElementById(containerEl, id);
      if (!el) throw new Error(`No element registered with id "${id}"`);
      return snapshotDomAgentElement(el);
    }

    case "get-focus": {
      const elements = listDomAgentElements(containerEl);
      const element = elements.find((item) => item.focused) ?? null;
      return { focusedId: element?.id ?? null, element };
    }

    case "agent-focus": {
      const id = agentIdParam(params);
      if (!id) throw new Error("agent-focus requires an `id` parameter");
      const el = getAgentElementById(containerEl, id);
      if (!el) return { ok: false, id, reason: "element not found" };
      el.focus();
      return { ok: true, id };
    }

    case "agent-click": {
      const id = agentIdParam(params);
      if (!id) throw new Error("agent-click requires an `id` parameter");
      const el = getAgentElementById(containerEl, id);
      if (!el) return { ok: false, id, reason: "element not found" };
      el.click();
      return { ok: true, id };
    }

    case "agent-fill": {
      const id = agentIdParam(params);
      const value = typeof params?.value === "string" ? params.value : null;
      if (!id) throw new Error("agent-fill requires an `id` parameter");
      if (value === null) {
        throw new Error("agent-fill requires a string `value` parameter");
      }
      const el = getAgentElementById(containerEl, id);
      if (!el) return { ok: false, id, reason: "element not found" };
      if (
        isSensitiveAgentElement(
          {
            id,
            label: el.getAttribute("data-agent-label") || "",
            sensitive: el.getAttribute("data-agent-sensitive") === "true",
          },
          el,
        )
      ) {
        return { ok: false, id, reason: SENSITIVE_AGENT_ELEMENT_REASON };
      }
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) {
        setNativeInputValue(el, value);
        return { ok: true, id, value };
      }
      return { ok: false, id, reason: "element is not a native field" };
    }

    case "agent-scroll-to": {
      const id = agentIdParam(params);
      if (!id) throw new Error("agent-scroll-to requires an `id` parameter");
      const el = getAgentElementById(containerEl, id);
      if (!el) return { ok: false, id, reason: "element not found" };
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return { ok: true, id };
    }

    case "set-highlight":
      return { highlighting: false };

    default:
      throw new Error(`Unknown agent-surface capability "${capability}"`);
  }
}

/**
 * Handle a standard capability on the view container element.
 * Called when a view module does not export an `interact` function, or when
 * the capability is a known standard one (ensuring baseline support).
 */
function agentIdParam(
  params: Record<string, unknown> | undefined,
): string | null {
  const id = params?.agentId ?? params?.id;
  return typeof id === "string" ? id : null;
}

async function handleStandardCapability(
  capability: string,
  params: Record<string, unknown> | undefined,
  containerEl: HTMLElement | null,
  setReloadKey: (fn: (k: number) => number) => void,
  cacheKey: string,
  registry: ViewAgentRegistry | undefined,
): Promise<unknown> {
  switch (capability) {
    case "get-text":
      return containerEl?.innerText ?? "";

    case "get-state": {
      // Prefer the agent-surface snapshot when the view registers elements; it
      // supersedes the legacy manual `[data-view-state]` attribute.
      if (registry && registry.size() > 0) {
        return registry.snapshot();
      }
      const stateEl = containerEl?.querySelector("[data-view-state]");
      if (stateEl) {
        try {
          return JSON.parse(stateEl.getAttribute("data-view-state") ?? "{}");
        } catch {
          return {};
        }
      }
      return {};
    }

    case "refresh":
      invalidateBundleModule(cacheKey);
      setReloadKey((k) => k + 1);
      return { refreshed: true };

    case "focus-element": {
      // Addressing by registered agent id takes precedence over raw selectors.
      const id = agentIdParam(params);
      if (id && registry) {
        const result = registry.focus(id);
        return { focused: result.ok, id, reason: result.reason };
      }
      const { target, selector } = resolveInteractTarget(containerEl, params);
      if (target) {
        target.focus();
        return { focused: true, selector };
      }
      return { focused: false, reason: "element not found" };
    }

    case "click-element": {
      const id = agentIdParam(params);
      if (id && registry) {
        const result = registry.click(id);
        return { clicked: result.ok, id, reason: result.reason };
      }
      const { target, selector } = resolveInteractTarget(containerEl, params);
      if (target) {
        target.click();
        return { clicked: true, selector };
      }
      return { clicked: false, reason: "element not found" };
    }

    case "fill-input": {
      const value = typeof params?.value === "string" ? params.value : null;
      if (value === null) {
        return { filled: false, reason: "value must be a string" };
      }
      const id = agentIdParam(params);
      if (id && registry) {
        const result = registry.fill(id, value);
        return {
          filled: result.ok,
          id,
          reason: result.reason,
          ...(result.ok ? { value } : {}),
        };
      }
      const { target, selector } = resolveInteractTarget(containerEl, params);
      if (!target) {
        return { filled: false, reason: "element not found" };
      }
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        if (
          isSensitiveAgentElement(
            {
              id:
                target.getAttribute("data-agent-id") ||
                target.id ||
                target.name ||
                selector ||
                "",
              label: target.getAttribute("data-agent-label") || "",
              sensitive: target.getAttribute("data-agent-sensitive") === "true",
            },
            target,
          )
        ) {
          return {
            filled: false,
            selector,
            reason: SENSITIVE_AGENT_ELEMENT_REASON,
          };
        }
        setNativeInputValue(target, value);
        return { filled: true, selector, value };
      }
      return { filled: false, reason: "element is not fillable" };
    }

    default:
      throw new Error(`Unknown standard capability "${capability}"`);
  }
}

interface DynamicViewLoaderProps {
  /** The URL of the JS bundle to dynamically import. */
  bundleUrl: string;
  /** Named export inside the bundle to use as the root component. Defaults to "default". */
  componentExport?: string;
  /** The view's stable ID, used in error state messages. */
  viewId: string;
  /** Optional props forwarded to the loaded view root component. */
  viewProps?: Record<string, unknown>;
  /** Presentation/runtime family for this view. Defaults to GUI. */
  viewType?: "gui" | "tui" | "xr";
}

/**
 * Loads and mounts a view component from a remote bundle URL.
 *
 * Usage:
 * ```tsx
 * <DynamicViewLoader
 *   bundleUrl="/api/views/wallet.inventory/bundle.js"
 *   viewId="wallet.inventory"
 * />
 * ```
 */
export const DynamicViewLoader = memo(function DynamicViewLoader({
  bundleUrl,
  componentExport = "default",
  viewId,
  viewProps: forwardedViewProps,
  viewType = "gui",
}: DynamicViewLoaderProps) {
  const [bundle, setBundle] = useState<ViewBundleModule | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  // Incrementing this key invalidates the module cache entry and forces a
  // fresh import. Used by the dev-mode ETag poller when the bundle changes,
  // and by the `refresh` standard capability.
  const [reloadKey, setReloadKey] = useState(0);
  const dynamicLoadingAllowed = isDynamicViewLoadingAllowed();
  // Ref to the container div so standard capabilities (get-text, focus-element, get-state)
  // can query the DOM.
  const containerRef = useRef<HTMLDivElement>(null);
  // viewId is only a log label inside the load effect; held in a ref so it does
  // not become an effect dependency (a viewId change with the same bundleUrl
  // must not re-run the import or flash the loading skeleton).
  const viewIdRef = useRef(viewId);
  viewIdRef.current = viewId;

  // reloadKey is intentionally a dependency: bumping it via the
  // standard `refresh` capability or the dev-mode ETag poller must
  // re-run this effect to invalidate the module cache.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a manual cache-bust trigger
  useEffect(() => {
    if (!dynamicLoadingAllowed) return;

    let cancelled = false;
    const lease = acquireBundleModule(bundleUrl, componentExport);

    setBundle(null);
    setLoadError(null);
    void lease.promise
      .then((nextBundle) => {
        if (!cancelled) {
          setBundle(nextBundle);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(
          `DynamicViewLoader failed to load view "${viewIdRef.current}" from ${bundleUrl}`,
          error,
        );
        setLoadError(error);
      });

    return () => {
      cancelled = true;
      lease.release();
    };
  }, [bundleUrl, componentExport, dynamicLoadingAllowed, reloadKey]);

  // Register this view's interact handler whenever the bundle is loaded.
  // The handler is unregistered on unmount or when the bundle changes.
  useLayoutEffect(() => {
    if (!bundle) return;

    const unregister = registerViewInteractHandler(
      viewId,
      viewType,
      async (capability, params) => {
        const registry = getViewRegistry(viewId, viewType);
        // Generic agent-surface capabilities (list-elements, agent-fill, …)
        // operate on the view's element registry.
        if (isAgentSurfaceCapability(capability)) {
          if (registry && registry.size() > 0) {
            return handleAgentSurfaceCapability(registry, capability, params);
          }
          return handleDomAgentSurfaceCapability(
            viewId,
            viewType,
            capability,
            params,
            containerRef.current,
          );
        }
        // Standard capabilities are handled here regardless of whether the
        // module exports interact — they operate on the registry or the DOM.
        if (STANDARD_CAPABILITIES.has(capability)) {
          return handleStandardCapability(
            capability,
            params,
            containerRef.current,
            setReloadKey,
            `${bundleUrl}::${componentExport}`,
            registry,
          );
        }
        // Delegate to the module's interact export if present.
        if (bundle.interact) {
          return bundle.interact(capability, params);
        }
        throw new Error(
          `View "${viewId}" does not support capability "${capability}"`,
        );
      },
    );

    return unregister;
  }, [bundle, bundleUrl, componentExport, viewId, viewType]);

  // Dev-mode only: poll the bundle URL with HEAD requests every 2s. When the
  // ETag changes the bundle has been rebuilt — evict the cache entry and bump
  // reloadKey so the component re-imports the updated bundle.
  const lastEtagRef = useRef<string | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV || !bundleUrl || !dynamicLoadingAllowed) return;

    const cacheKey = `${bundleUrl}::${componentExport}`;

    const id = setInterval(() => {
      void fetch(bundleUrl, { method: "HEAD" })
        .then((res) => {
          const etag = res.headers.get("etag");
          if (lastEtagRef.current !== null && etag !== lastEtagRef.current) {
            // Bundle changed on disk — evict cache and trigger re-import.
            invalidateBundleModule(cacheKey);
            setReloadKey((k) => k + 1);
          }
          lastEtagRef.current = etag;
        })
        .catch(() => {
          // Network errors during polling are non-fatal; just wait for the next tick.
        });
    }, DEV_POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [bundleUrl, componentExport, dynamicLoadingAllowed]);

  // Recover from a load failure or render crash: evict the cached module so the
  // next import re-fetches a fresh copy, clear the latched error, and bump
  // reloadKey to re-run the load effect. Bumping reloadKey also changes the
  // ErrorBoundary key below, remounting it with cleared state — so a view that
  // crashed at render is genuinely retried, not stuck behind a latched boundary.
  const recoverView = useCallback(() => {
    invalidateBundleModule(`${bundleUrl}::${componentExport}`);
    setLoadError(null);
    setReloadKey((k) => k + 1);
  }, [bundleUrl, componentExport]);

  // iOS App Store and Google Play builds cannot load remote JS at runtime.
  if (!dynamicLoadingAllowed) {
    return <ViewRestrictedState viewId={viewId} />;
  }

  if (loadError) {
    return (
      <ViewErrorState
        viewId={viewId}
        error={loadError}
        onRetry={recoverView}
        onBack={navigateToViews}
      />
    );
  }

  if (!bundle) {
    return <ViewLoadingSkeleton />;
  }

  const View = bundle.component;
  const viewProps = {
    ...forwardedViewProps,
    exitToApps: navigateToViews,
    t: (
      key: string,
      options?: { defaultValue?: string } | Record<string, unknown>,
    ) =>
      typeof options === "object" &&
      options !== null &&
      "defaultValue" in options &&
      typeof options.defaultValue === "string"
        ? options.defaultValue
        : key,
  };

  return (
    <div ref={containerRef} className="contents">
      <AgentSurfaceProvider viewId={viewId} viewType={viewType}>
        {/* Keyed by bundleUrl+reloadKey so a successful reload (refresh
            capability / dev HMR / Retry) remounts the boundary with cleared
            state instead of staying latched on a stale render crash. */}
        <ErrorBoundary
          key={`${bundleUrl}:${reloadKey}`}
          fallback={(error, resetErrorBoundary) => (
            <ViewErrorState
              viewId={viewId}
              error={error}
              onRetry={() => {
                resetErrorBoundary();
                recoverView();
              }}
              onBack={navigateToViews}
            />
          )}
        >
          {/* One shell-level SpatialSurface owns modality for every mounted
              view — GUI by auto-detect, XR inside a headset host — so plugin
              view components no longer each wrap themselves. Omitting `modality`
              keeps the exact auto-detect behaviour the per-view wrappers had. */}
          <SpatialSurface>
            <View {...viewProps} />
          </SpatialSurface>
        </ErrorBoundary>
        <AgentElementOverlay />
        <AgentSurfaceElementReporter />
      </AgentSurfaceProvider>
    </div>
  );
});
