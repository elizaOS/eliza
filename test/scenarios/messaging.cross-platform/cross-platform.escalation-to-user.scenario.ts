import type { AgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-schema";
import { receivePendingIntents } from "../../../plugins/app-lifeops/src/lifeops/intent-sync.ts";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "cross-platform.escalation-to-user",
  title: "Signature-required request escalates back to the owner",
  domain: "messaging.cross-platform",
  tags: ["cross-platform", "gateway", "negotiation", "intent-bus"],
  description:
    "A request that requires the owner's direct negotiation or signature should route through the real cross-platform gateway and create an owner-action intent instead of falling back to inbox/calendar actions.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-Platform Escalation",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "unresolvable request",
      room: "main",
      text: "Negotiate my apartment lease renewal with the landlord and sign it for me.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "cross-platform owner escalation",
        includesAny: ["escalate_to_user", "owner action", "lease"],
      }),
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "MESSAGE",
    },
    {
      type: "custom",
      name: "cross-platform-escalation-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["MESSAGE"],
        description: "cross-platform owner escalation",
        includesAny: ["escalate_to_user", "owner action", "lease"],
      }),
    },
    {
      type: "custom",
      name: "cross-platform-escalation-persists-intent",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) {
          return "scenario runtime unavailable";
        }
        const hit = ctx.actionsCalled.find(
          (entry) => entry.actionName === "MESSAGE",
        );
        const data =
          hit?.result?.data && typeof hit.result.data === "object"
            ? (hit.result.data as {
                intentId?: string;
                kind?: string;
                title?: string;
                body?: string;
              })
            : null;
        if (!data?.intentId) {
          return "expected CROSS_PLATFORM_GATEWAY to return an intentId";
        }
        if (data.kind !== "user_action_requested") {
          return `expected user_action_requested intent, got ${data.kind ?? "(missing)"}`;
        }
        const intents = await receivePendingIntents(runtime, {
          device: "desktop",
          deviceId: "scenario-desktop",
          limit: 20,
        });
        const intent = intents.find((entry) => entry.id === data.intentId);
        if (!intent) {
          return `expected pending owner-action intent ${data.intentId}`;
        }
        if (!/lease/i.test(`${intent.title} ${intent.body}`)) {
          return "expected persisted intent to reference the lease-renewal request";
        }
        return undefined;
      },
    },
  ],
});
