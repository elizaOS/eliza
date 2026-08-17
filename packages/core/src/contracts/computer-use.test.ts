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
	assertInteractionSessionExecutable,
	assertInteractionSurfaceCurrent,
	authorizeInteractionDispatch,
	computeInteractionActionDigest,
	INTERACTION_CONTRACT_VERSION,
	type InteractionAction,
	type InteractionActionResult,
	type InteractionAdapter,
	type InteractionCapabilitySet,
	InteractionConfirmationCoordinator,
	InteractionLeaseCoordinator,
	type InteractionObservation,
	type InteractionOutcomeStatus,
	type InteractionSession,
	type InteractionSurfaceRef,
	normalizeInteractionAction,
	normalizeInteractionActionResult,
	normalizeInteractionCapabilitySet,
	normalizeInteractionConfirmationPreview,
	normalizeInteractionObservation,
	normalizeInteractionSession,
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
	profileGrant: null,
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
	traceEvents: [],
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
			confirmationGrant: null,
			leaseIds: [],
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
		observationSequence:
			actionId === "case-stale_observation"
				? observation.sequence - 1
				: observation.sequence,
		requestedAt: now,
		confirmationGrant: null,
		leaseIds: [],
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
					confirmationId: "confirmation-1",
					actionId: input.actionId,
					taxonomy: "external_send",
					origin: "https://example.test",
					destination: "https://recipient.test",
					disclosures: ["draft text"],
					consequence: "Sends a message to the configured recipient.",
					actionDigest: computeInteractionActionDigest(input),
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
		traceEvents: [],
	} as InteractionActionResult;
}

const adapter: InteractionAdapter = {
	id: adapterId,
	capabilities: async () => capabilities,
	observe: async () => observation,
	execute: async (input) => resultFor(input),
};

function authorize(value: unknown) {
	return authorizeInteractionDispatch(value, {
		session,
		capabilities,
		now: Date.parse(now),
		leaseRequirements: [],
	});
}

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

	it("keeps sensitive trace values structurally redacted", () => {
		const traceEvent = {
			eventId: "event-1",
			sessionId,
			adapterId,
			surfaceId: surface.surfaceId,
			actionId: null,
			observationId: observation.observationId,
			sequence: 1,
			occurredAt: now,
			kind: "observation_captured",
			status: null,
			attributes: [
				{
					classification: "credential",
					name: "password",
					value: null,
					opaqueToken: "host-hmac-token-1",
					reason: "credential",
				},
			],
		};
		const normalized = normalizeInteractionObservation({
			...observation,
			traceEvents: [traceEvent],
		});
		expect(normalized.traceEvents[0]?.attributes[0]?.value).toBeNull();
		expect(() =>
			normalizeInteractionObservation({
				...observation,
				traceEvents: [
					{
						...traceEvent,
						attributes: [{ ...traceEvent.attributes[0], value: "raw-secret" }],
					},
				],
			}),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("reuses canonical effect receipts in successful action results", async () => {
		const input = await authorize(action("case-success"));
		const normalized = normalizeInteractionActionResult(
			{
				...resultFor(input),
				ignored: "discard me",
			},
			{ action: input, session, capabilities, now: Date.parse(later) },
		);
		expect(normalized.status).toBe("SUCCEEDED");
		expect(normalized.effectReceipts).toHaveLength(1);
		expect(normalized.effectReceipts[0]?.outcome).toBe("applied");
		expect(normalized).not.toHaveProperty("ignored");
	});

	it("forbids automatic retry after an uncertain effect", async () => {
		const input = await authorize(action("case-uncertain_effect"));
		const uncertain = resultFor(input);
		expect(() =>
			normalizeInteractionActionResult(
				{
					...uncertain,
					error: { ...uncertain.error, retryable: true },
				},
				{ action: input, session, capabilities, now: Date.parse(later) },
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
			actionDigest: "a".repeat(64),
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

	it("binds confirmations and effect receipts to the exact action outcome", async () => {
		const confirmationAction = await authorize(action("case-confirmation"));
		const confirmationResult = resultFor(confirmationAction);
		if (confirmationResult.status !== "NEEDS_CONFIRMATION") {
			throw new Error("expected confirmation fixture");
		}
		expect(() =>
			normalizeInteractionActionResult(
				{
					...confirmationResult,
					confirmation: {
						...confirmationResult.confirmation,
						actionId: "another-action",
					},
				},
				{
					action: confirmationAction,
					session,
					capabilities,
					now: Date.parse(later),
				},
			),
		).toThrowError(
			expect.objectContaining({ code: "INTERACTION_CONFIRMATION_MISMATCH" }),
		);

		const coordinator = new InteractionConfirmationCoordinator();
		const preview = coordinator.register(
			confirmationResult.confirmation,
			confirmationAction,
			Date.parse(later),
		);
		const grant = coordinator.issue(
			preview.confirmationId,
			confirmationAction,
			later,
			Date.parse(later),
		);
		const confirmedAction = await authorizeInteractionDispatch(
			{ ...confirmationAction, confirmationGrant: grant },
			{
				session,
				capabilities,
				now: Date.parse(later),
				confirmationGrantConsumer: coordinator,
				leaseRequirements: [],
			},
		);
		await expect(
			authorizeInteractionDispatch(
				{ ...confirmationAction, confirmationGrant: grant },
				{
					session,
					capabilities,
					now: Date.parse(later),
					confirmationGrantConsumer: coordinator,
					leaseRequirements: [],
				},
			),
		).rejects.toThrowError(
			expect.objectContaining({ code: "STALE_INTERACTION_CONFIRMATION" }),
		);
		expect(
			normalizeInteractionActionResult(
				{
					...resultFor(confirmedAction),
					startedAt: later,
					completedAt: later,
				},
				{
					action: confirmedAction,
					session,
					capabilities,
					now: Date.parse(later),
				},
			).actionId,
		).toBe(confirmedAction.actionId);

		const concurrentCoordinator = new InteractionConfirmationCoordinator();
		const concurrentPreview = concurrentCoordinator.register(
			confirmationResult.confirmation,
			confirmationAction,
			Date.parse(later),
		);
		const concurrentGrant = concurrentCoordinator.issue(
			concurrentPreview.confirmationId,
			confirmationAction,
			later,
			Date.parse(later),
		);
		const concurrentValue = {
			...confirmationAction,
			confirmationGrant: concurrentGrant,
		};
		const attempts = await Promise.allSettled([
			authorizeInteractionDispatch(concurrentValue, {
				session,
				capabilities,
				now: Date.parse(later),
				confirmationGrantConsumer: concurrentCoordinator,
				leaseRequirements: [],
			}),
			authorizeInteractionDispatch(concurrentValue, {
				session,
				capabilities,
				now: Date.parse(later),
				confirmationGrantConsumer: concurrentCoordinator,
				leaseRequirements: [],
			}),
		]);
		expect(
			attempts.filter((attempt) => attempt.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			attempts.filter((attempt) => attempt.status === "rejected"),
		).toHaveLength(1);

		let dispatchClock = Date.parse(later);
		const leaseCoordinator = new InteractionLeaseCoordinator(
			() => dispatchClock,
		);
		const expiringLease = leaseCoordinator.acquire({
			leaseId: "confirmation-pointer-lease",
			sessionId,
			ownerId: session.ownerId,
			resourceKind: "physical_pointer",
			resourceId: "local",
			generation: session.generation,
			ttlMs: 100,
		});
		const deferredCoordinator = new InteractionConfirmationCoordinator();
		const deferredPreview = deferredCoordinator.register(
			confirmationResult.confirmation,
			confirmationAction,
			dispatchClock,
		);
		const deferredGrant = deferredCoordinator.issue(
			deferredPreview.confirmationId,
			confirmationAction,
			later,
			dispatchClock,
		);
		let releaseConsume: (() => void) | undefined;
		const consumeGate = new Promise<void>((resolve) => {
			releaseConsume = resolve;
		});
		const deferredAuthorization = authorizeInteractionDispatch(
			{
				...confirmationAction,
				confirmationGrant: deferredGrant,
				leaseIds: [expiringLease.leaseId],
			},
			{
				session,
				capabilities,
				clock: () => dispatchClock,
				confirmationGrantConsumer: {
					consume: async (grant, candidate, consumedAt) => {
						await consumeGate;
						await deferredCoordinator.consume(grant, candidate, consumedAt);
					},
				},
				leaseCoordinator,
				leaseRequirements: [
					{ resourceKind: "physical_pointer", resourceId: "local" },
				],
			},
		);
		dispatchClock += 200;
		leaseCoordinator.acquire({
			leaseId: "replacement-pointer-lease",
			sessionId: "other-session",
			ownerId: "other-owner",
			resourceKind: "physical_pointer",
			resourceId: "local",
			generation: session.generation,
			ttlMs: 1_000,
		});
		releaseConsume?.();
		await expect(deferredAuthorization).rejects.toEqual(
			expect.objectContaining({ code: "INTERACTION_LEASE_CONFLICT" }),
		);

		const stoppedSession = { ...session };
		const stateCoordinator = new InteractionConfirmationCoordinator();
		const statePreview = stateCoordinator.register(
			confirmationResult.confirmation,
			confirmationAction,
			Date.parse(later),
		);
		const stateGrant = stateCoordinator.issue(
			statePreview.confirmationId,
			confirmationAction,
			later,
			Date.parse(later),
		);
		const stoppedAuthorization = authorizeInteractionDispatch(
			{ ...confirmationAction, confirmationGrant: stateGrant },
			{
				session: stoppedSession,
				capabilities,
				clock: () => Date.parse(later),
				confirmationGrantConsumer: {
					consume: async (grant, candidate, consumedAt) => {
						stoppedSession.state = "stopped";
						await stateCoordinator.consume(grant, candidate, consumedAt);
					},
				},
				leaseRequirements: [],
			},
		);
		await expect(stoppedAuthorization).rejects.toEqual(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);

		const failedAction = await authorize(action("case-failed_no_effect"));
		expect(() =>
			normalizeInteractionActionResult(
				{
					...resultFor(failedAction),
					effectReceipts: resultFor(
						normalizeInteractionAction(action("case-success"), { session }),
					).effectReceipts,
				},
				{
					action: failedAction,
					session,
					capabilities,
					now: Date.parse(later),
				},
			),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("digests normalized action semantics and rejects half-bound observations", () => {
		const first = normalizeInteractionAction(
			action("digest-action", "evaluate"),
			{
				session,
			},
		);
		const reordered = normalizeInteractionAction(
			{
				...action("digest-action", "evaluate"),
				payload: { expression: "document.title" },
			},
			{ session },
		);
		expect(computeInteractionActionDigest(first)).toBe(
			computeInteractionActionDigest(reordered),
		);
		const changed = normalizeInteractionAction(
			{
				...action("digest-action", "evaluate"),
				payload: { expression: "document.URL" },
			},
			{ session },
		);
		expect(computeInteractionActionDigest(changed)).not.toBe(
			computeInteractionActionDigest(first),
		);
		expect(() =>
			normalizeInteractionAction(
				{ ...action("bad-binding"), observationSequence: null },
				{ session },
			),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("preserves semantic text and rejects targetless actions", () => {
		const setValue = normalizeInteractionAction(
			{
				...action("set-value"),
				kind: "set_value",
				payload: {
					text: "  secret with spaces  ",
					elementId: null,
					sensitive: true,
				},
			},
			{ session },
		);
		expect(setValue.kind === "set_value" && setValue.payload.text).toBe(
			"  secret with spaces  ",
		);
		const clearClipboard = normalizeInteractionAction(
			{
				...action("clear-clipboard"),
				kind: "set_clipboard",
				payload: { text: "", sensitive: false },
			},
			{ session },
		);
		expect(
			clearClipboard.kind === "set_clipboard" && clearClipboard.payload.text,
		).toBe("");
		expect(() =>
			normalizeInteractionAction(
				{
					...action("targetless"),
					kind: "click",
					payload: { elementId: null, point: null },
				},
				{ session },
			),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("separates lifecycle normalization from execution authorization", () => {
		const paused = normalizeInteractionSession(
			{ ...session, state: "paused" },
			{ capabilities },
		);
		expect(paused.state).toBe("paused");
		expect(() =>
			assertInteractionSessionExecutable(paused, {
				capabilities,
				now: Date.parse(later),
			}),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("rejects backdated results and uncertain no-effect receipts", async () => {
		const input = await authorize(action("case-failed_no_effect"));
		expect(() =>
			normalizeInteractionActionResult(resultFor(input), {
				action: input,
				session,
				capabilities,
				now: Date.parse(now),
			}),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
		expect(() =>
			normalizeInteractionActionResult(
				{
					...resultFor(input),
					effectReceipts: [
						{
							receiptId: "unknown-effect",
							operation: "computer.click",
							resource: { kind: "browser.tab", id: surface.surfaceId },
							artifacts: [],
							idempotency: { key: null, replayed: false },
							observedAt: later,
							outcome: "failed",
							failure: {
								code: "UNKNOWN",
								retryable: false,
								acceptance: "unknown",
							},
						},
					],
				},
				{
					action: input,
					session,
					capabilities,
					now: Date.parse(later),
				},
			),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
	});

	it("requires a current explicit grant for existing signed-in profiles", () => {
		const explicitCapabilities = normalizeInteractionCapabilitySet({
			...capabilities,
			profileAccess: {
				modes: ["existing_explicit"],
				requiresExplicitGrant: true,
			},
		});
		expect(() =>
			normalizeInteractionSession(
				{ ...session, profileMode: "existing_explicit", profileGrant: null },
				{ capabilities: explicitCapabilities, now: Date.parse(now) },
			),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
		const granted = assertInteractionSessionExecutable(
			{
				...session,
				profileMode: "existing_explicit",
				profileGrant: {
					grantId: "grant-1",
					sessionId,
					ownerId: session.ownerId,
					adapterId,
					profileHandle: "profile-1",
					issuedAt: now,
					expiresAt: "2026-01-01T01:00:00.000Z",
				},
			},
			{
				capabilities: explicitCapabilities,
				now: Date.parse(later),
				profileGrantVerifier: { verify: () => true },
			},
		);
		expect(granted.profileGrant?.grantId).toBe("grant-1");
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
			normalizeInteractionSession(
				{
					...session,
					surfaces: [
						{
							...surface,
							surfaceId: "surface-a",
							parentSurfaceId: "surface-b",
						},
						{
							...surface,
							surfaceId: "surface-b",
							parentSurfaceId: "surface-a",
						},
					],
				},
				{ capabilities },
			),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
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
		expect(
			coordinator.acquire({
				leaseId: "lease-1",
				sessionId,
				ownerId: "owner-1",
				resourceKind: "physical_pointer",
				resourceId: " local ",
				generation: 1,
				ttlMs: 100,
			}),
		).toBe(first);
		expect(() =>
			coordinator.acquire({
				leaseId: "lease-other",
				sessionId,
				ownerId: "owner-1",
				resourceKind: "physical_pointer",
				resourceId: "local",
				generation: 1,
				ttlMs: 100,
			}),
		).toThrowError(
			expect.objectContaining({ code: "INTERACTION_LEASE_CONFLICT" }),
		);
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
				leaseId: "overflow",
				sessionId,
				ownerId: "owner-1",
				resourceKind: "physical_pointer",
				resourceId: "local",
				generation: 1,
				ttlMs: Number.MAX_VALUE,
			}),
		).toThrowError(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);

		let actionClock = Date.parse(now);
		const actionLeases = new InteractionLeaseCoordinator(() => actionClock);
		const actionLease = actionLeases.acquire({
			leaseId: "action-pointer",
			sessionId,
			ownerId: session.ownerId,
			resourceKind: "physical_pointer",
			resourceId: "local",
			generation: session.generation,
			ttlMs: 1_000,
		});
		const leasedAction = normalizeInteractionAction(
			{ ...action("case-success"), leaseIds: [actionLease.leaseId] },
			{ session },
		);
		expect(
			actionLeases.assertActionLeases(leasedAction, session, [
				{ resourceKind: "physical_pointer", resourceId: " local " },
			]),
		).toEqual([actionLease]);
		const renewed = actionLeases.renew(
			{ ...actionLease, acquiredAt: "1999-01-01T00:00:00.000Z" },
			500,
		);
		expect(renewed.acquiredAt).toBe(actionLease.acquiredAt);
		actionClock = Number.NaN;
		expect(() => actionLeases.assertHeld(renewed)).toThrowError(
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
			now: Date.parse(later),
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

	it("rejects advertised unsupported and non-stale observation fixtures", async () => {
		const fixtures = REQUIRED_INTERACTION_CONFORMANCE_CASES.map((name) => ({
			name,
			action: action(
				`case-${name}`,
				name === "unsupported" ? "evaluate" : "observe",
			),
		}));
		await expect(
			runInteractionAdapterConformance({
				adapter,
				session,
				surface,
				now: Date.parse(later),
				fixtures: fixtures.map((fixture) =>
					fixture.name === "unsupported"
						? { ...fixture, action: action("case-unsupported") }
						: fixture,
				),
			}),
		).rejects.toEqual(
			expect.objectContaining({
				code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
			}),
		);
		await expect(
			runInteractionAdapterConformance({
				adapter,
				session,
				surface,
				now: Date.parse(later),
				fixtures: fixtures.map((fixture) =>
					fixture.name === "stale_observation"
						? {
								...fixture,
								action: {
									...fixture.action,
									observationSequence: observation.sequence,
								},
							}
						: fixture,
				),
			}),
		).rejects.toEqual(
			expect.objectContaining({
				code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
			}),
		);
	});

	it("forwards explicit-profile verification through conformance", async () => {
		const profileCapabilities: InteractionCapabilitySet = {
			...capabilities,
			profileAccess: {
				modes: ["existing_explicit"],
				requiresExplicitGrant: true,
			},
		};
		const profileSession: InteractionSession = {
			...session,
			profileMode: "existing_explicit",
			profileGrant: {
				grantId: "profile-conformance-grant",
				sessionId,
				ownerId: session.ownerId,
				adapterId,
				profileHandle: "signed-in-profile",
				issuedAt: now,
				expiresAt: "2026-01-01T00:05:00.000Z",
			},
		};
		const profileAdapter: InteractionAdapter = {
			...adapter,
			capabilities: async () => profileCapabilities,
		};
		const fixtures = REQUIRED_INTERACTION_CONFORMANCE_CASES.map((name) => ({
			name,
			action: action(
				`case-${name}`,
				name === "unsupported" ? "evaluate" : "observe",
			),
		}));
		await expect(
			runInteractionAdapterConformance({
				adapter: profileAdapter,
				session: profileSession,
				surface,
				now: Date.parse(later),
				fixtures,
			}),
		).rejects.toEqual(
			expect.objectContaining({ code: "INVALID_INTERACTION_CONTRACT" }),
		);
		const report = await runInteractionAdapterConformance({
			adapter: profileAdapter,
			session: profileSession,
			surface,
			now: Date.parse(later),
			fixtures,
			profileGrantVerifier: { verify: () => true },
		});
		expect(report.passed).toBe(true);
	});

	it("fails closed when a required scenario is missing", async () => {
		await expect(
			runInteractionAdapterConformance({
				adapter,
				session,
				surface,
				now: Date.parse(later),
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
				now: Date.parse(later),
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

	it("fails closed when observations exceed advertised capabilities", async () => {
		const lyingAdapter: InteractionAdapter = {
			...adapter,
			observe: async () => ({ ...observation, channels: ["ocr"] }),
		};
		await expect(
			runInteractionAdapterConformance({
				adapter: lyingAdapter,
				session,
				surface,
				now: Date.parse(later),
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
