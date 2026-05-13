/**
 * Pure composition layer for `getConfig`, `getAuthStatus`, `getAuthMe`.
 *
 * Same shape as boot-progress.ts and onboarding-rpc.ts — the body of
 * the HTTP readers is the transitional carrier; the typed contract on
 * the renderer side is the load-bearing surface and stays stable when
 * the agent runtime merges into this Bun process.
 *
 * Failure semantics (critical):
 *
 *   - When the agent has no port yet (early-startup poll), the
 *     composer **throws AGENT_NOT_READY**. It never fabricates a
 *     placeholder snapshot. Returning a "fake" {required: false} or
 *     {complete: false} shape would be authoritatively wrong — the
 *     renderer can't tell our placeholder apart from a real answer
 *     and risks rendering a UI that doesn't match reality (e.g. a
 *     LoginView when the actual server says local-loopback).
 *
 *   - When the agent IS ready but the HTTP reader hits a transient
 *     transport error (timeout, 5xx), the composer also throws.
 *     Renderer-side wrappers catch and fall through to their HTTP
 *     fallback, which then surfaces a real transport error to the
 *     polling loop. Same semantics the renderer already had before
 *     RPC was in the picture.
 *
 *   - When the agent answers with a structured 401 (auth required),
 *     the composer returns the parsed `AuthMeSnapshot.unauthorized`.
 *     That IS an authoritative answer — different from "not ready".
 *
 * `getAuthMe` is the one wrinkle: the upstream returns 401 with a
 * structured body when unauthenticated. We capture that body in
 * `AuthMeSnapshot.unauthorized` so callers can drive the LoginView
 * correctly. But only when the agent itself returned that 401 —
 * never as a placeholder for "agent hasn't started yet".
 */

/**
 * Error thrown by composers when the agent isn't ready to answer
 * (no port assigned yet). Caller patterns:
 *
 *   try {
 *     return await rpc.request.getAuthMe();
 *   } catch (err) {
 *     if (err instanceof AgentNotReadyError) {
 *       // fall through to HTTP / keep polling
 *     }
 *   }
 *
 * `cause` is preserved through electrobun RPC's structured clone so
 * the renderer side can introspect if needed.
 */
export class AgentNotReadyError extends Error {
	override readonly name = "AgentNotReadyError";
	constructor(method: string) {
		super(`Agent not ready (no port assigned yet); cannot serve ${method}.`);
	}
}

import type {
	AuthMeSnapshot,
	AuthStatusSnapshot,
	ConfigSchemaSnapshot,
	ConfigSnapshot,
} from "./rpc-schema";

const DEFAULT_TIMEOUT_MS = 4_000;

async function fetchJsonRaw(
	port: number,
	pathname: string,
): Promise<{ status: number; body: unknown } | null> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
			method: "GET",
			signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
		});
		const body = await response.json().catch(() => null);
		return { status: response.status, body };
	} catch {
		return null;
	}
}

// ── getConfig ───────────────────────────────────────────────────────

export type ConfigReader = (port: number) => Promise<ConfigSnapshot | null>;

export const readConfigViaHttp: ConfigReader = async (port) => {
	const raw = await fetchJsonRaw(port, "/api/config");
	if (!raw || raw.status < 200 || raw.status >= 300) return null;
	if (raw.body && typeof raw.body === "object" && !Array.isArray(raw.body)) {
		return raw.body as ConfigSnapshot;
	}
	return null;
};

export async function composeConfigSnapshot(
	port: number | null,
	read: ConfigReader,
): Promise<ConfigSnapshot> {
	if (port === null) throw new AgentNotReadyError("getConfig");
	const value = await read(port);
	if (value === null) {
		// Transport-level failure (timeout / 5xx). Caller decides whether
		// to retry; the renderer falls through to HTTP which then
		// surfaces the same kind of transport error to its polling loop.
		throw new AgentNotReadyError("getConfig");
	}
	return value;
}

// ── getConfigSchema ─────────────────────────────────────────────────

export type ConfigSchemaReader = (
	port: number,
) => Promise<ConfigSchemaSnapshot | null>;

export const readConfigSchemaViaHttp: ConfigSchemaReader = async (port) => {
	const raw = await fetchJsonRaw(port, "/api/config/schema");
	if (!raw || raw.status < 200 || raw.status >= 300) return null;
	if (!raw.body || typeof raw.body !== "object" || Array.isArray(raw.body)) {
		return null;
	}
	const body = raw.body as Record<string, unknown>;
	if (
		!body.schema ||
		typeof body.schema !== "object" ||
		Array.isArray(body.schema) ||
		!body.uiHints ||
		typeof body.uiHints !== "object" ||
		Array.isArray(body.uiHints) ||
		typeof body.version !== "string" ||
		typeof body.generatedAt !== "string"
	) {
		return null;
	}
	return {
		schema: body.schema as Record<string, unknown>,
		uiHints: body.uiHints as Record<string, unknown>,
		version: body.version,
		generatedAt: body.generatedAt,
	};
};

export async function composeConfigSchemaSnapshot(
	port: number | null,
	read: ConfigSchemaReader,
): Promise<ConfigSchemaSnapshot> {
	if (port === null) throw new AgentNotReadyError("getConfigSchema");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("getConfigSchema");
	return value;
}

// ── getAuthStatus ───────────────────────────────────────────────────

export type AuthStatusReader = (
	port: number,
) => Promise<AuthStatusSnapshot | null>;

export const readAuthStatusViaHttp: AuthStatusReader = async (port) => {
	const raw = await fetchJsonRaw(port, "/api/auth/status");
	if (!raw || raw.status < 200 || raw.status >= 300) return null;
	if (!raw.body || typeof raw.body !== "object") return null;
	const body = raw.body as Record<string, unknown>;
	const snap: AuthStatusSnapshot = {
		required: body.required === true,
		pairingEnabled: body.pairingEnabled === true,
		expiresAt:
			typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
				? body.expiresAt
				: null,
	};
	if (typeof body.authenticated === "boolean") {
		snap.authenticated = body.authenticated;
	}
	if (typeof body.loginRequired === "boolean") {
		snap.loginRequired = body.loginRequired;
	}
	if (typeof body.bootstrapRequired === "boolean") {
		snap.bootstrapRequired = body.bootstrapRequired;
	}
	if (typeof body.localAccess === "boolean") {
		snap.localAccess = body.localAccess;
	}
	if (typeof body.passwordConfigured === "boolean") {
		snap.passwordConfigured = body.passwordConfigured;
	}
	return snap;
};

export async function composeAuthStatusSnapshot(
	port: number | null,
	read: AuthStatusReader,
): Promise<AuthStatusSnapshot> {
	if (port === null) throw new AgentNotReadyError("getAuthStatus");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("getAuthStatus");
	return value;
}

// ── getAuthMe ───────────────────────────────────────────────────────

export type AuthMeReader = (port: number) => Promise<AuthMeSnapshot | null>;

function readUnauthorizedBody(
	body: Record<string, unknown>,
): AuthMeSnapshot["unauthorized"] | null {
	const access = body.access;
	if (!access || typeof access !== "object") return null;
	const acc = access as Record<string, unknown>;
	const reason = typeof body.reason === "string" ? body.reason : null;
	if (reason === null) return null;
	return {
		reason,
		access: {
			mode: typeof acc.mode === "string" ? acc.mode : "remote",
			passwordConfigured: acc.passwordConfigured === true,
			ownerConfigured: acc.ownerConfigured === true,
		},
	};
}

export const readAuthMeViaHttp: AuthMeReader = async (port) => {
	const raw = await fetchJsonRaw(port, "/api/auth/me");
	if (!raw?.body || typeof raw.body !== "object") return null;
	const body = raw.body as Record<string, unknown>;

	if (raw.status === 401) {
		const unauthorized = readUnauthorizedBody(body);
		if (!unauthorized) return null;
		return { unauthorized };
	}

	if (raw.status >= 200 && raw.status < 300) {
		const snap: AuthMeSnapshot = {};
		if (body.identity && typeof body.identity === "object") {
			const id = body.identity as Record<string, unknown>;
			if (typeof id.id === "string") {
				snap.identity = {
					id: id.id,
					displayName:
						typeof id.displayName === "string" ? id.displayName : id.id,
					kind: typeof id.kind === "string" ? id.kind : "machine",
				};
			}
		}
		if (body.session && typeof body.session === "object") {
			const s = body.session as Record<string, unknown>;
			snap.session = {
				id: typeof s.id === "string" ? s.id : "",
				kind: typeof s.kind === "string" ? s.kind : "machine",
				expiresAt:
					typeof s.expiresAt === "number" && Number.isFinite(s.expiresAt)
						? s.expiresAt
						: null,
			};
		}
		if (body.access && typeof body.access === "object") {
			const a = body.access as Record<string, unknown>;
			snap.access = {
				mode: typeof a.mode === "string" ? a.mode : "remote",
				passwordConfigured: a.passwordConfigured === true,
				ownerConfigured: a.ownerConfigured === true,
			};
		}
		return snap;
	}

	return null;
};

export async function composeAuthMeSnapshot(
	port: number | null,
	read: AuthMeReader,
): Promise<AuthMeSnapshot> {
	if (port === null) throw new AgentNotReadyError("getAuthMe");
	const value = await read(port);
	if (value === null) throw new AgentNotReadyError("getAuthMe");
	return value;
}
