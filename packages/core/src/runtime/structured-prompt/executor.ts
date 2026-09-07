/** Executes structured prompts with schema validation, streaming delivery, and retry diagnostics.
 * The runtime supplies public model and optimization hooks; the per-runtime trace store owns enrichment.
 * Attempt metrics are shared across runtimes as before. */

import { v4 as uuidv4 } from "uuid";
import { isRateLimitError } from "../../services/message/fallback-reply";
import { runWithStreamingContext } from "../../streaming-context";
import {
	type GenerateTextParams,
	getModelFallbackChain,
	type IAgentRuntime,
	type JsonValue,
	type ModelTypeName,
	type PromptSegment,
	type State,
	type StreamChunkCallback,
} from "../../types";
import { ScoreCard } from "../../types/prompt-optimization-score-card";
import type { ExecutionTrace } from "../../types/prompt-optimization-trace";
import type {
	RetryBackoffConfig,
	SchemaRow,
	StreamEvent,
	StructuredOutputFailure,
} from "../../types/state";
import { parseBooleanValue } from "../../utils/boolean";
import { shortStringHash } from "../../utils/deterministic";
import {
	getErrorMessage,
	isTransientModelError,
} from "../../utils/model-errors";
import { StructuredFieldStreamExtractor } from "../../utils/streaming";
import { toWellFormedUnicode } from "../../utils/well-formed.js";
import { computePrefixHashes } from "../context-hash";
import { cachePrefixSegments } from "../context-renderer";
import { stringifyForModel } from "../json-output";
import { RUNTIME_DEBUG_LOG_ENABLED } from "../model-diagnostics.js";
import { buildProviderCachePlan } from "../provider-cache-plan";
import type { ActivePromptTraces } from "./active-traces";
import {
	mergeProviderOptionsWithCachePlan,
	resolveDefaultOutputFormat,
	resolveDynamicPromptModelType,
	resolveDynamicPromptStreamFields,
} from "./options.js";
import {
	normalizeStructuredResponse,
	parseStructuredResponse,
} from "./response";
import {
	buildSchemaMetricKey,
	buildValidationOutputInstructions,
	collectSchemaDefinitionWarnings,
	flattenSchemaRows,
	renderJsonSchemaExample,
	validateResponseAgainstSchema,
} from "./schema";
import type { DynamicPromptStreamExtractor } from "./stream-extractor.js";
import {
	joinPromptSegmentGroups,
	mergePromptSegments,
	renderPromptTemplateSegments,
} from "./template";
import type { StructuredResponseFormat } from "./types";
export class StructuredPromptExecutor {
	constructor(
		private readonly runtime: IAgentRuntime,
		private readonly promptTraces: ActivePromptTraces,
	) {}
	resolveProviderModelString(
		resolvedModelType: string,
		optionsModel?: string,
		effectiveModelId?: string,
	): string {
		if (effectiveModelId) return effectiveModelId;
		if (optionsModel) return optionsModel;

		const slotToSetting: Record<string, string> = {
			TEXT_NANO: "NANO_MODEL",
			TEXT_MINI: "MINI_MODEL",
			TEXT_SMALL: "SMALL_MODEL",
			TEXT_LARGE: "LARGE_MODEL",
			TEXT_MEGA: "MEGA_MODEL",
			RESPONSE_HANDLER: "RESPONSE_HANDLER_MODEL",
			ACTION_PLANNER: "ACTION_PLANNER_MODEL",
			REASONING_SMALL: "REASONING_SMALL_MODEL",
			REASONING_LARGE: "REASONING_LARGE_MODEL",
			TEXT_COMPLETION: "COMPLETION_MODEL",
		};

		const providerPrefixes = ["OLLAMA_", "OPENAI_", "ANTHROPIC_", ""];
		for (const candidate of getModelFallbackChain(
			resolvedModelType as ModelTypeName,
		)) {
			const settingKey = slotToSetting[candidate];
			if (!settingKey) continue;
			for (const prefix of providerPrefixes) {
				const val = this.runtime.getSetting(`${prefix}${settingKey}`);
				if (typeof val === "string" && val) return val;
			}
		}

		return resolvedModelType;
	}

	private static dynamicPromptMetrics = new Map<
		string,
		{
			lowestFailedTokenCount: number | null;
			highestSuccessTokenCount: number | null;
			totalAttempts: number;
			successfulAttempts: number;
			failedAttempts: number;
			lastUpdated: number;
		}
	>();

	private static readonly METRICS_MAX_ENTRIES = 100;

	private static readonly METRICS_TTL_MS = 60 * 60 * 1000;

	private static readonly STRUCTURED_FAILURE_PREVIEW_LIMIT = 4000;

	private static getOrCreateMetrics(key: string) {
		const now = Date.now();

		// Prune stale entries periodically (when we access)
		if (
			StructuredPromptExecutor.dynamicPromptMetrics.size >
			StructuredPromptExecutor.METRICS_MAX_ENTRIES / 2
		) {
			for (const [k, v] of StructuredPromptExecutor.dynamicPromptMetrics) {
				if (now - v.lastUpdated > StructuredPromptExecutor.METRICS_TTL_MS) {
					StructuredPromptExecutor.dynamicPromptMetrics.delete(k);
				}
			}
		}

		// Evict oldest if still at max capacity
		if (
			StructuredPromptExecutor.dynamicPromptMetrics.size >=
			StructuredPromptExecutor.METRICS_MAX_ENTRIES
		) {
			let oldestKey: string | null = null;
			let oldestTime = Infinity;
			for (const [k, v] of StructuredPromptExecutor.dynamicPromptMetrics) {
				if (v.lastUpdated < oldestTime) {
					oldestTime = v.lastUpdated;
					oldestKey = k;
				}
			}
			if (oldestKey) {
				StructuredPromptExecutor.dynamicPromptMetrics.delete(oldestKey);
			}
		}

		let metric = StructuredPromptExecutor.dynamicPromptMetrics.get(key);
		if (!metric) {
			metric = {
				lowestFailedTokenCount: null,
				highestSuccessTokenCount: null,
				totalAttempts: 0,
				successfulAttempts: 0,
				failedAttempts: 0,
				lastUpdated: now,
			};
			StructuredPromptExecutor.dynamicPromptMetrics.set(key, metric);
		}
		return metric;
	}

	private setStructuredOutputFailureState(
		state: State,
		failure: StructuredOutputFailure,
	): void {
		const issues = Array.isArray(failure.issues)
			? failure.issues.filter(
					(issue): issue is string =>
						typeof issue === "string" && issue.trim().length > 0,
				)
			: [];
		const summaryParts = [
			`Structured output ${failure.kind.replaceAll("_", " ")}`,
			`model=${failure.model}`,
			`format=${failure.format}`,
			`attempt=${failure.attempts}/${failure.maxRetries + 1}`,
			...(issues.length > 0 ? [`issue=${issues[0]}`] : []),
			...(failure.parseError ? [`error=${failure.parseError}`] : []),
		];

		state.values = {
			...state.values,
			structuredOutputFailureSummary: summaryParts.join("; "),
		};
		state.data = {
			...state.data,
			structuredOutputFailure: failure,
		};
	}

	private clearStructuredOutputFailureState(state: State): void {
		if (state.values.structuredOutputFailureSummary !== undefined) {
			const { structuredOutputFailureSummary: _discard, ...restValues } =
				state.values;
			state.values = restValues;
		}

		if (state.data.structuredOutputFailure !== undefined) {
			const { structuredOutputFailure: _discard, ...restData } = state.data;
			state.data = restData;
		}
	}

	async dynamicPromptExecFromState({
		state: stateArg,
		params,
		schema,
		options = {},
	}: {
		state?: State;
		params: Omit<GenerateTextParams, "prompt"> & {
			prompt: string | ((ctx: { state: State }) => string);
		};
		schema: SchemaRow[];
		options?: {
			key?: string;
			promptName?: string;
			modelSize?: "nano" | "small" | "medium" | "large" | "mega";
			modelType?: import("../../types").TextGenerationModelType;
			model?: string;
			requiredFields?: string[];
			contextCheckLevel?: 0 | 1 | 2 | 3;
			checkpointCodes?: boolean;
			maxRetries?: number;
			retryBackoff?: number | RetryBackoffConfig;
			disableCache?: boolean;
			cacheTTL?: number;
			onStreamChunk?: StreamChunkCallback;
			onStreamEvent?: (
				event: StreamEvent,
				messageId?: string,
			) => void | Promise<void>;
			abortSignal?: AbortSignal;
		};
	}): Promise<Record<string, unknown> | null> {
		const state: State =
			stateArg ?? ({ values: {}, data: {}, text: "" } as State);

		// Validate schema input
		if (!schema || schema.length === 0) {
			this.runtime.logger.error(
				"dynamicPromptExecFromState: schema must have at least one entry",
			);
			this.clearStructuredOutputFailureState(state);
			return null;
		}

		const flattenedSchema = flattenSchemaRows(schema);
		const schemaWarnings = collectSchemaDefinitionWarnings(schema);
		for (const warning of schemaWarnings) {
			this.runtime.logger.warn(
				`dynamicPromptExecFromState schema warning: ${warning}`,
			);
		}

		// Validate field names are valid identifiers
		const invalidFields = flattenedSchema.filter((row) => {
			if (!row.field || typeof row.field !== "string") return true;
			// Field names should be valid identifiers: start with letter/underscore, contain only alphanumeric/underscore
			return !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(row.field);
		});

		if (invalidFields.length > 0) {
			this.runtime.logger.error(
				`dynamicPromptExecFromState: invalid field names in schema: ${invalidFields.map((f) => f.field || "(empty)").join(", ")}`,
			);
			this.clearStructuredOutputFailureState(state);
			return null;
		}

		// Generate keys for metrics
		const resolvedModelType = resolveDynamicPromptModelType(
			options.modelType,
			options.modelSize,
		);
		const modelIdentifier =
			options.modelType || options.model || resolvedModelType;
		const schemaKey = buildSchemaMetricKey(schema);
		const modelSchemaKey = `${modelIdentifier}:${schemaKey}`;

		// Get validation level from settings or options
		const validationLevelRaw = this.runtime.getSetting("VALIDATION_LEVEL");
		const validationLevel =
			typeof validationLevelRaw === "string"
				? validationLevelRaw.toLowerCase()
				: undefined;

		// Map VALIDATION_LEVEL to contextCheckLevel and default retries
		let defaultContextCheckLevel: 0 | 1 | 2 | 3 = 2;
		let defaultRetries = 1;

		if (validationLevel === "trusted" || validationLevel === "fast") {
			defaultContextCheckLevel = 0;
			defaultRetries = 0;
		} else if (validationLevel === "progressive") {
			defaultContextCheckLevel = 1;
			defaultRetries = 2;
		} else if (validationLevel === "strict" || validationLevel === "safe") {
			defaultContextCheckLevel = 3;
			defaultRetries = 3;
		} else if (validationLevel !== undefined) {
			// Warn about unrecognized validation level
			this.runtime.logger.warn(
				`Unrecognized VALIDATION_LEVEL "${validationLevel}". ` +
					`Valid values: trusted, fast, progressive, strict, safe. ` +
					`Falling back to default (level 2).`,
			);
		}

		const maxRetries = options.maxRetries ?? defaultRetries;
		const checkpointCodesEnabled =
			options.checkpointCodes ??
			parseBooleanValue(this.runtime.getSetting("PROMPT_CHECKPOINT_CODES")) ??
			false;
		let currentRetry = 0;
		const promptCode = () => uuidv4().replaceAll("-", "").slice(0, 8);
		let lastStructuredFailure: StructuredOutputFailure | null = null;

		// Initialize metrics with LRU eviction
		const metric = StructuredPromptExecutor.getOrCreateMetrics(modelSchemaKey);

		// Extractor is created once and persists across retries
		let extractor: DynamicPromptStreamExtractor | undefined;
		let structuredPromptDelivery = Promise.resolve();
		let structuredPromptDeliveryError: unknown;
		let structuredPromptDeliveryFailed = false;
		const enqueueStructuredPromptDelivery = (
			deliver: () => void | Promise<void>,
		): void => {
			structuredPromptDelivery = structuredPromptDelivery
				.then(async () => {
					if (structuredPromptDeliveryFailed) return;
					await deliver();
				})
				.then(undefined, (error: unknown) => {
					structuredPromptDeliveryFailed = true;
					structuredPromptDeliveryError = error;
				});
		};
		const drainStructuredPromptDelivery = async (): Promise<void> => {
			await structuredPromptDelivery;
			if (structuredPromptDeliveryFailed) {
				throw structuredPromptDeliveryError;
			}
		};
		let contextLevel: 0 | 1 | 2 | 3 = defaultContextCheckLevel;
		const perFieldCodes = new Map<string, string>();

		let traceModelId: string | undefined;
		let tracePromptKey: string | undefined;
		let traceVariant = "baseline";
		let traceArtifactVersion: number | undefined;
		const traceStartTime = Date.now();
		const optimizationHooks = this.runtime.getPromptOptimizationHooks();

		if (optimizationHooks) {
			traceModelId = this.resolveProviderModelString(
				resolvedModelType,
				options.model,
			);
			const schemaHash = buildSchemaMetricKey(schema)
				.split("")
				.reduce((h, c) => ((h * 31) ^ c.charCodeAt(0)) >>> 0, 5381)
				.toString(16)
				.slice(0, 8);
			tracePromptKey = options.promptName ?? schemaHash;
		}

		while (currentRetry <= maxRetries) {
			const template = params.prompt;
			const templateStr =
				typeof template === "function" ? template({ state }) : template;

			let finalTemplateStr = templateStr;
			if (
				optimizationHooks &&
				traceModelId &&
				tracePromptKey &&
				currentRetry === 0
			) {
				try {
					const merged = await optimizationHooks.mergePromptTemplate(
						this.runtime,
						{
							baselineTemplate: templateStr,
							modelId: traceModelId,
							modelSlot: resolvedModelType,
							promptKey: tracePromptKey,
						},
					);
					finalTemplateStr = merged.template;
					traceVariant = merged.variant;
					traceArtifactVersion = merged.artifactVersion;
				} catch (optErr) {
					// error-policy:J4 Prompt optimization is optional; the
					// unoptimized baseline remains the explicit degraded path.
					this.runtime.logger.warn(
						{ error: optErr },
						"Optimization artifact lookup failed",
					);
					this.runtime.reportError(
						"AgentRuntime.promptOptimizationLookup",
						optErr,
						{
							promptKey: tracePromptKey,
						},
					);
				}
			}

			// Get keys from state (excluding text, values, data)
			const stateKeys = Object.keys(state);
			const filteredKeys = stateKeys.filter(
				(key) => !["text", "values", "data"].includes(key),
			);
			const filteredState = filteredKeys.reduce(
				(acc: Record<string, unknown>, key) => {
					acc[key] = state[key];
					return acc;
				},
				{},
			);
			const templateContext = { ...filteredState, ...state.values };

			let outputSegments = renderPromptTemplateSegments(
				finalTemplateStr,
				templateContext,
				state,
			);
			// Callers that assemble the prompt themselves (e.g. the PromptBatcher
			// dispatcher) can pass `params.promptSegments` alongside the flat
			// `params.prompt` to preserve stable/dynamic structure for provider
			// prompt caching. Without this, the whole caller prompt renders as a
			// single segment and volatile content (batched section contexts) can be
			// marked stable, producing cache writes that are never read. The caller
			// segmentation is adopted ONLY when it reproduces the rendered template
			// byte-for-byte, so the prompt text sent to the model is provably
			// unchanged; otherwise (placeholders, template cleaning, optimization
			// hooks rewriting the template) we keep the rendered segmentation.
			const callerPromptSegments = (params as { promptSegments?: unknown })
				.promptSegments;
			if (
				Array.isArray(callerPromptSegments) &&
				callerPromptSegments.length > 0
			) {
				const normalizedCallerSegments: PromptSegment[] = [];
				let callerSegmentsValid = true;
				for (const segment of callerPromptSegments) {
					if (
						typeof segment !== "object" ||
						segment === null ||
						typeof (segment as { content?: unknown }).content !== "string"
					) {
						callerSegmentsValid = false;
						break;
					}
					const typedSegment = segment as PromptSegment;
					normalizedCallerSegments.push({
						content: typedSegment.content,
						stable: Boolean(typedSegment.stable),
						...(typedSegment.ttl === "long" || typedSegment.ttl === "short"
							? { ttl: typedSegment.ttl }
							: {}),
					});
				}
				const renderedOutput = outputSegments
					.map((segment) => segment.content)
					.join("");
				const callerJoined = normalizedCallerSegments
					.map((segment) => segment.content)
					.join("");
				if (callerSegmentsValid && callerJoined === renderedOutput) {
					outputSegments = mergePromptSegments(normalizedCallerSegments);
				} else if (RUNTIME_DEBUG_LOG_ENABLED) {
					this.runtime.logger.debug(
						"dynamicPromptExecFromState: caller promptSegments do not reproduce the rendered prompt; using template segmentation",
					);
				}
			}
			const output = outputSegments.map((segment) => segment.content).join("");

			// Process format options
			const format: StructuredResponseFormat = resolveDefaultOutputFormat(
				this.runtime.getSetting("PROMPT_OUTPUT_FORMAT"),
			);

			/**
			 * Rough token count estimate for logging/debugging purposes only.
			 *
			 * NOTE: This is a heuristic approximation, not an accurate tokenizer.
			 * Modern LLMs use subword tokenization (BPE, WordPiece, SentencePiece)
			 * where actual token counts vary significantly by model and content.
			 *
			 * The 1.3x multiplier accounts for:
			 * - Subword splitting of longer/uncommon words
			 * - Punctuation and special characters as separate tokens
			 * - Whitespace handling differences
			 *
			 * For accurate counts, use model-specific tokenizers (e.g., tiktoken).
			 * This estimate is sufficient for logging and rough capacity planning.
			 */
			const estToken = (text: string) => {
				const words = text
					.trim()
					.split(/\s+|\b/)
					.filter((w) => /\w+/.test(w));
				return Math.ceil(words.length * 1.3);
			};

			// estToken scans the full multi-KB output; only run it when the debug
			// log it feeds would actually be emitted.
			if (RUNTIME_DEBUG_LOG_ENABLED) {
				this.runtime.logger.debug(
					`dynamicPromptExecFromState: using format ${format}, ~${estToken(output).toLocaleString()} tokens`,
				);
			}

			// Set context level on first iteration
			if (currentRetry === 0) {
				contextLevel = options.contextCheckLevel ?? defaultContextCheckLevel;

				// Generate per-field validation codes for levels 0-1
				if (contextLevel <= 1) {
					for (const row of schema) {
						const defaultValidate = contextLevel === 1;
						const needsValidation = row.validateField ?? defaultValidate;
						if (needsValidation) {
							perFieldCodes.set(row.field, promptCode());
						}
					}
				}

				const streamFields = resolveDynamicPromptStreamFields(schema);
				if (
					streamFields.length > 0 &&
					(options.onStreamChunk || options.onStreamEvent)
				) {
					extractor = new StructuredFieldStreamExtractor({
						level: contextLevel,
						schema,
						streamFields,
						...(options.abortSignal
							? { abortSignal: options.abortSignal }
							: {}),
						onChunk: (chunk, _field, accumulated, streamRevision) => {
							enqueueStructuredPromptDelivery(() =>
								options.onStreamChunk?.(
									chunk,
									undefined,
									accumulated,
									streamRevision,
								),
							);
						},
						onEvent: (event) => {
							enqueueStructuredPromptDelivery(() =>
								options.onStreamEvent?.(event, undefined),
							);
						},
					});
				}
			}

			// Optional checkpoint codes: level 2+ gets first codes, level 3 gets both.
			const first = checkpointCodesEnabled && contextLevel >= 2;
			const last = checkpointCodesEnabled && contextLevel >= 3;

			// Build extended schema with validation codes
			const extSchema: Array<{
				field: string;
				description: string;
				required?: boolean;
			}> = [];

			const codesSchema = (prefix: string) => [
				{
					field: `${prefix}initial_code`,
					description: "echo the initial prompt code",
				},
				{
					field: `${prefix}middle_code`,
					description: "echo the middle prompt code",
				},
				{
					field: `${prefix}end_code`,
					description: "echo the end prompt code",
				},
			];

			if (first) {
				extSchema.push(...codesSchema("one_"));
			}

			// Add schema fields with per-field codes for levels 0-1
			for (const row of schema) {
				const fieldCode = perFieldCodes.get(row.field);
				if (fieldCode) {
					extSchema.push({
						field: `code_${row.field}_start`,
						description: `output exactly: ${fieldCode}`,
					});
				}
				extSchema.push(row);
				if (fieldCode) {
					extSchema.push({
						field: `code_${row.field}_end`,
						description: `output exactly: ${fieldCode}`,
					});
				}
			}

			if (last) {
				extSchema.push(...codesSchema("two_"));
			}

			// Generate prompt with format example
			const EXAMPLE = renderJsonSchemaExample(schema);
			const VALIDATION_INSTRUCTIONS = buildValidationOutputInstructions({
				format,
				schema,
				perFieldCodes,
				includeFirstCheckpoint: first,
				includeLastCheckpoint: last,
			});

			const initCode = checkpointCodesEnabled ? promptCode() : "";
			const midCode = checkpointCodesEnabled ? promptCode() : "";
			const finalCode = checkpointCodesEnabled ? promptCode() : "";

			// Check for smart retry context (set by previous retry iteration)
			const smartRetryContextRaw = (state as Record<string, unknown>)
				._smartRetryContext;
			const smartRetryContext =
				typeof smartRetryContextRaw === "string"
					? smartRetryContextRaw.trim()
					: "";

			const section_start = "# Strict Output instructions";
			const section_end = "";

			const variableSegments = joinPromptSegmentGroups([
				checkpointCodesEnabled
					? [{ content: `initial code: ${initCode}`, stable: false }]
					: [],
				outputSegments,
				smartRetryContext
					? [{ content: smartRetryContext, stable: false }]
					: [],
				checkpointCodesEnabled
					? [{ content: `middle code: ${midCode}`, stable: false }]
					: [],
			]).concat({ content: "\n", stable: false });
			// Prompt cache hints: build segments so providers can cache the stable prefix.
			// WHY: We only mark content stable when it is identical across calls for the same
			// schema/character. VALIDATION_INSTRUCTIONS contains per-call UUIDs (perFieldCodes,
			// checkpoint codes), so it must be in an unstable segment; otherwise provider caches
			// would never hit. Format instructions and example (same for same schema) are stable.
			const formatStablePrefix =
				section_start +
				`\nReturn only ${format}. No prose before or after it. No <think>.

`;
			const formatStableSuffix = `
Use this shape:
${EXAMPLE}

Return exactly one JSON object.
${section_end}`;
			const endBlock = checkpointCodesEnabled
				? `\nend code: ${finalCode}\n`
				: "\n";
			// Middle block: validation text when present (unstable); else "\n\n" so prompt string is unchanged.
			const formatMiddleBlock = VALIDATION_INSTRUCTIONS
				? `${VALIDATION_INSTRUCTIONS}\n\n`
				: "\n\n";

			const segments: PromptSegment[] = mergePromptSegments([
				...variableSegments,
				{ content: formatStablePrefix, stable: true },
				{ content: formatMiddleBlock, stable: false },
				{ content: formatStableSuffix, stable: true },
				{ content: endBlock, stable: false },
			]);
			const prompt = segments.map((s) => s.content).join("");

			// Token estimate used for:
			// 1. Debug logging of prompt size
			// 2. Metrics tracking: highestSuccessTokenCount / lowestFailedTokenCount
			//    (useful for identifying token-count-related failure patterns)
			const outputTokenEst = estToken(prompt);
			this.runtime.logger.debug(
				`dynamicPromptExecFromState prompt ~${outputTokenEst.toLocaleString()} tokens`,
			);

			// Pass promptSegments so providers can use cache hints when supported (Anthropic block cache, OpenAI/Gemini prefix).
			// Build the full provider cache plan from the stable-prefix hash so providers like plugin-anthropic and
			// plugin-openrouter can inject cache_control breakpoints without needing a separate planner call.
			const _dynamicPrefixHashes = computePrefixHashes(segments);
			const _dynamicCacheHash =
				computePrefixHashes(cachePrefixSegments(segments)).at(-1)?.hash ??
				"no-context-segments";
			const _callerTools = (params as { tools?: unknown }).tools;
			const _dynamicCachePlan = buildProviderCachePlan({
				prefixHash: _dynamicCacheHash,
				segmentHashes: _dynamicPrefixHashes.map((e) => e.segmentHash),
				promptSegments: segments,
				// Providers with tool-aware cache policies (Gemini disables explicit
				// caching when tools are present; Anthropic reserves a breakpoint for
				// the tools array) need to know whether this call carries tools.
				hasTools: Array.isArray(_callerTools)
					? _callerTools.length > 0
					: typeof _callerTools === "object" && _callerTools !== null
						? Object.keys(_callerTools).length > 0
						: false,
			});
			// Deep-merge caller-supplied providerOptions with the cache plan. See
			// mergeProviderOptionsWithCachePlan for the full merging semantics.
			const _rawCallerProviderOptions = (
				params as { providerOptions?: unknown }
			).providerOptions;
			const _callerProviderOptions =
				_rawCallerProviderOptions != null &&
				typeof _rawCallerProviderOptions === "object" &&
				!Array.isArray(_rawCallerProviderOptions)
					? (_rawCallerProviderOptions as Record<
							string,
							JsonValue | object | undefined
						>)
					: undefined;
			const _planProviderOptions = _dynamicCachePlan.providerOptions;
			const _mergedProviderOptions = mergeProviderOptionsWithCachePlan(
				{ agentName: this.runtime.character.name },
				_callerProviderOptions,
				_planProviderOptions,
			);
			const modelParams = {
				...params,
				prompt,
				responseFormat: params.responseFormat ?? { type: "json_object" },
				promptSegments: segments,
				providerOptions: _mergedProviderOptions,
				...(extractor
					? {
							onStreamChunk: (chunk: string) => {
								extractor?.push(chunk);
							},
						}
					: {}),
			};

			// Check for cancellation before request
			if (options.abortSignal?.aborted) {
				extractor?.signalError("Cancelled by user");
				await drainStructuredPromptDelivery();
				delete (state as Record<string, unknown>)._smartRetryContext;
				this.clearStructuredOutputFailureState(state);
				return null;
			}

			let response: string;
			try {
				response = await runWithStreamingContext(undefined, () =>
					this.runtime.useModel(resolvedModelType, modelParams, options.model),
				);
			} catch (modelError) {
				// error-policy:J4 Structured generation retries transient model
				// failures and records an explicit failure state on exhaustion.
				const modelErrorMessage = getErrorMessage(modelError);
				const isTransientFailure = isTransientModelError(modelError);
				// useModel has already tried the configured provider chain. A schema
				// reroll cannot repair exhausted capacity and only repeats that chain.
				const capacityExhausted = isRateLimitError(modelError);
				const willRetry = !capacityExhausted && currentRetry + 1 <= maxRetries;
				const failureMessage = isTransientFailure
					? `Model call failed transiently${willRetry ? ", retrying" : ""}: ${modelErrorMessage}`
					: `Model call failed: ${modelErrorMessage}`;
				if (isTransientFailure) {
					this.runtime.logger.warn(failureMessage);
				} else {
					this.runtime.logger.error(failureMessage);
				}
				lastStructuredFailure = {
					source: "dynamicPromptExecFromState",
					kind: "model_error",
					model: String(modelIdentifier),
					format,
					schemaFields: flattenedSchema.map((row) => row.field),
					attempts: currentRetry + 1,
					maxRetries,
					timestamp: Date.now(),
					key: options.key ?? modelSchemaKey,
					parseError: modelErrorMessage,
					issues: [
						"Model call failed before a structured response could be validated.",
					],
				};
				currentRetry++;

				if (options.abortSignal?.aborted) {
					extractor?.signalError("Cancelled by user");
					await drainStructuredPromptDelivery();
					delete (state as Record<string, unknown>)._smartRetryContext;
					this.clearStructuredOutputFailureState(state);
					return null;
				}

				if (capacityExhausted) break;

				if (currentRetry <= maxRetries) {
					// Apply retry backoff for model errors
					if (options.retryBackoff) {
						const delayMs = this.calculateBackoffDelay(
							options.retryBackoff,
							currentRetry,
						);
						this.runtime.logger.debug(
							`Retry backoff: waiting ${delayMs}ms before retry ${currentRetry}`,
						);

						// Abortable sleep - check signal during wait, not just after
						const aborted = await this.abortableSleep(
							delayMs,
							options.abortSignal,
						);
						if (aborted) {
							extractor?.signalError("Cancelled by user");
							await drainStructuredPromptDelivery();
							delete (state as Record<string, unknown>)._smartRetryContext;
							this.clearStructuredOutputFailureState(state);
							return null;
						}
					}

					// Signal retry to extractor if it exists
					if (extractor) {
						await drainStructuredPromptDelivery();
						extractor.signalRetry(currentRetry);
						extractor.reset();
					}
				}
				continue;
			}

			// Clean response (remove <think> blocks)
			const cleanResponse = response.replace(/<think>[\s\S]*?<\/think>/g, "");

			let responseContent: Record<string, unknown> | null = null;
			let parseErrorMessage: string | undefined;
			const validationIssues: string[] = [];
			try {
				responseContent = parseStructuredResponse(
					cleanResponse,
					format,
					this.runtime.logger,
				);
				this.runtime.logger.debug(
					`dynamicPromptExecFromState parsed: ${JSON.stringify(responseContent)}`,
				);
			} catch (e) {
				// error-policy:J3 Model output is untrusted input; parse failure
				// becomes an explicit invalid attempt for schema retry.
				parseErrorMessage = e instanceof Error ? e.message : String(e);
				this.runtime.logger.error(
					`dynamicPromptExecFromState parse error: ${parseErrorMessage}`,
				);
			}

			responseContent = normalizeStructuredResponse(responseContent);

			// Validate response
			let allGood = true;
			let schemaValidation: { missingPaths: string[]; invalidPaths: string[] } =
				{
					missingPaths: [],
					invalidPaths: [],
				};
			if (!responseContent) {
				validationIssues.push(
					"No structured output could be parsed from the model response.",
				);
				this.runtime.logger.warn(
					`dynamicPromptExecFromState parse problem: ${cleanResponse}`,
				);
				allGood = false;
			} else {
				// Validate codes based on context level
				if (contextLevel <= 1) {
					// Per-field validation
					for (const [field, expectedCode] of perFieldCodes) {
						const startCodeField = `code_${field}_start`;
						const endCodeField = `code_${field}_end`;
						const startCode = responseContent[startCodeField];
						const endCode = responseContent[endCodeField];

						if (startCode !== expectedCode || endCode !== expectedCode) {
							validationIssues.push(
								`Per-field validation failed for ${field}.`,
							);
							this.runtime.logger.warn(
								`Per-field validation failed for ${field}: expected=${expectedCode}, start=${startCode}, end=${endCode}`,
							);
							allGood = false;
						}

						delete responseContent[startCodeField];
						delete responseContent[endCodeField];
					}
				} else {
					// Checkpoint validation
					const validationCodes: [string, string][] = [
						...(first
							? [
									["one_initial_code", initCode] as [string, string],
									["one_middle_code", midCode] as [string, string],
									["one_end_code", finalCode] as [string, string],
								]
							: []),
						...(last
							? [
									["two_initial_code", initCode] as [string, string],
									["two_middle_code", midCode] as [string, string],
									["two_end_code", finalCode] as [string, string],
								]
							: []),
					];

					for (const [field, expected] of validationCodes) {
						if (responseContent[field] !== expected) {
							validationIssues.push(
								`Checkpoint validation failed for ${field}.`,
							);
							this.runtime.logger.warn(
								`Checkpoint ${field} mismatch: expected ${expected}`,
							);
							allGood = false;
						}
					}

					if (first) {
						delete responseContent.one_initial_code;
						delete responseContent.one_middle_code;
						delete responseContent.one_end_code;
					}
					if (last) {
						delete responseContent.two_initial_code;
						delete responseContent.two_middle_code;
						delete responseContent.two_end_code;
					}
				}

				schemaValidation = validateResponseAgainstSchema(
					responseContent,
					schema,
				);
				if (
					schemaValidation.missingPaths.length > 0 ||
					schemaValidation.invalidPaths.length > 0
				) {
					if (schemaValidation.missingPaths.length > 0) {
						validationIssues.push(
							`Missing required schema paths: ${schemaValidation.missingPaths.join(", ")}`,
						);
						this.runtime.logger.warn(
							`Missing required schema paths: ${schemaValidation.missingPaths.join(", ")}`,
						);
					}
					if (schemaValidation.invalidPaths.length > 0) {
						validationIssues.push(
							`Invalid schema paths: ${schemaValidation.invalidPaths.join(", ")}`,
						);
						this.runtime.logger.warn(
							`Invalid schema paths: ${schemaValidation.invalidPaths.join(", ")}`,
						);
					}
					allGood = false;
				}

				// Validate required fields
				if (options.requiredFields && options.requiredFields.length > 0) {
					const isMissingField = (value: unknown): boolean => {
						if (value === undefined || value === null) return true;
						if (typeof value === "string") return value.trim().length === 0;
						if (Array.isArray(value)) return value.length === 0;
						if (typeof value === "object")
							return Object.keys(value).length === 0;
						return false;
					};

					const missingFields = options.requiredFields.filter(
						(field) =>
							!responseContent ||
							!(field in responseContent) ||
							isMissingField(responseContent[field]),
					);
					if (missingFields.length > 0) {
						validationIssues.push(
							`Missing required fields: ${missingFields.join(", ")}`,
						);
						this.runtime.logger.warn(
							`Missing required fields: ${missingFields.join(", ")}`,
						);
						allGood = false;
					}
				}
			}

			// Update metrics
			metric.totalAttempts++;

			if (allGood && responseContent) {
				// Success - flush buffered content for levels 2-3
				if (extractor) {
					extractor.flush();
				}
				await drainStructuredPromptDelivery();

				metric.successfulAttempts++;
				if (
					metric.highestSuccessTokenCount === null ||
					outputTokenEst > metric.highestSuccessTokenCount
				) {
					metric.highestSuccessTokenCount = outputTokenEst;
				}
				metric.lastUpdated = Date.now();

				this.runtime.logger.debug(
					`dynamicPromptExecFromState success [${modelSchemaKey}]: ${outputTokenEst} tokens`,
				);

				// Clean up smart retry context from state
				delete (state as Record<string, unknown>)._smartRetryContext;

				if (optimizationHooks && traceModelId && tracePromptKey) {
					try {
						const scoreCard = new ScoreCard();
						scoreCard.add({
							source: "dpe",
							kind: "parseSuccess",
							value: 1.0,
							reason: "Structured output parsed successfully",
						});
						const schemaOk =
							schemaValidation.missingPaths.length === 0 &&
							schemaValidation.invalidPaths.length === 0;
						scoreCard.add({
							source: "dpe",
							kind: "schemaValid",
							value: schemaOk ? 1.0 : 0.0,
							reason: schemaOk
								? "Response matched schema paths"
								: `Schema issues: missing [${schemaValidation.missingPaths.join(", ")}]; invalid [${schemaValidation.invalidPaths.join(", ")}]`,
						});
						scoreCard.add({
							source: "dpe",
							kind: "retriesUsed",
							value: Math.max(0, 1.0 - currentRetry / Math.max(maxRetries, 1)),
							reason: `Succeeded on attempt ${currentRetry + 1} of ${maxRetries + 1}`,
						});
						scoreCard.add({
							source: "dpe",
							kind: "tokenEfficiency",
							value: Math.min(1.0, 500 / Math.max(outputTokenEst, 1)),
							reason: `Estimated output tokens ${outputTokenEst} vs reference 500`,
						});

						const templateHashInput =
							typeof params.prompt === "string"
								? params.prompt
								: tracePromptKey;
						const computedTemplateHash = shortStringHash(templateHashInput);

						const trace: ExecutionTrace = {
							id: uuidv4(),
							traceVersion: 1,
							type: "trace",
							promptKey: tracePromptKey,
							modelSlot: resolvedModelType,
							modelId: traceModelId,
							runId: this.runtime.getCurrentRunId(),
							templateHash: computedTemplateHash,
							schemaFingerprint: schemaKey,
							artifactVersion: traceArtifactVersion,
							variant: traceVariant,
							parseSuccess: true,
							schemaValid:
								schemaValidation.missingPaths.length === 0 &&
								schemaValidation.invalidPaths.length === 0,
							validationCodesMatched: true,
							retriesUsed: currentRetry,
							tokenEstimate: outputTokenEst,
							latencyMs: Date.now() - traceStartTime,
							response: responseContent,
							scoreCard: scoreCard.toJSON(),
							createdAt: Date.now(),
						};

						this.promptTraces.record(trace);

						void optimizationHooks
							.persistRegistryEntry(this.runtime, {
								promptKey: tracePromptKey,
								schemaFingerprint: schemaKey,
								templateHash: computedTemplateHash,
								promptTemplate:
									typeof params.prompt === "string" ? params.prompt : "",
								schema: JSON.parse(JSON.stringify(schema)) as SchemaRow[],
							})
							.catch((err) => {
								// error-policy:J7 Optimization registries are diagnostic.
								this.runtime.logger.warn(
									{ error: err, src: "dpe" },
									"Failed to write prompt optimization registry",
								);
								this.runtime.reportError(
									"AgentRuntime.promptOptimizationRegistry",
									err,
									{ promptKey: tracePromptKey },
								);
							});
						void optimizationHooks
							.appendBaselineTrace(this.runtime, { trace })
							.catch((err) => {
								// error-policy:J7 Optimization traces are diagnostic.
								this.runtime.logger.warn(
									"Failed to write optimization trace",
									err,
								);
								this.runtime.reportError(
									"AgentRuntime.promptOptimizationTrace",
									err,
									{
										promptKey: tracePromptKey,
									},
								);
							});
					} catch (traceErr) {
						// error-policy:J7 Optimization traces are diagnostic and
						// cannot change an otherwise valid structured response.
						this.runtime.logger.warn(
							{ error: traceErr },
							"Failed to build optimization trace",
						);
						this.runtime.reportError(
							"AgentRuntime.buildPromptOptimizationTrace",
							traceErr,
							{ promptKey: tracePromptKey },
						);
					}
				}

				this.clearStructuredOutputFailureState(state);
				return responseContent;
			}

			lastStructuredFailure = {
				source: "dynamicPromptExecFromState",
				kind: !responseContent
					? parseErrorMessage
						? "parse_error"
						: "parse_problem"
					: "validation_error",
				model: String(modelIdentifier),
				format,
				schemaFields: flattenedSchema.map((row) => row.field),
				attempts: currentRetry + 1,
				maxRetries,
				timestamp: Date.now(),
				key: options.key ?? modelSchemaKey,
				parseError: parseErrorMessage,
				issues: validationIssues,
				responsePreview: this.runtime
					.redactSecrets(cleanResponse)
					.slice(0, StructuredPromptExecutor.STRUCTURED_FAILURE_PREVIEW_LIMIT),
			};

			// Failure - update metrics
			metric.failedAttempts++;
			if (
				metric.lowestFailedTokenCount === null ||
				outputTokenEst < metric.lowestFailedTokenCount
			) {
				metric.lowestFailedTokenCount = outputTokenEst;
			}

			currentRetry++;

			if (options.abortSignal?.aborted) {
				extractor?.signalError("Cancelled by user");
				await drainStructuredPromptDelivery();
				delete (state as Record<string, unknown>)._smartRetryContext;
				this.clearStructuredOutputFailureState(state);
				return null;
			}

			if (currentRetry <= maxRetries) {
				// Apply retry backoff
				if (options.retryBackoff) {
					const delayMs = this.calculateBackoffDelay(
						options.retryBackoff,
						currentRetry,
					);
					this.runtime.logger.debug(
						`Retry backoff: waiting ${delayMs}ms before retry ${currentRetry}`,
					);

					// Abortable sleep - check signal during wait, not just after
					const aborted = await this.abortableSleep(
						delayMs,
						options.abortSignal,
					);
					if (aborted) {
						extractor?.signalError("Cancelled by user");
						await drainStructuredPromptDelivery();
						delete (state as Record<string, unknown>)._smartRetryContext;
						this.clearStructuredOutputFailureState(state);
						return null;
					}
				}

				// Signal retry to extractor
				let smartRetryContextNext: string | undefined;
				if (extractor) {
					await drainStructuredPromptDelivery();
					const { validatedFields } = extractor.signalRetry(currentRetry);
					const diagnosis = extractor.diagnose();

					this.runtime.logger.warn(
						`dynamicPromptExecFromState retry ${currentRetry}/${maxRetries}`,
						`validated=${validatedFields.join(",") || "none"}`,
						`missing=${diagnosis.missingFields.join(",") || "none"}`,
					);

					// For level 1, build smart retry context
					if (contextLevel === 1 && validatedFields.length > 0) {
						const validatedContent = extractor.getValidatedFields();
						const validatedParts: string[] = [];
						for (const [field, content] of validatedContent) {
							const wellFormedContent = toWellFormedUnicode(content);
							validatedParts.push(
								stringifyForModel({ [field]: wellFormedContent }),
							);
						}
						if (validatedParts.length > 0) {
							smartRetryContextNext = `\n\n[RETRY CONTEXT]\nYou previously produced these valid fields:\n${validatedParts.join("\n")}\n\nPlease complete: ${diagnosis.missingFields.concat(diagnosis.invalidFields, diagnosis.incompleteFields).join(", ") || "all fields"}`;
						}
					}

					extractor.reset();
				}

				// Repair reroll: when the extractor didn't produce a targeted retry
				// context (the common case — contextLevel 2, no streaming extractor,
				// or no validated fields), feed the model the CONCRETE reason its last
				// output was rejected + the complete redacted bad output, so the
				// reroll is corrective instead of a blind re-roll of the same prompt.
				// Goes in the same `_smartRetryContext` field, which is rendered as a
				// `stable:false` segment (prompt-cache safe) and cleared on
				// success/abort. Correctness-neutral: it only changes the prompt of a
				// retry that was already going to run; it never skips a validation.
				if (!smartRetryContextNext) {
					const repairIssues =
						validationIssues.length > 0
							? validationIssues
							: parseErrorMessage
								? [parseErrorMessage]
								: [];
					if (repairIssues.length > 0) {
						const priorOutput = toWellFormedUnicode(
							this.runtime.redactSecrets(cleanResponse),
						);
						const issueList = repairIssues
							.map((issue) => `- ${issue}`)
							.join("\n");
						smartRetryContextNext = `\n\n[REPAIR] Your previous response was rejected because it did not satisfy the required schema. Fix exactly these problems and return a corrected response:\n${issueList}${
							priorOutput
								? `\n\nYour previous (invalid) output was:\n${priorOutput}`
								: ""
						}`;
					}
				}

				if (smartRetryContextNext) {
					(state as Record<string, unknown>)._smartRetryContext =
						smartRetryContextNext;
				}
			}
		}

		// Retries exhausted, or the provider chain cannot currently serve a call.
		const retriesUsed = Math.max(
			0,
			(lastStructuredFailure?.attempts ?? currentRetry) - 1,
		);
		if (extractor) {
			const diagnosis = extractor.diagnose();
			const diagnosticParts: string[] = [];
			if (diagnosis.missingFields.length > 0) {
				diagnosticParts.push(`missing: ${diagnosis.missingFields.join(", ")}`);
			}
			if (diagnosis.invalidFields.length > 0) {
				diagnosticParts.push(`invalid: ${diagnosis.invalidFields.join(", ")}`);
			}
			if (diagnosis.incompleteFields.length > 0) {
				diagnosticParts.push(
					`partial: ${diagnosis.incompleteFields.join(", ")}`,
				);
			}
			extractor.signalError(
				`Failed after ${retriesUsed} retries. ${diagnosticParts.length > 0 ? diagnosticParts.join("; ") : "unknown error"}`,
			);
		}
		await drainStructuredPromptDelivery();

		const finalFailureMessage = `dynamicPromptExecFromState failed after ${retriesUsed} retries [${modelSchemaKey}]`;
		const finalFailureSummary = `${metric.successfulAttempts}/${metric.totalAttempts} successful`;
		if (
			lastStructuredFailure?.kind === "model_error" &&
			isTransientModelError(lastStructuredFailure.parseError)
		) {
			this.runtime.logger.warn(finalFailureMessage, finalFailureSummary);
		} else {
			this.runtime.logger.error(finalFailureMessage, finalFailureSummary);
		}

		if (optimizationHooks && traceModelId && tracePromptKey) {
			try {
				this.promptTraces.purgeStaleActiveTraces();

				const scoreCard = new ScoreCard();
				scoreCard.add({
					source: "dpe",
					kind: "parseSuccess",
					value: 0.0,
					reason: `No valid parse after ${retriesUsed} retries`,
				});
				scoreCard.add({
					source: "dpe",
					kind: "schemaValid",
					value: 0.0,
					reason: "Parse or validation never succeeded",
				});
				scoreCard.add({
					source: "dpe",
					kind: "retriesUsed",
					value: 0.0,
					reason:
						retriesUsed < maxRetries
							? "Provider capacity exhausted"
							: "All retry attempts exhausted",
				});

				const failTemplateHash = shortStringHash(
					typeof params.prompt === "string" ? params.prompt : tracePromptKey,
				);

				const trace: ExecutionTrace = {
					id: uuidv4(),
					traceVersion: 1,
					type: "trace",
					promptKey: tracePromptKey,
					modelSlot: resolvedModelType,
					modelId: traceModelId,
					runId: this.runtime.getCurrentRunId(),
					templateHash: failTemplateHash,
					schemaFingerprint: schemaKey,
					artifactVersion: traceArtifactVersion,
					variant: traceVariant,
					parseSuccess: false,
					schemaValid: false,
					validationCodesMatched: false,
					retriesUsed,
					tokenEstimate: 0,
					latencyMs: Date.now() - traceStartTime,
					scoreCard: scoreCard.toJSON(),
					createdAt: Date.now(),
				};

				void optimizationHooks
					.persistRegistryEntry(this.runtime, {
						promptKey: tracePromptKey,
						schemaFingerprint: schemaKey,
						templateHash: failTemplateHash,
						promptTemplate:
							typeof params.prompt === "string" ? params.prompt : "",
						schema: JSON.parse(JSON.stringify(schema)) as SchemaRow[],
					})
					.catch((err) => {
						// error-policy:J7 Optimization registries are diagnostic.
						this.runtime.logger.warn(
							{ error: err, src: "dpe" },
							"Failed to write prompt optimization registry",
						);
						this.runtime.reportError(
							"AgentRuntime.promptOptimizationRegistry",
							err,
							{
								promptKey: tracePromptKey,
							},
						);
					});
				void optimizationHooks
					.appendFailureTrace(this.runtime, { trace })
					.catch((err) => {
						// error-policy:J7 Optimization traces are diagnostic.
						this.runtime.logger.warn("Failed to write failure trace", err);
						this.runtime.reportError(
							"AgentRuntime.promptOptimizationFailureTrace",
							err,
							{ promptKey: tracePromptKey },
						);
					});
			} catch (traceErr) {
				// error-policy:J7 Failure traces are diagnostic and cannot replace
				// the structured failure already returned to the caller.
				this.runtime.logger.warn(
					{ error: traceErr },
					"Failed to build failure trace",
				);
				this.runtime.reportError(
					"AgentRuntime.buildPromptOptimizationFailureTrace",
					traceErr,
					{ promptKey: tracePromptKey },
				);
			}
		}

		// Clean up smart retry context from state
		delete (state as Record<string, unknown>)._smartRetryContext;
		if (lastStructuredFailure) {
			this.setStructuredOutputFailureState(state, lastStructuredFailure);
		} else {
			this.clearStructuredOutputFailureState(state);
		}
		return null;
	}

	private calculateBackoffDelay(
		config: number | RetryBackoffConfig,
		retryCount: number,
	): number {
		if (typeof config === "number") {
			return config;
		}
		const { initialMs = 1000, multiplier = 2, maxMs = 30000 } = config;
		const delay = initialMs * multiplier ** (retryCount - 1);
		return Math.min(delay, maxMs);
	}

	private abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) return Promise.resolve(true);

		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve(false);
			}, ms);

			const onAbort = () => {
				clearTimeout(timeout);
				resolve(true);
			};

			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
}
