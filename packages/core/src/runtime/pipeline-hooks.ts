/** Owns runtime pipeline hook registration, ordering, execution, and telemetry. Hook handlers receive the original runtime and share its canonical state-cache invalidation and output-sanitization policies. */

import { guardOutboundEnvelopeText } from "../security/outbound-envelope-guard.js";
import { sanitizeOutboundText } from "../services/message/outbound-sanitize";
import {
	EventType,
	type IAgentRuntime,
	type PipelineHookContext,
	type PipelineHookPhase,
	type PipelineHookSpec,
	type ResolvedPipelineHook,
} from "../types";
import {
	PIPELINE_HOOK_DEBUG_LOG_MS,
	PIPELINE_HOOK_ERROR_LOG_MS,
	PIPELINE_HOOK_WARN_MS,
	pipelineHookMetricRoomId,
	resolvePipelineHookSpec,
	sortPipelineHooksByPosition,
} from "../types/pipeline-hooks";

export function coerceOutgoingMessageText(text: unknown): string {
	if (text === null || text === undefined) {
		return "";
	}
	return String(text);
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
			{
				const durationMs = Math.round(performance.now() - t0);
				if (!pipelineHookTelemetry) {
					const baseLite = {
						src: "pipeline_hook" as const,
						agentId: this.runtime.agentId,
						hookId: entry.id,
						phase,
						roomId,
						durationMs,
					};
					if (durationMs >= PIPELINE_HOOK_WARN_MS) {
						this.runtime.logger.warn(
							baseLite,
							`PIPELINE HOOK SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
						);
					}
					if (durationMs >= PIPELINE_HOOK_ERROR_LOG_MS) {
						this.runtime.logger.error(
							baseLite,
							`PIPELINE HOOK VERY SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
						);
					}
				} else {
					const slow = durationMs >= PIPELINE_HOOK_WARN_MS;
					const baseFields = {
						src: "pipeline_hook" as const,
						agentId: this.runtime.agentId,
						hookId: entry.id,
						phase,
						roomId,
						durationMs,
					};
					if (durationMs >= PIPELINE_HOOK_DEBUG_LOG_MS) {
						this.runtime.logger.debug(baseFields, "Pipeline hook timing");
					}
					if (slow) {
						this.runtime.logger.warn(
							baseFields,
							`PIPELINE HOOK SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
						);
					}
					if (durationMs >= PIPELINE_HOOK_ERROR_LOG_MS) {
						this.runtime.logger.error(
							baseFields,
							`PIPELINE HOOK VERY SLOW (${durationMs}ms): ${entry.id} phase=${phase}`,
						);
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
				}
			}
		};

		if (
			phase === "parallel_with_should_respond" ||
			phase === "model_stream_chunk"
		) {
			await Promise.all(hooks.map((h) => runOne(h)));
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
		await Promise.all(concurrentReaders.map((h) => runOne(h)));
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
			pipelineHookTelemetry !== undefined
				? pipelineHookTelemetry
				: phase !== "model_stream_chunk";

		const hasHooks = this.hooksForPhase(phase).length > 0;

		switch (phase) {
			case "incoming_before_compose": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "incoming_before_compose" }
				>;
				const md = c.message.content.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipIncomingMessageHooks === true) {
					return;
				}
				const messageId = c.message.id;
				await this.invokePipelineHooks(
					phase,
					c,
					"Incoming pipeline hook",
					hookTelemetry,
				);
				if (messageId) {
					this.runtime.stateCache.delete(messageId);
					this.runtime.stateCache.delete(`${messageId}_action_results`);
				}
				return;
			}
			case "compose_state_providers": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "compose_state_providers" }
				>;
				const md = c.message.content.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipComposeStateProviderHooks === true) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					c,
					"Compose-state provider pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "pre_should_respond": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "pre_should_respond" }
				>;
				const md = c.message.content.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipPreShouldRespondHooks === true) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					c,
					"Pre-should-respond pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "parallel_with_should_respond": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "parallel_with_should_respond" }
				>;
				const md = c.message.content.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipParallelWithShouldRespondHooks === true) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					c,
					"Parallel should-respond pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "outgoing_before_deliver": {
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "outgoing_before_deliver" }
				>;
				if (hasHooks) {
					await this.invokePipelineHooks(
						phase,
						c,
						"Outgoing pipeline hook",
						hookTelemetry,
					);
				}
				// Mandatory outbound hygiene, hooks or none: strip leaked model
				// machine syntax (#15888), redact secrets, then fail-closed block
				// any security-envelope echo. Runs before the content is
				// persisted, so stored outbound memories carry the same text the
				// connector delivers.
				c.content.text = guardOutboundEnvelopeText(
					this.runtime,
					this.runtime.redactSecrets(
						sanitizeOutboundText(coerceOutgoingMessageText(c.content.text)),
					),
					"outgoing_before_deliver",
				);
				return;
			}
			case "pre_model":
			case "post_model": {
				if (!hasHooks) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					ctx as Extract<
						PipelineHookContext,
						{ phase: "pre_model" | "post_model" }
					>,
					phase === "pre_model"
						? "Pre-model pipeline hook"
						: "Post-model pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "after_memory_persisted": {
				if (!hasHooks) {
					return;
				}
				const c = ctx as Extract<
					PipelineHookContext,
					{ phase: "after_memory_persisted" }
				>;
				const md = c.memory.content.metadata;
				const meta =
					typeof md === "object" && md !== null
						? (md as Record<string, unknown>)
						: null;
				if (meta?.skipAfterMemoryPersistedHooks === true) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					c,
					"After-memory-persisted pipeline hook",
					hookTelemetry,
				);
				return;
			}
			case "model_stream_chunk":
			case "model_stream_end": {
				if (!hasHooks) {
					return;
				}
				await this.invokePipelineHooks(
					phase,
					ctx as Extract<
						PipelineHookContext,
						{ phase: "model_stream_chunk" | "model_stream_end" }
					>,
					phase === "model_stream_chunk"
						? "Model stream chunk pipeline hook"
						: "Model stream end pipeline hook",
					hookTelemetry,
				);
				return;
			}
			default: {
				throw new Error(`Unknown pipeline hook phase: ${String(phase)}`);
			}
		}
	}
}
