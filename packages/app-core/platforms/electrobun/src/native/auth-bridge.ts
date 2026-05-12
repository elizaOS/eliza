/**
 * Desktop Auth Bridge — loopback-only auto-session for the Electrobun shell.
 *
 * On first boot the user should not be forced through the password flow just to
 * use their own desktop. This module mints a "desktop loopback" browser session
 * by proving filesystem co-location to the local API:
 *
 *   1. Generate a 32-byte secret in the bun main process.
 *   2. Open a Unix domain socket under `<stateDir>/sockets/` with mode 0600.
 *   3. POST `/api/auth/desktop-bootstrap` with the socket path.
 *   4. The API connects to the socket, reads the secret, verifies it has
 *      filesystem access (= same user), and mints a `kind: "browser"` session
 *      flagged loopback-only. The auth-context resolver MUST refuse a
 *      loopback-only session on non-loopback requests — that is the actual
 *      security boundary, not anything we do here.
 *   5. Persist `{ sessionId, csrfToken, expiresAt }` to
 *      `<stateDir>/auth/desktop-session.json` (mode 0600) for the next boot.
 *   6. Install both cookies (session + csrf) into the webview's cookie jar via
 *      `Session.cookies.set` so the renderer's first `/api` request is already
 *      authenticated. The session cookie is HttpOnly — JS can't set it via
 *      document.cookie, but the cookie jar can.
 *
 * On any failure (no endpoint, bad response, socket race, fs permission) the
 * bridge fails closed: it returns null and the renderer sees the same login
 * flow a remote browser would. Never silent "ignore and proceed".
 */

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { getBrandConfig } from "../brand-config";

export const DESKTOP_BOOTSTRAP_ENDPOINT = "/api/auth/desktop-bootstrap";
export const SESSION_COOKIE_NAME = "eliza_session";
export const CSRF_COOKIE_NAME = "eliza_csrf";
const PERSISTED_SCHEMA_VERSION = 1;
const SOCKET_CONNECT_TIMEOUT_MS = 5_000;
const HTTP_REQUEST_TIMEOUT_MS = 10_000;
const SECRET_BYTES = 32;
/** Refuse to reuse an existing session if it expires within this window. */
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

export interface DesktopSession {
	sessionId: string;
	csrfToken: string;
	expiresAt: number;
}

/**
 * Loose `fetch` shape — narrower than the runtime `typeof fetch` (which on Bun
 * includes `preconnect`) so tests can pass simple stubs.
 */
export type FetchLike = (
	input: URL | RequestInfo,
	init?: RequestInit,
) => Promise<Response>;

export interface DesktopBootstrapDeps {
	/** Loopback API base, e.g. `http://127.0.0.1:31337`. */
	apiBase: string;
	/** Override for tests. Default: `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Override secret generator for deterministic tests. */
	generateSecret?: () => Buffer;
	/** Override fetch (tests inject a stub). Default: global `fetch`. */
	fetchImpl?: FetchLike;
	/** Override clock for tests. */
	now?: () => number;
}

interface DesktopBootstrapResponseBody {
	sessionId?: string;
	csrfToken?: string;
	expiresAt?: number;
}

// ── State paths ───────────────────────────────────────────────────────────────

/**
 * Resolve the eliza state dir. Mirrors the precedence used elsewhere in the
 * codebase: explicit eliza env first, then legacy eliza env, then
 * `~/.<namespace>` derived from brand config.
 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.ELIZA_STATE_DIR?.trim() || "";
	if (explicit) return explicit;
	return path.join(os.homedir(), `.${getBrandConfig().namespace}`);
}

export function resolveAuthDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(resolveStateDir(env), "auth");
}

export function resolveSessionPath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return path.join(resolveAuthDir(env), "desktop-session.json");
}

export function resolveSocketDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(resolveStateDir(env), "sockets");
}

// ── Persisted-session round-trip ─────────────────────────────────────────────

/**
 * Try to load a previously-minted desktop session. Returns null on any failure
 * (missing file, wrong schema, expired, malformed JSON). Failure is silent —
 * caller is expected to fall through to `bootstrapDesktopSession`.
 */
export function loadPersistedSession(
	env: NodeJS.ProcessEnv = process.env,
	now: () => number = Date.now,
): DesktopSession | null {
	const sessionPath = resolveSessionPath(env);
	if (!fs.existsSync(sessionPath)) return null;

	let raw: string;
	try {
		raw = fs.readFileSync(sessionPath, "utf8");
	} catch {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== "object") return null;
	const record = parsed as Record<string, unknown>;
	if (record.schemaVersion !== PERSISTED_SCHEMA_VERSION) return null;

	const sessionId =
		typeof record.sessionId === "string" ? record.sessionId : "";
	const csrfToken =
		typeof record.csrfToken === "string" ? record.csrfToken : "";
	const expiresAt =
		typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
			? record.expiresAt
			: 0;

	if (!sessionId || !csrfToken || expiresAt <= 0) return null;
	if (expiresAt - EXPIRY_SAFETY_MARGIN_MS <= now()) return null;

	return { sessionId, csrfToken, expiresAt };
}

export function persistSession(
	session: DesktopSession,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const dir = resolveAuthDir(env);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	// Best-effort tighten in case mkdir respected an inherited umask.
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		/* non-fatal on platforms where chmod has no effect */
	}
	const sessionPath = resolveSessionPath(env);
	const body = JSON.stringify(
		{
			schemaVersion: PERSISTED_SCHEMA_VERSION,
			sessionId: session.sessionId,
			csrfToken: session.csrfToken,
			expiresAt: session.expiresAt,
		},
		null,
		2,
	);
	fs.writeFileSync(sessionPath, body, { encoding: "utf8", mode: 0o600 });
	try {
		fs.chmodSync(sessionPath, 0o600);
	} catch {
		/* non-fatal */
	}
}

export function clearPersistedSession(
	env: NodeJS.ProcessEnv = process.env,
): void {
	const sessionPath = resolveSessionPath(env);
	try {
		if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
	} catch {
		/* non-fatal */
	}
}

// ── Socket server (one-shot secret hand-off) ─────────────────────────────────

interface BootstrapSocket {
	socketPath: string;
	/** Resolves once a peer has connected, read the secret, and disconnected. */
	consumed: Promise<void>;
	close: () => void;
}

/**
 * Open a Unix domain socket that will hand a single connection the secret and
 * close. Windows is unsupported — Bun on Windows does not implement reliable
 * UDS, and the named-pipe equivalent has different semantics. Callers should
 * skip the auto-session path on win32 and fall back to the password flow.
 */
function openBootstrapSocket(
	env: NodeJS.ProcessEnv,
	secret: Buffer,
): BootstrapSocket {
	let socketDir = resolveSocketDir(env);
	let socketName = `desktop-auth-${crypto.randomBytes(8).toString("hex")}.sock`;
	if (
		process.platform === "darwin" &&
		path.join(socketDir, socketName).length > 100
	) {
		socketDir = os.tmpdir();
		socketName = `mda-${crypto.randomBytes(4).toString("hex")}.sock`;
	}
	fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(socketDir, 0o700);
	} catch {
		/* non-fatal */
	}

	const socketPath = path.join(socketDir, socketName);

	// Stale socket from a previous crashed run — unlink before bind.
	try {
		if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
	} catch {
		/* swallowed; bind will report the real failure */
	}

	let resolveConsumed: () => void = () => {};
	let rejectConsumed: (err: Error) => void = () => {};
	const consumed = new Promise<void>((res, rej) => {
		resolveConsumed = res;
		rejectConsumed = rej;
	});

	const server = net.createServer((conn) => {
		// Hand the secret over and tear down. The peer (the API process) is
		// expected to read the bytes and close. We close on our side after a
		// single connection regardless.
		conn.write(secret, () => {
			conn.end();
		});
		conn.once("close", () => resolveConsumed());
		conn.once("error", (err) => rejectConsumed(err));
	});

	server.on("error", (err) => rejectConsumed(err));
	server.listen(socketPath);

	// chmod the socket inode itself so only the owner can connect. On Linux this
	// is enforced; on macOS UDS permissions are advisory but still useful.
	try {
		fs.chmodSync(socketPath, 0o600);
	} catch {
		/* non-fatal */
	}

	return {
		socketPath,
		consumed,
		close: () => {
			try {
				server.close();
			} catch {
				/* no-op */
			}
			try {
				if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
			} catch {
				/* no-op */
			}
		},
	};
}

// ── Backend call ─────────────────────────────────────────────────────────────

function buildBootstrapUrl(apiBase: string): string {
	const trimmed = apiBase.replace(/\/+$/, "");
	return `${trimmed}${DESKTOP_BOOTSTRAP_ENDPOINT}`;
}

function isLoopbackBase(apiBase: string): boolean {
	try {
		const url = new URL(apiBase);
		const host = url.hostname.toLowerCase();
		return (
			host === "127.0.0.1" ||
			host === "localhost" ||
			host === "::1" ||
			host === "[::1]"
		);
	} catch {
		return false;
	}
}

/**
 * Mint a fresh desktop session by handshaking with the local API. Fails closed
 * — returns null on any error, including missing endpoint (404), wrong shape,
 * timeout, or socket-permission failure.
 */
export async function bootstrapDesktopSession(
	deps: DesktopBootstrapDeps,
): Promise<DesktopSession | null> {
	const env = deps.env ?? process.env;
	const fetchImpl = deps.fetchImpl ?? fetch;
	const now = deps.now ?? Date.now;
	const generateSecret =
		deps.generateSecret ?? (() => crypto.randomBytes(SECRET_BYTES));

	if (process.platform === "win32") {
		// UDS path is POSIX-only for this bridge. Win32 falls through to the
		// password flow for now; revisit when the named-pipe variant is wired.
		return null;
	}

	if (!isLoopbackBase(deps.apiBase)) {
		// Defence-in-depth: never hand a secret to a non-loopback origin.
		return null;
	}

	const secret = generateSecret();
	if (secret.length < SECRET_BYTES) {
		return null;
	}

	let socketHandle: BootstrapSocket | null = null;
	try {
		socketHandle = openBootstrapSocket(env, secret);
	} catch {
		return null;
	}

	const url = buildBootstrapUrl(deps.apiBase);
	const requestSignal = AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS);
	const consumeSignal = AbortSignal.timeout(SOCKET_CONNECT_TIMEOUT_MS);

	// Wrap consumed in a race so a hung backend doesn't keep the socket open.
	const consumedOrTimeout = new Promise<void>((resolve, reject) => {
		const onAbort = () =>
			reject(new Error("socket consume timed out before backend connected"));
		consumeSignal.addEventListener("abort", onAbort, { once: true });
		socketHandle?.consumed
			.then(() => resolve())
			.catch((err: unknown) =>
				reject(err instanceof Error ? err : new Error(String(err))),
			);
	});

	let body: DesktopBootstrapResponseBody | null = null;
	try {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({ socketPath: socketHandle.socketPath }),
			signal: requestSignal,
		});

		if (!response.ok) {
			// 404 means the backend doesn't implement the endpoint yet — flag in
			// logs but stay silent in the UX so the renderer can still log in.
			return null;
		}

		body = (await response
			.json()
			.catch(() => null)) as DesktopBootstrapResponseBody | null;

		// Wait for the API to actually connect to the socket before we tear it
		// down. If the API never connects we still got an HTTP response, but the
		// session it minted was based on something other than filesystem proof —
		// refuse it.
		await consumedOrTimeout;
	} catch {
		return null;
	} finally {
		socketHandle.close();
	}

	if (!body) return null;
	const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
	const csrfToken = typeof body.csrfToken === "string" ? body.csrfToken : "";
	const expiresAt =
		typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
			? body.expiresAt
			: 0;

	if (!sessionId || !csrfToken || expiresAt <= now()) return null;

	return { sessionId, csrfToken, expiresAt };
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Try the persisted session first; fall back to a fresh bootstrap. Persists
 * a successful bootstrap so the next boot can short-circuit. Returns null if
 * the bridge cannot establish a session — the renderer should then surface
 * the normal login flow.
 */
export async function loadOrCreateDesktopSession(
	deps: DesktopBootstrapDeps,
): Promise<DesktopSession | null> {
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;

	const existing = loadPersistedSession(env, now);
	if (existing) return existing;

	const fresh = await bootstrapDesktopSession(deps);
	if (!fresh) return null;

	try {
		persistSession(fresh, env);
	} catch {
		// Persistence is best-effort: even without it, the renderer is logged in
		// for the lifetime of this process.
	}
	return fresh;
}

// ── Cookie installation ──────────────────────────────────────────────────────

/**
 * Resolve the origin that owns the cookies. For local mode this is the loopback
 * API base; for the Vite dev server case the renderer is served from a separate
 * loopback origin and its requests proxy to the API, so cookies must live on
 * the renderer's own origin to be sent automatically. We always install on the
 * API origin; an additional renderer-origin install is a deliberate no-op when
 * `rendererOrigin === apiOrigin`.
 */
export interface InstallCookieTargets {
	apiOrigin: string;
	rendererOrigin?: string | null;
}

export interface CookieInstaller {
	set: (cookie: {
		name: string;
		value: string;
		domain?: string;
		path?: string;
		secure?: boolean;
		httpOnly?: boolean;
		sameSite?: "no_restriction" | "lax" | "strict";
		expirationDate?: number;
	}) => boolean;
}

/**
 * Install the desktop session and CSRF cookies into the given Electrobun
 * session's cookie jar. The session cookie is HttpOnly and Secure-only when
 * the API origin is https; the CSRF cookie is readable so the SPA can mirror
 * it into `x-eliza-csrf` on state-changing requests.
 *
 * Returns the list of targets that were touched, for logging.
 */
export function installDesktopSessionCookies(
	installer: CookieInstaller,
	session: DesktopSession,
	targets: InstallCookieTargets,
): string[] {
	const expirationDate = Math.floor(session.expiresAt / 1000);
	const seen = new Set<string>();
	const touched: string[] = [];

	const tryInstall = (origin: string): void => {
		if (!origin) return;
		let parsed: URL;
		try {
			parsed = new URL(origin);
		} catch {
			return;
		}
		const key = parsed.origin;
		if (seen.has(key)) return;
		seen.add(key);
		const secure = parsed.protocol === "https:";
		const url = parsed.origin;
		installer.set({
			name: SESSION_COOKIE_NAME,
			value: session.sessionId,
			domain: parsed.hostname,
			path: "/",
			secure,
			httpOnly: true,
			sameSite: "lax",
			expirationDate,
			// electrobun's `Cookie` shape uses `url`/origin under the hood; adding
			// `domain` keeps it compatible with both implementations.
			...({ url } as Record<string, unknown>),
		});
		installer.set({
			name: CSRF_COOKIE_NAME,
			value: session.csrfToken,
			domain: parsed.hostname,
			path: "/",
			secure,
			httpOnly: false,
			sameSite: "lax",
			expirationDate,
			...({ url } as Record<string, unknown>),
		});
		touched.push(key);
	};

	tryInstall(targets.apiOrigin);
	if (targets.rendererOrigin) tryInstall(targets.rendererOrigin);
	return touched;
}
