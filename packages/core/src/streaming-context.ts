/**
 * Propagates per-turn stream callbacks and cancellation through model and
 * action execution, using Node AsyncLocalStorage.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getAmbientSingleton, setAmbientSingleton } from "./ambient-context";
import { ElizaError } from "./errors";
import type { StreamChunkCallback } from "./types/components";
import type {
	StreamingContextEventPayload,
	StreamingEvaluationPayload,
	StreamingEventHooks,
	StreamingToolCallPayload,
	StreamingToolResultPayload,
} from "./types/streaming";
import { AsyncContextManager } from "./utils/async-context-manager";

/** Trusted execution policy, bound to an actor and incoming turn, never tool arguments. */
export interface TurnActionConstraint {
	messageId: string;
	roomId: string;
	actorId: string;
	action: string;
	operations: readonly string[];
	disposition: "allow" | "deny";
	reason: string;
}

/** A host-verified text tariff. Unknown routes and non-text billing are refused. */
export interface ModelAttemptTariff {
	provider: string;
	model: string;
	route: string;
	inputNanoUsdPerToken: number;
	outputNanoUsdPerToken: number;
	/** Conservative reservation bound, not measured prompt tokens. */
	inputTokenUpperBound: number;
}

export interface ModelAttemptLease {
	readonly messageId: string;
	readonly maxOutputTokens: number;
	reserve(
		provider: string,
		model: string,
		route: string | undefined,
		serialized: string,
		outputTokens: number | undefined,
	): void;
	close(): void;
}

/** Host-only, in-memory trial allowance. Reservations are never refunded. */
export interface ModelAttemptAllowance {
	openTurn(
		messageId: string,
		signal: AbortSignal,
		assertCurrent?: () => void,
	): ModelAttemptLease;
	close(): void;
	readonly remainingMicroUsd: number;
}
const modelAttemptLeases = getAmbientSingleton(
	Symbol.for("elizaos.modelAttemptLeases"),
	() => new WeakSet<ModelAttemptLease>(),
);
export function createModelAttemptAllowance(options: {
	signal: AbortSignal;
	budgetMicroUsd: number;
	maxAttempts: number;
	maxOutputTokens: number;
	expiresAt: number;
	tariffs: readonly ModelAttemptTariff[];
}): ModelAttemptAllowance {
	const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
	if (
		!positive(options.budgetMicroUsd) ||
		!positive(options.maxAttempts) ||
		!positive(options.maxOutputTokens) ||
		!positive(options.expiresAt) ||
		!options.tariffs.length ||
		options.tariffs.some(
			(t) =>
				!t.provider ||
				!t.model ||
				!t.route ||
				!positive(t.inputNanoUsdPerToken) ||
				!positive(t.outputNanoUsdPerToken) ||
				!positive(t.inputTokenUpperBound),
		)
	) {
		throw new ElizaError("Invalid host model allowance", {
			code: "MODEL_ATTEMPT_POLICY_INVALID",
		});
	}
	const tariffs = options.tariffs.map((t) => Object.freeze({ ...t }));
	const { maxOutputTokens, expiresAt } = options;
	let remaining = options.budgetMicroUsd,
		attempts = options.maxAttempts,
		closed = false;
	const abortTrial = () => {
		closed = true;
	};
	options.signal.addEventListener("abort", abortTrial, { once: true });
	if (options.signal.aborted) closed = true;
	return Object.freeze({
		get remainingMicroUsd() {
			return remaining;
		},
		close() {
			closed = true;
			options.signal.removeEventListener("abort", abortTrial);
		},
		openTurn(
			messageId: string,
			signal: AbortSignal,
			assertCurrent?: () => void,
		): ModelAttemptLease {
			if (!messageId || closed || Date.now() >= expiresAt || signal.aborted) {
				throw new ElizaError("Model allowance ended", {
					code: "MODEL_ATTEMPT_POLICY_CLOSED",
				});
			}
			let ended = false;
			// Barge-in cancels this turn, not the session's remaining allowance.
			const abort = () => close();
			const close = () => {
				ended = true;
				signal.removeEventListener("abort", abort);
			};
			signal.addEventListener("abort", abort, { once: true });
			const lease: ModelAttemptLease = Object.freeze({
				messageId,
				maxOutputTokens,
				close,
				reserve(
					provider: string,
					model: string,
					route: string | undefined,
					serialized: string,
					outputTokens: number | undefined,
				) {
					if (ended || closed || signal.aborted || Date.now() >= expiresAt) {
						throw new ElizaError("Model allowance ended", {
							code: "MODEL_ATTEMPT_POLICY_CLOSED",
						});
					}
					assertCurrent?.();
					const tariff = tariffs.find(
						(t) =>
							t.provider === provider && t.model === model && t.route === route,
					);
					if (
						!tariff ||
						!outputTokens ||
						!positive(outputTokens) ||
						outputTokens > maxOutputTokens ||
						Buffer.byteLength(serialized, "utf8") > tariff.inputTokenUpperBound
					) {
						throw new ElizaError("Unqualified bounded model request", {
							code: "MODEL_ATTEMPT_POLICY_ROUTE",
						});
					}
					const nanoUsd =
						BigInt(tariff.inputTokenUpperBound) *
							BigInt(tariff.inputNanoUsdPerToken) +
						BigInt(outputTokens) * BigInt(tariff.outputNanoUsdPerToken);
					const microUsd = (nanoUsd + 999n) / 1000n;
					if (attempts < 1 || microUsd > BigInt(remaining)) {
						throw new ElizaError("Model allowance exhausted", {
							code: "MODEL_ATTEMPT_POLICY_EXHAUSTED",
						});
					}
					// No await between admission and debit: parallel attempts cannot share funds.
					remaining -= Number(microUsd);
					attempts--;
				},
			});
			modelAttemptLeases.add(lease);
			return lease;
		},
	});
}

/** Model parameters and UI metadata cannot mint a trusted lease. */
export function getModelAttemptLease(): ModelAttemptLease | undefined {
	const context = getStreamingContext();
	const lease = context?.modelAttemptLease;
	if (!lease) return undefined;
	if (
		!modelAttemptLeases.has(lease) ||
		context.modelAttemptTurnId !== lease.messageId
	) {
		throw new ElizaError("Invalid model turn lease", {
			code: "MODEL_ATTEMPT_POLICY_INVALID",
		});
	}
	return lease;
}

/**
 * Streaming context containing callbacks for streaming lifecycle.
 */
export interface StreamingContext extends StreamingEventHooks {
	/**
	 * Called for each chunk of streamed content. Omitted when a scope exists
	 * only to carry cancellation or structured hooks: a context without a chunk
	 * consumer must not put nested `useModel` calls on the streaming path.
	 */
	onStreamChunk?: StreamChunkCallback;
	/** Called when a useModel streaming call completes (allows reset between calls) */
	onStreamEnd?: () => void;
	reportError?: (
		scope: string,
		error: unknown,
		context?: Record<string, unknown>,
	) => void;
	messageId?: string;
	/** Optional abort signal to cancel streaming */
	abortSignal?: AbortSignal;
	/** Shared by nested model/action scopes; policy producers own writes. */
	actionConstraints?: Map<string, TurnActionConstraint>;
	/** Opaque host-created policy; never reconstructed from request/model metadata. */
	modelAttemptLease?: ModelAttemptLease;
	/** Original incoming user turn, separate from the assistant streaming ID. */
	modelAttemptTurnId?: string;
}

export interface StreamingHookPayloads {
	onToolCall: StreamingToolCallPayload;
	onToolResult: StreamingToolResultPayload;
	onEvaluation: StreamingEvaluationPayload;
	onContextEvent: StreamingContextEventPayload;
}

/**
 * Safely emit an optional streaming event hook.
 * Missing hooks are no-ops, and hook failures are isolated from runtime flow.
 */
export async function emitStreamingHook<K extends keyof StreamingHookPayloads>(
	context: StreamingContext | undefined,
	hook: K,
	payload: StreamingHookPayloads[K],
): Promise<void> {
	const callback = context?.[hook];
	if (!callback) {
		return;
	}

	try {
		await (
			callback as (value: StreamingHookPayloads[K]) => void | Promise<void>
		)(payload);
	} catch (error) {
		// error-policy:J7 Streaming observers cannot alter model/action flow;
		// the owning runtime receives the observer failure when available.
		context?.reportError?.("StreamingContext.emitHook", error, {
			hook: String(hook),
		});
		// Streaming observers must not break the underlying model/action flow.
	}
}

/**
 * Interface for streaming context managers.
 * AsyncLocalStorage isolates concurrent turns across asynchronous work.
 */
export interface IStreamingContextManager {
	/**
	 * Run a function with a streaming context.
	 * The context will be available to all nested async calls via `active()`.
	 */
	run<T>(context: StreamingContext | undefined, fn: () => T): T;

	/**
	 * Get the currently active streaming context.
	 * Returns undefined if no context is active.
	 */
	active(): StreamingContext | undefined;
}

const STREAMING_CONTEXT_MANAGER_KEY = Symbol.for(
	"elizaos.streamingContextManager",
);

function initContextManagerSync(): IStreamingContextManager {
	return new AsyncContextManager<StreamingContext | undefined>();
}

function getOrCreateContextManager(): IStreamingContextManager {
	// The shared global slot is the single source of truth (no module-local
	// cache): under a duplicated core bundle every copy must observe the same
	// manager, and `setStreamingContextManager` must be visible everywhere.
	return getAmbientSingleton(
		STREAMING_CONTEXT_MANAGER_KEY,
		initContextManagerSync,
	);
}

/**
 * Set the global streaming context manager.
 * Can be used to override the auto-detected manager.
 *
 * @param manager - The context manager to use globally
 */
export function setStreamingContextManager(
	manager: IStreamingContextManager,
): void {
	setAmbientSingleton(STREAMING_CONTEXT_MANAGER_KEY, manager);
}

/**
 * Get the global streaming context manager.
 * Auto-detects and creates the appropriate manager on first access.
 */
export function getStreamingContextManager(): IStreamingContextManager {
	return getOrCreateContextManager();
}

/**
 * Run a function with a streaming context.
 * All useModel calls within this function will automatically use streaming.
 *
 * @example
 * ```typescript
 * await runWithStreamingContext(
 * { onStreamChunk: async (chunk) => sendSSE(chunk), messageId },
 * async () => {
 * // All useModel calls here will stream automatically
 * await runtime.processMessage(message);
 * }
 * );
 * ```
 *
 * @param context - The streaming context with onStreamChunk callback
 * @param fn - The function to run with streaming context
 * @returns The result of the function
 */
export function runWithStreamingContext<T>(
	context: StreamingContext | undefined,
	fn: () => T,
): T {
	const manager = getOrCreateContextManager();
	const parent = manager.active();
	const sameTurn =
		!context?.messageId || context.messageId === parent?.messageId;
	if (parent?.modelAttemptLease) {
		const originalTurn = parent.modelAttemptTurnId;
		if (
			originalTurn !== parent.modelAttemptLease.messageId ||
			(context?.modelAttemptTurnId !== undefined &&
				context.modelAttemptTurnId !== originalTurn) ||
			(!sameTurn && context?.modelAttemptTurnId !== originalTurn)
		) {
			throw new ElizaError("Bounded model turn cannot change identity", {
				code: "MODEL_ATTEMPT_POLICY_INVALID",
			});
		}
		context = {
			...context,
			modelAttemptLease: parent.modelAttemptLease,
			modelAttemptTurnId: originalTurn,
		};
		if (!context.messageId) context.messageId = parent.messageId;
		if (parent.abortSignal)
			context.abortSignal = context.abortSignal
				? AbortSignal.any([parent.abortSignal, context.abortSignal])
				: parent.abortSignal;
	}
	if (parent?.actionConstraints && sameTurn) {
		// Detaching model streaming must not detach execution policy/cancellation.
		context = context ?? { messageId: parent.messageId };
		context.actionConstraints = parent.actionConstraints;
		if (parent.abortSignal && context.abortSignal !== parent.abortSignal) {
			context.abortSignal = context.abortSignal
				? AbortSignal.any([parent.abortSignal, context.abortSignal])
				: parent.abortSignal;
		}
	} else if (
		parent?.actionConstraints &&
		context?.actionConstraints === parent.actionConstraints
	) {
		context = { ...context, actionConstraints: new Map() };
	}
	return manager.run(context, fn);
}

/** Register validated policy on the ambient turn before asynchronous selection. */
export function setTurnActionConstraint(
	constraint: TurnActionConstraint,
): void {
	const context = getStreamingContext();
	if (
		!context ||
		!constraint.messageId ||
		!constraint.roomId ||
		!constraint.actorId ||
		!constraint.action ||
		constraint.operations.length === 0 ||
		constraint.operations.some((operation) => !operation.trim())
	) {
		throw new ElizaError(
			"Turn action constraint requires an active context and complete identity",
			{ code: "TURN_ACTION_CONSTRAINT_INVALID" },
		);
	}
	context.abortSignal?.throwIfAborted();
	context.actionConstraints ??= new Map();
	context.actionConstraints.set(
		JSON.stringify([
			constraint.messageId,
			constraint.roomId,
			constraint.actorId,
			constraint.action,
		]),
		Object.freeze({
			...constraint,
			operations: Object.freeze([...constraint.operations]),
		}),
	);
}

/** Read only the policy for this exact actor, turn, action and operation. */
export function getTurnActionConstraint(
	identity: Pick<
		TurnActionConstraint,
		"messageId" | "roomId" | "actorId" | "action"
	>,
	operation: string,
): TurnActionConstraint | undefined {
	const constraint = getStreamingContext()?.actionConstraints?.get(
		JSON.stringify([
			identity.messageId,
			identity.roomId,
			identity.actorId,
			identity.action,
		]),
	);
	return constraint?.operations.includes(operation) ? constraint : undefined;
}

/** A `StreamChunkCallback` that discards every chunk. */
const discardStreamChunk: StreamChunkCallback = async () => undefined;

/**
 * Run `fn` with the ambient visible-token stream detached.
 *
 * Any `useModel` call inside still inherits the active streaming context's
 * abort signal and structured tool/evaluation hooks, but its raw tokens no
 * longer reach the turn's visible reply channel — `onStreamChunk` becomes a
 * no-op. This is the seam that keeps an action handler's *internal* model
 * calls off the user-visible reply: only the top-level response
 * generation streams raw tokens, while an action delivers its own output
 * through the HandlerCallback. The visible stream would otherwise surface an
 * action's intermediate model output as though it were the action's final
 * reply. An action that
 * genuinely wants to stream can still opt in with an explicit `onStreamChunk`
 * in its `useModel` params, which `useModel` honors independently of the
 * ambient context. The planner and evaluator model calls apply the same
 * override inline.
 *
 * A straight pass-through (no added scope) when no streaming context is active
 * or when the active context has no chunk consumer to detach. Installing the
 * discarding callback in that second case would make the context look like a
 * stream consumer to `useModel` and move otherwise non-streaming internal calls
 * onto the streaming path.
 */
export function runWithSuppressedModelStream<T>(fn: () => T): T {
	const active = getStreamingContext();
	if (!active?.onStreamChunk) {
		return fn();
	}
	return runWithStreamingContext(
		{ ...active, onStreamChunk: discardStreamChunk },
		fn,
	);
}

/**
 * Get the currently active streaming context.
 * Called by useModel to check if automatic streaming should be enabled.
 *
 * @returns The current streaming context or undefined
 */
export function getStreamingContext(): StreamingContext | undefined {
	return getOrCreateContextManager().active();
}

// useModel → chunk callback delivery (dedupe `model_stream_chunk` hooks)

// The same provider chunk is often forwarded from useModel's textStream loop *and* from
// DefaultMessageService. Without a turn-scoped marker, pipeline hooks would run twice per
// token (inflated metrics, duplicate side effects). Node uses AsyncLocalStorage depth so
// nested async work stays scoped.
// See docs/PIPELINE_HOOKS.md § "Stream hook dedupe (Node)".

// Shared across duplicated core bundles for the same reason as the streaming
// context manager: `useModel` and `DefaultMessageService` may come from
// different copies and must observe the same delivery depth.
const MODEL_STREAM_CHUNK_DELIVERY_DEPTH_KEY = Symbol.for(
	"elizaos.modelStreamChunkDeliveryDepth",
);

function modelStreamChunkDeliveryDepthStorage(): AsyncLocalStorage<number> {
	return getAmbientSingleton(
		MODEL_STREAM_CHUNK_DELIVERY_DEPTH_KEY,
		() => new AsyncLocalStorage<number>(),
	);
}

/**
 * While `> 0`, the runtime is inside `useModel`'s delivery of one `textStream` chunk to
 * `paramsChunk` / `ctxChunk` (after `model_stream_chunk` with `source: "use_model"`).
 * `DefaultMessageService` skips its own `model_stream_chunk` (`source: "message_service"`) in
 * this window so the same raw token is not processed twice.
 */
export function getModelStreamChunkDeliveryDepth(): number {
	const s = modelStreamChunkDeliveryDepthStorage();
	return s.getStore() ?? 0;
}

/** Wrap `paramsChunk` / `ctxChunk` invocations from `useModel`'s stream loop. */
export function runInsideModelStreamChunkDelivery<T>(
	fn: () => T | Promise<T>,
): T | Promise<T> {
	const s = modelStreamChunkDeliveryDepthStorage();
	const parent = s.getStore() ?? 0;
	return s.run(parent + 1, fn);
}
