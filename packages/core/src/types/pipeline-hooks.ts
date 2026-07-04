/**
 * Pipeline-hook types for the single `registerPipelineHook` / `applyPipelineHooks`
 * extension model: the phase enumeration (message compose/reply, model I/O,
 * post-persist, stream chunks) and handler shapes. One registration + ordering
 * model lets the runtime attach a uniform metrics/logging envelope to every hook.
 * Rationale: `docs/PIPELINE_HOOKS.md`.
 */
import type { AgentContext } from "./contexts";
import type { Room } from "./environment";
import type { Memory } from "./memory";
import {
	type Content,
	DEFAULT_UUID,
	type MentionContext,
	type UUID,
} from "./primitives";
import type { State } from "./state";

/**
 * pipeline hooks (`registerPipelineHook` / `applyPipelineHooks`).
 *
 * **Why one subsystem:** plugins historically needed many bespoke extension points; a single
 * registration + ordering model keeps behavior discoverable and lets the runtime attach one
 * metrics/logging envelope (`PIPELINE_HOOK_METRIC`, `PIPELINE_HOOK_*_MS`) everywhere.
 *
 * Phases include message/reply steps (`incoming_before_compose`, …, `outgoing_before_deliver`),
 * model I/O (`pre_model` / `post_model` around `useModel`), `after_memory_persisted` after
 * `createMemory` commits, and **stream** hooks (`model_stream_chunk` / `model_stream_end`) on
 * raw `useModel` `textStream` plus async message-service boundaries.
 *
 * **Observability:** each handler invocation emits `EventType.PIPELINE_HOOK_METRIC` (when
 * listeners are registered) and logs at debug / warn / error thresholds — see
 * `PIPELINE_HOOK_*_MS` constants below. **Why:** slow or flaky hooks are a top production
 * failure mode; comparable timings across phases avoid one-off timing code per feature.
 *
 * @see `docs/PIPELINE_HOOKS.md` for rationale (outgoing, stream dedupe, DPE, contributor checklist).
 */

/**
 * Where outgoing text is about to be delivered (for hook logic and logging).
 */
export type OutgoingContentSource =
	| "simple"
	| "action"
	| "telegram_compose_post"
	| "reply_debug_toggle"
	| "terminal"
	/** Hooks may skip cosmetic transforms (e.g. IGNORE/STOP terminal payloads). */
	| "excluded"
	| "continuation_simple"
	| "autonomy_simple"
	| "autonomy_evaluate"
	| "evaluate"
	| (string & {});

export interface OutgoingContentContext {
	/** Lets plugins skip terminal payloads (`excluded`) or apply different rules per pipeline leg. */
	source: OutgoingContentSource;
	roomId: UUID;
	message?: Memory;
	actionName?: string;
	responseId?: UUID;
	/**
	 * When true, cosmetic plugins should usually skip (e.g. typography).
	 * Hooks assume whole-message text; streaming may still be emitting partials to the client.
	 */
	streaming?: boolean;
}

/** Log at debug when a hook meets or exceeds this duration (ms). */
export const PIPELINE_HOOK_DEBUG_LOG_MS = 100;
/** Warn loudly (and set `slow` on {@link EventType.PIPELINE_HOOK_METRIC}) from this duration up. */
export const PIPELINE_HOOK_WARN_MS = 250;
/** Escalate to error-level log for pathological hook latency. */
export const PIPELINE_HOOK_ERROR_LOG_MS = 2000;

/**
 * Built-in message / reply pipeline hook attachment points.
 */
export type PipelineHookPhase =
	| "incoming_before_compose"
	/**
	 * Inside `composeState`, after the runtime selects the provider NAMES for the
	 * turn (default selection + context routing, or an explicit include-list) but
	 * before any provider's `get()` runs. Hooks reassign `providers.current` to
	 * filter, extend, or reorder the set — letting a host app shape context per
	 * message intent (e.g. drop heavy wallet/ledger providers on a greeting, add
	 * `CRYPTO_SWAP` when transaction keywords appear). Opt-in: zero cost and
	 * identical behavior when no hook is registered. Mutator phase (serial,
	 * `mutatesPrimary`), so multiple hooks compose in `position` order.
	 *
	 * Contract: reassign `providers.current` to a `string[]`; a non-array value is
	 * ignored and the pre-hook selection is kept (a thrown hook is swallowed and
	 * continues, like every phase). Keep selection **deterministic for a given
	 * message** — `composeState` caches by `message.id`. The hook also fires for
	 * curated/internal calls (`onlyInclude === true`, e.g. response composition);
	 * those pass an exact list the runtime depends on, so gate on `onlyInclude` and
	 * no-op unless you mean to override them.
	 */
	| "compose_state_providers"
	| "pre_should_respond"
	/**
	 * Overlaps the should-respond phase (heuristics + optional classifier). **All** hooks for this
	 * phase run concurrently in one `Promise.all` — `position`, `schedule`, and `mutatesPrimary`
	 * do not create serial ordering or mutator-first buckets (unlike other phases). Prefer
	 * `pre_should_respond` for ordered mutators / readers.
	 */
	| "parallel_with_should_respond"
	| "outgoing_before_deliver"
	/** Immediately before the registered model `handler` runs (`AgentRuntime.useModel`). */
	| "pre_model"
	/** After the model handler returns (including stream consumption). Replace output via `result.current`. */
	| "post_model"
	/**
	 * After `createMemory` successfully wrote to the adapter; `memory.id` is the persisted id.
	 * Runs for every table (e.g. `messages`, `knowledge`); filter on `tableName` when needed.
	 * Set `memory.content.metadata.skipAfterMemoryPersistedHooks === true` to skip (rare).
	 */
	| "after_memory_persisted"
	/**
	 * Per stream delta: raw provider tokens from `useModel`'s `textStream` loop (`source: "use_model"`),
	 * plus **async** `onStreamChunk` boundaries (`message_service`, …).
	 * On Node, `message_service` is skipped while delivering the same chunk from `useModel`
	 * (see `getModelStreamChunkDeliveryDepth` in `streaming-context.ts`) to avoid duplicate hooks.
	 * High frequency: default `applyPipelineHooks` disables per-hook telemetry for this phase.
	 */
	| "model_stream_chunk"
	/**
	 * After a streaming leg ends: `useModel` when `textStream` is exhausted (before `post_model`),
	 * or `onStreamEnd` in action streaming context.
	 * Best-effort `text` when the caller tracks accumulated stream text.
	 */
	| "model_stream_end";

/** Who invoked a stream hook (for logging / filtering). */
export type ModelStreamHookSource =
	| "use_model"
	| "message_service"
	| "dpe"
	| (string & {});

/** `roomId` / `responseId` / `runId` shared by turn-scoped message pipeline phases. */
export type PipelineMessageCorrelation = {
	roomId: UUID;
	responseId: UUID;
	runId: UUID;
};

/** User message + correlation for incoming / should-respond phases. */
export type PipelineMessageTurnFields = PipelineMessageCorrelation & {
	message: Memory;
};

/** Common fields for `pre_model` and `post_model`. */
export type ModelCallHookCorrelation = {
	/** Slot passed to `useModel` (e.g. `ModelType.TEXT_LARGE`). */
	requestedModelType: string;
	/** Resolved delegate key after registration / LLM mode override. */
	resolvedModelKey: string;
	provider?: string;
	/** Correlation when trajectory / message context is active; else omit. */
	roomId?: UUID;
	/**
	 * Same object passed to the model handler; mutators may change fields (e.g. `prompt`).
	 * For streaming calls, `stream` is already resolved (`true`/`false`) and `onStreamChunk`
	 * has been stripped (chunks still flow via streaming context / handler return).
	 */
	params: unknown;
};

/** Shared correlation for `model_stream_chunk` / `model_stream_end`. */
export type ModelStreamHookCorrelation = {
	source: ModelStreamHookSource;
	roomId: UUID;
	runId: UUID;
	responseId?: UUID;
	messageId?: string;
};

export type PipelineHookSchedule = "serial" | "concurrent";

export type PipelineHookContext =
	| ({ phase: "incoming_before_compose" } & PipelineMessageTurnFields)
	| {
			phase: "compose_state_providers";
			/** The message state is being composed for (read-only). */
			message: Memory;
			/**
			 * The provider NAMES the runtime selected for this turn. Reassign
			 * `providers.current` to filter, extend, or reorder the set. Only names
			 * matching a registered provider take effect; final execution order is
			 * still governed by each provider's `position`. Adding a name pulls in
			 * that provider even if it is `dynamic`/`private` (explicit selection),
			 * mirroring `composeState`'s include-list. Same `current`-replacement
			 * convention as `post_model`'s `result.current`.
			 */
			providers: { current: string[] };
			/** Routing contexts the classifier selected for this turn (read-only). */
			activeContexts: readonly AgentContext[];
			/**
			 * True when the caller demanded an exact include-list (curated/internal
			 * `composeState` calls). Well-behaved hooks usually no-op when set.
			 */
			onlyInclude: boolean;
			/** The raw include-list passed to `composeState`, if any (read-only). */
			includeList: readonly string[] | null;
	  }
	| ({ phase: "pre_should_respond" } & PipelineMessageTurnFields & {
				state: State;
				isAutonomous: boolean;
			})
	| ({ phase: "parallel_with_should_respond" } & PipelineMessageTurnFields & {
				state: State;
				room: Room | undefined;
				mentionContext?: MentionContext;
				isAutonomous: boolean;
				setTranslatedUserText: (text: string) => void;
			})
	| {
			phase: "outgoing_before_deliver";
			content: Content;
			source: OutgoingContentSource;
			roomId: UUID;
			message?: Memory;
			actionName?: string;
			responseId?: UUID;
			streaming?: boolean;
	  }
	| ({ phase: "pre_model" } & ModelCallHookCorrelation)
	| ({ phase: "post_model" } & ModelCallHookCorrelation & {
				/** Wall time from start of `useModel` through handler + optional stream read. */
				durationMs: number;
				/**
				 * Final value returned from `useModel`. For streaming, this is the **fully concatenated**
				 * string after the `textStream` loop — not per-chunk. Assign `current` to replace the
				 * return value (and what downstream logging sees).
				 */
				result: { current: unknown };
				/** `true` when this call used the stream consumer path in `useModel` (callback streaming). */
				streaming?: boolean;
			})
	| {
			phase: "after_memory_persisted";
			memory: Memory;
			tableName: string;
			memoryId: UUID;
	  }
	| ({ phase: "model_stream_chunk" } & ModelStreamHookCorrelation & {
				chunk: string;
				accumulated?: string;
				/** Field path for deltas produced by DPE / structured streaming. */
				field?: string;
			})
	| ({ phase: "model_stream_end" } & ModelStreamHookCorrelation & {
				/** Accumulated text for this leg when the caller tracks it. */
				text?: string;
			});

/** Discriminated lookup: context for a single {@link PipelineHookPhase}. */
export type PipelineHookContextForPhase<P extends PipelineHookPhase> = Extract<
	PipelineHookContext,
	{ phase: P }
>;

export type PipelineHookHandler = (
	runtime: import("./runtime").IAgentRuntime,
	ctx: PipelineHookContext,
) => void | Promise<void>;

function withPipelinePhase<P extends PipelineHookPhase>(
	phase: P,
	fields: Omit<PipelineHookContextForPhase<P>, "phase">,
): PipelineHookContextForPhase<P> {
	return { phase, ...fields } as PipelineHookContextForPhase<P>;
}

export interface PipelineHookSpec {
	id: string;
	phase: PipelineHookPhase;
	/**
	 * Lower runs first within the same scheduling group (mutators, then serial readers, then concurrent), same idea as `Provider.position` in `composeState`.
	 * Ties break on `id` lexicographically. Ignored for `parallel_with_should_respond` (see phase note).
	 */
	position?: number;
	/**
	 * serial: ordered with other serial hooks (see mutatesPrimary).
	 * concurrent: after all serial work for this phase, runs in Promise.all with other concurrent hooks.
	 */
	schedule?: PipelineHookSchedule;
	/**
	 * true: runs in the first serial group with other mutators (safe for message/content edits).
	 * false: runs after mutators; can be concurrent if schedule is concurrent.
	 * Defaults: true for incoming + outgoing, false for pre_should_respond + parallel_with_should_respond.
	 */
	mutatesPrimary?: boolean;
	handler: PipelineHookHandler;
}

const PIPELINE_PHASE_CONCURRENT_DEFAULT = new Set<PipelineHookPhase>([
	"parallel_with_should_respond",
	"model_stream_chunk",
]);

export function defaultPipelineHookSchedule(
	phase: PipelineHookPhase,
): PipelineHookSchedule {
	return PIPELINE_PHASE_CONCURRENT_DEFAULT.has(phase) ? "concurrent" : "serial";
}

const PIPELINE_PHASE_MUTATES_PRIMARY_DEFAULT = new Set<PipelineHookPhase>([
	"incoming_before_compose",
	"compose_state_providers",
	"outgoing_before_deliver",
	"pre_model",
	"post_model",
]);

export function defaultPipelineHookMutatesPrimary(
	phase: PipelineHookPhase,
): boolean {
	return PIPELINE_PHASE_MUTATES_PRIMARY_DEFAULT.has(phase);
}

/** Room id for pipeline metrics / logs; falls back to {@link DEFAULT_UUID} when unknown. */
export function pipelineHookMetricRoomId(ctx: PipelineHookContext): UUID {
	switch (ctx.phase) {
		case "incoming_before_compose":
		case "pre_should_respond":
		case "parallel_with_should_respond":
		case "outgoing_before_deliver":
			return ctx.roomId;
		case "compose_state_providers":
			return ctx.message.roomId;
		case "pre_model":
		case "post_model":
			return ctx.roomId ?? DEFAULT_UUID;
		case "after_memory_persisted":
			return ctx.memory.roomId;
		case "model_stream_chunk":
		case "model_stream_end":
			return ctx.roomId;
		default: {
			const _exhaustive: never = ctx;
			void _exhaustive;
			return DEFAULT_UUID;
		}
	}
}

export type ResolvedPipelineHook = {
	id: string;
	phase: PipelineHookPhase;
	/** Resolved from `position ?? 0` (provider-style ordering). */
	position: number;
	schedule: PipelineHookSchedule;
	mutatesPrimary: boolean;
	handler: PipelineHookHandler;
};

/**
 * Sort hooks like providers in `composeState`: `(position) asc`, then `id` asc.
 */
export function sortPipelineHooksByPosition(
	hooks: ReadonlyArray<ResolvedPipelineHook>,
): ResolvedPipelineHook[] {
	return [...hooks].sort(
		(a, b) => (a.position || 0) - (b.position || 0) || a.id.localeCompare(b.id),
	);
}

export function resolvePipelineHookSpec(
	spec: PipelineHookSpec,
): ResolvedPipelineHook {
	const phase = spec.phase;
	return {
		id: spec.id,
		phase,
		position: spec.position ?? 0,
		schedule: spec.schedule ?? defaultPipelineHookSchedule(phase),
		mutatesPrimary:
			spec.mutatesPrimary ?? defaultPipelineHookMutatesPrimary(phase),
		handler: spec.handler,
	};
}

export type IncomingPipelineHookContext = Pick<
	PipelineHookContextForPhase<"incoming_before_compose">,
	"roomId" | "responseId" | "runId"
>;

export function incomingPipelineHookContext(
	message: Memory,
	correlation: IncomingPipelineHookContext,
): PipelineHookContextForPhase<"incoming_before_compose"> {
	return withPipelinePhase("incoming_before_compose", {
		message,
		...correlation,
	});
}

export function composeStateProvidersPipelineHookContext(
	fields: Omit<PipelineHookContextForPhase<"compose_state_providers">, "phase">,
): PipelineHookContextForPhase<"compose_state_providers"> {
	return withPipelinePhase("compose_state_providers", fields);
}

export function preShouldRespondPipelineHookContext(
	message: Memory,
	fields: Pick<
		PipelineHookContextForPhase<"pre_should_respond">,
		"roomId" | "responseId" | "runId" | "state" | "isAutonomous"
	>,
): PipelineHookContextForPhase<"pre_should_respond"> {
	return withPipelinePhase("pre_should_respond", {
		message,
		...fields,
	});
}

export function parallelWithShouldRespondPipelineHookContext(
	fields: Omit<
		PipelineHookContextForPhase<"parallel_with_should_respond">,
		"phase"
	>,
): PipelineHookContextForPhase<"parallel_with_should_respond"> {
	return withPipelinePhase("parallel_with_should_respond", fields);
}

export function outgoingPipelineHookContext(
	content: Content,
	ctx: OutgoingContentContext,
): PipelineHookContextForPhase<"outgoing_before_deliver"> {
	return withPipelinePhase("outgoing_before_deliver", {
		content,
		source: ctx.source,
		roomId: ctx.roomId,
		message: ctx.message,
		actionName: ctx.actionName,
		responseId: ctx.responseId,
		streaming: ctx.streaming,
	});
}

export function preModelPipelineHookContext(
	fields: Omit<PipelineHookContextForPhase<"pre_model">, "phase">,
): PipelineHookContextForPhase<"pre_model"> {
	return withPipelinePhase("pre_model", fields);
}

export function postModelPipelineHookContext(
	fields: Omit<PipelineHookContextForPhase<"post_model">, "phase">,
): PipelineHookContextForPhase<"post_model"> {
	return withPipelinePhase("post_model", fields);
}

export function afterMemoryPersistedPipelineHookContext(
	memory: Memory,
	tableName: string,
	memoryId: UUID,
): PipelineHookContextForPhase<"after_memory_persisted"> {
	return withPipelinePhase("after_memory_persisted", {
		memory: { ...memory, id: memoryId },
		tableName,
		memoryId,
	});
}

export function modelStreamChunkPipelineHookContext(
	fields: Omit<PipelineHookContextForPhase<"model_stream_chunk">, "phase">,
): PipelineHookContextForPhase<"model_stream_chunk"> {
	return withPipelinePhase("model_stream_chunk", fields);
}

export function modelStreamEndPipelineHookContext(
	fields: Omit<PipelineHookContextForPhase<"model_stream_end">, "phase">,
): PipelineHookContextForPhase<"model_stream_end"> {
	return withPipelinePhase("model_stream_end", fields);
}
