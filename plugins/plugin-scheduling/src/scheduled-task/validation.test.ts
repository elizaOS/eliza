/**
 * Unit coverage for validateScheduledTaskInput — structural and registry checks.
 *
 * Exercises the pure validator that guards the scheduling API boundary before
 * persistence. Each case uses the same mock registries the runner uses in
 * production (built-in gates / checks / ladders), so a failure mirrors a
 * real API 400 rather than a synthetic cast-only path.
 */

import { describe, expect, it } from "vitest";

import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import type { ScheduledTaskInput } from "./types.js";
import { validateScheduledTaskInput } from "./validation.js";

function createDeps() {
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  return { gates, completionChecks, ladders };
}

function validInput(
  overrides: Record<string, unknown> = {},
): ScheduledTaskInput {
  const base: ScheduledTaskInput = {
    kind: "reminder",
    promptInstructions: "test instructions",
    trigger: { kind: "manual" },
    priority: "medium",
    respectsGlobalPause: true,
    source: "user_chat",
    createdBy: "tester",
    ownerVisible: true,
  };
  // Apply overrides via record mutation to keep type strict
  const merged = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides)) {
    merged[k] = v;
  }
  return merged as ScheduledTaskInput;
}

describe("validateScheduledTaskInput", () => {
  it("accepts a minimal valid manual task", () => {
    const deps = createDeps();
    const input = validInput();
    expect(validateScheduledTaskInput(input, deps)).toEqual([]);
  });

  it("accepts a fully populated valid task", () => {
    const deps = createDeps();
    const input = validInput({
      kind: "approval",
      priority: "high",
      source: "plugin",
      trigger: { kind: "once", atIso: "2025-01-01T00:00:00.000Z" },
      subject: { kind: "entity", id: "entity-1" },
      output: { destination: "in_app_card" },
      idempotencyKey: "key-1",
    });
    expect(validateScheduledTaskInput(input, deps)).toEqual([]);
  });

  it("flags an invalid kind", () => {
    const deps = createDeps();
    const input = validInput();
    (input as Record<string, unknown>).kind = "not-a-kind";
    const issues = validateScheduledTaskInput(input, deps);
    expect(issues.join(";")).toMatch(/kind/i);
  });

  it("flags an invalid priority", () => {
    const deps = createDeps();
    const input = validInput();
    (input as Record<string, unknown>).priority = "urgent";
    const issues = validateScheduledTaskInput(input, deps);
    expect(issues.join(";")).toMatch(/priority/i);
  });

  it("flags an invalid source", () => {
    const deps = createDeps();
    const input = validInput();
    (input as Record<string, unknown>).source = "bad_source";
    const issues = validateScheduledTaskInput(input, deps);
    expect(issues.join(";")).toMatch(/source/i);
  });

  it("flags malformed ISO in once trigger", () => {
    const deps = createDeps();
    const input = validInput({
      trigger: { kind: "once", atIso: "not-an-iso" },
    });
    const issues = validateScheduledTaskInput(input, deps);
    expect(issues.join(";")).toMatch(/atIso/i);
  });

  it("flags unknown cron expression", () => {
    const deps = createDeps();
    const input = validInput({
      trigger: { kind: "cron", expression: "" },
    });
    const issues = validateScheduledTaskInput(input, deps);
    expect(issues.join(";")).toMatch(/expression/i);
  });

  it("flags non-positive interval minutes", () => {
    const deps = createDeps();
    const input = validInput({
      trigger: { kind: "interval", everyMinutes: 0 },
    });
    const issues = validateScheduledTaskInput(input, deps);
    expect(issues.join(";")).toMatch(/everyMinutes/i);
  });

  it("flags an unregistered gate kind", () => {
    const deps = createDeps();
    const input = validInput({
      shouldFire: { gates: [{ kind: "not-a-registered-gate" }] },
    });
    const issues = validateScheduledTaskInput(input, deps);
    expect(issues.join(";")).toMatch(/not-a-registered-gate/);
  });

  it("flags an unregistered completion-check kind", () => {
    const deps = createDeps();
    const input = validInput({
      completionCheck: { kind: "not-a-check" },
    });
    const issues = validateScheduledTaskInput(input, deps);
    expect(issues.join(";")).toMatch(/not-a-check/);
  });

  it("flags an unregistered escalation ladder", () => {
    const deps = createDeps();
    const input = validInput({
      escalation: { ladderKey: "not-a-ladder" },
    });
    const issues = validateScheduledTaskInput(input, deps);
    expect(issues.join(";")).toMatch(/not-a-ladder/);
  });

  it("flags an invalid output destination", () => {
    const deps = createDeps();
    const input = validInput();
    (input as Record<string, unknown>).output = { destination: "bad-dest" };
    const issues = validateScheduledTaskInput(input, deps);
    expect(issues.join(";")).toMatch(/destination/i);
  });

  it("catches a cyclic pipeline reference", () => {
    const deps = createDeps();
    const inner: ScheduledTaskInput = validInput();
    const outer = validInput({
      pipeline: { onComplete: [inner] },
    });
    // Create cycle: inner references outer
    (inner as Record<string, unknown>).pipeline = { onComplete: [outer] };
    const issues = validateScheduledTaskInput(outer, deps);
    expect(issues.join(";")).toMatch(/cyclic/i);
  });

  it("flags invalid idempotencyKey", () => {
    const deps = createDeps();
    const input = validInput({ idempotencyKey: "" });
    const issues = validateScheduledTaskInput(input, deps);
    expect(issues.join(";")).toMatch(/idempotencyKey/i);
  });
});
