/**
 * `anticipation_feedback` — post-turn evaluator that classifies how the owner
 * received the agent's most recent proactive (anticipatory) message:
 * `accepted`, `rejected`, or `ignored`.
 *
 * Detection keys off the proactive-dispatch markers the scheduler writes when
 * a proactive task fires (see `./store.ts` for why the pending-prompts store
 * cannot serve that role). Runs inside the runtime's single merged
 * SMALL-model evaluation call, so it costs no extra round-trip. Idempotence
 * is structural: the processor removes every marker it classifies, and
 * `shouldRun` is false when no unprocessed marker exists — the same owner
 * turn is never classified twice. When several markers are pending, the
 * newest one is model-classified against the owner's reply and the older,
 * never-engaged ones are deterministically counted as `ignored`.
 */

import { hasOwnerAccess } from "@elizaos/agent";
import type { Evaluator, JSONSchema } from "@elizaos/core";
import {
  type AnticipationOutcome,
  listUnprocessedDispatches,
  type ProactiveDispatchMarker,
  recordAnticipationFeedback,
} from "./store.js";

export interface AnticipationFeedbackOutput {
  outcome: AnticipationOutcome;
}

export interface AnticipationFeedbackPrepared {
  markers: ProactiveDispatchMarker[];
}

const anticipationSchema: JSONSchema = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["accepted", "rejected", "ignored"],
    },
  },
  required: ["outcome"],
  additionalProperties: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseAnticipationFeedbackOutput(
  output: unknown,
): AnticipationFeedbackOutput | null {
  if (!isRecord(output)) return null;
  const outcome = output.outcome;
  if (
    outcome !== "accepted" &&
    outcome !== "rejected" &&
    outcome !== "ignored"
  ) {
    return null;
  }
  return { outcome };
}

export const anticipationFeedbackEvaluator: Evaluator<
  AnticipationFeedbackOutput,
  AnticipationFeedbackPrepared
> = {
  name: "anticipation_feedback",
  description:
    "Classifies whether the owner accepted, rejected, or ignored the agent's most recent proactive message.",
  priority: 150,
  schema: anticipationSchema,

  async shouldRun({ runtime, message }) {
    if (!message.content.text || message.entityId === runtime.agentId) {
      return false;
    }
    if (!(await hasOwnerAccess(runtime, message))) {
      return false;
    }
    const markers = await listUnprocessedDispatches(runtime, message.roomId);
    return markers.length > 0;
  },

  async prepare({ runtime, message }) {
    return {
      markers: await listUnprocessedDispatches(runtime, message.roomId),
    };
  },

  prompt({ prepared }) {
    const latest = prepared.markers[prepared.markers.length - 1];
    return `The agent proactively messaged the owner (without being asked). Classify the owner's reply in the shared turn context as a reaction to that proactive message.

Proactive message the agent sent:
${latest?.snippet || "(content unavailable)"}

Rules:
- accepted: the owner engages positively — answers the question, acts on the nudge, thanks the agent, or asks to continue.
- rejected: the owner pushes back — asks the agent to stop, calls it unwanted/annoying, or explicitly declines the suggestion.
- ignored: the owner's reply does not engage with the proactive message at all (talks about something unrelated).`;
  },

  parse: parseAnticipationFeedbackOutput,

  processors: [
    {
      name: "recordAnticipationOutcome",
      async process({ runtime, message, prepared, output }) {
        if (prepared.markers.length === 0) {
          return undefined;
        }
        const latest = prepared.markers[prepared.markers.length - 1];
        if (!latest) return undefined;
        // The owner's reply is read as feedback on the NEWEST proactive
        // message; older unaddressed dispatches were demonstrably ignored —
        // count them deterministically without burning model output on them.
        const entries: Array<{
          marker: ProactiveDispatchMarker;
          outcome: AnticipationOutcome;
        }> = prepared.markers
          .slice(0, -1)
          .map((marker) => ({ marker, outcome: "ignored" as const }));
        entries.push({ marker: latest, outcome: output.outcome });
        const stats = await recordAnticipationFeedback(
          runtime,
          message.roomId,
          entries,
        );
        return {
          success: true,
          values: {
            anticipationOutcome: output.outcome,
            anticipationAccepted: stats.accepted,
            anticipationRejected: stats.rejected,
            anticipationIgnored: stats.ignored,
          },
        };
      },
    },
  ],
};
