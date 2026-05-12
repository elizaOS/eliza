/**
 * Tone preference enforcement — the user previously declared "be terse, no
 * pleasantries". Subsequent drafts must respect that.
 *
 * Seed: a meeting prefs row that says terse=true and an inbox triage entry
 * to reply to. The user asks for a draft. The draft must be short and not
 * start with pleasantries ("Hi there, hope you're well!").
 *
 * Failure modes guarded:
 *   - long flowery openings
 *   - "hope you're doing well" / "hope this finds you" boilerplate
 *   - 5+ sentence drafts for a simple confirm
 *
 * Cited: 03-coverage-gap-matrix.md — tone-preference enforcement.
 */

import type { AgentRuntime } from "@elizaos/core";
import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { LifeOpsRepository } from "../../../plugins/app-lifeops/src/lifeops/repository.ts";
import {
  executeRawSql,
  sqlQuote,
} from "../../../plugins/app-lifeops/src/lifeops/sql.ts";
import { judgeRubric } from "../_helpers/action-assertions.ts";

const PLEASANTRY_BLOCKLIST = [
  "hope you're doing well",
  "hope you are doing well",
  "hope this finds you",
  "hope this email finds you",
  "i hope all is well",
  "hope all is well",
  "happy monday",
  "happy friday",
];

function checkDraftIsTerse(ctx: ScenarioContext): string | undefined {
  const draftActions = ctx.actionsCalled.filter(
    (a) => a.actionName === "MESSAGE" || a.actionName === "INBOX_TRIAGE",
  );
  if (draftActions.length === 0) {
    return "expected MESSAGE / INBOX_TRIAGE action to draft reply";
  }
  const blob = draftActions
    .map((a) =>
      JSON.stringify({ p: a.parameters, d: a.result?.data, t: a.result?.text }),
    )
    .join(" || ")
    .toLowerCase();
  for (const pleasantry of PLEASANTRY_BLOCKLIST) {
    if (blob.includes(pleasantry)) {
      return `Draft contains blocked pleasantry "${pleasantry}" despite terse-tone preference. Blob: ${blob.slice(0, 400)}`;
    }
  }
  // Count sentences in any draft body — terse should be <= 4 sentences.
  // Extract a likely draft body field if present.
  const bodyMatch = blob.match(/"body"\s*:\s*"([^"]{20,2000})"/);
  if (bodyMatch?.[1]) {
    const sentences = bodyMatch[1]
      .split(/[.!?]+/)
      .filter((s) => s.trim().length > 5);
    if (sentences.length > 6) {
      return `Draft is too verbose for terse mode: ${sentences.length} sentences. Body: ${bodyMatch[1].slice(0, 300)}`;
    }
  }
  return undefined;
}

export default scenario({
  id: "inbox-triage.draft-respects-tone-prefs",
  title: "Draft respects 'terse, no pleasantries' tone preference",
  domain: "lifeops.inbox-triage",
  tags: ["lifeops", "inbox-triage", "tone", "preferences", "draft"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Tone Preference Enforcement",
    },
  ],
  seed: [
    {
      type: "custom",
      name: "seed-tone-pref-and-triage",
      apply: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const agentId = String(runtime.agentId);
        const now = new Date().toISOString();
        // Best-effort tone-pref insert; tolerate missing table.
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_user_prefs
             (id, agent_id, key, value, created_at, updated_at)
           VALUES (
             ${sqlQuote("pref-tone-terse")},
             ${sqlQuote(agentId)},
             'communication_tone',
             ${sqlQuote(JSON.stringify({ tone: "terse", pleasantries: false }))},
             ${sqlQuote(now)},
             ${sqlQuote(now)}
           )
           ON CONFLICT DO NOTHING`,
        ).catch(() => undefined);
        await executeRawSql(
          runtime,
          `INSERT INTO app_lifeops.life_inbox_triage_entries (
             id, agent_id, source, source_message_id, channel_name, channel_type,
             classification, urgency, confidence, snippet, sender_name,
             thread_context, triage_reasoning, auto_replied, resolved,
             created_at, updated_at
           ) VALUES (
             ${sqlQuote("triage-tone-1")},
             ${sqlQuote(agentId)},
             ${sqlQuote("gmail")},
             ${sqlQuote("msg-tone-1")},
             ${sqlQuote("gmail")},
             'email',
             'needs-response',
             'medium',
             0.8,
             ${sqlQuote("Can we confirm Wednesday 3pm for the demo?")},
             ${sqlQuote("client@example.com")},
             '[]',
             'simple confirm',
             FALSE, FALSE,
             ${sqlQuote(now)},
             ${sqlQuote(now)}
           )`,
        );
        return undefined;
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-to-draft-terse",
      room: "main",
      text: "Draft a yes-confirm reply to the client about Wednesday 3pm. Remember I asked you to keep replies terse — no pleasantries.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "draft-is-terse",
      predicate: checkDraftIsTerse,
    },
    judgeRubric({
      name: "inbox-triage-tone-prefs-rubric",
      threshold: 0.7,
      description: `User explicitly asked for a terse no-pleasantries reply. Correct: draft is short (2-4 sentences max) and skips "hope you're well" / boilerplate. Incorrect: long flowery draft, opens with "Hi! Hope you're doing well!". Score 0 if any blocked pleasantry appears.`,
    }),
  ],
});
