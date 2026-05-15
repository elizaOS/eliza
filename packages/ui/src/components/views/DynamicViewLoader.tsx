/**
 * DynamicViewLoader — loads a view bundle from a remote URL at runtime.
 *
 * Each view lives behind a React.lazy boundary so it is only fetched when
 * first navigated to, and an ErrorBoundary wrapper prevents a failing view
 * from crashing the shell.
 *
 * Loaded modules are cached by bundleUrl so re-mounting does not re-fetch.
 */

import {
  type ComponentType,
  lazy,
  type LazyExoticComponent,
  memo,
  Suspense,
  useRef,
} from "react";
import { ErrorBoundary } from "../ui/error-boundary";

// Module cache lives outside React so it persists across re-renders and
// component unmounts.
const bundleModuleCache = new Map<string, Promise<{ default: ComponentType }>>();

function loadBundleModule(
  bundleUrl: string,
  componentExport: string,
): Promise<{ default: ComponentType }> {
  const cached = bundleModuleCache.get(bundleUrl);
  if (cached) return cached;

  const promise = import(/* @vite-ignore */ bundleUrl).then(
    (mod: Record<string, unknown>) => {
      const exported = mod[componentExport] ?? mod["default"];
      if (typeof exported !== "function") {
        throw new Error(
          `DynamicViewLoader: bundle at ${bundleUrl} did not export a React component as "${componentExport}"`,
        );
      }
      return { default: exported as ComponentType };
    },
  );

  bundleModuleCache.set(bundleUrl, promise);
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
  // Keep a stable lazy component reference per (bundleUrl, componentExport)
  // pair so React does not remount on every render.
  const lazyRef = useRef<LazyExoticComponent<ComponentType> | null>(null);
  const cacheKeyRef = useRef<string>("");

  const cacheKey = `${bundleUrl}::${componentExport}`;
  if (lazyRef.current === null || cacheKeyRef.current !== cacheKey) {
    cacheKeyRef.current = cacheKey;
    lazyRef.current = lazy(() => loadBundleModule(bundleUrl, componentExport));
  }

  const LazyView = lazyRef.current;

  return (
    <ErrorBoundary fallback={() => <ViewErrorState viewId={viewId} />}>
      <Suspense fallback={<ViewLoadingSkeleton />}>
        <LazyView />
      </Suspense>
    </ErrorBoundary>
  );
});
