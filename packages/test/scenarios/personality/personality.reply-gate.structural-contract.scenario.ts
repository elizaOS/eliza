/**
 * Proves the deterministic PERSONALITY reply-gate contract against the real
 * advanced-capabilities action, store, message ingress gate, and audit table.
 * The live personality corpus separately evaluates natural-language routing;
 * this scenario isolates the safety-critical state transition from model taste.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

type PersonalitySlotView = {
  reply_gate?: string | null;
  verbosity?: string | null;
  tone?: string | null;
  formality?: string | null;
  custom_directives?: unknown[];
};

type PersonalityStoreView = {
  getSlot(userId: string): PersonalitySlotView;
};

type RuntimeView = {
  getService(serviceType: string): unknown;
};

function actionAfterReplyGate(
  result: unknown,
  expected: string,
): string | undefined {
  const data =
    result && typeof result === "object"
      ? (result as { data?: { after?: PersonalitySlotView } }).data
      : undefined;
  return data?.after?.reply_gate === expected
    ? undefined
    : `expected action result after.reply_gate=${expected}`;
}

export default scenario({
  lane: "pr-deterministic",
  id: "personality.reply-gate.structural-contract",
  title: "Personality reply gate persists, suppresses, audits, and lifts",
  domain: "personality",
  tier: "T4",
  evidenceScope: "domain-contract",
  tags: [
    "personality",
    "structural-proof",
    "reply-gate",
    "audit",
    "scope:user",
  ],
  description:
    "Directly sets a user-scoped never-until-lift gate, proves ingress silence, lifts it, and verifies durable audit plus absence of global mutation.",
  scope: "user",
  isolation: "per-scenario",
  requires: { services: ["PERSONALITY_STORE"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Personality Structural Contract",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "set-user-silence",
      room: "main",
      actionName: "PERSONALITY_SET_REPLY_GATE",
      text: "Stay silent until I tell you to talk again.",
      content: {
        metadata: { __responseContext: { primaryContext: "settings" } },
      },
      options: {
        parameters: {
          scope: "user",
          mode: "never_until_lift",
        },
      },
      expectedActions: ["PERSONALITY_SET_REPLY_GATE"],
      assertTurn: (turn) =>
        actionAfterReplyGate(turn.responseBody, "never_until_lift"),
    },
    {
      kind: "message",
      name: "suppressed-unrelated-message",
      room: "main",
      text: "What is the capital of Mongolia?",
      forbiddenActions: ["REPLY"],
      assertResponse: (text: string) =>
        text.trim().length === 0
          ? undefined
          : `reply gate leaked response: ${JSON.stringify(text)}`,
    },
    {
      kind: "action",
      name: "lift-user-silence",
      room: "main",
      actionName: "PERSONALITY_LIFT_REPLY_GATE",
      text: "Okay, you can talk again.",
      content: {
        metadata: { __responseContext: { primaryContext: "settings" } },
      },
      options: { parameters: { scope: "user" } },
      expectedActions: ["PERSONALITY_LIFT_REPLY_GATE"],
      assertTurn: (turn) => actionAfterReplyGate(turn.responseBody, "always"),
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "PERSONALITY_SET_REPLY_GATE",
      status: "success",
    },
    {
      type: "actionCalled",
      actionName: "PERSONALITY_LIFT_REPLY_GATE",
      status: "success",
    },
    {
      type: "memoryExists",
      table: "personality_audit_log",
      content: { text: "personality_change set_reply_gate scope=user" },
    },
    {
      type: "memoryExists",
      table: "personality_audit_log",
      content: { text: "personality_change lift_reply_gate scope=user" },
    },
    {
      type: "custom",
      name: "user slot lifted without global mutation",
      predicate: (ctx) => {
        const runtime = ctx.runtime as RuntimeView | undefined;
        const store = runtime?.getService(
          "PERSONALITY_STORE",
        ) as PersonalityStoreView | null;
        if (!store) return "PERSONALITY_STORE unavailable";

        const userId = ctx.primaryUserId;
        if (!userId) return "scenario primary user was not exposed";
        const userSlot = store.getSlot(userId);
        if (userSlot.reply_gate !== "always") {
          return `expected lifted user reply_gate=always, saw ${String(userSlot.reply_gate)}`;
        }

        const globalSlot = store.getSlot("global");
        const globalWasMutated =
          globalSlot.reply_gate !== null ||
          globalSlot.verbosity !== null ||
          globalSlot.tone !== null ||
          globalSlot.formality !== null ||
          (globalSlot.custom_directives?.length ?? 0) > 0;
        return globalWasMutated
          ? "user-scoped reply-gate flow mutated the global personality slot"
          : undefined;
      },
    },
  ],
});
