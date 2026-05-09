/**
 * Main-process `POST /api/agent/reset`.
 *
 * Renderer `fetch` can stall after a native confirmation sheet in Electrobun.
 * Posting from Bun keeps Settings reset on the same reliable path as menu reset
 * and cloud disconnect, while still letting the renderer decide which target
 * (local/cloud/remote) is active.
 */

import { normalizeApiBase, resolveInitialApiBase } from "./api-base";
import { getBrandConfig } from "./brand-config";
import { buildMainApiHeaders } from "./cloud-disconnect-from-main";
import {
	buildMainMenuResetApiCandidates,
	type FetchLike,
	pickReachableMenuResetApiBase,
} from "./menu-reset-from-main";
import { getAgentManager } from "./native/agent";

export type AgentResetMainResult = { ok: true } | { ok: false; error: string };

export async function postAgentResetFromMain(options?: {
	fetchImpl?: FetchLike;
	resetTimeoutMs?: number;
	apiBaseOverride?: string | null;
	bearerTokenOverride?: string | null;
}): Promise<AgentResetMainResult> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const timeoutMs = options?.resetTimeoutMs ?? 60_000;
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
	for (const candidate of fromEnv) {
		if (!candidates.includes(candidate)) {
			candidates.push(candidate);
		}
	}

	const buildHeaders = () => buildMainApiHeaders(undefined, bearer);
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

	let res: Response;
	try {
		res = await fetchImpl(`${apiBase}/api/agent/reset`, {
			method: "POST",
			headers: buildMainApiHeaders("application/json", bearer),
			body: "{}",
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Network request failed",
		};
	}

	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		return {
			ok: false,
			error:
				typeof body.error === "string" && body.error.trim()
					? body.error.trim()
					: `HTTP ${res.status}`,
		};
	}

	return { ok: true };
}
