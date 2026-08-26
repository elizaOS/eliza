/**
 * Default-pack boundary tests prove authored scheduling seeds retain their
 * canonical fields and every materialized catalog task satisfies the runner.
 */

import {
  type ScheduledTaskSeed,
  scheduledTaskInputSchema,
} from "@elizaos/plugin-scheduling";
import { describe, expect, it } from "vitest";
import {
  buildDefaultPackCatalogTasks,
  toSpineTaskInput,
} from "./spine-registration.js";

describe("default-pack scheduling boundary", () => {
  it("preserves fallback output, execution profile, and readonly context selections", () => {
    const ownerFacts = ["preferredName", "timezone"] as const;
    const seed: ScheduledTaskSeed = {
      kind: "reminder",
      promptInstructions: "Surface the authored reminder.",
      contextRequest: { includeOwnerFacts: ownerFacts },
      trigger: { kind: "manual" },
      priority: "low",
      output: {
        destination: "channel",
        target: "in_app",
        fallback: { title: "Reminder", body: "Authored fallback" },
      },
      idempotencyKey: "test:canonical-seed",
      respectsGlobalPause: true,
      source: "default_pack",
      createdBy: "test",
      ownerVisible: true,
      executionProfile: "notify-only",
    };

    const input = toSpineTaskInput(seed, "unused:fallback");

    expect(input.contextRequest?.includeOwnerFacts).toEqual(ownerFacts);
    expect(input.output?.fallback).toEqual({
      title: "Reminder",
      body: "Authored fallback",
    });
    expect(input.executionProfile).toBe("notify-only");
    expect(scheduledTaskInputSchema.safeParse(input).success).toBe(true);
  });

  it("materializes every enabled catalog record as canonical runner input", () => {
    for (const input of buildDefaultPackCatalogTasks()) {
      const parsed = scheduledTaskInputSchema.safeParse(input);
      expect(parsed.success, input.idempotencyKey).toBe(true);
    }
  });
});
