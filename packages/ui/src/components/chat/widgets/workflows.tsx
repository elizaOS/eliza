import { Workflow } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../../api";
// Real wire types for GET /api/automations (READ, not guessed):
// packages/ui/src/api/client-types-config.ts
//   - AutomationItem: { id, type, status, enabled, system, lastExecution?, … }
//   - AutomationStatus = "active" | "paused" | "completed" | "draft" | "system"
import type { AutomationItem } from "../../../api/client-types-config";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const AUTOMATIONS_VIEW = "/automations";

/**
 * "Running" = an automation the agent is actively keeping alive on a fresh
 * install: the always-on coordinator/system automations plus any user workflow
 * that is enabled and not a draft. Paused, draft, and completed automations are
 * excluded — this card answers "what is the agent running right now?".
 */
function isRunning(item: AutomationItem): boolean {
  if (item.isDraft) return false;
  if (item.status === "system") return true;
  return item.enabled && item.status === "active";
}

/** Stable display order: system automations first, then the rest by title. */
function compareRunning(a: AutomationItem, b: AutomationItem): number {
  if (a.system !== b.system) return a.system ? -1 : 1;
  return a.title.localeCompare(b.title);
}

interface WorkflowsState {
  running: AutomationItem[];
  /** True until the first fetch settles — distinguishes "loading" from "none". */
  loading: boolean;
}

const INITIAL_STATE: WorkflowsState = { running: [], loading: true };

/**
 * Workflows home widget. Glanceable, icon-first surface of the agent's
 * currently-running automations (default system automations + active user
 * workflows) read from GET /api/automations. Shows the most relevant running
 * automation's title plus a "+N" badge for the rest; tapping opens the
 * Automations view.
 *
 * Zero-setup: no connect gate. Self-hides (renders null) once the first fetch
 * settles with nothing running, so a fresh home surface never shows an empty
 * placeholder (#9143). A 404 (workflow runtime not hosted here, e.g. mobile)
 * settles to "nothing running" rather than a broken card.
 */
export function WorkflowsWidget({
  spanClassName = "col-span-2 row-span-1",
}: Partial<WidgetProps>) {
  const [state, setState] = useState<WorkflowsState>(INITIAL_STATE);
  const nav = useWidgetNavigation();

  const load = useCallback(async (signal: { cancelled: boolean }) => {
    try {
      const res = await client.listAutomations();
      if (signal.cancelled) return;
      const items = Array.isArray(res?.automations) ? res.automations : [];
      const running = items.filter(isRunning).sort(compareRunning);
      setState({ running, loading: false });
    } catch {
      // Network/runtime failure (incl. 404 where the workflow runtime isn't
      // hosted) — settle to "nothing running" so the card resolves rather than
      // spinning forever or surfacing a broken state.
      if (signal.cancelled) return;
      setState({ running: [], loading: false });
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void load(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [load]);

  const open = useCallback(
    () => nav.openView(AUTOMATIONS_VIEW, "automations"),
    [nav],
  );

  if (state.loading) {
    return (
      <div className={spanClassName}>
        <HomeWidgetCard
          icon={<Workflow />}
          label="Workflows"
          value="Loading…"
          testId="chat-widget-workflows"
          ariaLabel="Workflows loading."
          onActivate={open}
        />
      </div>
    );
  }

  const top = state.running[0] ?? null;
  // Settled with nothing running: the home surface must not render an empty
  // placeholder (#9143), and this is a zero-setup widget, so render nothing.
  if (!top) return null;

  const extraCount = state.running.length - 1;

  return (
    <div className={spanClassName}>
      <HomeWidgetCard
        icon={<Workflow />}
        label="Workflows"
        value={top.title}
        badge={extraCount > 0 ? `+${extraCount}` : undefined}
        testId="chat-widget-workflows"
        ariaLabel={`Running workflows: ${top.title}${
          extraCount > 0 ? `, and ${extraCount} more` : ""
        }. Open automations.`}
        onActivate={open}
      />
    </div>
  );
}
