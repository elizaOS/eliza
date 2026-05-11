/**
 * Pure composition layer for the typed onboarding RPC methods.
 *
 * Two routes:
 *   - `getOnboardingStatus` : transitional carrier wraps `GET /api/onboarding/status`.
 *   - `getOnboardingOptions`: transitional carrier wraps `GET /api/onboarding/options`.
 *
 * As with `boot-progress.ts`, the body of the readers swaps to direct
 * in-process state reads when the agent runtime merges into this Bun
 * process. The typed contract on the renderer side (and the schema in
 * rpc-schema.ts) is the load-bearing interface and stays stable.
 *
 * Both readers tolerate "agent not ready yet" by returning `null`. The
 * compose layer then converts to a deterministic default the renderer
 * can safely render against (the existing client.ts behavior threw on
 * 5xx; the typed RPC surface is gentler so the renderer never needs
 * try/catch around a startup gate).
 */

import type {
	OnboardingOptionsSnapshot,
	OnboardingStatusSnapshot,
} from "./rpc-schema";

export type AgentJsonReader<T> = (port: number) => Promise<T | null>;

const DEFAULT_TIMEOUT_MS = 4_000;

async function fetchJson<T>(
	port: number,
	pathname: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T | null> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
			method: "GET",
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

export const readOnboardingStatusViaHttp: AgentJsonReader<
	OnboardingStatusSnapshot
> = async (port) => {
	const raw = await fetchJson<{
		complete?: unknown;
		cloudProvisioned?: unknown;
	}>(port, "/api/onboarding/status");
	if (!raw) return null;
	const complete = raw.complete === true;
	const cloudProvisioned =
		raw.cloudProvisioned === true ? true : undefined;
	return cloudProvisioned ? { complete, cloudProvisioned } : { complete };
};

/**
 * Coerce server option lists into the typed snapshot shape. Each option
 * is forwarded as an unknown record — the typed RPC surface enforces
 * "array of objects" but leaves the inner option shape to the existing
 * `@elizaos/shared/contracts/onboarding` types that consumers downcast
 * to. Same boundary the HTTP route used; we are not narrowing further.
 */
function coerceOptionList(
	value: unknown,
): ReadonlyArray<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(item): item is Record<string, unknown> =>
			typeof item === "object" && item !== null,
	);
}

function coerceModelGroups(
	value: unknown,
): OnboardingOptionsSnapshot["models"] {
	if (!value || typeof value !== "object") return {};
	const out: OnboardingOptionsSnapshot["models"] = {};
	const v = value as Record<string, unknown>;
	const tiers = ["nano", "small", "medium", "large", "mega"] as const;
	for (const tier of tiers) {
		const list = coerceOptionList(v[tier]);
		if (list.length > 0) out[tier] = list;
	}
	return out;
}

export const readOnboardingOptionsViaHttp: AgentJsonReader<
	OnboardingOptionsSnapshot
> = async (port) => {
	const raw = await fetchJson<Record<string, unknown>>(
		port,
		"/api/onboarding/options",
	);
	if (!raw) return null;
	const namesRaw = raw.names;
	return {
		names: Array.isArray(namesRaw)
			? namesRaw.filter((n): n is string => typeof n === "string")
			: [],
		styles: coerceOptionList(raw.styles),
		providers: coerceOptionList(raw.providers),
		cloudProviders: coerceOptionList(raw.cloudProviders),
		models: coerceModelGroups(raw.models),
		openrouterModels:
			raw.openrouterModels !== undefined
				? coerceOptionList(raw.openrouterModels)
				: undefined,
		inventoryProviders: coerceOptionList(raw.inventoryProviders),
		sharedStyleRules:
			typeof raw.sharedStyleRules === "string" ? raw.sharedStyleRules : "",
		githubOAuthAvailable:
			raw.githubOAuthAvailable === true ? true : undefined,
	};
};

/**
 * Default snapshot returned when the agent hasn't answered yet. Marks
 * onboarding as incomplete so the renderer's startup gate keeps polling
 * rather than treating "no answer" as "onboarded".
 */
export const INITIAL_ONBOARDING_STATUS: OnboardingStatusSnapshot = {
	complete: false,
};

/**
 * Default options snapshot returned when the agent hasn't answered yet.
 * Empty catalogs, no providers — the renderer renders a loading state.
 */
export const INITIAL_ONBOARDING_OPTIONS: OnboardingOptionsSnapshot = {
	names: [],
	styles: [],
	providers: [],
	cloudProviders: [],
	models: {},
	inventoryProviders: [],
	sharedStyleRules: "",
};

export async function composeOnboardingStatusSnapshot(
	port: number | null,
	read: AgentJsonReader<OnboardingStatusSnapshot>,
): Promise<OnboardingStatusSnapshot> {
	if (port === null) return INITIAL_ONBOARDING_STATUS;
	const value = await read(port);
	return value ?? INITIAL_ONBOARDING_STATUS;
}

export async function composeOnboardingOptionsSnapshot(
	port: number | null,
	read: AgentJsonReader<OnboardingOptionsSnapshot>,
): Promise<OnboardingOptionsSnapshot> {
	if (port === null) return INITIAL_ONBOARDING_OPTIONS;
	const value = await read(port);
	return value ?? INITIAL_ONBOARDING_OPTIONS;
}
