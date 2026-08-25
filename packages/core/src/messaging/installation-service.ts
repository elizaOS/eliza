/**
 * In-memory host for the canonical group installation lifecycle. Owns the
 * per-scope record, idempotency-key deduplication, and transition dispatch
 * through the pure reducer in installation-lifecycle.ts. Storage-backed
 * adapters (SQL) implement the same surface later; the in-memory host is the
 * reference semantics and the test harness.
 */

import { ElizaError } from "../errors";
import type { UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import { Service, ServiceType } from "../types/service";
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
 * a replayed receipt whose record no longer matches the live epoch is NOT
 * returned as idempotent — the event is applied against the live record.
 */
type ReceiptLog = Map<string, InstallationTransitionReceipt>;

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
		const log =
			this.receipts.get(key) ??
			new Map<string, InstallationTransitionReceipt>();
		const record = this.records.get(key);
		const prior = log.get(event.idempotencyKey);
		if (prior) {
			// Cross-epoch replay guard: a receipt cached under this key only
			// short-circuits when its record belongs to the LIVE installation
			// epoch. A removal receipt from a prior (removed/revoked/failed)
			// installation must not satisfy an event against the recreated
			// record — fall through and apply for real.
			const sameEpoch =
				record !== undefined &&
				prior.record.reinstallVersion === record.reinstallVersion &&
				prior.record.state !== "removed" &&
				prior.record.state !== "revoked" &&
				prior.record.state !== "failed";
			if (sameEpoch) {
				return { ...prior, idempotentReplay: true };
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
		if (receipt.accepted) {
			this.records.set(key, receipt.record);
			// Same-key/different-payload guard: overwriting a cached receipt
			// for a changed payload would let a collision launder a different
			// transition under the same key; keep the FIRST receipt per key.
			if (!log.has(event.idempotencyKey)) {
				log.set(event.idempotencyKey, receipt);
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
