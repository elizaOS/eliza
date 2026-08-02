/**
 * Verifies app-control deadlines, caller cancellation, and the typed no-op
 * result used by APP stop at the loopback boundary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppControlClient } from "./api.js";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function responseFor(url: string): Response {
	if (url.endsWith("/api/apps/installed")) return jsonResponse([]);
	if (url.endsWith("/api/apps/runs")) return jsonResponse([]);
	if (url.endsWith("/api/apps/launch")) {
		return jsonResponse({
			pluginInstalled: false,
			needsRestart: false,
			displayName: "Chess",
			launchType: "view",
			launchUrl: null,
			run: null,
		});
	}
	if (url.endsWith("/api/apps/stop")) {
		return jsonResponse({
			success: false,
			appName: "chess",
			runId: null,
			stoppedAt: "2026-07-22T00:00:00.000Z",
			pluginUninstalled: false,
			needsRestart: false,
			stopScope: "nothing-stopped",
			message: "No active app run found.",
		});
	}
	if (url.endsWith("/api/apps/runs/run-1/stop")) {
		return jsonResponse({
			success: true,
			appName: "chess",
			runId: "run-1",
			stoppedAt: "2026-07-22T00:00:00.000Z",
			pluginUninstalled: false,
			needsRestart: false,
			stopScope: "viewer-session",
			message: "Stopped",
		});
	}
	if (url.endsWith("/api/apps/runs/missing/stop")) {
		return jsonResponse({
			success: false,
			appName: "",
			runId: "missing",
			stoppedAt: "2026-07-22T00:00:00.000Z",
			pluginUninstalled: false,
			needsRestart: false,
			stopScope: "nothing-stopped",
			message: 'App run "missing" was not found.',
		});
	}
	throw new Error(`Unexpected test URL: ${url}`);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("app-control client deadlines", () => {
	it("assigns short reads, bounded stop, and install-capable launch deadlines", async () => {
		const deadlines: number[] = [];
		vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
			deadlines.push(delay);
			return new AbortController().signal;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) =>
				responseFor(String(input)),
			),
		);
		const client = createAppControlClient();

		await client.listInstalledApps();
		await client.listAppRuns();
		await client.stopApp("chess");
		await client.stopAppRun("run-1");
		await client.launchApp("chess");

		// Read deadline must cover a cold registry discovery scan on slow hosts
		// (a 2s read deadline made every cold `APP list` a TimeoutError).
		expect(deadlines).toEqual([10_000, 10_000, 10_000, 10_000, 120_000]);
	});

	it("preserves a typed nothing-stopped result from the name-based UI route", async () => {
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(
			new AbortController().signal,
		);
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return responseFor(String(input));
			}),
		);

		await expect(createAppControlClient().stopApp("chess")).resolves.toEqual(
			expect.objectContaining({
				success: false,
				appName: "chess",
				stopScope: "nothing-stopped",
			}),
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toMatch(/\/api\/apps\/stop$/);
		expect(requests[0]?.init?.body).toBe(JSON.stringify({ name: "chess" }));
	});

	it("preserves a typed nothing-stopped result for an explicit run id", async () => {
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(
			new AbortController().signal,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) =>
				responseFor(String(input)),
			),
		);

		await expect(
			createAppControlClient().stopAppRun("missing"),
		).resolves.toEqual(
			expect.objectContaining({
				success: false,
				runId: "missing",
				stopScope: "nothing-stopped",
			}),
		);
	});

	it("rejects a malformed stop result instead of fabricating success", async () => {
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(
			new AbortController().signal,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					appName: "chess",
					runId: null,
					stoppedAt: "2026-07-22T00:00:00.000Z",
					pluginUninstalled: false,
					needsRestart: false,
					stopScope: "nothing-stopped",
					message: "No active app run found.",
				}),
			),
		);

		await expect(createAppControlClient().stopApp("chess")).rejects.toThrow(
			"Malformed stop result: missing required fields",
		);
	});

	it("propagates caller cancellation through the combined request signal", async () => {
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(
			new AbortController().signal,
		);
		let observedSignal: AbortSignal | null = null;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (_input: string | URL | Request, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						observedSignal = init?.signal as AbortSignal;
						observedSignal.addEventListener(
							"abort",
							() => reject(observedSignal?.reason),
							{ once: true },
						);
					}),
			),
		);
		const caller = new AbortController();
		const request = createAppControlClient().listInstalledApps(caller.signal);

		caller.abort(new DOMException("turn cancelled", "AbortError"));

		await expect(request).rejects.toMatchObject({ name: "AbortError" });
		expect(observedSignal?.aborted).toBe(true);
	});

	it("classifies fetch transport failures at the HTTP boundary", async () => {
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(
			new AbortController().signal,
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);

		await expect(
			createAppControlClient().listInstalledApps(),
		).rejects.toMatchObject({
			name: "ElizaError",
			code: "LOOPBACK_UNREACHABLE",
			context: { path: "/api/apps/installed" },
		});
	});
});
