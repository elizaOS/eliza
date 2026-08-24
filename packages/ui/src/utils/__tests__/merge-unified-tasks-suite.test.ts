/**
 * Unit tests for unified tasks merging and comparator logic.
 * Validates system-first ordering, enabled state priority, title tiebreaks, and id deduplication.
 */
import { describe, expect, it } from "vitest";
import type { AutomationItem } from "../../api/client-types-config";
import type { ScheduledTaskView } from "../../api/client-types-core";
import {
  compareUnifiedItems,
  mergeUnifiedTasks,
} from "../merge-unified-tasks.ts";

describe("merge-unified-tasks", () => {
  describe("compareUnifiedItems", () => {
    it("sorts system items before non-system items", () => {
      const sys: AutomationItem = {
        id: "sys-1",
        title: "Z-System",
        system: true,
        enabled: true,
        type: "workflow",
      };
      const user: AutomationItem = {
        id: "usr-1",
        title: "A-User",
        system: false,
        enabled: true,
        type: "workflow",
      };
      expect(compareUnifiedItems(sys, user)).toBeLessThan(0);
      expect(compareUnifiedItems(user, sys)).toBeGreaterThan(0);
    });

    it("sorts enabled items before disabled items", () => {
      const enabled: AutomationItem = {
        id: "en-1",
        title: "Z-Task",
        system: false,
        enabled: true,
        type: "workflow",
      };
      const disabled: AutomationItem = {
        id: "dis-1",
        title: "A-Task",
        system: false,
        enabled: false,
        type: "workflow",
      };
      expect(compareUnifiedItems(enabled, disabled)).toBeLessThan(0);
      expect(compareUnifiedItems(disabled, enabled)).toBeGreaterThan(0);
    });

    it("sorts by title alphabetically when system and enabled states match", () => {
      const a: AutomationItem = {
        id: "1",
        title: "Alpha",
        system: false,
        enabled: true,
        type: "workflow",
      };
      const b: AutomationItem = {
        id: "2",
        title: "Beta",
        system: false,
        enabled: true,
        type: "workflow",
      };
      expect(compareUnifiedItems(a, b)).toBeLessThan(0);
      expect(compareUnifiedItems(b, a)).toBeGreaterThan(0);
    });
  });

  describe("mergeUnifiedTasks", () => {
    it("merges automations and scheduled tasks with deduplication and sorting", () => {
      const automations: AutomationItem[] = [
        {
          id: "auto-1",
          title: "Daily Standup",
          system: false,
          enabled: true,
          type: "workflow",
        },
        {
          id: "scheduled:task-dup",
          title: "Existing Automation Win",
          system: true,
          enabled: true,
          type: "workflow",
        },
      ];

      const scheduledTasks: ScheduledTaskView[] = [
        {
          taskId: "task-dup",
          kind: "generic",
          trigger: { kind: "cron", expression: "0 * * * *" },
          state: { status: "pending" },
          metadata: { recordKey: "gm" },
        } as unknown as ScheduledTaskView,
        {
          taskId: "task-unique",
          kind: "generic",
          trigger: { kind: "cron", expression: "0 0 * * *" },
          state: { status: "pending" },
          metadata: { recordKey: "gn" },
        } as unknown as ScheduledTaskView,
      ];

      const merged = mergeUnifiedTasks(automations, scheduledTasks);

      expect(merged).toHaveLength(3);
      expect(merged[0]?.id).toBe("scheduled:task-dup"); // system item first
      expect(merged[0]?.title).toBe("Existing Automation Win");
      expect(merged[1]?.id).toBe("auto-1"); // "Daily Standup" comes before "Good night"
      expect(merged[2]?.id).toBe("scheduled:task-unique");
    });
  });
});
