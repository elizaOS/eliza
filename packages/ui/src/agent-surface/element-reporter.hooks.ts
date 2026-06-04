/**
 * Element-reporter internals — the payload builder and the subscribe/POST hook.
 *
 * Split out of element-reporter.tsx so that module exports only the
 * `AgentSurfaceElementReporter` component: React Fast Refresh requires a
 * component-only module to hot-reload without forcing a full page reload.
 */

import { useEffect } from "react";
import type { ViewAgentRegistry } from "./registry";

// The API client + url helper are loaded dynamically inside flush() (production
// path only) so this module — re-exported from the widely-imported agent-surface
// barrel and externalised into every plugin view bundle — stays import-light and
// pulls no api/utils graph into its consumers.

const REPORT_DEBOUNCE_MS = 400;

interface ReportedElement {
  id: string;
  role: string;
  label: string;
  value?: string;
  focused?: boolean;
}

export function buildPayload(registry: ViewAgentRegistry): {
  viewId: string;
  elements: ReportedElement[];
} {
  const snap = registry.snapshot();
  const elements: ReportedElement[] = snap.elements.map((e) => ({
    id: e.id,
    role: e.role,
    label: e.label,
    ...(typeof e.value === "string" ? { value: e.value } : {}),
    ...(e.focused ? { focused: true } : {}),
  }));
  return { viewId: snap.viewId, elements };
}

/**
 * Subscribe to a registry and push its element snapshot to the backend on mount
 * and on every (debounced) change. Exported for direct/test use; the
 * `AgentSurfaceElementReporter` component is the in-tree mount point.
 */
export function useAgentSurfaceElementReporter(
  registry: ViewAgentRegistry | null,
): void {
  useEffect(() => {
    // Inert without a registry, without fetch, or under the test runner (no
    // backend to report to — mirrors the repo's NODE_ENV=test I/O convention).
    const isTestEnv =
      typeof process !== "undefined" && process.env?.NODE_ENV === "test";
    if (!registry || isTestEnv || typeof fetch === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const flush = () => {
      const { viewId, elements } = buildPayload(registry);
      // Nothing addressable yet (e.g. before any useAgentElement mounts, or a
      // non-instrumented view) → skip the POST. Navigation clears server-side
      // elements on view switch, so we never need to push an empty snapshot.
      if (elements.length === 0) return;
      void (async () => {
        try {
          const [{ fetchWithCsrf }, { resolveApiUrl }] = await Promise.all([
            import("../api/csrf-client"),
            import("../utils/asset-url"),
          ]);
          await fetchWithCsrf(
            resolveApiUrl(`/api/views/${encodeURIComponent(viewId)}/elements`),
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ elements }),
            },
          );
        } catch {
          // Best-effort: planner awareness is an optimization, never a hard dep.
        }
      })();
    };

    const schedule = () => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, REPORT_DEBOUNCE_MS);
    };

    schedule(); // initial snapshot
    const unsubscribe = registry.subscribe(schedule);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [registry]);
}
