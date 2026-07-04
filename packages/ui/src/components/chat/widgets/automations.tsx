import { Workflow } from "lucide-react";
import { useCallback } from "react";
// Real wire types (READ, not guessed):
//   - AutomationItem: packages/ui/src/api/client-types-config.ts
//   - AutomationStatus = "active" | "paused" | "completed" | "draft" | "system"
// The unified set merges automations (GET /api/automations) with LifeOps
// scheduled items (GET /api/lifeops/scheduled-tasks) client-side — see
// hooks/useUnifiedTasks.ts. No second scheduler, no store touch.
import type { AutomationItem } from "../../../api/client-types-config";
import { useUnifiedTasks } from "../../../hooks/useUnifiedTasks";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";

const AUTOMATIONS_VIEW = "/automations";
// Bound the bridge call so a hung agent channel settles the tile (self-hide)
// rather than spinning on "Loading…" forever.
const AUTOMATIONS_TIMEOUT_MS = 6_000;

/**
 * "Running" = an automation the agent is actively keeping alive on a fresh
 * install: the always-on coordinator/system automations, any user workflow
 * that is enabled and not a draft, AND any LifeOps scheduled item whose status
 * is "active" (a scheduled, non-manual trigger — e.g. the boot-seeded gm / gn /
 * daily check-in / morning-brief watcher). Paused (manual-trigger, e.g. the
 * seeded weekly-review), draft, and completed items are excluded from the
 * running top-line but still appear in the full Automations list.
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

/**
 * Automations home widget. Glanceable, icon-first surface of the agent's
 * currently running automations — default system automations, active user
 * workflows, AND boot-seeded LifeOps scheduled items (gm / gn / daily check-in /
 * morning-brief watcher) — merged from `GET /api/automations` +
 * `GET /api/lifeops/scheduled-tasks`. Shows the most relevant running item's
 * title plus a "+N" badge for the rest; tapping opens the Automations view.
 *
 * Zero-setup: no connect gate. Self-hides (renders null) once the first fetch
 * settles with nothing running, so a fresh home surface never shows an empty
 * placeholder (#9143). A 404 on either source (the runtime/runner not hosted
 * here, e.g. mobile) settles to "nothing running" rather than a broken card.
 */
export function AutomationsWidget({
  spanClassName = "col-span-2 row-span-1",
}: Partial<WidgetProps>) {
  const { state } = useUnifiedTasks({ timeoutMs: AUTOMATIONS_TIMEOUT_MS });
  const nav = useWidgetNavigation();

  const open = useCallback(
    () => nav.openView(AUTOMATIONS_VIEW, "automations"),
    [nav],
  );

  if (state.loading) {
    return (
      <div className={spanClassName}>
        <HomeWidgetCard
          icon={<Workflow />}
          label="Automations"
          value="Loading…"
          testId="chat-widget-automations"
          ariaLabel="Automations loading."
          onActivate={open}
        />
      </div>
    );
  }

  const running = state.items.filter(isRunning).sort(compareRunning);
  const top = running[0] ?? null;
  // Settled with nothing running: the home surface must not render an empty
  // placeholder (#9143), and this is a zero-setup widget, so render nothing.
  if (!top) return null;

  const extraCount = running.length - 1;

  return (
    <div className={spanClassName}>
      <HomeWidgetCard
        icon={<Workflow />}
        label="Automations"
        value={top.title}
        badge={extraCount > 0 ? `+${extraCount}` : undefined}
        testId="chat-widget-automations"
        ariaLabel={`Running automations: ${top.title}${
          extraCount > 0 ? `, and ${extraCount} more` : ""
        }. Open automations.`}
        onActivate={open}
      />
    </div>
  );
}
