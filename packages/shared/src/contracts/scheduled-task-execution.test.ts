/**
 * Unit coverage for scheduled-task execution profile contracts
 * in scheduled-task-execution.ts.
 *
 * Tests vocabulary exports, profile array structure and uniqueness,
 * and canonical default profile assignment.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_EXECUTION_PROFILE,
  TASK_EXECUTION_PROFILES,
  type TaskExecutionProfile,
} from "./scheduled-task-execution.js";

describe("scheduled-task-execution", () => {
  it("exports TASK_EXECUTION_PROFILES with expected profile vocabulary", () => {
    expect(Array.isArray(TASK_EXECUTION_PROFILES)).toBe(true);
    expect(TASK_EXECUTION_PROFILES).toEqual([
      "foreground",
      "bg-light-30s",
      "bg-heavy-fgs",
      "notify-only",
    ]);
  });

  it("ensures all execution profiles are non-empty unique strings", () => {
    const unique = new Set(TASK_EXECUTION_PROFILES);
    expect(unique.size).toBe(TASK_EXECUTION_PROFILES.length);

    for (const profile of TASK_EXECUTION_PROFILES) {
      expect(typeof profile).toBe("string");
      expect(profile.length).toBeGreaterThan(0);
      expect(profile.trim()).toBe(profile);
    }
  });

  it("defines DEFAULT_TASK_EXECUTION_PROFILE as 'foreground'", () => {
    expect(DEFAULT_TASK_EXECUTION_PROFILE).toBe("foreground");
    expect(
      TASK_EXECUTION_PROFILES.includes(
        DEFAULT_TASK_EXECUTION_PROFILE as TaskExecutionProfile,
      ),
    ).toBe(true);
  });
});
