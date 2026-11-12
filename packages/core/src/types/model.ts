/**
 * Model-layer types: the `ModelType` registry, LLM-mode overrides, generation
 * params/results, tool-definition and tool-call shapes, chat-message parts, and
 * response-skeleton/sampler structures. Defines the model-agnostic interface the
 * runtime calls through (`useModel`) and that model plugins implement.
 */

import type { ContextObject } from "../runtime/context-object";
import type { StreamChunkCallback } from "./components";
import type { AgentContext } from "./contexts";
import type { ContentValue, JsonValue } from "./primitives";
import type { IAgentRuntime } from "./runtime";
import type { JSONSchema } from "./schema";

/** Runtime-only canonical input binding. JSON/client/model fields cannot populate this symbol. */
export const MODEL_CANONICAL_CONTEXT: unique symbol = Symbol.for(
	"elizaos.modelCanonicalContext",
);

/**
 * Scheduling priority for a single-lane local inference request.
 * The gate honoring it lives in `utils/inference-priority-gate.ts`.
 */
export type LocalInferencePriority = "interactive" | "background";

export type ModelTypeName = (typeof ModelType)[keyof typeof ModelType] | string;

/**
 * LLM Mode for overriding model selection.
 *
 * - `DEFAULT`: Use the model type specified in the useModel call (no override)
 * - `SMALL`: Override all text generation model calls to use TEXT_SMALL
 * - `LARGE`: Override all text generation model calls to use TEXT_LARGE
 *
 * This is useful for cost optimization (force SMALL) or quality (force LARGE).
 * While not recommended for production, it can be a fast way to make the agent run cheaper.
 *
 * @example
 * ```typescript
 * const runtime = new AgentRuntime({
 * character: myCharacter,
 * llmMode: LLMMode.SMALL, // All LLM calls will use TEXT_SMALL
 * });
 * ```
 */
export const LLMMode = {
	/** Use the model type as specified in the call (no override) */
	DEFAULT: "DEFAULT",
	/** Override all text generation model calls to use TEXT_SMALL */
	SMALL: "SMALL",
	/** Override all text generation model calls to use TEXT_LARGE */
	LARGE: "LARGE",
} as const;

export type LLMModeType = (typeof LLMMode)[keyof typeof LLMMode];

/**
 * Defines the recognized types of models that the agent runtime can use.
 * These include models for text generation (small, large, completion),
 * text embedding, tokenization (encode/decode), image generation and description,
 * audio transcription, text-to-speech, and generic object generation.
 * This constant is used throughout the system, particularly in `AgentRuntime.useModel`,
 * `AgentRuntime.registerModel`, and in `ModelParamsMap` / `ModelResultMap` to ensure
 * type safety and clarity when working with different AI models.
 * String values are used for extensibility with custom model types.
 */
export const ModelType = {
	NANO: "TEXT_NANO", // gpt-5.4-nano
	SMALL: "TEXT_SMALL", // haiku or gpt-5.4-mini
	MEDIUM: "TEXT_MEDIUM", // sonnet or gpt-5.4
	LARGE: "TEXT_LARGE", // opus or gpt-5.4
	MEGA: "TEXT_MEGA", // mythos or gpt-5.4 (5.5 when it comes out)
	TEXT_NANO: "TEXT_NANO", // gpt-5.4-nano
	TEXT_SMALL: "TEXT_SMALL", // haiku or gpt-5.4-mini
	TEXT_MEDIUM: "TEXT_MEDIUM", // sonnet or gpt-5.4
	TEXT_LARGE: "TEXT_LARGE", // opus or gpt-5.4
	TEXT_MEGA: "TEXT_MEGA", // mythos or gpt-5.4 (5.5 when it comes out)
	RESPONSE_HANDLER: "RESPONSE_HANDLER",
	ACTION_PLANNER: "ACTION_PLANNER",
	TEXT_EMBEDDING: "TEXT_EMBEDDING",
	/**
	 * Batch text embedding: one model call embeds N texts in a single request.
	 * Providers that support a batched embeddings endpoint (e.g. `input: string[]`)
	 * register this so callers that have many texts ready (the embedding-drain
	 * service) avoid N serial single-text round-trips. Falls back to N×
	 * {@link ModelType.TEXT_EMBEDDING} when a provider does not register it.
	 */
	TEXT_EMBEDDING_BATCH: "TEXT_EMBEDDING_BATCH",
	/**
	 * Context-aware PII classification + rewrite for the corpus scrub pipeline
	 * (`[pii] PII_SCRUB model-type seam`). One call-site, two interchangeable
	 * lanes: an on-device privacy-filter GGUF (default — data never leaves the
	 * device) and Eliza Cloud (bulk/Cerebras), selected by registration priority
	 * exactly like {@link ModelType.TEXT_EMBEDDING}. This is the ESCALATION tier
	 * above the free deterministic detectors ({@link ModelParamsMap} entry
	 * documents the contract) — never a replacement for them. The typed result
	 * ({@link PiiScrubResult}) structurally bans fake-clean fabrication: a handler
	 * that cannot decide MUST throw, never emit a "clean" verdict.
	 */
	PII_SCRUB: "PII_SCRUB",
	TEXT_TOKENIZER_ENCODE: "TEXT_TOKENIZER_ENCODE",
	TEXT_TOKENIZER_DECODE: "TEXT_TOKENIZER_DECODE",
	TEXT_REASONING_SMALL: "REASONING_SMALL",
	TEXT_REASONING_LARGE: "REASONING_LARGE",
	TEXT_COMPLETION: "TEXT_COMPLETION",
	IMAGE: "IMAGE",
	IMAGE_DESCRIPTION: "IMAGE_DESCRIPTION",
	TRANSCRIPTION: "TRANSCRIPTION",
	TEXT_TO_SPEECH: "TEXT_TO_SPEECH",
	AUDIO: "AUDIO",
	VIDEO: "VIDEO",
	RESEARCH: "RESEARCH",
} as const;

/**
 * Union type of all text generation model types.
 * These models accept GenerateTextParams
 */
export type TextGenerationModelType =
	| typeof ModelType.TEXT_NANO
	| typeof ModelType.TEXT_SMALL
	| typeof ModelType.TEXT_MEDIUM
	| typeof ModelType.TEXT_LARGE
	| typeof ModelType.TEXT_MEGA
	| typeof ModelType.RESPONSE_HANDLER
	| typeof ModelType.ACTION_PLANNER
	| typeof ModelType.TEXT_REASONING_SMALL
	| typeof ModelType.TEXT_REASONING_LARGE
	| typeof ModelType.TEXT_COMPLETION;

export const TEXT_GENERATION_MODEL_TYPES = [
	ModelType.TEXT_NANO,
	ModelType.TEXT_SMALL,
	ModelType.TEXT_MEDIUM,
	ModelType.TEXT_LARGE,
	ModelType.TEXT_MEGA,
	ModelType.RESPONSE_HANDLER,
	ModelType.ACTION_PLANNER,
	ModelType.TEXT_REASONING_SMALL,
	ModelType.TEXT_REASONING_LARGE,
	ModelType.TEXT_COMPLETION,
] as const satisfies readonly TextGenerationModelType[];

const TEXT_GENERATION_MODEL_TYPE_SET: ReadonlySet<string> = new Set(
	TEXT_GENERATION_MODEL_TYPES,
);

export function isTextGenerationModelType(
	modelType: unknown,
): modelType is TextGenerationModelType {
	const normalized = String(modelType ?? "")
		.trim()
		.toUpperCase();
	return TEXT_GENERATION_MODEL_TYPE_SET.has(normalized);
}

/**
 * A segment of prompt content with stability metadata for provider-level prompt caching.
 * Providers may use `stable: true` segments for caching (Anthropic cache_control,
 * OpenAI/Gemini prefix caching). Only mark content stable when it is identical across
 * calls for the same schema/character—e.g. instructions, format, examples. Per-call
 * content (state, validation UUIDs) must be unstable so caches can actually hit.
 */
export interface PromptSegment {
	content: string;
	/** true = same across calls for same schema/character; false = changes per call */
	stable: boolean;
	/**
	 * Optional per-segment prompt-cache TTL hint. Routed through the provider
	 * cache plan into Anthropic `cache_control` (`"short"` → 5m ephemeral,
	 * `"long"` → 1h ephemeral). When omitted, the breakpoint inherits the
	 * runtime-level TTL (`ANTHROPIC_PROMPT_CACHE_TTL`). Only meaningful on
	 * `stable: true` segments — dynamic segments never receive breakpoints.
	 * Use `"long"` sparingly: a 1h cache write costs 2× base input (vs 1.25×
	 * for 5m), so it only pays off for prefixes re-read across long idle gaps.
	 */
	ttl?: "short" | "long";
}

/**
 * Provider-neutral attachment content for text-generation models.
 *
 * `data` is intentionally broad enough to cover:
 * - raw base64 payloads (string)
 * - inline bytes (Uint8Array)
 * - remote URLs (URL)
 *
 * Providers decide whether to send these natively or ignore them.
 */
export interface GenerateTextAttachment {
	mediaType: string;
	data: string | Uint8Array | URL;
	filename?: string;
}

export interface ToolDefinition {
	name: string;
	description?: string;
	parameters?: JSONSchema;
	/** Provider-specific type. Defaults to a callable function/tool. */
	type?: "function" | "tool" | (string & {});
	contexts?: AgentContext[];
	metadata?: Record<string, JsonValue | object | undefined>;
	strict?: boolean;
	/** Permit strict normalization of a non-strict tool only when optional properties stay optional. */
	strictWithOptionalProperties?: boolean;
}

export type ToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "tool"; name: string }
	| { type: "function"; function: { name: string } }
	| { name: string };

export interface ToolCall {
	id: string;
	name: string;
	arguments: Record<string, JsonValue> | string;
	result?: ContentValue;
	status?: "pending" | "completed" | "failed" | (string & {});
}

export type ChatMessageRole =
	| "system"
	| "developer"
	| "user"
	| "assistant"
	| "tool";

export type ChatMessageContentPart =
	| { type: "text"; text: string }
	| { type: "image"; image: string | URL | Uint8Array; mediaType?: string }
	| {
			type: "file";
			data: string | URL | Uint8Array;
			mediaType: string;
			filename?: string;
	  }
	| { type: string; [key: string]: JsonValue | object | undefined };

export interface ChatMessage {
	role: ChatMessageRole;
	content?: string | ChatMessageContentPart[] | null;
	name?: string;
	toolCallId?: string;
	toolCalls?: ToolCall[];
	metadata?: Record<string, JsonValue | object | undefined>;
}

/**
 * Kind of a single span in a {@link ResponseSkeleton}.
 *
 * - `literal` — fixed text injected verbatim into the output (a key name,
 * a `": "` separator, a closing brace, or an enum collapsed to its single
 * allowed value). The decode loop spends **zero** sampled tokens on a
 * `literal` span — the engine splices the bytes in and continues.
 * - `enum` — a key whose value must be one of {@link ResponseSkeletonSpan.enumValues}.
 * With two-or-more values the engine constrains sampling to those tokens
 * (and can shortcut as soon as a value is unambiguous); a single value is
 * normally lowered to a `literal` by the producer.
 * - `number` — a key whose value is a JSON number. Grammar pins the
 * number-token shape; with per-span argmax sampling the engine picks the
 * most-likely number rather than letting non-zero temperature occasionally
 * tip the digit.
 * - `boolean` — a key whose value is `true` or `false`. Grammar pins the
 * alternation; argmax sampling makes the decision deterministic.
 * - `free-string` — a key whose value is a free-form JSON string the model
 * samples normally (e.g. `replyText`, `thought`).
 * - `free-json` — a key whose value is a free-form JSON sub-document the model
 * samples normally (e.g. `extract`, an action `parameters` object).
 */
export type ResponseSkeletonSpanKind =
	| "literal"
	| "enum"
	| "number"
	| "boolean"
	| "free-string"
	| "free-json";

/**
 * One ordered span of a forced response skeleton.
 *
 * A {@link ResponseSkeleton} is a flat, ordered list of these. The engine
 * walks the list: it emits every `literal` span's `value` directly, and
 * for every non-literal span it samples the value under whatever constraint
 * the kind implies, then emits the next `literal` (the `,\n` / next-key glue)
 * and continues. `key` is informational for the producer/consumer; the actual
 * text injected for the key itself is carried by the surrounding `literal`
 * spans, so the engine never has to know JSON layout rules.
 */
export interface ResponseSkeletonSpan {
	kind: ResponseSkeletonSpanKind;
	/**
	 * The envelope key this span produces a value for. Omitted for pure
	 * structural `literal` spans (opening `{`, the `": "` glue, trailing `}`).
	 */
	key?: string;
	/**
	 * For `literal` spans: the exact text to inject. For `enum` spans lowered
	 * to a literal by the producer this is the single chosen value.
	 */
	value?: string;
	/** For `enum` spans: the allowed values, in the order they should be tried. */
	enumValues?: string[];
	/**
	 * Optional GBNF non-terminal name the engine should pin this span's free
	 * value to (lets the producer reuse a shared sub-grammar, e.g. an action's parameter
	 * schema). When unset the engine uses the kind's default rule.
	 */
	rule?: string;
}

/**
 * A structured description of the response JSON envelope to in-fill, produced
 * by `buildResponseGrammar(...)` and consumed by the local llama-server
 * backend. It is the engine-neutral form of the per-turn structure-forcing
 * contract: which keys appear, in what order, which positions are sampled vs
 * literal, and the allowed values for enums. The engine may compile this to a
 * lazy GBNF (preferred — the model only spends tokens on free positions and
 * single-value enums collapse to literals) or drive it with a multi-call
 * "generate up to the next span boundary, inject the literal, continue" loop.
 *
 * Cloud adapters ignore it entirely — `responseSchema` / `tools` carry the
 * equivalent (unforced) contract for them.
 *
 * Producer: `@elizaos/core` `buildResponseGrammar`.
 * Consumer: local-inference `ffi-streaming-backend.ts`.
 */
export interface ResponseSkeleton {
	/**
	 * Ordered spans. The first span is normally the opening `{` literal and the
	 * last the closing `}` literal; everything between alternates key-glue
	 * literals and value spans.
	 */
	spans: ResponseSkeletonSpan[];
	/**
	 * Optional opaque identifier the engine can use as a cache key for a
	 * compiled grammar (the producer sets it from the action/evaluator set + contexts so
	 * grammars are reused across turns when the structure is unchanged).
	 */
	id?: string;
}

/**
 * Per-span sampler override for structured generation. Indexed by position
 * into `ResponseSkeleton.spans` (NOT free-span index). For positions whose
 * skeleton span is an `enum`, `number`, or `boolean`, the engine should pick
 * the argmax (force temperature=0 / top_k=1) so the model never "randomly"
 * picks an unlikely value at a position that already has a single
 * high-probability winner.
 *
 * Engines that don't honor per-span sampling either ignore this field
 * entirely (grammar still constrains the same tokens, just without the
 * argmax guarantee) or apply it as a whole-call override when every free
 * span has an override (`strict` mode in {@link SpanSamplerPlan} surfaces
 * the strict-mode requirement).
 */
export interface SpanSamplerOverride {
	/** Index into {@link ResponseSkeleton.spans} this override applies to. */
	spanIndex: number;
	/** Override temperature for the duration of this span. 0 = greedy argmax. */
	temperature: number;
	/**
	 * Override top_k for the duration of this span. 1 = greedy argmax. Most
	 * engines need this set in addition to temperature=0 to get a true argmax.
	 */
	topK?: number;
	/** Override top_p. Rarely needed when temperature=0. */
	topP?: number;
}

/**
 * Bundle of per-span sampler overrides for a structured generation call. The
 * agent's structure-forcing layer derives this from the {@link ResponseSkeleton}:
 * every `enum` / `number` / `boolean` span gets `temperature: 0, topK: 1` so the
 * model never randomly tips an enum or numerical decision that has a clear
 * argmax winner.
 *
 * Producer: `@elizaos/core` `buildSpanSamplerPlan(skeleton)`.
 * Consumer: local-inference engine → llama-server fork extension
 * `eliza_span_samplers` body field. Eliza Cloud fork extension
 * `x-eliza-span-samplers` header.
 */
export interface SpanSamplerPlan {
	/** Per-position overrides. Spans not listed keep the call-level sampler. */
	overrides: SpanSamplerOverride[];
	/**
	 * When true, the backend must honor the per-span overrides — fail loudly
	 * (do not silently fall back to whole-call sampling) if it cannot. Default
	 * `false`: engines that can't honor it simply ignore the field.
	 */
	strict?: boolean;
}

/**
 * Parameters for generating text using a language model.
 * This structure is typically passed to `AgentRuntime.useModel` when the `modelType` is one of
 * `ModelType.TEXT_SMALL`, `ModelType.TEXT_LARGE`, or `ModelType.TEXT_COMPLETION`.
 * It includes essential information like the prompt and various generation controls.
 *
 * **Note for Plugin Implementers**: Different LLM providers have varying support for these parameters.
 * Some providers may not support both `temperature` and `topP` simultaneously, or may have other restrictions.
 * Plugin implementations should filter out unsupported parameters before calling their provider's API.
 * Check your provider's documentation to determine which parameters are supported.
 *
 * **Local structure-forcing fields** (`prefill`, `responseSkeleton`, `grammar`,
 * `streamStructured`, `spanSamplerPlan`): honoured only by the local llama-server
 * engine — and, on the cloud path, the Eliza Cloud fork of llama-server
 * that backs the hosted `eliza-1` deployments. Cloud / HTTP adapters that can't
 * act on them simply leave them unread — there is no fallback branch; the
 * request still works, just without forcing.
 */
export interface GenerateTextParams {
	[MODEL_CANONICAL_CONTEXT]?: ContextObject;
	/** Non-enumerable runtime metadata; never part of the provider request body. */
	[MODEL_PROVIDER_ATTEMPTS]?: ModelProviderAttempt[];
	/** Runtime-only hook used to prepare request content for each resolved model attempt. */
	prepareModelAttempt?: (
		attempt: ModelAttemptContext,
		params: GenerateTextParams,
	) => Promise<void> | void;
	/** Concatenated prompt for text-only adapters. Callers using structured messages leave this unset. */
	prompt?: string;
	maxTokens?: number;
	/**
	 * When true, the adapter must avoid applying the runtime's normal default
	 * output cap and instead use the provider/model maximum. Most hosted adapters
	 * do this by omitting the max-tokens field; APIs that require a value (or
	 * local backends that would otherwise fall back to a small default) send a
	 * model/provider max instead. Scoped opt-in (e.g. direct-channel Stage 1):
	 * when unset, adapters keep their default cap so other callers stay bounded.
	 */
	omitMaxTokens?: boolean;
	minTokens?: number;
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	seed?: number;
	repetitionPenalty?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	stream?: boolean;
	responseFormat?: { type: "json_object" | "text" } | string;
	stopSequences?: string[];
	onStreamChunk?: StreamChunkCallback;
	/**
	 * Marks this generation as text that will be shown to the user, so local
	 * voice mode may route the same stream to TTS. Internal structured calls
	 * (planner, evaluators, tool repair, should-ignore JSON) must leave this
	 * unset or set it to `"internal"`.
	 */
	voiceOutput?: "user-visible" | "internal";
	/**
	 * Scheduling priority on single-lane local inference backends.
	 * On-device text runs one decode at a time; `"background"` marks deferred
	 * autonomous work (scheduled prompt tasks, prompt-batcher drains) so the
	 * local lane can (a) dispatch waiting interactive turns first, (b) bound
	 * how long the job waits for the lane before failing back to its
	 * scheduler, and (c) reject output requests unsupported by the device RAM
	 * class before dispatch. Unset means `"interactive"` (user-facing turns are
	 * never deprioritized or rewritten). Cloud adapters ignore this field.
	 *
	 * Producers: `PromptDispatcher` (prompt batcher).
	 * Consumers: the mobile/AOSP local text handlers via
	 * `InferencePriorityGate` (`utils/inference-priority-gate.ts`).
	 */
	priority?: LocalInferencePriority;
	user?: string;
	/**
	 * Provider-neutral system instruction for text-generation calls. When omitted,
	 * runtime/provider layers may derive it from the leading system message or
	 * character identity.
	 */
	system?: string;
	/**
	 * Optional multimodal attachments for the current turn. Providers that
	 * support native file/image inputs can send these directly alongside the
	 * prompt; others may ignore them and rely on prompt-only fallbacks.
	 */
	attachments?: GenerateTextAttachment[];
	/**
	 * Provider-neutral chat messages for native chat-completion APIs. Existing
	 * prompt-only providers may ignore this and use `prompt`.
	 */
	messages?: ChatMessage[];
	/** Native tool definitions available for this generation call. */
	tools?: ToolDefinition[];
	/** Native tool selection policy for this generation call. */
	toolChoice?: ToolChoice;
	/** Optional schema for structured final responses. */
	responseSchema?: JSONSchema;
	/**
	 * Optional ordered segments for prompt cache hints. When set, must satisfy:
	 * prompt === promptSegments.map(s => s.content).join("")
	 * Why: providers that ignore segments still get correct behavior via prompt;
	 * those that use segments must send the same total text so model behavior is unchanged.
	 */
	promptSegments?: PromptSegment[];
	/**
	 * Provider-specific options forwarded by adapters that support them. This is
	 * intentionally open-ended so callers can pass cache routing hints, gateway
	 * caching policy, or model-specific knobs without changing the core API for
	 * every provider.
	 */
	providerOptions?: Record<string, JsonValue | object | undefined>;
	/**
	 * Provider model id for this single generation call. Adapters that support
	 * per-call model selection should prefer this over their slot default; other
	 * adapters may ignore it.
	 */
	model?: string;
	/**
	 * Per-request cancellation. Honoured by adapters that wire it into their
	 * underlying transport (e.g. local llama backends forward to
	 * `LlamaChatSession.prompt({ stopOnAbortSignal })` and the FFI decode
	 * loop; HTTP-based providers pass it into `fetch`). The runtime
	 * composes distinct caller and streaming-context signals so either owner
	 * can cancel the request. Providers and runtime checks share that signal
	 * and its first abort reason. A sole signal or a shared reference retains
	 * its identity; caller parameters and controllers remain unchanged.
	 */
	signal?: AbortSignal;
	/**
	 * Text to seed the assistant turn with — generation continues *from here*
	 * rather than starting fresh. For chat-completion shapes this is appended as
	 * a partial trailing assistant message; for native tool-call shapes it is a
	 * partial tool-call arguments string the model continues. The local engine
	 * uses this for the "shouldRespond shortcut" and "in-fill the next
	 * param key on `,\n`" flows — once the structure up to `"replyText": "` is
	 * known it splices that in and resumes generation. Cloud adapters ignore it.
	 *
	 * Producer: `@elizaos/core` message service / grammar emitter.
	 * Consumer: local-inference engine.
	 */
	prefill?: string;
	/**
	 * Engine-neutral description of the response JSON envelope to in-fill (see
	 * {@link ResponseSkeleton}). When set, the local engine should express the
	 * whole skeleton as a lazy GBNF so only the free positions cost tokens and
	 * single-value enums collapse to literals; the multi-call boundary loop is
	 * the fallback. Cloud adapters ignore it.
	 *
	 * Producer: `@elizaos/core` `buildResponseGrammar`.
	 * Consumer: local-inference engine.
	 */
	responseSkeleton?: ResponseSkeleton;
	/**
	 * A GBNF grammar string — an alternative or companion to
	 * {@link responseSkeleton}. The engine may compile `responseSkeleton` to
	 * GBNF itself, or a caller may supply a pre-built grammar directly. If
	 * both are present the explicit `grammar` wins. Cloud adapters ignore it.
	 *
	 * Producer: grammar emitter (or the engine by compiling `responseSkeleton`).
	 * Consumer: local-inference engine → llama-server `grammar` / `grammar_lazy`.
	 */
	grammar?: string;
	/**
	 * When true the call streams its result and is parsed incrementally with
	 * per-field start/done events ({@link import("./streaming").StructuredFieldEventCallbacks}).
	 * The runtime releases only the caller's {@link streamFields} to downstream
	 * consumers, subject to {@link streamFieldGate}; every other envelope byte
	 * stays inside the runtime. Adapters that cannot stream ignore the flag and
	 * return the result whole. Distinct from `stream` (raw token stream) —
	 * `streamStructured` is "stream + structured field tracking".
	 *
	 * Producer: Stage-1 message handler (RESPONSE_HANDLER call).
	 * Consumer: local-inference engine (W4) + the runtime's field-event plumbing.
	 */
	streamStructured?: boolean;
	/**
	 * The user-visible top-level fields of a {@link streamStructured} envelope.
	 * Each streams to chunk consumers as it is generated when the
	 * {@link responseSkeleton} declares it a free string, or, with `partKinds`,
	 * when its value is an ordered `[{kind, value}]` parts array (only parts of
	 * those kinds stream, and the first other part ends the attempt's stream).
	 * Without it a structured call streams nothing. Each attempt carries its
	 * own `streamRevision`; the caller's final result stays authoritative.
	 */
	streamFields?: readonly StructuredStreamField[];
	/**
	 * Decides per attempt whether {@link streamFields} may stream, from the
	 * complete envelope fields generated before the first of them (`null` for
	 * unstructured prose output). An allowed attempt streams only that first
	 * top-level value. Lets a caller stream only answers whose routing is
	 * already settled. Runtime-only: never sent to providers.
	 */
	streamFieldGate?: StructuredStreamGate;
	/**
	 * Per-span sampler overrides for the {@link responseSkeleton}. Derived from
	 * the skeleton's per-position kinds (every `enum` / `number` / `boolean` span
	 * gets `temperature: 0, topK: 1`) so the model never "randomly" tips a
	 * decision that has a clear argmax winner — the classic case being a
	 * `shouldRespond: "RESPOND" | "IGNORE" | "STOP"` enum where the model's
	 * 51/49 logits sometimes flip to the minority option under default
	 * temperature.
	 *
	 * Engines that honour it swap the sampler chain at the indicated spans; those
	 * that don't ignore it entirely — the grammar still constrains to the same
	 * tokens, we just lose the per-span argmax determinism guarantee.
	 *
	 * Producer: `@elizaos/core` `buildSpanSamplerPlan`.
	 * Consumer: local-inference engine → llama-server fork
	 * `eliza_span_samplers` body field. Eliza Cloud llama-server fork
	 * via the `x-eliza-span-samplers` header.
	 */
	spanSamplerPlan?: SpanSamplerPlan;
}

/** A user-visible field of a structured stream (see `streamFields`). */
export interface StructuredStreamField {
	field: string;
	/** Part kinds whose `value` streams when the field is a parts array. */
	partKinds?: readonly string[];
}

/**
 * Decides whether structured stream fields may start, from the complete
 * top-level envelope fields that precede them (`null` for unstructured prose).
 */
export type StructuredStreamGate = (
	preceding: Readonly<Record<string, unknown>> | null,
) => boolean;

/** Shared only by dispatches within one useModel call, including router delegates. */
export const MODEL_PROVIDER_ATTEMPTS: unique symbol = Symbol.for(
	"eliza.modelProviderAttempts",
);

/** Exact dispatched registration, not a provider-wide or cross-call blacklist. */
export interface ModelProviderAttempt {
	modelType: string;
	provider: string;
	handler: object;
	error?: unknown;
}

/** Exact registration identity selected for one runtime model attempt. */
export interface ModelAttemptContext {
	modelType: string;
	provider: string;
	metadata?: ModelRegistrationMetadata;
}

/**
 * Token usage information from a model response.
 * Provides metrics about token consumption for billing and monitoring.
 *
 * `cacheReadInputTokens` and `cacheCreationInputTokens` are extension fields
 * for v5 cache observability. Not in the protobuf today; adapters that know
 * about provider-side cache (Anthropic prompt caching, OpenAI cached input,
 * etc.) populate them. Consumers that don't care can ignore them.
 *
 * `reasoningTokens` is the hidden reasoning-token count that reasoning models
 * (Cerebras zai-glm-4.7, OpenAI o-series, gpt-oss) report inside the
 * completion budget (`completion_tokens_details.reasoning_tokens`). It is
 * additive: adapters surface it only when the provider returns it, and
 * consumers that don't care can ignore it. Missing stays missing — never zero
 * — so an unattributed burst is distinguishable from a confirmed none.
 */
export interface TokenUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
	reasoningTokens?: number;
}

/**
 * Result of a streaming text generation request.
 * Provides an async iterable for consuming text chunks as they arrive.
 *
 * @example
 * ```typescript
 * const result = await runtime.useModel(ModelType.TEXT_LARGE, {
 * prompt: "Hello",
 * stream: true
 * }) as TextStreamResult;
 *
 * let fullText = '';
 * for await (const chunk of result.textStream) {
 * fullText += chunk;
 * console.log('Received:', chunk);
 * }
 *
 * // After stream completes
 * const usage = await result.usage;
 * console.log('Total tokens:', usage.totalTokens);
 * ```
 */
export interface TextStreamResult {
	/**
	 * Async iterable that yields text chunks as they are generated.
	 * Each iteration provides a string chunk of the response.
	 */
	textStream: AsyncIterable<string>;

	/**
	 * Promise that resolves to the complete text after streaming finishes.
	 * Useful when you need the full response after streaming.
	 */
	text: Promise<string>;

	/**
	 * Promise that resolves to token usage information after streaming completes.
	 * May be undefined if the provider doesn't report usage for streaming.
	 */
	usage: Promise<TokenUsage | undefined>;

	/**
	 * Promise that resolves to the finish reason after streaming completes.
	 * Common values: 'stop', 'length', 'content-filter'
	 */
	finishReason: Promise<string | undefined>;

	/**
	 * Optional native tool calls surfaced by providers that stream tool use
	 * (e.g. plugin-openai, plugin-codex-cli). Shape is provider-specific; the
	 * runtime duck-types this field off the stream result, so it is typed
	 * permissively rather than to one provider's tool-call shape.
	 */
	toolCalls?: unknown;

	/**
	 * Optional provider-specific metadata attached to the stream result
	 * (e.g. `{ modelName }`). Read opportunistically by the runtime.
	 */
	providerMetadata?: Record<string, unknown>;
}

/**
 * Result of a streaming text-to-speech request. Lets a caller play audio as it
 * is synthesized instead of waiting for the whole clip. Returned by a
 * TEXT_TO_SPEECH handler when `TextToSpeechParams.audioStream` is true; the
 * buffered `Uint8Array`/`Buffer` shape is still returned otherwise.
 *
 * @example
 * ```typescript
 * const result = await runtime.useModel(ModelType.TEXT_TO_SPEECH, {
 * text: "hello", audioStream: true,
 * }) as AudioStreamResult;
 * for await (const chunk of result.audioStream) sink.write(chunk);
 * const full = await result.bytes; // complete audio after the stream ends
 * ```
 */
export interface AudioStreamResult {
	/** Async iterable of audio byte chunks as they are synthesized. */
	audioStream: AsyncIterable<Uint8Array>;
	/** Resolves to the complete concatenated audio after streaming finishes. */
	bytes: Promise<Uint8Array>;
	/** MIME type of the audio (e.g. "audio/mpeg", "audio/wav", "audio/pcm"). */
	mimeType: string;
}

/**
 * Options for the simplified generateText API.
 * Extends GenerateTextParams with additional configuration for character context.
 */
export interface GenerateTextOptions {
	includeCharacter?: boolean;
	modelType?: TextGenerationModelType;
	maxTokens?: number;
	minTokens?: number;
	temperature?: number;
	frequencyPenalty?: number;
	presencePenalty?: number;
	stopSequences?: string[];
	topP?: number;
	topK?: number;
	minP?: number;
	seed?: number;
	repetitionPenalty?: number;
	user?: string;
	responseFormat?: { type: "json_object" | "text" } | string;
}

/**
 * Structured response from text generation.
 */
export interface GenerateTextResult {
	text: string;
	/**
	 * Raw assistant content as returned by some provider adapters: either a flat
	 * string or an array of content parts (e.g. Anthropic/OpenAI v5 message
	 * parts). Normalized to `text` by `getV5ModelText`/`extractGenerateTextContentText`.
	 */
	content?: string | GenerateTextContentPart[];
	/**
	 * Some provider adapters surface the assistant message under `response`
	 * instead of `text`. Normalized away by the same helpers.
	 */
	response?: string;
	usage?: TokenUsage;
	finishReason?: string;
	toolCalls?: ToolCall[];
	providerMetadata?: Record<string, JsonValue | object | undefined>;
}

/**
 * A single content part within a {@link GenerateTextResult.content} array, as
 * returned by chat-completion provider adapters (text/output_text parts carry
 * their string under `text`; some carry it under `content`).
 */
export interface GenerateTextContentPart {
	/** Provider-scoped metadata needed to replay private assistant content. */
	providerOptions?: Record<string, JsonValue | object | undefined>;
	type?: string;
	text?: string;
	content?: string;
}

/**
 * Parameters for text tokenization models
 */
export interface TokenizeTextParams {
	prompt: string;
	modelType: ModelTypeName;
}

/**
 * Parameters for detokenizing text, i.e., converting a sequence of numerical tokens back into a string.
 * This is the reverse operation of tokenization.
 * This structure is used with `AgentRuntime.useModel` when the `modelType` is `ModelType.TEXT_TOKENIZER_DECODE`.
 */
export interface DetokenizeTextParams {
	tokens: number[];
	modelType: ModelTypeName;
}

/**
 * Parameters for text embedding models
 */
export interface TextEmbeddingParams {
	text: string;
	/** Cancels the underlying embedding request with its owning turn. */
	signal?: AbortSignal;
}

/**
 * Parameters for batch text embedding models — embed many texts in one call.
 */
export interface BatchTextEmbeddingParams {
	texts: string[];
}

/**
 * A single pseudonym assignment slice handed to a {@link ModelType.PII_SCRUB}
 * call: one real-entity cluster mapped to its stable session surrogate. The
 * scrub call-site passes ONLY the assignments relevant to the current chunk
 * (`the cluster→pseudonym slice relevant to this chunk`), never the whole secret
 * map — a model must never receive the full mapping table (it is a secret
 * artifact).
 */
export interface PiiPseudonymAssignment {
	/** Stable id of the entity cluster this assignment covers. */
	readonly entityClusterId: string;
	/** The realistic surrogate the model should use in its rewrite. */
	readonly surrogate: string;
	/** Entity class (`person`, `org`, `location`, …). */
	readonly kind: string;
}

/**
 * Parameters for the {@link ModelType.PII_SCRUB} escalation call — context-aware
 * PII classification + rewrite for candidates the deterministic tier-0 detectors
 * could not decide. This is the ESCALATION tier, not a replacement for tier-0:
 * the pipeline always runs the free deterministic detectors first and only calls
 * this seam for the residue.
 */
export interface PiiScrubParams {
	/** The chunk of text to classify / rewrite. */
	text: string;
	/**
	 * Exact candidate spans the deterministic tier-0 detectors did not fully
	 * cover. The handler must return a verdict for each span or throw; absence is
	 * never interpreted as clean.
	 */
	candidateSpans: readonly string[];
	/**
	 * Optional retrieval context that helps the model disambiguate borderline
	 * candidates (surrounding messages, thread summary). Never the secret
	 * mapping table.
	 */
	contextPack?: string;
	/**
	 * The cluster→surrogate slice relevant to THIS chunk only — never the whole
	 * corpus secret map. Lets the model rewrite consistently with the corpus-wide
	 * pseudonym assignment without ever seeing the full vault.
	 */
	pseudonymAssignments?: readonly PiiPseudonymAssignment[];
	/**
	 * The active ruleset version. Threaded through so the result is
	 * content-addressable (`pii:<sha256(content)>:v<rulesetVersion>`) and a
	 * ruleset bump re-scrubs deterministically.
	 */
	rulesetVersion: string;
	/**
	 * Scheduling priority on single-lane local backends. The scrub is deferred
	 * autonomous work, so this is `"background"` — it must never queue ahead of
	 * an interactive turn. Cloud adapters ignore it.
	 */
	priority?: LocalInferencePriority;
	/** Per-request cancellation, forwarded to the underlying transport. */
	signal?: AbortSignal;
}

/**
 * The kind of decision a {@link PiiScrubVerdict} carries for one span.
 * - `pii`: the span is sensitive and must be replaced with `replacement`.
 * - `safe`: the model positively judged the span non-sensitive (an explicit,
 * auditable "I looked and it is clean" — NOT the absence of a verdict).
 */
export type PiiScrubVerdictKind = "pii" | "safe";

/**
 * One model verdict over a single candidate span. A `pii` verdict MUST carry a
 * `replacement`; a `safe` verdict is an explicit positive judgment. There is no
 * "unknown" verdict kind on purpose: a model that cannot decide throws (see the
 * error doctrine on {@link ModelResultMap}), it never fabricates a `safe`.
 */
export interface PiiScrubVerdict {
	/** The exact candidate substring this verdict is about. */
	readonly span: string;
	/** Whether the span is PII (replace) or positively judged safe (keep). */
	readonly kind: PiiScrubVerdictKind;
	/** Optional link back to the pseudonym cluster this span belongs to. */
	readonly entityClusterId?: string;
	/**
	 * The surrogate to substitute when `kind === "pii"`. Required for `pii`
	 * verdicts, absent for `safe`. Enforced structurally by
	 * {@link assertValidScrubResult}.
	 */
	readonly replacement?: string;
}

/**
 * Typed result of a {@link ModelType.PII_SCRUB} call. The shape structurally
 * bans fake-clean fabrication: a handler NEVER returns an empty/absent result
 * to mean "clean" — it either returns explicit per-span verdicts or throws.
 * `modelId` + `rulesetVersion` make the verdict auditable and content-addressable.
 */
export interface PiiScrubResult {
	/** One verdict per candidate span the model was asked to judge. */
	readonly verdicts: readonly PiiScrubVerdict[];
	/** Provider model id that produced these verdicts (audit trail). */
	readonly modelId: string;
	/** The ruleset version this scrub was performed under. */
	readonly rulesetVersion: string;
}

/**
 * Parameters for image generation models
 */
export interface ImageGenerationParams {
	prompt: string;
	size?: string;
	count?: number;
}

/**
 * Parameters for image description models
 */
export interface ImageDescriptionParams {
	imageUrl: string;
	prompt?: string;
	signal?: AbortSignal;
	/**
	 * Explicit opt-in token-by-token streaming of the generated description.
	 * Hidden preprocessing calls must leave this false/undefined so ambient chat
	 * streaming callbacks are not exposed to the user.
	 */
	stream?: boolean;
	onStreamChunk?: StreamChunkCallback;
}
export interface ImageDescriptionResult {
	title: string;
	description: string;
}
export interface ImageGenerationResult {
	url: string;
}

/**
 * Parameters for transcription models
 */
export interface TranscriptionParams {
	audioUrl: string;
	/** Raw audio bytes for providers that accept in-process media. */
	audio?: Uint8Array | ArrayBuffer;
	mimeType?: string;
	prompt?: string;
	signal?: AbortSignal;
	/**
	 * Call-site intent for providers and metering gateways. "interim" denotes
	 * repeated, overlapping ASR windows used to stabilize a live transcript and
	 * must not be counted as a user-visible billable transcription result.
	 */
	transcriptionPurpose?: "interim" | "final";
	billing?: {
		billable: boolean;
		reason?: string;
	};
	/**
	 * Reserved for incremental ASR providers. Current first-party local handlers
	 * are buffered and ignore this field.
	 */
	stream?: boolean;
	onStreamChunk?: StreamChunkCallback;
}

/**
 * Parameters for text-to-speech models
 */
export interface TextToSpeechParams {
	text: string;
	voice?: string;
	speed?: number;
	signal?: AbortSignal;
	/**
	 * Explicit opt-in for streamed audio: when true, the handler MAY return an
	 * {@link AudioStreamResult} (audio chunks as they synthesize) instead of the
	 * full buffer, so playback can start before the whole clip is ready.
	 * Handlers without streaming support ignore it and return the buffered shape.
	 *
	 * This is intentionally a DISTINCT flag from the generic `stream` (which
	 * `AgentRuntime.useModel` auto-injects from an ambient text-streaming
	 * context): a TTS call made inside a streaming reply turn (e.g. the
	 * GENERATE_MEDIA action) must keep returning bytes unless the caller
	 * explicitly consumes a stream. Only callers that handle `AudioStreamResult`
	 * set `audioStream: true`.
	 */
	audioStream?: boolean;
}

/**
 * Parameters for audio processing models
 */
export interface AudioProcessingParams {
	audioUrl?: string;
	processingType?: string;
	prompt?: string;
	audioKind?: "music" | "sfx" | "tts" | string;
	text?: string;
	duration?: number;
	durationSeconds?: number;
	instrumental?: boolean;
	genre?: string;
	voice?: string;
	model?: string;
	provider?: string;
	outputFormat?: string;
	referenceUrl?: string;
	seed?: number;
	signal?: AbortSignal;
}

/**
 * Parameters for video processing models
 */
export interface VideoProcessingParams {
	videoUrl?: string;
	processingType?: string;
	prompt?: string;
	duration?: number;
	durationSeconds?: number;
	aspectRatio?: string;
	imageUrl?: string;
	referenceUrl?: string;
	model?: string;
	resolution?: string;
	audio?: boolean;
	voiceControl?: boolean;
	signal?: AbortSignal;
}

/**
 * Research tool configuration for web search
 */
export interface ResearchWebSearchTool {
	type: "web_search_preview";
}

/**
 * Research tool configuration for file search over vector stores
 */
export interface ResearchFileSearchTool {
	type: "file_search";
	/** Array of vector store IDs to search (max 2) */
	vectorStoreIds: string[];
}

/**
 * Research tool configuration for code interpreter
 */
export interface ResearchCodeInterpreterTool {
	type: "code_interpreter";
	/** Container configuration */
	container?: { type: "auto" };
}

/**
 * Research tool configuration for remote MCP servers.
 * MCP servers must implement a search/fetch interface for deep research compatibility.
 */
export interface ResearchMcpTool {
	type: "mcp";
	/** Label to identify the MCP server */
	serverLabel: string;
	/** URL of the remote MCP server */
	serverUrl: string;
	/** Approval mode - must be "never" for deep research */
	requireApproval?: "never";
}

/**
 * Union type for all supported research tools
 */
export type ResearchTool =
	| ResearchWebSearchTool
	| ResearchFileSearchTool
	| ResearchCodeInterpreterTool
	| ResearchMcpTool;

/**
 * Parameters for deep research models (o3-deep-research, o4-mini-deep-research).
 *
 * Deep research models can find, analyze, and synthesize hundreds of sources
 * to create comprehensive reports. They support web search, file search over
 * vector stores, and remote MCP servers as data sources.
 *
 * @example
 * ```typescript
 * const result = await runtime.useModel(ModelType.RESEARCH, {
 * input: "Research the economic impact of AI on global labor markets",
 * tools: [
 * { type: "web_search_preview" },
 * { type: "code_interpreter", container: { type: "auto" } }
 * ],
 * background: true,
 * });
 * ```
 */
export interface ResearchParams {
	/**
	 * The research input/question.
	 * Should be a detailed, specific question for best results.
	 */
	input: string;

	/**
	 * Optional instructions to guide the research process.
	 * Can include formatting requirements, source preferences, etc.
	 */
	instructions?: string;

	/**
	 * Whether to run the request in background mode.
	 * Recommended for long-running research tasks (can take tens of minutes).
	 * When true, the request returns immediately and results can be polled.
	 * @default false
	 */
	background?: boolean;

	/**
	 * Optional cancellation signal for the provider request.
	 * The first-party research providers combine it with their configured
	 * request timeout, so either caller cancellation or the deadline aborts the
	 * underlying request.
	 */
	signal?: AbortSignal;

	/**
	 * Array of tools/data sources for the research model.
	 * Must include at least one data source: web_search_preview, file_search, or mcp.
	 * Can also include code_interpreter for data analysis.
	 */
	tools?: ResearchTool[];

	/**
	 * Maximum number of tool calls the model can make.
	 * Use this to control cost and latency.
	 */
	maxToolCalls?: number;

	/**
	 * Whether to include reasoning summary in the response.
	 * @default "auto"
	 */
	reasoningSummary?: "auto" | "none";

	/**
	 * Model variant to use.
	 * @default "o3-deep-research"
	 */
	model?: "o3-deep-research" | "o4-mini-deep-research";
}

/**
 * Annotation in research results, linking text to sources
 */
export interface ResearchAnnotation {
	/** URL of the source */
	url: string;
	/** Title of the source */
	title: string;
	/** Start index in the text where this citation appears */
	startIndex: number;
	/** End index in the text where this citation ends */
	endIndex: number;
}

/**
 * Web search action taken by the research model
 */
export interface ResearchWebSearchCall {
	id: string;
	type: "web_search_call";
	status: "completed" | "failed";
	action: {
		type: "search" | "open_page" | "find_in_page";
		query?: string;
		url?: string;
	};
}

/**
 * File search action taken over vector stores
 */
export interface ResearchFileSearchCall {
	id: string;
	type: "file_search_call";
	status: "completed" | "failed";
	query: string;
	results?: Array<{
		fileId: string;
		fileName: string;
		score: number;
	}>;
}

/**
 * Code interpreter action for data analysis
 */
export interface ResearchCodeInterpreterCall {
	id: string;
	type: "code_interpreter_call";
	status: "completed" | "failed";
	code: string;
	output?: string;
}

/**
 * MCP tool call made to a remote server
 */
export interface ResearchMcpToolCall {
	id: string;
	type: "mcp_tool_call";
	status: "completed" | "failed";
	serverLabel: string;
	toolName: string;
	arguments: Record<string, JsonValue>;
	result?: JsonValue;
}

/**
 * Final message output from research
 */
export interface ResearchMessageOutput {
	type: "message";
	content: Array<{
		type: "output_text";
		text: string;
		annotations: ResearchAnnotation[];
	}>;
}

/**
 * Union type for all research output items
 */
export type ResearchOutputItem =
	| ResearchWebSearchCall
	| ResearchFileSearchCall
	| ResearchCodeInterpreterCall
	| ResearchMcpToolCall
	| ResearchMessageOutput;

/**
 * Result from a deep research model request
 */
export interface ResearchResult {
	/** Unique identifier for the response */
	id: string;

	/** The final research report text with inline citations */
	text: string;

	/** Annotations linking text to sources - should be displayed as clickable links */
	annotations: ResearchAnnotation[];

	/**
	 * Output items showing the research process.
	 * Includes web searches, file searches, code execution, and MCP calls.
	 */
	outputItems: ResearchOutputItem[];

	/**
	 * For background requests, the current status
	 */
	status?: "queued" | "in_progress" | "completed" | "failed";
}

export type { JSONSchema } from "./schema";

/**
 * Map of model types to their parameter types
 */
export interface ModelParamsMap {
	[ModelType.TEXT_NANO]: GenerateTextParams;
	[ModelType.TEXT_SMALL]: GenerateTextParams;
	[ModelType.TEXT_MEDIUM]: GenerateTextParams;
	[ModelType.TEXT_LARGE]: GenerateTextParams;
	[ModelType.TEXT_MEGA]: GenerateTextParams;
	[ModelType.RESPONSE_HANDLER]: GenerateTextParams;
	[ModelType.ACTION_PLANNER]: GenerateTextParams;
	[ModelType.TEXT_REASONING_SMALL]: GenerateTextParams;
	[ModelType.TEXT_REASONING_LARGE]: GenerateTextParams;
	[ModelType.TEXT_EMBEDDING]: TextEmbeddingParams | string | null;
	[ModelType.TEXT_EMBEDDING_BATCH]: BatchTextEmbeddingParams;
	[ModelType.PII_SCRUB]: PiiScrubParams;
	[ModelType.TEXT_TOKENIZER_ENCODE]: TokenizeTextParams;
	[ModelType.TEXT_TOKENIZER_DECODE]: DetokenizeTextParams;
	[ModelType.IMAGE]: ImageGenerationParams;
	[ModelType.IMAGE_DESCRIPTION]: ImageDescriptionParams | string;
	[ModelType.TRANSCRIPTION]: TranscriptionParams | Buffer | string;
	[ModelType.TEXT_TO_SPEECH]: TextToSpeechParams | string;
	[ModelType.AUDIO]: AudioProcessingParams;
	[ModelType.VIDEO]: VideoProcessingParams;
	[ModelType.TEXT_COMPLETION]: GenerateTextParams;
	[ModelType.RESEARCH]: ResearchParams;
	// Custom model types should be registered via runtime.registerModel() in plugin init()
}

/**
 * Map of model types to their DEFAULT return value types.
 *
 * For text generation models (TEXT_SMALL, TEXT_LARGE, etc.),
 * the actual return type depends on the parameters and is handled by overloads:
 * - `{ prompt }`: Returns `string` (this default)
 * - `{ prompt, stream: true }`: Returns `TextStreamResult` (via overload)
 *
 * The overloads in IAgentRuntime.useModel() provide the correct type inference.
 */
export interface ModelResultMap {
	[ModelType.TEXT_NANO]: string;
	[ModelType.TEXT_SMALL]: string;
	[ModelType.TEXT_MEDIUM]: string;
	[ModelType.TEXT_LARGE]: string;
	[ModelType.TEXT_MEGA]: string;
	[ModelType.RESPONSE_HANDLER]: string;
	[ModelType.ACTION_PLANNER]: string;
	[ModelType.TEXT_REASONING_SMALL]: string;
	[ModelType.TEXT_REASONING_LARGE]: string;
	[ModelType.TEXT_EMBEDDING]: number[];
	[ModelType.TEXT_EMBEDDING_BATCH]: number[][];
	[ModelType.PII_SCRUB]: PiiScrubResult;
	[ModelType.TEXT_TOKENIZER_ENCODE]: number[];
	[ModelType.TEXT_TOKENIZER_DECODE]: string;
	[ModelType.IMAGE]: ImageGenerationResult[];
	[ModelType.IMAGE_DESCRIPTION]: ImageDescriptionResult;
	[ModelType.TRANSCRIPTION]: string;
	[ModelType.TEXT_TO_SPEECH]: Buffer | ArrayBuffer | Uint8Array;
	[ModelType.AUDIO]:
		| Buffer
		| ArrayBuffer
		| Uint8Array
		| Record<string, JsonValue>;
	[ModelType.VIDEO]:
		| Buffer
		| ArrayBuffer
		| Uint8Array
		| Record<string, JsonValue>;
	[ModelType.TEXT_COMPLETION]: string;
	[ModelType.RESEARCH]: ResearchResult;
	// Custom model types should be registered via runtime.registerModel() in plugin init()
}

/**
 * Models that support streaming - their handlers can return either string or TextStreamResult
 */
export type StreamableModelType = TextGenerationModelType;

/**
 * Model types whose handlers may return a streamed-audio result.
 */
export type StreamableAudioModelType = typeof ModelType.TEXT_TO_SPEECH;

/**
 * Result type for plugin model handlers — includes TextStreamResult for
 * streamable text models and AudioStreamResult for streamable audio (TTS).
 */
export type PluginModelResult<K extends keyof ModelResultMap> =
	K extends StreamableModelType
		? ModelResultMap[K] | TextStreamResult
		: K extends StreamableAudioModelType
			? ModelResultMap[K] | AudioStreamResult
			: ModelResultMap[K];

// A chain is consulted only after the requested registration failed with a
// failover-class error (rate limit, 5xx, timeout, provider warming budget); a
// healthy primary is never bypassed. Every text tier therefore ends in a
// registration of a different tier so a deployment that splits its small and
// large slots across two provider models (two rate-limit buckets) has a
// cross-bucket candidate after an exhausted bucket, instead of a hard failure
// (TEXT_SMALL/TEXT_LARGE had no chain) or a replay into the same bucket.
const MODEL_FALLBACK_CHAINS: Readonly<Record<string, readonly string[]>> = {
	[ModelType.TEXT_NANO]: [
		ModelType.TEXT_NANO,
		ModelType.TEXT_SMALL,
		ModelType.TEXT_MEDIUM,
		ModelType.TEXT_LARGE,
	],
	[ModelType.TEXT_SMALL]: [
		ModelType.TEXT_SMALL,
		ModelType.TEXT_MEDIUM,
		ModelType.TEXT_LARGE,
	],
	[ModelType.TEXT_MEDIUM]: [
		ModelType.TEXT_MEDIUM,
		ModelType.TEXT_SMALL,
		ModelType.TEXT_LARGE,
	],
	[ModelType.TEXT_LARGE]: [
		ModelType.TEXT_LARGE,
		ModelType.TEXT_MEDIUM,
		ModelType.TEXT_SMALL,
	],
	[ModelType.TEXT_MEGA]: [
		ModelType.TEXT_MEGA,
		ModelType.TEXT_LARGE,
		ModelType.TEXT_MEDIUM,
	],
	[ModelType.RESPONSE_HANDLER]: [
		ModelType.RESPONSE_HANDLER,
		ModelType.TEXT_NANO,
		ModelType.TEXT_SMALL,
		ModelType.TEXT_MEDIUM,
		ModelType.TEXT_LARGE,
	],
	[ModelType.ACTION_PLANNER]: [
		ModelType.ACTION_PLANNER,
		ModelType.TEXT_MEDIUM,
		ModelType.TEXT_SMALL,
		ModelType.TEXT_LARGE,
	],
};

/** Static per-type failover order; callers must not mutate the returned chain. */
export function getModelFallbackChain(
	modelType: ModelTypeName,
): readonly string[] {
	const modelKey = String(modelType);
	return MODEL_FALLBACK_CHAINS[modelKey] ?? [modelKey];
}

/**
 * Defines the structure for a model handler registration within the `AgentRuntime`.
 * Each model (e.g., for text generation, embedding) is associated with a handler function,
 * the name of the provider (plugin or system) that registered it, and an optional priority.
 * The `priority` (higher is more preferred) helps in selecting which handler to use if multiple
 * handlers are registered for the same model type. The `registrationOrder` (not in type, but used in runtime)
 * serves as a tie-breaker. See `AgentRuntime.registerModel` and `AgentRuntime.getModel`.
 */
export interface ModelHandler<
	TParams = Record<string, JsonValue | object>,
	TResult = JsonValue | object,
> {
	/** The function that executes the model, taking runtime and parameters, and returning a Promise. */
	handler: (runtime: IAgentRuntime, params: TParams) => Promise<TResult>;
	/** The name of the provider (e.g., plugin name) that registered this model handler. */
	provider: string;
	/**
	 * Optional priority for this model handler. Higher numbers indicate higher priority.
	 * This is used by `AgentRuntime.getModel` to select the most appropriate handler
	 * when multiple are available for a given model type. Defaults to 0 if not specified.
	 */
	priority?: number; // Optional priority for selection order

	registrationOrder?: number;

	/** Optional provider-declared metadata for display/routing observers. */
	metadata?: ModelRegistrationMetadata;
}

/**
 * Provider-declared metadata attached to a model registration.
 *
 * Keep this handler-free and serializable: it is surfaced through
 * `AgentRuntime.getModelRegistrations()` and `MODEL_REGISTERED` events.
 */
export interface ModelRegistrationMetadata {
	/**
	 * Provider-declared hard input-context ceiling. When present, the runtime
	 * uses it for complete-request diagnostics instead of inferring a limit from
	 * the display model id. Estimates never truncate input or authorize rejection.
	 */
	contextWindowTokens?: number;
	/** Provider-declared maximum generated-token count for the concrete model. */
	maxOutputTokens?: number;
	/**
	 * Concrete model id to display for this registration when callers ask what
	 * model is powering a slot.
	 */
	displayModel?: string;
	/**
	 * Runtime setting/env key that resolves to the concrete model id to display
	 * for this registration.
	 */
	displayModelSetting?: string;
	/**
	 * Ordered runtime setting/env keys used to resolve the concrete display model.
	 * The first non-empty value wins. Providers whose effective model has a
	 * fallback chain should declare that chain rather than snapshotting host env
	 * at plugin construction time.
	 */
	displayModelSettings?: string[];
	/**
	 * Provider-owned model id used only when no declared display-model setting is
	 * configured for this runtime.
	 */
	displayModelDefault?: string;
	/**
	 * Provider-declared capability: this registration runs on local/on-device
	 * inference (Ollama, LM Studio, MLX, llama.cpp, capacitor-llama, …) rather
	 * than a hosted cloud API.
	 *
	 * This is the authoritative signal for local-provider classification in
	 * action-model routing and trajectory pricing. When a provider declares this
	 * flag, routing/pricing consume it directly instead of substring-matching the
	 * provider name. The name heuristic remains only as an explicitly-tested
	 * fallback for providers that have not yet adopted the flag.
	 */
	local?: boolean;
	/**
	 * Provider-declared capability: this registration can stream tokens
	 * incrementally via the handler-facing `onStreamChunk` callback. Consumed by
	 * the runtime streaming gate; absence means "unknown / do not assume".
	 */
	streamable?: boolean;
}

/**
 * Handler-free view of a single model registration, returned by
 * `AgentRuntime.getModelRegistrations()`. Exposes the runtime's model registry
 * as metadata only — no handler function — so hosts and observers can render a
 * routing table or subscribe to registration changes without capturing
 * handlers or reaching into the private `models` map.
 */
export interface ModelRegistrationInfo {
	/** The model type key the handler is registered for (e.g. `TEXT_LARGE`). */
	modelType: string;
	/** The provider (plugin) name that registered the handler. */
	provider: string;
	/** Selection priority (higher wins); 0 when unspecified. */
	priority: number;
	/** Monotonic registration ordinal used as the priority tie-breaker. */
	registrationOrder: number;
	/** Optional provider-declared metadata. Never includes handler functions. */
	metadata?: ModelRegistrationMetadata;
}
