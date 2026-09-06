/** Selects and invokes registered model providers with admission, failover, streaming, and trajectory recording. Handlers receive the original runtime; private lifecycle and prompt collaborators remain explicit host callbacks. */

import { ElizaError } from "../../errors";
import {
	INFERENCE_MARKS,
	type InferenceTimingMeta,
	markInference,
	recordInferenceSpan,
	setInferenceModelProvider,
} from "../../inference-timing";
import {
	collectPiiPromptText,
	GuardedStreamScanner,
	type PseudonymSession,
} from "../../security/index.js";
import type { SecretSwapSession } from "../../security/secret-swap";
import {
	describeModelCallError,
	isElizaCloudGatewayWarmingExhaustedError,
	isModelProviderFallbackError,
} from "../../services/message/fallback-reply";
import {
	getStreamingContext,
	runInsideModelStreamChunkDelivery,
} from "../../streaming-context";
import { getTrajectoryContext } from "../../trajectory-context";
import {
	runInModelCallRecordingScope,
	runWithModelCallRecordingScope,
	type TrajectoryRuntimeLlmCallLogger,
} from "../../trajectory-utils";
import type { ModelHandler } from "../../types";
import {
	EventType,
	type GenerateTextParams,
	getModelFallbackChain,
	type IAgentRuntime,
	type JsonValue,
	MODEL_PROVIDER_ATTEMPTS,
	type ModelAttemptContext,
	type ModelParamsMap,
	type ModelProviderAttempt,
	type ModelRegistrationInfo,
	type ModelRegistrationMetadata,
	type ModelResultMap,
	ModelType,
	type ModelTypeName,
	type ResponseSkeleton,
	type Service,
	type ServiceTypeName,
	type StreamChunkCallback,
	type TextStreamResult,
	type UUID,
} from "../../types";
import {
	modelStreamChunkPipelineHookContext,
	modelStreamEndPipelineHookContext,
	postModelPipelineHookContext,
	preModelPipelineHookContext,
} from "../../types/pipeline-hooks";
import { BufferUtils } from "../../utils/buffer";
import {
	assertModelOutputComplete,
	modelProviderErrorDetail,
} from "../../utils/model-errors";
import { captureModelLookupCaller } from "../../utils/model-lookup-caller";
import { resolveSetting } from "../../utils/resolve-setting";
import { ResponseSkeletonStreamExtractor } from "../../utils/streaming";
import { isPlainObject } from "../../utils/type-guards";
import {
	executeChainWithFallback,
	isLocalHandler,
	maybeReroute,
	resolveChain,
} from "../action-model-routing";
import {
	getActionRoutingContext,
	runWithoutActionRoutingContext,
} from "../action-routing-context";
import { isCanonicalModelCapabilityDisabled } from "../canonical-model-capabilities.ts";
import { stringifyForModel } from "../json-output";
import { RUNTIME_DEBUG_LOG_ENABLED } from "../model-diagnostics.js";
import {
	buildModelInputBudget,
	DEFAULT_INPUT_RESERVE_TOKENS,
	withModelInputBudgetProviderOptions,
} from "../model-input-budget";
import type { RuntimePipelineHooks } from "../pipeline-hooks.js";
import { resolveEffectiveSystemPrompt } from "../system-prompt";
import {
	buildProviderAttributionsFromState,
	canonicalPromptForModelCall,
	omitUnvalidatedProviderSpans,
} from "../trajectory-provider-attribution";
import {
	assertRuntimeModelOutputComplete,
	isTextStreamResult,
	isUnavailableLocalModel,
	NoModelProviderConfiguredError,
	type ResolvedModelRegistration,
	readReasoningTokensFromResponse,
	resolveResponseSkeletonStreamFields,
	TEXT_GENERATION_MODEL_KEYS,
} from "./policy.js";

export interface RuntimeModelDispatchHost {
	models(): Map<string, ModelHandler[]>;
	pinnedEmbeddingProvider(): string | undefined;
	currentRoomId(): UUID | undefined;
	isSecretSwapEnabled(): boolean;
	isPiiSwapEnabled(): boolean;
	hooksForPhase(
		...args: Parameters<RuntimePipelineHooks["hooksForPhase"]>
	): ReturnType<RuntimePipelineHooks["hooksForPhase"]>;
	invokePipelineHooks(
		...args: Parameters<RuntimePipelineHooks["invokePipelineHooks"]>
	): ReturnType<RuntimePipelineHooks["invokePipelineHooks"]>;
	attachEffectiveSystemPrompt(
		modelKey: string,
		params: unknown,
	): string | undefined;
	createSecretSwapSession(): SecretSwapSession;
	createPiiSwapSession(): PseudonymSession;
	collectPromptText(params: unknown, systemPrompt: string | undefined): string;
	initResolver(): ((value?: void | PromiseLike<void>) => void) | undefined;
	_ensureServiceStarted(
		serviceType: ServiceTypeName | string,
	): Promise<Service | null>;
	buildRuntimeSystemPrompt(): string | undefined;
	getFirstUserPromptFromMessages(messages: unknown): string | undefined;
}

export class RuntimeModelDispatch {
	constructor(
		private readonly runtime: IAgentRuntime,
		private readonly host: RuntimeModelDispatchHost,
	) {}

	/**
	 * The provider name that actually served the most recent successful
	 * `useModel` call for each model type key. Populated the moment a
	 * registration answers (before any streaming/return path), so a caller that
	 * cannot see `useModel`'s internal resolution — e.g. the messageHandler /
	 * factsAndRelationships trajectory stage recorders in `services/message.ts`,
	 * which previously hardcoded the provider as the literal `"default"` — can
	 * read the real provider that answered instead of fabricating one (#13623).
	 * Keyed by the REQUESTED model type string so the recorder for a
	 * RESPONSE_HANDLER / TEXT_LARGE stage reads the provider for that stage's
	 * call, not some other model type's.
	 */
	lastResolvedModelProviderByType = new Map<string, string>();

	registerModel(
		modelType: ModelTypeName | string,
		handler: (
			runtime: IAgentRuntime,
			params: Record<string, JsonValue | object>,
		) => Promise<JsonValue | object>,
		provider: string,
		priority?: number,
		metadata?: ModelRegistrationMetadata,
	): void {
		const modelKey = String(modelType);
		if (this.isCanonicalModelCapabilityDisabled(modelKey)) {
			this.runtime.logger.debug(
				{
					src: "agent",
					agentId: this.runtime.agentId,
					modelType: modelKey,
					provider,
				},
				"Ignoring model registration for a capability omitted from canonical service routing",
			);
			return;
		}
		if (!this.host.models().has(modelKey)) {
			this.host.models().set(modelKey, []);
		}

		const registrationOrder = Date.now();
		const modelsArray = this.host.models().get(modelKey);
		if (modelsArray) {
			modelsArray.push({
				handler,
				metadata,
				provider,
				priority: priority || 0,
				registrationOrder,
			});
			modelsArray.sort((a, b) => {
				if ((b.priority || 0) !== (a.priority || 0)) {
					return (b.priority || 0) - (a.priority || 0);
				}
				return (a.registrationOrder || 0) - (b.registrationOrder || 0);
			});
		}

		// Announce the registration so observers (e.g. the local-inference
		// routing table) can mirror the model registry without patching the
		// runtime or capturing handlers. Fire-and-forget: a no-op when nothing
		// is subscribed, and registry bookkeeping must never block boot.
		void this.runtime.emitEvent(EventType.MODEL_REGISTERED, {
			runtime: this.runtime,
			source: "runtime",
			modelType: modelKey,
			metadata,
			provider,
			priority: priority || 0,
		});
	}

	/**
	 * Handler-free snapshot of every registered model handler, sorted by
	 * priority (descending) then registration order within each model type —
	 * the same order `getModel`/`useModel` select in. Exposes the private
	 * `models` map as metadata so hosts and observers can render a routing
	 * table or seed a mirror without touching handler functions. Pair with the
	 * {@link EventType.MODEL_REGISTERED} event to stay live.
	 */
	getModelRegistrations(): ModelRegistrationInfo[] {
		const out: ModelRegistrationInfo[] = [];
		for (const [modelType, handlers] of this.host.models()) {
			for (const h of handlers) {
				out.push({
					modelType,
					metadata: h.metadata,
					provider: h.provider,
					priority: h.priority || 0,
					registrationOrder: h.registrationOrder || 0,
				});
			}
		}
		return out;
	}

	/**
	 * The runtime-selected text-model provider, or undefined to use the default
	 * (highest-priority) handler. Read from `ELIZA_BRAIN_PROVIDER` so an owner
	 * action that mutates `character.settings` (and/or persists it to config)
	 * flips the chat brain on the next model call with no restart. Returns
	 * undefined when the setting is empty OR names a provider that has no
	 * registered text handler, so a stale or mistyped value never strands the
	 * brain — it simply falls back to the default provider. The same contract
	 * holds at call time: useModel keeps the default-chain registrations behind
	 * the override as a failover tail, so a rate-limited/exhausted override
	 * provider falls to the registered backups instead of stranding the brain.
	 */
	/**
	 * Record the provider that served a successful `useModel` call, keyed by the
	 * requested model-type string. Only real (non-empty) provider names are
	 * stored so a caller reading it back never sees a fabricated value (#13623).
	 */
	noteResolvedModelProvider(
		modelTypeKey: string,
		provider: string | undefined,
	): void {
		if (typeof provider === "string" && provider.trim().length > 0) {
			this.lastResolvedModelProviderByType.set(modelTypeKey, provider);
		}
	}

	/**
	 * The provider name that served the most recent successful `useModel` call
	 * for the given model type, or `undefined` if no such call has completed
	 * (so callers can fail-closed rather than fabricate a provider). Lets the
	 * trajectory stage recorders in `services/message.ts` name the real provider
	 * that answered the messageHandler / factsAndRelationships call instead of
	 * the hardcoded `"default"` literal (#13623).
	 */
	getLastResolvedModelProvider(
		modelType: ModelTypeName | string,
	): string | undefined {
		return this.lastResolvedModelProviderByType.get(String(modelType));
	}

	resolveTextProviderOverride(): string | undefined {
		const raw = this.runtime.getSetting("ELIZA_BRAIN_PROVIDER");
		const override = typeof raw === "string" ? raw.trim() : "";
		if (!override) return undefined;
		return override;
	}

	isCanonicalModelCapabilityDisabled(modelType: string): boolean {
		return isCanonicalModelCapabilityDisabled(this.runtime, modelType);
	}

	assertCanonicalModelCapabilityEnabled(modelType: string): void {
		if (!this.isCanonicalModelCapabilityDisabled(modelType)) return;
		const capability = TEXT_GENERATION_MODEL_KEYS.includes(modelType)
			? "llmText"
			: "embeddings";
		throw new NoModelProviderConfiguredError(
			`Canonical service routing does not configure the ${capability} capability. Add serviceRouting.${capability} before requesting ${modelType}.`,
			"capability-disabled",
		);
	}

	resolveModelRegistration(
		modelType: ModelTypeName | string,
		provider?: string,
	): ResolvedModelRegistration | undefined {
		return this.resolveModelRegistrations(modelType, provider)[0];
	}

	resolveModelRegistrations(
		modelType: ModelTypeName | string,
		provider?: string,
	): ResolvedModelRegistration[] {
		const requestedModelKey = String(modelType);
		if (this.isCanonicalModelCapabilityDisabled(requestedModelKey)) {
			return [];
		}
		const resolvedModels: ResolvedModelRegistration[] = [];

		for (const candidateKey of getModelFallbackChain(requestedModelKey)) {
			const models = this.host.models().get(candidateKey);
			if (!models?.length) {
				continue;
			}

			const modelWithProvider =
				provider && models.find((model) => model.provider === provider);
			const candidateModels = provider
				? modelWithProvider
					? [modelWithProvider]
					: []
				: models;

			for (const resolvedModel of candidateModels) {
				if (candidateKey !== requestedModelKey) {
					this.runtime.logger.debug(
						{
							src: "agent",
							agentId: this.runtime.agentId,
							requestedModel: requestedModelKey,
							resolvedModel: candidateKey,
							provider: resolvedModel.provider,
						},
						"Model fallback applied",
					);
				}

				resolvedModels.push({
					handler: resolvedModel.handler,
					metadata: resolvedModel.metadata,
					modelKey: candidateKey,
					provider: resolvedModel.provider,
				});
			}

			if (provider && candidateModels.length > 0) {
				break;
			}
		}

		return resolvedModels;
	}

	logModelProviderFailover(args: {
		requestedModelKey: string;
		failedModel: ResolvedModelRegistration;
		nextModel: ResolvedModelRegistration;
		error: unknown;
	}): void {
		this.runtime.logger.warn(
			{
				src: "agent",
				agentId: this.runtime.agentId,
				requestedModel: args.requestedModelKey,
				failedModel: args.failedModel.modelKey,
				failedProvider: args.failedModel.provider,
				nextModel: args.nextModel.modelKey,
				nextProvider: args.nextModel.provider,
				error:
					args.error instanceof Error ? args.error.message : String(args.error),
			},
			"Model provider failed; trying next registered provider",
		);
	}

	shouldFailOverModelProvider(error: unknown, modelType: string): boolean {
		return isModelProviderFallbackError(error, modelType);
	}

	throwNoModelHandler(requestedModelKey: string): never {
		// If the request is for a text-generation model AND no text-generation
		// handler is registered for ANY of the text model types, this is the
		// "no LLM provider configured at all" state — surface a typed error
		// so callers (chat UI, etc.) can render an actionable hint instead of
		// a generic "No handler found for delegate type" parse-failure message.
		// Issue: elizaOS/eliza#7203.
		if (TEXT_GENERATION_MODEL_KEYS.includes(requestedModelKey)) {
			const hasAnyTextHandler = TEXT_GENERATION_MODEL_KEYS.some((key) => {
				const handlers = this.host.models().get(key);
				return Array.isArray(handlers) && handlers.length > 0;
			});
			if (!hasAnyTextHandler) {
				throw new NoModelProviderConfiguredError();
			}
		}
		throw new Error(`No handler found for delegate type: ${requestedModelKey}`);
	}

	/**
	 * Surface the failure that ends a `useModel` failover chain. A real `Error`
	 * with a message rethrows unchanged so provider SDK stack traces and typed
	 * subclasses (e.g. `NoModelProviderConfiguredError`, which the chat UI
	 * narrows on) survive the boundary. Everything else — the bare
	 * `{ status, error }` objects some providers/AI-SDK paths throw, or a
	 * message-less `Error` — becomes an `ElizaError` whose message names the
	 * provider, HTTP status, and underlying cause. Without this, a bare object
	 * stringified to the diagnostically useless "[object Object]" in logs,
	 * trajectories, and any user-surfaced failure text.
	 */
	rethrowModelFailoverError(
		error: unknown,
		failed?: { modelKey: string; provider: string },
	): never {
		if (error instanceof Error && error.message.trim().length > 0) {
			throw error;
		}
		const detail = describeModelCallError(error);
		const provider = failed?.provider ?? "unknown";
		throw new ElizaError(`Model provider "${provider}" failed: ${detail}`, {
			code: "MODEL_PROVIDER_FAILED",
			cause: error,
			context: { provider: failed?.provider, modelKey: failed?.modelKey },
			severity: "ephemeral",
		});
	}

	getModel(
		modelType: ModelTypeName | string,
	):
		| ((
				runtime: IAgentRuntime,
				params: Record<string, JsonValue | object>,
		  ) => Promise<JsonValue | object>)
		| undefined {
		const requestedModelKey = String(modelType);
		// Keep capability probes aligned with useModel dispatch: once the
		// embedding dimension probe pins a provider, another provider's BATCH
		// handler is not usable because it may emit a different vector width.
		const requestedProvider =
			(requestedModelKey === ModelType.TEXT_EMBEDDING ||
				requestedModelKey === ModelType.TEXT_EMBEDDING_BATCH) &&
			this.host.pinnedEmbeddingProvider() !== undefined
				? this.host.pinnedEmbeddingProvider()
				: undefined;
		const resolvedModel = this.resolveModelRegistration(
			requestedModelKey,
			requestedProvider,
		);
		if (!resolvedModel) {
			return undefined;
		}

		// Return highest priority handler (first in array after sorting)
		return resolvedModel.handler;
	}

	/**
	 * Retrieves model configuration settings from character settings with support for
	 * model-specific overrides and default fallbacks.
	 *
	 * Precedence order (highest to lowest):
	 * 1. Model-specific settings (e.g., TEXT_SMALL_TEMPERATURE)
	 * 2. Default settings (e.g., DEFAULT_TEMPERATURE)
	 *
	 * @param modelType The specific model type to get settings for
	 * @returns Object containing model parameters if they exist, or null if no settings are configured
	 */
	getModelSettings(modelType?: ModelTypeName): Record<string, number> | null {
		const modelSettings: Record<string, number> = {};

		// Helper to get a setting value with fallback chain
		const getSettingWithFallback = (
			param:
				| "MAX_TOKENS"
				| "TEMPERATURE"
				| "TOP_P"
				| "TOP_K"
				| "MIN_P"
				| "SEED"
				| "REPETITION_PENALTY"
				| "FREQUENCY_PENALTY"
				| "PRESENCE_PENALTY",
		): number | null => {
			// Try model-specific setting first
			if (modelType) {
				const modelSpecificKey = `${modelType}_${param}`;
				const modelValue = this.runtime.getSetting(modelSpecificKey);
				if (modelValue !== null && modelValue !== undefined) {
					const numValue = Number(modelValue);
					if (!Number.isNaN(numValue)) {
						return numValue;
					}
				}
			}

			// Fall back to default setting
			const defaultKey = `DEFAULT_${param}`;
			const defaultValue = this.runtime.getSetting(defaultKey);
			if (defaultValue !== null && defaultValue !== undefined) {
				const numValue = Number(defaultValue);
				if (!Number.isNaN(numValue)) {
					return numValue;
				}
			}

			return null;
		};

		// Get settings with proper fallback chain
		const maxTokens = getSettingWithFallback("MAX_TOKENS");
		const temperature = getSettingWithFallback("TEMPERATURE");
		const topP = getSettingWithFallback("TOP_P");
		const topK = getSettingWithFallback("TOP_K");
		const minP = getSettingWithFallback("MIN_P");
		const seed = getSettingWithFallback("SEED");
		const repetitionPenalty = getSettingWithFallback("REPETITION_PENALTY");
		const frequencyPenalty = getSettingWithFallback("FREQUENCY_PENALTY");
		const presencePenalty = getSettingWithFallback("PRESENCE_PENALTY");

		// Add settings if they exist
		if (maxTokens !== null) modelSettings.maxTokens = maxTokens;
		if (temperature !== null) modelSettings.temperature = temperature;
		if (topP !== null) modelSettings.topP = topP;
		if (topK !== null) modelSettings.topK = topK;
		if (minP !== null) modelSettings.minP = minP;
		if (seed !== null) modelSettings.seed = seed;
		if (repetitionPenalty !== null)
			modelSettings.repetitionPenalty = repetitionPenalty;
		if (frequencyPenalty !== null)
			modelSettings.frequencyPenalty = frequencyPenalty;
		if (presencePenalty !== null)
			modelSettings.presencePenalty = presencePenalty;

		// Return null if no settings were configured
		return Object.keys(modelSettings).length > 0 ? modelSettings : null;
	}

	/** Resolve the concrete provider model id used for final-wire budgeting. */
	resolveRegistrationModelName(
		metadata: ModelRegistrationMetadata | undefined,
	): string | undefined {
		if (!metadata) return undefined;
		if (
			typeof metadata.displayModel === "string" &&
			metadata.displayModel.trim()
		) {
			return metadata.displayModel.trim();
		}
		for (const setting of [
			...(metadata.displayModelSettings ?? []),
			metadata.displayModelSetting,
		]) {
			if (!setting) continue;
			const value = resolveSetting(
				{ getSetting: (key: string) => this.runtime.getSetting(key) },
				setting,
			);
			if (value?.trim()) return value.trim();
		}
		if (
			typeof metadata.displayModelDefault === "string" &&
			metadata.displayModelDefault.trim()
		) {
			return metadata.displayModelDefault.trim();
		}
		return undefined;
	}

	/**
	 * Budget the exact text-generation request after runtime transforms and
	 * pre-model hooks. UTF-8 bytes are a conservative token upper bound, so the
	 * runtime can reject before a provider handler without silently rewriting
	 * any model-facing field.
	 */
	buildFinalModelInputBudget(
		params: unknown,
		metadata: ModelRegistrationMetadata | undefined,
	) {
		const record = isPlainObject(params)
			? (params as Record<string, unknown>)
			: {};
		const contextWindowTokens =
			typeof metadata?.contextWindowTokens === "number" &&
			Number.isFinite(metadata.contextWindowTokens)
				? Math.max(1, Math.floor(metadata.contextWindowTokens))
				: undefined;
		const requestedOutputTokens =
			typeof record.maxTokens === "number" &&
			Number.isFinite(record.maxTokens) &&
			record.maxTokens > 0
				? Math.floor(record.maxTokens)
				: 0;
		const requestedModelName =
			typeof record.model === "string" && record.model.trim()
				? record.model.trim()
				: undefined;
		return buildModelInputBudget({
			completeRequest: params,
			messages: Array.isArray(record.messages)
				? (record.messages as GenerateTextParams["messages"])
				: undefined,
			promptSegments: Array.isArray(record.promptSegments)
				? (record.promptSegments as GenerateTextParams["promptSegments"])
				: undefined,
			tools: Array.isArray(record.tools)
				? (record.tools as GenerateTextParams["tools"])
				: undefined,
			system: record.system,
			prompt: record.prompt,
			input: record.input,
			responseSchema: record.responseSchema,
			responseFormat: record.responseFormat,
			grammar: record.grammar,
			responseSkeleton: record.responseSkeleton,
			prefill: record.prefill,
			modelName:
				requestedModelName ??
				(contextWindowTokens === undefined
					? this.resolveRegistrationModelName(metadata)
					: undefined),
			...(contextWindowTokens ? { contextWindowTokens } : {}),
			reserveTokens: Math.max(
				DEFAULT_INPUT_RESERVE_TOKENS,
				requestedOutputTokens,
			),
			estimationMode: "utf8-upper-bound",
		});
	}

	/** Clone caller-owned request data before runtime transforms. Arrays and
	 * plain records become handler-owned; opaque transport collaborators retain
	 * identity because cloning them would change platform semantics. */
	cloneModelRequestGraph<T>(value: T): T {
		const seen = new WeakMap<object, unknown>();
		const clone = (candidate: unknown): unknown => {
			if (candidate === null || typeof candidate !== "object") return candidate;
			const existing = seen.get(candidate);
			if (existing !== undefined) return existing;
			if (Array.isArray(candidate)) {
				const result: unknown[] = [];
				seen.set(candidate, result);
				for (const item of candidate) result.push(clone(item));
				return result;
			}
			// A hostile Proxy may trap prototype reflection. Keep such an opaque
			// value intact here; the descriptor-only secret/PII walkers normalize it
			// later without consulting its prototype.
			try {
				if (!isPlainObject(candidate)) return candidate;
			} catch {
				return candidate;
			}
			const result: Record<string, unknown> = {};
			seen.set(candidate, result);
			for (const [key, nested] of Object.entries(candidate)) {
				result[key] = clone(nested);
			}
			return result;
		};
		return clone(value) as T;
	}

	/** Freeze the complete admitted handler payload so provider code cannot add,
	 * remove, or rewrite model-bound data after the final measurement. Only
	 * arrays and plain records belong to the request graph; platform objects
	 * such as AbortSignal remain opaque transport collaborators. */
	freezeAdmittedModelRequest(value: unknown): void {
		const seen = new WeakSet<object>();
		const visit = (candidate: unknown): void => {
			if (
				candidate === null ||
				(typeof candidate !== "object" && typeof candidate !== "function") ||
				seen.has(candidate as object)
			) {
				return;
			}
			if (!Array.isArray(candidate) && !isPlainObject(candidate)) return;
			seen.add(candidate as object);
			for (const nested of Object.values(
				candidate as Record<string, unknown>,
			)) {
				visit(nested);
			}
			Object.freeze(candidate);
		};
		visit(value);
	}

	logModelCall(
		modelType: string,
		modelKey: string,
		_params: unknown,
		promptContent: string | null,
		systemPrompt: string | undefined,
		elapsedTime: number,
		provider: string | undefined,
		response: unknown,
	): void {
		// Per-turn latency breakdown: attribute this model round-trip to the
		// active inference timer (no-op when none is active). `elapsedTime` is the
		// already-measured handler+stream duration, so every return path that
		// funnels through here is covered exactly once.
		const resolvedProvider =
			provider || this.host.models().get(modelKey)?.[0]?.provider || "unknown";
		// Surface reasoning-token usage on the successful model span so a
		// reasoning burst is attributable per call (#16394). Native results
		// (tool-call shape) carry `.usage`; plain-text results do not, in which
		// case the field is omitted entirely — missing stays missing, never zero.
		const spanMeta: InferenceTimingMeta = {
			modelKey,
			provider: resolvedProvider,
			outcome: "success",
		};
		const reasoningTokens = readReasoningTokensFromResponse(response);
		if (reasoningTokens !== undefined) {
			spanMeta.reasoningTokens = reasoningTokens;
		}
		recordInferenceSpan(`model:${modelType}`, elapsedTime, spanMeta);
		if (modelType !== ModelType.TEXT_EMBEDDING) {
			setInferenceModelProvider(resolvedProvider);
		}
		// Log to database
		const responseValue =
			Array.isArray(response) && response.every((x) => typeof x === "number")
				? "[array]"
				: typeof response === "string"
					? response
					: undefined;
		const trajectoryContext = getTrajectoryContext();
		const logRoomId =
			(trajectoryContext?.roomId as UUID | undefined) ??
			this.host.currentRoomId() ??
			this.runtime.agentId;
		void this.runtime.adapter
			.createLogs([
				{
					entityId: this.runtime.agentId,
					roomId: logRoomId,
					body: {
						modelType,
						modelKey,
						prompt: promptContent ?? undefined,
						systemPrompt,
						runId: this.runtime.getCurrentRunId(),
						timestamp: Date.now(),
						executionTime: elapsedTime,
						provider:
							provider ||
							this.host.models().get(modelKey)?.[0]?.provider ||
							"unknown",
						response: responseValue,
					},
					type: `useModel:${modelKey}`,
				},
			])
			.catch((error) => {
				// error-policy:J7 Model-call logs are diagnostic; report failed
				// persistence without altering the completed model response.
				this.runtime.logger.debug(
					{
						src: "agent",
						agentId: this.runtime.agentId,
						model: modelKey,
						error: error instanceof Error ? error.message : String(error),
					},
					"Model call log write failed",
				);
				this.runtime.reportError("AgentRuntime.modelCallLog", error, {
					model: modelKey,
					diagnosticOnly: true,
				});
			});
	}

	async useModel<T extends keyof ModelParamsMap, R = ModelResultMap[T]>(
		modelType: T,
		params: ModelParamsMap[T],
		provider?: string,
	): Promise<R> {
		const useModelStartedAt = Date.now();
		this.assertCanonicalModelCapabilityEnabled(String(modelType));
		const lookupCaller = RUNTIME_DEBUG_LOG_ENABLED
			? captureModelLookupCaller()
			: undefined;
		// Per-action model routing seam (closes A5 / W1-R2). If the call
		// originates inside an action handler that declared a `modelClass`, and
		// the requested model type is a text-generation model, we resolve
		// through a strategy chain instead of the default per-provider path.
		// The chain implements cost-aware ascending fallback: LOCAL → SMALL → LARGE.
		// Lookup the strategy ourselves rather than recursing on the requested
		// modelType so the routing decision is made once at the entry point,
		// not on every nested call.
		const actionRoutingCtx = getActionRoutingContext();
		if (actionRoutingCtx?.modelClass !== undefined && provider === undefined) {
			const strategy = maybeReroute(
				actionRoutingCtx.modelClass,
				String(modelType),
			);
			if (strategy) {
				const resolvedChain = resolveChain(strategy, (key) =>
					this.host.models().get(key),
				);
				if (resolvedChain.length > 0) {
					this.runtime.logger.debug(
						{
							src: "agent",
							agentId: this.runtime.agentId,
							action: actionRoutingCtx.actionName,
							modelClass: actionRoutingCtx.modelClass,
							requestedModelType: String(modelType),
							chain: resolvedChain.map((r) => ({
								modelType: r.modelType,
								provider: r.provider,
							})),
						},
						"Per-action model routing applied",
					);
					// Execute the chain. Each step recurses into useModel with the
					// resolved modelType + provider hint, but the action routing
					// context is cleared so the inner call uses the default path.
					return executeChainWithFallback(
						resolvedChain,
						strategy.confidenceThreshold,
						async (resolved) =>
							runWithoutActionRoutingContext(() =>
								this.useModel<T, R>(
									resolved.modelType as T,
									params,
									resolved.provider,
								),
							),
					);
				}
				this.runtime.logger.debug(
					{
						src: "agent",
						agentId: this.runtime.agentId,
						action: actionRoutingCtx.actionName,
						modelClass: actionRoutingCtx.modelClass,
						requestedModelType: String(modelType),
					},
					"Per-action model routing requested but no handlers in chain — falling back to default",
				);
			}
		}

		let requestedModelKey = String(modelType);

		// Apply LLM mode override for text generation models
		const llmMode = this.runtime.getLLMMode();
		if (llmMode !== "DEFAULT") {
			// List of text generation model types that can be overridden
			const textGenerationModels = [
				ModelType.TEXT_NANO,
				ModelType.TEXT_SMALL,
				ModelType.TEXT_MEDIUM,
				ModelType.TEXT_LARGE,
				ModelType.TEXT_MEGA,
				ModelType.RESPONSE_HANDLER,
				ModelType.ACTION_PLANNER,
				ModelType.TEXT_COMPLETION,
			];

			if (
				textGenerationModels.includes(
					requestedModelKey as (typeof textGenerationModels)[number],
				)
			) {
				const overrideModelKey =
					llmMode === "SMALL" ? ModelType.TEXT_SMALL : ModelType.TEXT_LARGE;
				if (requestedModelKey !== overrideModelKey) {
					this.runtime.logger.debug(
						{
							src: "agent",
							agentId: this.runtime.agentId,
							originalModel: requestedModelKey,
							overrideModel: overrideModelKey,
							llmMode,
						},
						"LLM mode override applied",
					);
					requestedModelKey = overrideModelKey as typeof requestedModelKey;
				}
			}
		}

		// TEXT_EMBEDDING and TEXT_EMBEDDING_BATCH calls without an explicit
		// provider are pinned to the provider that answered the dimension probe:
		// the vector column was sized from its output, so serving an embedding
		// call from any other registration (including a higher-priority BATCH
		// handler, or via rate-limit failover) can emit a different-width vector
		// that the SQL adapter silently drops (#8769). Pinning also disables
		// mid-call provider failover for embeddings — an embedding either comes
		// from the provider the column was sized for, or the call fails loudly.
		// An explicit provider argument still wins.
		const requestedProvider =
			provider === undefined &&
			(requestedModelKey === ModelType.TEXT_EMBEDDING ||
				requestedModelKey === ModelType.TEXT_EMBEDDING_BATCH) &&
			this.host.pinnedEmbeddingProvider() !== undefined
				? this.host.pinnedEmbeddingProvider()
				: provider;

		// Runtime preferred-provider override: when the caller did not pin a
		// provider and this is a text-generation model, honor the runtime-selected
		// provider (ELIZA_BRAIN_PROVIDER). This lets an owner flip the chat brain
		// between loaded providers with no restart. A selection is a strict pin:
		// failure or missing registration must not silently switch providers.
		const providerOverride =
			provider === undefined &&
			TEXT_GENERATION_MODEL_KEYS.includes(requestedModelKey)
				? this.resolveTextProviderOverride()
				: undefined;
		const resolvedModels = this.resolveModelRegistrations(
			requestedModelKey,
			providerOverride ?? requestedProvider,
		);
		if (resolvedModels.length === 0) {
			this.throwNoModelHandler(requestedModelKey);
		}

		let lastModelError: unknown;
		let lastFailedModel: ResolvedModelRegistration | undefined;
		let providerAttemptStartedOutput = false;
		const providersWithExhaustedWarmingBudget = new Set<string>();
		const providerAttempts: ModelProviderAttempt[] = [];
		const registrationAttempted = (
			candidate: ResolvedModelRegistration,
		): boolean =>
			providerAttempts.some(
				(attempt) =>
					attempt.modelType === candidate.modelKey &&
					attempt.provider === candidate.provider &&
					attempt.handler === candidate.handler,
			);
		for (
			let resolvedIndex = 0;
			resolvedIndex < resolvedModels.length;
			resolvedIndex++
		) {
			const resolvedModel = resolvedModels[resolvedIndex];
			if (!resolvedModel) {
				continue;
			}
			if (
				providersWithExhaustedWarmingBudget.has(resolvedModel.provider) ||
				registrationAttempted(resolvedModel)
			) {
				continue;
			}
			const resolvedModelKey = resolvedModel.modelKey;
			const handler = resolvedModel.handler;
			providerAttemptStartedOutput = false;
			const attemptMeta = {
				modelKey: String(resolvedModelKey),
				provider: resolvedModel.provider ?? "unknown",
				attempt: resolvedIndex + 1,
			};
			const preprocessingStartedAt = Date.now();
			let handlerStartedAt: number | null = null;
			let providerAttempt: ModelProviderAttempt | undefined;
			if (resolvedIndex === 0) {
				recordInferenceSpan(
					`model-routing:${String(modelType)}`,
					preprocessingStartedAt - useModelStartedAt,
					attemptMeta,
				);
			}

			// Outer-scope mirrors of the try-block locals needed by the catch block's
			// failed-attempt trajectory record. `let`/`const` inside `try` are not
			// visible to the matching `catch`, so we capture them here as they are
			// assigned inside (#17532).
			let modelParamsRef: unknown = params;
			let promptContentRef: string | null | undefined;
			// recordingStateRef tracks whether the provider already logged this call.
			// The catch block must not add a second failure entry for a call the
			// provider recorded before throwing (e.g. OpenAI streaming logs in its
			// generator finalizer then rethrows the stream error) — that would
			// reintroduce the double-counting this fix removes (#17532).
			//
			// Initial value `{ recorded: false }` is only read when the handler
			// throws BEFORE runWithModelCallRecordingScope assigns the real store
			// (line ~6578). Once assigned, all later reads reference the scope's
			// live mutable object, not this placeholder.
			let recordingStateRef: { recorded: boolean } = { recorded: false };
			let attemptPreparationFailed = false;
			let drainStructuredStreamCallbacks: (() => Promise<void>) | undefined;

			try {
				const binaryModels: string[] = [
					ModelType.TRANSCRIPTION,
					ModelType.IMAGE,
					ModelType.AUDIO,
					ModelType.VIDEO,
				];
				// PII swap skips binary-input modalities (nothing to swap) and TEXT_EMBEDDING
				// (a random per-turn surrogate would destabilize embeddings), but — unlike
				// the secret gate — swaps IMAGE prompts, whose text can carry real names.
				const PII_SWAP_SKIP_MODELS: string[] = [
					ModelType.TRANSCRIPTION,
					ModelType.AUDIO,
					ModelType.VIDEO,
					ModelType.TEXT_EMBEDDING,
				];
				const shouldSubstituteSecrets =
					this.host.isSecretSwapEnabled() &&
					!binaryModels.includes(resolvedModelKey);
				// Validate the caller-owned graph before `isPlainObject` / object spread
				// below can reflect it. The later collection still runs after secret swap
				// so NER never sees raw secrets; this preflight exists to make the earlier
				// runtime cloning boundary descriptor-safe and fail-closed as well.
				if (
					this.host.isPiiSwapEnabled() &&
					!PII_SWAP_SKIP_MODELS.includes(resolvedModelKey)
				) {
					collectPiiPromptText(params);
				}
				let modelParams: ModelParamsMap[T];
				const paramsClone = isPlainObject(params)
					? shouldSubstituteSecrets
						? { ...(params as Record<string, unknown>) }
						: this.cloneModelRequestGraph(params)
					: params;
				if (
					params === null ||
					params === undefined ||
					typeof params !== "object" ||
					Array.isArray(params) ||
					BufferUtils.isBuffer(params)
				) {
					modelParams = paramsClone as ModelParamsMap[T];
				} else {
					// Include model settings from character configuration if available
					const modelSettings = this.getModelSettings(requestedModelKey);

					if (modelSettings) {
						// Apply model settings if configured — merged object is narrowed at handlers after routing.
						const merged: object = {
							...modelSettings,
							...(paramsClone as Record<string, JsonValue | object>),
						};
						modelParams = merged as ModelParamsMap[T];
					} else {
						// No model settings configured, use params as-is
						modelParams = paramsClone as ModelParamsMap[T];
					}

					// Auto-populate user parameter from character name if not provided
					// The `user` parameter is used by LLM providers for tracking and analytics purposes.
					// We only auto-populate when user is undefined (not explicitly set to empty string or null)
					// to allow users to intentionally set an empty identifier if needed.
					const shouldAttachUser =
						requestedModelKey === ModelType.TEXT_NANO ||
						requestedModelKey === ModelType.TEXT_SMALL ||
						requestedModelKey === ModelType.TEXT_MEDIUM ||
						requestedModelKey === ModelType.TEXT_LARGE ||
						requestedModelKey === ModelType.TEXT_MEGA ||
						requestedModelKey === ModelType.RESPONSE_HANDLER ||
						requestedModelKey === ModelType.ACTION_PLANNER ||
						requestedModelKey === ModelType.TEXT_REASONING_SMALL ||
						requestedModelKey === ModelType.TEXT_REASONING_LARGE ||
						requestedModelKey === ModelType.TEXT_COMPLETION;
					if (
						shouldAttachUser &&
						isPlainObject(modelParams) &&
						this.runtime.character.name
					) {
						const modelParamsRecord = modelParams as Record<
							string,
							JsonValue | object
						>;
						if (modelParamsRecord.user === undefined) {
							modelParamsRecord.user = this.runtime.character.name;
						}
					}
				}
				const prepareModelAttempt =
					isPlainObject(modelParams) &&
					typeof (modelParams as GenerateTextParams).prepareModelAttempt ===
						"function"
						? (modelParams as GenerateTextParams).prepareModelAttempt
						: undefined;
				if (prepareModelAttempt) {
					const attempt: ModelAttemptContext = {
						modelType: String(resolvedModelKey),
						provider: resolvedModel.provider ?? "unknown",
						...(resolvedModel.metadata
							? { metadata: resolvedModel.metadata }
							: {}),
					};
					try {
						await prepareModelAttempt(
							attempt,
							modelParams as GenerateTextParams,
						);
					} catch (error) {
						attemptPreparationFailed = true;
						throw error;
					}
					delete (modelParams as GenerateTextParams).prepareModelAttempt;
				}
				let startTime =
					typeof performance !== "undefined" &&
					typeof performance.now === "function"
						? performance.now()
						: Date.now();

				// Get streaming config
				// Define interface for params that may have streaming properties
				interface StreamingParams {
					stream?: boolean;
					onStreamChunk?: StreamChunkCallback;
					signal?: AbortSignal;
					streamStructured?: boolean;
					responseSkeleton?: ResponseSkeleton;
				}
				const streamingCtx = getStreamingContext();
				const paramsAsStreaming = isPlainObject(modelParams)
					? (modelParams as StreamingParams)
					: undefined;
				const paramsChunk = paramsAsStreaming?.onStreamChunk;
				const ctxChunk = streamingCtx?.onStreamChunk;
				const msgId = streamingCtx?.messageId;
				const abortSignal = streamingCtx?.abortSignal;
				const explicitStream = paramsAsStreaming?.stream;
				const resolvedProviderName = resolvedModel?.provider;
				// stream: false = force no stream, otherwise stream if any callback exists.
				// Vision describes are often hidden preprocessing/OCR calls inside a chat
				// turn; do not leak those chunks into the visible chat stream unless the
				// call itself opts in.
				const requiresExplicitStreaming =
					requestedModelKey === ModelType.IMAGE_DESCRIPTION;
				const shouldStream =
					explicitStream === false
						? false
						: requiresExplicitStreaming
							? explicitStream === true
							: !!(paramsChunk || ctxChunk || explicitStream);
				const structuredStreamFields =
					shouldStream && paramsAsStreaming?.streamStructured === true
						? resolveResponseSkeletonStreamFields(
								paramsAsStreaming.responseSkeleton,
							)
						: [];
				const suppressStructuredStream =
					shouldStream &&
					paramsAsStreaming?.streamStructured === true &&
					structuredStreamFields.length === 0;
				let downstreamDelivery = Promise.resolve();
				let downstreamDeliveryError: unknown;
				let downstreamDeliveryFailed = false;
				const downstreamChunk = (
					chunk: string,
					accumulated?: string,
					streamRevision?: number,
				): void => {
					downstreamDelivery = downstreamDelivery
						.then(async () => {
							if (downstreamDeliveryFailed) return;
							if (paramsChunk)
								await paramsChunk(chunk, msgId, accumulated, streamRevision);
							if (ctxChunk)
								await ctxChunk(chunk, msgId, accumulated, streamRevision);
						})
						.then(undefined, (error: unknown) => {
							downstreamDeliveryFailed = true;
							downstreamDeliveryError = error;
						});
				};
				drainStructuredStreamCallbacks = async () => {
					await downstreamDelivery;
					if (downstreamDeliveryFailed) throw downstreamDeliveryError;
				};
				const structuredExtractor =
					structuredStreamFields.length > 0 &&
					paramsAsStreaming?.responseSkeleton
						? new ResponseSkeletonStreamExtractor({
								skeleton: paramsAsStreaming.responseSkeleton,
								streamFields: structuredStreamFields,
								unordered: true,
								onChunk: (chunk, _field, accumulated, streamRevision) =>
									downstreamChunk(chunk, accumulated, streamRevision),
								...(abortSignal ? { abortSignal } : {}),
							})
						: undefined;
				let handlerDeliveredStream = false;
				let streamedText = "";
				let secretSwapSession: SecretSwapSession | null = null;
				let guardScanner: GuardedStreamScanner | null = null;
				let piiSwapSession: PseudonymSession | null = null;
				const emitModelStreamChunk = async (
					safeChunk: string,
					visibleChunk = safeChunk,
				): Promise<void> => {
					if (abortSignal?.aborted) return;
					if (safeChunk.length > 0) {
						providerAttemptStartedOutput = true;
					}
					if (streamedText === "" && safeChunk.length > 0) {
						markInference(INFERENCE_MARKS.firstToken);
						const firstTokenAt =
							typeof performance !== "undefined" &&
							typeof performance.now === "function"
								? performance.now()
								: Date.now();
						recordInferenceSpan(
							`model-ttft:${String(modelType)}`,
							firstTokenAt - startTime,
							attemptMeta,
						);
					}
					streamedText += safeChunk;
					// Per-token hook dispatch: skip the whole ceremony (trajectory
					// lookup, context-object build, awaited invoke) when nothing is
					// registered for the phase — the common zero-hook stream would
					// otherwise pay it for every token. The length check reads the
					// cached per-phase list, so a hook registered mid-stream is still
					// picked up on the next chunk.
					if (this.host.hooksForPhase("model_stream_chunk").length > 0) {
						const trajStream = getTrajectoryContext();
						await this.host.invokePipelineHooks(
							"model_stream_chunk",
							modelStreamChunkPipelineHookContext({
								source: "use_model",
								chunk: safeChunk,
								messageId: msgId,
								roomId:
									(trajStream?.roomId as UUID | undefined) ??
									this.host.currentRoomId() ??
									this.runtime.agentId,
								runId: this.runtime.getCurrentRunId(),
								...(trajStream?.messageId
									? { responseId: trajStream.messageId as UUID }
									: {}),
								accumulated: streamedText,
							}),
							"Model stream chunk (useModel)",
							false,
						);
					}
					await runInsideModelStreamChunkDelivery(async () => {
						if (structuredExtractor) {
							structuredExtractor.push(visibleChunk);
							return;
						}
						// A structured caller with no approved stream fields must
						// hold the provider's raw envelope until the validated final
						// result is available. Falling through here would expose
						// routing JSON and unverified reply text token-by-token.
						if (suppressStructuredStream) return;
						if (paramsChunk) await paramsChunk(visibleChunk, msgId, undefined);
						if (ctxChunk) await ctxChunk(visibleChunk, msgId, undefined);
					});
				};
				// When a guard is active, route every chunk through the scanner: it
				// emits the substituted prefix it can prove safe and holds only the
				// still-in-progress tail, so guarded turns stream token-by-token instead
				// of collapsing to one terminal chunk (#15256). Both sessions are assigned
				// before the handler runs (below), so lazy construction here is ordering-safe.
				const deliverModelStreamChunk = async (
					chunk: string,
				): Promise<void> => {
					if (abortSignal?.aborted) return;
					if (secretSwapSession || piiSwapSession) {
						guardScanner ??= new GuardedStreamScanner({
							secretSession: secretSwapSession,
							piiSession: piiSwapSession,
						});
						const { safe, visible } = guardScanner.push(chunk);
						if (safe.length > 0) await emitModelStreamChunk(safe, visible);
						return;
					}
					await emitModelStreamChunk(chunk);
				};
				const flushGuardedStream = async (): Promise<void> => {
					if (abortSignal?.aborted || !guardScanner) return;
					const { safe, visible } = guardScanner.flush();
					if (safe.length > 0) await emitModelStreamChunk(safe, visible);
				};
				// Wire the handler-facing stream callback for registrations that declare
				// handler streaming support, with local-provider recognition retained as
				// the legacy fallback. The prefer-local router ("eliza-router") still opts
				// in by name because it forwards `onStreamChunk` to the underlying
				// on-device handler after routing.
				const declaredStreamable = resolvedModel.metadata?.streamable;
				const resolvedAcceptsHandlerStream =
					resolvedProviderName === "eliza-router" ||
					(typeof declaredStreamable === "boolean"
						? declaredStreamable
						: !!resolvedProviderName &&
							isLocalHandler({
								provider: resolvedProviderName,
								metadata: resolvedModel.metadata,
							}));
				const handlerStreamChunk: StreamChunkCallback | undefined =
					shouldStream &&
					resolvedAcceptsHandlerStream &&
					(paramsChunk || ctxChunk || structuredExtractor)
						? async (chunk) => {
								handlerDeliveredStream = true;
								await deliverModelStreamChunk(chunk);
							}
						: undefined;

				if (isPlainObject(modelParams) && paramsAsStreaming) {
					paramsAsStreaming.stream = shouldStream;
					if (handlerStreamChunk) {
						paramsAsStreaming.onStreamChunk = handlerStreamChunk;
					} else {
						delete paramsAsStreaming.onStreamChunk;
					}
					// Plumb the streaming-context abort signal into model params so the
					// underlying handler can wire it into its transport (e.g. local
					// llama's `stopOnAbortSignal`, fetch's `signal`). Only inject when
					// the caller didn't already pass one explicitly.
					if (paramsAsStreaming.signal === undefined && abortSignal) {
						paramsAsStreaming.signal = abortSignal;
					}
				}

				const textModelKey = TEXT_GENERATION_MODEL_KEYS.includes(
					String(resolvedModelKey),
				)
					? String(resolvedModelKey)
					: requestedModelKey;
				let effectiveSystemPrompt = this.host.attachEffectiveSystemPrompt(
					textModelKey,
					modelParams,
				);

				if (shouldSubstituteSecrets) {
					// Reuse one session per turn so every model call in the turn shares a
					// nonce and the action-execution boundary can restore what this call
					// swapped. The session hangs off the turn-scoped trajectory context;
					// calls outside a trajectory scope fall back to a per-call session
					// (no egress restore — there is no execution boundary to restore at).
					const trajectoryCtx = getTrajectoryContext();
					secretSwapSession =
						trajectoryCtx?.secretSwapSession ??
						this.host.createSecretSwapSession();
					if (trajectoryCtx && !trajectoryCtx.secretSwapSession) {
						trajectoryCtx.secretSwapSession = secretSwapSession;
					}
					modelParams = secretSwapSession.substituteInValue(modelParams);
					effectiveSystemPrompt =
						effectiveSystemPrompt === undefined
							? undefined
							: secretSwapSession.substituteText(effectiveSystemPrompt);
				}

				// Models the PII swap must NOT touch: binary-input modalities (nothing to
				// swap) and — unlike the secret gate — IMAGE is INCLUDED (its text prompt
				// can carry real names), while TEXT_EMBEDDING is EXCLUDED (a per-turn-random
				// surrogate would embed the same real text differently every turn and wreck
				// semantic memory retrieval; embeddings stay on the real text).
				let piiIngressText = "";
				if (
					this.host.isPiiSwapEnabled() &&
					!PII_SWAP_SKIP_MODELS.includes(resolvedModelKey)
				) {
					// Turn-scoped like the secret session (same mapping all turn), so the
					// execution boundary can restore what this call swapped.
					const trajectoryCtx = getTrajectoryContext();
					piiSwapSession =
						trajectoryCtx?.piiSwapSession ?? this.host.createPiiSwapSession();
					if (trajectoryCtx && !trajectoryCtx.piiSwapSession) {
						trajectoryCtx.piiSwapSession = piiSwapSession;
					}
					// The awaited detection step: learn every named entity in the assembled
					// prompt (params + system prompt), then substitute synchronously. Ordered
					// after the secret pass, so the NER model reads opaque
					// `__ELIZA_SECRET_…__` placeholders, never a raw secret. The ONNX
					// inference is offloaded to onnxruntime's threadpool, so it overlaps the
					// event loop rather than blocking other turns.
					piiIngressText = this.host.collectPromptText(
						modelParams,
						effectiveSystemPrompt,
					);
					await piiSwapSession.learn(piiIngressText);
					modelParams = piiSwapSession.substituteInValue(modelParams);
					effectiveSystemPrompt =
						effectiveSystemPrompt === undefined
							? undefined
							: piiSwapSession.substituteText(effectiveSystemPrompt);
				}

				await this.host.invokePipelineHooks(
					"pre_model",
					preModelPipelineHookContext({
						requestedModelType: String(modelType),
						resolvedModelKey,
						provider: resolvedModel.provider,
						roomId: getTrajectoryContext()?.roomId,
						params: modelParams,
					}),
					"Pre-model pipeline hook",
				);
				if (secretSwapSession) {
					modelParams = secretSwapSession.substituteInValue(modelParams);
					const postHookSystemPrompt = resolveEffectiveSystemPrompt({
						params: modelParams,
						fallback: effectiveSystemPrompt,
					});
					effectiveSystemPrompt =
						postHookSystemPrompt === undefined
							? undefined
							: secretSwapSession.substituteText(postHookSystemPrompt);
				}
				if (piiSwapSession) {
					// pre_model hooks may have injected fresh text (RAG snippets, extra
					// context) with never-seen PII. If the assembled text changed, re-run
					// detection so that new PII is swapped too — not just already-learned
					// values re-masked. learn() is idempotent, so this only adds new entities.
					const postHookText = this.host.collectPromptText(
						modelParams,
						effectiveSystemPrompt,
					);
					if (postHookText !== piiIngressText) {
						await piiSwapSession.learn(postHookText);
					}
					modelParams = piiSwapSession.substituteInValue(modelParams);
					const postHookSystemPrompt = resolveEffectiveSystemPrompt({
						params: modelParams,
						fallback: effectiveSystemPrompt,
					});
					effectiveSystemPrompt =
						postHookSystemPrompt === undefined
							? undefined
							: piiSwapSession.substituteText(postHookSystemPrompt);
				}

				const hookedParamsObj =
					modelParams &&
					typeof modelParams === "object" &&
					!Array.isArray(modelParams)
						? (modelParams as Record<string, JsonValue | object>)
						: null;
				const promptContent =
					(hookedParamsObj &&
					"prompt" in hookedParamsObj &&
					typeof hookedParamsObj.prompt === "string"
						? hookedParamsObj.prompt
						: null) ||
					(hookedParamsObj &&
					"input" in hookedParamsObj &&
					typeof hookedParamsObj.input === "string"
						? hookedParamsObj.input
						: null) ||
					(hookedParamsObj &&
					"messages" in hookedParamsObj &&
					Array.isArray(hookedParamsObj.messages)
						? stringifyForModel({
								messages: hookedParamsObj.messages,
							})
						: null) ||
					(typeof modelParams === "string" ? modelParams : null);

				// Capture the exact post-hook request before the final budget check so a
				// typed zero-dispatch rejection records the same complete request.
				modelParamsRef = modelParams;
				promptContentRef = promptContent;
				// Attach only to this attempt's fresh request, before admission freezes
				// it. Symbols are not enumerated, measured, serialized, or deep-frozen.
				if (isPlainObject(modelParams)) {
					Object.defineProperty(modelParams, MODEL_PROVIDER_ATTEMPTS, {
						value: providerAttempts,
						enumerable: false,
					});
				}

				if (TEXT_GENERATION_MODEL_KEYS.includes(String(resolvedModelKey))) {
					let finalBudget = this.buildFinalModelInputBudget(
						modelParams,
						resolvedModel.metadata,
					);
					if (isPlainObject(modelParams)) {
						const paramsRecord = modelParams as Record<string, unknown>;
						const providerOptions = isPlainObject(paramsRecord.providerOptions)
							? (paramsRecord.providerOptions as Record<string, unknown>)
							: {};
						const seenBudgetSignatures = new Set<string>();
						while (true) {
							const signature = JSON.stringify(finalBudget);
							if (seenBudgetSignatures.has(signature)) {
								throw new ElizaError(
									"Final model-input budget metadata did not stabilize",
									{ code: "MODEL_INPUT_BUDGET_UNSTABLE" },
								);
							}
							seenBudgetSignatures.add(signature);
							Object.assign(
								providerOptions,
								withModelInputBudgetProviderOptions(
									providerOptions,
									finalBudget,
								),
							);
							paramsRecord.providerOptions = providerOptions;
							const measuredWithMetadata = this.buildFinalModelInputBudget(
								modelParams,
								resolvedModel.metadata,
							);
							if (
								measuredWithMetadata.estimatedInputTokens ===
								finalBudget.estimatedInputTokens
							) {
								finalBudget = measuredWithMetadata;
								break;
							}
							finalBudget = measuredWithMetadata;
						}
					}
					this.freezeAdmittedModelRequest(modelParams);
				}

				if (!binaryModels.includes(resolvedModelKey)) {
					this.runtime.logger.trace(
						{
							src: "agent",
							agentId: this.runtime.agentId,
							model: resolvedModelKey,
							params: modelParams,
						},
						"Model input",
					);
				} else {
					let sizeInfo = "unknown size";
					if (Buffer.isBuffer(modelParams)) {
						sizeInfo = `${modelParams.length} bytes`;
					} else if (
						typeof Blob !== "undefined" &&
						modelParams instanceof Blob
					) {
						sizeInfo = `${modelParams.size} bytes`;
					} else if (typeof modelParams === "object" && modelParams !== null) {
						if ("audio" in modelParams && Buffer.isBuffer(modelParams.audio)) {
							sizeInfo = `${(modelParams.audio as Buffer).length} bytes`;
						} else if (
							"audio" in modelParams &&
							typeof Blob !== "undefined" &&
							modelParams.audio instanceof Blob
						) {
							sizeInfo = `${(modelParams.audio as Blob).size} bytes`;
						}
					}
					this.runtime.logger.trace(
						{
							src: "agent",
							agentId: this.runtime.agentId,
							model: resolvedModelKey,
							size: sizeInfo,
						},
						"Model input (binary)",
					);
				}

				this.runtime.logger.debug(
					{
						src: "agent",
						agentId: this.runtime.agentId,
						model: resolvedModelKey,
						provider: resolvedModel.provider,
						...(lookupCaller?.caller ? { caller: lookupCaller.caller } : {}),
						...(lookupCaller?.callerStack.length
							? { callerStack: lookupCaller.callerStack }
							: {}),
					},
					"Using model",
				);

				// The model-call timing window opens HERE, not at useModel entry:
				// everything above (streaming setup, secret/PII swap sessions,
				// pre_model hooks, prompt extraction) is runtime work, and charging
				// it to the provider span makes `model:*` timings unreadable as
				// provider latency (#16394).
				startTime =
					typeof performance !== "undefined" &&
					typeof performance.now === "function"
						? performance.now()
						: Date.now();
				recordInferenceSpan(
					`model-preprocess:${String(modelType)}`,
					Date.now() - preprocessingStartedAt,
					attemptMeta,
				);
				handlerStartedAt = Date.now();
				providerAttempt = {
					modelType: resolvedModelKey,
					provider: resolvedModel.provider,
					handler,
				};
				providerAttempts.push(providerAttempt);
				const { result: handlerResult, recordingState } =
					await runWithModelCallRecordingScope(() =>
						handler(
							this.runtime,
							modelParams as Record<string, JsonValue | object>,
						),
					);
				// Expose the mutable recording state to the catch block so it can
				// suppress a failure entry when the provider already logged this
				// call before throwing (#17532).
				recordingStateRef = recordingState;
				const rawResponse = handlerResult;

				let safeRawResponse: unknown =
					secretSwapSession?.substituteInValue(rawResponse) ?? rawResponse;
				safeRawResponse =
					piiSwapSession?.substituteInValue(safeRawResponse) ?? safeRawResponse;
				const resultRef: { current: unknown } = { current: safeRawResponse };
				const modelOutToTrajectoryString = (v: unknown) =>
					typeof v === "string" ? v : stringifyForModel({ response: v });

				// Stream: broadcast to callbacks if streaming
				if (
					shouldStream &&
					(paramsChunk || ctxChunk) &&
					isTextStreamResult(rawResponse)
				) {
					// Consume the provider stream inside the recording scope, mirroring
					// the pass-through TextStreamResult wrapper below. Async generators
					// do not inherit AsyncLocalStorage context from their creation, and
					// runWithModelCallRecordingScope above has already exited by the
					// time we iterate, so markProviderRecordedCall (fired from the
					// provider finalizer via logActiveTrajectoryLlmCall — e.g. the
					// plugin-openai live-stream finally block) would find no store and
					// no-op. Re-entering the scope per-.next() (and forwarding .return()
					// cleanup) ensures the provider mark lands and suppresses the
					// generic fallback, otherwise this call is double-recorded (#17532).
					const streamIter = rawResponse.textStream[Symbol.asyncIterator]();
					try {
						while (true) {
							const { done, value } = await runInModelCallRecordingScope(
								recordingState,
								() => streamIter.next(),
							);
							if (done) break;
							// Check abort AFTER pulling a chunk (matching the original
							// for-await pull-then-check order) so the provider generator
							// body always advances at least once and its finally block
							// runs on .return() cleanup.
							if (abortSignal?.aborted) break;
							await deliverModelStreamChunk(value);
						}
					} finally {
						// Forward cleanup to the provider iterator so its finally block
						// (markProviderRecordedCall) also runs inside the scope. Safe to
						// call even if already exhausted.
						await runInModelCallRecordingScope(recordingState, async () => {
							await streamIter.return?.();
						});
					}
					await flushGuardedStream();
					structuredExtractor?.flush();
					await drainStructuredStreamCallbacks();

					const trajStreamEnd = getTrajectoryContext();
					await this.host.invokePipelineHooks(
						"model_stream_end",
						modelStreamEndPipelineHookContext({
							source: "use_model",
							roomId:
								(trajStreamEnd?.roomId as UUID | undefined) ??
								this.host.currentRoomId() ??
								this.runtime.agentId,
							runId: this.runtime.getCurrentRunId(),
							messageId: msgId ?? trajStreamEnd?.messageId,
							text: streamedText,
						}),
						"Model stream end (useModel)",
						true,
					);

					// Signal stream end to allow context to reset state between useModel calls
					const streamingCtxEnd = getStreamingContext();
					const ctxEnd = streamingCtxEnd?.onStreamEnd;
					if (ctxEnd) ctxEnd();

					// Preserve tool calls + finishReason + usage from the stream result.
					// The streaming branch used to collapse the response to `streamedText`
					// (a bare string), discarding any `toolCalls` surfaced by the provider
					// as a Promise. Callers like `parsePlannerOutput` then saw
					// `toolCalls.length === 0` and incremented `required_tool_misses` even
					// though the LLM had emitted a valid native tool call.
					const streamRaw = rawResponse as {
						toolCalls?: unknown;
						finishReason?: unknown;
						usage?: unknown;
						providerMetadata?: unknown;
					};
					const hasToolCallsField = "toolCalls" in streamRaw;
					const resolvedToolCalls = hasToolCallsField
						? await Promise.resolve(streamRaw.toolCalls)
						: [];
					const resolvedFinishReason =
						"finishReason" in streamRaw
							? await Promise.resolve(streamRaw.finishReason)
							: undefined;
					assertModelOutputComplete({
						finishReason: resolvedFinishReason,
						provider: resolvedModel.provider,
						model: resolvedModelKey,
					});
					// The presence of `toolCalls` marks a native-result contract, even
					// when the provider returns an empty list. Collapsing that result to a
					// string discards usage, finish reason, and concrete model metadata,
					// which makes successful hosted calls unpriceable.
					if (hasToolCallsField) {
						const resolvedUsage =
							"usage" in streamRaw
								? await Promise.resolve(streamRaw.usage)
								: undefined;
						resultRef.current = {
							text: streamedText,
							toolCalls: resolvedToolCalls,
							finishReason: resolvedFinishReason,
							usage: resolvedUsage,
							providerMetadata: streamRaw.providerMetadata,
						};
					} else {
						resultRef.current = streamedText;
					}

					const elapsedTime =
						(typeof performance !== "undefined" &&
						typeof performance.now === "function"
							? performance.now()
							: Date.now()) - startTime;
					const postprocessingStartedAt = Date.now();

					await this.host.invokePipelineHooks(
						"post_model",
						postModelPipelineHookContext({
							requestedModelType: String(modelType),
							resolvedModelKey,
							provider: resolvedModel.provider,
							roomId: getTrajectoryContext()?.roomId,
							durationMs: Math.round(elapsedTime),
							params: modelParams,
							result: resultRef,
							streaming: true,
						}),
						"Post-model pipeline hook",
					);
					resultRef.current =
						secretSwapSession?.substituteInValue(resultRef.current) ??
						resultRef.current;
					resultRef.current =
						piiSwapSession?.substituteInValue(resultRef.current) ??
						resultRef.current;

					// Record the provider that actually served this call so callers
					// that can't see the internal resolution (message.ts stage
					// recorders) can read the real provider instead of hardcoding
					// "default" (#13623).
					this.noteResolvedModelProvider(
						requestedModelKey,
						resolvedModel.provider,
					);

					this.runtime.logger.trace(
						{
							src: "agent",
							agentId: this.runtime.agentId,
							model: resolvedModelKey,
							duration: Number(elapsedTime.toFixed(2)),
							streaming: true,
						},
						"Model output (stream with callback complete)",
					);

					this.logModelCall(
						String(modelType),
						resolvedModelKey,
						modelParams,
						promptContent,
						effectiveSystemPrompt,
						elapsedTime,
						resolvedModel.provider,
						resultRef.current,
					);

					if (String(modelType) !== ModelType.TEXT_EMBEDDING) {
						await this.recordUseModelTrajectory({
							modelType: String(modelType),
							resolvedModelKey: String(resolvedModelKey),
							provider: resolvedModel.provider,
							modelParams,
							promptContent,
							result: resultRef.current,
							response: modelOutToTrajectoryString(resultRef.current),
							elapsedTime,
							providerRecorded: recordingState.recorded,
						});
					}
					recordInferenceSpan(
						`model-postprocess:${String(modelType)}`,
						Date.now() - postprocessingStartedAt,
						{ ...attemptMeta, streaming: true },
					);

					return resultRef.current as R;
				}

				if (handlerDeliveredStream) {
					await flushGuardedStream();
					structuredExtractor?.flush();
					await drainStructuredStreamCallbacks();
					const trajStreamEnd = getTrajectoryContext();
					await this.host.invokePipelineHooks(
						"model_stream_end",
						modelStreamEndPipelineHookContext({
							source: "use_model",
							roomId:
								(trajStreamEnd?.roomId as UUID | undefined) ??
								this.host.currentRoomId() ??
								this.runtime.agentId,
							runId: this.runtime.getCurrentRunId(),
							messageId: msgId ?? trajStreamEnd?.messageId,
							text: streamedText,
						}),
						"Model stream end (useModel)",
						true,
					);
					const streamingCtxEnd = getStreamingContext();
					const ctxEnd = streamingCtxEnd?.onStreamEnd;
					if (ctxEnd) ctxEnd();
				}

				if (!isTextStreamResult(resultRef.current as JsonValue | object)) {
					await assertRuntimeModelOutputComplete({
						result: resultRef.current,
						provider: resolvedModel.provider,
						model: resolvedModelKey,
					});
				}

				const elapsedTime =
					(typeof performance !== "undefined" &&
					typeof performance.now === "function"
						? performance.now()
						: Date.now()) - startTime;
				const postprocessingStartedAt = Date.now();

				await this.host.invokePipelineHooks(
					"post_model",
					postModelPipelineHookContext({
						requestedModelType: String(modelType),
						resolvedModelKey,
						provider: resolvedModel.provider,
						roomId: getTrajectoryContext()?.roomId,
						durationMs: Math.round(elapsedTime),
						params: modelParams,
						result: resultRef,
						streaming: handlerDeliveredStream,
					}),
					"Post-model pipeline hook",
				);
				resultRef.current =
					secretSwapSession?.substituteInValue(resultRef.current) ??
					resultRef.current;
				resultRef.current =
					piiSwapSession?.substituteInValue(resultRef.current) ??
					resultRef.current;

				// Record the provider that actually served this call so callers
				// that can't see the internal resolution (message.ts stage
				// recorders) can read the real provider instead of hardcoding
				// "default" (#13623).
				this.noteResolvedModelProvider(
					requestedModelKey,
					resolvedModel.provider,
				);

				this.runtime.logger.trace(
					{
						src: "agent",
						agentId: this.runtime.agentId,
						model: resolvedModelKey,
						duration: Number(elapsedTime.toFixed(2)),
					},
					"Model output",
				);

				this.logModelCall(
					String(modelType),
					resolvedModelKey,
					modelParams,
					promptContent,
					effectiveSystemPrompt,
					elapsedTime,
					resolvedModel.provider,
					resultRef.current,
				);

				if (
					String(modelType) !== ModelType.TEXT_EMBEDDING &&
					!(
						shouldStream &&
						!handlerDeliveredStream &&
						isTextStreamResult(resultRef.current as object)
					)
				) {
					await this.recordUseModelTrajectory({
						modelType: String(modelType),
						resolvedModelKey: String(resolvedModelKey),
						provider: resolvedModel.provider,
						modelParams,
						promptContent,
						result: resultRef.current,
						response: modelOutToTrajectoryString(resultRef.current),
						elapsedTime,
						providerRecorded: recordingState.recorded,
					});
				}

				// Pass-through stream: the caller will consume textStream after
				// useModel returns. Defer the generic trajectory record until then,
				// so the provider's deferred recordLlmCall has time to mark the
				// flag (#17532). The wrapper accumulates chunks as they pass
				// through so the trajectory entry can be recorded from the
				// delivered text without awaiting streamResult.text, which may
				// never settle or may reject on the abort path. A backstop on the
				// provider's text promise guarantees at least one entry even when
				// the consumer never iterates or awaits .text (#17532 review).
				if (
					shouldStream &&
					!handlerDeliveredStream &&
					isTextStreamResult(resultRef.current as object)
				) {
					const streamResult = resultRef.current as TextStreamResult;
					const checkedFinishReason = Promise.resolve(
						streamResult.finishReason,
					).then((finishReason) => {
						assertModelOutputComplete({
							finishReason,
							provider: resolvedModel.provider,
							model: resolvedModelKey,
						});
						return finishReason;
					});
					const trajArgs = {
						modelType: String(modelType),
						resolvedModelKey: String(resolvedModelKey),
						provider: resolvedModel.provider,
						modelParams,
						promptContent,
						elapsedTime,
					};
					let didRecord = false;
					const accumulatedChunks: string[] = [];
					const recordOnce = async () => {
						if (didRecord) return;
						didRecord = true;
						const finalText = accumulatedChunks.join("");
						await this.recordUseModelTrajectory({
							...trajArgs,
							result: finalText,
							response: finalText,
							providerRecorded: recordingState.recorded,
						});
					};
					// Guaranteed terminal record: if the consumer never iterates
					// the textStream and never awaits .text, the provider's text
					// promise still resolves (or rejects) eventually. Attach a
					// backstop so at least one trajectory entry fires regardless
					// of how the consumer treats the stream result (#17532 review,
					// Finding 2).
					Promise.all([streamResult.text, checkedFinishReason]).then(
						([resolvedText]) => {
							if (accumulatedChunks.length === 0 && resolvedText) {
								accumulatedChunks.push(resolvedText);
							}
							void recordOnce();
						},
						() => void recordOnce(),
					);
					resultRef.current = {
						...streamResult,
						finishReason: checkedFinishReason,
						textStream: (async function* () {
							// Each .next() call re-enters the recording scope so
							// the provider generator body (and its finally block
							// where markProviderRecordedCall fires) runs inside
							// the ALS context (#17532).
							const innerIter = streamResult.textStream[Symbol.asyncIterator]();
							try {
								while (true) {
									const { done, value } = await runInModelCallRecordingScope(
										recordingState,
										() => innerIter.next(),
									);
									if (done) {
										await checkedFinishReason;
										break;
									}
									accumulatedChunks.push(value);
									yield value;
								}
							} finally {
								// Forward cleanup to the provider iterator so its
								// finally block (markProviderRecordedCall) runs inside
								// the scope. Safe to call even if already exhausted.
								await runInModelCallRecordingScope(recordingState, async () => {
									await innerIter.return?.();
								});
								// Record from accumulated chunks, NOT streamResult.text.
								// The abort path's text promise may never settle or may
								// reject; using accumulated chunks avoids hanging the
								// generator's return() (#17532 review, Finding 3).
								try {
									await recordOnce();
								} catch {
									// error-policy:J7 Trajectory logging must never break core model flow.
								}
							}
						})(),
						// Lazy: record from accumulated chunks when the caller
						// awaits text, not eagerly when the provider's SDK promise
						// settles (#17532). The consumer explicitly awaited
						// streamResult.text, so resolving it is safe — a rejection
						// surfaces at the caller's own await site.
						get text() {
							return Promise.resolve(
								runInModelCallRecordingScope(recordingState, async () => {
									const t = await streamResult.text;
									await checkedFinishReason;
									accumulatedChunks.length = 0;
									accumulatedChunks.push(t);
									await recordOnce();
									return t;
								}),
							);
						},
					} satisfies TextStreamResult;
				}
				recordInferenceSpan(
					`model-postprocess:${String(modelType)}`,
					Date.now() - postprocessingStartedAt,
					{ ...attemptMeta, streaming: handlerDeliveredStream },
				);
				return resultRef.current as R;
			} catch (error) {
				const streamCallbackResult =
					await drainStructuredStreamCallbacks?.().then(
						() => ({ failed: false as const }),
						(deliveryError: unknown) => ({
							failed: true as const,
							error: deliveryError,
						}),
					);
				if (
					streamCallbackResult?.failed === true &&
					streamCallbackResult.error !== error
				) {
					throw streamCallbackResult.error;
				}
				const unavailableLocalText =
					TEXT_GENERATION_MODEL_KEYS.includes(requestedModelKey) &&
					isUnavailableLocalModel(error);
				const rejectedLocalAdmission =
					handlerStartedAt === null && unavailableLocalText;
				if (attemptPreparationFailed || rejectedLocalAdmission) {
					recordInferenceSpan(
						`model-preprocess:${String(modelType)}`,
						Date.now() - preprocessingStartedAt,
						{ ...attemptMeta, outcome: "error" },
					);
					if (
						!rejectedLocalAdmission &&
						!(
							error instanceof ElizaError &&
							error.code === "EVALUATOR_INPUT_OVER_BUDGET"
						)
					) {
						throw error;
					}
					// A preparation rejection is attempt-local: the hook refused THIS
					// registration (e.g. its context window cannot fit the stable
					// input) before its handler ran, so no provider failure happened
					// and no failed-attempt trajectory entry is recorded. Registration
					// order is fallback tier + priority, not descending window size,
					// so a later registration may still fit — advance the chain and
					// rethrow the typed error only when the caller pinned a provider
					// or no candidate remains.
					// An absent fallback cannot explain away an earlier dispatched
					// provider's actionable failure (for example its quota error).
					if (!rejectedLocalAdmission || lastModelError === undefined) {
						lastModelError = error;
						lastFailedModel = resolvedModel;
					}
					const nextAfterPreparation = resolvedModels[resolvedIndex + 1];
					if (requestedProvider !== undefined) throw error;
					if (!nextAfterPreparation) {
						if (rejectedLocalAdmission) {
							this.rethrowModelFailoverError(lastModelError, lastFailedModel);
						}
						throw error;
					}
					this.logModelProviderFailover({
						requestedModelKey,
						failedModel: resolvedModel,
						nextModel: nextAfterPreparation,
						error,
					});
					continue;
				}
				// error-policy:J4 Provider failover is an explicit degraded path;
				// the final provider failure is rethrown if no alternative succeeds.
				if (handlerStartedAt === null) {
					recordInferenceSpan(
						`model-preprocess:${String(modelType)}`,
						Date.now() - preprocessingStartedAt,
						{ ...attemptMeta, outcome: "error" },
					);
				} else {
					recordInferenceSpan(
						`model:${String(modelType)}`,
						Date.now() - handlerStartedAt,
						{ ...attemptMeta, outcome: "error" },
					);
				}
				// Record the failed attempt as a trajectory llm-call entry so a
				// rejected (often billed) provider attempt is not invisible. If
				// failover succeeds, only the success would otherwise appear; if
				// every attempt fails, the step would have zero model entries
				// (#17532). Fire-and-forget: trajectory logging must not block the
				// failover/rethrow path, and its own failures are reported inside.
				// Skip when the provider already logged this call before throwing
				// (e.g. OpenAI streaming logs in its finalizer then rethrows) — a
				// second failure entry would reintroduce the double-counting this
				// fix removes (#17532).
				if (!recordingStateRef.recorded) {
					void this.recordFailedModelTrajectory({
						modelType: String(modelType),
						resolvedModelKey: String(resolvedModelKey),
						provider: resolvedModel.provider,
						modelParams: modelParamsRef,
						promptContent: promptContentRef,
						error,
						elapsedTime:
							handlerStartedAt === null
								? Date.now() - preprocessingStartedAt
								: Date.now() - handlerStartedAt,
					});
				}
				// A model can unload between admission and dispatch. Record that
				// real attempt, but retain the previous provider failure if absence
				// is the only fallback outcome. Output/request errors stay decisive.
				if (
					!unavailableLocalText ||
					lastModelError === undefined ||
					providerAttemptStartedOutput ||
					requestedProvider !== undefined
				) {
					lastModelError = error;
					lastFailedModel = resolvedModel;
				}
				if (providerAttempt) providerAttempt.error = error;
				if (isElizaCloudGatewayWarmingExhaustedError(error)) {
					providersWithExhaustedWarmingBudget.add(resolvedModel.provider);
				}
				const nextModelIndex = resolvedModels.findIndex(
					(candidate, candidateIndex) =>
						candidateIndex > resolvedIndex &&
						!providersWithExhaustedWarmingBudget.has(candidate.provider) &&
						!registrationAttempted(candidate),
				);
				const nextModel =
					nextModelIndex >= 0 ? resolvedModels[nextModelIndex] : undefined;
				if (
					requestedProvider !== undefined ||
					!nextModel ||
					providerAttemptStartedOutput ||
					!this.shouldFailOverModelProvider(error, requestedModelKey)
				) {
					this.rethrowModelFailoverError(lastModelError, lastFailedModel);
				}
				this.logModelProviderFailover({
					requestedModelKey,
					failedModel: resolvedModel,
					nextModel,
					error,
				});
				// The loop increments after this catch. Jump over every registration
				// backed by a provider whose one warming budget was already spent,
				// while preserving an actually distinct provider as the next attempt.
				resolvedIndex = nextModelIndex - 1;
			}
		}
		this.rethrowModelFailoverError(
			lastModelError ??
				new Error(`No handler found for delegate type: ${requestedModelKey}`),
			lastFailedModel,
		);
	}

	/**
	 * Emit an llm-call entry against the current trajectory step for a
	 * `useModel` call. Pure dedupe of the streaming and non-streaming paths
	 * inside {@link useModel}; both paths formerly inlined an identical block.
	 *
	 * Skipped while the runtime is still initializing because
	 * {@link _ensureServiceStarted} awaits `initPromise` and would deadlock.
	 * Trajectory logging must never break core model flow, so any thrown
	 * error here is swallowed.
	 */
	async recordUseModelTrajectory(args: {
		modelType: string;
		resolvedModelKey: string;
		provider?: string;
		modelParams: unknown;
		promptContent: string | null | undefined;
		result?: unknown;
		response: string;
		elapsedTime: number;
		providerRecorded: boolean;
	}): Promise<void> {
		if (this.host.initResolver()) return;

		// When the provider-level wire recorder (`recordLlmCall` or
		// `logActiveTrajectoryLlmCall`) already logged this call, suppress the
		// generic fallback to avoid double counting (#17532).
		if (args.providerRecorded) return;

		try {
			const trajCtx = getTrajectoryContext();
			const stepId = trajCtx?.trajectoryStepId;
			const trajLogger = (await this.host._ensureServiceStarted(
				"trajectories",
			)) as (Service & TrajectoryRuntimeLlmCallLogger) | null;
			if (!stepId || !trajLogger) return;

			const tempRaw = isPlainObject(args.modelParams)
				? (args.modelParams as { temperature?: number }).temperature
				: undefined;
			const maxTokensRaw = isPlainObject(args.modelParams)
				? (args.modelParams as { maxTokens?: number }).maxTokens
				: undefined;
			const paramsRecord = isPlainObject(args.modelParams)
				? (args.modelParams as Record<string, unknown>)
				: {};
			const systemPrompt =
				resolveEffectiveSystemPrompt({
					params: args.modelParams,
					fallback: this.host.buildRuntimeSystemPrompt(),
				}) ?? "";
			const userPrompt =
				this.host.getFirstUserPromptFromMessages(paramsRecord.messages) ??
				args.promptContent ??
				"";
			const resultRecord = isPlainObject(args.result)
				? (args.result as Record<string, unknown>)
				: {};
			const messages = Array.isArray(paramsRecord.messages)
				? paramsRecord.messages
				: undefined;
			const prompt =
				typeof paramsRecord.prompt === "string"
					? paramsRecord.prompt
					: userPrompt;
			// Rebind provider spans to the exact string this call persists. Copying
			// composeState's providersText offsets onto a larger messages prompt
			// produces false exact-match slices (#14877).
			const canonicalPrompt = canonicalPromptForModelCall({
				messages,
				prompt,
			});
			const reboundAttributions = trajCtx.providerAttributionState
				? buildProviderAttributionsFromState({
						state: trajCtx.providerAttributionState,
						prompt: canonicalPrompt,
					})
				: undefined;
			const providerOrder =
				reboundAttributions?.providerOrder ?? trajCtx.providerOrder;
			const providerAttributions =
				reboundAttributions?.providerAttributions ??
				omitUnvalidatedProviderSpans(trajCtx.providerAttributions);
			const usageRecord = isPlainObject(resultRecord.usage)
				? (resultRecord.usage as Record<string, unknown>)
				: {};
			const asNumber = (value: unknown): number | undefined =>
				typeof value === "number" && Number.isFinite(value) ? value : undefined;
			const activeTrace = this.runtime.getActiveTrace(
				this.runtime.getCurrentRunId(),
			);
			trajLogger.logLlmCall({
				stepId,
				model: args.resolvedModelKey,
				modelType: args.modelType,
				provider: args.provider,
				systemPrompt,
				userPrompt,
				prompt,
				messages,
				tools: paramsRecord.tools,
				toolChoice: paramsRecord.toolChoice,
				responseSchema: paramsRecord.responseSchema,
				providerOptions: paramsRecord.providerOptions,
				response: args.response,
				toolCalls: Array.isArray(resultRecord.toolCalls)
					? resultRecord.toolCalls
					: undefined,
				finishReason:
					typeof resultRecord.finishReason === "string"
						? resultRecord.finishReason
						: undefined,
				providerMetadata: resultRecord.providerMetadata,
				...(typeof tempRaw === "number" ? { temperature: tempRaw } : {}),
				...(typeof maxTokensRaw === "number"
					? { maxTokens: maxTokensRaw }
					: {}),
				purpose: trajCtx.purpose ?? "action",
				actionType: "runtime.useModel",
				latencyMs: Math.max(0, Math.round(args.elapsedTime)),
				promptTokens: asNumber(usageRecord.promptTokens),
				completionTokens: asNumber(usageRecord.completionTokens),
				cacheReadInputTokens: asNumber(usageRecord.cacheReadInputTokens),
				cacheCreationInputTokens: asNumber(
					usageRecord.cacheCreationInputTokens,
				),
				reasoningTokens: asNumber(usageRecord.reasoningTokens),
				modelSlot: args.modelType,
				runId: trajCtx.runId,
				roomId: trajCtx.roomId,
				messageId: trajCtx.messageId,
				executionTraceId: activeTrace?.id,
				providerOrder,
				providerAttributions,
			});
		} catch (error) {
			// error-policy:J7 diagnostics-must-not-kill-the-loop — model responses
			// remain usable when trajectory persistence fails, while reportError
			// makes the missing telemetry observable to the agent and owner.
			this.runtime.logger.warn(
				{ error, modelType: args.modelType },
				"Failed to record model-call trajectory",
			);
			this.runtime.reportError("AgentRuntime.recordUseModelTrajectory", error, {
				modelType: args.modelType,
				resolvedModelKey: args.resolvedModelKey,
				provider: args.provider,
			});
		}
	}

	/**
	 * Emit a failure llm-call entry for a `useModel` attempt that threw before
	 * producing a usable result. Without this, a rejected provider attempt is
	 * invisible in the trajectory: if failover succeeds, only the successful
	 * call appears and the failed (and often billed) attempt is lost; if every
	 * attempt fails, the step has zero model entries at all (#17532).
	 *
	 * Records the real error — sanitized of secrets — as the response payload
	 * with `finishReason: "error"`, and does NOT fabricate an empty response or
	 * zero token counts. Trajectory logging never breaks core model flow, so
	 * failures here are swallowed and surfaced via reportError instead.
	 */
	async recordFailedModelTrajectory(args: {
		modelType: string;
		resolvedModelKey: string;
		provider?: string;
		modelParams: unknown;
		promptContent: string | null | undefined;
		error: unknown;
		elapsedTime: number;
	}): Promise<void> {
		if (this.host.initResolver()) return;
		// A failed attempt is NOT provider-recorded: the provider never returned
		// a result, so its wire recorder did not run. We want this entry to land.
		try {
			const trajCtx = getTrajectoryContext();
			const stepId = trajCtx?.trajectoryStepId;
			if (!stepId) return;
			const trajLogger = (await this.host._ensureServiceStarted(
				"trajectories",
			)) as (Service & TrajectoryRuntimeLlmCallLogger) | null;
			if (!trajLogger) return;

			const paramsRecord = isPlainObject(args.modelParams)
				? (args.modelParams as Record<string, unknown>)
				: {};
			const tempRaw = isPlainObject(args.modelParams)
				? (args.modelParams as { temperature?: number }).temperature
				: undefined;
			const maxTokensRaw = isPlainObject(args.modelParams)
				? (args.modelParams as { maxTokens?: number }).maxTokens
				: undefined;
			const systemPrompt =
				resolveEffectiveSystemPrompt({
					params: args.modelParams,
					fallback: this.host.buildRuntimeSystemPrompt(),
				}) ?? "";
			const userPrompt =
				this.host.getFirstUserPromptFromMessages(paramsRecord.messages) ??
				args.promptContent ??
				"";
			const errorMessage =
				args.error instanceof Error
					? args.error.message
					: typeof args.error === "string"
						? args.error
						: "unknown model error";
			// Mark the response as a sanitized failure, not a success payload, so
			// downstream readers/agents can distinguish billed-but-failed attempts
			// from real outputs. Secrets are stripped to keep the trajectory safe.
			// The provider's own diagnostic (status + body message) is appended:
			// SDK error messages degrade to the bare statusText for providers with
			// non-OpenAI error envelopes, and without the body detail a failed
			// attempt reads as an uninvestigable "Bad Request".
			const providerDetail = modelProviderErrorDetail(args.error);
			const detailSuffix = providerDetail
				? `${
						providerDetail.providerMessage &&
						!errorMessage.includes(providerDetail.providerMessage)
							? ` | provider: ${providerDetail.providerMessage}`
							: ""
					}${
						providerDetail.status !== undefined
							? ` | status: ${providerDetail.status}`
							: ""
					}`
				: "";
			const sanitizedMessage = this.runtime.redactSecrets(
				`${errorMessage}${detailSuffix}`,
			);
			const activeTrace = this.runtime.getActiveTrace(
				this.runtime.getCurrentRunId(),
			);
			trajLogger.logLlmCall({
				stepId,
				model: args.resolvedModelKey,
				modelType: args.modelType,
				provider: args.provider,
				systemPrompt,
				userPrompt,
				prompt:
					typeof paramsRecord.prompt === "string"
						? paramsRecord.prompt
						: userPrompt,
				// The failed request's messages ARE the evidence: without them a
				// provider rejection (schema, shape, encoding) cannot be replayed or
				// diagnosed from the trajectory. Same privacy surface as the
				// successful-call record, which already persists messages.
				messages: Array.isArray(paramsRecord.messages)
					? (paramsRecord.messages as unknown[])
					: undefined,
				tools: paramsRecord.tools,
				toolChoice: paramsRecord.toolChoice,
				responseSchema: paramsRecord.responseSchema,
				providerOptions: paramsRecord.providerOptions,
				response: `[model call failed] ${sanitizedMessage}`,
				finishReason: "error",
				...(typeof tempRaw === "number" ? { temperature: tempRaw } : {}),
				...(typeof maxTokensRaw === "number"
					? { maxTokens: maxTokensRaw }
					: {}),
				purpose: trajCtx.purpose ?? "action",
				actionType: "runtime.useModel",
				latencyMs: Math.max(0, Math.round(args.elapsedTime)),
				modelSlot: args.modelType,
				runId: trajCtx.runId,
				roomId: trajCtx.roomId,
				messageId: trajCtx.messageId,
				executionTraceId: activeTrace?.id,
				providerOrder: trajCtx.providerOrder,
				providerAttributions: trajCtx.providerAttributions,
			});
		} catch (trajectoryError) {
			// error-policy:J7 Trajectory logging must never break core model flow.
			this.runtime.reportError(
				"TrajectoryFailedAttemptRecord",
				trajectoryError,
				{
					modelKey: args.resolvedModelKey,
					provider: args.provider,
				},
			);
		}
	}
}
