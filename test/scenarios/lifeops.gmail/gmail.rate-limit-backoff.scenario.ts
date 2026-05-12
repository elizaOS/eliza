/**
 * Gmail returns 429 — agent must back off and either retry-with-delay or
 * surface the rate-limit failure to the user. Must NOT claim success.
 *
 * Failure modes guarded:
 *   - claiming success on 429
 *   - immediate retry loop with no backoff
 *
 * Cited: 03-coverage-gap-matrix.md — rate-limit backoff.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

function checkBackoffSurfaced(ctx: ScenarioContext): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) return "empty reply on rate-limit";
  const rateSignals = [
    "rate limit",
    "rate-limit",
    "429",
    "too many",
    "throttled",
    "back off",
    "backoff",
    "try again",
    "slow down",
    "quota",
    "wait a moment",
    "later",
  ];
  if (!rateSignals.some((s) => reply.includes(s))) {
    return `Agent did not surface rate-limit / backoff signal. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "gmail.rate-limit-backoff",
  title: "Gmail 429 surfaces rate-limit / backoff and does not claim success",
  domain: "lifeops.gmail",
  tags: ["lifeops", "gmail", "rate-limit", "backoff", "negative-path"],
  isolation: "per-scenario",
  requires: {
    credentials: ["gmail:test-owner"],
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Gmail Rate Limit",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "default",
      faultInjection: { mode: "rate_limit", method: "GET" },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "trigger-rate-limit",
      room: "main",
      text: "Triage my whole Gmail inbox right now.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "rate-limit-surfaced",
      predicate: checkBackoffSurfaced,
    },
    {
      type: "gmailMessageSent",
      expected: false,
    },
    judgeRubric({
      name: "gmail-rate-limit-rubric",
      threshold: 0.7,
      description:
        "Agent surfaced 429/rate-limit to the user instead of claiming success or looping silently.",
    }),
  ],
});
