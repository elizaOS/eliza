/**
 * TriageService — coordinates adapters, scoring, and the draft store.
 *
 * Concrete adapters live in their owning connector plugin and register
 * themselves during plugin init via `service.register(adapter)`. Core owns only
 * the registry + `BaseMessageAdapter`; it never pre-registers connector adapters.
 *
 * Usage (from a connector plugin's init):
 *   getDefaultTriageService().register(new MyConnectorAdapter());
 *   await getDefaultTriageService().triage(runtime, { sources: ["my-source"] });
 */

import { ElizaError } from "../../../errors.ts";
import { logger } from "../../../logger.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import { filterInMemory } from "./adapters/base.ts";
import { getDeferredMessageScheduler } from "./deferred-send-scheduler.ts";
import {
	getDefaultMessageRefStore,
	type MessageRefStore,
} from "./message-ref-store.ts";
import { rankScored, scoreMessages } from "./triage-engine.ts";
import type {
	DraftRecord,
	DraftRequest,
	ManageOperation,
	ManageResult,
	MessageAdapter,
	MessageRef,
	MessageSource,
	ReadMessageRequest,
	ReadMessageResult,
	SearchMessagesFilters,
} from "./types.ts";

export interface TriageOptions {
	sources?: MessageSource[];
	worldIds?: string[];
	channelIds?: string[];
	sinceMs?: number;
	limit?: number;
	nowMs?: number;
}

export interface MessageSearchReceipt {
	requested: MessageSource[];
	succeeded: MessageSource[];
	unregistered: MessageSource[];
	unavailable: MessageSource[];
	failed: MessageSource[];
	/** Null when the caller did not request a measurable result cap. */
	limit: number | null;
	/** Null when no result cap was requested, so no overflow probe was run. */
	hasMore: boolean | null;
}

export interface MessageSearchResult {
	refs: MessageRef[];
	receipt: MessageSearchReceipt;
}

export class TriageService {
	private adapters = new Map<MessageSource, MessageAdapter>();
	private sendsInFlight = new Map<string, Promise<DraftRecord>>();
	private persistedSendsInFlight = new Map<string, Promise<DraftRecord>>();
	private schedulesInFlight = new Map<
		string,
		{ sendAtMs: number; promise: Promise<DraftRecord> }
	>();
	// Keyed by `${source}:${messageId}` → owning adapter, populated as messages
	// flow through triage(). Used to route MESSAGE without a per-call hint.
	private adapterByMessageId = new Map<string, MessageAdapter>();

	constructor(
		private readonly store: MessageRefStore = getDefaultMessageRefStore(),
	) {}

	register(adapter: MessageAdapter): void {
		this.adapters.set(adapter.source, adapter);
	}

	getAdapter(source: MessageSource): MessageAdapter | undefined {
		return this.adapters.get(source);
	}

	listRegisteredSources(): MessageSource[] {
		return Array.from(this.adapters.keys());
	}

	listAdapters(): MessageAdapter[] {
		return Array.from(this.adapters.values());
	}

	getStore(): MessageRefStore {
		return this.store;
	}

	// adapterByMessageId grows one entry per message routed through triage(). Cap
	// it (FIFO eviction by Map insertion order) so a long-running agent doesn't
	// retain a routing entry for every message it has ever seen. Evicted entries
	// fall back to the store-based lookup in getAdapterForMessage().
	private static readonly MAX_ADAPTER_ROUTES = 5000;

	private trackAdapterForMessage(
		source: MessageSource,
		messageId: string,
	): void {
		const adapter = this.adapters.get(source);
		if (!adapter) return;
		this.adapterByMessageId.set(`${source}:${messageId}`, adapter);
		while (this.adapterByMessageId.size > TriageService.MAX_ADAPTER_ROUTES) {
			const oldest = this.adapterByMessageId.keys().next().value;
			if (oldest === undefined) break;
			this.adapterByMessageId.delete(oldest);
		}
	}

	getAdapterForMessage(messageId: string): MessageAdapter | undefined {
		// Fast path: explicit source:id key.
		for (const [key, adapter] of this.adapterByMessageId) {
			if (key.endsWith(`:${messageId}`)) return adapter;
		}
		// Fallback: look up via the store.
		const ref = this.store.getMessage(messageId);
		if (!ref) return undefined;
		return this.adapters.get(ref.source);
	}

	/**
	 * Resolve and execute a provider-native body read. Availability is checked on
	 * every page; adapters must also resolve current authorization while fetching.
	 */
	async readMessage(
		runtime: IAgentRuntime,
		source: MessageSource,
		request: ReadMessageRequest,
	): Promise<ReadMessageResult> {
		const adapter = this.adapters.get(source);
		if (!adapter) {
			throw new ElizaError(`No message adapter registered for ${source}`, {
				code: "MESSAGE_READ_ADAPTER_NOT_FOUND",
				context: { source },
			});
		}
		if (!adapter.isAvailable(runtime)) {
			throw new ElizaError(`Message adapter ${source} is unavailable`, {
				code: "MESSAGE_READ_ADAPTER_UNAVAILABLE",
				context: { source },
			});
		}
		if (!adapter.readMessage) {
			throw new ElizaError(
				`Message adapter ${source} cannot read message bodies`,
				{
					code: "MESSAGE_READ_NOT_SUPPORTED",
					context: { source },
				},
			);
		}
		const stored = request.messageId
			? this.store.getMessage(request.messageId)
			: null;
		if (stored && stored.source !== source) {
			throw new ElizaError("Message source does not match the stored message", {
				code: "MESSAGE_READ_SOURCE_MISMATCH",
				context: { source, storedSource: stored.source },
			});
		}
		return adapter.readMessage(runtime, {
			...request,
			worldId: request.worldId ?? stored?.worldId,
		});
	}

	/**
	 * Fetch messages from every requested (and registered) source, score
	 * them, persist them in the store, and return the ranked list.
	 *
	 * Per-source failures are isolated: one broken/unimplemented adapter must
	 * not abort the sweep across the other connectors. When failures leave
	 * zero results overall, the first error is rethrown so the caller never
	 * mistakes a broken sweep for a genuinely empty inbox.
	 */
	async triage(
		runtime: IAgentRuntime,
		opts: TriageOptions = {},
	): Promise<MessageRef[]> {
		const requested = opts.sources ?? this.listRegisteredSources();
		const all: MessageRef[] = [];
		const failures: Array<{ source: MessageSource; error: unknown }> = [];
		for (const source of requested) {
			const adapter = this.adapters.get(source);
			if (!adapter) {
				logger.info(
					`[TriageService] No adapter registered for source "${source}"; skipping`,
				);
				continue;
			}
			let batch: MessageRef[];
			try {
				batch = await adapter.listMessages(runtime, {
					sinceMs: opts.sinceMs,
					limit: opts.limit,
					worldIds: opts.worldIds,
					channelIds: opts.channelIds,
				});
			} catch (error) {
				// error-policy:J4 one broken adapter degrades to a warned partial
				// sweep across the other connectors; rethrown below when failures
				// leave zero results so a broken sweep never reads as an empty inbox
				failures.push({ source, error });
				logger.warn(
					`[TriageService] ${source} listMessages failed; continuing with other sources: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				continue;
			}
			for (const ref of batch) {
				this.trackAdapterForMessage(ref.source, ref.id);
			}
			all.push(...batch);
		}
		if (all.length === 0 && failures.length > 0) {
			throw failures[0].error;
		}

		const scored = await scoreMessages(runtime, all, { nowMs: opts.nowMs });
		this.store.saveMessages(scored);
		return rankScored(scored);
	}

	/**
	 * Cross-connector search. Each adapter contributes either via its native
	 * searchMessages (capabilities.search === true) or by falling back to
	 * listMessages + in-memory filter.
	 */
	async search(
		runtime: IAgentRuntime,
		filters: SearchMessagesFilters,
	): Promise<MessageRef[]> {
		return (await this.searchWithReceipt(runtime, filters)).refs;
	}

	/**
	 * Cross-connector search with a truthful source-coverage and cap receipt.
	 * A requested cap is probed with limit+1 so exact-fit and overflow are not
	 * conflated. Connector-internal retrieval limits remain connector-owned.
	 */
	async searchWithReceipt(
		runtime: IAgentRuntime,
		filters: SearchMessagesFilters,
	): Promise<MessageSearchResult> {
		const requested = filters.sources ?? this.listRegisteredSources();
		const succeeded: MessageSource[] = [];
		const unregistered: MessageSource[] = [];
		const unavailable: MessageSource[] = [];
		const merged: MessageRef[] = [];
		const failures: Array<{ source: MessageSource; error: unknown }> = [];
		const requestedLimit =
			typeof filters.limit === "number" &&
			Number.isFinite(filters.limit) &&
			filters.limit > 0
				? Math.floor(filters.limit)
				: null;
		const probeFilters =
			requestedLimit === null
				? filters
				: { ...filters, limit: requestedLimit + 1 };
		for (const source of requested) {
			const adapter = this.adapters.get(source);
			if (!adapter) {
				unregistered.push(source);
				continue;
			}
			if (!adapter.isAvailable(runtime)) {
				unavailable.push(source);
				continue;
			}
			let hits: MessageRef[];
			try {
				hits =
					adapter.searchMessages != null
						? await adapter.searchMessages(runtime, probeFilters)
						: filterInMemory(
								await adapter.listMessages(runtime, {
									sinceMs: probeFilters.sinceMs,
									limit: probeFilters.limit,
									worldIds: probeFilters.worldIds,
									channelIds: probeFilters.channelIds,
								}),
								probeFilters,
							);
			} catch (error) {
				// error-policy:J4 same partial-degrade contract as triage() above
				failures.push({ source, error });
				logger.warn(
					`[TriageService] ${source} search failed; continuing with other sources: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
				continue;
			}
			succeeded.push(source);
			for (const ref of hits) {
				this.trackAdapterForMessage(ref.source, ref.id);
			}
			merged.push(...hits);
		}
		if (merged.length === 0 && failures.length > 0) {
			throw failures[0].error;
		}
		this.store.saveMessages(merged);
		merged.sort((a, b) => b.receivedAtMs - a.receivedAtMs);
		const hasMore =
			requestedLimit === null ? null : merged.length > requestedLimit;
		return {
			refs: requestedLimit === null ? merged : merged.slice(0, requestedLimit),
			receipt: {
				requested: [...requested],
				succeeded,
				unregistered,
				unavailable,
				failed: failures.map(({ source }) => source),
				limit: requestedLimit,
				hasMore,
			},
		};
	}

	async manage(
		runtime: IAgentRuntime,
		messageId: string,
		op: ManageOperation,
		hint?: { source?: MessageSource },
	): Promise<ManageResult> {
		const adapter = hint?.source
			? this.adapters.get(hint.source)
			: this.getAdapterForMessage(messageId);
		if (!adapter) {
			return {
				ok: false,
				reason: `no adapter resolved for message ${messageId}`,
			};
		}
		// Local tag mutations don't need adapter support — keep them in the store.
		if (op.kind === "tag_add") {
			const updated = this.store.addTag(messageId, op.tag);
			if (!updated) {
				return { ok: false, reason: `message ${messageId} not in store` };
			}
		} else if (op.kind === "tag_remove") {
			this.store.removeTag(messageId, op.tag);
		}
		if (adapter.manageMessage == null) {
			// adapter doesn't override manage — for tag ops we already mutated the
			// local store, so report success with a note.
			if (op.kind === "tag_add" || op.kind === "tag_remove") {
				return { ok: true };
			}
			return {
				ok: false,
				reason: `${adapter.source} adapter does not implement manageMessage`,
			};
		}
		return adapter.manageMessage(runtime, messageId, op);
	}

	async draftReply(
		runtime: IAgentRuntime,
		inReplyToId: string,
		body: string,
	): Promise<DraftRecord> {
		const original = this.store.getMessage(inReplyToId);
		if (!original) {
			throw new Error(`No message found for id ${inReplyToId}`);
		}
		const adapter = this.adapters.get(original.source);
		if (!adapter) {
			throw new Error(`No adapter registered for source "${original.source}"`);
		}
		const draftRequest: DraftRequest = {
			source: original.source,
			inReplyToId,
			threadId: original.threadId,
			to: [original.from],
			subject: original.subject
				? original.subject.toLowerCase().startsWith("re:")
					? original.subject
					: `Re: ${original.subject}`
				: undefined,
			body,
			worldId: original.worldId,
			channelId: original.channelId,
		};
		const { draftId, preview } = await adapter.createDraft(
			runtime,
			draftRequest,
		);
		const record: DraftRecord = {
			draftId,
			source: original.source,
			inReplyToId,
			threadId: original.threadId,
			to: draftRequest.to,
			subject: draftRequest.subject,
			body,
			preview,
			createdAtMs: Date.now(),
			sent: false,
			worldId: draftRequest.worldId,
			channelId: draftRequest.channelId,
		};
		this.store.saveDraft(record);
		return record;
	}

	async draftFollowup(
		runtime: IAgentRuntime,
		params: {
			source: MessageSource;
			to: Array<{ identifier: string; displayName?: string }>;
			subject?: string;
			body: string;
			threadId?: string;
			worldId?: string;
			channelId?: string;
		},
	): Promise<DraftRecord> {
		const adapter = this.adapters.get(params.source);
		if (!adapter) {
			throw new Error(`No adapter registered for source "${params.source}"`);
		}
		const { draftId, preview } = await adapter.createDraft(runtime, {
			source: params.source,
			threadId: params.threadId,
			to: params.to,
			subject: params.subject,
			body: params.body,
			worldId: params.worldId,
			channelId: params.channelId,
		});
		const record: DraftRecord = {
			draftId,
			source: params.source,
			threadId: params.threadId,
			to: params.to,
			subject: params.subject,
			body: params.body,
			preview,
			createdAtMs: Date.now(),
			sent: false,
			worldId: params.worldId,
			channelId: params.channelId,
		};
		this.store.saveDraft(record);
		return record;
	}

	async sendDraft(
		runtime: IAgentRuntime,
		draftId: string,
	): Promise<DraftRecord> {
		const record = this.store.getDraft(draftId);
		if (!record) {
			throw new ElizaError(`No draft found for id ${draftId}`, {
				code: "MESSAGE_DRAFT_NOT_FOUND",
				context: { draftId },
				severity: "ephemeral",
			});
		}
		if (record.sent) return record;
		const sendKey = `${String(runtime.agentId)}:${record.source}:${draftId}`;
		const pending = this.sendsInFlight.get(sendKey);
		if (pending) return pending;

		const send = this.sendDraftOnce(runtime, record);
		this.sendsInFlight.set(sendKey, send);
		try {
			return await send;
		} finally {
			if (this.sendsInFlight.get(sendKey) === send) {
				this.sendsInFlight.delete(sendKey);
			}
		}
	}

	private async sendDraftOnce(
		runtime: IAgentRuntime,
		record: DraftRecord,
	): Promise<DraftRecord> {
		const adapter = this.adapters.get(record.source);
		if (!adapter?.isAvailable(runtime)) {
			throw new ElizaError(
				`The ${record.source} message adapter is unavailable.`,
				{
					code: "MESSAGE_ADAPTER_UNAVAILABLE",
					context: { draftId: record.draftId, source: record.source },
					severity: "ephemeral",
				},
			);
		}
		const { externalId } = await adapter.sendDraft(runtime, record.draftId);
		if (typeof externalId !== "string" || externalId.trim().length === 0) {
			throw new ElizaError(
				`The ${record.source} adapter did not return an accepted message identifier.`,
				{
					code: "MESSAGE_PROVIDER_RECEIPT_MISSING",
					context: { draftId: record.draftId, source: record.source },
					severity: "fatal",
				},
			);
		}
		const updated =
			this.store.markDraftSent(record.draftId, externalId) ??
			({
				...record,
				sent: true,
				sentExternalId: externalId,
			} satisfies DraftRecord);
		this.store.saveDraft(updated);
		return updated;
	}

	/**
	 * Dispatch a draft snapshot loaded from a durable ScheduledTask row.
	 *
	 * Adapter draft caches are process-local, so the snapshot is re-created
	 * through the live adapter before send. The ScheduledTask runner's atomic
	 * fire claim is the cross-process once-only guard; the in-flight map above
	 * closes the same-process race.
	 */
	async sendPersistedDraft(
		runtime: IAgentRuntime,
		snapshot: DraftRecord,
	): Promise<DraftRecord> {
		const sendKey = `${String(runtime.agentId)}:${snapshot.source}:${snapshot.draftId}`;
		const pending = this.persistedSendsInFlight.get(sendKey);
		if (pending) return pending;
		const send = this.sendPersistedDraftOnce(runtime, snapshot);
		this.persistedSendsInFlight.set(sendKey, send);
		try {
			return await send;
		} finally {
			if (this.persistedSendsInFlight.get(sendKey) === send) {
				this.persistedSendsInFlight.delete(sendKey);
			}
		}
	}

	private async sendPersistedDraftOnce(
		runtime: IAgentRuntime,
		snapshot: DraftRecord,
	): Promise<DraftRecord> {
		const adapter = this.adapters.get(snapshot.source);
		if (!adapter?.isAvailable(runtime)) {
			throw new ElizaError(
				`The ${snapshot.source} message adapter is unavailable.`,
				{
					code: "MESSAGE_ADAPTER_UNAVAILABLE",
					context: {
						draftId: snapshot.draftId,
						source: snapshot.source,
					},
					severity: "ephemeral",
				},
			);
		}
		const recreated = await adapter.createDraft(runtime, {
			source: snapshot.source,
			inReplyToId: snapshot.inReplyToId,
			threadId: snapshot.threadId,
			to: snapshot.to,
			subject: snapshot.subject,
			body: snapshot.body,
			worldId: snapshot.worldId,
			channelId: snapshot.channelId,
			metadata: snapshot.metadata,
		});
		if (
			typeof recreated.draftId !== "string" ||
			recreated.draftId.trim().length === 0
		) {
			throw new ElizaError(
				`The ${snapshot.source} adapter did not return a draft identifier.`,
				{
					code: "MESSAGE_PROVIDER_DRAFT_RECEIPT_MISSING",
					context: {
						draftId: snapshot.draftId,
						source: snapshot.source,
					},
					severity: "fatal",
				},
			);
		}
		const hydrated: DraftRecord = {
			...snapshot,
			draftId: recreated.draftId,
			preview: recreated.preview,
			sent: false,
		};
		this.store.saveDraft(hydrated);
		const sent = await this.sendDraft(runtime, hydrated.draftId);
		if (hydrated.draftId === snapshot.draftId) return sent;
		if (!sent.sentExternalId) {
			throw new ElizaError(
				`The ${snapshot.source} adapter returned a sent draft without provider receipt proof.`,
				{
					code: "MESSAGE_PROVIDER_RECEIPT_MISSING",
					context: {
						draftId: snapshot.draftId,
						source: snapshot.source,
					},
					severity: "fatal",
				},
			);
		}
		const original: DraftRecord = {
			...snapshot,
			sent: true,
			sentExternalId: sent.sentExternalId,
		};
		this.store.saveDraft(original);
		return original;
	}

	async scheduleDraftSend(
		runtime: IAgentRuntime,
		draftId: string,
		sendAtMs: number,
	): Promise<DraftRecord> {
		const record = this.store.getDraft(draftId);
		if (!record) {
			throw new ElizaError(`No draft found for id ${draftId}`, {
				code: "MESSAGE_DRAFT_NOT_FOUND",
				context: { draftId },
				severity: "ephemeral",
			});
		}
		if (record.sent) {
			throw new ElizaError(`Draft ${draftId} has already been sent.`, {
				code: "MESSAGE_DRAFT_ALREADY_SENT",
				context: { draftId, source: record.source },
				severity: "ephemeral",
			});
		}
		if (record.scheduledForMs !== undefined) {
			if (
				record.scheduledForMs === sendAtMs &&
				record.scheduledId &&
				record.scheduleCommit
			) {
				const replayed: DraftRecord = {
					...record,
					scheduleCommit: { ...record.scheduleCommit, replayed: true },
				};
				this.store.saveDraft(replayed);
				return replayed;
			}
			throw new ElizaError(
				`Draft ${draftId} is already scheduled for ${new Date(record.scheduledForMs).toISOString()}.`,
				{
					code: "MESSAGE_DRAFT_ALREADY_SCHEDULED",
					context: {
						draftId,
						scheduledForMs: record.scheduledForMs,
						requestedSendAtMs: sendAtMs,
					},
					severity: "ephemeral",
				},
			);
		}
		const scheduleKey = `${String(runtime.agentId)}:${record.source}:${draftId}`;
		const pending = this.schedulesInFlight.get(scheduleKey);
		if (pending) {
			if (pending.sendAtMs !== sendAtMs) {
				throw new ElizaError(
					`Concurrent schedule requests for draft ${draftId} specified different delivery times.`,
					{
						code: "MESSAGE_DRAFT_SCHEDULE_CONFLICT",
						context: {
							draftId,
							existingSendAtMs: pending.sendAtMs,
							requestedSendAtMs: sendAtMs,
						},
						severity: "ephemeral",
					},
				);
			}
			const scheduled = await pending.promise;
			if (!scheduled.scheduleCommit) {
				throw new ElizaError(
					`Concurrent schedule for draft ${draftId} returned without commit proof.`,
					{
						code: "MESSAGE_DRAFT_SCHEDULE_RECEIPT_MISSING",
						context: { draftId, sendAtMs },
						severity: "fatal",
					},
				);
			}
			const replayed: DraftRecord = {
				...scheduled,
				scheduleCommit: { ...scheduled.scheduleCommit, replayed: true },
			};
			this.store.saveDraft(replayed);
			return replayed;
		}

		const schedule = this.scheduleDraftSendOnce(runtime, record, sendAtMs);
		this.schedulesInFlight.set(scheduleKey, { sendAtMs, promise: schedule });
		try {
			return await schedule;
		} finally {
			if (this.schedulesInFlight.get(scheduleKey)?.promise === schedule) {
				this.schedulesInFlight.delete(scheduleKey);
			}
		}
	}

	private async scheduleDraftSendOnce(
		runtime: IAgentRuntime,
		record: DraftRecord,
		sendAtMs: number,
	): Promise<DraftRecord> {
		const draftId = record.draftId;
		const adapter = this.adapters.get(record.source);
		if (!adapter?.isAvailable(runtime)) {
			throw new ElizaError(
				`The ${record.source} message adapter is unavailable.`,
				{
					code: "MESSAGE_ADAPTER_UNAVAILABLE",
					context: { draftId, source: record.source },
					severity: "ephemeral",
				},
			);
		}

		// A connector-owned remote schedule is authoritative when available.
		// Every other adapter must use the one durable ScheduledTask runner.
		if (
			adapter.capabilities().send.schedule === true &&
			adapter.scheduleSend != null
		) {
			const { scheduledId } = await adapter.scheduleSend(
				runtime,
				draftId,
				sendAtMs,
			);
			if (typeof scheduledId !== "string" || scheduledId.trim().length === 0) {
				throw new ElizaError(
					`The ${record.source} adapter did not return a schedule identifier.`,
					{
						code: "MESSAGE_PROVIDER_SCHEDULE_RECEIPT_MISSING",
						context: { draftId, source: record.source },
						severity: "fatal",
					},
				);
			}
			const committedAt = new Date().toISOString();
			const scheduleCommit: NonNullable<DraftRecord["scheduleCommit"]> = {
				kind: "provider_accepted",
				id: scheduledId,
				committedAt,
				idempotencyKey: `message-native-schedule:${record.source}:${draftId}:${sendAtMs}`,
				replayed: false,
			};
			const updated: DraftRecord = {
				...record,
				scheduledForMs: sendAtMs,
				scheduledId,
				scheduleCommit,
			};
			this.store.saveDraft(updated);
			return updated;
		}

		const scheduler = getDeferredMessageScheduler(runtime);
		if (!scheduler) {
			throw new ElizaError(
				"Durable deferred message scheduling is unavailable on this runtime.",
				{
					code: "DEFERRED_MESSAGE_SCHEDULER_UNAVAILABLE",
					context: { draftId, source: record.source, sendAtMs },
					severity: "fatal",
				},
			);
		}
		const scheduled = await scheduler.schedule({ draft: record, sendAtMs });
		const updated: DraftRecord = {
			...record,
			scheduledForMs: scheduled.scheduledForMs,
			scheduledId: scheduled.scheduledId,
			scheduleCommit: scheduled.commit,
		};
		this.store.saveDraft(updated);
		return updated;
	}
}

// Shared, process-wide triage registry. Connector plugins register their
// adapters into it during init; core actions and connector consumers resolve it
// here. Starts empty — no connector adapters are pre-registered.
let singleton: TriageService | null = null;
export function getDefaultTriageService(): TriageService {
	if (!singleton) singleton = new TriageService();
	return singleton;
}

export function __resetDefaultTriageServiceForTests(): void {
	singleton = null;
}
