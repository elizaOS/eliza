/**
 * Behavioral Open-Meteo JSON deadline. Executes getWeatherJsonWithFetch
 * under abort — not a source-grep of useWeather.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
	client: { fetch: async () => ({ lat: 0, lon: 0 }) },
}));

vi.mock("@elizaos/logger", () => ({
	logger: { warn: () => undefined, debug: () => undefined, info: () => undefined },
}));

vi.mock("../surface-realm-channel", () => ({
	shellLocalStorage: {
		getItem: () => null,
		setItem: () => undefined,
		removeItem: () => undefined,
	},
}));

vi.mock("./useDocumentVisibility", () => ({
	useIntervalWhenDocumentVisible: () => undefined,
}));

vi.mock("./useProtectedAgentProbesEnabled", () => ({
	useProtectedAgentProbesEnabled: () => true,
}));

import {
	WEATHER_JSON_TIMEOUT_MS,
	getWeatherJsonWithFetch,
} from "./useWeather";

const URL =
	"https://api.open-meteo.com/v1/forecast?latitude=40.71&longitude=-74.01&current=temperature_2m,weather_code&temperature_unit=celsius";

function stallUntilAborted(): typeof fetch {
	return ((_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected weather abort signal");
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		})) as typeof fetch;
}

describe("Open-Meteo weather JSON deadline", () => {
	it("keeps a documented UI JSON budget", () => {
		expect(WEATHER_JSON_TIMEOUT_MS).toBe(15_000);
	});

	it("aborts a stalled weather GET at the injected deadline", async () => {
		await expect(
			getWeatherJsonWithFetch(URL, stallUntilAborted(), 10),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("surfaces a provider error from a completed weather GET", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("nope", { status: 503, statusText: "Service Unavailable" });

		await expect(getWeatherJsonWithFetch(URL, fetchImpl, 1_000)).rejects.toThrow(
			"503",
		);
	});

	it("uses the injected fetch for a successful weather GET", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			return Response.json({
				current: { temperature_2m: 18.6, weather_code: 0 },
			});
		};

		const body = await getWeatherJsonWithFetch<{
			current: { temperature_2m: number; weather_code: number };
		}>(URL, fetchImpl, 1_000);

		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		expect(body.current.temperature_2m).toBe(18.6);
	});
});
