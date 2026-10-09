/** Typed desktop snapshots preserve upstream authentication and readiness failures. */
import { ROLE_RANK, type RoleGateRole } from "@elizaos/core/protocol";

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
		// error-policy:J3 non-JSON body → null body; the caller inspects `status`
		// and treats a null body as an unusable response, never as valid data.
		const body = await response.json().catch(() => null);
		return { status: response.status, body };
	} catch {
		// error-policy:J4 local API probe: the dashboard may not be listening yet
		// during boot; a null result is the designed "not-yet-available" signal
		// the ConfigReader callers below branch on.
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
	if (typeof body.instanceId === "string" && body.instanceId.length > 0) {
		snap.instanceId = body.instanceId;
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
	const access = readAuthAccess(body);
	const reason = typeof body.reason === "string" ? body.reason : null;
	if (!access || reason === null) return null;
	return { reason, access };
}

function readAuthIdentity(
	body: Record<string, unknown>,
): AuthMeSnapshot["identity"] {
	if (!body.identity || typeof body.identity !== "object") return undefined;
	const id = body.identity as Record<string, unknown>;
	if (typeof id.id !== "string") return undefined;
	return {
		id: id.id,
		displayName: typeof id.displayName === "string" ? id.displayName : id.id,
		kind: typeof id.kind === "string" ? id.kind : "machine",
	};
}

function readAuthSession(
	body: Record<string, unknown>,
): AuthMeSnapshot["session"] {
	if (!body.session || typeof body.session !== "object") return undefined;
	const session = body.session as Record<string, unknown>;
	return {
		id: typeof session.id === "string" ? session.id : "",
		kind: typeof session.kind === "string" ? session.kind : "machine",
		expiresAt:
			typeof session.expiresAt === "number" &&
			Number.isFinite(session.expiresAt)
				? session.expiresAt
				: null,
	};
}

function readAuthAccess(
	body: Record<string, unknown>,
): AuthMeSnapshot["access"] {
	if (!body.access || typeof body.access !== "object") return undefined;
	const access = body.access as Record<string, unknown>;
	if (typeof access.role !== "string" || !Object.hasOwn(ROLE_RANK, access.role))
		return undefined;
	return {
		role: access.role as RoleGateRole,
		mode: typeof access.mode === "string" ? access.mode : "remote",
		passwordConfigured: access.passwordConfigured === true,
		ownerConfigured: access.ownerConfigured === true,
	};
}

function readAuthorizedBody(
	body: Record<string, unknown>,
): AuthMeSnapshot | null {
	const identity = readAuthIdentity(body);
	const session = readAuthSession(body);
	const access = readAuthAccess(body);
	if (!identity || !session || !access) return null;
	return { identity, session, access };
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
		return readAuthorizedBody(body);
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
