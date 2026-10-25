/**
 * Durable group-room coordination for Discord replies. The coordinator keeps
 * the human edge, speaker slots, lease heartbeat, delivery receipts, and trust
 * membership in shared SQL rows scoped by `server_id`, so independent runtimes
 * and processes contend on one database surface instead of agent-local memory.
 */
import { createHash, randomUUID } from "node:crypto";
import { type IAgentRuntime, stringToUuid, type UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";

export const DISCORD_SPEAKER_LEASE_TABLE = "discord_coordination_reply_slots";
export const DISCORD_COORDINATION_RECEIPT_TABLE =
	"discord_coordination_receipts";
export const MAX_LEASE_GENERATIONS = 64;
export const DEFAULT_SPEAKER_LEASE_MS = 180_000;
export const DEFAULT_BOT_REPLY_BUDGET = 1;
export const DISCORD_COORDINATION_AUDIT_SCOPE = "discord:coordination.audit";

const DEFAULT_HEARTBEAT_MS = 30_000;

export const DEFAULT_COORDINATION_SWEEP_MS = 60_000;

export interface GroupCoordinationConfig {
	enabled: boolean;
	leaseMs: number;
	botReplyBudget: number;
	heartbeatMs: number;
	sweepMs: number;
	serverId?: UUID;
	trustGroupId?: string;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
	if (value === undefined || value === null) return fallback;
	return String(value).trim().toLowerCase() === "true";
}

function parsePositiveInteger(value: unknown, fallback: number): number {
	// `Number.parseInt` stops at the first non-digit, so "2junk" parsed to a
	// finite, positive 2 and was accepted as a deliberate setting instead of
	// falling back. Require the whole trimmed value to be decimal.
	const text = String(value ?? "").trim();
	const parsed = /^\+?\d+$/.test(text) ? Number(text) : Number.NaN;
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: unknown, fallback: number): number {
	// `Number.parseInt` stops at the first non-digit, so "2junk" parsed to a
	// finite, non-negative 2 and was accepted as a deliberate setting instead of
	// falling back. Require the whole trimmed value to be decimal.
	const text = String(value ?? "").trim();
	const parsed = /^\+?\d+$/.test(text) ? Number(text) : Number.NaN;
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeOptionalUuid(value: unknown): UUID | undefined {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) return undefined;
	return text as UUID;
}

export function getGroupCoordinationConfig(
	getSetting: (key: string) => unknown,
): GroupCoordinationConfig {
	return {
		enabled: parseBoolean(
			getSetting("DISCORD_GROUP_COORDINATION_ENABLED"),
			false,
		),
		leaseMs: parsePositiveInteger(
			getSetting("DISCORD_SPEAKER_LEASE_MS"),
			DEFAULT_SPEAKER_LEASE_MS,
		),
		botReplyBudget: parseNonNegativeInteger(
			getSetting("DISCORD_BOT_REPLY_BUDGET"),
			DEFAULT_BOT_REPLY_BUDGET,
		),
		heartbeatMs: parsePositiveInteger(
			getSetting("DISCORD_COORDINATION_HEARTBEAT_MS"),
			DEFAULT_HEARTBEAT_MS,
		),
		sweepMs: parseNonNegativeInteger(
			getSetting("DISCORD_COORDINATION_SWEEP_MS"),
			DEFAULT_COORDINATION_SWEEP_MS,
		),
		serverId: normalizeOptionalUuid(
			getSetting("DISCORD_GROUP_COORDINATION_SERVER_ID") ??
				getSetting("ELIZA_SERVER_ID"),
		),
		trustGroupId:
			typeof getSetting("DISCORD_GROUP_COORDINATION_TRUST_GROUP_ID") ===
				"string" &&
			String(getSetting("DISCORD_GROUP_COORDINATION_TRUST_GROUP_ID")).trim()
				? String(getSetting("DISCORD_GROUP_COORDINATION_TRUST_GROUP_ID")).trim()
				: undefined,
	};
}

export type SpeakerLeaseStore = Pick<IAgentRuntime, "agentId"> &
	Partial<Pick<IAgentRuntime, "reportError">> & {
		db?: object;
		adapter?: { db?: object };
	};

export interface SpeakerLease {
	id: UUID;
	channelId: string;
	edgeMessageId: string;
	lane: CoordinationLane;
	generation: number;
	holderAgentId: UUID;
	contenderToken: string;
	accountId: string;
	serverId?: UUID;
	trustGroupId?: string;
	edgeEpoch?: string;
	claimedAt: number;
	expiresAt: number;
	entityId: UUID;
	roomId: UUID;
	worldId?: UUID;
	nonce?: string;
}

export type SpeakerLeaseClaimOutcome = "won" | "renewed" | "reclaimed" | "lost";

export interface SpeakerLeaseClaimResult {
	outcome: SpeakerLeaseClaimOutcome;
	lease: SpeakerLease;
}

export function speakerLeaseId(
	channelId: string,
	edgeMessageId: string,
	generation: number,
	lane: CoordinationLane = "human",
): UUID {
	return stringToUuid(
		`discord-speaker-lease:${channelId}:${edgeMessageId}:${lane}:g${generation}`,
	);
}

export function createDiscordContenderToken(options: {
	accountId?: string;
	agentId: UUID;
	runtimeInstanceId?: string;
}): string {
	const accountId = options.accountId ?? "default";
	const runtimeInstanceId = options.runtimeInstanceId ?? randomUUID();
	return `discord:${accountId}:${options.agentId}:${runtimeInstanceId}`;
}

export function deterministicDiscordNonce(options: {
	accountId?: string;
	channelId: string;
	authorId: string;
	edgeMessageId: string;
	contentKey?: string;
}): string {
	return createHash("sha256")
		.update(
			[
				"eliza-discord",
				options.accountId ?? "default",
				options.channelId,
				options.authorId,
				options.edgeMessageId,
				options.contentKey ?? "",
			].join(":"),
		)
		.digest("hex")
		.slice(0, 24);
}

/**
 * Provider nonce for a coordinated send. It deliberately excludes agent and
 * runtime-instance identity: recovery by another worker managing the SAME
 * Discord account must reproduce the original nonce. Slot generation
 * distinguishes budgeted bot replies under one human edge.
 */
export function deterministicCoordinationNonce(
	lease: Pick<
		SpeakerLease,
		| "serverId"
		| "trustGroupId"
		| "channelId"
		| "edgeEpoch"
		| "lane"
		| "generation"
	>,
	contentKey: string,
): string {
	return createHash("sha256")
		.update(
			[
				"eliza-discord-coordination",
				lease.serverId ?? "",
				lease.trustGroupId ?? "",
				lease.channelId,
				lease.edgeEpoch ?? "",
				lease.lane,
				String(lease.generation),
				contentKey,
			].join(":"),
		)
		.digest("hex")
		.slice(0, 24);
}

type SqlExecutor = {
	execute(query: unknown): Promise<{ rows?: unknown[] } | unknown>;
};

function getSqlExecutor(store: SpeakerLeaseStore): SqlExecutor | undefined {
	const direct = store.db;
	if (direct && typeof (direct as SqlExecutor).execute === "function") {
		return direct as SqlExecutor;
	}
	const adapterDb = store.adapter?.db;
	if (adapterDb && typeof (adapterDb as SqlExecutor).execute === "function") {
		return adapterDb as SqlExecutor;
	}
	return undefined;
}

function dateFromMs(ms: number): Date {
	return new Date(ms);
}

function msFromDb(value: unknown): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "string" || typeof value === "number") {
		const parsed = new Date(value).getTime();
		return Number.isFinite(parsed) ? parsed : Date.now();
	}
	return Date.now();
}

export function compareDiscordSnowflake(a: string, b: string): number {
	if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
		const left = BigInt(a);
		const right = BigInt(b);
		return left === right ? 0 : left > right ? 1 : -1;
	}
	return a.localeCompare(b);
}

function rowRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function rowsOf(result: unknown): Record<string, unknown>[] {
	const rows = rowRecord(result).rows;
	return Array.isArray(rows) ? rows.map(rowRecord) : [];
}

async function ensureCoordinationTables(db: SqlExecutor): Promise<void> {
	// The plugin schema/migration owns these tables so plugin-sql can apply its
	// production server_id RLS policy. Runtime DDL would create an unprotected
	// table after the RLS pass, so enabled deployments fail closed instead.
	await db.execute(
		sql`SELECT 1 FROM discord_coordination_trust_members LIMIT 0`,
	);
	await db.execute(sql`SELECT 1 FROM discord_coordination_human_edges LIMIT 0`);
	await db.execute(sql`SELECT 1 FROM discord_coordination_reply_slots LIMIT 0`);
	await db.execute(sql`SELECT 1 FROM discord_coordination_receipts LIMIT 0`);
}

export interface CoordinationScope {
	accountId: string;
	serverId: UUID;
	trustGroupId: string;
	contenderToken: string;
	runtimeInstanceId: string;
}

/**
 * Reply lanes are budgeted separately. Answering the human who set the edge is
 * the `human` lane (always exactly one slot); answering another bot that
 * addressed us is the `bot` lane (bounded by DISCORD_BOT_REPLY_BUDGET). Sharing
 * one lane would let the human answer exhaust the bot budget for that edge.
 */
export type CoordinationLane = "human" | "bot";

/**
 * Operator-declared trust roster for a coordination group:
 * `DISCORD_COORDINATION_TRUST_MEMBERS` is a comma-separated list of agent ids
 * allowed to contend in the group. Membership rows are DERIVED from it, never
 * self-minted — an agent that merely knows the server/trust-group ids cannot
 * register itself and then pass its own trust check.
 */
export function parseTrustRoster(value: unknown): Set<string> {
	return new Set(
		String(value ?? "")
			.split(",")
			.map((entry) => entry.trim().toLowerCase())
			.filter((entry) => entry.length > 0),
	);
}

export function requireCoordinationScope(
	store: Pick<IAgentRuntime, "agentId" | "getSetting">,
	accountId: string,
): CoordinationScope {
	const config = getGroupCoordinationConfig((key) => store.getSetting(key));
	if (!config.enabled) {
		throw new Error("Discord group coordination is not enabled");
	}
	if (!config.serverId || !config.trustGroupId) {
		throw new Error(
			"DISCORD_GROUP_COORDINATION_ENABLED requires DISCORD_GROUP_COORDINATION_SERVER_ID/ELIZA_SERVER_ID and DISCORD_GROUP_COORDINATION_TRUST_GROUP_ID",
		);
	}
	const roster = parseTrustRoster(
		store.getSetting("DISCORD_COORDINATION_TRUST_MEMBERS"),
	);
	if (roster.size === 0) {
		throw new Error(
			"DISCORD_GROUP_COORDINATION_ENABLED requires DISCORD_COORDINATION_TRUST_MEMBERS (explicit agent-id roster for the trust group)",
		);
	}
	if (!roster.has(String(store.agentId).toLowerCase())) {
		throw new Error(
			`Agent ${store.agentId} is not listed in DISCORD_COORDINATION_TRUST_MEMBERS for group ${config.trustGroupId}`,
		);
	}
	const runtimeInstanceId =
		String(store.getSetting("ELIZA_RUNTIME_INSTANCE_ID") ?? "").trim() ||
		randomUUID();
	return {
		accountId,
		serverId: config.serverId,
		trustGroupId: config.trustGroupId,
		runtimeInstanceId,
		contenderToken: createDiscordContenderToken({
			accountId,
			agentId: store.agentId,
			runtimeInstanceId,
		}),
	};
}

export async function registerCoordinationTrustMember(
	store: SpeakerLeaseStore & Partial<Pick<IAgentRuntime, "getSetting">>,
	scope: CoordinationScope,
): Promise<void> {
	const db = getSqlExecutor(store);
	if (!db) {
		throw new Error(
			"Discord group coordination requires plugin-sql runtime.db",
		);
	}
	// Trust is operator-declared, not self-asserted: an agent may only publish a
	// membership row for itself if the operator listed it in the roster. Without
	// this, self-registration would make assertTrusted vacuous.
	if (typeof store.getSetting === "function") {
		const roster = parseTrustRoster(
			store.getSetting("DISCORD_COORDINATION_TRUST_MEMBERS"),
		);
		if (!roster.has(String(store.agentId).toLowerCase())) {
			throw new Error(
				`Agent ${store.agentId} is not listed in DISCORD_COORDINATION_TRUST_MEMBERS for group ${scope.trustGroupId}`,
			);
		}
	}
	await ensureCoordinationTables(db);
	await db.execute(sql`
		INSERT INTO discord_coordination_trust_members
			(server_id, account_id, trust_group_id, runtime_instance_id, agent_id, allowed, updated_at)
		VALUES (${scope.serverId}, ${scope.accountId}, ${scope.trustGroupId}, ${scope.runtimeInstanceId}, ${store.agentId}, TRUE, NOW())
		ON CONFLICT (server_id, account_id, trust_group_id, agent_id)
		DO UPDATE SET runtime_instance_id = EXCLUDED.runtime_instance_id, allowed = TRUE, updated_at = NOW()
	`);
}

async function assertTrusted(
	store: SpeakerLeaseStore,
	scope: CoordinationScope,
): Promise<void> {
	const db = getSqlExecutor(store);
	if (!db) {
		throw new Error(
			"Discord group coordination requires plugin-sql runtime.db",
		);
	}
	await ensureCoordinationTables(db);
	const result = await db.execute(sql`
		SELECT allowed FROM discord_coordination_trust_members
		WHERE server_id = ${scope.serverId}
			AND account_id = ${scope.accountId}
			AND trust_group_id = ${scope.trustGroupId}
			AND agent_id = ${store.agentId}
	`);
	if (rowsOf(result)[0]?.allowed !== true) {
		throw new Error(
			`Discord coordination contender is not trusted for group ${scope.trustGroupId}`,
		);
	}
}

export async function recordDiscordHumanEdge(
	owner: SpeakerLeaseStore | object | undefined,
	channelId: string | undefined,
	messageId: string | undefined,
	_at: number = Date.now(),
	scope?: CoordinationScope,
): Promise<void> {
	if (!owner || !channelId || !messageId || !scope) return;
	const db = getSqlExecutor(owner as SpeakerLeaseStore);
	if (!db) return;
	await ensureCoordinationTables(db);
	await assertTrusted(owner as SpeakerLeaseStore, scope);
	await db.execute(sql`
		INSERT INTO discord_coordination_human_edges
			(server_id, trust_group_id, channel_id, edge_message_id, edge_epoch, updated_at)
		VALUES (${scope.serverId}, ${scope.trustGroupId}, ${channelId}, ${messageId}, ${messageId}, NOW())
		ON CONFLICT (server_id, trust_group_id, channel_id)
		DO UPDATE SET
			edge_message_id = CASE
				WHEN EXCLUDED.edge_message_id::numeric > discord_coordination_human_edges.edge_message_id::numeric
				THEN EXCLUDED.edge_message_id
				ELSE discord_coordination_human_edges.edge_message_id
			END,
			edge_epoch = CASE
				WHEN EXCLUDED.edge_message_id::numeric > discord_coordination_human_edges.edge_message_id::numeric
				THEN EXCLUDED.edge_epoch
				ELSE discord_coordination_human_edges.edge_epoch
			END,
			updated_at = NOW()
	`);
}

export async function getDiscordHumanEdge(
	owner: SpeakerLeaseStore | object | undefined,
	channelId: string | undefined,
	scope?: CoordinationScope,
): Promise<{ messageId: string; at: number; edgeEpoch: string } | undefined> {
	if (!owner || !channelId || !scope) return undefined;
	const db = getSqlExecutor(owner as SpeakerLeaseStore);
	if (!db) return undefined;
	await ensureCoordinationTables(db);
	const result = await db.execute(sql`
		SELECT edge_message_id, edge_epoch, updated_at
		FROM discord_coordination_human_edges
		WHERE server_id = ${scope.serverId}
			AND trust_group_id = ${scope.trustGroupId}
			AND channel_id = ${channelId}
	`);
	const row = rowsOf(result)[0];
	if (!row) return undefined;
	return {
		messageId: String(row.edge_message_id),
		edgeEpoch: String(row.edge_epoch),
		at: msFromDb(row.updated_at),
	};
}

export interface EdgeCurrencyDecision {
	current: boolean;
	latestEdgeMessageId?: string;
	edgeEpoch?: string;
}

export async function evaluateEdgeCurrency(options: {
	owner: SpeakerLeaseStore | object | undefined;
	channelId: string | undefined;
	edgeMessageId: string;
	coalescedMessageIds?: string[];
	explicitlyAddressed?: boolean;
	scope?: CoordinationScope;
}): Promise<EdgeCurrencyDecision> {
	const latest = await getDiscordHumanEdge(
		options.owner,
		options.channelId,
		options.scope,
	);
	if (!latest) return { current: true, edgeEpoch: options.edgeMessageId };
	if (latest.messageId === options.edgeMessageId) {
		return {
			current: true,
			latestEdgeMessageId: latest.messageId,
			edgeEpoch: latest.edgeEpoch,
		};
	}
	if (options.coalescedMessageIds?.includes(latest.messageId)) {
		return {
			current: true,
			latestEdgeMessageId: latest.messageId,
			edgeEpoch: latest.edgeEpoch,
		};
	}
	if (options.explicitlyAddressed) {
		return {
			current: true,
			latestEdgeMessageId: latest.messageId,
			edgeEpoch: latest.edgeEpoch,
		};
	}
	return {
		current: false,
		latestEdgeMessageId: latest.messageId,
		edgeEpoch: latest.edgeEpoch,
	};
}

export interface SpeakerLeaseClaimParams {
	channelId: string;
	edgeMessageId: string;
	roomId: UUID;
	entityId: UUID;
	worldId?: UUID;
	leaseMs: number;
	now?: number;
	accountId?: string;
	scope?: CoordinationScope;
	contenderToken?: string;
	nonce?: string;
	slotCount?: number;
	lane?: CoordinationLane;
}

function decodeSlot(
	row: Record<string, unknown>,
	params: SpeakerLeaseClaimParams,
	scope: CoordinationScope,
): SpeakerLease {
	const slotIndex =
		typeof row.slot_index === "number"
			? row.slot_index
			: Number.parseInt(String(row.slot_index ?? "0"), 10);
	const holderToken = String(row.contender_token ?? scope.contenderToken);
	const lane = (
		String(row.lane ?? params.lane ?? "human") === "bot" ? "bot" : "human"
	) as CoordinationLane;
	return {
		id: speakerLeaseId(params.channelId, params.edgeMessageId, slotIndex, lane),
		channelId: params.channelId,
		edgeMessageId: params.edgeMessageId,
		lane,
		generation: slotIndex,
		holderAgentId: storeAgentIdFromToken(holderToken, scope),
		contenderToken: holderToken,
		accountId: scope.accountId,
		serverId: scope.serverId,
		trustGroupId: scope.trustGroupId,
		edgeEpoch: String(row.edge_epoch ?? params.edgeMessageId),
		claimedAt: msFromDb(row.claimed_at),
		expiresAt: msFromDb(row.expires_at),
		entityId: params.entityId,
		roomId: params.roomId,
		worldId: params.worldId,
		nonce: String(row.nonce ?? params.nonce ?? ""),
	};
}

function storeAgentIdFromToken(token: string, scope: CoordinationScope): UUID {
	const parts = token.split(":");
	return (parts[2] || scope.contenderToken.split(":")[2] || "") as UUID;
}

export async function claimSpeakerLease(
	store: SpeakerLeaseStore,
	params: SpeakerLeaseClaimParams,
): Promise<SpeakerLeaseClaimResult> {
	if (!params.scope) {
		throw new Error(
			"Discord group coordination requires a durable CoordinationScope",
		);
	}
	const db = getSqlExecutor(store);
	if (!db) {
		throw new Error(
			"Discord group coordination requires plugin-sql runtime.db",
		);
	}
	const scope = params.scope;
	const now = params.now ?? Date.now();
	const expiresAt = dateFromMs(now + params.leaseMs);
	const nonce =
		params.nonce ??
		deterministicDiscordNonce({
			accountId: scope.accountId,
			channelId: params.channelId,
			authorId: String(params.entityId),
			edgeMessageId: params.edgeMessageId,
		});
	await ensureCoordinationTables(db);
	await assertTrusted(store, scope);
	const lane: CoordinationLane = params.lane ?? "human";
	const edge =
		(await getDiscordHumanEdge(store, params.channelId, scope)) ??
		({
			messageId: params.edgeMessageId,
			edgeEpoch: params.edgeMessageId,
			at: now,
		} as const);
	const slotCount = Math.max(1, params.slotCount ?? 1);
	for (
		let slotIndex = 0;
		slotIndex < Math.min(slotCount, MAX_LEASE_GENERATIONS);
		slotIndex += 1
	) {
		// First claim is a strict first-writer-wins insert. Every contender uses
		// the same agent-independent primary-key row, and ON CONFLICT DO NOTHING
		// makes the winner atomic without allowing a concurrent writer to mutate
		// the settled holder.
		const inserted = rowsOf(
			await db.execute(sql`
				INSERT INTO discord_coordination_reply_slots
					(server_id, trust_group_id, account_id, channel_id, edge_epoch, lane, slot_index, contender_token, inbound_message_id, nonce, state, claimed_at, heartbeat_at, expires_at, updated_at)
				VALUES (${scope.serverId}, ${scope.trustGroupId}, ${scope.accountId}, ${params.channelId}, ${edge.edgeEpoch}, ${lane}, ${slotIndex}, ${scope.contenderToken}, ${params.edgeMessageId}, ${nonce}, 'claimed', NOW(), NOW(), ${expiresAt}, NOW())
				ON CONFLICT DO NOTHING
				RETURNING *
			`),
		)[0];
		if (inserted) {
			return { outcome: "won", lease: decodeSlot(inserted, params, scope) };
		}

		const settled = rowsOf(
			await db.execute(sql`
				SELECT * FROM discord_coordination_reply_slots
				WHERE server_id = ${scope.serverId}
					AND trust_group_id = ${scope.trustGroupId}
					AND channel_id = ${params.channelId}
					AND edge_epoch = ${edge.edgeEpoch}
					AND lane = ${lane}
					AND slot_index = ${slotIndex}
			`),
		)[0];
		if (!settled) continue;

		// A slot that reached a terminal outcome is never reclaimable by expiry:
		// the reply either went out (`delivered`) or the budget was spent. Treating
		// it as free would let an expired-but-answered edge be answered twice.
		const state = String(settled.state ?? "claimed");
		if (
			state === "delivered" ||
			state === "consumed" ||
			state === "abandoned" ||
			typeof settled.delivered_message_id === "string"
		) {
			continue;
		}
		if (msFromDb(settled.expires_at) > now && state === "claimed") {
			const liveLease = decodeSlot(settled, params, scope);
			if (liveLease.contenderToken === scope.contenderToken) {
				return { outcome: "renewed", lease: liveLease };
			}
			continue;
		}

		// Expiry/release reclaim is a separate compare-and-set. This preserves the
		// strict DO NOTHING initial race while still allowing one successor to
		// recover a dead holder. The settled token/state predicates prevent a stale
		// observation from overwriting a newer holder.
		const reclaimed = rowsOf(
			await db.execute(sql`
				UPDATE discord_coordination_reply_slots
				SET account_id = ${scope.accountId},
					contender_token = ${scope.contenderToken},
					inbound_message_id = ${params.edgeMessageId},
					nonce = ${nonce},
					state = 'claimed',
					claimed_at = NOW(),
					heartbeat_at = NOW(),
					expires_at = ${expiresAt},
					updated_at = NOW()
				WHERE server_id = ${scope.serverId}
					AND trust_group_id = ${scope.trustGroupId}
					AND channel_id = ${params.channelId}
					AND edge_epoch = ${edge.edgeEpoch}
					AND lane = ${lane}
					AND slot_index = ${slotIndex}
					-- Recovery is Discord-account-affine. Other accounts may contend
					-- initially, but cannot replay a winner's send with different
					-- provider credentials/idempotency scope after a crash.
					AND account_id = ${scope.accountId}
					AND contender_token = ${String(settled.contender_token)}
					AND state = ${state}
					AND delivered_message_id IS NULL
					AND state NOT IN ('delivered', 'consumed', 'abandoned')
					AND (expires_at <= NOW() OR state IN ('released', 'expired'))
				RETURNING *
			`),
		)[0];
		if (reclaimed) {
			return {
				outcome: "reclaimed",
				lease: decodeSlot(reclaimed, params, scope),
			};
		}
	}
	const existing = await db.execute(sql`
		SELECT * FROM discord_coordination_reply_slots
		WHERE server_id = ${scope.serverId}
			AND trust_group_id = ${scope.trustGroupId}
			AND channel_id = ${params.channelId}
			AND edge_epoch = ${edge.edgeEpoch}
			AND lane = ${lane}
		ORDER BY slot_index ASC
		LIMIT 1
	`);
	const row = rowsOf(existing)[0];
	if (row) {
		return { outcome: "lost", lease: decodeSlot(row, params, scope) };
	}
	return {
		outcome: "lost",
		lease: {
			id: speakerLeaseId(params.channelId, params.edgeMessageId, 0, lane),
			channelId: params.channelId,
			edgeMessageId: params.edgeMessageId,
			lane,
			generation: 0,
			holderAgentId: store.agentId,
			contenderToken: scope.contenderToken,
			accountId: scope.accountId,
			serverId: scope.serverId,
			trustGroupId: scope.trustGroupId,
			edgeEpoch: edge.edgeEpoch,
			claimedAt: now,
			expiresAt: now,
			entityId: params.entityId,
			roomId: params.roomId,
			worldId: params.worldId,
			nonce,
		},
	};
}

export interface SpeakerLeaseVerifyResult {
	held: boolean;
	reason?: "expired" | "superseded" | "not-holder" | "missing";
	deliveredMessageId?: string;
}

export async function verifySpeakerLease(
	store: SpeakerLeaseStore,
	lease: SpeakerLease,
	now: number = Date.now(),
): Promise<SpeakerLeaseVerifyResult> {
	if (!lease.serverId || !lease.edgeEpoch) {
		return { held: false, reason: "missing" };
	}
	const db = getSqlExecutor(store);
	if (!db)
		throw new Error(
			"Discord group coordination requires plugin-sql runtime.db",
		);
	const result = await db.execute(sql`
		SELECT * FROM discord_coordination_reply_slots
		WHERE server_id = ${lease.serverId}
			AND trust_group_id = ${lease.trustGroupId}
			AND channel_id = ${lease.channelId}
			AND edge_epoch = ${lease.edgeEpoch}
			AND lane = ${lease.lane ?? "human"}
			AND slot_index = ${lease.generation}
	`);
	const row = rowsOf(result)[0];
	if (!row) return { held: false, reason: "missing" };
	if (String(row.contender_token) !== lease.contenderToken) {
		return { held: false, reason: "not-holder" };
	}
	if (msFromDb(row.expires_at) <= now)
		return { held: false, reason: "expired" };
	return {
		held: true,
		deliveredMessageId:
			typeof row.delivered_message_id === "string"
				? row.delivered_message_id
				: undefined,
	};
}

export async function renewSpeakerLease(
	store: SpeakerLeaseStore,
	lease: SpeakerLease,
	leaseMs: number,
): Promise<boolean> {
	// A lease without tenant scope is not a lease: the fence must fail closed.
	if (!lease.serverId || !lease.edgeEpoch) return false;
	const db = getSqlExecutor(store);
	if (!db) return false;
	const result = await db.execute(sql`
		UPDATE discord_coordination_reply_slots
		SET heartbeat_at = NOW(), expires_at = ${dateFromMs(Date.now() + leaseMs)}, updated_at = NOW()
		WHERE server_id = ${lease.serverId}
			AND trust_group_id = ${lease.trustGroupId}
			AND channel_id = ${lease.channelId}
			AND edge_epoch = ${lease.edgeEpoch}
			AND lane = ${lease.lane ?? "human"}
			AND slot_index = ${lease.generation}
			AND contender_token = ${lease.contenderToken}
			AND state = 'claimed'
			AND expires_at > NOW()
		RETURNING *
	`);
	return rowsOf(result).length > 0;
}

/**
 * Release a claimed slot that will never produce a reply (aborted before the
 * third-party send: superseded edge, model failure, empty response). Without this
 * the slot sits `claimed` until it expires, the sweeper then re-dispatches an
 * edge that was deliberately abandoned, and for the bot lane the budget stays
 * spent for the rest of the edge. Only the holder can release, and a slot that
 * already delivered is never released.
 */
export async function releaseSpeakerLease(
	store: SpeakerLeaseStore,
	lease: SpeakerLease,
	reason: string,
): Promise<void> {
	if (!lease.serverId || !lease.edgeEpoch) return;
	const db = getSqlExecutor(store);
	if (!db) return;
	await db.execute(sql`
		UPDATE discord_coordination_reply_slots
		SET state = 'released',
			expires_at = NOW(),
			heartbeat_at = NOW(),
			updated_at = NOW()
		WHERE server_id = ${lease.serverId}
			AND trust_group_id = ${lease.trustGroupId}
			AND channel_id = ${lease.channelId}
			AND edge_epoch = ${lease.edgeEpoch}
			AND lane = ${lease.lane ?? "human"}
			AND slot_index = ${lease.generation}
			AND contender_token = ${lease.contenderToken}
			AND delivered_message_id IS NULL
			AND state = 'claimed'
	`);
	void reason;
}

export async function reconcileDiscordDelivery(
	store: SpeakerLeaseStore,
	lease: SpeakerLease,
	deliveredMessageId: string,
): Promise<void> {
	if (!lease.serverId || !lease.edgeEpoch) return;
	const db = getSqlExecutor(store);
	if (!db) return;
	await db.execute(sql`
		UPDATE discord_coordination_reply_slots
		SET state = 'delivered',
			delivered_message_id = ${deliveredMessageId},
			heartbeat_at = NOW(),
			updated_at = NOW()
		WHERE server_id = ${lease.serverId}
			AND trust_group_id = ${lease.trustGroupId}
			AND channel_id = ${lease.channelId}
			AND edge_epoch = ${lease.edgeEpoch}
			AND lane = ${lease.lane ?? "human"}
			AND slot_index = ${lease.generation}
			AND contender_token = ${lease.contenderToken}
	`);
}

export async function shouldSuppressBotReply(options: {
	owner: SpeakerLeaseStore | object | undefined;
	channelId: string | undefined;
	explicitlyAddressed: boolean;
	budget: number;
	scope?: CoordinationScope;
}): Promise<{
	suppress: boolean;
	reason?: "not-addressed" | "budget-exhausted";
}> {
	if (!options.explicitlyAddressed) {
		return { suppress: true, reason: "not-addressed" };
	}
	if (!options.owner || !options.channelId || !options.scope) {
		return { suppress: false };
	}
	const db = getSqlExecutor(options.owner as SpeakerLeaseStore);
	if (!db) return { suppress: false };
	const edge = await getDiscordHumanEdge(
		options.owner,
		options.channelId,
		options.scope,
	);
	// The budget is defined relative to a human-edge epoch. Before the first
	// human edge there is no budget to spend, so an addressed bot message must be
	// suppressed rather than manufacturing a bot-authored epoch (which would let
	// each new bot message reset its own budget and loop forever).
	if (!edge) return { suppress: true, reason: "budget-exhausted" };
	// Bot-lane rows only: the human-lane slot for this edge is the answer to the
	// human and must not count against the bot-to-bot loop budget. `released`
	// rows are abandoned attempts and are likewise not spend.
	const result = await db.execute(sql`
		SELECT COUNT(*) AS count
		FROM discord_coordination_reply_slots
		WHERE server_id = ${options.scope.serverId}
			AND trust_group_id = ${options.scope.trustGroupId}
			AND channel_id = ${options.channelId}
			AND edge_epoch = ${edge.edgeEpoch}
			AND lane = 'bot'
			AND state IN ('claimed', 'consumed', 'delivered')
	`);
	const used = Number(rowsOf(result)[0]?.count ?? 0);
	if (used >= options.budget) {
		return { suppress: true, reason: "budget-exhausted" };
	}
	return { suppress: false };
}

/**
 * A reply slot recovered by the crash sweeper: the holder's lease expired in
 * state `claimed` with no delivered message, meaning the winner crashed (or
 * lost its process) between claim and delivery and the human edge is
 * unanswered. The sweeper marks the row `expired` (atomically, first sweeper
 * wins) and returns it so the caller can re-dispatch the inbound message
 * through the normal handle path, where the ordinary claim/fence machinery
 * decides who answers.
 */
export interface SweptCoordinationSlot {
	channelId: string;
	edgeEpoch: string;
	lane: CoordinationLane;
	slotIndex: number;
	inboundMessageId: string;
	holderToken: string;
	recoveryAttempts: number;
}

/**
 * Bound on sweeper re-dispatch per slot. A message that reproducibly kills its
 * holder (poison inbound) would otherwise be recovered, crash the next holder,
 * expire, and be recovered again forever. After this many recoveries the slot
 * is terminally `abandoned` and reported, never re-dispatched.
 */
export const MAX_SWEEP_RECOVERY_ATTEMPTS = 3;

export async function sweepExpiredCoordinationSlots(
	store: SpeakerLeaseStore,
	scope: CoordinationScope,
	now: number = Date.now(),
	/**
	 * Channels this sweeper can actually re-dispatch into. Recovery is only
	 * meaningful for a channel whose Discord client this process holds: sweeping
	 * an unreachable channel terminally expires the slot (spending a recovery
	 * attempt) while the re-dispatch silently fails, leaving the human edge
	 * permanently unanswered. Undefined = no restriction (single-account
	 * deployments and protocol-level tests).
	 */
	reachableChannelIds?: readonly string[],
): Promise<SweptCoordinationSlot[]> {
	const db = getSqlExecutor(store);
	if (!db) return [];
	if (reachableChannelIds && reachableChannelIds.length === 0) return [];
	const channelFilter = reachableChannelIds
		? sql`AND channel_id IN (${sql.join(
				reachableChannelIds.map((id) => sql`${id}`),
				sql`, `,
			)})`
		: sql``;
	await ensureCoordinationTables(db);
	await assertTrusted(store, scope);
	// Slots past the recovery bound are retired instead of recovered, so a poison
	// inbound cannot be re-dispatched indefinitely.
	await db.execute(sql`
		UPDATE discord_coordination_reply_slots
		SET state = 'abandoned', updated_at = NOW()
		WHERE server_id = ${scope.serverId}
			AND trust_group_id = ${scope.trustGroupId}
			AND account_id = ${scope.accountId}
			AND state = 'claimed'
			AND expires_at <= ${dateFromMs(now)}
			AND delivered_message_id IS NULL
			AND recovery_attempts >= ${MAX_SWEEP_RECOVERY_ATTEMPTS}
			${channelFilter}
	`);
	const result = await db.execute(sql`
		UPDATE discord_coordination_reply_slots
		SET state = 'expired',
			recovery_attempts = recovery_attempts + 1,
			updated_at = NOW()
		WHERE server_id = ${scope.serverId}
			AND trust_group_id = ${scope.trustGroupId}
			AND account_id = ${scope.accountId}
			AND state = 'claimed'
			AND expires_at <= ${dateFromMs(now)}
			AND delivered_message_id IS NULL
			AND recovery_attempts < ${MAX_SWEEP_RECOVERY_ATTEMPTS}
			${channelFilter}
		RETURNING channel_id, edge_epoch, lane, slot_index, inbound_message_id, contender_token, recovery_attempts
	`);
	return rowsOf(result).map((row) => ({
		channelId: String(row.channel_id),
		edgeEpoch: String(row.edge_epoch),
		lane: (String(row.lane ?? "human") === "bot"
			? "bot"
			: "human") as CoordinationLane,
		slotIndex:
			typeof row.slot_index === "number"
				? row.slot_index
				: Number.parseInt(String(row.slot_index ?? "0"), 10),
		inboundMessageId: String(row.inbound_message_id),
		holderToken: String(row.contender_token),
		recoveryAttempts: Number(row.recovery_attempts ?? 1),
	}));
}

/**
 * Re-arm a swept slot when redispatch did not claim it. The update is a guarded
 * compare-and-set: if redispatch succeeded (state/token changed), this is a
 * no-op. Otherwise the next sweep retries after `retryMs`, bounded by the
 * already-incremented recovery counter.
 */
export async function rearmSweptCoordinationSlot(
	store: SpeakerLeaseStore,
	scope: CoordinationScope,
	slot: SweptCoordinationSlot,
	retryMs: number,
): Promise<boolean> {
	const db = getSqlExecutor(store);
	if (!db) return false;
	const result = await db.execute(sql`
		UPDATE discord_coordination_reply_slots
		SET state = 'claimed',
			heartbeat_at = NOW(),
			expires_at = ${dateFromMs(Date.now() + Math.max(1_000, retryMs))},
			updated_at = NOW()
		WHERE server_id = ${scope.serverId}
			AND trust_group_id = ${scope.trustGroupId}
			AND account_id = ${scope.accountId}
			AND channel_id = ${slot.channelId}
			AND edge_epoch = ${slot.edgeEpoch}
			AND lane = ${slot.lane}
			AND slot_index = ${slot.slotIndex}
			AND contender_token = ${slot.holderToken}
			AND state = 'expired'
			AND delivered_message_id IS NULL
		RETURNING slot_index
	`);
	return rowsOf(result).length > 0;
}

export type CoordinationReceiptKind =
	| "lease-claim"
	| "stale-edge-abort"
	| "lost-lease-abort"
	| "bot-loop-suppress"
	| "delivery-reconciled"
	| "sweeper-recovery"
	| "coordination-error";

export interface CoordinationReceiptParams {
	kind: CoordinationReceiptKind;
	channelId: string;
	edgeMessageId: string;
	roomId: UUID;
	entityId: UUID;
	worldId?: UUID;
	outcome?: string;
	generation?: number;
	holderAgentId?: UUID;
	holderToken?: string;
	edgeEpoch?: string;
	detail?: Record<string, unknown>;
	scope?: CoordinationScope;
}

export type CoordinationReceiptStore = Pick<IAgentRuntime, "agentId"> &
	Partial<Pick<IAgentRuntime, "reportError">> & {
		db?: object;
		adapter?: { db?: object };
	};

export async function emitCoordinationReceipt(
	store: CoordinationReceiptStore,
	params: CoordinationReceiptParams,
): Promise<boolean> {
	try {
		if (params.scope) {
			const db = getSqlExecutor(store as SpeakerLeaseStore);
			if (!db) {
				throw new Error(
					"Discord coordination audit requires plugin-sql runtime.db",
				);
			}
			await ensureCoordinationTables(db);
			await db.execute(sql`
				INSERT INTO discord_coordination_receipts
					(id, server_id, account_id, trust_group_id, channel_id, edge_message_id, edge_epoch, kind, outcome, contender_token, holder_token, detail, created_at)
				VALUES (
					${randomUUID()},
					${params.scope.serverId},
					${params.scope.accountId},
					${params.scope.trustGroupId},
					${params.channelId},
					${params.edgeMessageId},
					${params.edgeEpoch ?? null},
					${params.kind},
					${params.outcome ?? null},
					${params.scope.contenderToken},
					${params.holderToken ?? null},
					${params.detail ? JSON.stringify(params.detail) : null},
					NOW()
				)
			`);
			return true;
		}
		// No scope means the caller is not on the durable path; audit rows only
		// exist in the coordination schema, so report instead of silently writing
		// an untenanted memory row nobody reads.
		throw new Error(
			"Discord coordination audit requires a durable CoordinationScope",
		);
	} catch (error) {
		store.reportError?.(DISCORD_COORDINATION_AUDIT_SCOPE, error, {
			kind: params.kind,
			channelId: params.channelId,
			edgeMessageId: params.edgeMessageId,
			outcome: params.outcome,
		});
		return false;
	}
}
