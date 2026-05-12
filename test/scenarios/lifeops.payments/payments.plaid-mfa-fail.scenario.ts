/**
 * Plaid bank-link MFA fail.
 *
 * Bug class this guards: when Plaid's `/link/token/exchange` returns an
 * `ITEM_LOGIN_REQUIRED` or MFA-failure response, the agent must (a) NOT
 * pretend the link succeeded, (b) NOT silently retry, (c) surface the
 * actionable error to the user with the next step (re-auth in the linked
 * accounts UI).
 *
 * The test seeds a fake Plaid connector grant in a "MFA failed" state and
 * asks the agent for the linked-accounts overview. The PAYMENTS action's
 * structured result must mark the bank source as `state: "needs_reauth"`
 * (or equivalent error state) AND the agent's reply must reference the
 * action the user should take.
 *
 * Cited: 03-coverage-gap-matrix.md row "bank link MFA fail" / NONE in matrix.
 *
 * BLOCKED-ON-MOCKOON: there is no `plaid.json` mockoon environment yet
 * (`test/mocks/environments/` has no plaid file as of 2026-05-09). The
 * scenario seeds the failure state directly into the lifeops payment_sources
 * table to exercise the agent's read+report path. When the Plaid mockoon
 * lands, the seed should be replaced with an actual mock-server roundtrip.
 *
 * Gated on `LIFEOPS_USE_MOCKOON=1` for the mockoon round-trip path; the
 * direct DB-seed path always runs.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import { judgeRubric } from "../_helpers/action-assertions.ts";

function checkAgentSurfacesActionableError(
  ctx: ScenarioContext,
): string | undefined {
  const payments = ctx.actionsCalled.find(
    (action) => action.actionName === "PAYMENTS",
  );
  if (!payments) {
    return "expected the PAYMENTS action to be invoked when the user asks about their linked bank accounts";
  }

  // The structured result should mark the source as needing re-auth.
  // We check for any of the expected error markers in the action's
  // serialized data — this is "agent read the live row", not LARP, because
  // the seed wrote a specific status string.
  const blob = JSON.stringify({
    parameters: payments.parameters ?? null,
    data: payments.result?.data ?? null,
    text: payments.result?.text ?? null,
  }).toLowerCase();
  const errorMarkers = [
    "needs_reauth",
    "needs reauth",
    "mfa",
    "item_login_required",
    "login_required",
    "needs to re-authenticate",
    "auth required",
    "requires re-auth",
    "needs attention",
  ];
  if (!errorMarkers.some((m) => blob.includes(m))) {
    return `PAYMENTS action did not surface the failed-MFA state from the seeded payment_sources row. Action blob: ${blob.slice(0, 400)}`;
  }

  // The agent's user-facing reply must mention re-linking, the bank's name,
  // or otherwise prompt the user to take action — NOT cheerfully report a
  // healthy connection.
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty agent response";
  const userActionMarkers = [
    "re-auth",
    "reauth",
    "re-link",
    "relink",
    "sign in again",
    "log in again",
    "verify",
    "needs attention",
    "mfa",
    "re-connect",
    "reconnect",
    "expired",
    "couldn't",
    "can't",
    "unable",
    "failed",
  ];
  if (!userActionMarkers.some((m) => reply.includes(m))) {
    return `Agent reply did not surface the actionable error. The user must be told to re-link / verify / re-authenticate the bank. Reply: ${reply.slice(0, 400)}`;
  }
  // Negative-space check: agent must NOT claim success.
  const successMarkers = [
    "successfully linked",
    "all set",
    "all good",
    "looks healthy",
    "everything looks good",
    "no issues",
  ];
  for (const m of successMarkers) {
    if (reply.includes(m)) {
      return `Agent claimed success in the face of an MFA-failed bank link. Reply: ${reply.slice(0, 400)}`;
    }
  }
  return undefined;
}

export default scenario({
  id: "payments.plaid-mfa-fail",
  title:
    "Plaid MFA failure surfaces actionable re-auth, never claims success",
  domain: "lifeops.payments",
  tags: [
    "lifeops",
    "payments",
    "plaid",
    "mfa-failure",
    "negative-path",
    "blocked-on-mockoon",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Plaid MFA Fail",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-plaid-source-in-mfa-failed-state",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const nowIso = new Date().toISOString();
        // life_payment_sources schema (schema.ts:396) has columns: id,
        // agent_id, kind, label, institution, account_mask, status,
        // last_synced_at, transaction_count, metadata_json. The "plaid"
        // provider identity goes inside metadata_json since there's no
        // top-level provider column.
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_payment_sources (
             id, agent_id, kind, label, institution, account_mask, status,
             last_synced_at, transaction_count, metadata_json, created_at, updated_at
           ) VALUES (
             ${sqlQuote("seed-plaid-chase")},
             ${sqlQuote(agentId)},
             'bank',
             'Chase Checking',
             'Chase',
             '0042',
             'needs_reauth',
             ${sqlQuote(nowIso)},
             0,
             ${sqlQuote(JSON.stringify({
               provider: "plaid",
               error_code: "ITEM_LOGIN_REQUIRED",
               error_type: "ITEM_ERROR",
               last_failure: nowIso,
               failure_message:
                 "MFA verification failed; the user must re-authenticate Chase via Plaid Link.",
               link_token_url:
                 "https://link.plaid.com/v2/sandbox/seed-token-needs-reauth",
             }))},
             ${sqlQuote(nowIso)},
             ${sqlQuote(nowIso)}
           )
           ON CONFLICT (id) DO UPDATE SET
             status = EXCLUDED.status,
             metadata_json = EXCLUDED.metadata_json,
             updated_at = EXCLUDED.updated_at`,
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-bank-status",
      room: "main",
      text: "What's the status of my linked bank accounts? I tried connecting Chase yesterday but I'm not sure if it worked.",
      expectedActions: ["PAYMENTS"],
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "PAYMENTS",
      minCount: 1,
    },
    {
      type: "custom",
      name: "agent-surfaces-mfa-failure-actionably",
      predicate: checkAgentSurfacesActionableError,
    },
    judgeRubric({
      name: "payments-plaid-mfa-fail-rubric",
      threshold: 0.7,
      description: `The user's Chase Plaid link is in a needs_reauth state because MFA failed. They asked about their linked bank accounts. A correct reply: tells the user the Chase link failed / needs re-auth / requires them to verify again, ideally referencing Chase explicitly. An incorrect reply: claims the bank is connected; reports balances/transactions as if the link worked; tells the user "everything looks good"; suggests waiting and retrying without user action. Score 0 if the agent claims success or reports balances as if the link is healthy.`,
    }),
  ],
});
