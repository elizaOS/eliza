/**
 * Screenshot-harness entry. Reads `?view=<id>&state=<id>&compact=0|1` from the
 * URL, imports the matching LifeOps view component, injects the per-state mock
 * fetchers (or, for CalendarView, primes the `useCalendarWeek` hook global), and
 * mounts it into `#root`. `@elizaos/ui` + `@elizaos/ui/agent-surface` (and, for
 * calendar, its data hook + drawer) are aliased to local stubs in vite.config.
 *
 * On successful mount it sets `window.__VIEW_HARNESS_READY__ = true`; on any
 * import/render failure it sets `window.__VIEW_HARNESS_ERROR__` to the message
 * so the driver can fail loudly rather than screenshot a blank page.
 */

import type { ComponentType } from "react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VIEW_SPECS } from "./fixtures.ts";

declare global {
  interface Window {
    __VIEW_HARNESS_READY__?: boolean;
    __VIEW_HARNESS_ERROR__?: string;
  }
}

const params = new URLSearchParams(window.location.search);
const view = params.get("view") ?? "";
const state = params.get("state") ?? "";
globalThis.__VIEW_HARNESS_COMPACT__ = params.get("compact") === "1";

// Static map so vite can analyze the dynamic imports.
const LOADERS: Record<string, () => Promise<{ default: ComponentType }>> = {
  focus: () =>
    import(
      "../../../../plugins/plugin-blocker/src/components/focus/FocusView.tsx"
    ) as Promise<{ default: ComponentType }>,
  health: () =>
    import(
      "../../../../plugins/plugin-health/src/components/health/HealthView.tsx"
    ) as Promise<{ default: ComponentType }>,
  finances: () =>
    import(
      "../../../../plugins/plugin-finances/src/components/finances/FinancesView.tsx"
    ) as Promise<{ default: ComponentType }>,
  inbox: () =>
    import(
      "../../../../plugins/plugin-inbox/src/components/inbox/InboxView.tsx"
    ) as Promise<{ default: ComponentType }>,
  goals: () =>
    import(
      "../../../../plugins/plugin-goals/src/components/goals/GoalsView.tsx"
    ) as Promise<{ default: ComponentType }>,
  todos: () =>
    import(
      "../../../../plugins/plugin-todos/src/components/todos/TodosView.tsx"
    ) as Promise<{ default: ComponentType }>,
  documents: () =>
    import(
      "../../../../plugins/plugin-documents/src/components/documents/DocumentsView.tsx"
    ) as Promise<{ default: ComponentType }>,
  relationships: () =>
    import(
      "../../../../plugins/plugin-relationships/src/components/relationships/RelationshipsView.tsx"
    ) as Promise<{ default: ComponentType }>,
  calendar: () =>
    import(
      "../../../../plugins/plugin-calendar/src/components/calendar/CalendarView.tsx"
    ) as Promise<{ default: ComponentType }>,
};

async function main(): Promise<void> {
  const spec = VIEW_SPECS[view];
  const loader = LOADERS[view];
  if (!spec || !loader) {
    throw new Error(`Unknown view "${view}"`);
  }
  if (!spec.states.includes(state)) {
    throw new Error(`Unknown state "${state}" for view "${view}"`);
  }

  // Calendar's seam is a hook read at render time, not a prop.
  if (spec.calendarResultFor) {
    globalThis.__VIEW_HARNESS_CALENDAR__ = spec.calendarResultFor(
      state,
    ) as typeof globalThis.__VIEW_HARNESS_CALENDAR__;
  }

  const props = spec.propsFor(state);
  const mod = await loader();
  const View = mod.default;

  const rootEl = document.getElementById("root");
  if (!rootEl) throw new Error("missing #root");
  createRoot(rootEl).render(
    <StrictMode>
      <View {...props} />
    </StrictMode>,
  );

  // Give effects + the resolved/never fetcher microtasks a tick to settle.
  await new Promise((r) => setTimeout(r, 0));
  window.__VIEW_HARNESS_READY__ = true;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  window.__VIEW_HARNESS_ERROR__ = message;
  const rootEl = document.getElementById("root");
  if (rootEl) {
    rootEl.textContent = `HARNESS ERROR: ${message}`;
    rootEl.setAttribute("data-harness-error", "1");
  }
  // Surface in the page console for the driver's log capture.
  console.error("[view-harness]", message);
});
