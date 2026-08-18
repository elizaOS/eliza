/**
 * Behavioral today-todos JSON deadline. Executes getTodayTodosJsonWithFetch
 * under abort — not a source-grep of today-todos-data.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../api", () => ({
	client: { getBaseUrl: () => "http://test.local" },
}));

vi.mock("../../../api/app-shell-capabilities", () => ({
	supportsFullAppShellRoutes: () => true,
}));

import {
	TODAY_TODOS_JSON_TIMEOUT_MS,
	getTodayTodosJsonWithFetch,
} from "./today-todos-data";

const URL = "http://test.local/api/lifeops/todos";

function stallUntilAborted(): typeof fetch {
	return ((_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected today-todos abort signal");
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		})) as typeof fetch;
}

describe("Today todos JSON deadline", () => {
	it("keeps a documented UI JSON budget", () => {
		expect(TODAY_TODOS_JSON_TIMEOUT_MS).toBe(15_000);
	});

	it("aborts a stalled todos GET at the injected deadline", async () => {
		await expect(
			getTodayTodosJsonWithFetch(URL, stallUntilAborted(), 10),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("surfaces a provider error from a completed todos GET", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("nope", { status: 503, statusText: "Service Unavailable" });

		await expect(
			getTodayTodosJsonWithFetch(URL, fetchImpl, 1_000),
		).rejects.toThrow("503");
	});

	it("uses the injected fetch for a successful todos GET", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			return Response.json({ todos: [] });
		};

		const body = await getTodayTodosJsonWithFetch<{ todos: unknown[] }>(
			URL,
			fetchImpl,
			1_000,
		);

		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		expect(body.todos).toEqual([]);
	});
});
