/** Owns runtime pipeline hook registration, ordering, execution, and telemetry. Hook handlers receive the original runtime and share its canonical state-cache invalidation and output-sanitization policies. */

import { guardOutboundEnvelopeText } from "../security/outbound-envelope-guard.js";
import { sanitizeOutboundText } from "../security/outbound-sanitize.ts";
import { EventType } from "../types/events.js";
import {
	PIPELINE_HOOK_DEBUG_LOG_MS,
	PIPELINE_HOOK_ERROR_LOG_MS,
	PIPELINE_HOOK_WARN_MS,
	pipelineHookMetricRoomId,
	resolvePipelineHookSpec,
	sortPipelineHooksByPosition,
} from "../types/pipeline-hooks";
import type {
	PipelineHookContext,
	PipelineHookPhase,
	PipelineHookSpec,
	ResolvedPipelineHook,
} from "../types/pipeline-hooks.js";
import type { IAgentRuntime } from "../types/runtime.js";
import {
	isUnavailableLocalModel,
	TEXT_GENERATION_MODEL_KEYS,
} from "./model-policy.js";

/** Log label per phase; also the set of phases `applyPipelineHooks` accepts. */
const PIPELINE_HOOK_LOG_LABELS: Readonly<Record<PipelineHookPhase, string>> = {
	incoming_before_compose: "Incoming pipeline hook",
	compose_state_providers: "Compose-state provider pipeline hook",
	pre_should_respond: "Pre-should-respond pipeline hook",
	parallel_with_should_respond: "Parallel should-respond pipeline hook",
	outgoing_before_deliver: "Outgoing pipeline hook",
	pre_model: "Pre-model pipeline hook",
	post_model: "Post-model pipeline hook",
	after_memory_persisted: "After-memory-persisted pipeline hook",
	model_stream_chunk: "Model stream chunk pipeline hook",
	model_stream_end: "Model stream end pipeline hook",
};

/** `content.metadata` flag that skips a phase's hooks for one message or memory. */
const PIPELINE_HOOK_SKIP_FLAGS: Partial<Record<PipelineHookPhase, string>> = {
	incoming_before_compose: "skipIncomingMessageHooks",
	compose_state_providers: "skipComposeStateProviderHooks",
	pre_should_respond: "skipPreShouldRespondHooks",
	parallel_with_should_respond: "skipParallelWithShouldRespondHooks",
	after_memory_persisted: "skipAfterMemoryPersistedHooks",
};

function skipFlagMetadata(ctx: PipelineHookContext): unknown {
	if (ctx.phase === "after_memory_persisted") {
		return ctx.memory.content.metadata;
	}
	return "message" in ctx ? ctx.message?.content.metadata : undefined;
}

export class RuntimePipelineHooks {
	constructor(private readonly runtime: IAgentRuntime) {}

	private pipelineHookEntries: ResolvedPipelineHook[] = [];

	private pipelineHookIdToIndex = new Map<string, number>();

	/**
	 * Per-phase, position-sorted hook lists, cached because the
	 * `model_stream_chunk` phase is consulted once per streamed token — a
	 * filter+sort over all registered hooks per token dominated the zero-hook
	 * stream path. Invalidated wholesale on register/unregister (rare,
	 * boot-time operations). Callers must treat the returned array as
	 * read-only.
	 */
	private pipelineHooksByPhase = new Map<
		PipelineHookPhase,
		ResolvedPipelineHook[]
	>();

	hooksForPhase(phase: PipelineHookPhase): ResolvedPipelineHook[] {
		let hooks = this.pipelineHooksByPhase.get(phase);
		if (!hooks) {
			hooks = sortPipelineHooksByPosition(
				this.pipelineHookEntries.filter((e) => e.phase === phase),
			);
			this.pipelineHooksByPhase.set(phase, hooks);
		}
		return hooks;
	}

	upsertPipelineHook(entry: ResolvedPipelineHook): void {
		// A re-registered id may change phase, so drop every phase's cache rather
		// than tracking which two lists are stale.
		this.pipelineHooksByPhase.clear();
		const existing = this.pipelineHookIdToIndex.get(entry.id);
		if (existing !== undefined) {
			this.pipelineHookEntries[existing] = entry;
			return;
		}
		this.pipelineHookIdToIndex.set(entry.id, this.pipelineHookEntries.length);
		this.pipelineHookEntries.push(entry);
	}

	async invokePipelineHooks(
		phase: PipelineHookPhase,
		ctx: PipelineHookContext,
		logLabel: string,
		pipelineHookTelemetry = true,
	): Promise<void> {
		const hooks = this.hooksForPhase(phase);
		if (!hooks.length) {
			return;
		}

		const roomId = pipelineHookMetricRoomId(ctx);

		const runOne = async (entry: ResolvedPipelineHook) => {
			const t0 = performance.now();
			let errorMessage: string | undefined;
			try {
				await entry.handler(this.runtime, ctx);
			} catch (error) {
				// error-policy:J4 Local text admission rejects before dispatch; other
				// hook failures retain the ordinary isolated diagnostic behavior.
				if (
					ctx.phase === "pre_model" &&
					ctx.provider === "eliza-local-inference" &&
					TEXT_GENERATION_MODEL_KEYS.includes(ctx.resolvedModelKey) &&
					isUnavailableLocalModel(error)
				) {
					throw error;
				}
				// error-policy:J4 Hooks are isolated so one plugin cannot suppress
				// later hooks; the failure is surfaced to the agent explicitly.
				errorMessage = error instanceof Error ? error.message : String(error);
				this.runtime.logger.error(
					{
						src: "agent",
						agentId: this.runtime.agentId,
						hookId: entry.id,
						phase: entry.phase,
						error: errorMessage,
					},
					`${logLabel} threw; continuing`,
				);
				this.runtime.reportError("AgentRuntime.pipelineHook", error, {
					hookId: entry.id,
					phase: entry.phase,
				});
			}
			const durationMs = Math.round(performance.now() - t0);
			const slow = durationMs >= PIPELINE_HOOK_WARN_MS;
			const fields = {
				src: "pipeline_hook" as const,
				agentId: this.runtime.agentId,
				hookId: entry.id,
				phase,
				roomId,
				durationMs,
			};
			if (pipelineHookTelemetry && durationMs >= PIPELINE_HOOK_DEBUG_LOG_MS) {
				this.runtime.logger.debug(fields, "Pipeline hook timing");
			}
			if (slow) {
				this.runtime.logger.warn(
					fields,
					`PIPELINE HOOK SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
				);
			}
			if (durationMs >= PIPELINE_HOOK_ERROR_LOG_MS) {
				this.runtime.logger.error(
					fields,
					`PIPELINE HOOK VERY SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
				);
			}
			if (!pipelineHookTelemetry) {
				return;
			}
			try {
				await this.runtime.emitEvent(EventType.PIPELINE_HOOK_METRIC, {
					runtime: this.runtime,
					source: "runtime",
					phase,
					hookId: entry.id,
					durationMs,
					roomId,
					slow,
					...(errorMessage !== undefined ? { error: errorMessage } : {}),
				});
			} catch (metricError) {
				// error-policy:J7 Hook metrics are diagnostics and cannot
				// interrupt the pipeline they observe.
				this.runtime.logger.debug(
					{
						src: "pipeline_hook",
						agentId: this.runtime.agentId,
						hookId: entry.id,
						phase,
						error:
							metricError instanceof Error
								? metricError.message
								: String(metricError),
					},
					"PIPELINE_HOOK_METRIC listener failed",
				);
				this.runtime.reportError(
					"AgentRuntime.pipelineHookMetric",
					metricError,
					{
						hookId: entry.id,
						phase,
					},
				);
			}
		};

		if (
			phase === "parallel_with_should_respond" ||
			phase === "model_stream_chunk"
		) {
			await Promise.all(hooks.map(runOne));
			return;
		}

		const mutators = hooks.filter((h) => h.mutatesPrimary);
		const serialReaders = hooks.filter(
			(h) => !h.mutatesPrimary && h.schedule === "serial",
		);
		const concurrentReaders = hooks.filter(
			(h) => !h.mutatesPrimary && h.schedule === "concurrent",
		);

		for (const h of mutators) {
			await runOne(h);
		}
		for (const h of serialReaders) {
			await runOne(h);
		}
		await Promise.all(concurrentReaders.map(runOne));
	}

	registerPipelineHook(spec: PipelineHookSpec): void {
		this.upsertPipelineHook(resolvePipelineHookSpec(spec));
	}

	unregisterPipelineHook(id: string): void {
		const idx = this.pipelineHookIdToIndex.get(id);
		if (idx === undefined) {
			return;
		}
		this.pipelineHooksByPhase.clear();
		this.pipelineHookEntries.splice(idx, 1);
		this.pipelineHookIdToIndex.clear();
		for (let i = 0; i < this.pipelineHookEntries.length; i++) {
			const e = this.pipelineHookEntries[i];
			this.pipelineHookIdToIndex.set(e.id, i);
		}
	}

	/**
	 * Run pipeline hooks for a phase (skip metadata, ordering, and outgoing sanitize + redact).
	 * @param pipelineHookTelemetry When false, skips debug logs / `PIPELINE_HOOK_METRIC` per hook
	 * (still logs warn/error for slow hooks). Defaults to false for `model_stream_chunk` only.
	 */
	async applyPipelineHooks(
		phase: PipelineHookPhase,
		ctx: PipelineHookContext,
		pipelineHookTelemetry?: boolean,
	): Promise<void> {
		if (ctx.phase !== phase) {
			throw new Error(
				`applyPipelineHooks: phase mismatch (expected ${phase}, ctx.phase=${ctx.phase})`,
			);
		}

		const hookTelemetry =
			pipelineHookTelemetry ?? phase !== "model_stream_chunk";
		if (!Object.hasOwn(PIPELINE_HOOK_LOG_LABELS, phase)) {
			throw new Error(`Unknown pipeline hook phase: ${String(phase)}`);
		}
		const hasHooks = this.hooksForPhase(phase).length > 0;
		if (hasHooks) {
			const skipFlag = PIPELINE_HOOK_SKIP_FLAGS[phase];
			if (skipFlag) {
				const metadata = skipFlagMetadata(ctx);
				if (
					typeof metadata === "object" &&
					metadata !== null &&
					(metadata as Record<string, unknown>)[skipFlag] === true
				) {
					return;
				}
			}
			const messageId =
				ctx.phase === "incoming_before_compose" ? ctx.message.id : undefined;
			await this.invokePipelineHooks(
				phase,
				ctx,
				PIPELINE_HOOK_LOG_LABELS[phase],
				hookTelemetry,
			);
			if (messageId) {
				this.runtime.stateCache.delete(messageId);
				this.runtime.stateCache.delete(`${messageId}_action_results`);
			}
		}
		if (ctx.phase === "outgoing_before_deliver") {
			// Mandatory outbound hygiene, hooks or none: strip leaked model
			// machine syntax, redact secrets, then fail-closed block
			// any security-envelope echo. Runs before the content is
			// persisted, so stored outbound memories carry the same text the
			// connector delivers.
			ctx.content.text = guardOutboundEnvelopeText(
				this.runtime,
				this.runtime.redactSecrets(
					sanitizeOutboundText(String(ctx.content.text ?? "")),
				),
				"outgoing_before_deliver",
			);
		}
	}
}
