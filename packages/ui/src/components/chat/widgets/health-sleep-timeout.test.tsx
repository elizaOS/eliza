/**
 * @vitest-environment jsdom
 *
 * Behavioral HealthSleepWidget sleep-JSON deadline. Executes
 * getHealthSleepJsonWithFetch under abort — not a source-grep of
 * health-sleep.tsx.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../api", () => ({
	client: { getBaseUrl: () => "http://test.local" },
}));

vi.mock("../../../api/app-shell-capabilities", () => ({
	supportsFullAppShellRoutes: () => true,
}));

vi.mock("../../../widgets/home-priority", () => ({
	HOME_SIGNAL_WEIGHTS: { "check-in": 1 },
}));

vi.mock("lucide-react", () => ({
	Moon: () => null,
}));

vi.mock("./home-widget-card", () => ({
	HomeWidgetCard: () => null,
	useWidgetNavigation: () => ({ openView: () => undefined }),
}));

vi.mock("../../../hooks", () => ({
	useIntervalWhenDocumentVisible: () => undefined,
}));

vi.mock("../../../hooks/useAuthStatus", () => ({
	useIsAuthenticated: () => false,
}));

vi.mock("../../../widgets/home-attention-store", () => ({
	usePublishHomeAttention: () => undefined,
}));

import {
	HEALTH_SLEEP_JSON_TIMEOUT_MS,
	getHealthSleepJsonWithFetch,
} from "./health-sleep";

const URL = "http://test.local/api/lifeops/sleep/regularity?windowDays=14";

function stallUntilAborted(): typeof fetch {
	return ((_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected health-sleep abort signal");
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		})) as typeof fetch;
}

describe("HealthSleepWidget sleep JSON deadline", () => {
	it("keeps a documented UI JSON budget", () => {
		expect(HEALTH_SLEEP_JSON_TIMEOUT_MS).toBe(15_000);
	});

	it("aborts a stalled sleep GET at the injected deadline", async () => {
		await expect(
			getHealthSleepJsonWithFetch(URL, stallUntilAborted(), 10),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("surfaces a provider error from a completed sleep GET", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("nope", { status: 503, statusText: "Service Unavailable" });

		await expect(
			getHealthSleepJsonWithFetch(URL, fetchImpl, 1_000),
		).rejects.toThrow("503");
	});

	it("uses the injected fetch for a successful sleep GET", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			return Response.json({ classification: "regular" });
		};

		const body = await getHealthSleepJsonWithFetch(URL, fetchImpl, 1_000);

		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		expect(body).toEqual({ classification: "regular" });
	});
});
