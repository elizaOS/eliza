/**
 * Keyless OWNER_GOALS e2e (#8801, gap 5 — per-plugin harness adoption).
 *
 * Drives the goals plugin's primary action (`OWNER_GOALS`) end-to-end through
 * the deterministic mock LLM with `withMockLlmRuntime()` and NO API keys. The
 * action resolves its subaction + params via `resolveActionArgs`, which makes a
 * single `TEXT_LARGE` extraction call answered here by a declared fixture (the
 * JSON envelope `{action, params, missing, confidence}`). The handler's
 * `callback` captures the agent's reply, asserting the natural-language →
 * mock-LLM-extraction → action-dispatch loop closed with zero external cost.
 *
 * Two complementary paths, both terminating inside the action's own handler
 * (before the goals back-end touches PA's cross-plugin `app_lifeops` audit
 * table, which is out of this plugin's keyless surface):
 *   1. A missing required field → the handler's clarification branch, reply
 *      naming the field the LLM could not extract.
 *   2. A low-confidence extraction → the same structured clarification, proving
 *      the action degrades safely on an uncertain model decision.
 */
import {
  type HandlerCallback,
  type Memory,
  ModelType,
  parseInteractionBlocks,
} from "@elizaos/core";
import { type MockLlmRuntime, withMockLlmRuntime } from "@elizaos/test-harness";
import { afterEach, describe, expect, it } from "vitest";
import { executeRawSql } from "../db/sql.ts";
import { goalsPlugin } from "../plugin.ts";
import { GOAL_CHECKIN_PROGRESS_STATES } from "../services/checkin.ts";
import { ownerGoalsAction } from "./goals.ts";

/**
 * Provision the one peer-owned table the OWNER_GOALS create/update/delete path
 * appends an audit row into. In production `@elizaos/plugin-personal-assistant`
 * owns `app_lifeops.life_audit_events`; in this PA-free keyless e2e we create
 * just that table (matching the columns the goals repository's INSERT writes) so
 * the full create→reply loop runs without pulling all of PA into the runtime.
 */
async function provisionAuditTable(harness: MockLlmRuntime): Promise<void> {
  await executeRawSql(
    harness.runtime,
    "CREATE SCHEMA IF NOT EXISTS app_lifeops",
  );
  await executeRawSql(
    harness.runtime,
    `CREATE TABLE IF NOT EXISTS app_lifeops.life_audit_events (
       id text PRIMARY KEY,
       agent_id text NOT NULL,
       event_type text NOT NULL,
       owner_type text NOT NULL,
       owner_id text NOT NULL,
       reason text,
       inputs_json text,
       decision_json text,
       actor text NOT NULL,
       created_at text NOT NULL
     )`,
  );
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

function track(harness: MockLlmRuntime): MockLlmRuntime {
  cleanups.push(harness.cleanup);
  return harness;
}

async function runOwnerGoals(
  harness: MockLlmRuntime,
  text: string,
): Promise<{
  result: { success: boolean; data?: { action?: string; missing?: string[] } };
  reply: string;
}> {
  const message = { content: { text } } as Memory;
  let reply = "";
  const callback: HandlerCallback = async (content) => {
    if (typeof content.text === "string") reply += content.text;
    return [];
  };
  const result = (await ownerGoalsAction.handler(
    harness.runtime,
    message,
    undefined,
    undefined,
    callback,
  )) as { success: boolean; data?: { action?: string; missing?: string[] } };
  return { result, reply };
}

describe("OWNER_GOALS action (keyless harness)", () => {
  it("creates a goal from natural language via the mock LLM extraction pass", async () => {
    const harness = track(
      await withMockLlmRuntime({
        plugins: [goalsPlugin],
        fixtures: [
          {
            name: "goal-extraction-create",
            match: { modelType: ModelType.TEXT_LARGE },
            response: JSON.stringify({
              action: "create",
              params: { title: "Run a marathon" },
              missing: [],
              confidence: 0.95,
            }),
            times: 1,
          },
        ],
      }),
    );
    await provisionAuditTable(harness);

    const { result, reply } = await runOwnerGoals(
      harness,
      "Add a goal to run a marathon next year.",
    );

    expect(result.success, reply).toBe(true);
    expect(result.data?.action).toBe("create");
    expect(reply).toContain("Run a marathon");
    expect(() => harness.assertFixturesConsumed()).not.toThrow();
  });

  it("asks for the missing required field the mock LLM could not extract", async () => {
    const harness = track(
      await withMockLlmRuntime({
        plugins: [goalsPlugin],
        fixtures: [
          {
            // The `resolveActionArgs` extraction pass (a single TEXT_LARGE call)
            // chose `update` but could not pull the required `id`.
            name: "goal-extraction-missing-id",
            match: { modelType: ModelType.TEXT_LARGE },
            response: JSON.stringify({
              action: "update",
              params: { title: "Run a marathon" },
              missing: ["id"],
              confidence: 0.95,
            }),
            times: 1,
          },
        ],
      }),
    );

    const { result, reply } = await runOwnerGoals(
      harness,
      "Update my marathon goal.",
    );

    expect(result.success).toBe(false);
    expect(result.data?.missing).toContain("id");
    // The action's clarification names the field, delivered via the callback.
    expect(reply.toLowerCase()).toContain("id");
    expect(() => harness.assertFixturesConsumed()).not.toThrow();
  });

  it("degrades to a clarification when the mock LLM extraction is low-confidence", async () => {
    const harness = track(
      await withMockLlmRuntime({
        plugins: [goalsPlugin],
        fixtures: [
          {
            name: "goal-extraction-low-confidence",
            match: { modelType: ModelType.TEXT_LARGE },
            response: JSON.stringify({
              action: "create",
              params: { title: "Run a marathon" },
              missing: [],
              confidence: 0.2,
            }),
            times: 1,
          },
        ],
      }),
    );

    const { result, reply } = await runOwnerGoals(
      harness,
      "Maybe do something about marathons?",
    );

    expect(result.success).toBe(false);
    expect(reply.trim().length).toBeGreaterThan(0);
    expect(() => harness.assertFixturesConsumed()).not.toThrow();
  });

  it("re-asks an invalid check-in progress with one-tap [CHOICE] chips whose values the checkin turn accepts (#14733)", async () => {
    const harness = track(
      await withMockLlmRuntime({
        plugins: [goalsPlugin],
        fixtures: [
          {
            // Extraction picked `checkin` but pulled a free-text progress the
            // handler cannot classify.
            name: "goal-extraction-checkin-bad-progress",
            match: { modelType: ModelType.TEXT_LARGE },
            response: JSON.stringify({
              action: "checkin",
              params: { id: "goal-123", progress: "kinda okay" },
              missing: [],
              confidence: 0.95,
            }),
            times: 1,
          },
        ],
      }),
    );

    const { result, reply } = await runOwnerGoals(
      harness,
      "Check in on my marathon goal — it's kinda okay.",
    );

    expect(result.success).toBe(false);
    expect((result.data as { error?: string } | undefined)?.error).toBe(
      "invalid_progress",
    );
    const { blocks } = parseInteractionBlocks(reply);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    expect(block).toMatchObject({
      kind: "choice",
      scope: "goal-checkin",
      id: "goal-checkin-goal-123",
    });
    if (block?.kind !== "choice") throw new Error("expected choice block");
    // Round-trip contract: every chip value IS a valid `progress` token.
    expect(block.options.map((o) => o.value)).toEqual([
      ...GOAL_CHECKIN_PROGRESS_STATES,
    ]);
    expect(() => harness.assertFixturesConsumed()).not.toThrow();
  });

  it("appends the progress chips to a note-only check-in, and a chip value round-trips into recorded progress", async () => {
    const harness = track(
      await withMockLlmRuntime({
        plugins: [goalsPlugin],
        fixtures: [
          {
            name: "goal-extraction-create-for-checkin",
            match: { modelType: ModelType.TEXT_LARGE },
            response: JSON.stringify({
              action: "create",
              params: { title: "Ship the widget cluster" },
              missing: [],
              confidence: 0.95,
            }),
            times: 1,
          },
        ],
      }),
    );
    await provisionAuditTable(harness);

    const created = await runOwnerGoals(
      harness,
      "Add a goal to ship the widget cluster.",
    );
    expect(created.result.success, created.reply).toBe(true);
    const record = (
      created.result.data as { record?: { goal?: { id?: string } } } | undefined
    )?.record;
    const goalId = record?.goal?.id;
    expect(typeof goalId).toBe("string");

    // Turn 2: a note-only check-in — the reply must end with progress chips.
    harness.fixtures.register({
      name: "goal-extraction-checkin-note-only",
      match: { modelType: ModelType.TEXT_LARGE },
      response: JSON.stringify({
        action: "checkin",
        params: { id: goalId, note: "made progress this week" },
        missing: [],
        confidence: 0.95,
      }),
      times: 1,
    });
    const noteTurn = await runOwnerGoals(
      harness,
      "Check in on the widget goal: made progress this week.",
    );
    expect(noteTurn.result.success, noteTurn.reply).toBe(true);
    expect(noteTurn.reply).toContain("How is it tracking?");
    const { blocks } = parseInteractionBlocks(noteTurn.reply);
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "choice") throw new Error("expected choice block");
    expect(block.id).toBe(`goal-checkin-${goalId}`);
    const tappedValue = block.options[1]?.value;
    expect(tappedValue).toBe("at_risk");

    // Turn 3: the tap — the chip value arrives as the user's message and the
    // extraction passes it through as `progress`; the goal's reviewState
    // must flip to the tapped token.
    harness.fixtures.register({
      name: "goal-extraction-checkin-tap",
      match: { modelType: ModelType.TEXT_LARGE },
      response: JSON.stringify({
        action: "checkin",
        params: { id: goalId, progress: tappedValue },
        missing: [],
        confidence: 0.95,
      }),
      times: 1,
    });
    const tapTurn = await runOwnerGoals(harness, tappedValue ?? "");
    expect(tapTurn.result.success, tapTurn.reply).toBe(true);
    expect(tapTurn.reply).toContain("at risk");
    const updatedGoal = (
      tapTurn.result.data as { goal?: { reviewState?: string } } | undefined
    )?.goal;
    expect(updatedGoal?.reviewState).toBe("at_risk");
    // A progress-carrying check-in reply needs no chips.
    expect(parseInteractionBlocks(tapTurn.reply).blocks).toHaveLength(0);
    expect(() => harness.assertFixturesConsumed()).not.toThrow();
  });
});
