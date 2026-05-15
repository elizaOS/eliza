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
 */

import { type ComponentType, memo, useEffect, useRef, useState } from "react";
import { isDynamicViewLoadingAllowed } from "../../platform/platform-guards";
import { ErrorBoundary } from "../ui/error-boundary";

interface ViewBundleModule {
  component: ComponentType;
  cleanup?: () => void | Promise<void>;
}

// Module cache lives outside React so it persists across re-renders and
// component unmounts.
const bundleModuleCache = new Map<string, Promise<ViewBundleModule>>();

/** Dev-mode polling interval in ms. Not used in production builds. */
const DEV_POLL_INTERVAL_MS = 2000;

function loadBundleModule(
  bundleUrl: string,
  componentExport: string,
): Promise<ViewBundleModule> {
  const cacheKey = `${bundleUrl}::${componentExport}`;
  const cached = bundleModuleCache.get(cacheKey);
  if (cached) return cached;

  const promise = import(/* @vite-ignore */ bundleUrl).then(
    (mod: Record<string, unknown>) => {
      const exported = mod[componentExport] ?? mod.default;
      if (typeof exported !== "function") {
        throw new Error(
          `DynamicViewLoader: bundle at ${bundleUrl} did not export a React component as "${componentExport}"`,
        );
      }
      const cleanup =
        typeof mod.cleanup === "function" ? mod.cleanup : undefined;
      return {
        component: exported as ComponentType,
        cleanup: cleanup as ViewBundleModule["cleanup"],
      };
    },
  );

  bundleModuleCache.set(cacheKey, promise);
  return promise;
}

function ViewLoadingSkeleton() {
  return (
    <div className="flex flex-1 min-h-0 min-w-0 items-center justify-center text-sm text-muted">
      Loading view…
    </div>
  );
}

function ViewErrorState({ viewId }: { viewId: string }) {
  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm font-semibold text-destructive">
        Failed to load view
      </p>
      <p className="text-xs text-muted">View ID: {viewId}</p>
    </div>
  );
}

function ViewRestrictedState({ viewId }: { viewId: string }) {
  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm font-semibold text-muted-foreground">
        View not available on this platform
      </p>
      <p className="text-xs text-muted">
        Dynamic views cannot be loaded on iOS or Android store builds.
      </p>
      <p className="text-xs text-muted">View ID: {viewId}</p>
    </div>
  );
}

interface DynamicViewLoaderProps {
  /** The URL of the JS bundle to dynamically import. */
  bundleUrl: string;
  /** Named export inside the bundle to use as the root component. Defaults to "default". */
  componentExport?: string;
  /** The view's stable ID, used in error state messages. */
  viewId: string;
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
}: DynamicViewLoaderProps) {
  const [bundle, setBundle] = useState<ViewBundleModule | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  // Incrementing this key invalidates the module cache entry and forces a
  // fresh import. Used by the dev-mode ETag poller when the bundle changes.
  const [reloadKey, setReloadKey] = useState(0);
  const dynamicLoadingAllowed = isDynamicViewLoadingAllowed();

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
        setLoadError(err instanceof Error ? err : new Error(String(err)));
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
  }, [bundleUrl, componentExport, dynamicLoadingAllowed, reloadKey]);

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

  return (
    <ErrorBoundary fallback={() => <ViewErrorState viewId={viewId} />}>
      <View />
    </ErrorBoundary>
  );
});
