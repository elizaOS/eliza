/**
 * Event Triage — classifies coordinator events as "routine" or "creative"
 * to route them to the fast small-LLM path or the full Eliza pipeline.
 *
 * Tier 1 (auto-response rules at PTY worker) already handled before we get here.
 * This module splits the remaining events into:
 * - "routine": simple approvals, permissions, config prompts → small LLM (~1-2s)
 * - "creative": error recovery, design questions, task evaluation → Eliza (~5-10s)
 *
 * Pure functions — no side effects, same pattern as stall-classifier.ts.
 *
 * @module services/swarm-event-triage
 */

import {
  parseToonKeyValue,
  type IAgentRuntime,
  ModelType,
} from "@elizaos/core";
import { withTrajectoryContext } from "./trajectory-context.js";

// ─── Types ───

export type TriageTier = "routine" | "creative";

export interface TriageContext {
  /** "blocked" or "turn_complete" */
  eventType: "blocked" | "turn_complete";
  /** The blocking prompt text (empty for turn completions). */
  promptText: string;
  /** Adapter's promptInfo.type if available. */
  promptType?: string;
  /** Recent terminal output (for turn completions). */
  recentOutput?: string;
  /** The original task description. */
  originalTask: string;
}

// ─── Heuristic Sets ───

/** Prompt types from coding-agent-adapters that are always routine. */
const ROUTINE_PROMPT_TYPES = new Set([
  "permission",
  "config",
  "tos",
  "tool_wait",
]);

/** Prompt types that always need creative/contextual handling. */
const CREATIVE_PROMPT_TYPES = new Set(["project_select", "model_select"]);

/** Regex patterns that indicate routine approval prompts. */
const ROUTINE_PATTERNS: RegExp[] = [
  /\bAllow\s+tool\b/i,
  /\(Y\/n\)/,
  /\(y\/N\)/,
  /\bTrust\s+(this\s+)?directory\b/i,
  /\bProceed\?/i,
  /\boverwrite\?/i,
  /\bDo you trust\b/i,
  /\bAllow access\b/i,
  /\bGrant permission\b/i,
  /\bAccept\?/i,
  /\bContinue\?/i,
  /\bPermit\b.*\?/i,
  /\bApprove\b.*\?/i,
];

/** Regex patterns that indicate creative / contextual decision needed. */
const CREATIVE_PATTERNS: RegExp[] = [
  /\bWhich approach\b/i,
  /\bHow should\b/i,
  /\btests? failing\b/i,
  /\bchoose between\b/i,
  /\bpick (one|a|an)\b/i,
  /\bWhat do you (want|think)\b/i,
  /\berror recover/i,
  /\bfailed with\b/i,
  /\bcompilation error/i,
  /\bbuild failed\b/i,
  /\btype error/i,
  /\bmerge conflict/i,
];

/** Turn-complete output patterns that are obviously terminal (routine). */
const TERMINAL_OUTPUT_PATTERNS: RegExp[] = [
  /All \d+ tests? pass/i,
  /Tests?:\s+\d+ passed/i,
  /✓ All checks passed/i,
  /https:\/\/github\.com\/[^\s]+\/pull\/\d+/,
  /Successfully created PR/i,
  /Commit [a-f0-9]{7,40}/i,
];

/** Turn-complete output patterns that are obviously intermediate (routine → continue). */
const INTERMEDIATE_OUTPUT_PATTERNS: RegExp[] = [
  /^Running tests?\.\.\./im,
  /^Building\.\.\./im,
  /^Installing dependencies/im,
];

// ─── Heuristic Classifier ───

/**
 * Classify an event tier using only heuristics (prompt type + regex).
 * Returns null if inconclusive.
 */
export function classifyByHeuristic(ctx: TriageContext): TriageTier | null {
  // 1. Check adapter-provided prompt type
  if (ctx.promptType) {
    if (ROUTINE_PROMPT_TYPES.has(ctx.promptType)) return "routine";
    if (CREATIVE_PROMPT_TYPES.has(ctx.promptType)) return "creative";
  }

  // 2. For blocked events, check prompt text patterns
  if (ctx.eventType === "blocked" && ctx.promptText) {
    const hasRoutine = ROUTINE_PATTERNS.some((r) => r.test(ctx.promptText));
    const hasCreative = CREATIVE_PATTERNS.some((r) => r.test(ctx.promptText));

    if (hasRoutine && !hasCreative) return "routine";
    if (hasCreative && !hasRoutine) return "creative";
    // Both or neither → inconclusive
    if (hasCreative) return "creative"; // creative wins ties
  }

  // 3. For turn completions, check output patterns
  if (ctx.eventType === "turn_complete" && ctx.recentOutput) {
    const isTerminal = TERMINAL_OUTPUT_PATTERNS.some((r) =>
      r.test(ctx.recentOutput!),
    );
    const isIntermediate = INTERMEDIATE_OUTPUT_PATTERNS.some((r) =>
      r.test(ctx.recentOutput!),
    );

    if (isTerminal || isIntermediate) return "routine";
    // For turn completions, bias toward creative — most benefit from task context
  }

  return null; // Inconclusive — needs LLM classifier
}

// ─── LLM Classifier ───

/**
 * Build a short classifier prompt for ambiguous events.
 */
export function buildTriagePrompt(ctx: TriageContext): string {
  const eventDesc =
    ctx.eventType === "blocked"
      ? `BLOCKED prompt: "${ctx.promptText.slice(0, 300)}"`
      : `TURN COMPLETE. Recent output:\n${(ctx.recentOutput ?? "").slice(-500)}`;

  return [
    "task: classify_task_agent_event",
    `originalTask: ${ctx.originalTask.slice(0, 200)}`,
    `eventType: ${ctx.eventType}`,
    "event: |",
    ...eventDesc.split("\n").map((line) => `  ${line}`),
    "tiers:",
    "  routine: simple approval, permission, config, yes/no, tool consent, obvious pass/fail",
    "  creative: task context needed, error recovery, design choice, ambiguity, approach selection",
    "outputShape:",
    "  tier: routine",
    "response: TOON only",
  ].join("\n");
}

/**
 * Parse the LLM's triage response. Returns null on failure.
 */
export function parseTriageResponse(llmOutput: string): TriageTier | null {
  const parsedToon = parseToonKeyValue<Record<string, unknown>>(llmOutput);
  if (parsedToon?.tier === "routine" || parsedToon?.tier === "creative") {
    return parsedToon.tier;
  }

  const matches = llmOutput.matchAll(/\{[\s\S]*?\}/g);
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.tier === "routine" || parsed.tier === "creative") {
        return parsed.tier;
      }
    } catch {
      // Try next match
    }
  }
  return null;
}

/**
 * Main entry point: classify an event as routine or creative.
 *
 * 1. Heuristics (0ms)
 * 2. Small LLM classifier (~500ms-1s) if heuristics are inconclusive
 * 3. Default to "creative" if classifier fails (safe default)
 */
export async function classifyEventTier(
  runtime: IAgentRuntime,
  ctx: TriageContext,
  log: (msg: string) => void,
): Promise<TriageTier> {
  // Step 1: Heuristic classification
  const heuristicResult = classifyByHeuristic(ctx);
  if (heuristicResult) {
    log(`Triage: heuristic → ${heuristicResult}`);
    return heuristicResult;
  }

  // Step 2: Small LLM classifier
  try {
    const prompt = buildTriagePrompt(ctx);
    const result = await withTrajectoryContext(
      runtime,
      { source: "orchestrator", decisionType: "event-triage" },
      () => runtime.useModel(ModelType.TEXT_SMALL, { prompt }),
    );
    const tier = parseTriageResponse(result);
    if (tier) {
      log(`Triage: LLM → ${tier}`);
      return tier;
    }
    log(`Triage: LLM returned unparseable response — defaulting to creative`);
  } catch (err) {
    log(`Triage: LLM classifier failed: ${err} — defaulting to creative`);
  }

  // Step 3: Safe default
  return "creative";
}
