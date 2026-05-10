/**
 * Apple Reminders permission denied → fall back to internal reminder OR
 * surface the permission ask.
 *
 * Failure modes guarded:
 *   - silently failing to create any reminder (the user's request is dropped)
 *   - claiming the native Apple reminder was created when it wasn't
 *   - throwing an error to the user without offering a path forward
 *
 * The scenario writes a settings row that signals "apple reminders is not
 * permitted" and asks the agent to set a reminder. The valid outcomes are:
 *   (a) the agent creates an internal life_task_definitions row (LIFE
 *       action), OR
 *   (b) the agent's reply asks the user to grant permission AND no broken
 *       state is recorded.
 *
 * Cited: 03-coverage-gap-matrix.md row 15 — apple reminders permission
 * denied has no scenario.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { judgeRubric } from "../_helpers/action-assertions.ts";

function checkAgentChoseValidFallback(
  ctx: ScenarioContext,
): string | undefined {
  const lifeAction = ctx.actionsCalled.find(
    (action) => action.actionName === "LIFE",
  );
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty agent response";

  // Path A: agent created an internal reminder via LIFE action.
  const createdInternalReminder = (() => {
    if (!lifeAction) return false;
    const blob = JSON.stringify({
      params: lifeAction.parameters ?? null,
      data: lifeAction.result?.data ?? null,
    }).toLowerCase();
    return (
      blob.includes("call mom") ||
      blob.includes("call_mom") ||
      blob.includes('"title"') ||
      blob.includes("create_definition") ||
      blob.includes("create_task")
    );
  })();

  // Path B: agent's reply asks the user to grant permission AND the agent
  // did NOT silently claim "your reminder is set".
  const permissionAskMarkers = [
    "grant",
    "permission",
    "allow access",
    "authorize",
    "system settings",
    "system preferences",
    "privacy",
    "reminders access",
    "needs access",
  ];
  const askedForPermission = permissionAskMarkers.some((m) =>
    reply.includes(m),
  );

  // Fail conditions:
  //   - claimed reminder created via apple/native AND no internal fallback row
  const fakeAppleSuccess =
    /apple reminder|native reminder|set in apple|set in reminders|added to reminders/.test(
      reply,
    );
  if (fakeAppleSuccess && !createdInternalReminder) {
    return `Agent claimed the apple/native reminder was set, but there is no permission and no internal fallback row was created. Reply: ${reply.slice(0, 400)}`;
  }
  if (!createdInternalReminder && !askedForPermission) {
    return `Agent neither created an internal reminder nor asked the user to grant Apple Reminders permission. The user's request was silently dropped. Reply: ${reply.slice(0, 400)}; LIFE action invoked: ${lifeAction ? "yes" : "no"}`;
  }
  return undefined;
}

export default scenario({
  id: "reminders.apple-permission-denied",
  title:
    "Reminder request with Apple permission denied falls back internally or asks for grant",
  domain: "lifeops.reminders",
  tags: [
    "lifeops",
    "reminders",
    "apple-reminders",
    "permission-denied",
    "fallback",
    "robustness",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "Apple Reminders Permission Denied",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-apple-reminders-permission-denied",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const nowIso = new Date().toISOString();
        // Persist the denied state in life_connector_grants. The schema
        // (schema.ts:41) has no "state" column; the convention used
        // elsewhere in the codebase is to encode "denied" via mode and
        // metadata_json.
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_connector_grants (
             id, agent_id, provider, side, identity_json, granted_scopes_json,
             capabilities_json, mode, execution_target, source_of_truth,
             metadata_json, last_refresh_at, created_at, updated_at
           ) VALUES (
             ${sqlQuote("seed-apple-reminders-denied")},
             ${sqlQuote(agentId)},
             'apple_reminders',
             'owner',
             '{}',
             '[]',
             '[]',
             'denied',
             'local',
             'local_storage',
             ${sqlQuote(JSON.stringify({
               denied: true,
               denied_reason:
                 "user denied Reminders access in System Settings → Privacy & Security → Reminders",
               last_check_at: nowIso,
             }))},
             ${sqlQuote(nowIso)},
             ${sqlQuote(nowIso)},
             ${sqlQuote(nowIso)}
           )
           ON CONFLICT (id) DO UPDATE SET
             metadata_json = EXCLUDED.metadata_json,
             mode = EXCLUDED.mode,
             updated_at = EXCLUDED.updated_at`,
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-for-reminder",
      room: "main",
      text: "Remind me to call mom at 5pm tomorrow.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "agent-uses-fallback-or-asks-for-permission",
      predicate: checkAgentChoseValidFallback,
    },
    judgeRubric({
      name: "reminders-apple-permission-denied-rubric",
      threshold: 0.7,
      description: `Apple Reminders permission is denied. The user asked the agent to set a 5pm-tomorrow reminder to call mom. Two valid outcomes: (1) the agent quietly creates an internal Eliza reminder and confirms it; OR (2) the agent tells the user that Apple Reminders access is denied and asks them to grant it (in System Settings → Privacy → Reminders). An invalid outcome: claims the Apple reminder was set when it wasn't; says "ok" with no follow-up; throws a raw stack trace. Score 0 if the agent claims the Apple reminder was created.`,
    }),
  ],
});
