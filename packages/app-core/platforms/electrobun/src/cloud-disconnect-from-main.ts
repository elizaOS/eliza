/**
 * Main-process `POST /api/cloud/disconnect` — same rationale as menu reset:
 * after a native message box, the renderer's `fetch` may not run until later,
 * so disconnect appeared to do nothing.
 */

import { resolveApiToken } from "@elizaos/shared";
import {
	normalizeApiBase,
	resolveDesktopRuntimeMode,
	resolveInitialApiBase,
} from "./api-base";
import { getBrandConfig } from "./brand-config";
import {
	buildMainMenuResetApiCandidates,
	type FetchLike,
	pickReachableMenuResetApiBase,
} from "./menu-reset-from-main";
import { configureDesktopLocalApiAuth, getAgentManager } from "./native/agent";

export type CloudDisconnectMainResult =
	| { ok: true }
	| { ok: false; error: string };

export function buildMainApiHeaders(
	contentType?: string,
	bearerTokenOverride?: string | null,
): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (contentType) {
		headers["Content-Type"] = contentType;
	}
	const override = bearerTokenOverride?.trim();
	if (override) {
		headers.Authorization = `Bearer ${override}`;
		return headers;
	}
	let apiToken = resolveApiToken(process.env);
	if (!apiToken) {
		const rt = resolveDesktopRuntimeMode(
			process.env as Record<string, string | undefined>,
		);
		if (rt.mode === "local") {
			apiToken = configureDesktopLocalApiAuth().trim();
		}
	}
	if (apiToken) {
		headers.Authorization = `Bearer ${apiToken}`;
	}
	return headers;
}

export const buildAppMainApiHeaders = buildMainApiHeaders;

export async function postCloudDisconnectFromMain(options?: {
	fetchImpl?: FetchLike;
	disconnectTimeoutMs?: number;
	/** the appClient base URL from the renderer (e.g. Vite :2138 proxy vs direct :31337). */
	apiBaseOverride?: string | null;
	/** Renderer bearer token when main `ELIZA_API_TOKEN` is unset (external desktop mode). */
	bearerTokenOverride?: string | null;
}): Promise<CloudDisconnectMainResult> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const timeoutMs = options?.disconnectTimeoutMs ?? 30_000;
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
	const buildHeaders = (contentType?: string) =>
		buildMainApiHeaders(contentType, bearer);
	const apiBase = await pickReachableMenuResetApiBase({
		candidates,
		fetchImpl,
		buildHeaders: () => buildHeaders(),
	});
	if (!apiBase) {
		return {
			ok: false,
			error: `Could not reach the ${getBrandConfig().appName} API.`,
		};
	}

	let res: Response;
	try {
		res = await fetchImpl(`${apiBase}/api/cloud/disconnect`, {
			method: "POST",
			headers: buildHeaders("application/json"),
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
