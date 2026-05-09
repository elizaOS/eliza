/**
 * Shared extraction pipeline used by the LifeOps LLM extractors.
 *
 * Each extractor (life operation, goal create/update, task create/params,
 * task update) implements the same call → parse → repair → parse loop with
 * a try/catch fallback. The differences are the prompt, the parser, and
 * the optional repair prompt. This helper owns only that orchestration —
 * callers retain full control of their schema, validators, and prompts.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { ModelType, runWithTrajectoryContext } from "@elizaos/core";

type ModelTypeValue = (typeof ModelType)[keyof typeof ModelType];

export interface ExtractorPipelineResult<TParsed> {
  /** Parsed value from the first or repaired model call, or null when both failed. */
  parsed: TParsed | null;
  /**
   * Raw model output. When the repair pass ran, this is the repair output;
   * otherwise it is the first call's output.
   */
  raw: string;
  /** True when the repair prompt was issued. */
  repaired: boolean;
}

export interface RunExtractorPipelineArgs<TParsed> {
  runtime: IAgentRuntime;
  prompt: string;
  /**
   * Convert the raw model text into a typed value. Return `null` when the
   * output is unparseable or fails validation; that triggers the repair pass.
   */
  parser: (raw: string) => TParsed | null;
  /**
   * Build the repair prompt from the raw first-pass output. Omit to skip
   * the repair pass entirely.
   */
  buildRepairPrompt?: (rawFirstPass: string) => string;
  /** Defaults to {@link ModelType.TEXT_LARGE}. */
  modelType?: ModelTypeValue;
}

const EMPTY_RESULT_NO_MODEL: ExtractorPipelineResult<never> = {
  parsed: null,
  raw: "",
  repaired: false,
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Run the canonical LifeOps extractor pipeline.
 *
 * Order of operations:
 *   1. Call the model with `prompt`.
 *   2. Run `parser` on the result. If it returns non-null, return that.
 *   3. Otherwise, if `buildRepairPrompt` is provided, call the model again
 *      with the repair prompt and run `parser` on that result.
 *   4. On any thrown error, log a warning and return `{parsed:null,...}`.
 *
 * Returns `{parsed:null, raw:"", repaired:false}` (with no model call) when
 * `runtime.useModel` is unavailable.
 */
export async function runExtractorPipeline<TParsed>(
  args: RunExtractorPipelineArgs<TParsed>,
): Promise<ExtractorPipelineResult<TParsed>> {
  const { runtime, prompt, parser, buildRepairPrompt } = args;
  const modelType = args.modelType ?? ModelType.TEXT_LARGE;

  if (typeof runtime.useModel !== "function") {
    return EMPTY_RESULT_NO_MODEL;
  }

  try {
    const firstResult = await runWithTrajectoryContext(
      { purpose: "lifeops-extractor-first-pass" },
      () => runtime.useModel(modelType, { prompt }),
    );
    const firstRaw = asString(firstResult);
    const firstParsed = parser(firstRaw);
    if (firstParsed !== null) {
      return { parsed: firstParsed, raw: firstRaw, repaired: false };
    }

    if (!buildRepairPrompt) {
      return { parsed: null, raw: firstRaw, repaired: false };
    }

    const repairResult = await runWithTrajectoryContext(
      { purpose: "lifeops-extractor-repair-pass" },
      () =>
        runtime.useModel(modelType, {
          prompt: buildRepairPrompt(firstRaw),
        }),
    );
    const repairRaw = asString(repairResult);
    const repairParsed = parser(repairRaw);
    return { parsed: repairParsed, raw: repairRaw, repaired: true };
  } catch (error) {
    runtime.logger?.warn?.(
      {
        src: "lifeops:extractor-pipeline",
        error: error instanceof Error ? error.message : String(error),
      },
      "Extractor pipeline model call failed",
    );
    return EMPTY_RESULT_NO_MODEL;
  }
}
