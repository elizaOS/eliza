import type { IAgentRuntime } from "@elizaos/core";
import { ModelType, logger, parseJSONObjectFromText } from "@elizaos/core";
import type {
  LifeOpsGoalDefinition,
  LifeOpsGoalReviewState,
  LifeOpsGoalSuggestionKind,
} from "../contracts/index.js";
import {
  buildGoalSemanticReviewMetadata,
  type GoalSemanticReviewMetadata,
  type GoalSemanticSuggestionMetadata,
} from "./goal-grounding.js";

const VALID_REVIEW_STATES = new Set<LifeOpsGoalReviewState>([
  "idle",
  "needs_attention",
  "on_track",
  "at_risk",
]);
const VALID_SUGGESTION_KINDS = new Set<LifeOpsGoalSuggestionKind>([
  "create_support",
  "focus_now",
  "resolve_overdue",
  "review_progress",
  "tighten_cadence",
]);

export interface GoalSemanticEvaluationResult
  extends GoalSemanticReviewMetadata {}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeSuggestions(
  value: unknown,
): GoalSemanticSuggestionMetadata[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const title = normalizeText(record.title);
      const detail = normalizeText(record.detail);
      if (!title || !detail) {
        return null;
      }
      const kind = normalizeText(record.kind);
      return {
        kind:
          kind && VALID_SUGGESTION_KINDS.has(kind as LifeOpsGoalSuggestionKind)
            ? kind
            : null,
        title,
        detail,
      };
    })
    .filter((entry): entry is GoalSemanticSuggestionMetadata => entry !== null);
}

function buildSemanticEvaluationPrompt(args: {
  evidence: Record<string, unknown>;
  goal: LifeOpsGoalDefinition;
  nowIso: string;
}): string {
  return [
    "Evaluate the user's goal semantically using the grounded goal contract and the evidence.",
    "Do not rely only on linked support tasks. If the goal has direct evidence such as sleep data, use it.",
    "Do not bluff. If the evidence is too weak, say so clearly and lower confidence.",
    "",
    "Return ONLY valid JSON with these fields:",
    '- reviewState: one of "idle", "needs_attention", "on_track", "at_risk"',
    "- progressScore: number from 0 to 1 or null if not enough evidence",
    "- confidence: number from 0 to 1",
    "- explanation: short grounded explanation",
    "- evidenceSummary: short summary of the strongest evidence used",
    "- missingEvidence: array of short evidence gaps",
    '- suggestions: array of up to 3 objects with fields kind, title, detail; kind must be one of "create_support", "focus_now", "resolve_overdue", "review_progress", "tighten_cadence"',
    "",
    "Guidance:",
    "- Use on_track only when the available evidence supports progress.",
    "- Use at_risk when the evidence suggests drift, missed targets, or contradictory outcomes.",
    "- Use needs_attention when the goal is grounded but the evidence is insufficient or the support structure is weak.",
    "- Use idle only when the goal is brand new and there is genuinely nothing to judge yet.",
    "",
    `Now: ${JSON.stringify(args.nowIso)}`,
    `Goal: ${JSON.stringify(args.goal)}`,
    `Evidence: ${JSON.stringify(args.evidence)}`,
  ].join("\n");
}

function buildSemanticRepairPrompt(args: {
  evidence: Record<string, unknown>;
  goal: LifeOpsGoalDefinition;
  nowIso: string;
  rawResponse: string;
}): string {
  return [
    "Your last reply for the goal semantic evaluator was invalid.",
    "Return ONLY valid JSON with exactly these fields:",
    "reviewState, progressScore, confidence, explanation, evidenceSummary, missingEvidence, suggestions",
    "",
    'reviewState must be one of "idle", "needs_attention", "on_track", "at_risk".',
    "suggestions must be an array of objects with kind, title, detail.",
    "",
    `Now: ${JSON.stringify(args.nowIso)}`,
    `Goal: ${JSON.stringify(args.goal)}`,
    `Evidence: ${JSON.stringify(args.evidence)}`,
    `Previous invalid output: ${JSON.stringify(args.rawResponse)}`,
  ].join("\n");
}

function buildSemanticEvaluationResult(
  parsed: Record<string, unknown>,
  nowIso: string,
): GoalSemanticEvaluationResult | null {
  const reviewState = normalizeText(parsed.reviewState);
  const explanation = normalizeText(parsed.explanation);
  if (
    !reviewState ||
    !VALID_REVIEW_STATES.has(reviewState as LifeOpsGoalReviewState) ||
    !explanation
  ) {
    return null;
  }
  return buildGoalSemanticReviewMetadata({
    confidence: normalizeFiniteNumber(parsed.confidence),
    evidenceSummary: normalizeText(parsed.evidenceSummary),
    explanation,
    missingEvidence: normalizeStringArray(parsed.missingEvidence),
    progressScore: normalizeFiniteNumber(parsed.progressScore),
    reviewState: reviewState as LifeOpsGoalReviewState,
    reviewedAt: nowIso,
    suggestions: normalizeSuggestions(parsed.suggestions),
  });
}

export async function evaluateGoalProgressWithLlm(args: {
  runtime: IAgentRuntime;
  evidence: Record<string, unknown>;
  goal: LifeOpsGoalDefinition;
  nowIso: string;
}): Promise<GoalSemanticEvaluationResult | null> {
  if (typeof args.runtime.useModel !== "function") {
    return null;
  }
  const prompt = buildSemanticEvaluationPrompt(args);
  try {
    const raw = await args.runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    const parsed = parseJSONObjectFromText(typeof raw === "string" ? raw : "");
    const evaluation = parsed
      ? buildSemanticEvaluationResult(parsed, args.nowIso)
      : null;
    if (evaluation) {
      return evaluation;
    }
    const repairedRaw = await args.runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: buildSemanticRepairPrompt({
        evidence: args.evidence,
        goal: args.goal,
        nowIso: args.nowIso,
        rawResponse: typeof raw === "string" ? raw : "",
      }),
    });
    const repairedParsed = parseJSONObjectFromText(
      typeof repairedRaw === "string" ? repairedRaw : "",
    );
    return repairedParsed
      ? buildSemanticEvaluationResult(repairedParsed, args.nowIso)
      : null;
  } catch (error) {
    logger.warn(
      {
        boundary: "lifeops",
        component: "goal-semantic-evaluator",
        goalId: args.goal?.id ?? null,
        detail: error instanceof Error ? error.message : String(error),
      },
      "[goal-semantic-evaluator] evaluation failed; returning null",
    );
    return null;
  }
}
