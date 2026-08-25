/**
 * Unit tests for the PURE parts of the P4 group-room coordination primitive:
 * config parsing, contender-token derivation, deterministic nonce, snowflake
 * ordering, trust-roster parsing, scope validation, and the edge-currency
 * decision function.
 *
 * The stateful protocol (claim races, expiry/reclaim, lane budgets, sweeper
 * recovery, fenced delivery) is covered ONLY against a real plugin-sql adapter
 * in `test/group-coordination-pglite.test.ts` and
 * `test/messages-group-coordination-pglite.test.ts`. It deliberately has no
 * in-process fake store: the previous shared-Map version of these tests passed
 * while `runtime.db` was absent, which proved a fallback code path rather than
 * the durable protocol the feature ships.
 */
import { stringToUuid, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	compareDiscordSnowflake,
	createDiscordContenderToken,
	DEFAULT_BOT_REPLY_BUDGET,
	DEFAULT_SPEAKER_LEASE_MS,
	deterministicCoordinationNonce,
	deterministicDiscordNonce,
	emitCoordinationReceipt,
	evaluateEdgeCurrency,
	getGroupCoordinationConfig,
	parseTrustRoster,
	requireCoordinationScope,
	speakerLeaseId,
} from "../group-coordination.ts";

const CHANNEL = "111000000000000001";
const AGENT_A = stringToUuid("agent-a") as UUID;
const AGENT_B = stringToUuid("agent-b") as UUID;
const SERVER_ID = stringToUuid("coord-server") as UUID;

describe("speakerLeaseId", () => {
	it("is agent-independent, generation-scoped, and lane-scoped", () => {
		expect(speakerLeaseId(CHANNEL, "m1", 0)).not.toBe(
			speakerLeaseId(CHANNEL, "m1", 1),
		);
		expect(speakerLeaseId(CHANNEL, "m1", 0)).not.toBe(
			speakerLeaseId(CHANNEL, "m2", 0),
		);
		// Human and bot reply lanes must never collide on one row id.
		expect(speakerLeaseId(CHANNEL, "m1", 0, "human")).not.toBe(
			speakerLeaseId(CHANNEL, "m1", 0, "bot"),
		);
	});
});

describe("createDiscordContenderToken", () => {
	it("distinguishes two managers that share one agentId", () => {
		const left = createDiscordContenderToken({
			accountId: "default",
			agentId: AGENT_A,
			runtimeInstanceId: "instance-1",
		});
		const right = createDiscordContenderToken({
			accountId: "default",
			agentId: AGENT_A,
			runtimeInstanceId: "instance-2",
		});
		expect(left).not.toBe(right);
	});

	it("distinguishes two accounts on one runtime instance", () => {
		const left = createDiscordContenderToken({
			accountId: "acct-a",
			agentId: AGENT_A,
			runtimeInstanceId: "instance-1",
		});
		const right = createDiscordContenderToken({
			accountId: "acct-b",
			agentId: AGENT_A,
			runtimeInstanceId: "instance-1",
		});
		expect(left).not.toBe(right);
	});
});

describe("deterministicDiscordNonce", () => {
	it("differs per chunk so multi-chunk replies are not collapsed by Discord", () => {
		const base = {
			accountId: "default",
			channelId: CHANNEL,
			authorId: "555",
			edgeMessageId: "m1",
		};
		expect(deterministicDiscordNonce({ ...base, contentKey: "0" })).not.toBe(
			deterministicDiscordNonce({ ...base, contentKey: "1" }),
		);
	});

	it("fits Discord's nonce length limit (<= 25 chars)", () => {
		const nonce = deterministicDiscordNonce({
			accountId: "default",
			channelId: CHANNEL,
			authorId: "555",
			edgeMessageId: "m1",
		});
		expect(nonce.length).toBeLessThanOrEqual(25);
	});
});

describe("deterministicCoordinationNonce", () => {
	it("is independent of contender/runtime identity for crash recovery", () => {
		const sharedLease = {
			serverId: SERVER_ID,
			trustGroupId: "group-1",
			channelId: CHANNEL,
			edgeEpoch: "edge-1",
			lane: "human" as const,
			generation: 0,
		};
		const firstWorker = deterministicCoordinationNonce(sharedLease, "0");
		const recoveredWorker = deterministicCoordinationNonce(
			{ ...sharedLease },
			"0",
		);
		expect(firstWorker).toBe(recoveredWorker);
		expect(firstWorker).toHaveLength(24);
	});

	it("distinguishes budget slots and chunks", () => {
		const lease = {
			serverId: SERVER_ID,
			trustGroupId: "group-1",
			channelId: CHANNEL,
			edgeEpoch: "edge-1",
			lane: "bot" as const,
			generation: 0,
		};
		expect(deterministicCoordinationNonce(lease, "0")).not.toBe(
			deterministicCoordinationNonce({ ...lease, generation: 1 }, "0"),
		);
		expect(deterministicCoordinationNonce(lease, "0")).not.toBe(
			deterministicCoordinationNonce(lease, "1"),
		);
	});
});

describe("compareDiscordSnowflake", () => {
	it("orders snowflakes as integers, not lexically", () => {
		// Lexical comparison gets this backwards: "9..." > "10..." as a string.
		expect(
			compareDiscordSnowflake("10000000000000000", "9999999999999999"),
		).toBe(1);
		expect(
			compareDiscordSnowflake("9999999999999999", "10000000000000000"),
		).toBe(-1);
		expect(compareDiscordSnowflake("123", "123")).toBe(0);
	});

	it("exceeds Number.MAX_SAFE_INTEGER without precision loss", () => {
		// These two differ only in the last digit and are both > 2^53.
		const a = "1400000000000000001";
		const b = "1400000000000000002";
		expect(Number(a) === Number(b)).toBe(true); // float would tie
		expect(compareDiscordSnowflake(a, b)).toBe(-1); // BigInt does not
	});
});

describe("parseTrustRoster", () => {
	it("parses, trims, lowercases, and drops blanks", () => {
		const roster = parseTrustRoster(` ${AGENT_A.toUpperCase()} , ,${AGENT_B} `);
		expect(roster.has(AGENT_A.toLowerCase())).toBe(true);
		expect(roster.has(AGENT_B.toLowerCase())).toBe(true);
		expect(roster.size).toBe(2);
	});

	it("treats missing/empty config as an empty roster (fails closed upstream)", () => {
		expect(parseTrustRoster(undefined).size).toBe(0);
		expect(parseTrustRoster("").size).toBe(0);
		expect(parseTrustRoster("  ,  ").size).toBe(0);
	});
});

describe("requireCoordinationScope", () => {
	function store(settings: Record<string, string>, agentId: UUID = AGENT_A) {
		return { agentId, getSetting: (key: string) => settings[key] };
	}

	const complete = {
		DISCORD_GROUP_COORDINATION_ENABLED: "true",
		DISCORD_GROUP_COORDINATION_SERVER_ID: SERVER_ID,
		DISCORD_GROUP_COORDINATION_TRUST_GROUP_ID: "group-1",
		DISCORD_COORDINATION_TRUST_MEMBERS: `${AGENT_A},${AGENT_B}`,
		ELIZA_RUNTIME_INSTANCE_ID: "instance-1",
	};

	it("builds a scope when fully configured", () => {
		const scope = requireCoordinationScope(store(complete), "default");
		expect(scope.serverId).toBe(SERVER_ID);
		expect(scope.trustGroupId).toBe("group-1");
		expect(scope.runtimeInstanceId).toBe("instance-1");
		expect(scope.contenderToken).toContain(AGENT_A);
	});

	it("refuses when the feature is off", () => {
		expect(() =>
			requireCoordinationScope(
				store({ ...complete, DISCORD_GROUP_COORDINATION_ENABLED: "false" }),
				"default",
			),
		).toThrow(/not enabled/);
	});

	it("refuses without a server/trust-group id", () => {
		const { DISCORD_GROUP_COORDINATION_SERVER_ID: _drop, ...rest } = complete;
		expect(() => requireCoordinationScope(store(rest), "default")).toThrow(
			/SERVER_ID/,
		);
	});

	it("refuses without an explicit operator trust roster", () => {
		const { DISCORD_COORDINATION_TRUST_MEMBERS: _drop, ...rest } = complete;
		expect(() => requireCoordinationScope(store(rest), "default")).toThrow(
			/TRUST_MEMBERS/,
		);
	});

	it("refuses an agent that is not on the roster (trust is not self-minted)", () => {
		const intruder = stringToUuid("agent-intruder") as UUID;
		expect(() =>
			requireCoordinationScope(store(complete, intruder), "default"),
		).toThrow(/not listed in DISCORD_COORDINATION_TRUST_MEMBERS/);
	});
});

describe("evaluateEdgeCurrency", () => {
	// The persisted-edge lookup is covered on the PGlite path; here the decision
	// function is exercised against an explicit latest-edge reading.
	const scope = {
		accountId: "default",
		serverId: SERVER_ID,
		trustGroupId: "group-1",
		contenderToken: "token",
		runtimeInstanceId: "instance-1",
	};

	function ownerWithEdge(edgeMessageId: string) {
		return {
			agentId: AGENT_A,
			db: {
				execute: async () => ({
					rows: [
						{
							edge_message_id: edgeMessageId,
							edge_epoch: edgeMessageId,
							updated_at: new Date(),
						},
					],
				}),
			},
		};
	}

	it("is current when the edge is this message", async () => {
		const decision = await evaluateEdgeCurrency({
			owner: ownerWithEdge("m5"),
			channelId: CHANNEL,
			edgeMessageId: "m5",
			scope,
		});
		expect(decision.current).toBe(true);
	});

	it("is stale when a newer human message set the edge", async () => {
		const decision = await evaluateEdgeCurrency({
			owner: ownerWithEdge("m9"),
			channelId: CHANNEL,
			edgeMessageId: "m5",
			scope,
		});
		expect(decision.current).toBe(false);
		expect(decision.latestEdgeMessageId).toBe("m9");
	});

	it("stays current when the coalesced batch contains the latest edge", async () => {
		const decision = await evaluateEdgeCurrency({
			owner: ownerWithEdge("m9"),
			channelId: CHANNEL,
			edgeMessageId: "m5",
			coalescedMessageIds: ["m5", "m9"],
			scope,
		});
		expect(decision.current).toBe(true);
	});

	it("never drops explicitly addressed work even when superseded", async () => {
		const decision = await evaluateEdgeCurrency({
			owner: ownerWithEdge("m9"),
			channelId: CHANNEL,
			edgeMessageId: "m5",
			explicitlyAddressed: true,
			scope,
		});
		expect(decision.current).toBe(true);
	});
});

describe("coordination audit failures", () => {
	it("reports receipt storage failure through the J7 audit scope", async () => {
		const reportError = vi.fn();
		const writeFailure = new Error("audit database unavailable");
		const ok = await emitCoordinationReceipt(
			{
				agentId: AGENT_A,
				reportError,
				db: { execute: vi.fn(async () => Promise.reject(writeFailure)) },
			},
			{
				kind: "lease-claim",
				channelId: CHANNEL,
				edgeMessageId: "m1",
				roomId: stringToUuid("audit-room") as UUID,
				entityId: stringToUuid("audit-entity") as UUID,
				outcome: "won",
				scope: {
					accountId: "default",
					serverId: SERVER_ID,
					trustGroupId: "group-1",
					contenderToken: "token-a",
					runtimeInstanceId: "instance-1",
				},
			},
		);

		expect(ok).toBe(false);
		expect(reportError).toHaveBeenCalledWith(
			"discord:coordination.audit",
			writeFailure,
			expect.objectContaining({
				kind: "lease-claim",
				channelId: CHANNEL,
				edgeMessageId: "m1",
			}),
		);
	});
});

describe("getGroupCoordinationConfig", () => {
	it("defaults off with sane lease/budget values", () => {
		const config = getGroupCoordinationConfig(() => undefined);
		expect(config.enabled).toBe(false);
		expect(config.leaseMs).toBeGreaterThan(120_000);
		expect(config.botReplyBudget).toBe(1);
	});

	it("parses explicit settings", () => {
		const settings: Record<string, string> = {
			DISCORD_GROUP_COORDINATION_ENABLED: "true",
			DISCORD_SPEAKER_LEASE_MS: "30000",
			DISCORD_BOT_REPLY_BUDGET: "2",
		};
		const config = getGroupCoordinationConfig((key) => settings[key]);
		expect(config).toEqual({
			enabled: true,
			leaseMs: 30_000,
			botReplyBudget: 2,
			heartbeatMs: 30_000,
			sweepMs: 60_000,
			serverId: undefined,
			trustGroupId: undefined,
		});
	});

	it("sweeper interval is configurable and can be disabled with 0", () => {
		const onSettings: Record<string, string> = {
			DISCORD_COORDINATION_SWEEP_MS: "15000",
		};
		expect(getGroupCoordinationConfig((key) => onSettings[key]).sweepMs).toBe(
			15_000,
		);
		const offSettings: Record<string, string> = {
			DISCORD_COORDINATION_SWEEP_MS: "0",
		};
		expect(getGroupCoordinationConfig((key) => offSettings[key]).sweepMs).toBe(
			0,
		);
	});
});

describe("group coordination config parsing", () => {
	function settings(values: Record<string, string>) {
		return (key: string) => values[key];
	}

	it("ignores trailing-garbage lease and budget values", () => {
		// parseInt("3junk") is 3, so a malformed setting silently installed a
		// 3ms speaker lease and a 3-reply bot budget.
		const config = getGroupCoordinationConfig(
			settings({
				DISCORD_SPEAKER_LEASE_MS: "3junk",
				DISCORD_BOT_REPLY_BUDGET: "3junk",
			}),
		);
		expect(config.leaseMs).toBe(DEFAULT_SPEAKER_LEASE_MS);
		expect(config.botReplyBudget).toBe(DEFAULT_BOT_REPLY_BUDGET);
	});

	it("keeps signed values and rejects ones past the safe range", () => {
		// `Number.parseInt` accepted "+5000"; rejecting it would be a regression.
		const signed = getGroupCoordinationConfig(
			settings({ DISCORD_SPEAKER_LEASE_MS: "+5000" }),
		);
		expect(signed.leaseMs).toBe(5000);
		const unsafe = getGroupCoordinationConfig(
			settings({ DISCORD_SPEAKER_LEASE_MS: "9007199254740993" }),
		);
		expect(unsafe.leaseMs).toBe(DEFAULT_SPEAKER_LEASE_MS);
	});

	it("still honours clean lease and budget values", () => {
		const config = getGroupCoordinationConfig(
			settings({
				DISCORD_SPEAKER_LEASE_MS: "5000",
				DISCORD_BOT_REPLY_BUDGET: "0",
			}),
		);
		expect(config.leaseMs).toBe(5000);
		expect(config.botReplyBudget).toBe(0);
	});
});
