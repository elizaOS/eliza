import type { IAgentRuntime } from "@elizaos/core";
import {
  logger,
  ModelType,
  runWithTrajectoryContext,
} from "@elizaos/core";
import { parseJsonModelRecord } from "../utils/json-model-output.js";
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
  const parsedValue =
    typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : value;
  if (typeof parsedValue !== "number" || !Number.isFinite(parsedValue)) {
    return null;
  }
  return Math.max(0, Math.min(1, parsedValue));
}

function normalizeStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/\n|,/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
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

function formatPromptValue(value: unknown, depth = 0): string {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);
  if (value === null) return "null";
  if (value === undefined) return "";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "(none)";
    return value
      .map((entry) => `${childIndent}- ${formatPromptValue(entry, depth + 1)}`)
      .join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "(empty)";
    return entries
      .map(([key, entry]) => {
        const formatted = formatPromptValue(entry, depth + 1);
        return formatted.includes("\n")
          ? `${indent}${key}:\n${formatted}`
          : `${indent}${key}: ${formatted}`;
      })
      .join("\n");
  }
  return String(value);
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
    "Return ONLY a JSON object with these fields:",
    "reviewState: one of idle, needs_attention, on_track, at_risk",
    "- progressScore: number from 0 to 1 or null if not enough evidence",
    "- confidence: number from 0 to 1",
    "- explanation: short grounded explanation",
    "- evidenceSummary: short summary of the strongest evidence used",
    "- missingEvidence: array of short evidence gaps",
    "- suggestions: up to 3 objects with kind, title, and detail. kind must be one of create_support, focus_now, resolve_overdue, review_progress, tighten_cadence",
    "",
    'Example: {"reviewState":"needs_attention","progressScore":0.4,"confidence":0.65,"explanation":"Some supporting evidence exists, but the outcome evidence is thin.","evidenceSummary":"One recent support task was completed.","missingEvidence":["Direct outcome measurement"],"suggestions":[{"kind":"review_progress","title":"Review goal evidence","detail":"Ask for the latest measurement before changing status."}]}',
    "",
    "Guidance:",
    "- Use on_track only when the available evidence supports progress.",
    "- Use at_risk when the evidence suggests drift, missed targets, or contradictory outcomes.",
    "- Use needs_attention when the goal is grounded but the evidence is insufficient or the support structure is weak.",
    "- Use idle only when the goal is brand new and there is genuinely nothing to judge yet.",
    "",
    `Now: ${args.nowIso}`,
    "Goal:",
    formatPromptValue(args.goal),
    "Evidence:",
    formatPromptValue(args.evidence),
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
    "Return ONLY JSON with exactly these fields:",
    "reviewState, progressScore, confidence, explanation, evidenceSummary, missingEvidence, suggestions",
    "",
    "reviewState must be one of idle, needs_attention, on_track, at_risk.",
    "Use a missingEvidence array for evidence gaps.",
    "Use a suggestions array of {kind,title,detail} objects.",
    "",
    `Now: ${args.nowIso}`,
    "Goal:",
    formatPromptValue(args.goal),
    "Evidence:",
    formatPromptValue(args.evidence),
    "Previous invalid output:",
    args.rawResponse,
  ].join("\n");
}

function parseSemanticEvaluationOutput(
  raw: string,
): Record<string, unknown> | null {
  return parseJsonModelRecord<Record<string, unknown>>(raw);
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
    const raw = await runWithTrajectoryContext(
      { purpose: "lifeops-goal-evaluator-first-pass" },
      () => args.runtime.useModel(ModelType.TEXT_LARGE, { prompt }),
    );
    const parsed = parseSemanticEvaluationOutput(
      typeof raw === "string" ? raw : "",
    );
    const evaluation = parsed
      ? buildSemanticEvaluationResult(parsed, args.nowIso)
      : null;
    if (evaluation) {
      return evaluation;
    }
    const repairedRaw = await runWithTrajectoryContext(
      { purpose: "lifeops-goal-evaluator-repair-pass" },
      () =>
        args.runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: buildSemanticRepairPrompt({
            evidence: args.evidence,
            goal: args.goal,
            nowIso: args.nowIso,
            rawResponse: typeof raw === "string" ? raw : "",
          }),
        }),
    );
    const repairedParsed = parseSemanticEvaluationOutput(
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
