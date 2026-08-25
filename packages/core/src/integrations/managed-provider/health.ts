/**
 * Connection health probing shared by provider adapters. A probe never throws:
 * it translates the adapter failure taxonomy into a typed health snapshot that
 * catalog/kill-switch surfaces and the Connections UI can render directly,
 * keeping "needs reauth" visibly distinct from "provider down".
 */

import { ManagedProviderError } from "./errors";
import type {
	ManagedProviderHttpClient,
	ProviderResponseSchema,
} from "./http-client";

export type ProviderHealthState =
	| "healthy"
	| "reauth_required"
	| "revoked"
	| "rate_limited"
	| "unreachable"
	| "degraded";

export interface ProviderHealthSnapshot {
	state: ProviderHealthState;
	checkedAt: string;
	latencyMs: number;
	/** Failure taxonomy code when unhealthy; null when healthy. */
	code: string | null;
	retryAfterMs?: number;
}

const HEALTH_BODY_SCHEMA: ProviderResponseSchema<Record<string, unknown>> = {
	safeParse(value: unknown) {
		return value !== null && typeof value === "object"
			? { success: true, data: value as Record<string, unknown> }
			: { success: false, error: new Error("health body must be an object") };
	},
};

function stateForError(error: ManagedProviderError): ProviderHealthState {
	switch (error.code) {
		case "AUTH_EXPIRED":
			return "reauth_required";
		case "AUTH_REVOKED":
			return "revoked";
		case "RATE_LIMITED":
			return "rate_limited";
		case "PROVIDER_TIMEOUT":
		case "PROVIDER_NETWORK":
		case "ENDPOINT_BLOCKED":
			return "unreachable";
		default:
			return "degraded";
	}
}

/** Probes one endpoint (default `/health`) on the adapter's pinned origin. */
export async function probeProviderHealth(
	client: ManagedProviderHttpClient,
	path = "/health",
): Promise<ProviderHealthSnapshot> {
	const startedAt = Date.now();
	const checkedAt = new Date(startedAt).toISOString();
	try {
		await client.requestJson(
			client.url(path),
			{ method: "GET" },
			{
				safeParse: HEALTH_BODY_SCHEMA.safeParse,
			},
		);
		return {
			state: "healthy",
			checkedAt,
			latencyMs: Date.now() - startedAt,
			code: null,
		};
	} catch (error) {
		// error-policy:J4 A probe is a diagnostic surface: only the typed adapter
		// taxonomy becomes a distinct unhealthy state; anything else rethrows.
		if (error instanceof ManagedProviderError) {
			return {
				state: stateForError(error),
				checkedAt,
				latencyMs: Date.now() - startedAt,
				code: error.code,
				retryAfterMs: error.retryAfterMs,
			};
		}
		throw error;
	}
}
