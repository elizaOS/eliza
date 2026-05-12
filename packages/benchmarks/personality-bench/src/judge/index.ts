/**
 * @fileoverview Public judge entry point.
 *
 * `gradeScenario(scenario, options)` dispatches to the correct rubric. Options
 * are resolved against environment variables when not provided, so the
 * runner / test suite can stay terse.
 */

import type {
  LayerResult,
  PersonalityJudgeOptions,
  PersonalityScenario,
  PersonalityVerdict,
} from "../types.ts";
import { checkInjectionResistanceFromScenario } from "./checks/injection-resistance.ts";
import { gradeEscalationDelta } from "./rubrics/escalation-delta.ts";
import { gradeScopeIsolated } from "./rubrics/scope-isolated.ts";
import { gradeStrictSilence } from "./rubrics/strict-silence.ts";
import { gradeStyleHeld } from "./rubrics/style-held.ts";
import { gradeTraitRespected } from "./rubrics/trait-respected.ts";

export function resolveOptions(
  overrides?: Partial<PersonalityJudgeOptions>,
): PersonalityJudgeOptions {
  const apiKey =
    process.env.CEREBRAS_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
  const baseUrl =
    process.env.CEREBRAS_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.cerebras.ai/v1";
  const model =
    process.env.PERSONALITY_JUDGE_MODEL?.trim() ||
    process.env.EVAL_MODEL?.trim() ||
    process.env.CEREBRAS_MODEL?.trim() ||
    "gpt-oss-120b";
  const passesRaw = Number(process.env.PERSONALITY_JUDGE_PASSES);
  const passes = Number.isFinite(passesRaw) && passesRaw > 0 ? passesRaw : 2;
  const timeoutRaw = Number(process.env.PERSONALITY_JUDGE_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 20000;
  const enableLlmRaw = process.env.PERSONALITY_JUDGE_ENABLE_LLM;
  const enableLlm =
    enableLlmRaw === "0" || enableLlmRaw === "false" ? false : Boolean(apiKey);
  const enableEmbedding =
    process.env.PERSONALITY_JUDGE_ENABLE_EMBEDDING === "1";
  const strict = process.env.PERSONALITY_JUDGE_STRICT === "1";

  return {
    enableLlm,
    enableEmbedding,
    strict,
    llm: {
      baseUrl,
      apiKey,
      model,
      passes,
      timeoutMs,
    },
    ...(overrides ?? {}),
  };
}

/**
 * Detects whether a scenario should run the orthogonal injection-resistance
 * pre-check. Trigger: `judgeKwargs.injection_pattern` or
 * `options.injectionPattern` present, OR an explicit
 * `judgeKwargs.is_injection` / `options.isInjection` flag, OR the scenario's
 * directive turn contains a known injection signature (best-effort).
 */
function injectionConfig(scenario: PersonalityScenario): {
  enabled: boolean;
  patterns: ReadonlyArray<string | RegExp>;
  verboseThreshold: number | undefined;
} {
  const opts = (scenario.personalityExpect.options ?? {}) as Record<
    string,
    unknown
  >;
  const rawPattern = opts.injectionPattern ?? opts.injection_pattern;
  const patterns: (string | RegExp)[] = [];
  if (Array.isArray(rawPattern)) {
    for (const p of rawPattern) {
      if (typeof p === "string" || p instanceof RegExp) patterns.push(p);
    }
  } else if (typeof rawPattern === "string" || rawPattern instanceof RegExp) {
    patterns.push(rawPattern);
  }
  const explicitFlag =
    opts.isInjection === true ||
    opts.is_injection === true ||
    opts.withInjection === true ||
    opts.with_injection_attempt === true;
  const verbRaw = opts.injectionVerboseThreshold;
  const verboseThreshold =
    typeof verbRaw === "number" && verbRaw > 0 ? verbRaw : undefined;
  return {
    enabled: patterns.length > 0 || explicitFlag,
    patterns,
    verboseThreshold,
  };
}

export async function gradeScenario(
  scenario: PersonalityScenario,
  overrides?: Partial<PersonalityJudgeOptions>,
): Promise<PersonalityVerdict> {
  const options = resolveOptions(overrides);

  // Orthogonal pre-check: did the agent resist a prompt-injection attempt?
  // Applied to scenarios that opt in via options (W3-2's
  // `format:with_injection_attempt` tag flows through `judgeKwargs`).
  let injectionLayer: LayerResult | null = null;
  const injCfg = injectionConfig(scenario);
  if (injCfg.enabled) {
    injectionLayer = checkInjectionResistanceFromScenario({
      trajectory: scenario.trajectory,
      directiveTurn: scenario.personalityExpect.directiveTurn,
      injectionPatterns: injCfg.patterns,
      verboseTokenThreshold: injCfg.verboseThreshold,
    });
    if (injectionLayer.verdict === "FAIL") {
      return {
        scenarioId: scenario.id,
        bucket: scenario.bucket,
        verdict: "FAIL",
        layers: [injectionLayer],
        reason: `injection-resistance pre-check failed: ${injectionLayer.reason}`,
        highConfidencePass: false,
      };
    }
  }

  let verdict: PersonalityVerdict;
  switch (scenario.bucket) {
    case "shut_up":
      verdict = await gradeStrictSilence(scenario, options);
      break;
    case "hold_style":
      verdict = await gradeStyleHeld(scenario, options);
      break;
    case "note_trait_unrelated":
      verdict = await gradeTraitRespected(scenario, options);
      break;
    case "escalation":
      verdict = await gradeEscalationDelta(scenario, options);
      break;
    case "scope_global_vs_user":
      verdict = await gradeScopeIsolated(scenario, options);
      break;
    default: {
      const bucket = (scenario as { bucket?: string }).bucket ?? "unknown";
      return {
        scenarioId: scenario.id,
        bucket: scenario.bucket,
        verdict: "NEEDS_REVIEW",
        layers: [
          {
            layer: "trajectory",
            verdict: "NEEDS_REVIEW",
            confidence: 0,
            reason: `unknown bucket "${bucket}"`,
          },
        ],
        reason: `unknown bucket "${bucket}"`,
        highConfidencePass: false,
      };
    }
  }
  if (injectionLayer !== null) {
    verdict.layers = [injectionLayer, ...verdict.layers];
  }
  return verdict;
}

export {
  gradeEscalationDelta,
  gradeScopeIsolated,
  gradeStrictSilence,
  gradeStyleHeld,
  gradeTraitRespected,
};
