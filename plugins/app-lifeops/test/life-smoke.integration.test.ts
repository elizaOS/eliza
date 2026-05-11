/**
 * Smoke tests for the LIFE action -- verifies the full handler chain
 * with a real PGLite-backed LifeOps service and real runtime, exercising
 * the handler path with and without explicit action parameters.
 *
 * These simulate what happens when the LLM selects the LIFE action
 * with various parameter combinations:
 *
 *   1. LLM provides `action` param (primary path, reliable)
 *   2. LLM omits `action` but provides `intent` (extractor path)
 *   3. LLM provides both (action wins)
 *   4. LLM provides malformed/missing params (error paths)
 *
 * Run: bunx vitest run eliza/plugins/app-lifeops/test/life-smoke.integration.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRealTestRuntime } from "../../../test/helpers/real-runtime";
import { runLifeOperationHandler } from "../src/actions/life.js";
import { appLifeOpsPlugin } from "../src/plugin.js";

let runtime: AgentRuntime;
let cleanup: () => Promise<void> = async () => {};
let isolatedStateDir: string;
let isolatedConfigPath: string;

const isolatedEnvKeys = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
] as const;

const previousEnv = new Map<string, string | undefined>();

function setIsolatedLifeSmokeEnv(): void {
  isolatedStateDir = mkdtempSync(join(tmpdir(), "life-smoke-state-"));
  isolatedConfigPath = join(isolatedStateDir, "eliza.json");
  writeFileSync(
    isolatedConfigPath,
    JSON.stringify({ logging: { level: "error" } }),
    "utf8",
  );

  for (const key of isolatedEnvKeys) {
    previousEnv.set(key, process.env[key]);
  }

  process.env.ELIZA_STATE_DIR = isolatedStateDir;
  process.env.ELIZA_CONFIG_PATH = isolatedConfigPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = isolatedConfigPath;
  delete process.env.ELIZA_STATE_DIR;
  delete process.env.ELIZA_CONFIG_PATH;
  delete process.env.ELIZA_PERSIST_CONFIG_PATH;
  delete process.env.ELIZAOS_CLOUD_API_KEY;
  delete process.env.ELIZAOS_CLOUD_BASE_URL;
}

function restoreIsolatedLifeSmokeEnv(): void {
  for (const key of isolatedEnvKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

function send(params: Record<string, unknown>, messageText?: string) {
  return runLifeOperationHandler(
    runtime,
    {
      entityId: runtime.agentId,
      content: {
        source: "autonomy",
        text: messageText ?? (params.intent as string) ?? "test",
      },
    } as never,
    undefined,
    { parameters: params },
  );
}

beforeAll(async () => {
  setIsolatedLifeSmokeEnv();
  const result = await createRealTestRuntime({
    plugins: [appLifeOpsPlugin],
  });
  runtime = result.runtime;
  cleanup = result.cleanup;
}, 180_000);

afterAll(async () => {
  await cleanup();
  restoreIsolatedLifeSmokeEnv();
  if (isolatedStateDir) {
    rmSync(isolatedStateDir, { recursive: true, force: true });
  }
});

describe("LIFE action smoke tests -- BRD acceptance criteria", () => {
  // -- AC-1: "I need help brushing my teeth twice a day" --

  it("AC-1: creates a twice-daily brushing habit via action param", async () => {
    const result = await send({
      action: "create",
      intent: "help me brush my teeth twice a day, morning and night",
      title: "Brush teeth",
      details: {
        kind: "habit",
        cadence: {
          kind: "times_per_day",
          slots: [
            {
              key: "morning",
              label: "Morning",
              minuteOfDay: 420,
              durationMinutes: 5,
            },
            {
              key: "night",
              label: "Night",
              minuteOfDay: 1320,
              durationMinutes: 5,
            },
          ],
        },
        confirmed: true,
      },
    });

    expect(result).toMatchObject({ success: true });
    expect((result as { text: string }).text).toContain("Brush teeth");
  }, 60_000);

  // -- AC-2: Snooze a brushing reminder for 30 minutes --
  // Requires an existing occurrence in the DB. We create a definition first,
  // then get the overview to materialize occurrences, then snooze one.

  it("AC-2: snoozes via action param with 30m preset (end-to-end)", async () => {
    // First create a definition so we have an occurrence to snooze.
    // Uses times_per_day with explicit slots spread across the day so an
    // occurrence is always materializable regardless of when the test runs
    // (a single-window daily cadence would expire after the window passes).
    const createResult = await send({
      action: "create",
      intent: "brush teeth twice a day",
      title: "Brush teeth (snooze test)",
      details: {
        kind: "habit",
        cadence: {
          kind: "times_per_day",
          slots: [
            {
              key: "morning",
              label: "Morning",
              minuteOfDay: 420,
              durationMinutes: 5,
            },
            {
              key: "night",
              label: "Night",
              minuteOfDay: 1320,
              durationMinutes: 5,
            },
          ],
        },
        confirmed: true,
      },
    });
    expect(createResult).toMatchObject({ success: true });

    // Get overview to materialize occurrences and grab a concrete ID. Two
    // slots → two pending occurrences; pass the ID directly so the snooze
    // resolver doesn't have to disambiguate by name.
    const overviewResult = await send({
      action: "overview",
      intent: "give me an overview",
    });
    expect(overviewResult).toMatchObject({ success: true });
    const occurrences =
      (overviewResult?.data as { occurrences?: Array<{ id: string }> })
        ?.occurrences ?? [];
    expect(occurrences.length).toBeGreaterThan(0);
    const targetOccurrenceId = occurrences[0]?.id;
    expect(typeof targetOccurrenceId).toBe("string");

    const result = await send({
      action: "snooze",
      intent: "snooze brushing for 30 minutes",
      target: targetOccurrenceId,
      details: { preset: "30m" },
    });
    expect(result).toMatchObject({ success: true });
  }, 60_000);

  // -- AC-3: "Add one push-up and sit-up every day" (progressive) --

  it("AC-3: creates a progressive daily routine", async () => {
    const result = await send({
      action: "create",
      intent: "add one push-up every day, start at 10 and add one each day",
      title: "Daily pushups",
      details: {
        kind: "routine",
        cadence: { kind: "daily", windows: ["morning"] },
        progressionRule: {
          kind: "linear_increment",
          metric: "push-ups",
          start: 10,
          step: 1,
          unit: "reps",
        },
        confirmed: true,
      },
    });

    expect(result).toMatchObject({ success: true });
  }, 60_000);

  // -- AC-4: "I want to call my mom every week" --

  it("AC-4: creates an explicitly named weekly goal", async () => {
    const result = await send({
      action: "create_goal",
      intent: "Actually create a goal called Call Mom every week",
      title: "Call Mom every week",
      details: {
        cadence: { kind: "weekly" },
        successCriteria: {
          summary: "Call Mom at least once every calendar week.",
          metric: "weekly_call_completed",
          target: { callsPerWeek: 1 },
          evidenceSignals: ["manual_checkin"],
        },
        supportStrategy: {
          approach: "weekly_nudge",
          message: "Have you called Mom this week?",
        },
        confirmed: true,
      },
    });

    expect(result).toMatchObject({ success: true });
    // The handler should create the goal (confirmed: true) — the response
    // text may confirm the title or ask a follow-up depending on the LLM.
    // We verify goal creation succeeded via the success flag above.
    const text = (result as { text: string }).text;
    expect(typeof text).toBe("string");
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);

  // -- AC-5: Calendar query --
  // Calendar depends on Google connector which we don't have in test.
  // The handler should gracefully report "not connected".

  it("AC-5: calendar reports not connected when Google is not configured", async () => {
    const result = await send({
      action: "calendar",
      intent: "what's on my calendar today",
    });

    // Without Google connector, we expect a graceful "not connected" message
    expect(result).toMatchObject({ success: false });
    expect((result as { text: string }).text).toMatch(/not connected/i);
  }, 60_000);

  // -- AC-7: Email query --
  // Same as calendar: without Google connector, should report not connected.

  it("AC-7: email reports not connected when Google is not configured", async () => {
    const result = await send({
      action: "email",
      intent: "do I have any important emails?",
    });

    expect(result).toMatchObject({ success: false });
  }, 60_000);
});

describe("LIFE action -- robustness scenarios", () => {
  it("handles complete -> target not found gracefully", async () => {
    const result = await send({
      action: "complete",
      intent: "mark nonexistent done",
      target: "nonexistent",
    });
    expect(result).toMatchObject({
      success: false,
      text: expect.stringContaining("could not find"),
    });
  }, 60_000);

  it("handles create without title gracefully", async () => {
    const result = await send({
      action: "create",
      intent: "add something",
      details: {
        cadence: { kind: "daily", windows: ["morning"] },
        confirmed: true,
      },
    });
    expect(result).toMatchObject({
      success: false,
      text: expect.stringMatching(/call|name/i),
    });
  }, 60_000);

  it("handles create without cadence gracefully", async () => {
    const result = await send({
      action: "create",
      intent: "add pushups",
      title: "Pushups",
    });
    expect(result).toMatchObject({
      success: false,
      text: expect.stringMatching(/when|schedule/i),
    });
  }, 60_000);

  it("handles Google not connected for calendar gracefully", async () => {
    const result = await send({
      action: "calendar",
      intent: "what's on my calendar",
    });
    expect(result).toMatchObject({
      success: false,
      text: expect.stringContaining("not connected"),
    });
  }, 60_000);

  it("handles phone capture without number gracefully", async () => {
    const result = await send({
      action: "phone",
      intent: "text me reminders",
    });
    expect(result).toMatchObject({
      success: false,
      text: expect.stringContaining("phone number"),
    });
  }, 60_000);

  it("handles empty intent gracefully", async () => {
    const result = await send({ action: "overview", intent: "" }, "");
    expect(result).toMatchObject({
      success: false,
      text: expect.stringMatching(/tell me|intent/i),
    });
  }, 60_000);

  it("handles missing action + intent", async () => {
    const result = await send({ intent: "asdfghjkl gibberish" });
    // Without explicit action and with gibberish, handler should clarify (noop)
    expect(result).toMatchObject({ success: true });
    expect((result as { data?: { noop?: boolean } }).data).toMatchObject({
      noop: true,
    });
  }, 60_000);

  it("action param takes precedence over classifier when both disagree", async () => {
    // "review the calendar" would classify as review_goal via regex,
    // but action says "calendar" -- action wins
    const result = await send({
      action: "calendar",
      intent: "review the calendar",
    });
    // Calendar without Google should fail with "not connected",
    // proving action param was used (not review_goal)
    expect(result).toMatchObject({
      success: false,
      text: expect.stringContaining("not connected"),
    });
  }, 60_000);
});
