/**
 * Deterministic behavioral coverage for the TrustEngine service. Every test
 * drives the real engine through its public API against an in-memory runtime
 * and Drizzle-shaped database stub; expectations assert computed scores,
 * persistence payloads, and cache/rate-limit transitions rather than stubbed
 * return values. Time is frozen with fake timers so decay, recency windows,
 * hourly limits, and the five-minute profile cache are exercised exactly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaError } from "../../../errors.ts";
import {
	type Component,
	type IAgentRuntime,
	Service,
	type UUID,
} from "../../../types/index.ts";
import { stringToUuid } from "../../../utils.ts";
import {
	type TrustEvidence,
	TrustEvidenceType,
	type TrustProfile,
} from "../types/trust.ts";
import { TrustEngine } from "./TrustEngine.ts";

const FROZEN_NOW = Date.parse("2026-08-24T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const AGENT_ID = "00000000-0000-4000-8000-0000000000a1" as UUID;
const EVALUATOR_ID = "00000000-0000-4000-8000-0000000000b2" as UUID;
const SUBJECT_ID = "00000000-0000-4000-8000-0000000000c3" as UUID;
const WORLD_ID = "00000000-0000-4000-8000-0000000000d4" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-0000000000e5" as UUID;

let componentSeq = 0;

function uuidFor(index: number): UUID {
	return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as UUID;
}

interface HarnessState {
	components: Component[];
	created: Component[];
	updated: Component[];
	dbRows: Array<Record<string, unknown>>;
	inserted: Array<Record<string, unknown>>;
	ensuredWorlds: Array<Record<string, unknown>>;
	reportedErrors: Array<{
		scope: string;
		error: unknown;
		context?: Record<string, unknown>;
	}>;
	insertFailure: Error | null;
}

interface Harness {
	engine: TrustEngine;
	runtime: IAgentRuntime;
	state: HarnessState;
}

function makeDb(state: HarnessState) {
	return {
		select: () => ({
			from: () => ({
				where: () => ({
					orderBy: () => ({
						limit: async () => state.dbRows,
					}),
				}),
			}),
		}),
		insert: () => ({
			values: async (row: Record<string, unknown>) => {
				if (state.insertFailure) throw state.insertFailure;
				state.inserted.push(row);
			},
		}),
	};
}

async function makeHarness(options?: { omitDb?: boolean }): Promise<Harness> {
	const state: HarnessState = {
		components: [],
		created: [],
		updated: [],
		dbRows: [],
		inserted: [],
		ensuredWorlds: [],
		reportedErrors: [],
		insertFailure: null,
	};

	const runtime = {
		agentId: AGENT_ID,
		...(options?.omitDb ? {} : { db: makeDb(state) }),
		getComponents: async (entityId: UUID) =>
			state.components.filter((c) => c.entityId === entityId),
		getComponent: async (
			entityId: UUID,
			type: string,
			worldId: UUID,
			evaluatorId: UUID,
		) =>
			state.components.find(
				(c) =>
					c.entityId === entityId &&
					c.type === type &&
					c.worldId === worldId &&
					c.agentId === evaluatorId,
			),
		ensureWorldExists: async (world: Record<string, unknown>) => {
			state.ensuredWorlds.push(world);
			return true;
		},
		createComponent: async (component: Component) => {
			state.created.push(component);
			state.components.push(component);
			return true;
		},
		updateComponent: async (component: Component) => {
			state.updated.push(component);
			const index = state.components.findIndex(
				(c) =>
					c.entityId === component.entityId &&
					c.type === component.type &&
					c.worldId === component.worldId &&
					c.agentId === component.agentId,
			);
			if (index >= 0) state.components[index] = component;
			else state.components.push(component);
			return true;
		},
		reportError: (
			scope: string,
			error: unknown,
			context?: Record<string, unknown>,
		) => {
			state.reportedErrors.push({ scope, error, context });
		},
	} as unknown as IAgentRuntime;

	const engine = new TrustEngine();
	await engine.initialize(runtime);
	return { engine, runtime, state };
}

function evidenceData(overrides: Partial<TrustEvidence> = {}): TrustEvidence {
	return {
		type: TrustEvidenceType.PROMISE_KEPT,
		timestamp: FROZEN_NOW,
		impact: 10,
		weight: 1,
		description: "kept a promise",
		reportedBy: EVALUATOR_ID,
		verified: true,
		context: { evaluatorId: EVALUATOR_ID },
		targetEntityId: SUBJECT_ID,
		evaluatorId: EVALUATOR_ID,
		...overrides,
	};
}

function evidenceComponent(overrides: Partial<TrustEvidence> = {}): Component {
	componentSeq += 1;
	return {
		id: uuidFor(componentSeq),
		type: "trust_evidence",
		entityId: SUBJECT_ID,
		agentId: EVALUATOR_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		sourceEntityId: EVALUATOR_ID,
		createdAt: FROZEN_NOW,
		data: evidenceData(overrides) as unknown as Record<string, unknown>,
	};
}

function profileData(
	overrides: Partial<TrustProfile> & {
		trendLastChangeAt?: number;
	} = {},
): Record<string, unknown> {
	const { trendLastChangeAt, ...rest } = overrides;
	return {
		entityId: SUBJECT_ID,
		dimensions: {
			reliability: 50,
			competence: 50,
			integrity: 50,
			benevolence: 50,
			transparency: 50,
		},
		overallTrust: 50,
		confidence: 0,
		interactionCount: 0,
		evidence: [],
		lastCalculated: FROZEN_NOW,
		calculationMethod: "seed",
		trend: {
			direction: "stable",
			changeRate: 0,
			lastChangeAt: trendLastChangeAt ?? FROZEN_NOW,
		},
		evaluatorId: EVALUATOR_ID,
		...rest,
	};
}

function profileComponent(
	data: Record<string, unknown>,
	overrides: Partial<Component> = {},
): Component {
	componentSeq += 1;
	return {
		id: uuidFor(componentSeq),
		type: "trust_profile",
		entityId: SUBJECT_ID,
		agentId: EVALUATOR_ID,
		roomId: ROOM_ID,
		worldId: stringToUuid("trust-world"),
		sourceEntityId: EVALUATOR_ID,
		createdAt: FROZEN_NOW,
		data,
		...overrides,
	};
}

function dbRow(overrides: Record<string, unknown> = {}) {
	return {
		targetEntityId: SUBJECT_ID,
		sourceEntityId: EVALUATOR_ID,
		evaluatorId: EVALUATOR_ID,
		type: TrustEvidenceType.CONTEXT_SWITCH,
		impact: 0,
		weight: 1,
		description: "row",
		verified: false,
		context: { evaluatorId: EVALUATOR_ID },
		timestamp: FROZEN_NOW,
		...overrides,
	};
}

async function expectElizaError(code: string, run: () => Promise<unknown>) {
	const err: unknown = await run().then(
		() => new Error("expected rejection"),
		(e: unknown) => e,
	);
	if (!(err instanceof ElizaError)) {
		throw new Error(`expected ElizaError with code ${code}`);
	}
	expect(err.code).toBe(code);
	return err;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(FROZEN_NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("TrustEngine identity and lifecycle", () => {
	it("exposes its service identity", () => {
		expect(TrustEngine.serviceType).toBe("trust-engine:core");
	});

	it("starts against a runtime and yields a usable engine", async () => {
		const { runtime } = await makeHarness();
		const service = await TrustEngine.start(runtime);
		expect(service).toBeInstanceOf(TrustEngine);
		expect(service).toBeInstanceOf(Service);
		const engine = service as TrustEngine;
		expect(engine.capabilityDescription).toBe(
			"Multi-dimensional trust scoring and evaluation system",
		);
		const profile = await engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.entityId).toBe(SUBJECT_ID);
	});

	it("clears the profile cache on stop so the next call recomputes", async () => {
		const h = await makeHarness();
		const first = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		await h.engine.stop();
		const second = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(second).not.toBe(first);
		expect(h.state.created.length + h.state.updated.length).toBe(2);
	});
});

describe("TrustEngine constructor configuration", () => {
	it("honors a lowered minimumEvidenceCount where the default yields zero confidence", async () => {
		const hDefault = await makeHarness();
		const hConfigured = await makeHarness();
		hDefault.state.components.push(
			evidenceComponent(),
			evidenceComponent({ timestamp: FROZEN_NOW - 1000 }),
		);
		hConfigured.state.components.push(
			evidenceComponent(),
			evidenceComponent({ timestamp: FROZEN_NOW - 1000 }),
		);

		const relaxed = new TrustEngine({ minimumEvidenceCount: 2 });
		await relaxed.initialize(hConfigured.runtime);

		const strict = await hDefault.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		const relaxedProfile = await relaxed.calculateTrust(SUBJECT_ID, {
			evaluatorId: uuidFor(999901),
		});
		expect(strict.confidence).toBe(0);
		expect(relaxedProfile.confidence).toBeCloseTo(0.64, 10);
	});

	it("replaces (not merges) dimensionWeights, so overall tracks the sole weighted dimension", async () => {
		const h = await makeHarness();
		h.state.components.push(evidenceComponent());
		const engine = new TrustEngine({
			dimensionWeights: {
				reliability: 1,
				competence: 0,
				integrity: 0,
				benevolence: 0,
				transparency: 0,
			},
		});
		await engine.initialize(h.runtime);
		const profile = await engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: uuidFor(999902),
		});
		// One verified PROMISE_KEPT at age zero: reliability = 50 + 15*0.85*1.5 = 69.125.
		expect(profile.dimensions.reliability).toBeCloseTo(69.125, 10);
		expect(profile.overallTrust).toBe(69);
	});

	it("lets recencyBias flatten age decay to the floor weight", async () => {
		const h = await makeHarness();
		const old = FROZEN_NOW - 365 * DAY_MS;
		h.state.components.push(
			evidenceComponent({ verified: false, timestamp: old }),
		);
		const flat = new TrustEngine({ recencyBias: 0 });
		await flat.initialize(h.runtime);

		const defaultProfile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		const flatProfile = await flat.calculateTrust(SUBJECT_ID, {
			evaluatorId: uuidFor(999903),
		});
		// Flat bias: ageWeight = 0.5 regardless of age → 50 + 15*0.5 = 57.5.
		expect(flatProfile.dimensions.reliability).toBeCloseTo(57.5, 10);
		// Default bias on year-old evidence decays toward the 0.15 floor blend.
		expect(defaultProfile.dimensions.reliability).toBeLessThan(
			flatProfile.dimensions.reliability,
		);
		expect(defaultProfile.dimensions.reliability).toBeCloseTo(52.25, 6);
	});

	it("makes verified and unverified evidence equivalent when verificationMultiplier is 1", async () => {
		const hVerified = await makeHarness();
		const hPlain = await makeHarness();
		hVerified.state.components.push(evidenceComponent({ verified: true }));
		hPlain.state.components.push(evidenceComponent({ verified: false }));

		const neutralizer = new TrustEngine({ verificationMultiplier: 1 });
		await neutralizer.initialize(hVerified.runtime);

		const verified = await neutralizer.calculateTrust(SUBJECT_ID, {
			evaluatorId: uuidFor(999904),
		});
		const plain = await hPlain.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: uuidFor(999905),
		});
		expect(verified.dimensions).toEqual(plain.dimensions);
	});
});

describe("TrustEngine.calculateTrust baseline", () => {
	it("produces a neutral profile for an entity with no evidence", async () => {
		const h = await makeHarness();
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.entityId).toBe(SUBJECT_ID);
		expect(profile.evaluatorId).toBe(EVALUATOR_ID);
		expect(profile.dimensions).toEqual({
			reliability: 50,
			competence: 50,
			integrity: 50,
			benevolence: 50,
			transparency: 50,
		});
		expect(profile.overallTrust).toBe(50);
		expect(profile.confidence).toBe(0);
		expect(profile.interactionCount).toBe(0);
		expect(profile.evidence).toEqual([]);
		expect(profile.calculationMethod).toBe("dimensional_aggregation_v1");
		expect(profile.lastCalculated).toBe(FROZEN_NOW);
		expect(profile.trend).toEqual({
			direction: "stable",
			changeRate: 0,
			lastChangeAt: FROZEN_NOW,
		});
	});
});

describe("TrustEngine.calculateTrust dimension arithmetic", () => {
	it("maps verified PROMISE_KEPT onto reliability/integrity with decay and verification factors", async () => {
		const h = await makeHarness();
		h.state.components.push(evidenceComponent());
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.dimensions.reliability).toBeCloseTo(69.125, 10);
		expect(profile.dimensions.integrity).toBeCloseTo(62.75, 10);
		expect(profile.dimensions.competence).toBe(50);
		expect(profile.overallTrust).toBe(58);
	});

	it("skips the verification multiplier for unverified evidence", async () => {
		const h = await makeHarness();
		h.state.components.push(evidenceComponent({ verified: false }));
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.dimensions.reliability).toBeCloseTo(62.75, 10);
		expect(profile.dimensions.integrity).toBeCloseTo(58.5, 10);
	});

	it("clamps dimensions at 100 after repeated positive evidence", async () => {
		const h = await makeHarness();
		for (let i = 0; i < 3; i++) {
			h.state.components.push(
				evidenceComponent({
					type: TrustEvidenceType.CONSISTENT_BEHAVIOR,
					timestamp: FROZEN_NOW - i,
				}),
			);
		}
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.dimensions.reliability).toBe(100);
		expect(profile.dimensions.transparency).toBeCloseTo(88.25, 6);
	});

	it("clamps dimensions at 0 after repeated harmful evidence", async () => {
		const h = await makeHarness();
		for (let i = 0; i < 2; i++) {
			h.state.components.push(
				evidenceComponent({
					type: TrustEvidenceType.HARMFUL_ACTION,
					timestamp: FROZEN_NOW - i,
				}),
			);
		}
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.dimensions.benevolence).toBe(0);
		expect(profile.dimensions.integrity).toBe(0);
	});

	it("counts neutral ROLE_CHANGE evidence toward volume without moving dimensions", async () => {
		const h = await makeHarness();
		for (let i = 0; i < 3; i++) {
			h.state.components.push(
				evidenceComponent({
					type: TrustEvidenceType.ROLE_CHANGE,
					impact: 0,
					timestamp: FROZEN_NOW - i,
				}),
			);
		}
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.interactionCount).toBe(3);
		expect(profile.dimensions).toEqual({
			reliability: 50,
			competence: 50,
			integrity: 50,
			benevolence: 50,
			transparency: 50,
		});
		// count 3/20 → 0.15*0.4 + consistency 0 + recency 1*0.3 = 0.36.
		expect(profile.confidence).toBeCloseTo(0.36, 10);
	});

	it("applies financial action weights over the default aggregation", async () => {
		const h = await makeHarness();
		h.state.components.push(evidenceComponent());
		const financial = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
			action: "financial",
		});
		expect(financial.overallTrust).toBe(60);

		const hUnknown = await makeHarness();
		hUnknown.state.components.push(evidenceComponent());
		const unknownAction = await hUnknown.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: uuidFor(999906),
			action: "interplanetary_diplomacy",
		});
		expect(unknownAction.overallTrust).toBe(58);

		const hModeration = await makeHarness();
		hModeration.state.components.push(evidenceComponent());
		const moderation = await hModeration.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: uuidFor(999907),
			action: "moderation",
		});
		expect(moderation.overallTrust).toBe(56);
	});
});

describe("TrustEngine.calculateTrust confidence", () => {
	function threePositiveHarness() {
		return makeHarness().then((h) => {
			for (let i = 0; i < 3; i++) {
				h.state.components.push(
					evidenceComponent({ timestamp: FROZEN_NOW - i * HOUR_MS }),
				);
			}
			return h;
		});
	}

	it("reaches 0.66 for minimal unanimous recent evidence", async () => {
		const h = await threePositiveHarness();
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.confidence).toBeCloseTo(0.66, 10);
	});

	it("excludes evidence exactly seven days old from the recency factor (strict boundary)", async () => {
		const h = await makeHarness();
		h.state.components.push(
			evidenceComponent(),
			evidenceComponent({ timestamp: FROZEN_NOW - HOUR_MS }),
			evidenceComponent({ timestamp: FROZEN_NOW - 7 * DAY_MS }),
		);
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		// 0.15*0.4 + 1*0.3 + (2/3)*0.3 = 0.56.
		expect(profile.confidence).toBeCloseTo(0.56, 10);
	});

	it("zeroes consistency for balanced contradictory evidence", async () => {
		const h = await makeHarness();
		h.state.components.push(
			evidenceComponent(),
			evidenceComponent({ timestamp: FROZEN_NOW - 1 }),
			evidenceComponent({
				type: TrustEvidenceType.PROMISE_BROKEN,
				impact: -15,
				timestamp: FROZEN_NOW - 2,
			}),
			evidenceComponent({
				type: TrustEvidenceType.PROMISE_BROKEN,
				impact: -15,
				timestamp: FROZEN_NOW - 3,
			}),
		);
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		// count 4/20 → 0.2*0.4 + 0 + 1*0.3 = 0.38.
		expect(profile.confidence).toBeCloseTo(0.38, 10);
	});

	it("caps count confidence at twenty evidence items", async () => {
		const h = await makeHarness();
		for (let i = 0; i < 20; i++) {
			h.state.components.push(evidenceComponent({ timestamp: FROZEN_NOW - i }));
		}
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.confidence).toBeCloseTo(1, 10);
	});
});

describe("TrustEngine.calculateTrust evidence loading", () => {
	it("filters component evidence by world and room when the context pins them", async () => {
		const h = await makeHarness();
		h.state.components.push(
			evidenceComponent(), // exact world+room match
			evidenceComponent(), // wrong world
			evidenceComponent(), // wrong room
			evidenceComponent(), // missing world entirely
		);
		h.state.components[1] = {
			...h.state.components[1],
			worldId: uuidFor(888001),
		};
		h.state.components[2] = {
			...h.state.components[2],
			roomId: uuidFor(888002),
		};
		delete (h.state.components[3] as { worldId?: UUID }).worldId;

		const pinned = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
			worldId: WORLD_ID,
			roomId: ROOM_ID,
		});
		expect(pinned.interactionCount).toBe(1);

		const hLoose = await makeHarness();
		hLoose.state.components.push(
			evidenceComponent(),
			evidenceComponent(),
			evidenceComponent(),
			evidenceComponent(),
		);
		hLoose.state.components[2] = {
			...hLoose.state.components[2],
			roomId: uuidFor(888003),
		};
		const loose = await hLoose.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: uuidFor(999908),
			roomId: ROOM_ID,
		});
		// Without a world pin every room match counts; the wrong-room one drops.
		expect(loose.interactionCount).toBe(3);
	});

	it("applies the time window inclusively at both boundaries", async () => {
		const start = FROZEN_NOW - 3 * DAY_MS;
		const end = FROZEN_NOW - DAY_MS;
		const h = await makeHarness();
		h.state.components.push(
			evidenceComponent({ timestamp: start }),
			evidenceComponent({ timestamp: end }),
			evidenceComponent({ timestamp: FROZEN_NOW - 2 * DAY_MS }),
			evidenceComponent({ timestamp: start - 1000 }),
			evidenceComponent({ timestamp: end + 1000 }),
		);
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
			timeWindow: { start, end },
		});
		expect(profile.interactionCount).toBe(3);
		expect(profile.evidence.map((e) => e.timestamp)).toEqual([
			FROZEN_NOW - DAY_MS,
			FROZEN_NOW - 2 * DAY_MS,
			start,
		]);
	});

	it("merges database rows with component evidence and dedupes on timestamp+type", async () => {
		const h = await makeHarness();
		h.state.components.push(
			evidenceComponent({ timestamp: 1000 }), // PROMISE_KEPT at 1000
		);
		h.state.dbRows.push(
			dbRow({
				timestamp: 1000,
				type: TrustEvidenceType.PROMISE_KEPT, // duplicate → dropped
			}),
			dbRow({
				timestamp: 1000,
				type: TrustEvidenceType.HELPFUL_ACTION, // same ts, other type → kept
			}),
			dbRow({
				timestamp: 2000,
				type: TrustEvidenceType.PROMISE_BROKEN,
				impact: -15,
			}),
		);
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.interactionCount).toBe(3);
		expect(profile.evidence.map((e) => e.timestamp)).toEqual([
			2000, 1000, 1000,
		]);
		expect(new Set(profile.evidence.map((e) => e.type))).toEqual(
			new Set([
				TrustEvidenceType.PROMISE_BROKEN,
				TrustEvidenceType.PROMISE_KEPT,
				TrustEvidenceType.HELPFUL_ACTION,
			]),
		);
	});

	it("converts Date timestamps from database rows into millisecond numbers", async () => {
		const h = await makeHarness();
		h.state.dbRows.push(
			dbRow({ timestamp: new Date(111222333444) }),
			dbRow({ timestamp: 555666777888 }),
		);
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		const timestamps = profile.evidence.map((e) => e.timestamp);
		expect(timestamps).toContain(111222333444);
		expect(timestamps).toContain(555666777888);
		for (const ts of timestamps) {
			expect(typeof ts).toBe("number");
		}
	});

	it("rejects a malformed stored evidence component without reporting through the runtime", async () => {
		const h = await makeHarness();
		const bad = evidenceComponent();
		bad.data = { type: TrustEvidenceType.PROMISE_KEPT }; // missing required fields
		const badId = bad.id;
		h.state.components.push(bad);

		const err = await expectElizaError("INVALID_STORED_TRUST_EVIDENCE", () =>
			h.engine.calculateTrust(SUBJECT_ID, { evaluatorId: EVALUATOR_ID }),
		);
		expect(err.message).toBe("Stored trust evidence component is malformed");
		expect(err.context).toEqual({
			entityId: SUBJECT_ID,
			componentId: badId,
		});
		expect(h.state.reportedErrors).toEqual([]);
	});

	it("reports and rethrows when database evidence loading fails", async () => {
		const h = await makeHarness({ omitDb: true });
		await expect(
			h.engine.calculateTrust(SUBJECT_ID, { evaluatorId: EVALUATOR_ID }),
		).rejects.toThrow("[trust] Database not available");
		expect(h.state.reportedErrors.length).toBe(1);
		expect(h.state.reportedErrors[0].scope).toBe("TrustEngine.loadEvidence");
		expect(h.state.reportedErrors[0].context).toEqual({
			targetEntityId: SUBJECT_ID,
		});
	});

	it("reports and rethrows a malformed database evidence row", async () => {
		const h = await makeHarness();
		h.state.dbRows.push(dbRow({ verified: undefined }));
		const err = await expectElizaError("INVALID_STORED_TRUST_EVIDENCE", () =>
			h.engine.calculateTrust(SUBJECT_ID, { evaluatorId: EVALUATOR_ID }),
		);
		expect(err.message).toBe("Stored trust evidence is malformed");
		expect(h.state.reportedErrors[0]?.scope).toBe("TrustEngine.loadEvidence");
	});
});

describe("TrustEngine.calculateTrust trend analysis", () => {
	it("returns a stable zero trend with fewer than two historical profiles", async () => {
		const h = await makeHarness();
		h.state.components.push(
			profileComponent(profileData({ overallTrust: 42 })),
		);
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.trend).toEqual({
			direction: "stable",
			changeRate: 0,
			lastChangeAt: FROZEN_NOW,
		});
	});

	it("ignores historical profiles recorded by a different evaluator", async () => {
		const h = await makeHarness();
		h.state.components.push(
			profileComponent(profileData({}), { agentId: uuidFor(777001) }),
		);
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.trend.direction).toBe("stable");
		expect(profile.trend.changeRate).toBe(0);
	});

	it("computes an increasing trend from the oldest stored score over elapsed days", async () => {
		const h = await makeHarness();
		h.state.components.push(
			profileComponent(
				profileData({ overallTrust: 40, lastCalculated: FROZEN_NOW - DAY_MS }),
			),
			profileComponent(
				profileData({
					overallTrust: 45,
					lastCalculated: FROZEN_NOW - 1000,
					trendLastChangeAt: FROZEN_NOW - 5000,
				}),
			),
		);
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.trend.direction).toBe("increasing");
		expect(profile.trend.changeRate).toBe(10);
		// Current score differs from the newest stored score → change stamped now.
		expect(profile.trend.lastChangeAt).toBe(FROZEN_NOW);
	});

	it("computes a decreasing trend when the oldest score exceeds the current", async () => {
		const h = await makeHarness();
		h.state.components.push(
			profileComponent(
				profileData({ overallTrust: 60, lastCalculated: FROZEN_NOW - DAY_MS }),
			),
			profileComponent(profileData({ lastCalculated: FROZEN_NOW - 1000 })),
		);
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.trend.direction).toBe("decreasing");
		expect(profile.trend.changeRate).toBe(-10);
	});

	it("keeps sub-half-point daily drift stable and rounds the rate to one decimal", async () => {
		const h = await makeHarness();
		h.state.components.push(
			profileComponent(
				profileData({
					overallTrust: 49.6,
					lastCalculated: FROZEN_NOW - DAY_MS,
				}),
			),
			profileComponent(profileData({ lastCalculated: FROZEN_NOW - 1000 })),
		);
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.trend.direction).toBe("stable");
		expect(profile.trend.changeRate).toBe(0.4);
	});

	it("enforces a minimum one-minute timespan so same-moment history cannot divide by zero", async () => {
		const h = await makeHarness();
		h.state.components.push(
			// Oldest score sits four milliseconds in the past: below one minute of
			// elapsed time, so the timespan floor of 1/1440 day must apply.
			profileComponent(
				profileData({ overallTrust: 49, lastCalculated: FROZEN_NOW - 4 }),
			),
			profileComponent(profileData({ lastCalculated: FROZEN_NOW - 1 })),
		);
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		// (50 - 49) / (1/1440) = 1440 points per day.
		expect(profile.trend.direction).toBe("increasing");
		expect(profile.trend.changeRate).toBe(1440);
	});

	it("preserves the newest profile's lastChangeAt when the score is unchanged", async () => {
		const h = await makeHarness();
		const preservedStamp = FROZEN_NOW - 5000;
		h.state.components.push(
			profileComponent(
				profileData({ overallTrust: 40, lastCalculated: FROZEN_NOW - DAY_MS }),
			),
			profileComponent(
				profileData({
					overallTrust: 50,
					lastCalculated: FROZEN_NOW - 1000,
					trendLastChangeAt: preservedStamp,
				}),
			),
		);
		const profile = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(profile.overallTrust).toBe(50);
		expect(profile.trend.direction).toBe("increasing");
		expect(profile.trend.lastChangeAt).toBe(preservedStamp);
	});

	it("rejects a malformed stored trust profile with a typed error", async () => {
		const h = await makeHarness();
		h.state.components.push(
			profileComponent({ garbage: true } as Record<string, unknown>),
		);
		const err = await expectElizaError("INVALID_STORED_TRUST_PROFILE", () =>
			h.engine.calculateTrust(SUBJECT_ID, { evaluatorId: EVALUATOR_ID }),
		);
		expect(err.message).toBe("Stored trust profile is malformed");
		expect(err.context).toEqual({
			entityId: SUBJECT_ID,
			evaluatorId: EVALUATOR_ID,
		});
	});
});

describe("TrustEngine profile persistence", () => {
	it("creates a deterministic trust_profile component in a default trust world", async () => {
		const h = await makeHarness();
		await h.engine.calculateTrust(SUBJECT_ID, { evaluatorId: EVALUATOR_ID });

		expect(h.state.ensuredWorlds).toEqual([
			{
				id: stringToUuid("trust-world"),
				name: "trust-world",
				agentId: AGENT_ID,
				messageServerId: stringToUuid("default"),
				metadata: {},
			},
		]);
		expect(h.state.created.length).toBe(1);
		const component = h.state.created[0];
		expect(component.id).toBe(
			stringToUuid(`trust-profile-${SUBJECT_ID}-${EVALUATOR_ID}`),
		);
		expect(component.type).toBe("trust_profile");
		expect(component.agentId).toBe(EVALUATOR_ID);
		expect(component.entityId).toBe(SUBJECT_ID);
		expect(component.roomId).toBe(stringToUuid("trust-global"));
		expect(component.worldId).toBe(stringToUuid("trust-world"));
		expect(component.createdAt).toBe(FROZEN_NOW);
		const data = component.data as Record<string, unknown>;
		expect(data.overallTrust).toBe(50);
		expect(data.calculationMethod).toBe("dimensional_aggregation_v1");
	});

	it("propagates explicit world and room from the context", async () => {
		const h = await makeHarness();
		await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
			worldId: WORLD_ID,
			roomId: ROOM_ID,
		});
		expect(h.state.ensuredWorlds[0]).toMatchObject({ id: WORLD_ID });
		expect(h.state.created[0].worldId).toBe(WORLD_ID);
		expect(h.state.created[0].roomId).toBe(ROOM_ID);
	});

	it("updates an existing component while preserving its createdAt", async () => {
		const h = await makeHarness();
		const originalCreatedAt = FROZEN_NOW - 9999;
		h.state.components.push(
			profileComponent(profileData({ overallTrust: 10 }), {
				createdAt: originalCreatedAt,
			}),
		);
		await h.engine.calculateTrust(SUBJECT_ID, { evaluatorId: EVALUATOR_ID });
		expect(h.state.created.length).toBe(0);
		expect(h.state.updated.length).toBe(1);
		expect(h.state.updated[0].createdAt).toBe(originalCreatedAt);
		const data = h.state.updated[0].data as Record<string, unknown>;
		expect(data.overallTrust).toBe(50);
	});
});

describe("TrustEngine profile caching", () => {
	it("serves an identical cached object within five minutes without saving again", async () => {
		const h = await makeHarness();
		const first = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		vi.setSystemTime(FROZEN_NOW + 299_999);
		const second = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(second).toBe(first);
		expect(h.state.created.length).toBe(1);
	});

	it("recomputes and saves once the cache is exactly five minutes stale", async () => {
		const h = await makeHarness();
		const first = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		vi.setSystemTime(FROZEN_NOW + 300_000);
		const second = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: EVALUATOR_ID,
		});
		expect(second).not.toBe(first);
		expect(h.state.created.length + h.state.updated.length).toBe(2);
	});

	it("keys the cache per evaluator", async () => {
		const h = await makeHarness();
		const a = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: uuidFor(999910),
		});
		const b = await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: uuidFor(999911),
		});
		expect(b).not.toBe(a);
		expect(b.evaluatorId).not.toBe(a.evaluatorId);
		expect(h.state.created.length).toBe(2);
	});

	it("evicts the oldest entry once the cache exceeds two thousand keys", async () => {
		const h = await makeHarness();
		const evaluatorCount = 2000;
		for (let i = 0; i < evaluatorCount; i++) {
			await h.engine.calculateTrust(SUBJECT_ID, { evaluatorId: uuidFor(i) });
		}
		expect(h.state.created.length + h.state.updated.length).toBe(
			evaluatorCount,
		);

		// Inserting one more key overflows the cache and evicts uuidFor(0).
		await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: uuidFor(evaluatorCount),
		});
		expect(h.state.created.length + h.state.updated.length).toBe(
			evaluatorCount + 1,
		);

		// The evicted oldest key recomputes and writes again.
		await h.engine.calculateTrust(SUBJECT_ID, { evaluatorId: uuidFor(0) });
		expect(h.state.created.length + h.state.updated.length).toBe(
			evaluatorCount + 2,
		);

		// The most recently added key survived → served from cache, no write.
		await h.engine.calculateTrust(SUBJECT_ID, {
			evaluatorId: uuidFor(evaluatorCount),
		});
		expect(h.state.created.length + h.state.updated.length).toBe(
			evaluatorCount + 2,
		);
	}, 120_000);
});

describe("TrustEngine.recordInteraction rate limiting", () => {
	async function recordedHarness() {
		const h = await makeHarness();
		const record = (overrides: Record<string, unknown> = {}) =>
			h.engine.recordInteraction({
				sourceEntityId: EVALUATOR_ID,
				targetEntityId: SUBJECT_ID,
				type: TrustEvidenceType.HELPFUL_ACTION,
				timestamp: Date.now(),
				impact: 8,
				...overrides,
			} as Parameters<TrustEngine["recordInteraction"]>[0]);
		return { h, record };
	}

	it("applies diminishing returns weights of 1, 0.75, 0.5, then 0.25 per type", async () => {
		const { h, record } = await recordedHarness();
		for (let i = 0; i < 4; i++) {
			await record();
		}
		expect(h.state.inserted.map((r) => r.impact)).toEqual([8, 6, 4, 2]);
		expect(h.state.inserted.map((r) => r.weight)).toEqual([1, 0.75, 0.5, 0.25]);
	});

	it("accepts ten interactions per entity per hour and silently drops the eleventh", async () => {
		const { h, record } = await recordedHarness();
		for (let i = 0; i < 10; i++) {
			await record();
		}
		await record(); // eleventh — rate limited, neither persisted nor retained
		expect(h.state.inserted.length).toBe(10);
		const recent = await h.engine.getRecentInteractions(SUBJECT_ID);
		expect(recent.length).toBe(10);
	});

	it("keeps the window closed at exactly one hour and resets strictly after", async () => {
		const { h, record } = await recordedHarness();
		for (let i = 0; i < 10; i++) {
			await record();
		}
		vi.setSystemTime(FROZEN_NOW + HOUR_MS);
		await record();
		expect(h.state.inserted.length).toBe(10);

		vi.setSystemTime(FROZEN_NOW + HOUR_MS + 1);
		await record();
		expect(h.state.inserted.length).toBe(11);
		// Fresh window → the type's weight restarts at 1.
		expect(h.state.inserted[10].weight).toBe(1);
	});

	it("rate limits are tracked per target entity independently", async () => {
		const { h, record } = await recordedHarness();
		const otherSubject = uuidFor(700010);
		for (let i = 0; i < 10; i++) {
			await record();
		}
		await record({ targetEntityId: otherSubject });
		expect(h.state.inserted.length).toBe(11);
		expect(h.state.inserted[10].targetEntityId).toBe(otherSubject);
	});
});

describe("TrustEngine.recordInteraction persistence", () => {
	it("falls back to the runtime agent id, empty description, and merged context", async () => {
		const h = await makeHarness();
		await h.engine.recordInteraction({
			sourceEntityId: EVALUATOR_ID,
			targetEntityId: SUBJECT_ID,
			type: TrustEvidenceType.PROMISE_KEPT,
			timestamp: FROZEN_NOW,
			impact: 10,
		});
		expect(h.state.inserted[0]).toEqual({
			targetEntityId: SUBJECT_ID,
			sourceEntityId: EVALUATOR_ID,
			evaluatorId: AGENT_ID,
			type: TrustEvidenceType.PROMISE_KEPT,
			impact: 10,
			weight: 1,
			description: "",
			verified: true,
			context: { evaluatorId: AGENT_ID },
		});
	});

	it("persists supplied descriptions and context with the context evaluator winning", async () => {
		const h = await makeHarness();
		const contextEvaluator = uuidFor(600001);
		await h.engine.recordInteraction({
			sourceEntityId: EVALUATOR_ID,
			targetEntityId: SUBJECT_ID,
			type: TrustEvidenceType.PROMISE_KEPT,
			timestamp: FROZEN_NOW,
			impact: 10,
			details: { description: "delivered the artifact" },
			context: { evaluatorId: contextEvaluator, platform: "test" },
		});
		expect(h.state.inserted[0].description).toBe("delivered the artifact");
		expect(h.state.inserted[0].evaluatorId).toBe(contextEvaluator);
		expect(h.state.inserted[0].context).toEqual({
			platform: "test",
			evaluatorId: contextEvaluator,
		});
	});

	it("reports and rethrows persistence failures", async () => {
		const h = await makeHarness();
		h.state.insertFailure = new Error("db down");
		await expect(
			h.engine.recordInteraction({
				sourceEntityId: EVALUATOR_ID,
				targetEntityId: SUBJECT_ID,
				type: TrustEvidenceType.PROMISE_KEPT,
				timestamp: FROZEN_NOW,
				impact: 10,
			}),
		).rejects.toThrow("db down");
		expect(h.state.reportedErrors.length).toBe(1);
		expect(h.state.reportedErrors[0].scope).toBe("TrustEngine.persistEvidence");
		expect(h.state.reportedErrors[0].context).toEqual({
			targetEntityId: SUBJECT_ID,
		});
		expect((h.state.reportedErrors[0].error as Error).message).toBe("db down");
	});

	it("invalidates only the affected entity's cached profiles", async () => {
		const h = await makeHarness();
		const subjectA = uuidFor(500001);
		const subjectB = uuidFor(500002);
		await h.engine.calculateTrust(subjectA, { evaluatorId: EVALUATOR_ID });
		await h.engine.calculateTrust(subjectB, { evaluatorId: EVALUATOR_ID });
		expect(h.state.created.length).toBe(2);

		await h.engine.recordInteraction({
			sourceEntityId: EVALUATOR_ID,
			targetEntityId: subjectA,
			type: TrustEvidenceType.PROMISE_KEPT,
			timestamp: FROZEN_NOW,
			impact: 10,
		});

		// A's cache entry was dropped → recalculation writes a fresh profile.
		await h.engine.calculateTrust(subjectA, { evaluatorId: EVALUATOR_ID });
		expect(h.state.created.length + h.state.updated.length).toBe(3);

		// B's cache entry survived → no additional write.
		await h.engine.calculateTrust(subjectB, { evaluatorId: EVALUATOR_ID });
		expect(h.state.created.length + h.state.updated.length).toBe(3);
	});

	it("retains only the most recent five hundred interactions in memory", async () => {
		const h = await makeHarness();
		for (let i = 0; i < 505; i++) {
			await h.engine.recordInteraction({
				sourceEntityId: EVALUATOR_ID,
				targetEntityId: uuidFor(400000 + i),
				type: TrustEvidenceType.PROMISE_KEPT,
				timestamp: FROZEN_NOW + i,
				impact: 1,
			});
		}
		const forFirstEntity = await h.engine.getRecentInteractions(
			uuidFor(400000),
		);
		expect(forFirstEntity.length).toBe(0);
		const forNewestEntity = await h.engine.getRecentInteractions(
			uuidFor(400000 + 504),
		);
		expect(forNewestEntity.length).toBe(1);
	});
});

describe("TrustEngine.evaluateTrustDecision", () => {
	it("denies when overall trust is below the requirement and explains the gap", async () => {
		const h = await makeHarness();
		const decision = await h.engine.evaluateTrustDecision(
			SUBJECT_ID,
			{ minimumTrust: 51 },
			{ evaluatorId: EVALUATOR_ID },
		);
		expect(decision.allowed).toBe(false);
		expect(decision.trustScore).toBe(50);
		expect(decision.requiredScore).toBe(51);
		expect(decision.reason).toBe("Trust score 50 is below required 51");
		expect(decision.suggestions?.[0]).toBe(
			"Build 1 more trust points through positive interactions",
		);
		expect(decision.suggestions).toContain(
			"Keep your promises and commitments",
		);
		expect(decision.suggestions).toContain(
			"Engage in more conversations and activities",
		);
	});

	it("denies on a specific dimension and returns the dimension's suggestions", async () => {
		const h = await makeHarness();
		const decision = await h.engine.evaluateTrustDecision(
			SUBJECT_ID,
			{ minimumTrust: 0, dimensions: { transparency: 60 } },
			{ evaluatorId: EVALUATOR_ID },
		);
		expect(decision.allowed).toBe(false);
		expect(decision.reason).toBe("transparency score 50 is below required 60");
		expect(decision.dimensionsChecked).toEqual({ transparency: 60 });
		expect(decision.suggestions).toEqual([
			"Be open about your intentions",
			"Share information freely when appropriate",
			"Verify your identity on multiple platforms",
		]);
	});

	it("allows when scores exactly equal every requirement and zero minima are falsy", async () => {
		const h = await makeHarness();
		const decision = await h.engine.evaluateTrustDecision(
			SUBJECT_ID,
			{
				minimumTrust: 50,
				minimumInteractions: 0,
				minimumConfidence: 0,
				dimensions: { reliability: 50 },
			},
			{ evaluatorId: EVALUATOR_ID },
		);
		expect(decision.allowed).toBe(true);
		expect(decision.reason).toBe("All trust requirements met");
		expect(decision.trustScore).toBe(50);
		expect(decision.requiredScore).toBe(50);
		expect(decision.suggestions).toBeUndefined();
	});

	it("resolves failures by precedence: overall, then dimension, then interactions, then confidence", async () => {
		const h = await makeHarness();

		const overall = await h.engine.evaluateTrustDecision(
			SUBJECT_ID,
			{
				minimumTrust: 99,
				dimensions: { transparency: 99 },
				minimumInteractions: 5,
				minimumConfidence: 0.9,
			},
			{ evaluatorId: uuidFor(300001) },
		);
		expect(overall.reason).toContain("Trust score");

		const dimension = await h.engine.evaluateTrustDecision(
			SUBJECT_ID,
			{
				minimumTrust: 0,
				dimensions: { transparency: 99, reliability: 99 },
				minimumInteractions: 5,
				minimumConfidence: 0.9,
			},
			{ evaluatorId: uuidFor(300002) },
		);
		expect(dimension.reason).toBe("transparency score 50 is below required 99");

		const interactions = await h.engine.evaluateTrustDecision(
			SUBJECT_ID,
			{ minimumTrust: 0, minimumInteractions: 5, minimumConfidence: 0.9 },
			{ evaluatorId: uuidFor(300003) },
		);
		expect(interactions.reason).toBe("Insufficient interactions: 0 < 5");
		expect(interactions.suggestions).toEqual([
			"Engage in more interactions to build history",
		]);

		const confidence = await h.engine.evaluateTrustDecision(
			SUBJECT_ID,
			{ minimumTrust: 0, minimumConfidence: 0.9 },
			{ evaluatorId: uuidFor(300004) },
		);
		expect(confidence.reason).toBe("Trust confidence 0 is below required 0.9");
		expect(confidence.suggestions).toEqual([
			"More consistent interactions needed to increase confidence",
		]);
	});
});

describe("TrustEngine.evaluateTrust convenience wrapper", () => {
	it("delegates with the evaluator merged into the context", async () => {
		const h = await makeHarness();
		h.state.components.push(evidenceComponent());
		const profile = await h.engine.evaluateTrust(SUBJECT_ID, uuidFor(200001), {
			worldId: WORLD_ID,
		});
		expect(profile.evaluatorId).toBe(uuidFor(200001));
		expect(profile.interactionCount).toBe(1);
	});

	it("filters out evidence outside the merged world context", async () => {
		const h = await makeHarness();
		h.state.components.push(evidenceComponent());
		const elsewhere = await h.engine.evaluateTrust(
			SUBJECT_ID,
			uuidFor(200002),
			{ worldId: uuidFor(200003) },
		);
		expect(elsewhere.interactionCount).toBe(0);
	});

	it("lets a partial context's evaluatorId win over the parameter (observed spread order)", async () => {
		const h = await makeHarness();
		const parameterEvaluator = uuidFor(200004);
		const contextEvaluator = uuidFor(200005);
		const profile = await h.engine.evaluateTrust(
			SUBJECT_ID,
			parameterEvaluator,
			{ evaluatorId: contextEvaluator },
		);
		expect(profile.evaluatorId).toBe(contextEvaluator);
	});
});

describe("TrustEngine.getRecentInteractions", () => {
	async function interactionsHarness() {
		const h = await makeHarness();
		const record = (
			timestamp: number,
			overrides: Record<string, unknown> = {},
		) =>
			h.engine.recordInteraction({
				sourceEntityId: EVALUATOR_ID,
				targetEntityId: SUBJECT_ID,
				type: TrustEvidenceType.PROMISE_KEPT,
				timestamp,
				impact: 1,
				...overrides,
			} as Parameters<TrustEngine["recordInteraction"]>[0]);
		return { h, record };
	}

	it("returns source-or-target matches inside the default ten-day window in insertion order", async () => {
		const { h, record } = await interactionsHarness();
		const unrelated = uuidFor(100001);
		await record(FROZEN_NOW); // target match
		await record(FROZEN_NOW - 9 * DAY_MS, {
			sourceEntityId: SUBJECT_ID,
			targetEntityId: uuidFor(100002),
		}); // source match
		await record(FROZEN_NOW - 10 * DAY_MS); // exactly at cutoff → excluded
		await record(FROZEN_NOW, {
			sourceEntityId: unrelated,
			targetEntityId: unrelated,
		}); // unrelated
		await record(FROZEN_NOW - HOUR_MS); // source+target match

		const recent = await h.engine.getRecentInteractions(SUBJECT_ID);
		expect(recent.map((i) => i.timestamp)).toEqual([
			FROZEN_NOW,
			FROZEN_NOW - 9 * DAY_MS,
			FROZEN_NOW - HOUR_MS,
		]);
	});

	it("honors custom, zero, and negative daysBack with a strict greater-than cutoff", async () => {
		const { h, record } = await interactionsHarness();
		await record(FROZEN_NOW - 10 * DAY_MS);
		await record(FROZEN_NOW - HOUR_MS);
		await record(FROZEN_NOW + 1000);

		const wide = await h.engine.getRecentInteractions(SUBJECT_ID, 30);
		expect(wide.length).toBe(3);

		const zero = await h.engine.getRecentInteractions(SUBJECT_ID, 0);
		expect(zero.map((i) => i.timestamp)).toEqual([FROZEN_NOW + 1000]);

		const negative = await h.engine.getRecentInteractions(SUBJECT_ID, -1);
		expect(negative).toEqual([]);
	});
});
