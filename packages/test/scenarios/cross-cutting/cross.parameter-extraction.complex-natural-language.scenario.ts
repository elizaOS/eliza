/**
 * Parameter-extraction test: a long, meandering utterance containing a
 * contact name, a specific date-time, and a subject. The agent must
 * extract "Alex" as the target and normalize next Tuesday noon against the
 * explicit reference clock and IANA timezone supplied in the request.
 *
 * CONTACT is the canonical contact-scoped follow-up boundary; accepting a
 * generic task/reminder action here would hide an incorrect route.
 */

import type { CapturedAction } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

const EXPECTED_ACTION = "CONTACT";

const REFERENCE_CLOCK = "2026-08-18T09:00:00-07:00";
const REFERENCE_TIMEZONE = "America/Los_Angeles";
const EXPECTED_INSTANT = "2026-08-25T19:00:00.000Z";

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

function collectTemporalValues(
  value: unknown,
  values: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectTemporalValues(item, values);
    return values;
  }
  if (!value || typeof value !== "object") return values;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof item === "string" &&
      ["scheduledAt", "dueAt", "atIso", "startAt"].includes(key)
    ) {
      values.push(item);
    } else {
      collectTemporalValues(item, values);
    }
  }
  return values;
}

function isExpectedInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === EXPECTED_INSTANT
  );
}

export default scenario({
  lane: "live-only",
  id: "cross.parameter-extraction.complex-natural-language",
  title: "Extracts contact and date-time from a long utterance",
  domain: "cross-cutting",
  evidenceScope: "domain-contract",
  tags: ["cross-cutting", "parameter-extraction", "critical"],
  description:
    "Long meandering follow-up request with a fixed reference clock. The agent must route to a reminder/follow-up action and structurally normalize next Tuesday noon in America/Los_Angeles to the exact UTC instant.",

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
      text: `Reference clock: ${REFERENCE_CLOCK}; timezone: ${REFERENCE_TIMEZONE}. Hey so I've been meaning to follow up with Alex Rodriguez from the consulting firm we talked to in January — can you remind me to email them next Tuesday at noon about the pricing proposal?`,
      assertTurn: (turn) => {
        const hit = turn.actionsCalled.find(
          (action) => action.actionName === EXPECTED_ACTION,
        );
        if (!hit) {
          const fired =
            turn.actionsCalled.map((a) => a.actionName).join(", ") || "(none)";
          return `Expected ${EXPECTED_ACTION} but got: ${fired}`;
        }
        const blob = extractParamText(hit);
        if (!/alex/i.test(blob)) {
          return `Captured action params did not contain 'Alex'. Params: ${blob}`;
        }
        const data =
          hit.result?.data && typeof hit.result.data === "object"
            ? (hit.result.data as Record<string, unknown>)
            : null;
        if (hit.result?.success !== true || data?.op !== "followup") {
          return `Expected a successful CONTACT followup result, saw ${JSON.stringify(hit.result)}`;
        }
        if (data.contactName !== "Alex Rodriguez") {
          return `Expected exact resolved contact Alex Rodriguez, saw ${JSON.stringify(data.contactName)}`;
        }
        const temporalValues = collectTemporalValues({
          parameters: hit.parameters,
          data: hit.result?.data,
          values: hit.result?.values,
        });
        if (!temporalValues.some(isExpectedInstant)) {
          return `Expected a structural scheduled instant normalizing to ${EXPECTED_INSTANT} (next Tuesday noon in ${REFERENCE_TIMEZONE} from ${REFERENCE_CLOCK}); saw ${JSON.stringify(temporalValues)}. Params: ${blob}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "followup-action-with-extracted-params",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === EXPECTED_ACTION,
        );
        if (!hit) {
          return `No canonical ${EXPECTED_ACTION} follow-up action fired.`;
        }
      },
    },
  ],
});
