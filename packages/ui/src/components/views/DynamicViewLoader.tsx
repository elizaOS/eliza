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

import { AlertTriangle, Ban, LoaderCircle } from "lucide-react";
import {
  type ComponentType,
  memo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  AgentElementOverlay,
  AgentSurfaceProvider,
  getViewRegistry,
  handleAgentSurfaceCapability,
  isAgentSurfaceCapability,
  type ViewAgentRegistry,
} from "../../agent-surface";
import { isDynamicViewLoadingAllowed } from "../../platform/platform-guards";
import { useTranslation } from "../../state/TranslationContext";
import { ErrorBoundary } from "../ui/error-boundary";
import { registerViewInteractHandler } from "./view-interact-registry";

interface ViewBundleModule {
  component: ComponentType<Record<string, unknown>>;
  interact?: (
    capability: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
  cleanup?: () => void | Promise<void>;
}

// Module cache lives outside React so it persists across re-renders and
// component unmounts.
const bundleModuleCache = new Map<string, Promise<ViewBundleModule>>();

function isReactComponentExport(
  value: unknown,
): value is ComponentType<Record<string, unknown>> {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

type HostExternalImporter = () => Promise<Record<string, unknown>>;

const HOST_EXTERNAL_IMPORTERS: Record<string, HostExternalImporter> = {
  "@elizaos/app-core": () => import("@elizaos/app-core"),
  "@elizaos/app-core/browser": () => import("@elizaos/app-core"),
  "@elizaos/app-core/ui-compat": () => import("@elizaos/app-core/ui-compat"),
  "@elizaos/capacitor-contacts": () => import("@elizaos/capacitor-contacts"),
  "@elizaos/capacitor-messages": () => import("@elizaos/capacitor-messages"),
  "@elizaos/capacitor-mobile-signals": () =>
    import("@elizaos/capacitor-mobile-signals"),
  "@elizaos/capacitor-phone": () => import("@elizaos/capacitor-phone"),
  "@elizaos/capacitor-system": () => import("@elizaos/capacitor-system"),
  "@elizaos/shared": () => import("@elizaos/shared"),
  "@elizaos/ui": () => import("@elizaos/ui"),
  "@elizaos/plugin-browser": () => import("@elizaos/plugin-browser"),
  "@elizaos/plugin-health/screen-time/mobile-signal-setup": () =>
    import("@elizaos/plugin-health/screen-time/mobile-signal-setup"),
  "@elizaos/ui/agent-surface": () => import("../../agent-surface/index.ts"),
  "@elizaos/ui/api": () => import("../../api/index.ts"),
  "@elizaos/ui/platform": () => import("../../platform/index.ts"),
  "@elizaos/ui/platform/ios-runtime": () =>
    import("../../platform/ios-runtime.ts"),
  "@elizaos/ui/state": () => import("../../state/index.ts"),
  "@elizaos/ui/state/useApp": () => import("../../state/useApp.ts"),
  "@elizaos/ui/components/views/TerminalPluginView": () =>
    import("./TerminalPluginView.tsx"),
  "@elizaos/ui/components/ui/button": () => import("../ui/button.tsx"),
  "@elizaos/ui/components/ui/input": () => import("../ui/input.tsx"),
  "@elizaos/ui/components/ui/spinner": () => import("../ui/spinner.tsx"),
  "@elizaos/ui/components/ui/tabs": () => import("../ui/tabs.tsx"),
  "@elizaos/ui/components/ui/textarea": () => import("../ui/textarea.tsx"),
  "@elizaos/ui/components/apps/surfaces/GameOperatorShell": () =>
    import("../apps/surfaces/GameOperatorShell.tsx"),
  "lucide-react": () => import("lucide-react"),
  "@pixiv/three-vrm": () => import("@pixiv/three-vrm"),
  react: () => import("react"),
  "react-plaid-link": () => import("react-plaid-link"),
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

const HOST_EXTERNAL_IMPORTER_SPECIFIERS = Object.keys(HOST_EXTERNAL_IMPORTERS);

declare global {
  interface Window {
    __ELIZA_DYNAMIC_VIEW_IMPORT__?: (
      specifier: string,
    ) => Promise<Record<string, unknown>>;
    __ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__?: (
      bundleUrl: string,
    ) => Promise<Record<string, unknown>>;
  }
}

if (typeof window !== "undefined" && !window.__ELIZA_DYNAMIC_VIEW_IMPORT__) {
  window.__ELIZA_DYNAMIC_VIEW_IMPORT__ = async (specifier) => {
    const importer = HOST_EXTERNAL_IMPORTERS[specifier];
    if (!importer) {
      throw new Error(
        `DynamicViewLoader: unsupported host external "${specifier}"`,
      );
    }
    return importer();
  };
}

/** Dev-mode polling interval in ms. Not used in production builds. */
const DEV_POLL_INTERVAL_MS = 2000;

async function importViewBundle(
  bundleUrl: string,
): Promise<Record<string, unknown>> {
  if (
    typeof window !== "undefined" &&
    window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__
  ) {
    return window.__ELIZA_DYNAMIC_VIEW_BUNDLE_IMPORT__(bundleUrl);
  }

  try {
    return await import(/* @vite-ignore */ bundleUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("Failed to resolve module specifier")) {
      throw err;
    }
  }

  const rewrittenUrl = new URL(bundleUrl, window.location.href);
  rewrittenUrl.searchParams.set("hostExternalRuntime", "1");
  rewrittenUrl.searchParams.set(
    "hostExternalSpecifiers",
    HOST_EXTERNAL_IMPORTER_SPECIFIERS.join(","),
  );
  return import(/* @vite-ignore */ rewrittenUrl.href);
}

function loadBundleModule(
  bundleUrl: string,
  componentExport: string,
): Promise<ViewBundleModule> {
  const cacheKey = `${bundleUrl}::${componentExport}`;
  const cached = bundleModuleCache.get(cacheKey);
  if (cached) return cached;

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
      return {
        component: exported as ComponentType<Record<string, unknown>>,
        interact,
        cleanup: cleanup as ViewBundleModule["cleanup"],
      };
    },
  );

  bundleModuleCache.set(cacheKey, promise);
  return promise;
}

const STANDARD_CAPABILITIES = new Set([
  "get-state",
  "refresh",
  "focus-element",
  "click-element",
  "fill-input",
  "get-text",
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
      bundleModuleCache.delete(cacheKey);
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
        return { filled: result.ok, id, reason: result.reason, value };
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
        setNativeInputValue(target, value);
        return { filled: true, selector, value };
      }
      return { filled: false, reason: "element is not fillable" };
    }

    default:
      throw new Error(`Unknown standard capability "${capability}"`);
  }
}

function ViewStatusFrame({
  tone,
  icon,
  title,
  children,
}: {
  tone: "loading" | "error" | "restricted";
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
}) {
  const toneClass =
    tone === "error"
      ? "border-destructive/25 bg-destructive/5 text-destructive"
      : tone === "restricted"
        ? "border-muted-foreground/20 bg-muted/20 text-muted-foreground"
        : "border-primary/20 bg-primary/5 text-primary";

  return (
    <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center p-6">
      <div
        className={`flex w-full max-w-sm items-center gap-3 rounded-lg border p-4 shadow-sm ${toneClass}`}
      >
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-background/70">
          {icon}
        </div>
        <div className="min-w-0 text-left">
          <div className="text-sm font-semibold">{title}</div>
          {children ? (
            <div className="mt-1 text-xs opacity-75">{children}</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ViewLoadingSkeleton() {
  const { t } = useTranslation();
  return (
    <ViewStatusFrame
      tone="loading"
      icon={
        <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />
      }
      title={t("dynamicviewloader.loading", { defaultValue: "Loading view…" })}
    />
  );
}

function ViewErrorState({ viewId }: { viewId: string }) {
  const { t } = useTranslation();
  return (
    <ViewStatusFrame
      tone="error"
      icon={<AlertTriangle className="h-5 w-5" aria-hidden="true" />}
      title={t("dynamicviewloader.error.title", {
        defaultValue: "Failed to load view",
      })}
    >
      <span>
        {t("dynamicviewloader.viewId", {
          viewId,
          defaultValue: "View ID: {{viewId}}",
        })}
      </span>
    </ViewStatusFrame>
  );
}

function ViewRestrictedState({ viewId }: { viewId: string }) {
  const { t } = useTranslation();
  return (
    <ViewStatusFrame
      tone="restricted"
      icon={<Ban className="h-5 w-5" aria-hidden="true" />}
      title={t("dynamicviewloader.restricted.title", {
        defaultValue: "View not available on this platform",
      })}
    >
      <span>
        {t("dynamicviewloader.restricted.body", {
          defaultValue:
            "Dynamic views cannot be loaded on iOS or Android store builds.",
        })}
      </span>
      <span className="mt-1 block">
        {t("dynamicviewloader.viewId", {
          viewId,
          defaultValue: "View ID: {{viewId}}",
        })}
      </span>
    </ViewStatusFrame>
  );
}

interface DynamicViewLoaderProps {
  /** The URL of the JS bundle to dynamically import. */
  bundleUrl: string;
  /** Named export inside the bundle to use as the root component. Defaults to "default". */
  componentExport?: string;
  /** The view's stable ID, used in error state messages. */
  viewId: string;
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

  // reloadKey is intentionally a dependency: bumping it via the
  // standard `refresh` capability or the dev-mode ETag poller must
  // re-run this effect to invalidate the module cache.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is a manual cache-bust trigger
  useEffect(() => {
    if (!dynamicLoadingAllowed) return;

    let cancelled = false;
    let loadedBundle: ViewBundleModule | null = null;

    setBundle(null);
    setLoadError(null);
    void loadBundleModule(bundleUrl, componentExport)
      .then((nextBundle) => {
        loadedBundle = nextBundle;
        if (!cancelled) {
          setBundle(nextBundle);
          return;
        }
        if (nextBundle.cleanup) {
          void Promise.resolve()
            .then(() => nextBundle.cleanup?.())
            .catch(() => {});
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(
          `DynamicViewLoader failed to load view "${viewId}" from ${bundleUrl}`,
          error,
        );
        setLoadError(error);
      });

    return () => {
      cancelled = true;
      const cleanup = loadedBundle?.cleanup;
      if (cleanup) {
        void Promise.resolve()
          .then(() => cleanup())
          .catch(() => {
            // View cleanup must never crash the shell.
          });
      }
    };
  }, [bundleUrl, componentExport, dynamicLoadingAllowed, reloadKey, viewId]);

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
          if (!registry) {
            throw new Error(
              `View "${viewId}" has no agent surface registered yet`,
            );
          }
          return handleAgentSurfaceCapability(registry, capability, params);
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
            bundleModuleCache.delete(cacheKey);
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

  // iOS App Store and Google Play builds cannot load remote JS at runtime.
  if (!dynamicLoadingAllowed) {
    return <ViewRestrictedState viewId={viewId} />;
  }

  if (loadError) {
    return <ViewErrorState viewId={viewId} />;
  }

  if (!bundle) {
    return <ViewLoadingSkeleton />;
  }

  const View = bundle.component;
  const viewProps = {
    exitToApps: () => {
      if (typeof window !== "undefined") {
        window.history.pushState(null, "", "/views");
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    },
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
        <ErrorBoundary fallback={() => <ViewErrorState viewId={viewId} />}>
          <View {...viewProps} />
        </ErrorBoundary>
        <AgentElementOverlay />
      </AgentSurfaceProvider>
    </div>
  );
});
