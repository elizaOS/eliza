/**
 * `ftu_goal_discovery` — post-turn evaluator that extracts the owner's
 * primary goal (what they value / want the assistant's help with) from the
 * conversation once first-run setup is complete.
 *
 * Runs inside the runtime's single merged, schema-constrained SMALL-model
 * evaluation call (`EvaluatorService`), so it adds no extra model round-trip
 * to the turn. `shouldRun` is the no-reprocessing gate: it is `false` the
 * moment the `FtuGoalStateStore` records a goal, so completed discovery never
 * re-evaluates the same conversation. The processor persists the goal as the
 * typed `primaryGoal` owner fact (with `agent_inferred` provenance) and flips
 * the lifecycle to `complete` only when extraction confidence clears
 * {@link FTU_GOAL_CONFIDENCE_THRESHOLD}.
 */

import { hasOwnerAccess } from "@elizaos/agent";
import type { Evaluator, JSONSchema } from "@elizaos/core";
import { createFirstRunStateStore } from "../first-run/state.js";
import { createOwnerFactStore } from "../owner/fact-store.js";
import { createFtuGoalStateStore } from "./state.js";

/**
 * Minimum extraction confidence required to persist the goal and close
 * discovery. Below this the turn contributes nothing and discovery stays
 * open — a half-guessed goal written as fact is worse than another turn of
 * conversation.
 */
export const FTU_GOAL_CONFIDENCE_THRESHOLD = 0.7;

const MAX_GOAL_LENGTH = 240;

export interface FtuGoalDiscoveryOutput {
  goalFound: boolean;
  goal: string;
  confidence: number;
}

const ftuGoalSchema: JSONSchema = {
  type: "object",
  properties: {
    goalFound: { type: "boolean" },
    goal: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["goalFound", "goal", "confidence"],
  additionalProperties: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseFtuGoalOutput(
  output: unknown,
): FtuGoalDiscoveryOutput | null {
  if (!isRecord(output)) return null;
  if (typeof output.goalFound !== "boolean") return null;
  const goal = typeof output.goal === "string" ? output.goal.trim() : "";
  const confidence =
    typeof output.confidence === "number" && Number.isFinite(output.confidence)
      ? Math.min(1, Math.max(0, output.confidence))
      : 0;
  return {
    goalFound: output.goalFound && goal.length > 0,
    goal: goal.slice(0, MAX_GOAL_LENGTH),
    confidence,
  };
}

export const ftuGoalDiscoveryEvaluator: Evaluator<FtuGoalDiscoveryOutput> = {
  name: "ftu_goal_discovery",
  description:
    "Extracts the owner's primary goal — what they value or want the assistant's help with — from the conversation after first-run setup completes.",
  priority: 140,
  schema: ftuGoalSchema,

  async shouldRun({ runtime, message }) {
    if (!message.content.text || message.entityId === runtime.agentId) {
      return false;
    }
    if (!(await hasOwnerAccess(runtime, message))) {
      return false;
    }
    const firstRun = await createFirstRunStateStore(runtime).read();
    if (firstRun.status !== "complete") {
      return false;
    }
    const ftuGoal = await createFtuGoalStateStore(runtime).read();
    return ftuGoal.status === "pending";
  },

  prompt() {
    return `Decide whether this turn reveals the owner's PRIMARY goal: the thing they mainly value or want the assistant's ongoing help with (e.g. "ship my startup's iOS app", "stay on top of email and family follow-ups", "train for a marathon").
Judge from the owner's latest message in the shared turn context, in light of the agent's response.
Rules:
- goalFound=true only when the owner expresses a durable want, priority, or area they need help with — in their own words, not the agent's suggestion.
- goal: one compact sentence (max ~30 words) restating that want. Empty string when goalFound=false.
- confidence: 0-1. Use >=${FTU_GOAL_CONFIDENCE_THRESHOLD} only when the owner stated it plainly; use lower values for hints or topic-of-the-moment chatter.
- One-off tasks ("remind me at 3pm"), pleasantries, and questions about the assistant itself are NOT goals => goalFound=false, goal="", confidence=0.`;
  },

  parse: parseFtuGoalOutput,

  processors: [
    {
      name: "persistDiscoveredGoal",
      async process({ runtime, message, output }) {
        if (
          !output.goalFound ||
          output.goal.length === 0 ||
          output.confidence < FTU_GOAL_CONFIDENCE_THRESHOLD
        ) {
          return undefined;
        }
        const stateStore = createFtuGoalStateStore(runtime);
        // Idempotence backstop: shouldRun already gates on `pending`, but a
        // concurrent turn may have completed discovery between the gate and
        // this processor. Never overwrite an already-discovered goal.
        const current = await stateStore.read();
        if (current.status === "complete") {
          return undefined;
        }

        const discoveredAt = new Date().toISOString();
        const sourceMessageId =
          typeof message.id === "string" && message.id.length > 0
            ? message.id
            : undefined;
        await createOwnerFactStore(runtime).update(
          { primaryGoal: output.goal },
          {
            source: "agent_inferred",
            recordedAt: discoveredAt,
            note: `ftu goal discovery from message:${sourceMessageId ?? "(unknown)"}`,
          },
        );
        await stateStore.complete({
          goal: output.goal,
          confidence: output.confidence,
          discoveredAt,
          ...(sourceMessageId ? { sourceMessageId } : {}),
        });
        return {
          success: true,
          values: {
            ftuGoalDiscovered: true,
            ftuGoalConfidence: output.confidence,
          },
        };
      },
    },
  ],
};
