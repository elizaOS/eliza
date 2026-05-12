/**
 * OAuth token expired mid-fetch — Gmail connector returns 401. Agent must
 * surface "re-authenticate" prompt, NOT silently fall back to claiming a
 * clean inbox.
 *
 * Failure modes guarded:
 *   - silent fallback to empty inbox on auth failure
 *   - retry loop without telling the user
 *   - vague generic "something went wrong"
 *
 * Cited: 03-coverage-gap-matrix.md — token expiry handling.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

function checkAgentSurfacesAuthFailure(
  ctx: ScenarioContext,
): string | undefined {
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  if (reply.length === 0) {
    return "no reply on 401 — unhandled token-expiry path";
  }
  const authSignals = [
    "re-authenticate",
    "reauthenticate",
    "reconnect",
    "sign in",
    "sign-in",
    "log in",
    "auth",
    "token",
    "expired",
    "401",
    "unauthorized",
    "credentials",
    "permission",
  ];
  const cleanLies = [
    "all clear",
    "you're caught up",
    "no unread",
    "inbox is empty",
  ];
  const sawAuth = authSignals.some((s) => reply.includes(s));
  const sawClean = cleanLies.some((s) => reply.includes(s));
  if (sawClean && !sawAuth) {
    return `Agent claimed inbox is clean on a 401 / token expiry. Reply: ${reply.slice(0, 400)}`;
  }
  if (!sawAuth) {
    return `Agent did not surface auth failure. Reply: ${reply.slice(0, 400)}`;
  }
  return undefined;
}

export default scenario({
  id: "inbox-triage.token-expiry-mid-fetch",
  title: "Gmail OAuth 401 mid-fetch surfaces re-authentication prompt",
  domain: "lifeops.inbox-triage",
  tags: [
    "lifeops",
    "inbox-triage",
    "auth",
    "oauth",
    "negative-path",
    "robustness",
  ],
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
      title: "Gmail Token Expiry",
    },
  ],
  seed: [
    {
      type: "gmailInbox",
      account: "test-owner",
      fixture: "default",
      faultInjection: { mode: "auth_expired", method: "GET" },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "ask-to-triage-with-expired-token",
      room: "main",
      text: "Triage my Gmail inbox.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "auth-failure-surfaced",
      predicate: checkAgentSurfacesAuthFailure,
    },
    {
      type: "gmailMessageSent",
      expected: false,
    },
    judgeRubric({
      name: "inbox-triage-token-expiry-rubric",
      threshold: 0.7,
      description: `Gmail returns 401 (token expired). Correct: agent surfaces the auth failure and prompts re-authentication or reconnection. Incorrect: claims a clean inbox, or retries silently without telling the user. Score 0 if the agent claims a clean inbox.`,
    }),
  ],
});
