/**
 * Deterministic contract tests for browser and native computer-use adapters.
 * The harness uses an in-process adapter rather than a mocked model or OS, and
 * exercises validation, side-effect classification, confirmation, isolation,
 * stale references, and concurrent resource leases.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.ts";
import {
	REQUIRED_INTERACTION_CONFORMANCE_CASES,
	runInteractionAdapterConformance,
} from "../testing/computer-use-conformance.ts";
import {
	assertInteractionSurfaceCurrent,
	INTERACTION_CONTRACT_VERSION,
	type InteractionAction,
	type InteractionActionResult,
	type InteractionAdapter,
	type InteractionCapabilitySet,
	InteractionLeaseCoordinator,
	type InteractionObservation,
	type InteractionOutcomeStatus,
	type InteractionSession,
	type InteractionSurfaceRef,
	interactionActionDigest,
	normalizeInteractionActionResult,
	normalizeInteractionCapabilitySet,
	normalizeInteractionConfirmationPreview,
	normalizeInteractionObservation,
} from "./computer-use.ts";

const adapterId = "deterministic-computer-use";
const sessionId = "session-1";
const now = "2026-01-01T00:00:00.000Z";
const later = "2026-01-01T00:00:01.000Z";

const surface: InteractionSurfaceRef = {
	sessionId,
	adapterId,
	surfaceId: "surface-1",
	kind: "browser_tab",
	generation: 3,
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
	generation: 3,
	createdAt: now,
	updatedAt: now,
	expiresAt: null,
	surfaces: [surface],
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
	surface,
	sequence: 7,
	observedAt: now,
	channels: ["dom", "screenshot"],
	artifacts: [
		{
			kind: "screenshot",
			uri: "memory://screenshot-1",
			sha256: "a".repeat(64),
			mimeType: "image/png",
			width: 1440,
			height: 900,
		},
	],
	viewport: { x: 0, y: 0, width: 1440, height: 900 },
	cursor: { x: 20, y: 30 },
	redactions: [],
};

function action(actionId: string, kind: "observe" | "evaluate" = "observe") {
	if (kind === "evaluate") {
		return {
			contractVersion: INTERACTION_CONTRACT_VERSION,
			actionId,
			sessionId,
			adapterId,
			surface,
			kind,
			payload: { expression: "document.title" },
			observationId: observation.observationId,
			observationSequence: observation.sequence,
			requestedAt: now,
		} satisfies InteractionAction;
	}
	return {
		contractVersion: INTERACTION_CONTRACT_VERSION,
		actionId,
		sessionId,
		adapterId,
		surface,
		kind,
		payload: {},
		observationId: observation.observationId,
		observationSequence: observation.sequence,
		requestedAt: now,
	} satisfies InteractionAction;
}

const statusByActionId: Readonly<Record<string, InteractionOutcomeStatus>> = {
	"case-success": "SUCCEEDED",
	"case-failed_no_effect": "FAILED_NO_EFFECT",
	"case-uncertain_effect": "UNCERTAIN_EFFECT",
	"case-policy_block": "BLOCKED_BY_POLICY",
	"case-confirmation": "NEEDS_CONFIRMATION",
	"case-unsupported": "UNSUPPORTED",
	"case-stale_observation": "STALE_OBSERVATION",
	"case-lease_conflict": "LEASE_CONFLICT",
};

function resultFor(input: InteractionAction): InteractionActionResult {
	const status = statusByActionId[input.actionId];
	if (!status)
		throw new Error(`Unknown deterministic action ${input.actionId}`);
	const needsConfirmation = status === "NEEDS_CONFIRMATION";
	const needsError = status !== "SUCCEEDED" && !needsConfirmation;
	return {
		contractVersion: INTERACTION_CONTRACT_VERSION,
		actionId: input.actionId,
		sessionId,
		adapterId,
		status,
		startedAt: now,
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
					confirmationId: "confirmation-1",
					actionId: input.actionId,
					taxonomy: "external_send",
					origin: "https://example.test",
					destination: "https://recipient.test",
					disclosures: ["draft text"],
					consequence: "Sends a message to the configured recipient.",
					actionDigest: interactionActionDigest(input),
					requestedAt: now,
					expiresAt: "2026-01-01T00:05:00.000Z",
				}
			: null,
		evidence: {
			beforeObservationId: observation.observationId,
			afterObservationId:
				status === "SUCCEEDED" ? observation.observationId : null,
			adapterTraceId: `trace-${input.actionId}`,
			actualTarget: surface.surfaceId,
		},
		effectReceipts:
			status === "SUCCEEDED"
				? [
						{
							receiptId: "receipt-1",
							operation: "computer.observe",
							resource: { kind: "browser.tab", id: surface.surfaceId },
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
	};
}

const adapter: InteractionAdapter = {
	id: adapterId,
	capabilities: async () => capabilities,
	observe: async () => observation,
	execute: async (input) => {
		if (input.actionId === "case-invalid_payload") {
			return { invalid: true } as unknown as InteractionActionResult;
		}
		return resultFor(input);
	},
};

describe("computer-use interaction contracts", () => {
	it("normalizes and freezes capability declarations", () => {
		const normalized = normalizeInteractionCapabilitySet({
			...capabilities,
			controlPlanes: ["browser", "browser"],
			ignored: "discard me",
		});
		expect(normalized.controlPlanes).toEqual(["browser"]);
		expect(normalized).not.toHaveProperty("ignored");
		expect(Object.isFrozen(normalized)).toBe(true);
		expect(Object.isFrozen(normalized.concurrency)).toBe(true);
	});

	it("rejects unadvertisable capability values", () => {
		expect(() =>
			normalizeInteractionCapabilitySet({
				...capabilities,
				actionKinds: ["teleport"],
			}),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("requires explicit grants for existing browser profiles", () => {
		expect(() =>
			normalizeInteractionCapabilitySet({
				...capabilities,
				profileAccess: {
					modes: ["existing_explicit"],
					requiresExplicitGrant: false,
				},
			}),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("does not allow foreground requirements to exceed advertised actions", () => {
		expect(() =>
			normalizeInteractionCapabilitySet({
				...capabilities,
				background: {
					mode: "semantic_only",
					requiresForeground: ["click"],
				},
			}),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("normalizes observations and rejects cross-session surfaces", () => {
		const normalized = normalizeInteractionObservation({
			...observation,
			ignored: true,
		});
		expect(normalized).not.toHaveProperty("ignored");
		expect(Object.isFrozen(normalized.artifacts)).toBe(true);
		expect(() =>
			normalizeInteractionObservation({
				...observation,
				sessionId: "other-session",
			}),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("reuses canonical effect receipts in successful action results", () => {
		const succeededAction = action("case-success");
		const normalized = normalizeInteractionActionResult(
			{
				...resultFor(succeededAction),
				ignored: "discard me",
			},
			succeededAction,
		);
		expect(normalized.status).toBe("SUCCEEDED");
		expect(normalized.effectReceipts).toHaveLength(1);
		expect(normalized.effectReceipts[0]?.outcome).toBe("applied");
		expect(normalized).not.toHaveProperty("ignored");
	});

	it("forbids automatic retry after an uncertain effect", () => {
		const uncertainAction = action("case-uncertain_effect");
		const uncertain = resultFor(uncertainAction);
		expect(() =>
			normalizeInteractionActionResult(
				{
					...uncertain,
					error: { ...uncertain.error, retryable: true },
				},
				uncertainAction,
			),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("requires a complete, expiring confirmation preview", () => {
		const normalized = normalizeInteractionConfirmationPreview({
			confirmationId: "confirmation-1",
			actionId: "action-1",
			taxonomy: "purchase",
			origin: "https://merchant.test",
			destination: "https://merchant.test/checkout",
			disclosures: ["shipping address"],
			consequence: "Places the order.",
			actionDigest: `sha256:${"a".repeat(64)}`,
			requestedAt: now,
			expiresAt: later,
		});
		expect(normalized.destination).toContain("checkout");
		expect(() =>
			normalizeInteractionConfirmationPreview({
				...normalized,
				expiresAt: now,
			}),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("rejects impossible calendar timestamps", () => {
		expect(() =>
			normalizeInteractionConfirmationPreview({
				confirmationId: "confirmation-1",
				actionId: "action-1",
				taxonomy: "purchase",
				origin: null,
				destination: null,
				disclosures: [],
				consequence: "Places the order.",
				actionDigest: `sha256:${"a".repeat(64)}`,
				requestedAt: "2026-02-30T00:00:00.000Z",
				expiresAt: later,
			}),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("binds confirmation and observation evidence to the result action", () => {
		const confirmationAction = action("case-confirmation");
		const confirmationResult = resultFor(confirmationAction);
		expect(() =>
			normalizeInteractionActionResult(
				{
					...confirmationResult,
					confirmation: {
						...confirmationResult.confirmation,
						actionId: "another-action",
					},
				},
				confirmationAction,
			),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
		expect(() =>
			normalizeInteractionActionResult(
				{
					...confirmationResult,
					confirmation: {
						...confirmationResult.confirmation,
						actionDigest: `sha256:${"b".repeat(64)}`,
					},
				},
				confirmationAction,
			),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);

		const succeeded = resultFor(action("case-success"));
		const succeededAction = action("case-success");
		expect(() =>
			normalizeInteractionActionResult(
				{
					...succeeded,
					evidence: {
						...succeeded.evidence,
						afterObservationId: "another-observation",
					},
				},
				succeededAction,
			),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("rejects committed effect proof on non-success outcomes", () => {
		const failedAction = action("case-failed_no_effect");
		const failed = resultFor(failedAction);
		const applied = resultFor(action("case-success")).effectReceipts;
		expect(() =>
			normalizeInteractionActionResult(
				{
					...failed,
					effectReceipts: applied,
				},
				failedAction,
			),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("rejects stale and cross-session surface references", () => {
		expect(() =>
			assertInteractionSurfaceCurrent(session, {
				...surface,
				generation: 2,
			}),
		).toThrowError(
			expect.objectContaining({ code: "STALE_INTERACTION_REFERENCE" }),
		);
		expect(() =>
			assertInteractionSurfaceCurrent(session, {
				...surface,
				sessionId: "other-session",
			}),
		).toThrowError(
			expect.objectContaining({
				code: "INTERACTION_CROSS_SESSION_REFERENCE",
			}),
		);
		expect(() =>
			assertInteractionSurfaceCurrent(session, {
				...surface,
				parentSurfaceId: "forged-parent",
			}),
		).toThrowError(
			expect.objectContaining({ code: "INTERACTION_SURFACE_NOT_FOUND" }),
		);
	});

	it("enforces exclusive leases, expiry, and current-owner release", () => {
		let clock = Date.parse(now);
		const coordinator = new InteractionLeaseCoordinator(() => clock);
		const first = coordinator.acquire({
			leaseId: "lease-1",
			sessionId,
			ownerId: "owner-1",
			resourceKind: "physical_pointer",
			resourceId: "local",
			generation: 1,
			ttlMs: 100,
		});
		expect(() =>
			coordinator.acquire({
				leaseId: "lease-2",
				sessionId: "session-2",
				ownerId: "owner-2",
				resourceKind: "physical_pointer",
				resourceId: "local",
				generation: 1,
				ttlMs: 100,
			}),
		).toThrowError(
			expect.objectContaining({ code: "INTERACTION_LEASE_CONFLICT" }),
		);
		clock += 101;
		expect(() => coordinator.assertHeld(first)).toThrowError(
			expect.objectContaining({ code: "STALE_INTERACTION_LEASE" }),
		);
		const second = coordinator.acquire({
			leaseId: "lease-2",
			sessionId: "session-2",
			ownerId: "owner-2",
			resourceKind: "physical_pointer",
			resourceId: "local",
			generation: 1,
			ttlMs: 100,
		});
		expect(coordinator.release(second)).toBe(true);
		expect(() =>
			coordinator.acquire({
				leaseId: "lease-overflow",
				sessionId,
				ownerId: "owner-1",
				resourceKind: "clipboard",
				resourceId: "overflow",
				generation: 1,
				ttlMs: Number.MAX_VALUE,
			}),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});
});

describe("computer-use adapter conformance", () => {
	it("covers every required action outcome and lease contention", async () => {
		const report = await runInteractionAdapterConformance({
			adapter,
			session,
			surface,
			fixtures: REQUIRED_INTERACTION_CONFORMANCE_CASES.map((name) => ({
				name,
				action: action(
					`case-${name}`,
					name === "unsupported" ? "evaluate" : "observe",
				),
			})),
		});
		expect(report.passed).toBe(true);
		expect(report.checks.map((check) => check.name)).toEqual([
			"capabilities",
			"observation",
			...REQUIRED_INTERACTION_CONFORMANCE_CASES,
			"lease_contention",
			"lease_expiry",
		]);
	});

	it("fails closed when a required scenario is missing", async () => {
		await expect(
			runInteractionAdapterConformance({
				adapter,
				session,
				surface,
				fixtures: [],
			}),
		).rejects.toEqual(
			expect.objectContaining({
				code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
			}),
		);
	});

	it("fails closed when an adapter lies about result identity", async () => {
		const lyingAdapter: InteractionAdapter = {
			...adapter,
			execute: async (input) => ({
				...resultFor(input),
				sessionId: "other-session",
			}),
		};
		await expect(
			runInteractionAdapterConformance({
				adapter: lyingAdapter,
				session,
				surface,
				fixtures: REQUIRED_INTERACTION_CONFORMANCE_CASES.map((name) => ({
					name,
					action: action(
						`case-${name}`,
						name === "unsupported" ? "evaluate" : "observe",
					),
				})),
			}),
		).rejects.toEqual(
			expect.objectContaining({
				code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
			}),
		);
	});

	it("requires the unsupported scenario to exercise an unadvertised action", async () => {
		await expect(
			runInteractionAdapterConformance({
				adapter,
				session,
				surface,
				fixtures: REQUIRED_INTERACTION_CONFORMANCE_CASES.map((name) => ({
					name,
					action: action(`case-${name}`),
				})),
			}),
		).rejects.toEqual(
			expect.objectContaining({
				code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
			}),
		);
	});
});

describe("typed error boundary", () => {
	it("uses ElizaError for invalid adapter payloads", () => {
		try {
			normalizeInteractionCapabilitySet(null);
			throw new Error("expected contract validation to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe("INVALID_INTERACTION_CONTRACT");
		}
	});
});
