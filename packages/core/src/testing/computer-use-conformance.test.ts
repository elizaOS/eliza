/**
 * Deterministic unit tests for the interaction adapter conformance runner.
 * A real in-process adapter drives `runInteractionAdapterConformance`, proving
 * identifier binding, fixture completeness and uniqueness, untrusted-payload
 * wrapping, capability/observation honesty gates, status truthfulness, and the
 * frozen report envelope, plus the standalone lease conformance export.
 */

import { describe, expect, it } from "vitest";
import {
	computeInteractionActionDigest,
	INTERACTION_CONTRACT_VERSION,
	type InteractionAction,
	type InteractionActionResult,
	type InteractionAdapter,
	type InteractionCapabilitySet,
	type InteractionObservation,
	type InteractionOutcomeStatus,
	type InteractionSession,
	type InteractionSurfaceRef,
} from "../contracts/computer-use.ts";
import { ElizaError } from "../errors.ts";
import {
	type InteractionAdapterConformanceOptions,
	type InteractionConformanceCaseName,
	type InteractionConformanceFixture,
	REQUIRED_INTERACTION_CONFORMANCE_CASES,
	runInteractionAdapterConformance,
	runInteractionLeaseConformance,
} from "./computer-use-conformance.ts";

const adapterId = "conformance-deterministic";
const sessionId = "conformance-session";
const now = "2026-01-01T00:00:00.000Z";
const later = "2026-01-01T00:00:01.000Z";

const primarySurface: InteractionSurfaceRef = {
	sessionId,
	adapterId,
	surfaceId: "surface-primary",
	kind: "browser_tab",
	generation: 5,
	parentSurfaceId: null,
};

const secondarySurface: InteractionSurfaceRef = {
	sessionId,
	adapterId,
	surfaceId: "surface-secondary",
	kind: "browser_tab",
	generation: 5,
	parentSurfaceId: null,
};

const session: InteractionSession = {
	contractVersion: INTERACTION_CONTRACT_VERSION,
	sessionId,
	ownerId: "owner-1",
	adapterId,
	state: "ready",
	isolationMode: "managed_browser",
	profileMode: "managed",
	generation: 5,
	createdAt: now,
	updatedAt: now,
	expiresAt: null,
	profileGrant: null,
	surfaces: [primarySurface, secondarySurface],
};

const capabilities: InteractionCapabilitySet = {
	contractVersion: INTERACTION_CONTRACT_VERSION,
	adapterId,
	controlPlanes: ["browser"],
	surfaceKinds: ["browser_tab"],
	observationChannels: ["dom", "screenshot"],
	actionKinds: ["observe"],
	background: {
		mode: "semantic_only",
		requiresForeground: [],
	},
	profileAccess: {
		modes: ["managed"],
		requiresExplicitGrant: false,
	},
	concurrency: {
		mode: "isolated_sessions",
		maxSessions: 4,
		sharedResources: ["clipboard"],
	},
	limitations: [],
};

const observation: InteractionObservation = {
	contractVersion: INTERACTION_CONTRACT_VERSION,
	observationId: "observation-1",
	sessionId,
	adapterId,
	surface: primarySurface,
	sequence: 7,
	observedAt: now,
	channels: ["dom", "screenshot"],
	artifacts: [],
	viewport: { x: 0, y: 0, width: 1440, height: 900 },
	cursor: { x: 20, y: 30 },
	redactions: [],
	traceEvents: [],
};

/** The documented status contract; the happy path proves the runner agrees. */
const statusByCase: Record<
	InteractionConformanceCaseName,
	InteractionOutcomeStatus
> = {
	success: "SUCCEEDED",
	failed_no_effect: "FAILED_NO_EFFECT",
	uncertain_effect: "UNCERTAIN_EFFECT",
	policy_block: "BLOCKED_BY_POLICY",
	confirmation: "NEEDS_CONFIRMATION",
	unsupported: "UNSUPPORTED",
	stale_observation: "STALE_OBSERVATION",
};

function caseNameOf(actionId: string): InteractionConformanceCaseName {
	const name = actionId.replace(/^case-/, "");
	if (
		!REQUIRED_INTERACTION_CONFORMANCE_CASES.includes(
			name as InteractionConformanceCaseName,
		)
	) {
		throw new Error(`Unknown deterministic conformance action ${actionId}`);
	}
	return name as InteractionConformanceCaseName;
}

function action(
	actionId: string,
	kind: "observe" | "evaluate" = "observe",
): InteractionAction {
	if (kind === "evaluate") {
		return {
			contractVersion: INTERACTION_CONTRACT_VERSION,
			actionId,
			sessionId,
			adapterId,
			surface: primarySurface,
			kind,
			payload: { expression: "document.title" },
			observationId: observation.observationId,
			observationSequence: observation.sequence,
			requestedAt: now,
			confirmationGrant: null,
			leaseIds: [],
		} satisfies InteractionAction;
	}
	return {
		contractVersion: INTERACTION_CONTRACT_VERSION,
		actionId,
		sessionId,
		adapterId,
		surface: primarySurface,
		kind,
		payload: {},
		observationId: observation.observationId,
		observationSequence:
			actionId === "case-stale_observation"
				? observation.sequence - 1
				: observation.sequence,
		requestedAt: now,
		confirmationGrant: null,
		leaseIds: [],
	} satisfies InteractionAction;
}

function fixtureAction(
	name: InteractionConformanceCaseName,
): InteractionAction {
	return action(
		`case-${name}`,
		name === "unsupported" ? "evaluate" : "observe",
	);
}

function conformanceFixtures(): InteractionConformanceFixture[] {
	return REQUIRED_INTERACTION_CONFORMANCE_CASES.map((name) => ({
		name,
		action: fixtureAction(name),
	}));
}

function resultFor(
	input: InteractionAction,
	status: InteractionOutcomeStatus,
): InteractionActionResult {
	const needsConfirmation = status === "NEEDS_CONFIRMATION";
	const needsError = status !== "SUCCEEDED" && !needsConfirmation;
	return {
		contractVersion: INTERACTION_CONTRACT_VERSION,
		actionId: input.actionId,
		sessionId,
		adapterId,
		status,
		startedAt: later,
		completedAt: later,
		error: needsError
			? {
					code: status,
					message: `Deterministic ${status}`,
					retryable: status !== "UNCERTAIN_EFFECT",
				}
			: null,
		confirmation: needsConfirmation
			? {
					confirmationId: `confirmation-${input.actionId}`,
					actionId: input.actionId,
					taxonomy: "external_send",
					origin: "https://example.test",
					destination: "https://recipient.test",
					disclosures: ["draft text"],
					consequence: "Sends the previewed payload.",
					actionDigest: computeInteractionActionDigest(input),
					requestedAt: now,
					expiresAt: "2026-01-01T00:05:00.000Z",
				}
			: null,
		evidence: {
			beforeObservationId: input.observationId,
			afterObservationId:
				status === "SUCCEEDED" ? observation.observationId : null,
			adapterTraceId: `trace-${input.actionId}`,
			actualTarget: primarySurface.surfaceId,
		},
		effectReceipts:
			status === "SUCCEEDED"
				? [
						{
							receiptId: "receipt-1",
							operation: "computer.observe",
							resource: { kind: "browser.tab", id: primarySurface.surfaceId },
							artifacts: [],
							idempotency: { key: "observe-1", replayed: false },
							observedAt: later,
							outcome: "applied",
							commit: {
								kind: "provider_accepted",
								id: "adapter-result-1",
								committedAt: later,
							},
						},
					]
				: [],
		observation: status === "SUCCEEDED" ? observation : null,
		traceEvents: [],
	} as InteractionActionResult;
}

const truthfulAdapter: InteractionAdapter = {
	id: adapterId,
	capabilities: async () => capabilities,
	observe: async () => observation,
	execute: async (input) =>
		resultFor(input, statusByCase[caseNameOf(input.actionId)]),
};

function runConformance(
	overrides: Partial<InteractionAdapterConformanceOptions> = {},
): ReturnType<typeof runInteractionAdapterConformance> {
	return runInteractionAdapterConformance({
		adapter: truthfulAdapter,
		session,
		surface: primarySurface,
		now: Date.parse(later),
		fixtures: conformanceFixtures(),
		...overrides,
	});
}

describe("computer-use-conformance", () => {
	describe("REQUIRED_INTERACTION_CONFORMANCE_CASES", () => {
		it("exposes the seven required case names in canonical order", () => {
			expect([...REQUIRED_INTERACTION_CONFORMANCE_CASES]).toEqual([
				"success",
				"failed_no_effect",
				"uncertain_effect",
				"policy_block",
				"confirmation",
				"unsupported",
				"stale_observation",
			]);
		});
	});

	describe("runInteractionLeaseConformance", () => {
		it("returns passed, frozen, deterministic contention and expiry checks", () => {
			const checks = runInteractionLeaseConformance();
			expect(Object.isFrozen(checks)).toBe(true);
			expect(checks.map((check) => check.name)).toEqual([
				"lease_contention",
				"lease_expiry",
			]);
			expect(checks.every((check) => check.passed)).toBe(true);
			expect(checks.every((check) => check.detail.length > 0)).toBe(true);
			expect(runInteractionLeaseConformance()).toEqual(checks);
		});
	});

	describe("runInteractionAdapterConformance", () => {
		it("passes a truthful adapter and freezes the report envelope", async () => {
			const report = await runConformance();
			expect(report.passed).toBe(true);
			expect(report.adapterId).toBe(adapterId);
			expect(report.checks.map((check) => check.name)).toEqual([
				"capabilities",
				"observation",
				...REQUIRED_INTERACTION_CONFORMANCE_CASES,
				"lease_contention",
				"lease_expiry",
			]);
			expect(report.checks.every((check) => check.passed)).toBe(true);
			expect(Object.isFrozen(report)).toBe(true);
			expect(Object.isFrozen(report.checks)).toBe(true);
			expect(Object.isFrozen(report.capabilities)).toBe(true);
			expect(report.capabilities.adapterId).toBe(adapterId);
			expect(report.observation.observationId).toBe(observation.observationId);
			expect(report.observation.sequence).toBe(observation.sequence);
		});

		it("fails closed when adapter, session, and surface identifiers disagree", async () => {
			await expect(
				runConformance({
					session: { ...session, adapterId: "other-adapter" },
				}),
			).rejects.toEqual(
				expect.objectContaining({
					code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
					message: "Adapter, session, and surface identifiers do not match.",
				}),
			);
		});

		it("propagates the stale-surface guard for an outdated generation", async () => {
			await expect(
				runConformance({
					surface: { ...primarySurface, generation: 4 },
				}),
			).rejects.toEqual(
				expect.objectContaining({ code: "STALE_INTERACTION_REFERENCE" }),
			);
		});

		it("names the first missing required case", async () => {
			const incomplete = conformanceFixtures().filter(
				(fixture) => fixture.name !== "confirmation",
			);
			await expect(runConformance({ fixtures: incomplete })).rejects.toEqual(
				expect.objectContaining({
					code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
					message:
						"Missing required interaction conformance case 'confirmation'.",
				}),
			);
		});

		it("rejects duplicate fixture names even when every case is present", async () => {
			const duplicated: InteractionConformanceFixture[] = [
				...conformanceFixtures(),
				{ name: "success", action: action("case-success-duplicate") },
			];
			await expect(runConformance({ fixtures: duplicated })).rejects.toEqual(
				expect.objectContaining({
					code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
					message: "Interaction conformance case names must be unique.",
				}),
			);
		});

		it("wraps an invalid capability payload and preserves the cause", async () => {
			const invalidPayload: unknown = { contractVersion: 999 };
			const lyingAdapter: InteractionAdapter = {
				...truthfulAdapter,
				capabilities: async () => invalidPayload as InteractionCapabilitySet,
			};
			const outcome = await runConformance({ adapter: lyingAdapter }).catch(
				(error: unknown) => error,
			);
			expect(outcome).toBeInstanceOf(ElizaError);
			const conformanceError = outcome as ElizaError;
			expect(conformanceError.code).toBe(
				"INTERACTION_ADAPTER_CONFORMANCE_FAILED",
			);
			expect(conformanceError.message).toBe(
				"Adapter returned an invalid capability payload.",
			);
			expect(conformanceError.cause).toBeInstanceOf(ElizaError);
			expect((conformanceError.cause as ElizaError).code).toBe(
				"INVALID_INTERACTION_CONTRACT",
			);
		});

		it("fails closed when capabilities advertise another adapter", async () => {
			const lyingAdapter: InteractionAdapter = {
				...truthfulAdapter,
				capabilities: async () => ({
					...capabilities,
					adapterId: "someone-else",
				}),
			};
			await expect(runConformance({ adapter: lyingAdapter })).rejects.toEqual(
				expect.objectContaining({
					code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
					message: "Adapter capability identity does not match the adapter.",
				}),
			);
		});

		it("fails closed when the supplied surface kind is not advertised", async () => {
			const windowSurface: InteractionSurfaceRef = {
				...primarySurface,
				kind: "native_window",
			};
			await expect(
				runConformance({
					session: { ...session, surfaces: [windowSurface, secondarySurface] },
					surface: windowSurface,
				}),
			).rejects.toEqual(
				expect.objectContaining({
					code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
					message: "Adapter did not advertise the supplied surface kind.",
				}),
			);
		});

		it("rejects sessions that are not executable", async () => {
			await expect(
				runConformance({ session: { ...session, state: "paused" } }),
			).rejects.toEqual(
				expect.objectContaining({
					code: "INVALID_INTERACTION_CONTRACT",
					message: "Interaction session is not executable.",
				}),
			);
		});

		it("fails closed when an observation escapes the requested surface", async () => {
			const wanderingAdapter: InteractionAdapter = {
				...truthfulAdapter,
				observe: async () => ({ ...observation, surface: secondarySurface }),
			};
			await expect(
				runConformance({ adapter: wanderingAdapter }),
			).rejects.toEqual(
				expect.objectContaining({
					code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
					message: "Adapter observation escaped the requested session surface.",
				}),
			);
		});

		it("fails closed when observations use unadvertised channels", async () => {
			const lyingAdapter: InteractionAdapter = {
				...truthfulAdapter,
				observe: async () => ({ ...observation, channels: ["ocr"] }),
			};
			await expect(runConformance({ adapter: lyingAdapter })).rejects.toEqual(
				expect.objectContaining({
					code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
					message:
						"Adapter returned an observation channel it did not advertise.",
				}),
			);
		});

		it("wraps an invalid observation payload and preserves the cause", async () => {
			const invalidPayload: unknown = {};
			const lyingAdapter: InteractionAdapter = {
				...truthfulAdapter,
				observe: async () => invalidPayload as InteractionObservation,
			};
			const outcome = await runConformance({ adapter: lyingAdapter }).catch(
				(error: unknown) => error,
			);
			expect(outcome).toBeInstanceOf(ElizaError);
			const conformanceError = outcome as ElizaError;
			expect(conformanceError.message).toBe(
				"Adapter returned an invalid observation payload.",
			);
			expect(conformanceError.cause).toBeInstanceOf(ElizaError);
			expect((conformanceError.cause as ElizaError).code).toBe(
				"INVALID_INTERACTION_CONTRACT",
			);
		});

		it("rejects a fixture action that targets another registered surface", async () => {
			const misdirected = conformanceFixtures().map((fixture) =>
				fixture.name === "success"
					? {
							...fixture,
							action: { ...fixture.action, surface: secondarySurface },
						}
					: fixture,
			);
			await expect(runConformance({ fixtures: misdirected })).rejects.toEqual(
				expect.objectContaining({
					code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
					message:
						"Conformance action does not target the supplied session surface.",
				}),
			);
		});

		it("wraps an invalid action-result payload and preserves the cause", async () => {
			const invalidPayload: unknown = {};
			const lyingAdapter: InteractionAdapter = {
				...truthfulAdapter,
				execute: async () => invalidPayload as InteractionActionResult,
			};
			const outcome = await runConformance({ adapter: lyingAdapter }).catch(
				(error: unknown) => error,
			);
			expect(outcome).toBeInstanceOf(ElizaError);
			const conformanceError = outcome as ElizaError;
			expect(conformanceError.code).toBe(
				"INTERACTION_ADAPTER_CONFORMANCE_FAILED",
			);
			expect(conformanceError.message).toBe(
				"Adapter returned an invalid action result payload.",
			);
			expect(conformanceError.cause).toBeInstanceOf(ElizaError);
			expect((conformanceError.cause as ElizaError).code).toBe(
				"INVALID_INTERACTION_CONTRACT",
			);
		});

		it("rejects an unsupported fixture built on an advertised action", async () => {
			const confused = REQUIRED_INTERACTION_CONFORMANCE_CASES.map((name) => ({
				name,
				action: action(`case-${name}`),
			}));
			await expect(runConformance({ fixtures: confused })).rejects.toEqual(
				expect.objectContaining({
					code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
					message: "Unsupported-capability fixture uses an advertised action.",
				}),
			);
		});

		it("rejects a non-unsupported fixture using an unadvertised action", async () => {
			const confused = conformanceFixtures().map((fixture) =>
				fixture.name === "success"
					? { name: fixture.name, action: action("case-success", "evaluate") }
					: fixture,
			);
			await expect(runConformance({ fixtures: confused })).rejects.toEqual(
				expect.objectContaining({
					code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
					message:
						"Adapter fixture 'success' uses an action it did not advertise.",
				}),
			);
		});

		it("rejects a stale-observation fixture with no observation binding", async () => {
			const detached = conformanceFixtures().map((fixture) =>
				fixture.name === "stale_observation"
					? {
							name: fixture.name,
							action: {
								...fixture.action,
								observationId: null,
								observationSequence: null,
							} as InteractionAction,
						}
					: fixture,
			);
			await expect(runConformance({ fixtures: detached })).rejects.toEqual(
				expect.objectContaining({
					code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
					message:
						"Stale-observation fixture references the current observation.",
				}),
			);
		});

		it("fails closed with expected and actual status context on lies", async () => {
			const alwaysSuccessAdapter: InteractionAdapter = {
				...truthfulAdapter,
				execute: async (input) => resultFor(input, "SUCCEEDED"),
			};
			await expect(
				runConformance({ adapter: alwaysSuccessAdapter }),
			).rejects.toEqual(
				expect.objectContaining({
					code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
					message: "Adapter returned the wrong status for 'failed_no_effect'.",
					context: expect.objectContaining({
						expectedStatus: "FAILED_NO_EFFECT",
						actualStatus: "SUCCEEDED",
					}),
				}),
			);
		});
	});
});
