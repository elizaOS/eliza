/**
 * Parameter-extraction test: a long, meandering utterance containing a
 * contact name, a specific date-time, and a subject. The agent must
 * extract "Alex" as the target and a date-time near next Tuesday noon.
 *
 * Accepts any of SCHEDULE_FOLLOW_UP / CREATE_TASK / LIFE — the important
 * part is that the captured parameters contain the extracted entities.
 */

import type { CapturedAction } from "@elizaos/scenario-schema";
import { scenario } from "@elizaos/scenario-schema";

const ACCEPTED_ACTIONS = [
  "SCHEDULE_FOLLOW_UP",
  "CREATE_TASK",
  "LIFE",
  // LifeOps' RELATIONSHIP action handles contact-scoped follow-up scheduling
  // when the utterance mentions a specific person + a follow-up time.
  "RELATIONSHIP",
];

function extractParamText(action: CapturedAction): string {
  const parts: string[] = [];
  if (action.parameters) {
    parts.push(JSON.stringify(action.parameters));
  }
  if (action.result?.data) {
    parts.push(JSON.stringify(action.result.data));
  }
  if (action.result?.values) {
    parts.push(JSON.stringify(action.result.values));
  }
  if (action.result?.text) {
    parts.push(action.result.text);
  }
  return parts.join(" | ");
}

export default scenario({
  id: "cross.parameter-extraction.complex-natural-language",
  title: "Extracts contact and date-time from a long utterance",
  domain: "cross-cutting",
  tags: ["cross-cutting", "parameter-extraction", "critical"],
  description:
    "Long meandering follow-up request. The agent must route to a reminder/follow-up action and its captured parameters must contain 'Alex' and a date-time near next Tuesday noon.",

  isolation: "per-scenario",

  seed: [
    {
      type: "custom",
      name: "seed-alex-rodriguez-contact",
      apply: async (ctx) => {
        const runtime = ctx.runtime as {
          agentId: string;
          createEntity: (entity: {
            id: string;
            agentId: string;
            names: string[];
            metadata: Record<string, unknown>;
          }) => Promise<unknown>;
          getService: (name: string) => unknown;
        };
        // Deterministic UUID for the seeded contact.
        const entityId = "11111111-aaaa-4aaa-8aaa-111111111111";
        await runtime.createEntity({
          id: entityId,
          agentId: runtime.agentId,
          names: ["Alex Rodriguez", "Alex"],
          metadata: { source: "scenario-seed" },
        });
        const svc = runtime.getService("relationships") as {
          addContact: (
            entityId: string,
            categories?: string[],
          ) => Promise<unknown>;
        } | null;
        if (!svc || typeof svc.addContact !== "function") {
          return "relationships service unavailable — cannot seed contact";
        }
        await svc.addContact(entityId, ["colleague"]);
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-cutting: param extraction",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "long-utterance",
      room: "main",
      text: "Hey so I've been meaning to follow up with Alex Rodriguez from the consulting firm we talked to in January — can you remind me to email them next Tuesday at noon about the pricing proposal?",
      assertTurn: (turn) => {
        const hit = turn.actionsCalled.find((a) =>
          ACCEPTED_ACTIONS.includes(a.actionName),
        );
        if (!hit) {
          const fired =
            turn.actionsCalled.map((a) => a.actionName).join(", ") || "(none)";
          return `Expected one of [${ACCEPTED_ACTIONS.join(", ")}] but got: ${fired}`;
        }
        const blob = extractParamText(hit);
        if (!/alex/i.test(blob)) {
          return `Captured action params did not contain 'Alex'. Params: ${blob}`;
        }
        const nextTuesdayNoonRe =
          /(tue|tuesday|12:00|12pm|noon|1[2]:00|t1[2]:)/i;
        if (!nextTuesdayNoonRe.test(blob)) {
          return `Captured action params did not mention next-Tuesday-noon signal. Params: ${blob}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "followup-action-with-extracted-params",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find((a) =>
          ACCEPTED_ACTIONS.includes(a.actionName),
        );
        if (!hit) {
          return `No follow-up action fired. Accepted: ${ACCEPTED_ACTIONS.join(", ")}`;
        }
      },
    },
  ],
});
