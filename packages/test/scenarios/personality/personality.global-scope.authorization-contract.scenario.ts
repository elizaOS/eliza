/**
 * Proves that a non-owner cannot mutate the global personality slot. The
 * scenario uses distinct owner and regular-user identities, calls the real
 * promoted PERSONALITY action, and checks both denial state and durable stores.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

type PersonalitySlotView = {
  reply_gate?: string | null;
  verbosity?: string | null;
  tone?: string | null;
  formality?: string | null;
  custom_directives?: unknown[];
};

type RuntimeView = {
  getService(
    serviceType: string,
  ): { getSlot(userId: string): PersonalitySlotView } | null;
};

export default scenario({
  lane: "pr-deterministic",
  id: "personality.global-scope.authorization-contract",
  title: "Regular users cannot mutate global personality state",
  domain: "personality",
  tier: "T4",
  evidenceScope: "domain-contract",
  tags: ["personality", "authorization", "scope:global", "negative-proof"],
  description:
    "Invokes a global personality mutation as a non-owner and proves permission denial, no audit write, and an unchanged global slot.",
  scope: "mixed",
  isolation: "per-scenario",
  requires: { services: ["PERSONALITY_STORE"] },
  rooms: [
    {
      id: "owner",
      account: "personality-contract-owner",
      source: "dashboard",
      channelType: "DM",
      title: "Personality Owner",
    },
    {
      id: "regular-user",
      account: "personality-contract-regular-user",
      source: "dashboard",
      channelType: "DM",
      title: "Personality Regular User",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "regular-user-attempts-global-change",
      room: "regular-user",
      actionName: "PERSONALITY_SET_TRAIT",
      text: "Make every user's replies terse globally.",
      content: {
        metadata: { __responseContext: { primaryContext: "settings" } },
      },
      options: {
        parameters: {
          scope: "global",
          trait: "verbosity",
          value: "terse",
        },
      },
      expectedActions: ["PERSONALITY_SET_TRAIT"],
      assertTurn: (turn) => {
        const result = turn.responseBody as
          | { success?: boolean; values?: { error?: string } }
          | undefined;
        if (result?.success !== false) {
          return "non-owner global mutation did not fail closed";
        }
        return result.values?.error === "PERMISSION_DENIED"
          ? undefined
          : "non-owner global mutation lacked PERMISSION_DENIED";
      },
    },
  ],
  finalChecks: [
    {
      type: "memoryExists",
      table: "personality_audit_log",
      expected: false,
    },
    {
      type: "custom",
      name: "global personality slot remains empty",
      predicate: (ctx) => {
        const runtime = ctx.runtime as RuntimeView | undefined;
        const store = runtime?.getService("PERSONALITY_STORE");
        if (!store) return "PERSONALITY_STORE unavailable";
        const globalSlot = store.getSlot("global");
        const changed =
          globalSlot.reply_gate !== null ||
          globalSlot.verbosity !== null ||
          globalSlot.tone !== null ||
          globalSlot.formality !== null ||
          (globalSlot.custom_directives?.length ?? 0) > 0;
        return changed
          ? "denied non-owner request mutated global personality state"
          : undefined;
      },
    },
  ],
});
