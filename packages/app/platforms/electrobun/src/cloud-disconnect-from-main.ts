/**
 * Main-process `POST /api/cloud/disconnect` — same rationale as menu reset:
 * after a native message box, the renderer's `fetch` may not run until later,
 * so disconnect appeared to do nothing.
 */

import { resolveApiToken } from "@elizaos/host/protocol";
import {
	normalizeApiBase,
	resolveDesktopRuntimeMode,
	resolveHttpLoopbackRendererOriginForApiClient,
	resolveInitialApiBase,
} from "./api-base";
import { getBrandConfig } from "./brand-config";
import {
	buildMainMenuResetApiCandidates,
	type FetchLike,
	type MainApiHeaderBuilder,
	pickReachableMenuResetApiBase,
} from "./menu-reset-from-main";
import { configureDesktopLocalApiAuth, getAgentManager } from "./native/agent";
import { resolveDesktopApiRequestToken } from "./runtime-preflight";
export type CloudDisconnectMainResult =
	| {
			ok: true;
	  }
	| {
			ok: false;
			error: string;
	  };
/**
 * Origins the main process itself knows to be the local agent: the embedded
 * agent's loopback port, the env-configured base, and the loopback dev-server
 * origin that proxies `/api` to the embedded agent. The local API bearer is
 * only ever attached to these; a renderer-supplied `apiBase` outside this set
 * never receives it.
 */
export function resolveMainLocalAgentOrigins(): string[] {
	const env = process.env as Record<string, string | undefined>;
	const origins: string[] = [];
	for (const raw of [
		...buildMainMenuResetApiCandidates({
			embeddedPort: getAgentManager().getPort(),
			configuredBase: resolveInitialApiBase(env),
		}),
		resolveHttpLoopbackRendererOriginForApiClient(env),
	]) {
		const origin = normalizeApiBase(raw ?? undefined);
		if (origin && !origins.includes(origin)) {
			origins.push(origin);
		}
	}
	return origins;
}
/**
 * Target-scoped header builder for main-process API calls. A renderer-provided
 * bearer is forwarded as-is (the renderer already holds it for that base).
 * Otherwise the main-process token goes through the origin-scoped
 * `resolveDesktopApiRequestToken` (external: only the configured external
 * origin; disabled: never) and, in local mode, only to a known local agent
 * origin.
 */
export function createMainApiHeaderBuilder(options: {
	bearerTokenOverride?: string | null;
	localAgentOrigins: readonly string[];
}): MainApiHeaderBuilder {
	return (targetUrl, contentType) => {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (contentType) {
			headers["Content-Type"] = contentType;
		}
		const override = options.bearerTokenOverride?.trim();
		if (override) {
			headers.Authorization = `Bearer ${override}`;
			return headers;
		}
		const env = process.env as Record<string, string | undefined>;
		const resolution = resolveDesktopRuntimeMode(env);
		if (resolution.mode === "local") {
			const targetOrigin = normalizeApiBase(targetUrl);
			if (!targetOrigin || !options.localAgentOrigins.includes(targetOrigin)) {
				return headers;
			}
		}
		let apiToken = resolveDesktopApiRequestToken({
			resolution,
			targetUrl,
			configuredToken: resolveApiToken(process.env),
		});
		if (!apiToken && resolution.mode === "local") {
			apiToken = configureDesktopLocalApiAuth().trim() || undefined;
		}
		if (apiToken) {
			headers.Authorization = `Bearer ${apiToken}`;
		}
		return headers;
	};
}
export async function postCloudDisconnectFromMain(options?: {
	fetchImpl?: FetchLike;
	disconnectTimeoutMs?: number;
	/** the appClient base URL from the renderer (e.g. Vite :2138 proxy vs direct :31337). */
	apiBaseOverride?: string | null;
	/** Renderer bearer token when main `ELIZA_API_TOKEN` is unset (external desktop mode). */
	bearerTokenOverride?: string | null;
}): Promise<CloudDisconnectMainResult> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const timeoutMs = options?.disconnectTimeoutMs ?? 30000;
	const bearer = options?.bearerTokenOverride ?? null;
	const embeddedPort = getAgentManager().getPort();
	const fromEnv = buildMainMenuResetApiCandidates({
		embeddedPort,
		configuredBase: resolveInitialApiBase(process.env),
	});
	const preferred = normalizeApiBase(options?.apiBaseOverride ?? undefined);
	const candidates: string[] = [];
	if (preferred) {
		candidates.push(preferred);
	}
	for (const c of fromEnv) {
		if (!candidates.includes(c)) {
			candidates.push(c);
		}
	}
	const buildHeaders = createMainApiHeaderBuilder({
		bearerTokenOverride: bearer,
		localAgentOrigins: resolveMainLocalAgentOrigins(),
	});
	const apiBase = await pickReachableMenuResetApiBase({
		candidates,
		fetchImpl,
		buildHeaders,
	});
	if (!apiBase) {
		return {
			ok: false,
			error: `Could not reach the ${getBrandConfig().appName} API.`,
		};
	}
	const disconnectUrl = `${apiBase}/api/cloud/disconnect`;
	let res: Response;
	try {
		res = await fetchImpl(disconnectUrl, {
			method: "POST",
			headers: buildHeaders(disconnectUrl, "application/json"),
			body: "{}",
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Network request failed";
		return { ok: false, error: msg };
	}
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		const msg =
			typeof body.error === "string" && body.error.trim()
				? body.error.trim()
				: `HTTP ${res.status}`;
		return { ok: false, error: msg };
	}
	return { ok: true };
}
