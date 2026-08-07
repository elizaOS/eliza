/**
 * Shared extraction pipeline for LLM argument/field extractors.
 *
 * Each extractor implements the same call → parse → repair → parse loop with
 * explicit failure propagation. The differences are the prompt, the parser, and the
 * optional repair prompt. This helper owns only that orchestration — callers
 * retain full control of their schema, validators, and prompts.
 */

import { ElizaError } from "../errors";
import { runWithTrajectoryPurpose } from "../trajectory-context";
import type { IAgentRuntime } from "../types";
import { ModelType } from "../types";

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

function asString(value: unknown): string {
	if (typeof value === "string") return value;
	throw new ElizaError("Extractor model returned a non-text response", {
		code: "EXTRACTOR_NON_TEXT_RESPONSE",
		context: { responseType: typeof value },
	});
}

/**
 * Run the canonical extractor pipeline.
 *
 * Order of operations:
 *   1. Call the model with `prompt`.
 *   2. Run `parser` on the result. If it returns non-null, return that.
 *   3. Otherwise, if `buildRepairPrompt` is provided, call the model again
 *      with the repair prompt and run `parser` on that result.
 *   4. Model and transport failures propagate after being reported.
 */
export async function runExtractorPipeline<TParsed>(
	args: RunExtractorPipelineArgs<TParsed>,
): Promise<ExtractorPipelineResult<TParsed>> {
	const { runtime, prompt, parser, buildRepairPrompt } = args;
	const modelType = args.modelType ?? ModelType.TEXT_LARGE;

	try {
		const firstResult = await runWithTrajectoryPurpose(
			"lifeops-extractor-first-pass",
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

		const repairResult = await runWithTrajectoryPurpose(
			"lifeops-extractor-repair-pass",
			() =>
				runtime.useModel(modelType, {
					prompt: buildRepairPrompt(firstRaw),
				}),
		);
		const repairRaw = asString(repairResult);
		const repairParsed = parser(repairRaw);
		return { parsed: repairParsed, raw: repairRaw, repaired: true };
	} catch (error) {
		// error-policy:J2 Extraction cannot distinguish a model outage from a real
		// parse miss, so preserve and surface the model failure.
		runtime.reportError("ExtractorPipeline.model", error, { modelType });
		runtime.logger.warn(
			{
				src: "lifeops:extractor-pipeline",
				error: error instanceof Error ? error.message : String(error),
			},
			"Extractor pipeline model call failed",
		);
		throw error;
	}
}
