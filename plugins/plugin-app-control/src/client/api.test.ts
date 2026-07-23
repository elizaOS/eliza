/**
 * Verifies that app-control HTTP operations use workload-specific deadlines
 * and preserve caller cancellation at the loopback boundary.
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
		await client.stopAppRun("run-1");
		await client.launchApp("chess");

		expect(deadlines).toEqual([2_000, 2_000, 10_000, 120_000]);
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
});
