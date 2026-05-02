import { getBrandConfig } from "./brand-config";

/**
 * Main-process "Reset the app" menu flow — **testable** fetch/restart/poll core.
 *
 * **WHY extract from `index.ts`:** menu reset is security- and UX-sensitive; unit
 * tests need mocked `fetch` without booting Electrobun. **WHY `pickReachable*`
 * uses `res.ok`:** 4xx/5xx must not count as a valid API base for
 * `POST /api/agent/reset`. **WHY embedded port first in candidates:** external
 * `ELIZA_DESKTOP_API_BASE` often points at a dev server that is down while the
 * embedded agent still listens on a dynamic loopback port.
 *
 * Native confirm, `Utils.showNotification`, and `getAgentManager()` stay in
 * `index.ts` (`resetthe appFromApplicationMenu`).
 */

export type FetchLike = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

export const MAIN_RESET_API_PROBE_TIMEOUT_MS = 4000;
export const MENU_RESET_STATUS_POLL_MS = 1000;
export const MENU_RESET_STATUS_MAX_MS = 120_000;
export const MENU_RESET_VERIFY_RETRIES = 1;

export function buildMainMenuResetApiCandidates(options: {
	embeddedPort: number | null | undefined;
	configuredBase: string | null;
}): string[] {
	const candidates: string[] = [];
	if (typeof options.embeddedPort === "number" && options.embeddedPort > 0) {
		candidates.push(`http://127.0.0.1:${options.embeddedPort}`);
	}
	const configured = options.configuredBase;
	if (configured && !candidates.includes(configured)) {
		candidates.push(configured);
	}
	return candidates;
}

export async function pickReachableMenuResetApiBase(options: {
	candidates: string[];
	fetchImpl: FetchLike;
	buildHeaders: () => Record<string, string>;
	probeTimeoutMs?: number;
}): Promise<string | null> {
	if (options.candidates.length === 0) {
		return null;
	}
	const timeoutMs = options.probeTimeoutMs ?? MAIN_RESET_API_PROBE_TIMEOUT_MS;
	for (const base of options.candidates) {
		try {
			const res = await options.fetchImpl(`${base}/api/status`, {
				method: "GET",
				headers: options.buildHeaders(),
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (res.ok) {
				return base;
			}
		} catch {
			/* try next candidate */
		}
	}
	return null;
}

export async function pollMenuResetAgentStatusJson(options: {
	apiBase: string;
	fetchImpl: FetchLike;
	buildHeaders: () => Record<string, string>;
	pollMs?: number;
	maxMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}): Promise<Record<string, unknown>> {
	const pollMs = options.pollMs ?? MENU_RESET_STATUS_POLL_MS;
	const maxMs = options.maxMs ?? MENU_RESET_STATUS_MAX_MS;
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = options.now ?? (() => Date.now());
	const deadline = now() + maxMs;
	while (now() < deadline) {
		try {
			const res = await options.fetchImpl(`${options.apiBase}/api/status`, {
				headers: options.buildHeaders(),
			});
			if (res.ok) {
				const data = (await res.json()) as Record<string, unknown>;
				if (data.state === "running") {
					return data;
				}
			}
		} catch {
			/* agent may still be binding */
		}
		await sleep(pollMs);
	}
	try {
		const res = await options.fetchImpl(`${options.apiBase}/api/status`, {
			headers: options.buildHeaders(),
		});
		if (res.ok) {
			return (await res.json()) as Record<string, unknown>;
		}
	} catch {
		/* fall through */
	}
	return { state: "error", agentName: getBrandConfig().appName };
}

export type MainMenuResetPostConfirmDeps = {
	apiBase: string;
	fetchImpl: FetchLike;
	buildHeaders: () => Record<string, string>;
	/** `true` when `resolveDesktopRuntimeMode(env).mode === "local"`. */
	useEmbeddedRestart: boolean;
	restartEmbeddedClearingLocalDb: () => Promise<{ port?: number }>;
	/** Called when embedded restart returns a port (local mode). */
	pushEmbeddedApiBaseToRenderer: (
		port: number | undefined,
		apiToken: string,
	) => void;
	getLocalApiAuthToken: () => string;
	/** External / non-embedded: POST restart (errors ignored). */
	postExternalAgentRestart: () => Promise<void>;
	resolveApiBaseForStatusPoll: () => string;
	sendMenuResetAppliedToRenderer: (payload: {
		itemId: "menu-reset-app-applied";
		agentStatus: Record<string, unknown>;
	}) => void;
};

/**
 * After the user confirms reset and a reachable `apiBase` is known: POST reset,
 * restart (embedded or HTTP), poll status, notify renderer.
 */
export async function runMainMenuResetAfterApiBaseResolved(
	d: MainMenuResetPostConfirmDeps,
): Promise<void> {
	const executeResetAndRestart = async (): Promise<Record<string, unknown>> => {
		const resetRes = await d.fetchImpl(`${d.apiBase}/api/agent/reset`, {
			method: "POST",
			headers: d.buildHeaders(),
		});
		if (!resetRes.ok) {
			throw new Error(`Reset API failed (${resetRes.status})`);
		}

		if (d.useEmbeddedRestart) {
			const status = await d.restartEmbeddedClearingLocalDb();
			const apiToken = d.getLocalApiAuthToken();
			if (status.port) {
				d.pushEmbeddedApiBaseToRenderer(status.port, apiToken);
			}
		} else {
			await d.postExternalAgentRestart();
			// Push current API base + token to renderer after external restart
			// so the client reconnects with valid auth credentials.
			const apiToken = d.getLocalApiAuthToken();
			d.pushEmbeddedApiBaseToRenderer(undefined, apiToken);
		}

		const pollBase = d.resolveApiBaseForStatusPoll();
		return pollMenuResetAgentStatusJson({
			apiBase: pollBase,
			fetchImpl: d.fetchImpl,
			buildHeaders: d.buildHeaders,
		});
	};

	const readOnboardingComplete = async (): Promise<boolean | null> => {
		try {
			const res = await d.fetchImpl(`${d.apiBase}/api/onboarding/status`, {
				method: "GET",
				headers: d.buildHeaders(),
			});
			if (!res.ok) {
				return null;
			}
			const payload = (await res.json()) as { complete?: unknown };
			return typeof payload.complete === "boolean" ? payload.complete : null;
		} catch {
			return null;
		}
	};

	let statusPayload = await executeResetAndRestart();
	let onboardingComplete = await readOnboardingComplete();

	for (
		let attempt = 0;
		onboardingComplete === true && attempt < MENU_RESET_VERIFY_RETRIES;
		attempt += 1
	) {
		statusPayload = await executeResetAndRestart();
		onboardingComplete = await readOnboardingComplete();
	}

	if (onboardingComplete === true) {
		throw new Error(
			"Reset verification failed: onboarding still marked complete",
		);
	}

	d.sendMenuResetAppliedToRenderer({
		itemId: "menu-reset-app-applied",
		agentStatus: statusPayload,
	});
}
