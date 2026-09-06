/**
 * Per-channel Discord membership evidence publisher: publishes the guild
 * roster a Discord client can actually observe into the canonical
 * `MembershipService` authority (#24365), replacing the false
 * `rooms[].metadata.participants` empty-roster fallback. Small fully-chunked
 * guilds publish complete permission-aware snapshots per text channel
 * (ViewChannel-filtered); large, partially-chunked, missing-intent, and
 * fetch-failure paths report the scope unavailable — never an empty roster.
 * Deltas (member add/remove, role and channel-permission changes, bans) and
 * sender renewals chain ordered evidence per scope; in-memory state is only
 * fencing cursors and renewal timestamps and is reconstructable after a
 * restart by adopting the durable scope state.
 */
import {
	ChannelType,
	type ConnectorAccount,
	type ConnectorAccountManager,
	ElizaError,
	getConnectorAccountManager,
	type IAgentRuntime,
	type JsonObject,
	logger,
	type MembershipMutationReceipt,
	type MembershipScope,
	type MembershipScopeHealth,
	MembershipService,
	type UUID,
} from "@elizaos/core";
import { v5 as uuidv5 } from "uuid";

/**
 * Evidence validity requested per observation; capped by the authority at
 * its 24h MAX_VALIDITY_MS.
 */
const MEMBERSHIP_VALIDITY_MS = 6 * 60 * 60 * 1_000;
/** Renewal window: a sender observed inside this window is not re-proven. */
const MEMBERSHIP_RENEWAL_MS = 60 * 60 * 1_000;
const MEMBERSHIP_IDEMPOTENCY_KEY_MAX = 1_000;
/**
 * Guilds at or above this member count never publish complete snapshots:
 * discord.js member chunking at this scale is not practically completable in
 * one ready pass, so the scope is honestly unavailable instead of
 * partially-populated masquerading as complete.
 */
const COMPLETE_SNAPSHOT_MAX_MEMBERS = 1000;

/** RFC-4122 v5 namespace for Discord membership principal ids. */
const DISCORD_MEMBERSHIP_NAMESPACE = "b1a0d9c8-2222-4f3b-8a4c-6b5d4e3f2f01";

export const DISCORD_CONNECTOR_ID = "discord";

export type DiscordMembershipCompleteness =
	| { kind: "complete"; memberCount: number }
	| { kind: "unavailable"; reason: string };

export interface DiscordSnapshotMemberEvidence {
	canonicalPrincipalId: UUID;
	roles: string[];
	permissionSnapshot: JsonObject;
	/** Runtime room/entity mapping for the authority's mapping guard. */
	runtime: {
		worldId: UUID | null;
		roomId: UUID | null;
		entityId: UUID | null;
	};
}

interface ScopePublisherState {
	/** Scope generation as of the last successful command (fencing token). */
	generation: number;
	/** Publisher generation this process registered under. */
	publisherGeneration: number;
	/**
	 * Evidence mode this process registered the scope under.
	 * `ordered_delta` scopes have a complete snapshot in this publisher
	 * generation and chain deltas off it; `point_query` scopes publish
	 * per-event evidence without a complete roster (fresh scopes and
	 * honestly-unavailable guilds).
	 */
	mode: "ordered_delta" | "point_query" | null;
	/** Durable evidence cursor of the last successful command. */
	sourceCursor: string | null;
	/** Durable evidence version of the last successful command (-1 = none). */
	currentVersion: number;
	/** Per-principal last-renewed timestamps (epoch ms) for renewal gating. */
	renewedAt: Map<UUID, number>;
	/** Serializes commands per scope: the evidence chain is strictly ordered. */
	queue: Promise<unknown>;
}

export class DiscordMembershipPublisher {
	private readonly runtime: IAgentRuntime;
	private readonly publisherInstanceId: string;
	private readonly scopes = new Map<string, ScopePublisherState>();
	/**
	 * Runtime world/room mapping rows ensured for the authority's
	 * MEMBERSHIP_RUNTIME_MAPPING_INVALID guard, keyed by the requested
	 * (worldId, roomId) pair. Both ids are process-stable (createUniqueUuid
	 * over runtime+guild/channel id) so the ensure is idempotent by id.
	 */
	private readonly ensuredMappings = new Set<string>();
	/** Principal entity rows ensured, keyed by (accountKey, discord user id). */
	private readonly ensuredEntities = new Set<string>();
	private readonly durableAccounts = new Map<string, ConnectorAccount>();
	private readonly durableAccountPromises = new Map<
		string,
		Promise<ConnectorAccount | null>
	>();
	/** Per-account-key terminal setup failures (publishing unavailable). */
	private readonly unavailableReasons = new Map<string, string>();

	constructor(runtime: IAgentRuntime) {
		this.runtime = runtime;
		this.publisherInstanceId = crypto.randomUUID();
	}

	private scopeKey(scope: MembershipScope): string {
		return `${scope.connectorAccountId}:${scope.externalWorldId}:${scope.externalRoomId}`;
	}

	private membershipService(): MembershipService | null {
		const services = this.runtime.getServicesByType<MembershipService>(
			MembershipService.serviceType,
		);
		return services.length > 0 ? services[0] : null;
	}

	private connectorAccountManager(): ConnectorAccountManager | null {
		try {
			return getConnectorAccountManager(this.runtime);
		} catch (error) {
			// error-policy:J4 membership evidence is a degrade-only surface;
			// a missing manager disables publishing (unavailableReasons) while
			// message flow continues.
			logger.debug(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Discord membership connector account manager unavailable",
			);
			return null;
		}
	}

	/**
	 * Resolve the durable, UUID-keyed connector account row for one
	 * configured Discord account key. The membership authority requires a
	 * `connector_accounts` row whose id is a real UUID; configured account
	 * keys are plain strings ("default", config labels), so the first
	 * resolution upserts a durable row keyed on the account key and reuses
	 * its generated UUID. Per-account caching keeps multi-account publishers
	 * independent.
	 */
	async scopeForChannel(options: {
		guildId: string;
		channelId: string;
		accountKey: string;
	}): Promise<MembershipScope | null> {
		const account = await this.resolveDurableAccount(options.accountKey);
		if (!account?.id || typeof account.id !== "string") {
			return null;
		}
		return {
			agentId: this.runtime.agentId,
			connectorId: DISCORD_CONNECTOR_ID,
			connectorAccountId: account.id as UUID,
			externalWorldId: options.guildId,
			externalRoomId: options.channelId,
		};
	}

	private async resolveDurableAccount(
		accountKey: string,
	): Promise<ConnectorAccount | null> {
		const cached = this.durableAccounts.get(accountKey);
		if (cached) {
			return cached;
		}
		if (this.unavailableReasons.has(accountKey)) {
			return null;
		}
		if (!this.durableAccountPromises.has(accountKey)) {
			const manager = this.connectorAccountManager();
			if (!manager) {
				this.unavailableReasons.set(
					accountKey,
					"connector_account_manager_missing",
				);
				return null;
			}
			this.durableAccountPromises.set(
				accountKey,
				ensureDurableDiscordAccount(manager, accountKey).catch(
					(error: unknown) => {
						// error-policy:J4 Membership evidence is a degrade-only
						// surface: a failed durable-account lookup disables
						// publishing for this account in this process while
						// message flow continues.
						this.unavailableReasons.set(
							accountKey,
							error instanceof Error
								? error.message
								: "account_resolution_failed",
						);
						this.durableAccountPromises.delete(accountKey);
						logger.warn(
							{
								src: "plugin:discord",
								agentId: this.runtime.agentId,
								accountKey,
								error: this.unavailableReasons.get(accountKey),
							},
							"Discord membership publishing unavailable: durable account resolution failed",
						);
						return null;
					},
				),
			);
		}
		const account = await this.durableAccountPromises.get(accountKey);
		if (account) {
			this.durableAccounts.set(accountKey, account);
		}
		return account ?? null;
	}

	private stateFor(scope: MembershipScope): ScopePublisherState {
		const key = this.scopeKey(scope);
		let state: ScopePublisherState | undefined = this.scopes.get(key);
		if (!state) {
			state = {
				generation: 0,
				publisherGeneration: 0,
				mode: null,
				sourceCursor: null,
				currentVersion: -1,
				renewedAt: new Map(),
				queue: Promise.resolve(),
			};
			this.scopes.set(key, state);
		}
		return state;
	}

	private async readScopeHealth(
		service: MembershipService,
		scope: MembershipScope,
	): Promise<MembershipScopeHealth | null> {
		try {
			return await service.getScopeHealth(scope);
		} catch (error) {
			// error-policy:J7 a failed health read is diagnostics-only: the
			// caller falls back to fresh registration state and the command
			// path continues; the error is surfaced for observability.
			logger.debug(
				{
					src: "plugin:discord",
					agentId: this.runtime.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Discord membership scope health read failed",
			);
			return null;
		}
	}

	/**
	 * Ensure an entity row exists for a membership principal id. The
	 * authority requires every canonicalPrincipalId (and runtime entity id)
	 * to resolve to a real row in this tenant (MEMBERSHIP_PRINCIPAL_NOT_
	 * FOUND). Idempotent by id: createEntities skips existing ids.
	 */
	async ensurePrincipalEntity(options: {
		principalId: UUID;
		discordUserId: string;
		accountKey: string;
	}): Promise<void> {
		// Dedup on the row id itself: the same Discord user produces TWO
		// principal rows (account-scoped principal id and the runtime
		// entity id), both of which must exist for the authority's
		// MEMBERSHIP_PRINCIPAL_NOT_FOUND guard.
		if (this.ensuredEntities.has(options.principalId)) {
			return;
		}
		const existing = await this.runtime.getEntityById(options.principalId);
		if (!existing) {
			await this.runtime.createEntities([
				{
					id: options.principalId,
					agentId: this.runtime.agentId,
					names: [`discord:${options.accountKey}:${options.discordUserId}`],
					metadata: {
						discord: {
							id: options.discordUserId,
							accountKey: options.accountKey,
						},
						source: "discord-membership",
					},
				},
			]);
		}
		this.ensuredEntities.add(options.principalId);
	}

	/**
	 * Ensure the runtime world and room rows exist for one observation's
	 * mapping before the authority validates it (the authority rejects
	 * non-null runtime world/room ids that do not resolve to real rows).
	 * Production ready-path discovery already ensures these rows; this is
	 * the idempotent safety net for scopes discovered before this publisher
	 * existed. Re-ensuring is idempotent by id.
	 */
	async ensureRuntimeMapping(options: {
		worldId: UUID;
		roomId: UUID;
		guildId: string;
		channelId: string;
		guildName?: string;
		channelName?: string;
		accountKey: string;
	}): Promise<void> {
		const key = `${options.accountKey}:${options.channelId}:${options.worldId}:${options.roomId}`;
		if (this.ensuredMappings.has(key)) {
			return;
		}
		await this.runtime.ensureWorldExists({
			id: options.worldId,
			agentId: this.runtime.agentId,
			name: options.guildName ?? `Discord ${options.guildId}`,
			messageServerId: options.guildId,
			metadata: {
				source: "discord",
				accountId: options.accountKey,
				discord: { guildId: options.guildId, accountId: options.accountKey },
			},
		});
		await this.runtime.ensureRoomExists({
			id: options.roomId,
			agentId: this.runtime.agentId,
			source: "discord",
			type: ChannelType.GROUP,
			name: options.channelName ?? `Discord ${options.channelId}`,
			channelId: options.channelId,
			serverId: options.guildId,
			worldId: options.worldId,
			metadata: {
				source: "discord",
				accountId: options.accountKey,
				discord: {
					guildId: options.guildId,
					channelId: options.channelId,
					accountId: options.accountKey,
				},
			},
		});
		this.ensuredMappings.add(key);
	}

	/**
	 * Register this process as the scope publisher in the requested evidence
	 * mode, adopting durable scope state first so a restarted process
	 * re-binds without losing fencing. A previous publisher's generation
	 * floor is advanced by one to satisfy the authority's monotonic
	 * publisherGeneration requirement. Re-registering to change mode (for
	 * example after a fresh complete snapshot on a point_query scope) is
	 * allowed and resets the durable evidence chain.
	 */
	private async registerPublisher(
		service: MembershipService,
		scope: MembershipScope,
		state: ScopePublisherState,
		mode: "ordered_delta" | "point_query",
	): Promise<void> {
		const health = await this.readScopeHealth(service, scope);
		const expectedGeneration = health ? health.generation : 0;
		state.publisherGeneration =
			health?.publisherGeneration !== null &&
			typeof health?.publisherGeneration === "number"
				? health.publisherGeneration + 1
				: 0;
		const receipt = await service.registerPublisher({
			...scope,
			expectedGeneration,
			publisherInstanceId: this.publisherInstanceId,
			publisherGeneration: state.publisherGeneration,
			evidenceMode: mode,
			idempotencyKey: membershipIdempotencyKey([
				scope.connectorAccountId,
				scope.externalRoomId,
				"register",
				this.publisherInstanceId,
				String(state.publisherGeneration),
			]),
			observedAt: new Date().toISOString(),
		});
		state.generation = receipt.committedGeneration;
		state.mode = mode;
		// A new publisher generation resets the durable evidence chain: the
		// authority sets sourceVersion back to -1 on registration.
		state.sourceCursor = null;
		state.currentVersion = -1;
	}

	/** Serialized command execution per scope (the evidence chain orders). */
	private enqueue<T>(
		state: ScopePublisherState,
		run: () => Promise<T>,
	): Promise<T> {
		const result = state.queue.then(run, run);
		// error-policy:J5 the rejection suppressed here is observed by the
		// caller through the returned `result` promise; this catch only keeps
		// the serialization chain alive for the next command.
		state.queue = result.catch(() => undefined);
		return result;
	}

	private async adoptDurableState(
		service: MembershipService,
		scope: MembershipScope,
		state: ScopePublisherState,
	): Promise<void> {
		const health = await this.readScopeHealth(service, scope);
		if (health && health.generation > state.generation) {
			state.generation = health.generation;
			state.sourceCursor = health.sourceCursor;
			state.currentVersion = health.sourceVersion;
		}
	}

	/**
	 * Publish one ordered-delta membership observation. Journal-idempotent on
	 * the authority side via the event-anchored idempotency key, so gateway
	 * redelivery cannot double-apply a delta. Fencing mismatches (another
	 * writer advanced the scope) re-register once and retry once; anything
	 * else degrades silently — publishing must never break the gateway path.
	 */
	async publishDelta(options: {
		scope: MembershipScope;
		principalId: UUID;
		/** Owner-aware runtime entity id (canonical principal stays separate). */
		runtimeEntityId?: UUID;
		worldId: UUID;
		roomId: UUID;
		membershipState: "active" | "revoked";
		reason:
			| "joined"
			| "reconciled_present"
			| "permission_restored"
			| "left"
			| "kicked"
			| "banned"
			| "permission_lost";
		roles: string[];
		permissionSnapshot: JsonObject;
		idempotencyKey: string;
		/**
		 * Observation timestamp anchoring this command: the caller computes it
		 * once per gateway observation and reuses it for retries/redeliveries,
		 * so replays match both key and digest in the authority journal.
		 */
		observedAt?: string;
	}): Promise<MembershipMutationReceipt | null> {
		const service = this.membershipService();
		if (!service) {
			return null;
		}
		const state = this.stateFor(options.scope);
		return this.enqueue(state, async () => {
			if (state.generation === 0 || state.mode === null) {
				await this.registerPublisher(
					service,
					options.scope,
					state,
					state.mode ?? "point_query",
				);
			}
			if (state.sourceCursor === null) {
				await this.adoptDurableState(service, options.scope, state);
			}
			const now = new Date();
			const observedAt = options.observedAt ?? now.toISOString();
			const validUntil = new Date(
				now.getTime() + MEMBERSHIP_VALIDITY_MS,
			).toISOString();
			let attempt = 0;
			while (attempt < 2) {
				attempt += 1;
				const currentVersion = state.currentVersion;
				const evidenceMode =
					state.mode === "ordered_delta" ? "ordered_delta" : "point_query";
				try {
					const receipt = await service.applyMembership({
						...options.scope,
						expectedGeneration: state.generation,
						publisherInstanceId: this.publisherInstanceId,
						publisherGeneration: state.publisherGeneration,
						evidenceMode,
						canonicalPrincipalId: options.principalId,
						state: options.membershipState,
						reason: options.reason,
						roles: options.roles,
						permissionSnapshot: options.permissionSnapshot,
						runtime: {
							worldId: options.worldId,
							roomId: options.roomId,
							entityId: options.runtimeEntityId ?? options.principalId,
						},
						sourceVersion: currentVersion + 1,
						previousSourceCursor: state.sourceCursor,
						sourceCursor: `discord:${options.idempotencyKey}`,
						validUntil,
						idempotencyKey: options.idempotencyKey,
						observedAt,
					});
					state.generation = receipt.committedGeneration;
					state.sourceCursor = `discord:${options.idempotencyKey}`;
					state.currentVersion = currentVersion + 1;
					if (options.membershipState === "active") {
						state.renewedAt.set(options.principalId, now.getTime());
					} else {
						state.renewedAt.delete(options.principalId);
					}
					return receipt;
				} catch (error) {
					const code = membershipErrorCode(error);
					const isFencing =
						code === "MEMBERSHIP_GENERATION_MISMATCH" ||
						code === "MEMBERSHIP_PUBLISHER_MISMATCH" ||
						code === "MEMBERSHIP_PUBLISHER_GENERATION_STALE" ||
						code === "MEMBERSHIP_CURSOR_DISCONTINUITY";
					if (isFencing && attempt === 1) {
						// Another writer (an overlapping previous process)
						// advanced the scope: adopt durable state, take the
						// publisher seat, and retry exactly once.
						await this.adoptDurableState(service, options.scope, state);
						await this.registerPublisher(
							service,
							options.scope,
							state,
							state.mode ?? "point_query",
						);
						continue;
					}
					// error-policy:J4 an unexpected rejection degrades the scope
					// to stale — authorize fails closed on this channel — and is
					// reported for observability; the gateway path continues.
					this.runtime.reportError(
						"discord:membership-delta",
						error instanceof Error ? error : new Error(String(error)),
						{
							idempotencyKey: options.idempotencyKey,
							scope: this.scopeKey(options.scope),
							reason: options.reason,
						},
					);
					await this.degradeScopeInternal(
						service,
						options.scope,
						state,
						"stale",
						`delta_rejected:${code || "unknown"}`,
					);
					return null;
				}
			}
			return null;
		});
	}

	/**
	 * Renew an active sender on observed message activity. Skipped inside
	 * the renewal window; the sender's message in the channel is itself the
	 * observation, so no roster fetch happens.
	 */
	async renewSender(options: {
		scope: MembershipScope;
		principalId: UUID;
		/** Owner-aware runtime entity id (canonical principal stays separate). */
		runtimeEntityId?: UUID;
		worldId: UUID;
		roomId: UUID;
		roles: string[];
		permissionSnapshot: JsonObject;
		idempotencyKey: string;
		/** Observation timestamp shared by retries of this observation. */
		observedAt?: string;
	}): Promise<void> {
		const state = this.stateFor(options.scope);
		const last = state.renewedAt.get(options.principalId) ?? 0;
		if (Date.now() - last < MEMBERSHIP_RENEWAL_MS) {
			return;
		}
		await this.publishDelta({
			...options,
			membershipState: "active",
			reason: "reconciled_present",
		});
	}

	/**
	 * Publish a complete permission-aware snapshot for one channel, or report
	 * the scope unavailable. The completeness rule is honest: only a small
	 * guild whose member cache is fully populated (cache size equals the
	 * authoritative member count) may publish complete; anything else is
	 * unavailable with the reason recorded durably.
	 */
	async publishSnapshot(options: {
		scope: MembershipScope;
		worldId: UUID;
		roomId: UUID;
		completeness: DiscordMembershipCompleteness;
		members?: DiscordSnapshotMemberEvidence[];
		idempotencyKey: string;
		/**
		 * Observation timestamp anchoring this command: the caller computes it
		 * once per ready/refresh observation and reuses it for retries, so
		 * replays match both key and digest in the authority journal.
		 */
		observedAt?: string;
	}): Promise<MembershipMutationReceipt | null> {
		const service = this.membershipService();
		if (!service) {
			return null;
		}
		const state = this.stateFor(options.scope);
		const unavailable =
			options.completeness.kind === "unavailable" ? options.completeness : null;
		if (unavailable) {
			return this.enqueue(state, async () => {
				if (state.generation === 0 || state.mode === null) {
					await this.registerPublisher(
						service,
						options.scope,
						state,
						"point_query",
					);
				}
				try {
					// An honestly-incomplete roster degrades the scope to
					// unavailable: authorize must fail closed with the
					// recorded reason rather than trust a partial roster.
					const receipt = await service.setScopeHealth({
						...options.scope,
						expectedGeneration: state.generation,
						health: "unavailable",
						reason: unavailable.reason,
						idempotencyKey: options.idempotencyKey,
						observedAt: new Date().toISOString(),
					});
					state.generation = receipt.committedGeneration;
					return receipt;
				} catch (error) {
					const code = membershipErrorCode(error);
					// error-policy:J4 the unavailable report is itself the degrade
					// signal; a rejection here is surfaced for observability and
					// the next ready pass retries the report.
					this.runtime.reportError(
						"discord:membership-snapshot-unavailable",
						error instanceof Error ? error : new Error(String(error)),
						{
							idempotencyKey: options.idempotencyKey,
							reason: unavailable.reason,
							scope: this.scopeKey(options.scope),
							code: code || "unknown",
						},
					);
					return null;
				}
			});
		}
		const members = options.members ?? [];
		return this.enqueue(state, async () => {
			if (state.generation === 0 || state.mode !== "ordered_delta") {
				// A complete snapshot makes this scope ordered-delta capable:
				// register (or re-register) in that mode so later deltas chain
				// off this snapshot's cursor within one publisher generation.
				await this.registerPublisher(
					service,
					options.scope,
					state,
					"ordered_delta",
				);
			}
			if (state.sourceCursor === null) {
				await this.adoptDurableState(service, options.scope, state);
			}
			const now = new Date();
			const observedAt = options.observedAt ?? now.toISOString();
			const validUntil = new Date(
				now.getTime() + MEMBERSHIP_VALIDITY_MS,
			).toISOString();
			let attempt = 0;
			while (attempt < 2) {
				attempt += 1;
				const currentVersion = state.currentVersion;
				try {
					const receipt = await service.applyCompleteSnapshot({
						...options.scope,
						expectedGeneration: state.generation,
						publisherInstanceId: this.publisherInstanceId,
						publisherGeneration: state.publisherGeneration,
						// Registering mode is ordered_delta: the authority accepts
						// complete snapshots in that mode and later deltas chain
						// off the snapshot cursor in the same mode.
						evidenceMode: "ordered_delta",
						completeness: "complete",
						members,
						sourceVersion: currentVersion + 1,
						previousSourceCursor: state.sourceCursor,
						sourceCursor: `discord:${options.idempotencyKey}`,
						validUntil,
						idempotencyKey: options.idempotencyKey,
						observedAt,
					});
					state.generation = receipt.committedGeneration;
					state.sourceCursor = `discord:${options.idempotencyKey}`;
					state.currentVersion = currentVersion + 1;
					const seen = new Set(
						members.map((m) => m.canonicalPrincipalId as string),
					);
					for (const principalId of state.renewedAt.keys()) {
						if (!seen.has(principalId)) {
							state.renewedAt.delete(principalId);
						}
					}
					return receipt;
				} catch (error) {
					const code = membershipErrorCode(error);
					const isFencing =
						code === "MEMBERSHIP_GENERATION_MISMATCH" ||
						code === "MEMBERSHIP_PUBLISHER_MISMATCH" ||
						code === "MEMBERSHIP_PUBLISHER_GENERATION_STALE" ||
						code === "MEMBERSHIP_CURSOR_DISCONTINUITY";
					if (isFencing && attempt === 1) {
						await this.adoptDurableState(service, options.scope, state);
						await this.registerPublisher(
							service,
							options.scope,
							state,
							"ordered_delta",
						);
						continue;
					}
					// error-policy:J4 a failed complete snapshot means the scope's
					// evidence is NOT refreshed as advertised: degrade the scope to
					// stale so authorize fails closed instead of trusting the prior
					// generation's roster, report it, and continue the ready pass.
					this.runtime.reportError(
						"discord:membership-snapshot",
						error instanceof Error ? error : new Error(String(error)),
						{
							idempotencyKey: options.idempotencyKey,
							scope: this.scopeKey(options.scope),
							code: code || "unknown",
						},
					);
					await this.degradeScopeInternal(
						service,
						options.scope,
						state,
						"stale",
						`snapshot_rejected:${code || "unknown"}`,
					);
					return null;
				}
			}
			return null;
		});
	}

	/**
	 * Degrade a scope when the gateway reports the guild or channel
	 * unreachable (bot removed, channel deleted, reconnect with stale
	 * evidence) so `authorize` fails closed with an explicit authority state
	 * instead of trusting stale evidence.
	 */
	async degradeScope(options: {
		scope: MembershipScope;
		health: "stale" | "unavailable" | "unsupported";
		reason: string;
	}): Promise<void> {
		const service = this.membershipService();
		if (!service) {
			return;
		}
		const state = this.stateFor(options.scope);
		if (state.generation === 0) {
			return;
		}
		await this.degradeScopeInternal(
			service,
			options.scope,
			state,
			options.health,
			options.reason,
		);
	}

	/**
	 * Shared degrade write used both by explicit gateway degrades and by
	 * failed evidence commands above. A degrade write itself failing must
	 * not break the caller: it is reported and swallowed (error-policy:J7
	 * diagnostics must not kill the loop — the next command or ready pass
	 * retries the degrade or supersedes it with fresh evidence).
	 */
	private async degradeScopeInternal(
		service: MembershipService,
		scope: MembershipScope,
		state: ScopePublisherState,
		health: "stale" | "unavailable" | "unsupported",
		reason: string,
	): Promise<void> {
		try {
			const receipt = await service.setScopeHealth({
				...scope,
				expectedGeneration: state.generation,
				health,
				reason,
				idempotencyKey: membershipIdempotencyKey([
					scope.connectorAccountId,
					scope.externalRoomId,
					"degrade",
					reason,
					String(Date.now()),
				]),
				observedAt: new Date().toISOString(),
			});
			state.generation = receipt.committedGeneration;
		} catch (error) {
			this.runtime.reportError(
				"discord:membership-degrade",
				error instanceof Error ? error : new Error(String(error)),
				{ scope: this.scopeKey(scope), reason },
			);
		}
	}

	/**
	 * Degrade every published scope of one account (gateway disconnect,
	 * invalid session) so `authorize` fails closed with an explicit state
	 * instead of trusting evidence that missed gateway events. When
	 * `worldIds` is provided, only scopes for those guilds degrade — a
	 * single shard disconnecting must not poison scopes served by healthy
	 * shards, and recovery (shardResume) only resnapshots that shard.
	 */
	async degradeAllForAccount(options: {
		accountKey: string;
		health: "stale" | "unavailable" | "unsupported";
		reason: string;
		worldIds?: string[];
	}): Promise<void> {
		const account = await this.resolveDurableAccount(options.accountKey);
		if (!account) {
			return;
		}
		const prefix = `${account.id}:`;
		const worldFilter =
			options.worldIds === undefined ? null : new Set(options.worldIds);
		for (const [key, state] of this.scopes) {
			if (!key.startsWith(prefix) || state.generation === 0) {
				continue;
			}
			const [_, worldId, roomId] = key.split(":");
			if (worldFilter && !worldFilter.has(worldId)) {
				continue;
			}
			await this.degradeScope({
				scope: {
					agentId: this.runtime.agentId,
					connectorId: DISCORD_CONNECTOR_ID,
					connectorAccountId: account.id as UUID,
					externalWorldId: worldId,
					externalRoomId: roomId,
				},
				health: options.health,
				reason: options.reason,
			});
		}
	}
}

/**
 * Canonical principal id for a Discord user inside one account, for the
 * membership authority. Deterministic RFC-4122 v5 over (account id,
 * Discord user id): stable across restarts and publishers, pattern-valid
 * for the authority's `[1-8]` version-nibble check, and distinct per
 * account so two configured bots never alias one human onto one principal.
 * The runtime entity for the same user remains separate; the authority
 * stores both id spaces (principal id + runtime mapping).
 */
export function discordMembershipPrincipalId(
	durableAccountId: string,
	discordUserId: string,
): UUID {
	return uuidv5(
		`${durableAccountId}:${discordUserId}`,
		DISCORD_MEMBERSHIP_NAMESPACE,
	) as UUID;
}

/** Cap and namespace an idempotency key for the authority's journal. */
export function discordMembershipIdempotencyKey(parts: string[]): string {
	const key = `discord:${parts.join(":")}`;
	return key.length > MEMBERSHIP_IDEMPOTENCY_KEY_MAX
		? key.slice(0, MEMBERSHIP_IDEMPOTENCY_KEY_MAX)
		: key;
}

const membershipIdempotencyKey = discordMembershipIdempotencyKey;

export function discordMembershipCompletenessForGuild(options: {
	memberCount: number;
	cachedMemberCount: number;
	membersIntentEnabled?: boolean;
}): DiscordMembershipCompleteness {
	if (options.membersIntentEnabled === false) {
		return {
			kind: "unavailable",
			reason: "missing_guild_members_intent",
		};
	}
	if (options.memberCount >= COMPLETE_SNAPSHOT_MAX_MEMBERS) {
		return {
			kind: "unavailable",
			reason: `guild_too_large:${options.memberCount}`,
		};
	}
	if (options.cachedMemberCount !== options.memberCount) {
		return {
			kind: "unavailable",
			reason: `member_cache_partial:${options.cachedMemberCount}/${options.memberCount}`,
		};
	}
	return { kind: "complete", memberCount: options.memberCount };
}

function membershipErrorCode(error: unknown): string {
	if (error instanceof ElizaError) {
		if (typeof error.code === "string" && error.code.length > 0) {
			return error.code;
		}
		// Legacy/wrapped authorities may surface the classification only in
		// context; keep that fallback without masking a missing top-level code.
		const context = error.context as { code?: string } | undefined;
		if (context && typeof context.code === "string") {
			return context.code;
		}
	}
	return "";
}

/**
 * Resolve a durable UUID-keyed connector account row for one Discord
 * account key, creating it on first use. Keyed by accountKey so the same
 * configured token maps to one stable row across restarts; the database
 * assigns the UUID id when the incoming id is not already a UUID.
 */
async function ensureDurableDiscordAccount(
	manager: ConnectorAccountManager,
	accountKey: string,
): Promise<ConnectorAccount> {
	const storage = manager.getStorage();
	const existing = await storage.getAccount(DISCORD_CONNECTOR_ID, accountKey);
	if (existing) {
		return existing;
	}
	const nowMs = Date.now();
	const created = await storage.upsertAccount({
		id: accountKey,
		provider: DISCORD_CONNECTOR_ID,
		label: `Discord (${accountKey})`,
		role: "AGENT",
		purpose: ["messaging"],
		accessGate: "open",
		status: "connected",
		metadata: { source: "discord-membership", accountKey },
		createdAt: nowMs,
		updatedAt: nowMs,
	});
	if (!created?.id || typeof created.id !== "string") {
		throw new ElizaError(
			"Discord membership account resolution returned no durable id",
			{
				code: "DISCORD_MEMBERSHIP_ACCOUNT_UNAVAILABLE",
				context: { accountKey },
			},
		);
	}
	return created;
}
