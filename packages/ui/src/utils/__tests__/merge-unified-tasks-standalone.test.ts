/**
 * Unit tests for unified tasks merging and comparator logic.
 */
import { describe, expect, it } from "vitest";
import type { AutomationItem } from "../../api/client-types-config.ts";
import type { ScheduledTaskView } from "../../api/client-types-core.ts";
import {
  compareUnifiedItems,
  mergeUnifiedTasks,
} from "../merge-unified-tasks.ts";

describe("merge-unified-tasks", () => {
  describe("compareUnifiedItems", () => {
    it("sorts system items first", () => {
      const regular: AutomationItem = {
        id: "1",
        title: "Alpha",
        enabled: true,
        kind: "workflow",
        system: false,
      };
      const system: AutomationItem = {
        id: "2",
        title: "Beta",
        enabled: true,
        kind: "workflow",
        system: true,
      };
      expect(compareUnifiedItems(system, regular)).toBeLessThan(0);
      expect(compareUnifiedItems(regular, system)).toBeGreaterThan(0);
    });

    it("sorts enabled items before disabled items within same system group", () => {
      const enabled: AutomationItem = {
        id: "1",
        title: "Beta",
        enabled: true,
        kind: "workflow",
        system: false,
      };
      const disabled: AutomationItem = {
        id: "2",
        title: "Alpha",
        enabled: false,
        kind: "workflow",
        system: false,
      };
      expect(compareUnifiedItems(enabled, disabled)).toBeLessThan(0);
      expect(compareUnifiedItems(disabled, enabled)).toBeGreaterThan(0);
    });

    it("sorts alphabetically by title when system and enabled states match", () => {
      const a: AutomationItem = {
        id: "1",
        title: "Alpha",
        enabled: true,
        kind: "workflow",
        system: false,
      };
      const b: AutomationItem = {
        id: "2",
        title: "Beta",
        enabled: true,
        kind: "workflow",
        system: false,
      };
      expect(compareUnifiedItems(a, b)).toBeLessThan(0);
      expect(compareUnifiedItems(b, a)).toBeGreaterThan(0);
    });
  });

  describe("mergeUnifiedTasks", () => {
    it("merges and deduplicates automations with scheduled tasks, sorted properly", () => {
      const automations: AutomationItem[] = [
        {
          id: "auto-1",
          title: "Daily Morning Briefing",
          enabled: true,
          kind: "workflow",
          system: false,
        },
      ];

      const scheduledTasks: ScheduledTaskView[] = [
        {
          taskId: "task-1",
          promptInstructions: "Nightly database sync",
          trigger: { kind: "cron", expression: "0 0 * * *" },
          state: { status: "pending" },
          metadata: { recordKey: "gm" },
          createdBy: "owner",
          kind: "generic",
        } as unknown as ScheduledTaskView,
      ];

      const merged = mergeUnifiedTasks(automations, scheduledTasks);
      expect(merged).toHaveLength(2);
      expect(merged[0]?.title).toBe("Daily Morning Briefing");
      expect(merged[1]?.title).toBe("Good morning");
    });
  });
});
