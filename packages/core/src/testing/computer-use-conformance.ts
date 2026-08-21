/**
 * Deterministic conformance runner for browser and computer-use adapters. It
 * validates capability truthfulness, session/surface isolation, side-effect
 * outcome classification, confirmation previews, and exclusive lease behavior
 * without requiring a particular browser, operating system, or model.
 */

import {
	assertInteractionSessionExecutable,
	assertInteractionSurfaceCurrent,
	authorizeInteractionDispatch,
	type InteractionAction,
	type InteractionAdapter,
	type InteractionCapabilitySet,
	InteractionLeaseCoordinator,
	type InteractionObservation,
	type InteractionOutcomeStatus,
	type InteractionProfileGrantVerifier,
	type InteractionSession,
	type InteractionSurfaceRef,
	normalizeInteractionAction,
	normalizeInteractionActionResult,
	normalizeInteractionCapabilitySet,
	normalizeInteractionObservation,
} from "../contracts/computer-use.ts";
import { ElizaError } from "../errors.ts";

export const REQUIRED_INTERACTION_CONFORMANCE_CASES = [
	"success",
	"failed_no_effect",
	"uncertain_effect",
	"policy_block",
	"confirmation",
	"unsupported",
	"stale_observation",
] as const;

export type InteractionConformanceCaseName =
	(typeof REQUIRED_INTERACTION_CONFORMANCE_CASES)[number];

const EXPECTED_STATUS: Readonly<
	Record<InteractionConformanceCaseName, InteractionOutcomeStatus>
> = Object.freeze({
	success: "SUCCEEDED",
	failed_no_effect: "FAILED_NO_EFFECT",
	uncertain_effect: "UNCERTAIN_EFFECT",
	policy_block: "BLOCKED_BY_POLICY",
	confirmation: "NEEDS_CONFIRMATION",
	unsupported: "UNSUPPORTED",
	stale_observation: "STALE_OBSERVATION",
});

export interface InteractionConformanceFixture {
	name: InteractionConformanceCaseName;
	action: InteractionAction;
}

export interface InteractionAdapterConformanceOptions {
	adapter: InteractionAdapter;
	session: InteractionSession;
	surface: InteractionSurfaceRef;
	fixtures: readonly InteractionConformanceFixture[];
	/** Trusted deterministic clock used for every expiry and chronology check. */
	now?: number;
	profileGrantVerifier?: InteractionProfileGrantVerifier;
}

export interface InteractionConformanceCheck {
	name: string;
	passed: boolean;
	detail: string;
}

export interface InteractionConformanceReport {
	adapterId: string;
	capabilities: InteractionCapabilitySet;
	observation: InteractionObservation;
	checks: readonly InteractionConformanceCheck[];
	passed: boolean;
}

function fail(message: string, context: Record<string, unknown> = {}): never {
	throw new ElizaError(message, {
		code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
		context,
		severity: "fatal",
	});
}

function ensureActionIdentity(
	action: InteractionAction,
	session: InteractionSession,
	surface: InteractionSurfaceRef,
): void {
	if (
		action.sessionId !== session.sessionId ||
		action.adapterId !== session.adapterId ||
		action.surface.sessionId !== surface.sessionId ||
		action.surface.adapterId !== surface.adapterId ||
		action.surface.surfaceId !== surface.surfaceId ||
		action.surface.generation !== surface.generation ||
		action.surface.kind !== surface.kind ||
		action.surface.parentSurfaceId !== surface.parentSurfaceId
	) {
		fail("Conformance action does not target the supplied session surface.", {
			actionId: action.actionId,
			sessionId: session.sessionId,
			surfaceId: surface.surfaceId,
		});
	}
}

function normalizeAdapterPayload<T>(
	label: string,
	normalize: () => T,
	context: Record<string, unknown>,
): T {
	try {
		return normalize();
	} catch (error) {
		// error-policy:J2 adapter output is an untrusted boundary; preserve the
		// validation cause while classifying the failed conformance contract.
		throw new ElizaError(`Adapter returned an invalid ${label} payload.`, {
			code: "INTERACTION_ADAPTER_CONFORMANCE_FAILED",
			cause: error,
			context,
			severity: "fatal",
		});
	}
}

/**
 * Run the required adapter contract scenarios. Adapters may use deterministic
 * fixture behavior here; their package-level E2E suites still have to prove
 * the real browser or OS integration represented by the same statuses.
 */
export async function runInteractionAdapterConformance(
	options: InteractionAdapterConformanceOptions,
): Promise<InteractionConformanceReport> {
	const { adapter, session, surface } = options;
	if (adapter.id !== session.adapterId || surface.adapterId !== adapter.id) {
		return fail("Adapter, session, and surface identifiers do not match.", {
			adapterId: adapter.id,
			sessionAdapterId: session.adapterId,
			surfaceAdapterId: surface.adapterId,
		});
	}
	assertInteractionSurfaceCurrent(session, surface);
	const fixtureByName = new Map(
		options.fixtures.map((fixture) => [fixture.name, fixture]),
	);
	for (const required of REQUIRED_INTERACTION_CONFORMANCE_CASES) {
		if (!fixtureByName.has(required)) {
			return fail(
				`Missing required interaction conformance case '${required}'.`,
				{
					adapterId: adapter.id,
				},
			);
		}
	}
	if (fixtureByName.size !== options.fixtures.length) {
		return fail("Interaction conformance case names must be unique.", {
			adapterId: adapter.id,
		});
	}

	const rawCapabilities = await adapter.capabilities();
	const capabilities = normalizeAdapterPayload(
		"capability",
		() => normalizeInteractionCapabilitySet(rawCapabilities),
		{ adapterId: adapter.id },
	);
	if (capabilities.adapterId !== adapter.id) {
		return fail("Adapter capability identity does not match the adapter.", {
			adapterId: adapter.id,
			capabilityAdapterId: capabilities.adapterId,
		});
	}
	if (!capabilities.surfaceKinds.includes(surface.kind)) {
		return fail("Adapter did not advertise the supplied surface kind.", {
			adapterId: adapter.id,
			surfaceKind: surface.kind,
		});
	}
	const normalizedSession = assertInteractionSessionExecutable(session, {
		capabilities,
		now: options.now,
		profileGrantVerifier: options.profileGrantVerifier,
	});
	const normalizedSurface = normalizedSession.surfaces.find(
		(candidate) => candidate.surfaceId === surface.surfaceId,
	);
	if (!normalizedSurface) {
		return fail("Supplied conformance surface is not registered.", {
			adapterId: adapter.id,
			surfaceId: surface.surfaceId,
		});
	}

	const rawObservation = await adapter.observe(
		normalizedSession,
		normalizedSurface,
	);
	const observation = normalizeAdapterPayload(
		"observation",
		() => normalizeInteractionObservation(rawObservation, { actionId: null }),
		{ adapterId: adapter.id },
	);
	assertInteractionSurfaceCurrent(normalizedSession, observation.surface);
	if (
		observation.surface.surfaceId !== surface.surfaceId ||
		observation.sessionId !== session.sessionId ||
		observation.adapterId !== adapter.id
	) {
		return fail("Adapter observation escaped the requested session surface.", {
			adapterId: adapter.id,
			observationId: observation.observationId,
		});
	}
	const unadvertisedObservationChannel = observation.channels.find(
		(channel) => !capabilities.observationChannels.includes(channel),
	);
	if (unadvertisedObservationChannel) {
		return fail(
			"Adapter returned an observation channel it did not advertise.",
			{
				adapterId: adapter.id,
				channel: unadvertisedObservationChannel,
			},
		);
	}

	const checks: InteractionConformanceCheck[] = [
		{
			name: "capabilities",
			passed: true,
			detail: "Capabilities normalized and matched the adapter and surface.",
		},
		{
			name: "observation",
			passed: true,
			detail: "Observation remained inside the current session generation.",
		},
	];

	for (const name of REQUIRED_INTERACTION_CONFORMANCE_CASES) {
		const fixture = fixtureByName.get(name);
		if (!fixture) return fail(`Missing conformance fixture '${name}'.`);
		const action = normalizeInteractionAction(fixture.action, {
			session: normalizedSession,
			now: options.now,
		});
		ensureActionIdentity(action, normalizedSession, normalizedSurface);
		const expectedStatus = EXPECTED_STATUS[name];
		if (
			name === "unsupported" &&
			capabilities.actionKinds.includes(action.kind)
		) {
			return fail("Unsupported-capability fixture uses an advertised action.", {
				adapterId: adapter.id,
				actionKind: action.kind,
			});
		}
		if (
			name !== "unsupported" &&
			!capabilities.actionKinds.includes(action.kind)
		) {
			return fail(
				`Adapter fixture '${name}' uses an action it did not advertise.`,
				{
					adapterId: adapter.id,
					actionKind: action.kind,
				},
			);
		}
		if (
			name === "stale_observation" &&
			(action.observationId === null ||
				action.observationSequence === null ||
				action.observationSequence >= observation.sequence)
		) {
			return fail(
				"Stale-observation fixture references the current observation.",
				{
					adapterId: adapter.id,
					actionId: action.actionId,
				},
			);
		}
		const authorizedAction = await authorizeInteractionDispatch(action, {
			session: normalizedSession,
			capabilities,
			now: options.now,
			profileGrantVerifier: options.profileGrantVerifier,
			leaseRequirements: [],
		});
		const rawResult = await adapter.execute(authorizedAction);
		const result = normalizeAdapterPayload(
			"action result",
			() =>
				normalizeInteractionActionResult(rawResult, {
					action: authorizedAction,
					session: normalizedSession,
					capabilities,
					now: options.now,
				}),
			{ adapterId: adapter.id, actionId: action.actionId, case: name },
		);
		if (
			result.actionId !== action.actionId ||
			result.sessionId !== normalizedSession.sessionId ||
			result.adapterId !== adapter.id
		) {
			return fail(`Adapter result identity mismatch for '${name}'.`, {
				adapterId: adapter.id,
				actionId: action.actionId,
			});
		}
		if (result.status !== expectedStatus) {
			return fail(`Adapter returned the wrong status for '${name}'.`, {
				adapterId: adapter.id,
				expectedStatus,
				actualStatus: result.status,
			});
		}
		if (result.observation) {
			assertInteractionSurfaceCurrent(
				normalizedSession,
				result.observation.surface,
			);
		}
		checks.push({
			name,
			passed: true,
			detail: `Adapter returned ${expectedStatus} with a valid result envelope.`,
		});
	}

	for (const check of runInteractionLeaseConformance()) checks.push(check);
	return Object.freeze({
		adapterId: adapter.id,
		capabilities,
		observation,
		checks: Object.freeze(checks),
		passed: checks.every((check) => check.passed),
	});
}

/** Verify exclusive ownership, stale release, expiry, and reacquisition. */
export function runInteractionLeaseConformance(): readonly InteractionConformanceCheck[] {
	let now = Date.parse("2026-01-01T00:00:00.000Z");
	const leases = new InteractionLeaseCoordinator(() => now);
	const first = leases.acquire({
		leaseId: "lease-one",
		sessionId: "session-one",
		ownerId: "owner-one",
		resourceKind: "physical_pointer",
		resourceId: "local",
		generation: 1,
		ttlMs: 1_000,
	});
	let conflictObserved = false;
	try {
		leases.acquire({
			leaseId: "lease-two",
			sessionId: "session-two",
			ownerId: "owner-two",
			resourceKind: "physical_pointer",
			resourceId: "local",
			generation: 1,
			ttlMs: 1_000,
		});
	} catch (error) {
		conflictObserved =
			error instanceof ElizaError &&
			error.code === "INTERACTION_LEASE_CONFLICT";
	}
	if (!conflictObserved) {
		return fail("Lease conformance did not reject concurrent ownership.");
	}
	leases.assertHeld(first);
	now += 1_001;
	let expiryObserved = false;
	try {
		leases.assertHeld(first);
	} catch (error) {
		expiryObserved =
			error instanceof ElizaError && error.code === "STALE_INTERACTION_LEASE";
	}
	if (!expiryObserved) {
		return fail("Lease conformance did not reject an expired lease.");
	}
	const second = leases.acquire({
		leaseId: "lease-two",
		sessionId: "session-two",
		ownerId: "owner-two",
		resourceKind: "physical_pointer",
		resourceId: "local",
		generation: 1,
		ttlMs: 1_000,
	});
	leases.assertHeld(second);
	if (!leases.release(second)) {
		return fail("Lease conformance could not release the current owner.");
	}
	return Object.freeze([
		{
			name: "lease_contention",
			passed: true,
			detail: "Concurrent ownership was rejected with a typed conflict.",
		},
		{
			name: "lease_expiry",
			passed: true,
			detail: "Expired ownership became stale and the resource was reacquired.",
		},
	]);
}
