/**
 * Unit coverage for the unified automation-feed merge: the
 * `compareUnifiedItems` ordering contract (system → enabled → title) and the
 * `mergeUnifiedTasks` de-dupe/sort behaviour, including empty inputs, single
 * elements, id collisions, and input non-mutation. Deterministic pure
 * functions driven directly — no mocks, no clock, no network.
 */
import { describe, expect, it } from "vitest";
import type { AutomationItem } from "../api/client-types-config";
import type { ScheduledTaskView } from "../api/client-types-core";
import { compareUnifiedItems, mergeUnifiedTasks } from "./merge-unified-tasks";

function automation(overrides: Partial<AutomationItem> = {}): AutomationItem {
  return {
    id: "workflow:w-1",
    type: "workflow",
    source: "workflow",
    title: "Daily digest",
    description: "",
    status: "active",
    enabled: true,
    system: false,
    isDraft: false,
    hasBackingWorkflow: true,
    updatedAt: null,
    schedules: [],
    ...overrides,
  };
}

function scheduledTask(
  overrides: Partial<ScheduledTaskView> = {},
): ScheduledTaskView {
  return {
    taskId: "t-1",
    kind: "reminder",
    promptInstructions: "Say good morning",
    trigger: {
      kind: "relative_to_anchor",
      anchorKey: "wake.confirmed",
      offsetMinutes: 0,
    },
    priority: "low",
    respectsGlobalPause: true,
    state: { status: "scheduled", followupCount: 0 },
    source: "default_pack",
    createdBy: "daily-rhythm",
    ownerVisible: true,
    metadata: { recordKey: "gm" },
    ...overrides,
  };
}

describe("compareUnifiedItems", () => {
  it("ranks system rows before user rows in both directions", () => {
    const system = automation({ id: "a", system: true });
    const user = automation({ id: "b", system: false });

    expect(compareUnifiedItems(user, system)).toBe(1);
    expect(compareUnifiedItems(system, user)).toBe(-1);
  });

  it("ranks enabled before disabled within the same system group", () => {
    const enabled = automation({ id: "a", system: false, enabled: true });
    const disabled = automation({ id: "b", system: false, enabled: false });

    expect(compareUnifiedItems(enabled, disabled)).toBe(-1);
    expect(compareUnifiedItems(disabled, enabled)).toBe(1);
  });

  it("breaks ties on title and returns 0 for equal titles", () => {
    const alpha = automation({ id: "a", title: "Alpha" });
    const beta = automation({ id: "b", title: "Beta" });
    const alphaAgain = automation({ id: "c", title: "Alpha" });

    expect(compareUnifiedItems(alpha, beta)).toBeLessThan(0);
    expect(compareUnifiedItems(beta, alpha)).toBeGreaterThan(0);
    expect(compareUnifiedItems(alpha, alphaAgain)).toBe(0);
  });

  it("is antisymmetric across mixed rows", () => {
    const rows = [
      automation({ id: "1", system: true, enabled: true, title: "S on" }),
      automation({ id: "2", system: true, enabled: false, title: "S off" }),
      automation({ id: "3", system: false, enabled: true, title: "U on" }),
      automation({ id: "4", system: false, enabled: false, title: "U off" }),
    ];

    for (const a of rows) {
      for (const b of rows) {
        if (a === b) continue;
        const forward = Math.sign(compareUnifiedItems(a, b));
        const backward = Math.sign(compareUnifiedItems(b, a));
        expect(forward).toBe(-backward);
      }
    }
  });
});

describe("mergeUnifiedTasks", () => {
  it("returns an empty list when both inputs are empty", () => {
    expect(mergeUnifiedTasks([], [])).toEqual([]);
  });

  it("merges one automation and one scheduled task through the real adapter", () => {
    const merged = mergeUnifiedTasks([automation()], [scheduledTask()]);

    expect(merged.map((item) => item.id)).toEqual([
      "workflow:w-1",
      "scheduled:t-1",
    ]);
    const adapted = merged.find((item) => item.source === "scheduled_task");
    expect(adapted?.title).toBe("Good morning");
    expect(adapted?.system).toBe(false);
    expect(adapted?.enabled).toBe(true);
  });

  it("keeps the automation object itself when ids collide", () => {
    const collide = automation({
      id: "scheduled:t-1",
      title: "Pre-existing",
    });
    const merged = mergeUnifiedTasks([collide], [scheduledTask()]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(collide);
  });

  it("lets the later duplicate win when automations repeat an id", () => {
    const first = automation({ id: "dup", title: "First" });
    const second = automation({ id: "dup", title: "Second" });
    const merged = mergeUnifiedTasks([first, second], []);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(second);
  });

  it("orders system first, then enabled, then by title across mixed sources", () => {
    const merged = mergeUnifiedTasks(
      [
        automation({ id: "z", system: false, enabled: false, title: "Zulu" }),
        automation({ id: "a", system: true, enabled: true, title: "Alpha" }),
        automation({ id: "m", system: false, enabled: true, title: "Mango" }),
      ],
      [scheduledTask({ taskId: "anchor", metadata: { slot: "Anchor" } })],
    );

    expect(merged.map((item) => item.id)).toEqual([
      "a",
      "scheduled:anchor",
      "m",
      "z",
    ]);
  });

  it("does not mutate its inputs and returns a fresh array", () => {
    const autos = [
      automation({ id: "b", title: "Bravo" }),
      automation({ id: "a", title: "Alfa" }),
    ];
    const tasks = [scheduledTask()];
    const autosSnapshot = [...autos];
    const tasksSnapshot = [...tasks];

    const merged = mergeUnifiedTasks(autos, tasks);

    expect(autos).toEqual(autosSnapshot);
    expect(tasks).toEqual(tasksSnapshot);
    expect(merged).not.toBe(autos);
  });
});
