/**
 * merge-unified-tasks — pure client-side read merge of automations
 * (workflows + workbench tasks + triggers from `GET /api/automations`) with
 * LifeOps scheduled tasks (`GET /api/lifeops/scheduled-tasks`) into one
 * `AutomationItem[]`.
 *
 * This is purely a UI read merge: it does NOT touch any backend store, add a
 * second scheduler, or mirror tasks across stores. The canonical scheduling
 * primitive remains the single LifeOps `ScheduledTask` runner; this only
 * surfaces those records alongside automations in one list.
 *
 * Lives outside React so it can be unit-tested in node-only vitest.
 */

import type { AutomationItem } from "../api/client-types-config";
import type { ScheduledTaskView } from "../api/client-types-core";
import { scheduledTaskToAutomationItem } from "./scheduled-task-to-automation";

/**
 * Stable ordering for the unified list: active rows first, then by title.
 * Scheduled-task seeds that are paused (manual trigger) sort into the
 * inactive group.
 */
export function compareUnifiedItems(
  a: AutomationItem,
  b: AutomationItem,
): number {
  // System rows first (always-on coordinator automations).
  if (a.system !== b.system) return a.system ? -1 : 1;
  // Then enabled before disabled.
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return a.title.localeCompare(b.title);
}

/**
 * Merge automations with adapted scheduled tasks, de-duping by stable id.
 * Automations win on id collision (the `scheduled:` prefix means collisions
 * only happen if a task is ever mirrored as a runtime item).
 */
export function mergeUnifiedTasks(
  automations: AutomationItem[],
  scheduledTasks: ScheduledTaskView[],
): AutomationItem[] {
  const byId = new Map<string, AutomationItem>();
  for (const item of automations) byId.set(item.id, item);
  for (const task of scheduledTasks) {
    const adapted = scheduledTaskToAutomationItem(task);
    if (!byId.has(adapted.id)) byId.set(adapted.id, adapted);
  }
  return Array.from(byId.values()).sort(compareUnifiedItems);
}
