/**
 * Shared extraction pipeline for LLM argument/field extractors.
 *
 * Each extractor implements the same call → parse → repair → parse loop with
 * explicit failure propagation. The differences are the prompt, the parser, and the
 * optional repair prompt. This helper owns only that orchestration — callers
 * retain full control of their schema, validators, and prompts.
 */

import { ElizaError } from "../errors";
import { isInsufficientCreditsError } from "../security/model-failure.ts";
import { getStreamingContext } from "../streaming-context";
import { runWithTrajectoryPurpose } from "../trajectory-context";
import { type GenerateTextParams, ModelType } from "../types/model.js";
import type { IAgentRuntime } from "../types/runtime.js";
import { modelProviderErrorStatus } from "../utils/model-errors";
import {
	isPermanentQuotaError,
	providerRateLimitRetryAt,
	readProviderRateLimit,
} from "../utils/model-retry";
import { sleepWithAbort } from "../utils/retry";

type ModelTypeValue = (typeof ModelType)[keyof typeof ModelType];

/**
 * Longest wait before the one re-send of a rate-limited extractor call. A
 * token bucket refills continuously, so a refused request is admitted again
 * within seconds; a longer wait would stall the visible turn.
 */
const RATE_LIMIT_RESEND_MAX_WAIT_MS = 5_000;

/**
 * Wait before re-sending a call the provider refused with a structural 429:
 * the refusal's own hint, capped, or the cap when it carries none. Spent
 * credit, permanent quota and a used-up period allowance get none, and
 * neither does a rate limit named only in prose. Same rule as the chat
 * turn's Stage 1, planner and evaluator re-sends.
 */
function rateLimitResendWaitMs(
	error: unknown,
	now = Date.now(),
): number | undefined {
	if (
		modelProviderErrorStatus(error) !== 429 ||
		isInsufficientCreditsError(error) ||
		isPermanentQuotaError(error)
	)
		return undefined;
	const reported = readProviderRateLimit(error);
	if (reported?.scope === "period") return undefined;
	const retryAt = providerRateLimitRetryAt(error, now);
	const hintMs = retryAt === undefined ? reported?.retryAfterMs : retryAt - now;
	return Math.min(
		Math.ceil(hintMs ?? RATE_LIMIT_RESEND_MAX_WAIT_MS),
		RATE_LIMIT_RESEND_MAX_WAIT_MS,
	);
}

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
	/** Request-bound canonical system context, when already supplied by the caller. */
	system?: string;
	/** Opt in to a provider text response format for both first and repair calls. */
	responseFormat?: GenerateTextParams["responseFormat"];
	/**
	 * Per-call provider options for both first and repair calls, such as the
	 * `eliza.thinking` reasoning hint. Omitted, the calls carry none.
	 */
	providerOptions?: GenerateTextParams["providerOptions"];
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
 * 1. Call the model with `prompt`.
 * 2. Run `parser` on the result. If it returns non-null, return that.
 * 3. Otherwise, if `buildRepairPrompt` is provided, call the model again
 * with the repair prompt and run `parser` on that result.
 * 4. A pass whose call is refused with a temporary rate limit waits out the
 * refusal (at most 5 s, cancelled with the turn) and re-sends the same call
 * once; each pass has its own re-send.
 * 5. Model and transport failures propagate after being reported.
 */
export async function runExtractorPipeline<TParsed>(
	args: RunExtractorPipelineArgs<TParsed>,
): Promise<ExtractorPipelineResult<TParsed>> {
	const { runtime, prompt, parser, buildRepairPrompt } = args;
	const modelType = args.modelType ?? ModelType.TEXT_LARGE;
	const callOptions = {
		...(args.system !== undefined ? { system: args.system } : {}),
		...(args.responseFormat !== undefined
			? { responseFormat: args.responseFormat }
			: {}),
		...(args.providerOptions !== undefined
			? { providerOptions: args.providerOptions }
			: {}),
	};
	const callPass = async (
		purpose: string,
		passPrompt: string,
	): Promise<string> => {
		const send = () =>
			runWithTrajectoryPurpose(purpose, () =>
				runtime.useModel(modelType, { prompt: passPrompt, ...callOptions }),
			);
		let result: unknown;
		try {
			result = await send();
		} catch (error) {
			// error-policy:J2 An extractor call waits out a temporary rate limit
			// once and re-sends the same request; a second refusal and every
			// other failure propagate unchanged.
			const waitMs = rateLimitResendWaitMs(error);
			if (waitMs === undefined) throw error;
			runtime.logger.warn(
				{ src: "lifeops:extractor-pipeline", purpose, delayMs: waitMs },
				"Extractor pipeline model call is rate limited; waiting before one re-send",
			);
			await sleepWithAbort(waitMs, getStreamingContext()?.abortSignal);
			result = await send();
		}
		return asString(result);
	};

	try {
		const firstRaw = await callPass("lifeops-extractor-first-pass", prompt);
		const firstParsed = parser(firstRaw);
		if (firstParsed !== null) {
			return { parsed: firstParsed, raw: firstRaw, repaired: false };
		}

		if (!buildRepairPrompt) {
			return { parsed: null, raw: firstRaw, repaired: false };
		}

		const repairRaw = await callPass(
			"lifeops-extractor-repair-pass",
			buildRepairPrompt(firstRaw),
		);
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
