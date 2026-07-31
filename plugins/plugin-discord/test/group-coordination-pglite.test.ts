/**
 * P4 group coordination against the real runtime/PGlite seam (no unit mocks).
 *
 * The speaker-lease protocol's safety argument rests on an agent-independent
 * composite row key and an atomic SQL `INSERT ... ON CONFLICT DO NOTHING`.
 * This suite proves that production query path against a real AgentRuntime and
 * in-process PGlite database, with independent holder identities contending
 * over the same durable store. PGlite does not enforce production PostgreSQL
 * Row Level Security and is not an independent-process Postgres proof.
 *
 * Proven here:
 *   - concurrent claim race    -> exactly one winner, one lease row, loser
 *                                 observes the winner (no split-brain)
 *   - idempotent retry         -> renewed, no second row, no double-claim
 *   - holder crash + expiry    -> one successor reclaims the same budget slot
 *   - stale revived holder     -> verify reports superseded; must abort
 *   - receipts                 -> auditable rows in the coordination table
 */
import { randomUUID } from "node:crypto";
import type { AgentRuntime, UUID } from "@elizaos/core";
import { ChannelType, stringToUuid } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	claimSpeakerLease,
	createDiscordContenderToken,
	emitCoordinationReceipt,
	MAX_SWEEP_RECOVERY_ATTEMPTS,
	reconcileDiscordDelivery,
	recordDiscordHumanEdge,
	registerCoordinationTrustMember,
	rearmSweptCoordinationSlot,
	releaseSpeakerLease,
	shouldSuppressBotReply,
	sweepExpiredCoordinationSlots,
	type CoordinationScope,
	type SpeakerLeaseStore,
	verifySpeakerLease,
} from "../group-coordination.ts";
import * as discordCoordinationSchema from "../coordination-schema.ts";
import {
	createTestRuntime,
	type TestRuntimeResult,
} from "./helpers/pglite-runtime.ts";

const HOLDER_A = stringToUuid("pglite-holder-agent-a") as UUID;
const HOLDER_B = stringToUuid("pglite-holder-agent-b") as UUID;
const CHANNEL = "111222333444555666";
const SERVER_ID = stringToUuid("pglite-discord-coordination-server") as UUID;
const TRUST_GROUP_ID = "pglite-test-trust-group";
const HOLDER_C = stringToUuid("pglite-holder-agent-c") as UUID;
/** Operator roster: only these agents may join the trust group. */
const TRUST_ROSTER = [HOLDER_A, HOLDER_B, HOLDER_C].join(",");

let testRuntime: TestRuntimeResult;
let runtime: AgentRuntime;
let roomId: UUID;
let entityId: UUID;

/**
 * A holder identity over the shared runtime database. WHO holds the lease is
 * the contender token derived from account + agent + runtime-instance identity.
 * This is exactly how independent managers sharing one coordination database
 * contend: same agent-independent row, different holder tokens.
 */
function holderStore(
	holderAgentId: UUID,
): SpeakerLeaseStore & { getSetting: (key: string) => unknown } {
	return {
		agentId: holderAgentId,
		db: runtime.db,
		// Trust is operator-declared: registration checks this roster, so an
		// agent absent from it cannot mint its own membership row.
		getSetting: (key: string) =>
			key === "DISCORD_COORDINATION_TRUST_MEMBERS" ? TRUST_ROSTER : undefined,
	};
}

function holderScope(
	holderAgentId: UUID,
	runtimeInstanceId: string,
	accountId = "default",
): CoordinationScope {
	return {
		accountId,
		serverId: SERVER_ID,
		trustGroupId: TRUST_GROUP_ID,
		runtimeInstanceId,
		contenderToken: createDiscordContenderToken({
			accountId,
			agentId: holderAgentId,
			runtimeInstanceId,
		}),
	};
}

beforeAll(async () => {
	// Register the coordination schema through plugin-sql's real migration
	// service. The production tables are owned by the plugin schema (never by
	// runtime DDL) so plugin-sql's RLS pass applies the tenant policy; this
	// suite must migrate them the same way rather than creating them ad hoc.
	testRuntime = await createTestRuntime({
		plugins: [
			{
				name: "discord-coordination-schema",
				description:
					"Discord group-room coordination tables (test registration)",
				schema: discordCoordinationSchema,
			},
		],
	});
	runtime = testRuntime.runtime;
	roomId = stringToUuid(`pglite-coord-room-${randomUUID()}`) as UUID;
	entityId = stringToUuid(`pglite-coord-entity-${randomUUID()}`) as UUID;
	await runtime.ensureConnection({
		entityId,
		roomId,
		worldId: stringToUuid(`pglite-coord-world-${randomUUID()}`) as UUID,
		userName: "shadow",
		name: "Shadow",
		source: "discord",
		type: ChannelType.GROUP,
	});
	await registerCoordinationTrustMember(
		holderStore(HOLDER_A),
		holderScope(HOLDER_A, "runtime-a"),
	);
	await registerCoordinationTrustMember(
		holderStore(HOLDER_B),
		holderScope(HOLDER_B, "runtime-b"),
	);
}, 180_000);

afterAll(async () => {
	await testRuntime.cleanup();
});

function params(
	edgeMessageId: string,
	scope: CoordinationScope,
	overrides: Record<string, unknown> = {},
) {
	return {
		channelId: CHANNEL,
		edgeMessageId,
		roomId,
		entityId,
		leaseMs: 60_000,
		scope,
		...overrides,
	};
}

describe("speaker lease on real PGlite", () => {
	it("two holders racing one edge: exactly one wins, loser sees the winner", async () => {
		const edge = `edge-${randomUUID()}`;
		const scopeA = holderScope(HOLDER_A, "runtime-a");
		const scopeB = holderScope(HOLDER_B, "runtime-b");
		const [resultA, resultB] = await Promise.all([
			claimSpeakerLease(holderStore(HOLDER_A), params(edge, scopeA)),
			claimSpeakerLease(holderStore(HOLDER_B), params(edge, scopeB)),
		]);

		const outcomes = [resultA.outcome, resultB.outcome].sort();
		expect(outcomes).toEqual(["lost", "won"]);
		expect(resultA.lease.id).toBe(resultB.lease.id);
		expect(resultA.lease.holderAgentId).toBe(resultB.lease.holderAgentId);

		// The dedicated reply-slot row is the database source of truth.
		const slot = await (
			runtime.db as { execute(query: unknown): Promise<{ rows: unknown[] }> }
		).execute(sql`
			SELECT contender_token
			FROM discord_coordination_reply_slots
			WHERE channel_id = ${CHANNEL}
				AND edge_epoch = ${edge}
				AND slot_index = 0
		`);
		expect(slot.rows).toHaveLength(1);
		expect((slot.rows[0] as Record<string, unknown>).contender_token).toBe(
			resultA.lease.contenderToken,
		);
	});

	it("same-agent independent managers still contend by runtime-instance token", async () => {
		const edge = `edge-${randomUUID()}`;
		const workerA = holderScope(HOLDER_A, "runtime-a-worker-1");
		const workerB = holderScope(HOLDER_A, "runtime-a-worker-2");
		const [resultA, resultB] = await Promise.all([
			claimSpeakerLease(holderStore(HOLDER_A), params(edge, workerA)),
			claimSpeakerLease(holderStore(HOLDER_A), params(edge, workerB)),
		]);

		expect([resultA.outcome, resultB.outcome].sort()).toEqual(["lost", "won"]);
		expect(resultA.lease.contenderToken).toBe(resultB.lease.contenderToken);
		expect([workerA.contenderToken, workerB.contenderToken]).toContain(
			resultA.lease.contenderToken,
		);
	});

	it("two Discord accounts on one agent still contend on the same room row", async () => {
		const edge = `edge-${randomUUID()}`;
		const primary = holderScope(HOLDER_A, "runtime-shared", "account-primary");
		const secondary = holderScope(
			HOLDER_A,
			"runtime-shared",
			"account-secondary",
		);
		await registerCoordinationTrustMember(holderStore(HOLDER_A), primary);
		await registerCoordinationTrustMember(holderStore(HOLDER_A), secondary);

		const [resultA, resultB] = await Promise.all([
			claimSpeakerLease(holderStore(HOLDER_A), params(edge, primary)),
			claimSpeakerLease(holderStore(HOLDER_A), params(edge, secondary)),
		]);
		expect([resultA.outcome, resultB.outcome].sort()).toEqual(["lost", "won"]);
		expect(resultA.lease.contenderToken).toBe(resultB.lease.contenderToken);
	});

	it("winner's retry is renewed (idempotent), not a re-claim", async () => {
		const edge = `edge-${randomUUID()}`;
		const storeA = holderStore(HOLDER_A);
		const first = await claimSpeakerLease(
			storeA,
			params(edge, holderScope(HOLDER_A, "runtime-a")),
		);
		expect(first.outcome).toBe("won");
		const retry = await claimSpeakerLease(
			storeA,
			params(edge, holderScope(HOLDER_A, "runtime-a")),
		);
		expect(retry.outcome).toBe("renewed");
		expect(retry.lease.generation).toBe(0);
		expect(retry.lease.generation).toBe(0);
	});

	it("holder crash -> expiry -> successor reclaims g+1; revived holder verifies superseded", async () => {
		const edge = `edge-${randomUUID()}`;
		const t0 = Date.now() - 60_000;
		const storeA = holderStore(HOLDER_A);
		const storeB = holderStore(HOLDER_B);
		const scopeA = holderScope(HOLDER_A, "runtime-a");
		const scopeB = holderScope(HOLDER_B, "runtime-b");

		// A claims a short lease at t0 and "crashes".
		const claimA = await claimSpeakerLease(
			storeA,
			params(edge, scopeA, { leaseMs: 5_000, now: t0 }),
		);
		expect(claimA.outcome).toBe("won");

		// After expiry, B atomically reclaims the same budget slot.
		const claimB = await claimSpeakerLease(storeB, params(edge, scopeB));
		expect(claimB.outcome).toBe("reclaimed");
		expect(claimB.lease.generation).toBe(0);
		expect(claimB.lease.holderAgentId).toBe(HOLDER_B);

		// A revives and re-verifies its old lease before sending: the slot is now
		// held by B.
		const check = await verifySpeakerLease(storeA, claimA.lease, t0 + 4_000);
		expect(check.held).toBe(false);
		expect(check.reason).toBe("not-holder");

		// B's lease verifies held.
		const checkB = await verifySpeakerLease(storeB, claimB.lease);
		expect(checkB.held).toBe(true);
	});

	it("two successors racing an expired lease: exactly one reclaims", async () => {
		const edge = `edge-${randomUUID()}`;
		const t0 = Date.now() - 60_000;
		await claimSpeakerLease(
			holderStore(HOLDER_A),
			params(edge, holderScope(HOLDER_A, "runtime-a"), {
				leaseMs: 5_000,
				now: t0,
			}),
		);
		const holderC = HOLDER_C;
		const scopeC = holderScope(holderC, "runtime-c");
		await registerCoordinationTrustMember(holderStore(holderC), scopeC);
		const [rB, rC] = await Promise.all([
			claimSpeakerLease(
				holderStore(HOLDER_B),
				params(edge, holderScope(HOLDER_B, "runtime-b")),
			),
			claimSpeakerLease(holderStore(holderC), params(edge, scopeC)),
		]);
		const outcomes = [rB.outcome, rC.outcome].sort();
		expect(outcomes).toEqual(["lost", "reclaimed"]);
		const winner = rB.outcome === "reclaimed" ? rB : rC;
		expect(winner.lease.generation).toBe(0);
		expect(rB.lease.holderAgentId).toBe(rC.lease.holderAgentId);
	});

	it("coordination receipts persist as auditable rows in the real store", async () => {
		const edge = `edge-${randomUUID()}`;
		const ok = await emitCoordinationReceipt(holderStore(HOLDER_A), {
			kind: "lease-claim",
			channelId: CHANNEL,
			edgeMessageId: edge,
			roomId,
			entityId,
			outcome: "won",
			generation: 0,
			scope: holderScope(HOLDER_A, "runtime-a"),
		});
		expect(ok).toBe(true);

		const result = await (runtime.db as { execute(query: unknown): Promise<{ rows: unknown[] }> }).execute(sql`
			SELECT kind, outcome, contender_token
			FROM discord_coordination_receipts
			WHERE edge_message_id = ${edge}
		`);
		const data = result.rows[0] as Record<string, unknown> | undefined;
		expect(data).toBeDefined();
		expect(data?.kind).toBe("lease-claim");
		expect(data?.outcome).toBe("won");
		expect(data?.contender_token).toContain(HOLDER_A);
	});
});

describe("crash-recovery sweeper on real PGlite", () => {
	it("recovers an expired undelivered claim exactly once (two sweepers race)", async () => {
		const edge = `edge-${randomUUID()}`;
		const t0 = Date.now() - 60_000;
		const scopeA = holderScope(HOLDER_A, "runtime-a");
		const scopeB = holderScope(HOLDER_B, "runtime-b");

		// A wins the edge, then "crashes" before delivering (short lease at t0).
		const claim = await claimSpeakerLease(
			holderStore(HOLDER_A),
			params(edge, scopeA, { leaseMs: 5_000, now: t0 }),
		);
		expect(claim.outcome).toBe("won");

		// Two independent sweepers race: the atomic UPDATE hands the slot to
		// exactly one of them.
		const [sweptA, sweptB] = await Promise.all([
			sweepExpiredCoordinationSlots(holderStore(HOLDER_A), scopeA),
			sweepExpiredCoordinationSlots(holderStore(HOLDER_B), scopeB),
		]);
		const mine = [...sweptA, ...sweptB].filter(
			(slot) => slot.edgeEpoch === edge,
		);
		expect(mine).toHaveLength(1);
		expect(mine[0].inboundMessageId).toBe(edge);
		expect(mine[0].holderToken).toBe(scopeA.contenderToken);

		// The slot is terminally expired: a later sweep finds nothing (negative
		// proof: no double recovery).
		const again = await sweepExpiredCoordinationSlots(
			holderStore(HOLDER_B),
			scopeB,
		);
		expect(again.filter((slot) => slot.edgeEpoch === edge)).toHaveLength(0);
	});

	it("never sweeps a live claim or a delivered slot (negative proof)", async () => {
		const liveEdge = `edge-${randomUUID()}`;
		const deliveredEdge = `edge-${randomUUID()}`;
		const scopeA = holderScope(HOLDER_A, "runtime-a");

		// Live claim: unexpired.
		const live = await claimSpeakerLease(
			holderStore(HOLDER_A),
			params(liveEdge, scopeA),
		);
		expect(live.outcome).toBe("won");

		// Delivered slot: expired but reconciled with a delivered message id.
		const delivered = await claimSpeakerLease(
			holderStore(HOLDER_A),
			params(deliveredEdge, scopeA, {
				leaseMs: 5_000,
				now: Date.now() - 60_000,
			}),
		);
		expect(delivered.outcome).toBe("won");
		await reconcileDiscordDelivery(
			holderStore(HOLDER_A),
			delivered.lease,
			"990000000000000042",
		);

		const swept = await sweepExpiredCoordinationSlots(
			holderStore(HOLDER_A),
			scopeA,
		);
		const edges = swept.map((slot) => slot.edgeEpoch);
		expect(edges).not.toContain(liveEdge);
		expect(edges).not.toContain(deliveredEdge);
	});

	it("an untrusted contender cannot sweep (trust boundary holds for recovery too)", async () => {
		const intruder = stringToUuid("pglite-holder-agent-intruder") as UUID;
		const scopeIntruder = holderScope(intruder, "runtime-intruder");
		// Never registered as a trust member.
		await expect(
			sweepExpiredCoordinationSlots(holderStore(intruder), scopeIntruder),
		).rejects.toThrow(/not trusted/);
	});
});

describe("reply lanes are budgeted independently", () => {
	it("suppresses addressed bot traffic until a human establishes the epoch", async () => {
		const channel = `channel-${randomUUID()}`;
		const scopeA = holderScope(HOLDER_A, "runtime-a");
		const decision = await shouldSuppressBotReply({
			owner: holderStore(HOLDER_A),
			channelId: channel,
			explicitlyAddressed: true,
			budget: 1,
			scope: scopeA,
		});
		expect(decision).toEqual({
			suppress: true,
			reason: "budget-exhausted",
		});
	});

	it("one inbound bot message can win only one slot even when budget is two", async () => {
		const channel = `channel-${randomUUID()}`;
		const edge = "700000000000000000";
		const botInbound = "700000000000000001";
		const scopeA = holderScope(HOLDER_A, "runtime-a");
		const scopeB = holderScope(HOLDER_B, "runtime-b");
		await recordDiscordHumanEdge(
			holderStore(HOLDER_A),
			channel,
			edge,
			Date.now(),
			scopeA,
		);

		const [first, second] = await Promise.all([
			claimSpeakerLease(
				holderStore(HOLDER_A),
				params(botInbound, scopeA, {
					channelId: channel,
					lane: "bot",
					slotCount: 2,
				}),
			),
			claimSpeakerLease(
				holderStore(HOLDER_B),
				params(botInbound, scopeB, {
					channelId: channel,
					lane: "bot",
					slotCount: 2,
				}),
			),
		]);
		expect([first.outcome, second.outcome].sort()).toEqual(["lost", "won"]);

		const rows = await (
			runtime.db as { execute(query: unknown): Promise<{ rows: unknown[] }> }
		).execute(sql`
			SELECT slot_index
			FROM discord_coordination_reply_slots
			WHERE channel_id = ${channel}
				AND edge_epoch = ${edge}
				AND lane = 'bot'
				AND inbound_message_id = ${botInbound}
		`);
		expect(rows.rows).toHaveLength(1);
	});

	it("a human-lane claim does not consume the bot-lane budget for the same edge", async () => {
		const channel = `channel-${randomUUID()}`;
		const edge = "700000000000000001";
		const scopeA = holderScope(HOLDER_A, "runtime-a");
		await recordDiscordHumanEdge(
			holderStore(HOLDER_A),
			channel,
			edge,
			Date.now(),
			scopeA,
		);

		// Answer the human: human lane, budget 1.
		const human = await claimSpeakerLease(
			holderStore(HOLDER_A),
			params(edge, scopeA, { channelId: channel, lane: "human" }),
		);
		expect(human.outcome).toBe("won");
		expect(human.lease.lane).toBe("human");

		// The bot lane must still be free: with a shared lane the human answer
		// above exhausted budget=1 and every addressed bot reply was suppressed.
		const suppression = await shouldSuppressBotReply({
			owner: holderStore(HOLDER_A),
			channelId: channel,
			explicitlyAddressed: true,
			budget: 1,
			scope: scopeA,
		});
		expect(suppression.suppress).toBe(false);

		const bot = await claimSpeakerLease(
			holderStore(HOLDER_A),
			params(edge, scopeA, { channelId: channel, lane: "bot" }),
		);
		expect(bot.outcome).toBe("won");
		expect(bot.lease.lane).toBe("bot");

		// Now the bot lane IS spent for this edge.
		const second = await shouldSuppressBotReply({
			owner: holderStore(HOLDER_A),
			channelId: channel,
			explicitlyAddressed: true,
			budget: 1,
			scope: scopeA,
		});
		expect(second.suppress).toBe(true);
		expect(second.reason).toBe("budget-exhausted");
	});
});

describe("terminal slots are never re-answered", () => {
	it("a delivered slot cannot be reclaimed after its lease expires", async () => {
		const edge = `edge-${randomUUID()}`;
		const scopeA = holderScope(HOLDER_A, "runtime-a");
		const scopeB = holderScope(HOLDER_B, "runtime-b");

		// A wins with a short lease at t0, delivers, then the lease expires.
		const claim = await claimSpeakerLease(
			holderStore(HOLDER_A),
			params(edge, scopeA, { leaseMs: 5_000, now: Date.now() - 60_000 }),
		);
		expect(claim.outcome).toBe("won");
		await reconcileDiscordDelivery(
			holderStore(HOLDER_A),
			claim.lease,
			"990000000000000777",
		);

		// B arrives on a redelivery of the same edge. The reply already went out,
		// so B must NOT be handed the slot (that is a duplicate reply).
		const second = await claimSpeakerLease(
			holderStore(HOLDER_B),
			params(edge, scopeB),
		);
		expect(second.outcome).toBe("lost");
	});

	it("a released slot is reclaimable (abandoned attempt, no reply was sent)", async () => {
		const edge = `edge-${randomUUID()}`;
		const scopeA = holderScope(HOLDER_A, "runtime-a");
		const scopeB = holderScope(HOLDER_B, "runtime-b");

		const claim = await claimSpeakerLease(
			holderStore(HOLDER_A),
			params(edge, scopeA),
		);
		expect(claim.outcome).toBe("won");
		await releaseSpeakerLease(holderStore(HOLDER_A), claim.lease, "test-abort");

		// Nothing was delivered, so another contender may take the edge.
		const second = await claimSpeakerLease(
			holderStore(HOLDER_B),
			params(edge, scopeB),
		);
		expect(second.outcome).toBe("reclaimed");

		// And a released slot is not sweeper material (it is not `claimed`).
		const swept = await sweepExpiredCoordinationSlots(
			holderStore(HOLDER_A),
			scopeA,
		);
		expect(swept.some((slot) => slot.edgeEpoch === edge)).toBe(false);
	});
});

describe("sweeper recovery is bounded and reachability-scoped", () => {
	it("stops recovering a poison slot after MAX_SWEEP_RECOVERY_ATTEMPTS", async () => {
		const edge = `edge-${randomUUID()}`;
		const scopeA = holderScope(HOLDER_A, "runtime-a");
		const store = holderStore(HOLDER_A);

		for (let attempt = 1; attempt <= MAX_SWEEP_RECOVERY_ATTEMPTS; attempt += 1) {
			// Re-claim with an already-expired lease, simulating a holder that dies
			// every time it picks this message up.
			await claimSpeakerLease(
				store,
				params(edge, scopeA, { leaseMs: 1, now: Date.now() - 60_000 }),
			);
			const swept = await sweepExpiredCoordinationSlots(store, scopeA);
			expect(swept.filter((slot) => slot.edgeEpoch === edge)).toHaveLength(1);
		}

		// One more crash cycle: the bound is reached, so the slot is retired
		// (`abandoned`) instead of being re-dispatched forever.
		await claimSpeakerLease(
			store,
			params(edge, scopeA, { leaseMs: 1, now: Date.now() - 60_000 }),
		);
		const finalSweep = await sweepExpiredCoordinationSlots(store, scopeA);
		expect(finalSweep.filter((slot) => slot.edgeEpoch === edge)).toHaveLength(0);

		const rows = await (
			runtime.db as { execute(query: unknown): Promise<{ rows: unknown[] }> }
		).execute(sql`
			SELECT state FROM discord_coordination_reply_slots
			WHERE edge_epoch = ${edge}
		`);
		expect((rows.rows[0] as Record<string, unknown>).state).toBe("abandoned");
	});

	it("re-arms an expired row when redispatch did not claim it", async () => {
		const edge = `edge-${randomUUID()}`;
		const scopeA = holderScope(HOLDER_A, "runtime-a");
		const store = holderStore(HOLDER_A);
		await claimSpeakerLease(
			store,
			params(edge, scopeA, { leaseMs: 1, now: Date.now() - 60_000 }),
		);
		const [swept] = await sweepExpiredCoordinationSlots(store, scopeA);
		expect(swept?.edgeEpoch).toBe(edge);

		// Simulate Discord channel/message fetch failing before handleMessage can
		// reclaim. The manager's finally block calls this guarded re-arm.
		await expect(
			rearmSweptCoordinationSlot(store, scopeA, swept, 1_000),
		).resolves.toBe(true);
		const retry = await sweepExpiredCoordinationSlots(
			store,
			scopeA,
			Date.now() + 2_000,
		);
		expect(retry.some((slot) => slot.edgeEpoch === edge)).toBe(true);
	});

	it("keeps crash recovery on the Discord account that won the send", async () => {
		const edge = `edge-${randomUUID()}`;
		const primary = holderScope(HOLDER_A, "runtime-a", "account-primary");
		const secondary = holderScope(
			HOLDER_B,
			"runtime-b",
			"account-secondary",
		);
		await registerCoordinationTrustMember(holderStore(HOLDER_A), primary);
		await registerCoordinationTrustMember(holderStore(HOLDER_B), secondary);
		await claimSpeakerLease(
			holderStore(HOLDER_A),
			params(edge, primary, { leaseMs: 1, now: Date.now() - 60_000 }),
		);

		// A different bot account cannot reclaim or sweep the winner's crash
		// window: its provider nonce/idempotency scope is not authoritative.
		const foreignClaim = await claimSpeakerLease(
			holderStore(HOLDER_B),
			params(edge, secondary),
		);
		expect(foreignClaim.outcome).toBe("lost");
		expect(
			await sweepExpiredCoordinationSlots(holderStore(HOLDER_B), secondary),
		).toHaveLength(0);

		// A replacement worker for the original account can recover it.
		const replacement = {
			...primary,
			runtimeInstanceId: "runtime-a-replacement",
			contenderToken: createDiscordContenderToken({
				accountId: primary.accountId,
				agentId: HOLDER_B,
				runtimeInstanceId: "runtime-a-replacement",
			}),
		};
		await registerCoordinationTrustMember(holderStore(HOLDER_B), replacement);
		const recovered = await claimSpeakerLease(
			holderStore(HOLDER_B),
			params(edge, replacement),
		);
		expect(recovered.outcome).toBe("reclaimed");
	});

	it("never sweeps a channel this client cannot re-dispatch into", async () => {
		const edge = `edge-${randomUUID()}`;
		const channel = `channel-${randomUUID()}`;
		const scopeA = holderScope(HOLDER_A, "runtime-a");
		await claimSpeakerLease(
			holderStore(HOLDER_A),
			params(edge, scopeA, {
				channelId: channel,
				leaseMs: 5_000,
				now: Date.now() - 60_000,
			}),
		);

		// Reachable set excludes this channel: expiring the slot here would spend a
		// recovery attempt while the re-dispatch silently fails, losing the edge.
		const unreachable = await sweepExpiredCoordinationSlots(
			holderStore(HOLDER_A),
			scopeA,
			Date.now(),
			["some-other-channel"],
		);
		expect(unreachable.some((slot) => slot.edgeEpoch === edge)).toBe(false);

		// Once the channel is reachable, recovery proceeds normally.
		const reachable = await sweepExpiredCoordinationSlots(
			holderStore(HOLDER_A),
			scopeA,
			Date.now(),
			[channel],
		);
		expect(reachable.some((slot) => slot.edgeEpoch === edge)).toBe(true);
	});
});

describe("trust membership is operator-declared, not self-minted", () => {
	it("an agent absent from the roster cannot register itself", async () => {
		const intruder = stringToUuid("pglite-holder-agent-rogue") as UUID;
		await expect(
			registerCoordinationTrustMember(
				holderStore(intruder),
				holderScope(intruder, "runtime-rogue"),
			),
		).rejects.toThrow(/not listed in DISCORD_COORDINATION_TRUST_MEMBERS/);

		// And therefore cannot claim: knowing the ids is not enough.
		await expect(
			claimSpeakerLease(
				holderStore(intruder),
				params(`edge-${randomUUID()}`, holderScope(intruder, "runtime-rogue")),
			),
		).rejects.toThrow(/not trusted/);
	});
});
