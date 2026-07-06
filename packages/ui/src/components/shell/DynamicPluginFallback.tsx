/**
 * Fallback for a plugin nav tab that resolved to a `componentExport` but has no
 * matching `registerAppShellPage` registration yet. Registration rides the boot
 * idle path, so this holds a brief loading state; a `registryVersion` bump in
 * `App.tsx` re-resolves the page and hands off to the real component once it
 * arrives. A tab that ships a `componentExport` and never registers would
 * otherwise strand the user on an unbounded "Loading…" — so after a bounded
 * wait this degrades to a designed error state, honoring the loading/empty/error
 * three-state rule instead of spinning forever.
 */
import { useEffect, useState } from "react";

/**
 * How long to wait for a late `registerAppShellPage` before declaring the view
 * failed. Registration is a boot-idle side effect, so a few seconds is ample;
 * past it the tab is treated as shipping no usable view.
 */
export const UNREGISTERED_PLUGIN_TIMEOUT_MS = 10_000;

export function DynamicPluginFallback({
  id,
  timeoutMs = UNREGISTERED_PLUGIN_TIMEOUT_MS,
}: {
  id: string;
  timeoutMs?: number;
}) {
  const [timedOutForId, setTimedOutForId] = useState<string | null>(null);
  useEffect(() => {
    setTimedOutForId(null);
    const timer = setTimeout(() => setTimedOutForId(id), timeoutMs);
    return () => clearTimeout(timer);
  }, [id, timeoutMs]);

  if (timedOutForId === id) {
    return (
      <div
        role="alert"
        data-testid="dynamic-plugin-page-error"
        className="flex flex-1 min-h-0 min-w-0 flex-col items-center justify-center gap-1 px-4 text-center"
      >
        <p className="text-sm font-medium text-destructive">
          This view failed to load
        </p>
        <p className="max-w-prose text-xs-tight text-muted">
          No view is registered for "{id}" in this build.
        </p>
      </div>
    );
  }
  return (
    <div
      aria-busy="true"
      data-testid="dynamic-plugin-page-loading"
      className="flex flex-1 min-h-0 min-w-0 items-center justify-center text-sm text-muted"
    >
      Loading {id}…
    </div>
  );
}
