/**
 * In-memory host for the canonical group installation lifecycle. Owns the
 * per-scope record, idempotency-key deduplication, and transition dispatch
 * through the pure reducer in installation-lifecycle.ts. Storage-backed
 * adapters (SQL) implement the same surface later; the in-memory host is the
 * reference semantics and the test harness.
 */

import { ElizaError } from "../errors";
import type { JsonObject, UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import { Service, ServiceType } from "../types/service";
import { stableStringify } from "../utils/deterministic";
import {
	type ConnectorInstallationContribution,
	validateInstallationContribution,
} from "./installation-contribution";
import {
	applyInstallationTransition,
	type GroupInstallationRecord,
	type InstallationScope,
	type InstallationTransitionEvent,
	type InstallationTransitionReceipt,
	recreateInstallationAfterRemoval,
} from "./installation-lifecycle";

/**
 * Idempotency memory: scope-keyed map of idempotency key -> last receipt.
 * Receipt logs deliberately survive re-creation so reconnect replays stay
 * no-ops; keys must therefore be epoch-scoped by callers (reinstallVersion)
 * so a removal key from installation N can never satisfy a removal of
 * installation N+1. The service enforces the second half of that contract:
 * a replayed receipt whose record belongs to a different installation epoch
 * is NOT returned as idempotent — the event is applied against the live
 * record.
 */
type ReceiptLog = Map<string, LogEntry>;

interface LogEntry {
	receipt: InstallationTransitionReceipt;
	/**
	 * Canonical payload fingerprint for collision detection: the same
	 * idempotency key must always carry the same payload. A key collision
	 * with a different payload is a provider integrity violation, not an
	 * idempotent replay, and fails loudly.
	 */
	fingerprint: string;
}

/**
 * Fingerprint of the event's semantic payload. Deliberately excludes the
 * idempotency key (the lookup dimension), observedAt (redelivery re-stamps
 * the clock), and observedGeneration/reinstallVersion (the observer's view
 * legitimately differs when an event is redelivered against an advanced
 * record — the cross-epoch guard below decides that case, not the
 * fingerprint). One key carrying two different transitions is a provider
 * integrity violation.
 */
function eventFingerprint(event: InstallationTransitionEvent): string {
	return stableStringify({
		scope: event.scope,
		transition: event.transition,
	});
}

function scopeKey(scope: InstallationScope): string {
	return `${scope.agentId}:${scope.connectorId}:${scope.connectorAccountId}:${scope.externalWorldId}`;
}

/**
 * Runtime service hosting the installation state machine. Registered under
 * ServiceType.INSTALLATION; connectors look it up to report lifecycle events
 * and read the authoritative record before sending traffic.
 */
export class InstallationLifecycleService extends Service {
	static override readonly serviceType = ServiceType.INSTALLATION;
	public readonly capabilityDescription =
		"Owns the provider-neutral group installation lifecycle records.";

	static override async start(runtime: IAgentRuntime) {
		return new InstallationLifecycleService(runtime);
	}

	private readonly records = new Map<string, GroupInstallationRecord>();
	private readonly receipts = new Map<string, ReceiptLog>();
	private readonly contributions = new Map<
		string,
		ConnectorInstallationContribution
	>();

	/** Apply one transition event idempotently for its scope. */
	apply(event: InstallationTransitionEvent): InstallationTransitionReceipt {
		if (event.idempotencyKey.trim() === "") {
			throw new ElizaError(
				"Installation transition idempotency key must be non-empty.",
				{ code: "INSTALLATION_INVALID_EVENT", context: { scope: event.scope } },
			);
		}
		const key = scopeKey(event.scope);
		const log = this.receipts.get(key) ?? new Map<string, LogEntry>();
		const record = this.records.get(key);
		const prior = log.get(event.idempotencyKey);
		if (prior) {
			// Payload collision guard: one idempotency key must always carry
			// one payload. A different payload under a cached key is a
			// provider integrity violation and fails loudly instead of
			// laundering a different transition through the cached receipt.
			if (prior.fingerprint !== eventFingerprint(event)) {
				throw new ElizaError(
					`Installation idempotency key collision for ${event.idempotencyKey}: the cached receipt carries a different payload.`,
					{
						code: "INSTALLATION_IDEMPOTENCY_COLLISION",
						context: {
							scope: event.scope,
							idempotencyKey: event.idempotencyKey,
						},
					},
				);
			}
			// Cross-epoch replay guard: a receipt cached under this key only
			// short-circuits when its record belongs to the LIVE installation
			// epoch — a terminal record stays terminal (a redelivered
			// guildDelete replays its removal receipt instead of falling
			// through to INVALID_TRANSITION), while a receipt from a prior
			// (removed/revoked/failed) installation must not satisfy an event
			// against the recreated record — it falls through and applies for
			// real.
			const sameEpoch =
				record !== undefined &&
				prior.receipt.record.reinstallVersion === record.reinstallVersion;
			if (sameEpoch) {
				return { ...prior.receipt, idempotentReplay: true };
			}
		}
		let receipt: InstallationTransitionReceipt;
		if (
			record !== undefined &&
			(record.state === "removed" ||
				record.state === "revoked" ||
				record.state === "failed") &&
			event.transition.kind === "invite_created"
		) {
			receipt = recreateInstallationAfterRemoval(record, event);
		} else {
			receipt = applyInstallationTransition(record ?? null, event);
		}
		if (receipt.accepted || receipt.rejection?.persistRecord === true) {
			// Attempt burns arrive as REJECTED receipts carrying a mutated
			// record; persist the record either way so exhaustion sticks.
			this.records.set(key, receipt.record);
			// Same-key/different-payload guard is enforced above at lookup;
			// keep the FIRST receipt per key (first-write-wins).
			if (!log.has(event.idempotencyKey)) {
				log.set(event.idempotencyKey, {
					receipt,
					fingerprint: eventFingerprint(event),
				});
			}
			this.receipts.set(key, log);
		}
		return receipt;
	}

	/** Authoritative record for a scope (null when never installed). */
	get(scope: InstallationScope): GroupInstallationRecord | null {
		return this.records.get(scopeKey(scope)) ?? null;
	}

	/** Traffic gate: connectors must consult this before sending to a group. */
	readyForTraffic(scope: InstallationScope): boolean {
		const record = this.records.get(scopeKey(scope));
		return record !== undefined && record.state === "ready";
	}

	/** Register a connector contribution; malformed registrations throw (fail fast). */
	registerContribution(contribution: ConnectorInstallationContribution): void {
		const problems = validateInstallationContribution(contribution);
		if (problems.length > 0) {
			throw new ElizaError(
				`Invalid installation contribution for ${contribution.connectorId}: ${problems.join("; ")}`,
				{
					code: "INSTALLATION_INVALID_CONTRIBUTION",
					context: { connectorId: contribution.connectorId, problems },
				},
			);
		}
		this.contributions.set(contribution.connectorId, contribution);
	}

	getContribution(
		connectorId: string,
	): ConnectorInstallationContribution | null {
		return this.contributions.get(connectorId) ?? null;
	}

	listConnectorIds(): readonly string[] {
		return [...this.contributions.keys()];
	}

	/** Test/diagnostic surface: all known installation records. */
	listRecords(): readonly GroupInstallationRecord[] {
		return [...this.records.values()];
	}

	override async stop(): Promise<void> {
		// In-memory host: nothing to drain. A storage adapter persists here.
	}
}

/** Structural type guard for service-registry lookups (mirrors membership.ts). */
export function isInstallationLifecycleService(
	service: unknown,
): service is InstallationLifecycleService {
	return (
		typeof service === "object" &&
		service !== null &&
		typeof (service as InstallationLifecycleService).apply === "function" &&
		typeof (service as InstallationLifecycleService).readyForTraffic ===
			"function"
	);
}

export function resolveInstallationLifecycleService(
	runtime: IAgentRuntime,
): InstallationLifecycleService | null {
	const service = runtime.getService(ServiceType.INSTALLATION);
	return isInstallationLifecycleService(service) ? service : null;
}

export type { UUID };
