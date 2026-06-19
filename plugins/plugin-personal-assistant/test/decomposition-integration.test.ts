import type { Action, Plugin, Service } from "@elizaos/core";
import { blockerPlugin } from "@elizaos/plugin-blocker";
import { calendarPlugin } from "@elizaos/plugin-calendar";
import { financesPlugin } from "@elizaos/plugin-finances";
import { goalsPlugin } from "@elizaos/plugin-goals";
import { healthPlugin } from "@elizaos/plugin-health";
import { inboxPlugin } from "@elizaos/plugin-inbox";
import { remoteDesktopPlugin } from "@elizaos/plugin-remote-desktop";
import { describe, expect, it } from "vitest";
import { personalAssistantPlugin } from "../src/plugin.ts";

/**
 * Integration invariant for the LifeOps decomposition.
 *
 * After breaking the monolith into focused plugins, PA (the chief-of-staff hub)
 * is composed *with* the seven domain plugins it integrates. This test pins the
 * properties that a large decomposition silently breaks: a dropped owner action,
 * two different service classes claiming one serviceType (the runtime skips the
 * second, so it never starts), two views shadowing one id, or an affinity-map
 * action name that no loaded plugin actually registers.
 *
 * It models the runtime's real registration behavior (first-wins dedup —
 * `AgentRuntime.registerAction`/`registerService` skip a name/serviceType that
 * is already present) without booting the scheduler stack, so it is fast and
 * deterministic.
 */

// The plugins PA integrates. calendar/finances/inbox/remote-desktop are
// auto-registered by PA.init() (so PA's own umbrella registers first and wins);
// goals/health/blocker are the standalone PA-free topology surfaces that PA
// reuses by direct import. The union below is the full composed surface.
const SUBPLUGINS: Plugin[] = [
  calendarPlugin,
  financesPlugin,
  inboxPlugin,
  remoteDesktopPlugin,
  goalsPlugin,
  healthPlugin,
  blockerPlugin,
];
// PA auto-registers these inside init() AFTER its own actions array is
// processed, so PA's umbrella wins their overlapping names (CALENDAR, …).
const AUTO_REGISTERED: Plugin[] = [
  calendarPlugin,
  financesPlugin,
  inboxPlugin,
  remoteDesktopPlugin,
];

const ALL: Plugin[] = [personalAssistantPlugin, ...SUBPLUGINS];

type ServiceClass = typeof Service & { serviceType?: string };

function actionsOf(plugin: Plugin): Action[] {
  return (plugin.actions ?? []) as Action[];
}
function servicesOf(plugin: Plugin): ServiceClass[] {
  return (plugin.services ?? []) as unknown as ServiceClass[];
}

/** Runtime first-wins: the first plugin to register a name owns it. */
function firstWinsActionOwners(
  plugins: Plugin[],
): Map<string, { plugin: string; action: Action }> {
  const reg = new Map<string, { plugin: string; action: Action }>();
  for (const plugin of plugins) {
    for (const action of actionsOf(plugin)) {
      if (!reg.has(action.name)) {
        reg.set(action.name, { plugin: plugin.name, action });
      }
    }
  }
  return reg;
}

describe("LifeOps decomposition — composed plugin surface", () => {
  it("every action across the composed set is structurally valid", () => {
    for (const plugin of ALL) {
      for (const action of actionsOf(plugin)) {
        expect(
          typeof action.name === "string" && action.name.length > 0,
          `${plugin.name} has an action with no name`,
        ).toBe(true);
        expect(
          typeof action.handler === "function",
          `${plugin.name}:${action.name} has no handler`,
        ).toBe(true);
      }
    }
  });

  it("no serviceType is claimed by two different service classes", () => {
    // Same serviceType from the same class (a re-export) is fine; two *different*
    // classes on one serviceType means the runtime silently never starts one.
    const byType = new Map<string, Set<ServiceClass>>();
    for (const plugin of ALL) {
      for (const svc of servicesOf(plugin)) {
        const type = svc.serviceType;
        if (!type) continue;
        const set = byType.get(type) ?? new Set<ServiceClass>();
        set.add(svc);
        byType.set(type, set);
      }
    }
    const collisions = [...byType.entries()]
      .filter(([, classes]) => classes.size > 1)
      .map(([type]) => type);
    expect(collisions, `serviceType claimed by 2+ classes: ${collisions}`).toEqual(
      [],
    );
  });

  it("no (view id + surface) is registered by two plugins (no shell shadowing)", () => {
    // The same id across gui/tui/xr is the legitimate surface-variant pattern;
    // a real shadow is two *plugins* claiming the same id+surface, which the
    // shell renders ambiguously. (PA no longer registers a view — the LifeOps
    // overview was removed — so this asserts the per-domain plugin views stay
    // unshadowed.)
    const byKey = new Map<string, Set<string>>();
    for (const plugin of ALL) {
      for (const view of plugin.views ?? []) {
        const key = `${view.id}::${(view as { viewType?: string }).viewType ?? "gui"}`;
        const owners = byKey.get(key) ?? new Set<string>();
        owners.add(plugin.name);
        byKey.set(key, owners);
      }
    }
    const shadowed = [...byKey.entries()]
      .filter(([, owners]) => owners.size > 1)
      .map(([key, owners]) => [key, [...owners]]);
    expect(shadowed, `view id+surface claimed by 2+ plugins: ${JSON.stringify(shadowed)}`).toEqual(
      [],
    );
  });

  it("the decomposition did not drop any owner action surface", () => {
    // Names that must exist somewhere in the composed set (umbrella action
    // names, post-promotion). If any is missing, a surface was lost in a move.
    const EXPECTED_OWNER_ACTIONS = [
      "INBOX",
      "CALENDAR",
      "CONFLICT_DETECT",
      "OWNER_FINANCES",
      "OWNER_GOALS",
      "OWNER_ROUTINES",
      "OWNER_REMINDERS",
      "OWNER_ALARMS",
      "OWNER_TODOS",
      "OWNER_HEALTH",
      "OWNER_DOCUMENTS",
      "PERSONAL_ASSISTANT",
      "BRIEF",
      "PRIORITIZE",
      "RESOLVE_REQUEST",
      "CREDENTIALS",
      "SCHEDULED_TASKS",
      "VOICE_CALL",
      "CONNECTOR",
      "ENTITY",
      "WORK_THREAD",
      "REMOTE_DESKTOP",
    ];
    const present = new Set(
      ALL.flatMap((p) => actionsOf(p).map((a) => a.name)),
    );
    const missing = EXPECTED_OWNER_ACTIONS.filter((n) => !present.has(n));
    expect(missing, `owner actions absent from the composed set: ${missing}`).toEqual(
      [],
    );
  });

  it("PA's umbrella wins the auto-registered overlaps (first-wins ordering)", () => {
    // PA registers its own actions, then init() auto-registers calendar/finances/
    // inbox/remote-desktop, so PA owns the names both define.
    const reg = firstWinsActionOwners([personalAssistantPlugin, ...AUTO_REGISTERED]);
    for (const name of ["CALENDAR", "CONFLICT_DETECT"]) {
      expect(reg.get(name)?.plugin, `${name} winner`).toBe(
        personalAssistantPlugin.name,
      );
    }
  });

  it("lifeops view→action affinity names all resolve in the composed set", () => {
    // Mirrors the lifeops slice of VIEW_ACTION_MAP
    // (packages/agent/src/runtime/view-action-affinity.ts). Inlined to keep this
    // test free of a cross-package import; the agent drift test guards the names
    // themselves, this guards that a loaded plugin actually registers them.
    const LIFEOPS_VIEW_ACTIONS: Record<string, string[]> = {
      calendar: ["CALENDAR", "CONFLICT_DETECT"],
      health: ["OWNER_HEALTH", "OWNER_SCREENTIME"],
      // The focus view's domain action is the BLOCK umbrella (list_active /
      // release are now subactions of it, not standalone actions).
      focus: ["BLOCK"],
      finances: ["OWNER_FINANCES"],
      inbox: ["INBOX"],
      goals: ["OWNER_GOALS", "OWNER_ALARMS", "OWNER_REMINDERS", "OWNER_ROUTINES"],
      todos: ["OWNER_TODOS"],
      lifeops: ["PERSONAL_ASSISTANT"],
    };
    const present = new Set(
      ALL.flatMap((p) => actionsOf(p).map((a) => a.name)),
    );
    const unresolved: string[] = [];
    for (const [view, names] of Object.entries(LIFEOPS_VIEW_ACTIONS)) {
      for (const name of names) {
        if (!present.has(name)) unresolved.push(`${view}:${name}`);
      }
    }
    expect(unresolved, `affinity action names with no registering plugin: ${unresolved}`).toEqual(
      [],
    );
  });
});
