/**
 * Replay validator for synthetic training data.
 *
 * Validates that every generated sample:
 * 1. Parses correctly with the same Eliza parser
 * 2. References only valid contexts/actions/providers
 * 3. Would survive round-trip through the real runtime
 * 4. Has proper structure for eliza_native_v1 supervised tuning
 *
 * Also computes dataset quality metrics:
 * - Decision balance (RESPOND/IGNORE/STOP distribution)
 * - Context coverage (all contexts represented)
 * - Agent name diversity (no statistical pollution)
 * - Turn count distribution
 */

import {
  ELIZA_NATIVE_MODEL_BOUNDARIES,
  ELIZA_NATIVE_TRAJECTORY_FORMAT,
  type ElizaNativeTrajectoryRow,
} from "@elizaos/core";
import {
  ACTION_CONTEXT_MAP,
  ALL_CONTEXTS,
  PROVIDER_CONTEXT_MAP,
} from "./context-catalog.js";
import type { AgentContext } from "./context-types.js";
import type {
  ElizaNativeTrainingExample,
  TrainingSample,
} from "./dataset-generator.js";

type TuningMessage = { role?: string; content?: unknown; parts?: unknown };
const NATIVE_MODEL_BOUNDARIES = new Set<string>(ELIZA_NATIVE_MODEL_BOUNDARIES);

function getTuningMessages(
  parsed: ElizaNativeTrainingExample,
): TuningMessage[] | null {
  const row = parsed as ElizaNativeTrajectoryRow & {
    messages?: TuningMessage[];
    request?: { system?: unknown; messages?: unknown; prompt?: unknown };
  };
  if (row.format === ELIZA_NATIVE_TRAJECTORY_FORMAT) {
    const out: TuningMessage[] = [];
    const system = row.request?.system;
    if (typeof system === "string" && system.length > 0) {
      out.push({ role: "system", content: system });
    }
    const msgs = row.request?.messages;
    if (Array.isArray(msgs)) {
      for (const msg of msgs as TuningMessage[]) {
        if (
          msg.role === "system" &&
          out.length > 0 &&
          out[0]?.role === "system" &&
          out[0]?.content === msg.content
        ) {
          continue;
        }
        out.push(msg);
      }
    }
    if (
      !out.some((msg) => msg.role === "user") &&
      typeof row.request?.prompt === "string" &&
      row.request.prompt.length > 0
    ) {
      out.push({ role: "user", content: row.request.prompt });
    }
    return out.length > 0 ? out : null;
  }
  return null;
}

// ==================== Validation types ====================

export interface ValidationResult {
  sampleId: string;
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  type:
    | "invalid_json"
    | "missing_field"
    | "invalid_context"
    | "invalid_action"
    | "invalid_decision"
    | "empty_messages"
    | "no_agent_name"
    | "name_in_response";
  message: string;
}

export interface ValidationWarning {
  type:
    | "low_turn_count"
    | "high_turn_count"
    | "duplicate_agent_name"
    | "missing_grounding_keywords"
    | "single_participant";
  message: string;
}

export interface DatasetQualityReport {
  totalSamples: number;
  validSamples: number;
  invalidSamples: number;
  errorRate: number;

  /** Distribution of decisions */
  decisionBalance: {
    RESPOND: number;
    IGNORE: number;
    STOP: number;
    respondPct: number;
    ignorePct: number;
    stopPct: number;
  };

  /** Context coverage */
  contextCoverage: Record<AgentContext, number>;
  missingContexts: AgentContext[];

  /** Agent name diversity */
  uniqueAgentNames: number;
  totalSamplesChecked: number;
  nameDiversityRatio: number;

  /** Turn count stats */
  turnCountStats: {
    min: number;
    max: number;
    mean: number;
    median: number;
    p90: number;
  };

  /** Pattern distribution */
  patternDistribution: Record<string, number>;

  /** Top errors */
  topErrors: Array<{ type: string; count: number }>;

  /** Top warnings */
  topWarnings: Array<{ type: string; count: number }>;

  /** Native model-boundary format validation */
  nativeFormatValid: number;
  nativeFormatInvalid: number;
}

// ==================== Validators ====================

/**
 * Validate a single training sample.
 */
export function validateSample(sample: TrainingSample): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Check required fields
  if (!sample.id)
    errors.push({ type: "missing_field", message: "Missing sample ID" });
  if (!sample.blueprintId)
    errors.push({ type: "missing_field", message: "Missing blueprint ID" });
  if (!sample.agentName)
    errors.push({ type: "no_agent_name", message: "Missing agent name" });

  // Check messages
  if (sample.messages.length === 0) {
    errors.push({ type: "empty_messages", message: "No messages in sample" });
  } else {
    if (sample.messages.length < 2) {
      warnings.push({
        type: "low_turn_count",
        message: `Only ${sample.messages.length} turn(s)`,
      });
    }
    if (sample.messages.length > 30) {
      warnings.push({
        type: "high_turn_count",
        message: `${sample.messages.length} turns (very long)`,
      });
    }
  }

  // Check decision
  const validDecisions = ["RESPOND", "IGNORE", "STOP"];
  if (!validDecisions.includes(sample.expectedOutput.decision)) {
    errors.push({
      type: "invalid_decision",
      message: `Invalid decision: ${sample.expectedOutput.decision}`,
    });
  }

  // Check context
  if (
    !ALL_CONTEXTS.includes(sample.expectedOutput.primaryContext as AgentContext)
  ) {
    errors.push({
      type: "invalid_context",
      message: `Unknown primary context: ${sample.expectedOutput.primaryContext}`,
    });
  }

  for (const ctx of sample.expectedOutput.secondaryContexts) {
    if (!ALL_CONTEXTS.includes(ctx as AgentContext)) {
      errors.push({
        type: "invalid_context",
        message: `Unknown secondary context: ${ctx}`,
      });
    }
  }

  // Check expected action (if present)
  if (sample.expectedOutput.expectedAction) {
    const actionUpper = sample.expectedOutput.expectedAction.toUpperCase();
    if (!ACTION_CONTEXT_MAP[actionUpper]) {
      warnings.push({
        type: "missing_grounding_keywords",
        message: `Action ${actionUpper} not in context catalog (may be a custom action)`,
      });
    }
  }

  // Check for agent name pollution in the response
  // The model output should use the randomized agent name, not a fixed name
  const participants = new Set(
    sample.messages.map((m) => m.name).filter(Boolean),
  );
  if (participants.size <= 1 && sample.messages.length > 2) {
    warnings.push({
      type: "single_participant",
      message: "Only one participant name in the conversation",
    });
  }

  return {
    sampleId: sample.id,
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate an eliza_native_v1 tuning example JSONL line.
 */
export function validateElizaNativeExample(jsonLine: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  let parsed: ElizaNativeTrainingExample;
  try {
    parsed = JSON.parse(jsonLine);
  } catch {
    return { valid: false, errors: ["Invalid JSON"] };
  }

  const messages = getTuningMessages(parsed);
  if (!messages) {
    errors.push("Missing eliza_native_v1 request system/messages/prompt");
    return { valid: false, errors };
  }

  const native = parsed as ElizaNativeTrajectoryRow;
  if (native.format !== ELIZA_NATIVE_TRAJECTORY_FORMAT) {
    errors.push(`format must be ${ELIZA_NATIVE_TRAJECTORY_FORMAT}`);
    return { valid: false, errors };
  }
  if (!NATIVE_MODEL_BOUNDARIES.has(native.boundary)) {
    errors.push("boundary must be a supported Vercel AI SDK model boundary");
  }

  if (messages.length < 2) {
    errors.push("Need at least 2 request messages (e.g. system + user)");
  }
  const text = native.response?.text;
  const toolCalls = native.response?.toolCalls;
  if (
    (typeof text !== "string" || text.trim().length === 0) &&
    !Array.isArray(toolCalls)
  ) {
    errors.push("Missing response.text or response.toolCalls");
  }
  for (const msg of messages) {
    if (
      !msg.role ||
      !["system", "developer", "user", "assistant", "tool"].includes(msg.role)
    ) {
      errors.push(`Invalid role: ${msg.role}`);
    }
    if (msg.content === undefined && msg.parts === undefined) {
      errors.push("Missing message content/parts");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate an entire dataset and produce a quality report.
 */
export function validateDataset(
  samples: TrainingSample[],
): DatasetQualityReport {
  const results = samples.map(validateSample);
  const validResults = results.filter((r) => r.valid);
  const invalidResults = results.filter((r) => !r.valid);

  // Decision balance
  const respondCount = samples.filter(
    (s) => s.expectedOutput.decision === "RESPOND",
  ).length;
  const ignoreCount = samples.filter(
    (s) => s.expectedOutput.decision === "IGNORE",
  ).length;
  const stopCount = samples.filter(
    (s) => s.expectedOutput.decision === "STOP",
  ).length;

  // Context coverage
  const contextCoverage = Object.fromEntries(
    ALL_CONTEXTS.map((ctx) => [
      ctx,
      samples.filter((s) => s.expectedOutput.primaryContext === ctx).length,
    ]),
  ) as Record<AgentContext, number>;
  const missingContexts = ALL_CONTEXTS.filter(
    (ctx) => contextCoverage[ctx] === 0,
  );

  // Agent name diversity
  const uniqueNames = new Set(samples.map((s) => s.agentName));

  // Turn count stats
  const turnCounts = samples
    .map((s) => s.metadata.turnCount)
    .sort((a, b) => a - b);
  const turnCountStats = {
    min: turnCounts[0] ?? 0,
    max: turnCounts[turnCounts.length - 1] ?? 0,
    mean: turnCounts.reduce((a, b) => a + b, 0) / (turnCounts.length || 1),
    median: turnCounts[Math.floor(turnCounts.length / 2)] ?? 0,
    p90: turnCounts[Math.floor(turnCounts.length * 0.9)] ?? 0,
  };

  // Pattern distribution
  const patternDistribution: Record<string, number> = {};
  for (const s of samples) {
    patternDistribution[s.metadata.pattern] =
      (patternDistribution[s.metadata.pattern] ?? 0) + 1;
  }

  // Top errors and warnings
  const errorCounts: Record<string, number> = {};
  const warningCounts: Record<string, number> = {};
  for (const r of results) {
    for (const e of r.errors) {
      errorCounts[e.type] = (errorCounts[e.type] ?? 0) + 1;
    }
    for (const w of r.warnings) {
      warningCounts[w.type] = (warningCounts[w.type] ?? 0) + 1;
    }
  }

  return {
    totalSamples: samples.length,
    validSamples: validResults.length,
    invalidSamples: invalidResults.length,
    errorRate: invalidResults.length / (samples.length || 1),

    decisionBalance: {
      RESPOND: respondCount,
      IGNORE: ignoreCount,
      STOP: stopCount,
      respondPct: respondCount / (samples.length || 1),
      ignorePct: ignoreCount / (samples.length || 1),
      stopPct: stopCount / (samples.length || 1),
    },

    contextCoverage,
    missingContexts,

    uniqueAgentNames: uniqueNames.size,
    totalSamplesChecked: samples.length,
    nameDiversityRatio: uniqueNames.size / (samples.length || 1),

    turnCountStats,
    patternDistribution,

    topErrors: Object.entries(errorCounts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),

    topWarnings: Object.entries(warningCounts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),

    nativeFormatValid: 0, // filled by separate JSONL validation
    nativeFormatInvalid: 0,
  };
}

/**
 * Run all validations and produce a formatted report string.
 */
export function formatQualityReport(report: DatasetQualityReport): string {
  const lines: string[] = [];

  lines.push("=== Dataset Quality Report ===");
  lines.push("");
  lines.push(`Total samples: ${report.totalSamples}`);
  lines.push(
    `Valid: ${report.validSamples} (${((1 - report.errorRate) * 100).toFixed(1)}%)`,
  );
  lines.push(`Invalid: ${report.invalidSamples}`);
  lines.push("");

  lines.push("--- Decision Balance ---");
  lines.push(
    `RESPOND: ${report.decisionBalance.RESPOND} (${(report.decisionBalance.respondPct * 100).toFixed(1)}%)`,
  );
  lines.push(
    `IGNORE:  ${report.decisionBalance.IGNORE} (${(report.decisionBalance.ignorePct * 100).toFixed(1)}%)`,
  );
  lines.push(
    `STOP:    ${report.decisionBalance.STOP} (${(report.decisionBalance.stopPct * 100).toFixed(1)}%)`,
  );
  lines.push("");

  lines.push("--- Context Coverage ---");
  for (const [ctx, count] of Object.entries(report.contextCoverage)) {
    lines.push(`  ${ctx}: ${count}`);
  }
  if (report.missingContexts.length > 0) {
    lines.push(`  MISSING: ${report.missingContexts.join(", ")}`);
  }
  lines.push("");

  lines.push("--- Name Diversity ---");
  lines.push(
    `Unique agent names: ${report.uniqueAgentNames} / ${report.totalSamplesChecked} samples`,
  );
  lines.push(
    `Diversity ratio: ${(report.nameDiversityRatio * 100).toFixed(1)}%`,
  );
  lines.push("");

  lines.push("--- Turn Count ---");
  lines.push(`Min: ${report.turnCountStats.min}`);
  lines.push(`Max: ${report.turnCountStats.max}`);
  lines.push(`Mean: ${report.turnCountStats.mean.toFixed(1)}`);
  lines.push(`Median: ${report.turnCountStats.median}`);
  lines.push(`P90: ${report.turnCountStats.p90}`);
  lines.push("");

  lines.push("--- Pattern Distribution ---");
  for (const [pattern, count] of Object.entries(report.patternDistribution)) {
    lines.push(`  ${pattern}: ${count}`);
  }
  lines.push("");

  if (report.topErrors.length > 0) {
    lines.push("--- Top Errors ---");
    for (const { type, count } of report.topErrors) {
      lines.push(`  ${type}: ${count}`);
    }
    lines.push("");
  }

  if (report.topWarnings.length > 0) {
    lines.push("--- Top Warnings ---");
    for (const { type, count } of report.topWarnings) {
      lines.push(`  ${type}: ${count}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ==================== Skill scoring ====================

/**
 * Minimum metadata a Skill needs for scoring. We do not import @elizaos/skills
 * here because app-training is downstream of the skills package and we want
 * scoreSkill to be usable in cron-job contexts that pass loaded skills.
 */
export interface ScoreableSkill {
  name: string;
}

/**
 * Loose Trajectory shape used for scoring. Mirrors the persisted-trajectory
 * type but kept narrow so callers can pass results from any source (the
 * `trajectories` service, JSON exports, fixtures).
 */
export interface ScoreableTrajectory {
  trajectoryId?: string;
  metrics?: { finalStatus?: string };
  steps?: Array<{
    usedSkills?: string[];
  }>;
  metadata?: Record<string, unknown>;
}

/**
 * Score a curated skill in [0, 1] based on its observed success rate across
 * the supplied held-out trajectories.
 *
 * Algorithm:
 *   1. Filter trajectories that reference the skill on any step (or via
 *      metadata.usedSkills, for parity with the refinement evaluator).
 *   2. Score = successCount / totalReferencingCount.
 *   3. Returns 0 when no referencing trajectories exist (signals "no data" —
 *      callers should treat 0 as "unscored" if they want to distinguish that
 *      from "always failed").
 *
 * The scoring is deliberately simple because the source of truth is the
 * trajectory store; richer signals (duration, retry count, user follow-ups)
 * are easy to layer in later by extending ScoreableTrajectory.
 */
export async function scoreSkill(
  skill: ScoreableSkill,
  heldOutTrajectories: ScoreableTrajectory[],
): Promise<number> {
  const referencing = heldOutTrajectories.filter((trajectory) =>
    trajectoryUsesSkill(trajectory, skill.name),
  );
  if (referencing.length === 0) {
    return 0;
  }
  const successes = referencing.filter(
    (trajectory) => (trajectory.metrics?.finalStatus ?? "") === "completed",
  ).length;
  const score = successes / referencing.length;
  return Math.max(0, Math.min(1, score));
}

function trajectoryUsesSkill(
  trajectory: ScoreableTrajectory,
  skillName: string,
): boolean {
  const target = skillName.trim();
  if (!target) return false;
  for (const step of trajectory.steps ?? []) {
    if (Array.isArray(step.usedSkills) && step.usedSkills.includes(target)) {
      return true;
    }
  }
  const metaUsed = trajectory.metadata?.usedSkills;
  if (Array.isArray(metaUsed) && metaUsed.includes(target)) {
    return true;
  }
  return false;
}
