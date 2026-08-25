/**
 * Tests for the provider-neutral group installation lifecycle state machine
 * (installation-lifecycle.ts), the connector contribution contract
 * (installation-contribution.ts), and the in-memory host service
 * (installation-service.ts). Deterministic unit harness: no runtime, no
 * network, no provider credentials — the reducer is pure and the host is
 * in-memory. The round-1 review regressions (epoch fencing, claim-secret
 * verification, owner-gated readiness, generation CAS) are the last two
 * describe blocks.
 */
import { describe, expect, it } from "vitest";
import { stringToUuid } from "../utils";
import {
	type ConnectorInstallationContribution,
	validateInstallationContribution,
} from "./installation-contribution";
import {
	applyInstallationTransition,
	INSTALLATION_LIFECYCLE_CONTRACT_VERSION,
	type InstallationScope,
	type InstallationTransitionEvent,
	isStaleAgainstRemoval,
	recreateInstallationAfterRemoval,
} from "./installation-lifecycle";
import { InstallationLifecycleService } from "./installation-service";

const agentId = stringToUuid("agent") as InstallationScope["agentId"];
const connectorAccountId = stringToUuid(
	"account",
) as InstallationScope["connectorAccountId"];
const scope: InstallationScope = {
	agentId,
	connectorId: "discord",
	connectorAccountId,
	externalWorldId: "123456789012345678",
};

const OBSERVED_AT = "2026-08-25T12:00:00Z";

function event(
	transition: InstallationTransitionEvent["transition"],
	observedGeneration = 99,
	observedAt = OBSERVED_AT,
	idempotencyKey = `key-${Math.random()}`,
	reinstallVersion = 1,
): InstallationTransitionEvent {
	return {
		contractVersion: INSTALLATION_LIFECYCLE_CONTRACT_VERSION,
		scope,
		reinstallVersion,
		observedGeneration,
		observedAt,
		idempotencyKey,
		transition,
	};
}

/** Next event for a live record: observes the record's exact generation. */
function next(
	record: { generation: number; reinstallVersion: number } | null,
	transition: InstallationTransitionEvent["transition"],
	observedAt = OBSERVED_AT,
	idempotencyKey = `key-${Math.random()}`,
): InstallationTransitionEvent {
	return event(
		transition,
		record?.generation ?? 1,
		observedAt,
		idempotencyKey,
		record?.reinstallVersion ?? 1,
	);
}

function driveToReady(observedAt = OBSERVED_AT) {
	let record = applyInstallationTransition(
		null,
		event({ kind: "invite_created" }, 1, observedAt),
	).record;
	record = applyInstallationTransition(
		record,
		next(
			record,
			{ kind: "provider_authorized", evidence: "connector_observed" },
			observedAt,
		),
	).record;
	record = applyInstallationTransition(
		record,
		next(
			record,
			{ kind: "agent_joined", worldId: stringToUuid("world") },
			observedAt,
		),
	).record;
	record = applyInstallationTransition(
		record,
		next(
			record,
			{
				kind: "permissions_verifying",
				requiredCapabilities: ["receive", "send"],
				optionalCapabilities: ["threads"],
			},
			observedAt,
		),
	).record;
	// Prove capabilities while still in permissions_verifying: readiness
	// recompute is owner-claim-gated, so the record stays verifying until the
	// claim is redeemed (round-1 ordering).
	record = applyInstallationTransition(
		record,
		next(
			record,
			{
				kind: "capability_proof",
				capability: "receive",
				required: true,
				proof: { permissions: 2048 },
				verifiedAt: observedAt,
			},
			observedAt,
		),
	).record;
	record = applyInstallationTransition(
		record,
		next(
			record,
			{
				kind: "capability_proof",
				capability: "send",
				required: true,
				proof: { permissions: 2048 },
				verifiedAt: observedAt,
			},
			observedAt,
		),
	).record;
	record = applyInstallationTransition(
		record,
		next(
			record,
			{
				kind: "owner_claim_issued",
				claimId: "c1",
				claimSecretHash: "h",
				expiresAt: "2026-08-25T13:00:00Z",
			},
			observedAt,
		),
	).record;
	record = applyInstallationTransition(
		record,
		next(
			record,
			{
				kind: "owner_claim_redeemed",
				claimId: "c1",
				claimSecretHash: "h",
				claimedByEntityId: stringToUuid("owner"),
			},
			observedAt,
		),
	).record;
	return record;
}

describe("installation lifecycle state machine", () => {
	it("creates the initial record from invite_created", () => {
		const receipt = applyInstallationTransition(
			null,
			event({ kind: "invite_created", externalGroupLabel: "Test Guild" }, 1),
		);
		expect(receipt.accepted).toBe(true);
		expect(receipt.record.state).toBe("invite_created");
		expect(receipt.record.reinstallVersion).toBe(1);
		expect(receipt.record.generation).toBe(1);
		expect(receipt.record.externalGroupLabel).toBe("Test Guild");
		// installationId is derived from the full scope tuple, not the raw
		// snowflake (round-1 F14).
		expect(receipt.record.installationId).toBe(
			stringToUuid("discord:" + connectorAccountId + ":123456789012345678"),
		);
	});

	it("refuses any first transition other than invite_created with a typed throw", () => {
		expect(() =>
			applyInstallationTransition(
				null,
				event(
					{ kind: "provider_authorized", evidence: "connector_observed" },
					1,
				),
			),
		).toThrowError(/invite_created must come first/);
	});

	it("walks the happy path to ready", () => {
		const record = driveToReady();
		expect(record.state).toBe("ready");
		expect(record.worldId).not.toBeNull();
		expect(record.ownerClaim?.claimedByEntityId).not.toBeNull();
		expect(record.generation).toBe(8);
	});

	it("cannot reach ready without every required capability proof", () => {
		let record = applyInstallationTransition(
			null,
			event({ kind: "invite_created" }, 1),
		).record;
		record = applyInstallationTransition(
			record,
			next(record, {
				kind: "provider_authorized",
				evidence: "connector_observed",
			}),
		).record;
		record = applyInstallationTransition(
			record,
			next(record, { kind: "agent_joined", worldId: stringToUuid("w") }),
		).record;
		record = applyInstallationTransition(
			record,
			next(record, {
				kind: "permissions_verifying",
				requiredCapabilities: ["receive", "send"],
				optionalCapabilities: [],
			}),
		).record;
		record = applyInstallationTransition(
			record,
			next(record, {
				kind: "capability_proof",
				capability: "receive",
				required: true,
				proof: {},
				verifiedAt: OBSERVED_AT,
			}),
		).record;
		expect(record.state).not.toBe("ready");
		expect(record.state).toBe("permissions_verifying");
	});

	it("fences stale events (stale-event resurrection guard)", () => {
		const record = driveToReady();
		const stale = applyInstallationTransition(
			record,
			event({ kind: "removal", reason: "uninstalled" }, record.generation - 1),
		);
		expect(stale.accepted).toBe(false);
		expect(stale.rejection?.code).toBe("STALE_GENERATION");
		expect(stale.record.state).toBe("ready");
	});

	it("rejects events observed AHEAD of the live generation (round-1 CAS guard)", () => {
		const record = driveToReady();
		const ahead = applyInstallationTransition(
			record,
			event({ kind: "removal", reason: "uninstalled" }, record.generation + 5),
		);
		expect(ahead.accepted).toBe(false);
		expect(ahead.rejection?.code).toBe("STALE_GENERATION");
		expect(ahead.record.state).toBe("ready");
	});

	it("isStaleAgainstRemoval fences events observed before removal", () => {
		const record = driveToReady();
		const removed = applyInstallationTransition(
			record,
			next(
				record,
				{ kind: "removal", reason: "kicked" },
				"2026-08-25T14:00:00Z",
			),
		);
		expect(removed.record.state).toBe("removed");
		expect(isStaleAgainstRemoval(removed.record, "2026-08-25T13:59:59Z")).toBe(
			true,
		);
		expect(isStaleAgainstRemoval(removed.record, "2026-08-25T14:00:01Z")).toBe(
			false,
		);
	});

	it("removal clears the owner claim and capability readiness", () => {
		const record = driveToReady();
		const removed = applyInstallationTransition(
			record,
			next(
				record,
				{ kind: "removal", reason: "uninstalled" },
				"2026-08-25T14:00:00Z",
			),
		);
		expect(removed.record.ownerClaim).toBeNull();
		expect(removed.record.capabilityReadiness).toEqual([]);
		expect(removed.record.removedAt).toBe("2026-08-25T14:00:00Z");
	});

	it("revoked_by_owner maps to the revoked terminal state", () => {
		const record = driveToReady();
		const revoked = applyInstallationTransition(
			record,
			next(
				record,
				{ kind: "removal", reason: "revoked_by_owner" },
				"2026-08-25T14:00:00Z",
			),
		);
		expect(revoked.record.state).toBe("revoked");
	});

	it("recreation bumps reinstallVersion and resets generation; requires terminal state", () => {
		const record = driveToReady();
		const notTerminal = recreateInstallationAfterRemoval(
			record,
			event({ kind: "invite_created" }, 99),
		);
		expect(notTerminal.accepted).toBe(false);

		const removed = applyInstallationTransition(
			record,
			next(
				record,
				{ kind: "removal", reason: "uninstalled" },
				"2026-08-25T14:00:00Z",
			),
		).record;
		const recreated = recreateInstallationAfterRemoval(
			removed,
			event({ kind: "invite_created" }, 99, "2026-08-25T15:00:00Z"),
		);
		expect(recreated.accepted).toBe(true);
		expect(recreated.record.reinstallVersion).toBe(2);
		expect(recreated.record.generation).toBe(1);
		expect(recreated.record.state).toBe("invite_created");
		expect(recreated.record.removedAt).toBeNull();
	});

	it("owner claim is single-use and expires", () => {
		const record = driveToReady();
		// From ready, a second redeem is not even a legal edge.
		const second = applyInstallationTransition(
			record,
			next(record, {
				kind: "owner_claim_redeemed",
				claimId: "c1",
				claimSecretHash: "h",
				claimedByEntityId: stringToUuid("other"),
			}),
		);
		expect(second.accepted).toBe(false);

		// fresh record driven only to owner_claim_pending: double redeem hits CLAIM_MISMATCH
		let pending = applyInstallationTransition(
			null,
			event({ kind: "invite_created" }, 1),
		).record;
		pending = applyInstallationTransition(
			pending,
			next(pending, {
				kind: "provider_authorized",
				evidence: "connector_observed",
			}),
		).record;
		pending = applyInstallationTransition(
			pending,
			next(pending, { kind: "agent_joined", worldId: stringToUuid("w") }),
		).record;
		pending = applyInstallationTransition(
			pending,
			next(pending, {
				kind: "permissions_verifying",
				requiredCapabilities: [],
				optionalCapabilities: [],
			}),
		).record;
		pending = applyInstallationTransition(
			pending,
			next(pending, {
				kind: "owner_claim_issued",
				claimId: "c2",
				claimSecretHash: "h",
				expiresAt: "2026-08-25T13:00:00Z",
			}),
		).record;
		const first = applyInstallationTransition(
			pending,
			next(
				pending,
				{
					kind: "owner_claim_redeemed",
					claimId: "c2",
					claimSecretHash: "h",
					claimedByEntityId: stringToUuid("owner"),
				},
				"2026-08-25T12:01:00Z",
			),
		);
		expect(first.accepted).toBe(true);
		const replay = applyInstallationTransition(
			first.record,
			next(
				first.record,
				{
					kind: "owner_claim_redeemed",
					claimId: "c2",
					claimSecretHash: "h",
					claimedByEntityId: stringToUuid("attacker"),
				},
				"2026-08-25T12:02:00Z",
			),
		);
		expect(replay.accepted).toBe(false);
		expect(replay.rejection?.code).toBe("CLAIM_MISMATCH");

		// expired claim
		let fresh = applyInstallationTransition(
			null,
			event({ kind: "invite_created" }, 1),
		).record;
		fresh = applyInstallationTransition(
			fresh,
			next(fresh, {
				kind: "provider_authorized",
				evidence: "connector_observed",
			}),
		).record;
		fresh = applyInstallationTransition(
			fresh,
			next(fresh, { kind: "agent_joined", worldId: stringToUuid("w") }),
		).record;
		fresh = applyInstallationTransition(
			fresh,
			next(fresh, {
				kind: "permissions_verifying",
				requiredCapabilities: [],
				optionalCapabilities: [],
			}),
		).record;
		fresh = applyInstallationTransition(
			fresh,
			next(fresh, {
				kind: "owner_claim_issued",
				claimId: "c3",
				claimSecretHash: "h",
				expiresAt: "2026-08-25T12:30:00Z",
			}),
		).record;
		const expired = applyInstallationTransition(
			fresh,
			next(
				fresh,
				{
					kind: "owner_claim_redeemed",
					claimId: "c3",
					claimSecretHash: "h",
					claimedByEntityId: stringToUuid("owner"),
				},
				"2026-08-25T12:31:00Z",
			),
		);
		expect(expired.accepted).toBe(false);
		expect(expired.rejection?.code).toBe("CLAIM_EXPIRED");
	});

	it("degrades on capability loss and recovers via restored proof", () => {
		const record = driveToReady();
		const degraded = applyInstallationTransition(
			record,
			next(record, {
				kind: "capability_degraded",
				capability: "send",
				reason: "permission lost",
			}),
		);
		expect(degraded.record.state).toBe("degraded");
		const restored = applyInstallationTransition(
			degraded.record,
			next(degraded.record, {
				kind: "capability_restored",
				capability: "send",
				proof: { permissions: 2048 },
			}),
		);
		expect(restored.record.state).toBe("ready");
	});

	it("invalid transitions are rejected with INVALID_TRANSITION", () => {
		const record = applyInstallationTransition(
			null,
			event({ kind: "invite_created" }, 1),
		).record;
		const bad = applyInstallationTransition(
			record,
			next(record, { kind: "agent_joined", worldId: stringToUuid("w") }),
		);
		expect(bad.accepted).toBe(false);
		expect(bad.rejection?.code).toBe("INVALID_TRANSITION");
	});

	it("scope mismatch is rejected (tenant binding)", () => {
		const record = driveToReady();
		const foreign: InstallationTransitionEvent = {
			...next(record, { kind: "removal", reason: "uninstalled" }),
			scope: { ...scope, externalWorldId: "999999999999999999" },
		};
		const receipt = applyInstallationTransition(record, foreign);
		expect(receipt.accepted).toBe(false);
		expect(receipt.rejection?.code).toBe("NO_INSTALLATION");
	});

	it("contract version mismatch is rejected", () => {
		const record = driveToReady();
		const receipt = applyInstallationTransition(record, {
			...next(record, { kind: "removal", reason: "uninstalled" }),
			contractVersion:
				999 as unknown as typeof INSTALLATION_LIFECYCLE_CONTRACT_VERSION,
		});
		expect(receipt.accepted).toBe(false);
		expect(receipt.rejection?.code).toBe("CONTRACT_VERSION_MISMATCH");
	});
});

describe("connector installation contribution contract", () => {
	const valid: ConnectorInstallationContribution = {
		contributionVersion: 1,
		connectorId: "discord",
		groupTypes: ["server"],
		scopeRequirements: [
			{
				providerScopeId: "VIEW_CHANNEL",
				capability: "receive",
				required: true,
			},
			{ providerScopeId: "SEND_MESSAGES", capability: "send", required: true },
		],
		activation: {
			kind: "oauth_install_url",
			installUrl: "https://discord.com/oauth2/authorize?...",
			steps: [{ instruction: "Open the invite link and pick your server" }],
		},
		normalizeEvent: (e) =>
			(e as { kind?: string }).kind === "joined"
				? {
						ok: true,
						transition: { kind: "agent_joined", worldId: stringToUuid("w") },
						observedGeneration: 1,
						observedAt: "2026-08-25T12:00:00Z",
						idempotencyKey: "evt-1",
					}
				: { ok: false, reason: "unknown event shape" },
		describeReadiness: (readiness) => ({ proven: readiness.length }),
	};

	it("accepts a well-formed contribution", () => {
		expect(validateInstallationContribution(valid)).toEqual([]);
	});

	it("rejects oauth activation without installUrl", () => {
		const broken: ConnectorInstallationContribution = {
			...valid,
			activation: {
				...valid.activation,
				kind: "oauth_install_url",
				installUrl: undefined,
			},
		};
		const problems = validateInstallationContribution(broken);
		expect(problems.some((p) => p.includes("installUrl"))).toBe(true);
	});

	it("rejects empty activation steps (truthful activation rule)", () => {
		const broken: ConnectorInstallationContribution = {
			...valid,
			activation: { ...valid.activation, steps: [] },
		};
		expect(validateInstallationContribution(broken).length).toBeGreaterThan(0);
	});

	it("rejects wrong contribution version", () => {
		const broken = { ...valid, contributionVersion: 2 as 1 };
		expect(validateInstallationContribution(broken).length).toBeGreaterThan(0);
	});
});

describe("InstallationLifecycleService (in-memory host)", () => {
	it("applies events idempotently by idempotency key", () => {
		const service = new InstallationLifecycleService();
		const first = service.apply(
			event({ kind: "invite_created" }, 1, OBSERVED_AT, "evt-invite"),
		);
		expect(first.accepted).toBe(true);
		expect(first.idempotentReplay).toBe(false);
		const replay = service.apply(
			event({ kind: "invite_created" }, 1, OBSERVED_AT, "evt-invite"),
		);
		expect(replay.idempotentReplay).toBe(true);
		// replay did not advance generation
		expect(replay.record.generation).toBe(first.record.generation);
	});

	it("readyForTraffic gates on the ready state only", () => {
		const service = new InstallationLifecycleService();
		expect(service.readyForTraffic(scope)).toBe(false);
		service.apply(event({ kind: "invite_created" }, 1, OBSERVED_AT, "e1"));
		expect(service.readyForTraffic(scope)).toBe(false);
		let record = service.get(scope);
		record = service.apply(
			next(
				record,
				{ kind: "provider_authorized", evidence: "connector_observed" },
				OBSERVED_AT,
				"e2",
			),
		).record;
		record = service.apply(
			next(
				record,
				{ kind: "agent_joined", worldId: stringToUuid("w") },
				OBSERVED_AT,
				"e3",
			),
		).record;
		record = service.apply(
			next(
				record,
				{
					kind: "permissions_verifying",
					requiredCapabilities: [],
					optionalCapabilities: [],
				},
				OBSERVED_AT,
				"e4",
			),
		).record;
		expect(service.readyForTraffic(scope)).toBe(false);
		expect(record.state).toBe("permissions_verifying");
	});

	it("registers and serves contributions; rejects malformed ones", () => {
		const service = new InstallationLifecycleService();
		const good: ConnectorInstallationContribution = {
			contributionVersion: 1,
			connectorId: "discord",
			groupTypes: ["server"],
			scopeRequirements: [],
			activation: {
				kind: "manual_admin_steps",
				steps: [{ instruction: "Add the bot manually" }],
			},
			normalizeEvent: () => ({ ok: false, reason: "none" }),
			describeReadiness: () => ({}),
		};
		service.registerContribution(good);
		expect(service.getContribution("discord")?.connectorId).toBe("discord");
		expect(service.listConnectorIds()).toEqual(["discord"]);
		const bad = { ...good, connectorId: "" };
		expect(() => service.registerContribution(bad)).toThrowError(
			/Invalid installation contribution/,
		);
	});

	it("re-creates a removed installation through the service (reinstall versioning)", () => {
		const service = new InstallationLifecycleService();
		service.apply(event({ kind: "invite_created" }, 1, OBSERVED_AT, "e1"));
		service.apply(
			event({ kind: "removal", reason: "uninstalled" }, 1, OBSERVED_AT, "e2"),
		);
		const record = service.get(scope);
		expect(record?.state).toBe("removed");
		const recreated = service.apply(
			event({ kind: "invite_created" }, 1, "2026-08-25T13:00:00Z", "e3"),
		);
		expect(recreated.accepted).toBe(true);
		expect(recreated.record.reinstallVersion).toBe(2);
		expect(service.get(scope)?.reinstallVersion).toBe(2);
	});
});

// ── Round-1 review regressions (2026-08-25) ─────────────────────────────────

describe("round-1: epoch fencing and cross-epoch idempotency", () => {
	it("rejects an old-epoch event whose generation fits the recreated record", () => {
		const service = new InstallationLifecycleService();
		const ready = (() => {
			let r = service.apply(
				event({ kind: "invite_created" }, 1, OBSERVED_AT, "r1"),
			).record;
			for (const [key, transition] of [
				["r2", { kind: "provider_authorized", evidence: "connector_observed" }],
				["r3", { kind: "agent_joined", worldId: stringToUuid("w") }],
			] as const) {
				r = service.apply(next(r, transition, OBSERVED_AT, key)).record;
			}
			return r;
		})();
		expect(ready.state).toBe("agent_joined");
		// Remove at the live generation.
		const removed = service.apply(
			next(ready, { kind: "removal", reason: "kicked" }, OBSERVED_AT, "rm"),
		);
		expect(removed.accepted).toBe(true);
		// Re-create at epoch 2 (generation resets to 1).
		const recreated = service.apply(
			event({ kind: "invite_created" }, 1, OBSERVED_AT, "re", 2),
		);
		expect(recreated.accepted).toBe(true);
		expect(recreated.record.reinstallVersion).toBe(2);
		// Old-epoch event with generation 1 (== recreated generation) must be
		// fenced by the EPOCH, not accepted.
		const stale = service.apply(
			event(
				{ kind: "provider_authorized", evidence: "connector_observed" },
				1,
				OBSERVED_AT,
				"stale",
				1,
			),
		);
		expect(stale.accepted).toBe(false);
		expect(stale.rejection?.code).toBe("STALE_EPOCH");
	});

	it("a second removal after reinstall lands on the new record, not a cached receipt", () => {
		const service = new InstallationLifecycleService();
		let r = service.apply(
			event({ kind: "invite_created" }, 1, OBSERVED_AT, "m1"),
		).record;
		r = service.apply(
			next(
				r,
				{ kind: "provider_authorized", evidence: "connector_observed" },
				OBSERVED_AT,
				"m2",
			),
		).record;
		const removed1 = service.apply(
			next(r, { kind: "removal", reason: "kicked" }, OBSERVED_AT, "rm1"),
		);
		expect(removed1.accepted).toBe(true);
		const recreated = service.apply(
			event({ kind: "invite_created" }, 1, OBSERVED_AT, "re", 2),
		);
		expect(recreated.accepted).toBe(true);
		const secondRemoval = service.apply(
			event({ kind: "removal", reason: "kicked" }, 1, OBSERVED_AT, "rm2", 2),
		);
		expect(secondRemoval.accepted).toBe(true);
		expect(secondRemoval.idempotentReplay).toBe(false);
		expect(secondRemoval.record.state).toBe("removed");
		expect(secondRemoval.record.reinstallVersion).toBe(2);
	});
});

describe("round-1: owner-claim gating and secret verification", () => {
	function driveToPending(service: InstallationLifecycleService) {
		let r = service.apply(
			event({ kind: "invite_created" }, 1, OBSERVED_AT, "p1"),
		).record;
		r = service.apply(
			next(
				r,
				{ kind: "provider_authorized", evidence: "connector_observed" },
				OBSERVED_AT,
				"p2",
			),
		).record;
		r = service.apply(
			next(
				r,
				{ kind: "agent_joined", worldId: stringToUuid("w") },
				OBSERVED_AT,
				"p3",
			),
		).record;
		r = service.apply(
			next(
				r,
				{
					kind: "permissions_verifying",
					requiredCapabilities: ["receive"],
					optionalCapabilities: [],
				},
				OBSERVED_AT,
				"p4",
			),
		).record;
		r = service.apply(
			next(
				r,
				{
					kind: "owner_claim_issued",
					claimId: "cc",
					claimSecretHash: "correct-hash",
					expiresAt: "2026-08-25T13:00:00Z",
				},
				OBSERVED_AT,
				"p5",
			),
		).record;
		return r;
	}

	it("capabilities alone never reach ready while the claim is unredeemed", () => {
		const service = new InstallationLifecycleService();
		let r = driveToPending(service);
		r = service.apply(
			next(
				r,
				{
					kind: "capability_proof",
					capability: "receive",
					required: true,
					proof: { ok: true },
					verifiedAt: OBSERVED_AT,
				},
				OBSERVED_AT,
				"p6",
			),
		).record;
		expect(r.state).toBe("owner_claim_pending");
		expect(r.ownerClaim?.claimedByEntityId).toBeNull();
	});

	it("redeeming with the wrong secret burns an attempt and never claims", () => {
		const service = new InstallationLifecycleService();
		const pending = driveToPending(service);
		const wrong = service.apply(
			next(
				pending,
				{
					kind: "owner_claim_redeemed",
					claimId: "cc",
					claimSecretHash: "definitely-wrong",
					claimedByEntityId: stringToUuid("attacker"),
				},
				OBSERVED_AT,
				"pw",
			),
		);
		expect(wrong.accepted).toBe(false);
		expect(wrong.rejection?.code).toBe("CLAIM_SECRET_MISMATCH");
		// The rejected transition's would-be record carries the burned attempt
		// (attemptsRemaining 4); the service's stored record stays untouched
		// because a rejected event never lands.
		expect(wrong.record.ownerClaim?.attemptsRemaining).toBe(4);
		expect(service.get(scope)?.ownerClaim?.claimedByEntityId).toBeNull();
	});

	it("redeeming with the right secret claims and re-evaluates readiness (late redemption)", () => {
		const service = new InstallationLifecycleService();
		// Prove the required capability while still in permissions_verifying
		// (readiness is claim-gated, so the record cannot go ready yet).
		let r = service.apply(
			event({ kind: "invite_created" }, 1, OBSERVED_AT, "q1"),
		).record;
		r = service.apply(
			next(
				r,
				{ kind: "provider_authorized", evidence: "connector_observed" },
				OBSERVED_AT,
				"q2",
			),
		).record;
		r = service.apply(
			next(
				r,
				{ kind: "agent_joined", worldId: stringToUuid("w") },
				OBSERVED_AT,
				"q3",
			),
		).record;
		r = service.apply(
			next(
				r,
				{
					kind: "permissions_verifying",
					requiredCapabilities: ["receive"],
					optionalCapabilities: [],
				},
				OBSERVED_AT,
				"q4",
			),
		).record;
		r = service.apply(
			next(
				r,
				{
					kind: "capability_proof",
					capability: "receive",
					required: true,
					proof: { ok: true },
					verifiedAt: OBSERVED_AT,
				},
				OBSERVED_AT,
				"q5",
			),
		).record;
		expect(r.state).toBe("permissions_verifying");
		r = service.apply(
			next(
				r,
				{
					kind: "owner_claim_issued",
					claimId: "cc",
					claimSecretHash: "correct-hash",
					expiresAt: "2026-08-25T13:00:00Z",
				},
				OBSERVED_AT,
				"q6",
			),
		).record;
		expect(r.state).toBe("owner_claim_pending");
		const ok = service.apply(
			next(
				r,
				{
					kind: "owner_claim_redeemed",
					claimId: "cc",
					claimSecretHash: "correct-hash",
					claimedByEntityId: stringToUuid("owner"),
				},
				OBSERVED_AT,
				"q7",
			),
		);
		expect(ok.accepted).toBe(true);
		expect(service.get(scope)?.state).toBe("ready");
		expect(service.get(scope)?.ownerClaim?.claimedByEntityId).toBe(
			stringToUuid("owner"),
		);
	});

	it("a malformed observedAt timestamp rejects instead of NaN-comparing open", () => {
		const service = new InstallationLifecycleService();
		const pending = driveToPending(service);
		const bad = service.apply(
			next(
				pending,
				{
					kind: "owner_claim_redeemed",
					claimId: "cc",
					claimSecretHash: "correct-hash",
					claimedByEntityId: stringToUuid("owner"),
				},
				"not-a-date",
				"pn",
			),
		);
		expect(bad.accepted).toBe(false);
		expect(bad.rejection?.code).toBe("CLAIM_EXPIRED");
	});

	it("records connector_observed authorization evidence distinctly on the record", () => {
		const service = new InstallationLifecycleService();
		let r = service.apply(
			event({ kind: "invite_created" }, 1, OBSERVED_AT, "ev1"),
		).record;
		r = service.apply(
			next(
				r,
				{ kind: "provider_authorized", evidence: "connector_observed" },
				OBSERVED_AT,
				"ev2",
			),
		).record;
		expect(r.providerAuthorizationEvidence).toBe("connector_observed");
	});
});

describe("round-1: service input guards", () => {
	it("rejects an empty idempotency key outright", () => {
		const service = new InstallationLifecycleService();
		expect(() =>
			service.apply(event({ kind: "invite_created" }, 1, OBSERVED_AT, "  ")),
		).toThrowError(/non-empty/i);
	});

	it("rejects record creation under a foreign contract version", () => {
		const service = new InstallationLifecycleService();
		const foreign = {
			...event({ kind: "invite_created" }, 1, OBSERVED_AT, "fv"),
			contractVersion: 999,
		} as unknown as InstallationTransitionEvent;
		expect(() => service.apply(foreign)).toThrowError(/contract version/i);
	});
});
